import express from "express";
import fetch from "node-fetch";            // On Node 18+, you can use global fetch and remove this
import morgan from "morgan";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public"))); // index.html + app.js in /public

// ---- RapidPipeline config ----
const API_BASE = process.env.RP_API_BASE || "https://api.rapidpipeline.com/api/v2";
const RP_TOKEN = process.env.RAPIDPIPELINE_TOKEN;
if (!RP_TOKEN) {
  console.error("Missing RAPIDPIPELINE_TOKEN (RapidPipeline API v2 token).");
  process.exit(1);
}

// Default preset id (your custom one). Can be overridden by frontend body.presetId.
const DEFAULT_PRESET_ID = Number(process.env.RP_PRESET_ID || 9547);

// ---- generic RP caller ----
async function rp(endpoint, method = "GET", body) {
  const res = await fetch(API_BASE + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${RP_TOKEN}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const status = res.status;
  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`${method} ${endpoint} -> ${status} ${res.statusText} ${text}`);
  }

  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------- Resilient search (avoids 500s) ----------
async function rpSafe(endpoint, method = "GET", body) {
  try {
    return await rp(endpoint, method, body);
  } catch (e) {
    return { __rp_error: true, __rp_message: e.message || String(e) };
  }
}

// Try ?q=<query> (searches name or tag). Return item whose tag exactly == query.
async function searchByQ(query) {
  let next = `/rawmodel?q=${encodeURIComponent(query)}`;
  while (next) {
    const data = await rpSafe(next, "GET");
    if (data?.__rp_error) return null; // upstream search errored (e.g., 500) → try another query
    const items = Array.isArray(data?.data) ? data.data : [];
    const hit = items.find((it) => {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      return tags.some((t) => (t?.name || t)?.toLowerCase() === query.toLowerCase());
    });
    if (hit) return hit;
    const n = data?.links?.next;
    next = n ? n.replace(API_BASE, "") : null;
  }
  return null;
}

// Full pagination without q; exact tag check locally
async function scanAllPagesForTag(tagLower) {
  let next = `/rawmodel`;
  while (next) {
    const data = await rpSafe(next, "GET");
    if (data?.__rp_error) return null;
    const items = Array.isArray(data?.data) ? data.data : [];
    const hit = items.find((it) => {
      const tags = Array.isArray(it.tags) ? it.tags : [];
      return tags.some((t) => (t?.name || t)?.toLowerCase() === tagLower);
    });
    if (hit) return hit;
    const n = data?.links?.next;
    next = n ? n.replace(API_BASE, "") : null;
  }
  return null;
}

// Find by SHA256 (uses safe tag first, raw hash, then colon tag, then scans)
async function findByHash(hash) {
  const tagSafe = `sha256-${hash}`; // colon-free (safe for ?q)
  const tagColon = `hash:${hash}`;  // legacy tag with colon

  // prefer ?q (fast)
  const hit1 = await searchByQ(tagSafe);  if (hit1) return hit1;
  const hit2 = await searchByQ(hash);     if (hit2) return hit2;
  const hit3 = await searchByQ(tagColon); if (hit3) return hit3;

  // fallbacks (never 500)
  const s1 = await scanAllPagesForTag(tagSafe.toLowerCase());  if (s1) return s1;
  const s2 = await scanAllPagesForTag(tagColon.toLowerCase()); if (s2) return s2;

  return null;
}

// ---------- Routes ----------

// health (optional)
app.get("/health", async (req, res) => {
  const ping = await rpSafe("/rawmodel?q=health", "GET");
  res.json({ ok: !ping.__rp_error, upstream_error: ping.__rp_message || null });
});

// idempotency check
app.get("/api/find-by-hash", async (req, res) => {
  try {
    const { hash } = req.query || {};
    if (!hash) return res.status(400).json({ error: "hash required" });
    const hit = await findByHash(hash);
    if (!hit) return res.json({ found: false });
    res.json({ found: true, id: hit.id, name: hit.name });
  } catch (e) {
    // Never 500 to client for existence check
    res.status(200).json({ found: false, note: "fallback: suppressed error", detail: String(e) });
  }
});

