// public/app.js — stable ETA + exact total time

// ---------- Tiny helpers ----------
// Fixed helper functions with correct IDs
const byId = (id) => document.getElementById(id);

function setStatus(msg, isError=false) {
  const el = byId("status"); // Changed from "statusMessage" to "status"
  if (!el) return;
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
  el.style.display = "block"; // Make sure it's visible
}

function setProgress(pct) {
  const el = document.getElementById("fill"); // Changed from "progressFill" to "fill"
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function fmt(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}
function setETA(msLeft) {
  const el = byId("eta");
  if (el) el.textContent = `Estimated time remaining: ${fmt(msLeft)}`;
}
function setElapsed(ms) {
  const el = byId("elapsed");
  if (el) el.textContent = `Elapsed: ${fmt(ms)}`;
}
function showTotal(ms) {
  const el = byId("totalTime");
  if (!el) return;
  el.style.display = "block";
  el.textContent = `Total time: ${fmt(ms)}`;
}

// ---------- Stable ETA / timing ----------
const PHASES = ["upload", "analyze", "optimize", "convert", "download"];
let plan = { upload: 0, analyze: 0, optimize: 0, convert: 0, download: 0 }; // ms per phase
let jobStart = 0;
let fileSizeBytes = 0;
let currentPhase = null;
let phaseStart = 0;
let lastKnownOptimizeProgress = 0;
let timingTimer = null;

function buildPlan(bytes) {
  const clamp = (ms, min) => Math.max(min, Math.floor(ms || 0));
  plan.upload   = 10_000;                                       // provisional; refined live
  plan.analyze  = clamp(estimateAnalyzeMs(bytes), 3_000);
  plan.optimize = clamp(estimateOptimizeMs(bytes), 20_000);
  plan.convert  = clamp(estimateConvertMs(bytes), 10_000);
  plan.download = clamp(bytes / (10 * 1024 * 1024) * 1000, 4_000); // ~10MB/s default
}
function beginPhase(name, plannedMs) {
  currentPhase = name;
  phaseStart = Date.now();
  if (typeof plannedMs === "number" && plannedMs > 0) {
    plan[name] = plannedMs; // resize current phase only (no total reset)
  }
}
function phaseProgress(name) {
  const now = Date.now();
  const elapsed = now - phaseStart;
  const budget = Math.max(1, plan[name] || 1);

  if (name === "optimize") {
    if (lastKnownOptimizeProgress > 0 && lastKnownOptimizeProgress < 100) {
      return Math.min(0.99, lastKnownOptimizeProgress / 100);
    }
    return Math.max(0, Math.min(0.99, elapsed / budget));
  }
  return Math.max(0, Math.min(0.99, elapsed / budget));
}
function remainingFromPlan() {
  if (!currentPhase) return 0;
  const idx = PHASES.indexOf(currentPhase);
  if (idx < 0) return 0;

  let rem = (plan[currentPhase] || 0) * (1 - phaseProgress(currentPhase));
  for (let i = idx + 1; i < PHASES.length; i++) rem += (plan[PHASES[i]] || 0);
  return Math.max(0, rem);
}
function startTimingLoop() {
  if (timingTimer) clearInterval(timingTimer);
  timingTimer = setInterval(() => {
    setElapsed(Date.now() - jobStart);
    setETA(remainingFromPlan());
  }, 1000);
}
function stopTimingLoop(finalize=false) {
  if (timingTimer) clearInterval(timingTimer);
  timingTimer = null;
  if (finalize) {
    const total = Date.now() - jobStart;
    setETA(0);
    setElapsed(total);
    showTotal(total);
  }
}

// ---------- Heuristics (size-tuned) ----------
function estimateAnalyzeMs(bytes) { const mb = bytes/(1024*1024); return Math.min(2*60_000, 15_000 + mb*150); }
function estimateOptimizeMs(bytes) { const mb = bytes/(1024*1024); return Math.min(12*60_000, 45_000 + mb*500); }
function estimateConvertMs(bytes) { const mb = bytes/(1024*1024); return Math.min(8*60_000, 30_000 + mb*300); }

// ---------- Backend API (token hidden server-side) ----------
async function backend(path, method="GET", data) {
  const res = await fetch(path, {
    method,
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}
async function startUpload(modelName, filename)  { return backend("/api/start-upload", "POST", { modelName, filename }); }
async function completeUpload(id)                { return backend(`/api/complete-upload/${id}`, "POST"); }
async function getRawmodel(id)                   { return backend(`/api/rawmodel/${id}`, "GET"); }
async function requestOptimize(rawmodelId, p)    { return backend("/api/optimize", "POST", { rawmodelId, ...p }); }
async function listRapidModels(rawmodelId)       { return backend(`/api/rawmodel/${rawmodelId}/rapidmodels`, "GET"); }
async function rapidDownloads(rapidmodelId)      { return backend(`/api/rapidmodel/${rapidmodelId}/downloads`, "GET"); }
async function addFormats(rawmodelId)            { return backend(`/api/rawmodel/${rawmodelId}/add-formats`, "POST"); }
async function rawDownloads(rawmodelId)          { return backend(`/api/rawmodel/${rawmodelId}/downloads`, "GET"); }

// XHR upload with progress (for live throughput)
function uploadFileWithProgress(signedUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === "function") onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });
}

