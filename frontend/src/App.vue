<!-- src/App.vue -->
<template>
    <div class="min-h-screen bg-gray-100 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <div class="max-w-3xl mx-auto p-6 space-y-6">
            <header class="flex items-center gap-3">
                <img src="/logo.svg" alt="logo" class="w-8 h-8" />
                <h1 class="text-2xl font-semibold">SatoriXR – Mesh Optimizer</h1>
            </header>

            <!-- Upload / Optimize form -->
            <section class="bg-white dark:bg-gray-800 rounded-xl shadow p-5 space-y-4">
                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                        <label class="block text-sm mb-1">Model name</label>
                        <input v-model="modelName" type="text"
                            class="w-full rounded border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2"
                            placeholder="Front Axle" />
                    </div>
                    <div>
                        <label class="block text-sm mb-1">Preset ID</label>
                        <input v-model.number="presetId" type="number"
                            class="w-full rounded border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2"
                            placeholder="9547" />
                    </div>
                </div>

                <div>
                    <label class="block text-sm mb-1">Choose file</label>
                    <input type="file" @change="onFile" />
                </div>

                <!-- Show file hash for debugging -->
                <div v-if="currentFileHash" class="text-xs opacity-70">
                    File hash: {{ currentFileHash.substring(0, 16) }}...
                </div>

                <div class="flex gap-3">
                    <button class="px-4 py-2 rounded bg-amber-600 text-white disabled:opacity-50"
                        :disabled="!file || busy" @click="startFlow">
                        {{ busy ? 'Working…' : 'Upload / Optimize' }}
                    </button>

                    <button class="px-4 py-2 rounded bg-gray-200 dark:bg-gray-700 disabled:opacity-50" :disabled="!busy"
                        @click="cancel">
                        Cancel
                    </button>
                </div>

                <p v-if="statusMsg" class="text-sm opacity-80">{{ statusMsg }}</p>
                <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
            </section>

            <!-- Processing Card -->
            <section v-if="rawmodelId" class="bg-slate-900 text-slate-100 rounded-xl shadow p-5 space-y-3">
                <div class="flex items-center justify-between">
                    <div class="text-sm">
                        <span v-if="stage === 'queued'">Queued in optimizer…</span>
                        <span v-else-if="stage === 'processing'">Processing in RapidPipeline…</span>
                        <span v-else-if="stage === 'ready'">Ready!</span>
                        <span v-else>Waiting…</span>
                    </div>
                    <div class="text-xs opacity-80">Asset ID: {{ rawmodelId }}</div>
                </div>

                <div class="h-2 bg-slate-700 rounded overflow-hidden">
                    <div v-if="!indeterminate" class="h-2 bg-amber-500 transition-all duration-300"
                        :style="{ width: progress + '%' }" />
                    <div v-else class="h-2 bg-amber-500 animate-pulse" style="width: 35%" />
                </div>

                <div class="flex justify-between items-center text-xs opacity-80">
                    <span>Progress: {{ Math.floor(progress) }}%</span>
                    <span>ETA: {{ eta }}</span>
                    <button @click="debugAsset"
                        class="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 rounded transition-colors"
                        v-if="rawmodelId">
                        Debug
                    </button>
                </div>

                <div v-if="downloads.length" class="pt-2">
                    <div class="text-xs mb-2 opacity-80">Downloads ready:</div>
                    <ul class="list-disc list-inside space-y-1">
                        <li v-for="d in downloads" :key="d.url">
                            <a class="underline text-amber-400"
                                :href="`/api/proxy-download?url=${encodeURIComponent(d.url)}`">
                                {{ d.format?.toUpperCase() || 'FILE' }} ({{ filenameFromUrl(d.url) }})
                            </a>
                        </li>
                    </ul>
                </div>
            </section>
        </div>
    </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted, onBeforeUnmount } from 'vue'

// ---------------- State ----------------
const modelName = ref<string>('')
const presetId = ref<number>(9547)
const file = ref<File | null>(null)
const currentFileHash = ref<string>('')

const busy = ref(false)
const statusMsg = ref('')
const error = ref<string | null>(null)

const rawmodelId = ref<number | null>(null)
const rapidmodelId = ref<number | null>(null)
const downloads = ref<Array<{ format: string; url: string }>>([])

const ETA_DEFAULTS: Record<string, number> = {
    queued: 45_000,      // 45s default
    processing: 240_000, // 4m default
};

