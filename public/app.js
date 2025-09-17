// public/app.js — idempotent upload with resilient search + safe colon-free tag

// ---------- DOM helpers ----------
const byId = (id) => document.getElementById(id);

function setStatus(msg, isError = false) {
  const el = byId("status");
  if (!el) return;
  el.textContent = msg;
  el.className = "status" + (isError ? " error" : "");
  el.style.display = "block";
}
function setProgress(pct) {
  const el = byId("fill");
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}
function fmt(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}
function setETA(msLeft) { const el = byId("eta"); if (el) el.textContent = `Estimated time remaining: ${fmt(msLeft)}`; }
function setElapsed(ms) { const el = byId("elapsed"); if (el) el.textContent = `Elapsed: ${fmt(ms)}`; }
function showTotal(ms)  { const el = byId("totalTime"); if (el) { el.style.display = "block"; el.textContent = `Total time: ${fmt(ms)}`; } }

// ---------- timing / plan ----------
const PHASES = ["upload", "analyze", "optimize", "convert", "download"];
let plan = { upload: 0, analyze: 0, optimize: 0, convert: 0, download: 0 };
let jobStart = 0, fileSizeBytes = 0, currentPhase = null, phaseStart = 0, lastKnownOptimizeProgress = 0, timingTimer = null;

function estimateAnalyzeMs(bytes) { const mb = bytes / (1024 * 1024); return Math.min(120000, 15000 + mb * 150); }
function estimateOptimizeMs(bytes){ const mb = bytes / (1024 * 1024); return Math.min(720000, 45000 + mb * 500); }
function estimateConvertMs(bytes) { const mb = bytes / (1024 * 1024); return Math.min(480000, 30000 + mb * 300); }

function buildPlan(bytes) {
  const clamp = (ms, min) => Math.max(min, Math.floor(ms || 0));
  plan.upload = 10000;
  plan.analyze = clamp(estimateAnalyzeMs(bytes), 3000);
  plan.optimize = clamp(estimateOptimizeMs(bytes), 20000);
  plan.convert = clamp(estimateConvertMs(bytes), 10000);
  plan.download = clamp((bytes / (10 * 1024 * 1024)) * 1000, 4000); // ~10MB/s
}
function beginPhase(name, plannedMs) { currentPhase = name; phaseStart = Date.now(); if (plannedMs > 0) plan[name] = plannedMs; }
function phaseProgress(name) {
  const budget = Math.max(1, plan[name] || 1);
  const elapsed = Date.now() - phaseStart;
  if (name === "optimize") {
    if (lastKnownOptimizeProgress > 0 && lastKnownOptimizeProgress < 100) {
      return Math.min(0.99, lastKnownOptimizeProgress / 100);
    }
  }
  return Math.max(0, Math.min(0.99, elapsed / budget));
}
function remainingFromPlan() {
  if (!currentPhase) return 0;
  const idx = PHASES.indexOf(currentPhase); if (idx < 0) return 0;
  let rem = (plan[currentPhase] || 0) * (1 - phaseProgress(currentPhase));
  for (let i = idx + 1; i < PHASES.length; i++) rem += plan[PHASES[i]] || 0;
  return Math.max(0, rem);
}
function startTimingLoop() {
  if (timingTimer) clearInterval(timingTimer);
  timingTimer = setInterval(() => { setElapsed(Date.now() - jobStart); setETA(remainingFromPlan()); }, 1000);
}
function stopTimingLoop(finalize = false) {
  if (timingTimer) clearInterval(timingTimer);
  timingTimer = null;
  if (finalize) {
    const total = Date.now() - jobStart;
    setETA(0); setElapsed(total); showTotal(total);
  }
}

// ---------- backend wrappers ----------
async function backend(path, method = "GET", data) {
  const res = await fetch(path, { method, headers: data ? { "Content-Type": "application/json" } : undefined, body: data ? JSON.stringify(data) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}
const startUpload = (modelName, filename, contentHash) => backend("/api/start-upload", "POST", { modelName, filename, contentHash });
const completeUpload = (id) => backend(`/api/complete-upload/${id}`, "POST");
const getRawmodel = (id) => backend(`/api/rawmodel/${id}`, "GET");
const requestOptimize = (rawmodelId, p) => backend("/api/optimize", "POST", { rawmodelId, ...p });
const listRapidModels = (rawmodelId) => backend(`/api/rawmodel/${rawmodelId}/rapidmodels`, "GET");
const rapidDownloads = (rapidmodelId) => backend(`/api/rapidmodel/${rawmodelId}/downloads`, "GET");
const addFormats = (rawmodelId) => backend(`/api/rawmodel/${rawmodelId}/add-formats`, "POST");
const rawDownloads = (rawmodelId) => backend(`/api/rawmodel/${rawmodelId}/downloads`, "GET");
const findByHash = (hash) => backend(`/api/find-by-hash?hash=${encodeURIComponent(hash)}`, "GET");
const addTags = (rawmodelId, tags) => backend(`/api/rawmodel/${rawmodelId}/tags`, "POST", { tags });

// upload with progress (to RP's presigned URL)
function uploadFileWithProgress(signedUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signedUrl, true);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(file);
  });
}