// add/merge tags on a base asset
app.post("/api/rawmodel/:id/tags", async (req, res) => {
  try {
    const id = req.params.id;
    const incoming = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const cur = await rp(`/rawmodel/${id}`, "GET");
    const currentTags = (cur?.data?.tags || []).map((t) => t?.name || t).filter(Boolean);
    const nextTags = Array.from(new Set([...currentTags, ...incoming])); // dedupe
    const out = await rp(`/rawmodel/${id}`, "PUT", { tags: nextTags });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// start upload (short-circuits if asset with same hash exists)
app.post("/api/start-upload", async (req, res) => {
  try {
    const { modelName, filename, contentHash } = req.body || {};
    if (!modelName || !filename) {
      return res.status(400).json({ error: "modelName and filename required" });
    }

    if (contentHash) {
      const hit = await findByHash(contentHash);
      if (hit) return res.json({ id: hit.id, exists: true });
    }

    const start = await rp("/rawmodel/api-upload/start", "POST", {
      model_name: modelName,
      filenames: [filename],
      is_zip: false,
    });

    const id = start.id;
    const signedUrl = start.links?.s3_upload_urls?.[filename];
    if (!id || !signedUrl) return res.status(502).json({ error: "Failed to create upload" });

    res.json({ id, signedUrl, exists: false });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// complete upload
app.post("/api/complete-upload/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await rp(`/rawmodel/${id}/api-upload/complete`, "GET");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// read base asset
app.get("/api/rawmodel/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await rp(`/rawmodel/${id}`, "GET");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// request optimize — use ONLY bulk endpoint; try id/key payload shapes
app.post("/api/optimize", async (req, res) => {
  try {
    const { rawmodelId, presetId, presetKey } = req.body || {};
    if (!rawmodelId) return res.status(400).json({ error: "rawmodelId required" });

    const effectivePresetId = Number(
      presetId ?? process.env.RP_PRESET_ID ?? DEFAULT_PRESET_ID
    );

    const bodies = [];

    // Prefer ID if available
    if (Number.isFinite(effectivePresetId)) {
      bodies.push({ optimizations: [{ model_id: rawmodelId, preset_id: effectivePresetId }] });             // top-level
      bodies.push({ optimizations: [{ model_id: rawmodelId, config: { preset_id: effectivePresetId } }] }); // inside config
    }

    // Also try by key if client sent it
    if (presetKey) {
      bodies.push({ optimizations: [{ model_id: rawmodelId, preset_key: presetKey }] });
      bodies.push({ optimizations: [{ model_id: rawmodelId, config: { preset_key: presetKey } }] });
    }

    // Last resort: no preset (frontend will fall back to convert if RP refuses)
    bodies.push({ optimizations: [{ model_id: rawmodelId }] });

    let lastErr = null;
    for (const b of bodies) {
      try {
        const out = await rp("/rawmodel/optimize", "POST", b); // BULK endpoint
        return res.json(out);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("All optimize payload variants failed");
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// list rapid models for a base asset
app.get("/api/rawmodel/:id/rapidmodels", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await rp(`/rawmodel/${id}/rapidmodels`, "GET");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// downloads for a rapid model
app.get("/api/rapidmodel/:id/downloads", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await rp(`/rapidmodel/${id}/downloads`, "GET");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// addFormats → GLB (fallback when optimize path fails)
app.post("/api/rawmodel/:id/add-formats", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await rp(`/rawmodel/${id}/addFormats`, "POST", { formats: ["glb"] });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// downloads for a base asset (converted)
app.get("/api/rawmodel/:id/downloads", async (req, res) => {
  try {
    const id = req.params.id;
    const data = await rp(`/rawmodel/${id}/downloads`, "GET");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// proxy final file download (keeps RP URL private)
app.get("/api/proxy-download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("missing url");
  const r = await fetch(url);
  if (!r.ok) return res.status(502).send("upstream download failed");
  res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Content-Disposition", 'attachment; filename="model.glb"');
  r.body.pipe(res);
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`RP Optimizer server running on http://localhost:${port}`));
