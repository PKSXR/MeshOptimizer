// server.js — CommonJS version
require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch"); // On Node 18+, global fetch exists, but this keeps compatibility
const morgan = require("morgan");
const cors = require("cors");
const path = require("path");

// Import the meshOptimizer router (case sensitive!)
const meshOptimizer = require("./routes/meshOptimizer");

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));
app.use(morgan("dev"));
app.use(express.static(path.join(__dirname, "public"))); // serves /public (index.html, app.js, etc.)

// ---- RapidPipeline config (passed to router) ----
const API_BASE = process.env.RP_API_BASE || "https://api.rapidpipeline.com/api/v2";
const RP_TOKEN = process.env.RAPIDPIPELINE_TOKEN;
if (!RP_TOKEN) {
  console.error("❌ Missing RAPIDPIPELINE_TOKEN (RapidPipeline API v2 token).");
  process.exit(1);
}
const DEFAULT_PRESET_ID = Number(process.env.RP_PRESET_ID || 9547);

// Mount the mesh optimizer router at root so existing /api/... paths keep working.
app.use(
  "/",
  meshOptimizer({
    token: RP_TOKEN,
    apiBase: API_BASE,
    presetId: DEFAULT_PRESET_ID,
  })
);

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 RP Optimizer server running on http://localhost:${port}`);
});