// hashing
async function sha256OfFile(file) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// IMPORTANT: let the SERVER choose the preset via RP_PRESET_ID (no hardcoding here)
const PRESET = {}; // server defaults to RP_PRESET_ID=9547

async function ensureAnalyzed(rawmodelId, timeoutMs = 10 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const info = await getRawmodel(rawmodelId);
    const d = info?.data || info || {};
    const an = (d.analysis_status || d.status || "").toString().toLowerCase();
    if (["done", "complete", "finished", "ready", "success"].includes(an)) return true;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return false;
}

async function waitForOptimizedGLB(rawmodelId, maxWaitMs = 20 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const list = await listRapidModels(rawmodelId);
    const arr = Array.isArray(list?.data) ? list.data : [];
    arr.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const fail = arr.find((m) => m.optimization_status === "error" || m.status === "error");
    if (fail) throw new Error(fail.error_message || "Optimization error");

    const active = arr.find((m) => typeof m.progress === "number" && m.progress < 100);
    if (active) lastKnownOptimizeProgress = Math.max(0, Math.min(100, active.progress));

    const done = arr.find((m) => m.progress === 100 || m.optimization_status === "done" || m.status === "done");
    if (done) {
      let dls = done.downloads;
      if (!dls && done.id) dls = await rapidDownloads(done.id);
      const url = dls?.glb || dls?.GLB;
      if (url) return url;
    }
    await new Promise((r) => setTimeout(r, 7000));
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
      const entry = Object.entries(dls || {}).find(([k]) => k.toLowerCase().endsWith(".glb"));
      if (entry) glb = entry[1];
    }
    if (glb) return glb;
    await new Promise((r) => setTimeout(r, 6000));
    setProgress(Math.min(85, ((Date.now() - t0) / maxWaitMs) * 100));
  }
  throw new Error("Conversion timeout");
}

