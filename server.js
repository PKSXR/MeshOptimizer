// server.js
import express from "express";
import fetch from "node-fetch";
import morgan from "morgan";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors()); // tighten for prod (e.g., CORS allowlist)
app.use(express.json({ limit: "200mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public"))); // serve frontend

const API_BASE = process.env.RP_API_BASE || "https://api.rapidpipeline.com/api/v2";
const RP_TOKEN = process.env.RAPIDPIPELINE_TOKEN;

if (!RP_TOKEN) {
  console.error("Missing RAPIDPIPELINE_TOKEN in environment.");
  process.exit(1);
}

// Helper to call RapidPipeline API with server-side token
// --- replace your rp() with this robust version ---
async function rp(endpoint, method = "GET", body) {
  const res = await fetch(API_BASE + endpoint, {
    method,
    headers: {
      "Authorization": `Bearer ${RP_TOKEN}`,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  // Grab the body as TEXT once; decide how to interpret it.
  const status = res.status;
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text().catch(() => "");

  if (!res.ok) {
    // Include upstream text in the error so you can see what happened.
    throw new Error(`${method} ${endpoint} -> ${status} ${res.statusText} ${raw}`);
  }

  // 204 or empty body? Return {} so callers can proceed without parsing errors.
  if (status === 204 || raw.length === 0) return {};

  // JSON when content-type says so (but still guard against bad/missing JSON)
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw); } catch {
      // If upstream sent bogus JSON, surface a useful error that includes raw.
      throw new Error(`${method} ${endpoint} -> Invalid JSON:\n${raw.slice(0, 500)}`);
    }
  }

  // Not JSON: return text (some RP endpoints may do this rarely)
  return raw;
}


// 1) Start upload: returns { id, signedUrl }
app.post("/api/start-upload", async (req, res) => {
  const { modelName, filename } = req.body || {};
  if (!modelName || !filename) return res.status(400).json({ error: "modelName and filename required" });

  const start = await rp("/rawmodel/api-upload/start", "POST", {
    model_name: modelName,
    filenames: [filename],
    is_zip: false
  });

  const id = start.id;
  const signedUrl = start.links?.s3_upload_urls?.[filename];
  if (!id || !signedUrl) return res.status(502).json({ error: "Failed to create upload" });

  res.json({ id, signedUrl });
});

// 2) Complete upload
app.post("/api/complete-upload/:id", async (req, res) => {
  const id = req.params.id;
  const data = await rp(`/rawmodel/${id}/api-upload/complete`, "GET");
  res.json(data);
});

// 3) Poll analysis status
app.get("/api/rawmodel/:id", async (req, res) => {
  const id = req.params.id;
  const data = await rp(`/rawmodel/${id}`, "GET");
  res.json(data);
});

// 4) Request optimization (custom preset or standard)
app.post("/api/optimize", async (req, res) => {
  const { rawmodelId, presetId, presetKey } = req.body || {};
  if (!rawmodelId) return res.status(400).json({ error: "rawmodelId required" });

  const config = {};
  if (presetId) config.preset_id = Number(presetId);
  else if (presetKey) config.preset_key = presetKey;
  else config.preset_key = "web-medium";

  const out = await rp("/rawmodel/optimize", "POST", {
    optimizations: [{ model_id: rawmodelId, config }]
  });
  res.json(out);
});

// 5) List rapidmodels (for progress + done)
app.get("/api/rawmodel/:id/rapidmodels", async (req, res) => {
  const id = req.params.id;
  const data = await rp(`/rawmodel/${id}/rapidmodels`, "GET");
  res.json(data);
});

// 6) Get downloads for a rapidmodel
app.get("/api/rapidmodel/:id/downloads", async (req, res) => {
  const id = req.params.id;
  const data = await rp(`/rapidmodel/${id}/downloads`, "GET");
  res.json(data);
});

// 7) Fallback: request raw conversion + poll downloads
app.post("/api/rawmodel/:id/add-formats", async (req, res) => {
  const id = req.params.id;
  const data = await rp(`/rawmodel/${id}/addFormats`, "POST", { formats: ["glb"] });
  res.json(data);
});
app.get("/api/rawmodel/:id/downloads", async (req, res) => {
  const id = req.params.id;
  const data = await rp(`/rawmodel/${id}/downloads`, "GET");
  res.json(data);
});

// 8) Optional: proxy the final GLB download (hides RapidPipeline URL from browser)
app.get("/api/proxy-download", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("missing url");

  const r = await fetch(url);
  if (!r.ok) return res.status(502).send("upstream download failed");

  res.setHeader("Content-Type", r.headers.get("content-type") || "application/octet-stream");
  res.setHeader("Content-Disposition", 'attachment; filename="model.glb"');
  r.body.pipe(res);
});

// SPA fallback (optional)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`RapidPipeline Optimizer backend listening on :${port}`));