// ---------- Preset (adjust as you like) ----------
const PRESET = { presetId: 9547 }; // or { presetKey: "web-medium" }

// ---------- Main processing ----------
let currentProcessingId = null;

async function ensureAnalyzed(rawmodelId, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await getRawmodel(rawmodelId);
    const d = info?.data || info || {};
    const an = (d.analysis_status || d.status || "").toString().toLowerCase();
    if (["done","complete","finished","ready","success"].includes(an)) return true;
    await new Promise(r => setTimeout(r, 4000));
  }
  return false;
}

async function waitForOptimizedGLB(rawmodelId, maxWaitMs = 20 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const list = await listRapidModels(rawmodelId);
    const arr = Array.isArray(list?.data) ? list.data : [];
    arr.sort((a,b)=> new Date(b.created_at||0) - new Date(a.created_at||0));

    const fail = arr.find(m => m.optimization_status==="error" || m.status==="error");
    if (fail) throw new Error(fail.error_message || "Optimization error");

    const active = arr.find(m => typeof m.progress === "number" && m.progress < 100);
    if (active) lastKnownOptimizeProgress = Math.max(0, Math.min(100, active.progress));

    const done = arr.find(m => m.progress===100 || m.optimization_status==="done" || m.status==="done");
    if (done) {
      let dls = done.downloads;
      if (!dls && done.id) dls = await rapidDownloads(done.id);
      const url = dls?.glb || dls?.GLB;
      if (url) return url;
    }
    await new Promise(r => setTimeout(r, 7000));
    setProgress(Math.min(90, ((Date.now() - t0) / maxWaitMs) * 100));
  }
  throw new Error("Optimization timeout");
}

async function waitForConvertedGLB(rawmodelId) {
  await addFormats(rawmodelId);
  const t0 = Date.now(), maxWaitMs = 15 * 60 * 1000;
  while (Date.now() - t0 < maxWaitMs) {
    const dls = await rawDownloads(rawmodelId);
    let glb = null;
    if (dls?.converted) {
      const entry = Object.entries(dls.converted).find(([k]) => k.toLowerCase().endsWith(".glb"));
      if (entry) glb = entry[1];
    } else {
      const entry = Object.entries(dls||{}).find(([k]) => k.toLowerCase().endsWith(".glb"));
      if (entry) glb = entry[1];
    }
    if (glb) return glb;
    await new Promise(r => setTimeout(r, 6000));
    setProgress(Math.min(85, ((Date.now() - t0) / maxWaitMs) * 100));
  }
  throw new Error("Conversion timeout");
}