function getAvgMs(stage: 'queued' | 'processing') {
    const k = `etaAvg_${stage}`;
    const v = Number(localStorage.getItem(k));
    return Number.isFinite(v) && v > 0 ? v : ETA_DEFAULTS[stage];
}

function updateAvgMs(stage: 'queued' | 'processing', sampleMs: number) {
    const alpha = 0.3; // EMA weight
    const prev = getAvgMs(stage);
    const next = Math.round((1 - alpha) * prev + alpha * sampleMs);
    localStorage.setItem(`etaAvg_${stage}`, String(next));
}

// progress UI state
const state = reactive({
    progress: 0,
    stage: 'waiting',
    eta: 'Calculating…',
    indeterminate: false,
})

const progress = computed(() => state.progress)
const stage = computed(() => state.stage)
const eta = computed(() => state.eta)
const indeterminate = computed(() => state.indeterminate)

// cancel flag
let stop = false

// ---------------- File handlers ----------------
async function onFile(e: Event) {
    const input = e.target as HTMLInputElement
    const selectedFile = input.files?.[0] || null
    file.value = selectedFile

    // Compute hash immediately when file is selected
    if (selectedFile) {
        try {
            statusMsg.value = 'Computing file hash...'
            currentFileHash.value = await sha256File(selectedFile)
            statusMsg.value = ''
            console.log(`[Hash] File hash computed: ${currentFileHash.value}`)
        } catch (err) {
            console.error('Error computing hash:', err)
            currentFileHash.value = ''
        }
    } else {
        currentFileHash.value = ''
    }
}

function filenameFromUrl(url: string) {
    try {
        let n = new URL(url).pathname.split('/').pop() || 'file'
        try { n = decodeURIComponent(n) } catch { }
        try { n = decodeURIComponent(n) } catch { }
        return n
    } catch {
        return 'file'
    }
}

async function debugAsset() {
    if (!rawmodelId.value) return;

    try {
        const response = await fetch(`/api/debug/${rawmodelId.value}`);
        const debug = await response.json();

        console.log('=== ASSET DEBUG INFO ===');
        console.log('Raw Model:', debug.rawmodel);
        console.log('Rapid Models:', debug.rapidmodels);
        console.log('Raw Downloads:', debug.rawDownloads);
        console.log('Rapid Downloads:', debug.rapidDownloads);
        console.log('Timestamp:', debug.timestamp);

        // Also show in UI
        const debugStr = JSON.stringify(debug, null, 2);
        const newWindow = window.open('', '_blank');
        if (newWindow) {
            newWindow.document.write(`<pre>${debugStr}</pre>`);
            newWindow.document.title = 'Debug Info';
        }

    } catch (err) {
        console.error('Debug failed:', err);
        alert('Debug failed: ' + err.message);
    }
}

// ---------------- Crypto helper (SHA-256) ----------------
async function sha256File(f: File): Promise<string> {
    const buf = await f.arrayBuffer()
    const hash = await crypto.subtle.digest('SHA-256', buf)
    const bytes = Array.from(new Uint8Array(hash))
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------- Backend helpers ----------------
async function backend(path: string, init?: RequestInit) {
    const res = await fetch(path, init)
    const text = await res.text()
    let data: any = {}
    if (text) { try { data = JSON.parse(text) } catch { data = { raw: text } } }
    if (!res.ok) {
        throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status} ${res.statusText} ${text}`)
    }
    return data
}

// ---------------- Enhanced hash checking ----------------
async function findExistingByHash(hash: string): Promise<{ found: boolean, id?: number, name?: string }> {
    try {
        console.log(`[Dedup] Checking for existing asset with hash: ${hash}`)

        const response = await backend(`/api/find-by-hash?hash=${encodeURIComponent(hash)}`)

        if (response.found && response.id) {
            console.log(`[Dedup] Found existing asset: ID ${response.id}, name: ${response.name}`)
            return {
                found: true,
                id: response.id,
                name: response.name
            }
        }

        console.log(`[Dedup] No existing asset found for hash`)
        return { found: false }

    } catch (err) {
        console.warn(`[Dedup] Error checking hash: ${err.message}`)
        return { found: false }
    }
}

// ---------------- Enhanced tagging after upload ----------------
async function ensureHashTags(rawId: number, hash: string, filename: string) {
    try {
        console.log(`[Tags] Adding hash tags to asset ${rawId}`)

        // Add multiple tag formats to ensure we can find it later
        const tags = [
            `sha256-${hash}`,           // Safe format (no special chars)
            `hash:${hash}`,             // Legacy format with colon
            `filename:${filename}`,     // Filename tag
            `content-hash-${hash.substring(0, 16)}` // Shortened version
        ]

        await backend(`/api/rawmodel/${rawId}/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tags })
        })

        console.log(`[Tags] Successfully added ${tags.length} tags to asset ${rawId}`)

    } catch (err) {
        console.warn(`[Tags] Failed to add tags: ${err.message}`)
        // Don't fail the entire flow if tagging fails
    }
}