async function processFile(file) {
  const name = file.name;
  const base = name.split(".").slice(0, -1).join(".") || name;

  // timing setup
  jobStart = Date.now(); fileSizeBytes = file.size; lastKnownOptimizeProgress = 0;
  buildPlan(file.size); startTimingLoop();

  // 1) compute content hash
  setStatus("Computing file hash…"); setProgress(5);
  const contentHash = await sha256OfFile(file);

  // 2) check existence (server uses safe queries + fallbacks)
  const existsInfo = await findByHash(contentHash);
  if (existsInfo?.found && existsInfo.id) {
    const rawmodelId = existsInfo.id;
    setStatus(`Found existing asset (#${rawmodelId}). Skipping upload…`); setProgress(45);

    beginPhase("analyze", plan.analyze);
    await ensureAnalyzed(rawmodelId);

    setStatus("Optimizing with preset…"); setProgress(55);
    await requestOptimize(rawmodelId, PRESET);

    setStatus("Waiting for optimized GLB…"); setProgress(70);
    beginPhase("optimize", plan.optimize);

    let downloadUrl, wasOptimized = true;
    try {
      downloadUrl = await waitForOptimizedGLB(rawmodelId);
    } catch {
      wasOptimized = false;
      setStatus("Optimization failed — converting to GLB…", true);
      beginPhase("convert", plan.convert);
      downloadUrl = await waitForConvertedGLB(rawmodelId);
    }

    setStatus("Downloading processed model…"); setProgress(90);
    beginPhase("download", plan.download);
    const resp = await fetch(`/api/proxy-download?url=${encodeURIComponent(downloadUrl)}`);
    if (!resp.ok) throw new Error("Download failed");
    const blob = await resp.blob();

    const outName = `${base}.glb`;
    const url = URL.createObjectURL(blob);
    const link = byId("downloadBtn");
    if (link) {
      link.href = url;
      link.download = outName;
      link.style.display = "inline-block";
      link.textContent = wasOptimized ? "Download Optimized GLB" : "Download GLB (converted)";
    }

    setProgress(100); setStatus("Processing complete — starting download…");
    stopTimingLoop(true);
    setTimeout(() => { link && link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); }, 400);
    return;
  }

  // 3) start upload (server will also short-circuit if it independently finds a hit)
  setStatus("Starting upload…"); setProgress(10);
  beginPhase("upload", Math.max(5000, (file.size / (5 * 1024 * 1024)) * 1000)); // assume ~5MB/s

  const up = await startUpload(base, name, contentHash);
  const rawmodelId = up.id;

  if (!up.exists) {
    const signedUrl = up.signedUrl;
    if (!signedUrl) throw new Error("No signed upload URL returned");

    setStatus("Uploading file…"); setProgress(30);
    const upStarted = Date.now();
    await uploadFileWithProgress(signedUrl, file, (frac) => {
      setProgress(10 + Math.floor(frac * 20)); // 10 → 30
      const sec = (Date.now() - upStarted) / 1000;
      const sent = Math.max(1, Math.floor(file.size * frac));
      const rate = sent / sec; // bytes/s
      if (isFinite(rate) && rate > 0) {
        const remainMs = ((file.size - sent) / rate) * 1000;
        plan.upload = Date.now() - phaseStart + remainMs;
      }
    });

    await completeUpload(rawmodelId);

    // add both safe and legacy tags so future searches are instant
    await addTags(rawmodelId, [
      `sha256-${contentHash}`,  // safe for ?q
      `hash:${contentHash}`,    // legacy colon tag
      `filename:${name}`,
    ]);
  } else {
    setStatus(`Found existing asset (#${rawmodelId}). Skipping upload…`);
  }

  // 4) analyze → optimize (or fallback convert) → download
  setStatus("Analyzing model…"); setProgress(45);
  beginPhase("analyze", plan.analyze);
  await ensureAnalyzed(rawmodelId);

  setStatus("Optimizing with preset…"); setProgress(55);
  await requestOptimize(rawmodelId, PRESET);

  setStatus("Waiting for optimized GLB…"); setProgress(70);
  beginPhase("optimize", plan.optimize);

  let downloadUrl, wasOptimized = true;
  try {
    downloadUrl = await waitForOptimizedGLB(rawmodelId);
  } catch {
    wasOptimized = false;
    setStatus("Optimization failed — converting to GLB…", true);
    beginPhase("convert", plan.convert);
    downloadUrl = await waitForConvertedGLB(rawmodelId);
  }

  setStatus("Downloading processed model…"); setProgress(90);
  beginPhase("download", plan.download);

  const resp = await fetch(`/api/proxy-download?url=${encodeURIComponent(downloadUrl)}`);
  if (!resp.ok) throw new Error("Download failed");
  const blob = await resp.blob();

  const outName = `${base}.glb`;
  const url = URL.createObjectURL(blob);
  const link = byId("downloadBtn");
  if (link) {
    link.href = url;
    link.download = outName;
    link.style.display = "inline-block";
    link.textContent = wasOptimized ? "Download Optimized GLB" : "Download GLB (converted)";
  }

  setProgress(100); setStatus("Processing complete — starting download…");
  stopTimingLoop(true);

  setTimeout(() => {
    link && link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, 400);
}

// ---------- UI wiring ----------
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = byId("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleChosenFile(f);
      e.target.value = "";
    });
  }

  const drop = byId("drop") || document.body;
  ["dragover", "dragenter"].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; drop.classList?.add("dragover"); })
  );
  ["dragleave", "dragend"].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList?.remove("dragover"))
  );
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList?.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) handleChosenFile(f);
  });

  byId("cancelBtn")?.addEventListener("click", () => {
    stopTimingLoop(false);
    setStatus("Processing cancelled.", true);
    setProgress(0);
  });
});

const supported = [".fbx", ".obj", ".dae", ".gltf", ".3ds", ".blend", ".ply", ".stl", ".stp", ".glb"];
function handleChosenFile(file) {
  const ext = "." + file.name.toLowerCase().split(".").pop();
  if (!supported.includes(ext)) {
    alert(`Unsupported type: ${ext}\nSupported: ${supported.join(", ")}`); return;
  }
  if (file.size > 50 * 1024 * 1024) {
    const mb = (file.size / (1024 * 1024)).toFixed(2);
    if (!confirm(`Large file detected (${mb} MB). Continue?`)) return;
  }
  // reset displays
  setProgress(0); setETA(0); setElapsed(0);
  const tt = byId("totalTime"); if (tt) tt.style.display = "none";

  processFile(file).catch((err) => {
    console.error(err);
    stopTimingLoop(false);
    setStatus(`Error: ${err.message}`, true);
  });
}