async function processFile(file) {
  const name = file.name;
  const base = name.split(".").slice(0, -1).join(".") || name;

  // Initialize timing once per job
  jobStart = Date.now();
  fileSizeBytes = file.size;
  lastKnownOptimizeProgress = 0;
  buildPlan(file.size);
  startTimingLoop();

  // Upload
  setStatus("Starting upload…"); setProgress(10);
  beginPhase("upload", Math.max(5_000, file.size / (5 * 1024 * 1024) * 1000)); // 5 MB/s initial guess

  const up = await startUpload(base, name);
  const rawmodelId = up.id;
  const signedUrl = up.signedUrl;
  if (!signedUrl) throw new Error("No signed upload URL returned");

  setStatus("Uploading file…"); setProgress(30);
  const upStarted = Date.now();
  await uploadFileWithProgress(signedUrl, file, (frac) => {
    setProgress(10 + Math.floor(frac * 20)); // 10 → 30%
    // refine upload plan using real throughput
    const sec = (Date.now() - upStarted) / 1000;
    const sent = Math.max(1, Math.floor(file.size * frac));
    const rate = sent / sec; // bytes/s
    if (isFinite(rate) && rate > 0) {
      const remainMs = (file.size - sent) / rate * 1000;
      plan.upload = (Date.now() - phaseStart) + remainMs; // resize current phase only
    }
  });

  await completeUpload(rawmodelId);

  // Analyze
  setStatus("Analyzing model…"); setProgress(45);
  beginPhase("analyze", plan.analyze);
  await ensureAnalyzed(rawmodelId);

  // Optimize (or fallback)
  setStatus("Optimizing with preset…"); setProgress(55);
  await requestOptimize(rawmodelId, PRESET);

  setStatus("Waiting for optimized GLB…"); setProgress(70);
  beginPhase("optimize", plan.optimize);

  let downloadUrl, wasOptimized = true;
  try {
    downloadUrl = await waitForOptimizedGLB(rawmodelId);
  } catch (e) {
    wasOptimized = false;
    setStatus("Optimization failed — converting to GLB…", true);
    beginPhase("convert", plan.convert);
    downloadUrl = await waitForConvertedGLB(rawmodelId);
  }

  // Download
  setStatus("Downloading processed model…"); setProgress(90);
  beginPhase("download", plan.download);

  // Proxy through backend to avoid exposing the upstream URL
  const resp = await fetch(`/api/proxy-download?url=${encodeURIComponent(downloadUrl)}`);
  if (!resp.ok) throw new Error("Download failed");
  const blob = await resp.blob();

  const outName = `${base}.glb`;
  const url = URL.createObjectURL(blob);
  const link = byId("downloadBtn") || byId("saveGlbBtn"); // support either id
  if (link) {
    link.href = url;
    link.download = outName;
    link.style.display = "inline-block";
    link.textContent = wasOptimized ? "Download Optimized GLB" : "Download GLB (converted)";
  }

  setProgress(100);
  setStatus("Processing complete — starting download…");
  stopTimingLoop(true); // shows Total time

  // Auto-download; revoke shortly after
  setTimeout(() => {
    link && link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 400);
}

// ---------- UI wiring ----------
const supported = [".fbx",".obj",".dae",".gltf",".3ds",".blend",".ply",".stl",".stp",".glb"];
let lastFailedFile = null;

function handleChosenFile(file) {
  if (!file) return;
  const ext = "." + file.name.toLowerCase().split(".").pop();
  if (!supported.includes(ext)) {
    alert(`Unsupported type: ${ext}\nSupported: ${supported.join(", ")}`);
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    const mb = (file.size / (1024*1024)).toFixed(2);
    const ok = confirm(`Large file detected (${mb} MB). Processing may take time. Continue?`);
    if (!ok) return;
  }

  currentProcessingId = Date.now();
  const modal = byId("processingModal");
  if (modal) modal.style.display = "block";
  const retryBtn = byId("retryProcessBtn");
  if (retryBtn) retryBtn.style.display = "none";

  // reset bars/text
  setProgress(0);
  setETA(0);
  setElapsed(0);
  const totalEl = byId("totalTime"); if (totalEl) totalEl.style.display = "none";

  processFile(file).catch(err => {
    console.error(err);
    stopTimingLoop(false);
    setStatus(`Error: ${err.message}`, true);
    const rb = byId("retryProcessBtn");
    if (rb) rb.style.display = "inline-block";
  }).finally(() => {
    currentProcessingId = null;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  // File input
  const inp = byId("fileInput");
  if (inp) {
    inp.addEventListener("change", (e) => {
      const f = e.target.files[0];
      lastFailedFile = f;
      handleChosenFile(f);
      e.target.value = "";
    });
  }

  // Drag & drop
  const drop = byId("drop") || document.body;
  ["dragover","dragenter"].forEach(ev => drop.addEventListener(ev, e => {
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    (drop.classList && drop.classList.add("dragover"));
  }));
  ["dragleave","dragend"].forEach(ev => drop.addEventListener(ev, () => {
    (drop.classList && drop.classList.remove("dragover"));
  }));
  drop.addEventListener("drop", e => {
    e.preventDefault(); (drop.classList && drop.classList.remove("dragover"));
    const f = e.dataTransfer.files[0];
    lastFailedFile = f;
    handleChosenFile(f);
  });

  // Cancel
  byId("cancelProcessBtn")?.addEventListener("click", () => {
    currentProcessingId = null;
    const modal = byId("processingModal");
    if (modal) modal.style.display = "none";
    stopTimingLoop(false);
    setStatus("Processing cancelled.", true);
    setProgress(0);
  });

  // Retry (inject if missing)
  let retryBtn = byId("retryProcessBtn");
  if (!retryBtn && byId("processingModal")) {
    retryBtn = document.createElement("button");
    retryBtn.id = "retryProcessBtn";
    retryBtn.textContent = "Retry";
    retryBtn.style.display = "none";
    retryBtn.className = "btn";
    byId("processingModal").querySelector(".modal-content")?.appendChild(retryBtn);
  }
  retryBtn?.addEventListener("click", () => {
    if (!lastFailedFile) return;
    retryBtn.style.display = "none";
    handleChosenFile(lastFailedFile);
  });
});