// ---------------- Poller (same as before) ----------------
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function humanizeMs(ms: number) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
}
function progressForStage(stage: 'queued' | 'processing', elapsedMs: number, avgMs: number) {
    const t = Math.min(1, elapsedMs / Math.max(1, avgMs));
    const eased = 1 - Math.pow(1 - t, 2);

    if (stage === 'queued') {
        const start = 20, end = 50;
        return start + eased * (end - start);
    } else {
        const start = 50, end = 95;
        return start + eased * (end - start);
    }
}

async function pollStatus(rawId: number) {
    let delay = 1000;
    let currentStage: 'waiting' | 'queued' | 'processing' | 'ready' | 'unknown' = 'waiting';
    let stuckAt95Count = 0;
    let maxStuckRetries = 10;

    let queueStart = 0;
    let procStart = 0;

    state.progress = 0;
    state.stage = 'waiting';
    state.eta = 'Calculating…';
    state.indeterminate = false;

    const startedAt = performance.now();

    while (!stop) {
        const now = performance.now();

        try {
            const status = await fetch(`/api/status/${rawId}`).then(r => r.json());

            const stage = String(status.stage || 'unknown') as typeof currentStage;
            let p = Number(status.progress || 0);

            console.log(`[Poll] Stage: ${stage}, Progress: ${p}%, Downloads: ${status.downloads?.length || 0}`);

            if (p >= 95 && p < 100 && (!Array.isArray(status.downloads) || status.downloads.length === 0)) {
                stuckAt95Count++;
                console.log(`[Poll] Stuck at ${p}% for ${stuckAt95Count} iterations`);

                if (stuckAt95Count >= maxStuckRetries) {
                    console.log(`[Poll] Been stuck too long, trying GLB nudge...`);
                    try {
                        const r = await fetch(`/api/rawmodel/${rawId}/add-formats`, { method: 'POST' });
                        if (!r.ok) {
                            const txt = await r.text().catch(() => '');
                            console.warn('add-formats failed:', r.status, txt);
                        } else {
                            console.log('[Poll] GLB nudge sent successfully');
                        }
                    } catch (err) {
                        console.warn('add-formats network error:', err);
                    }

                    stuckAt95Count = 0;
                    maxStuckRetries = 15;
                }
            } else {
                stuckAt95Count = 0;
            }

            if (stage !== currentStage) {
                console.log(`[Poll] Stage transition: ${currentStage} → ${stage}`);

                if (stage === 'queued') {
                    queueStart = now;
                }
                if (stage === 'processing') {
                    if (queueStart > 0) updateAvgMs('queued', now - queueStart);
                    procStart = now;
                }
                if (stage === 'ready') {
                    if (currentStage === 'processing' && procStart > 0) updateAvgMs('processing', now - procStart);
                    if (currentStage === 'queued' && queueStart > 0) updateAvgMs('queued', now - queueStart);
                }
                currentStage = stage;
            }

            if (stage === 'queued') {
                const avg = getAvgMs('queued');
                const elapsed = now - (queueStart || startedAt);
                const mapped = progressForStage('queued', elapsed, avg);
                p = Math.max(p, mapped);
                const remaining = Math.max(5_000, avg - elapsed);
                state.eta = elapsed > avg * 1.75 ? 'Taking longer than usual…' : `≈ ${humanizeMs(remaining)}`;
                state.indeterminate = false;

            } else if (stage === 'processing') {
                const avg = getAvgMs('processing');
                const elapsed = now - (procStart || startedAt);
                const mapped = progressForStage('processing', elapsed, avg);
                p = Math.max(p, mapped);

                const nearCap = p >= 95;
                if (nearCap && (!Array.isArray(status.downloads) || status.downloads.length === 0)) {
                    state.eta = 'Finalizing (preparing downloads)…';
                    state.indeterminate = true;
                } else {
                    const remaining = Math.max(10_000, avg - elapsed);
                    state.eta = elapsed > avg * 1.75
                        ? 'Taking longer than usual…'
                        : `≈ ${humanizeMs(remaining)}`;
                    state.indeterminate = false;
                }

            } else if (stage === 'ready') {
                p = 100;
                state.eta = 'Done';
                state.indeterminate = false;

            } else if (stage === 'error') {
                p = 0;
                state.eta = 'Error occurred';
                state.indeterminate = false;
                error.value = 'Optimization failed. Please try again.';
                break;

            } else {
                state.eta = 'Calculating…';
                state.indeterminate = true;
            }

            state.progress = Math.min(100, Math.max(state.progress, p));
            state.stage = stage;

            if (status.rapidmodelId) rapidmodelId.value = Number(status.rapidmodelId);

            if (Array.isArray(status.downloads) && status.downloads.length > 0) {
                downloads.value = status.downloads;
                console.log(`[Poll] Downloads available: ${status.downloads.length} files`);
            }

            if (stage === 'ready' && Array.isArray(status.downloads) && status.downloads.length > 0) {
                console.log('[Poll] Optimization complete with downloads');
                break;
            }

            if (stage === 'error') {
                console.log('[Poll] Optimization failed');
                break;
            }

            if (p >= 95 && stage === 'processing') {
                delay = Math.min(3000, delay);
            } else {
                delay = Math.min(8000, Math.floor(delay * 1.2));
            }

        } catch (err) {
            console.error('[Poll] Network error:', err);
            state.indeterminate = true;
            delay = Math.min(10000, Math.floor(delay * 1.5));
        }

        await new Promise(r => setTimeout(r, delay));
    }
}

// ---------------- Enhanced main flow with better deduplication ----------------
async function startFlow() {
    error.value = null
    statusMsg.value = ''
    downloads.value = []
    rapidmodelId.value = null
    rawmodelId.value = null
    stop = false

    if (!file.value) return

    try {
        busy.value = true

        // Use pre-computed hash if available, otherwise compute it
        let contentHash = currentFileHash.value
        if (!contentHash) {
            statusMsg.value = 'Computing file hash for deduplication…'
            contentHash = await sha256File(file.value)
            currentFileHash.value = contentHash
        }

        console.log(`[Flow] Starting with file hash: ${contentHash}`)

        // 1) Check for existing asset with strong deduplication
        statusMsg.value = 'Checking for existing identical assets…'
        const existing = await findExistingByHash(contentHash)

        if (existing.found && existing.id) {
            rawmodelId.value = Number(existing.id)
            statusMsg.value = `Found existing asset (#${rawmodelId.value}: "${existing.name}"). Skipping upload…`
            console.log(`[Flow] Using existing asset: ${rawmodelId.value}`)
        } else {
            // 2) Start new upload
            statusMsg.value = 'Creating new upload session…'
            const start = await backend('/api/start-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modelName: modelName.value || file.value.name,
                    filename: file.value.name,
                    contentHash: contentHash
                })
            })

            rawmodelId.value = Number(start.id)
            console.log(`[Flow] Created upload session: ${rawmodelId.value}`)

            if (!start.exists) {
                // 3) Upload file
                statusMsg.value = 'Uploading to storage…'
                const put = await fetch(start.signedUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: await file.value.arrayBuffer()
                })
                if (!put.ok) throw new Error(`S3 PUT failed: ${put.status} ${put.statusText}`)

                // 4) Complete upload
                statusMsg.value = 'Finalizing upload…'
                await backend(`/api/complete-upload/${rawmodelId.value}`, { method: 'POST' })

                // 5) Add hash tags immediately after upload
                statusMsg.value = 'Adding deduplication tags…'
                await ensureHashTags(rawmodelId.value, contentHash, file.value.name)

                console.log(`[Flow] Upload completed and tagged: ${rawmodelId.value}`)
            } else {
                console.log(`[Flow] Upload session found existing file: ${rawmodelId.value}`)
            }
        }

        // 6) Request optimization
        statusMsg.value = 'Requesting optimization…'
        await backend('/api/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawmodelId: rawmodelId.value, presetId: presetId.value })
        })

        // 7) Poll status until ready
        statusMsg.value = 'Tracking optimization progress…'
        await pollStatus(rawmodelId.value!)
        statusMsg.value = 'Optimization completed!'

    } catch (e: any) {
        console.error('[Flow] Error:', e)
        error.value = e?.message || String(e)
        statusMsg.value = ''
    } finally {
        busy.value = false
    }
}

function cancel() {
    stop = true
    busy.value = false
    statusMsg.value = 'Cancelled by user.'
}

onBeforeUnmount(() => { stop = true })
onMounted(() => {
    console.log('[App] Mesh Optimizer loaded')
})
</script>

<style>
:root {
    color-scheme: light dark;
}
</style>