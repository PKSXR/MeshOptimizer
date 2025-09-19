// routes/meshOptimizer.js
// Express Router that wraps the RapidPipeline "mesh optimizer" API flows
// Usage: const meshOptimizer = require('./routes/meshOptimizer');
//        app.use('/mesh-optimizer', meshOptimizer({ token: process.env.RAPIDPIPELINE_TOKEN, apiBase: 'https://api.rapidpipeline.com/api/v2', presetId: 9547 }));

const express = require('express');
const path = require('path');

// If you're on Node 18+, global fetch exists. Otherwise uncomment:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

/**
 * Create a router with all optimizer endpoints.
 * @param {Object} opts
 * @param {string} opts.token - RapidPipeline token (required)
 * @param {string} [opts.apiBase='https://api.rapidpipeline.com/api/v2']
 * @param {number} [opts.presetId=9547]
 */
module.exports = function meshOptimizer(opts = {}) {
  const router = express.Router();

  const API_BASE = String(opts.apiBase || 'https://api.rapidpipeline.com/api/v2');
  const RP_TOKEN = String(opts.token || '');
  const DEFAULT_PRESET_ID = Number.isFinite(Number(opts.presetId)) ? Number(opts.presetId) : 9547;

  if (!RP_TOKEN) {
    // Fail fast on misconfiguration
    throw new Error('meshOptimizer: RAPIDPIPELINE token is required. Pass { token: process.env.RAPIDPIPELINE_TOKEN }');
  }

  router.use(express.json({ limit: '200mb' }));

  // ---- generic RP caller ----
  async function rp(endpoint, method = 'GET', body) {
    const res = await fetch(API_BASE + endpoint, {
      method,
      headers: {
        Authorization: `Bearer ${RP_TOKEN}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const status = res.status;
    const text = await res.text().catch(() => '');

    if (!res.ok) {
      throw new Error(`${method} ${endpoint} -> ${status} ${res.statusText} ${text}`);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return text; }
  }

  // ---------- Resilient helpers ----------
  async function rpSafe(endpoint, method = 'GET', body) {
    try { return await rp(endpoint, method, body); }
    catch (e) { return { __rp_error: true, __rp_message: e.message || String(e) }; }
  }

  async function searchByQ(query) {
    let next = `/rawmodel?q=${encodeURIComponent(query)}`;
    while (next) {
      const data = await rpSafe(next, 'GET');
      if (data?.__rp_error) return null;
      const items = Array.isArray(data?.data) ? data.data : [];
      const hit = items.find((it) => {
        const tags = Array.isArray(it.tags) ? it.tags : [];
        return tags.some((t) => (t?.name || t)?.toLowerCase() === query.toLowerCase());
      });
      if (hit) return hit;
      const n = data?.links?.next;
      next = n ? n.replace(API_BASE, '') : null;
    }
    return null;
  }

  async function scanAllPagesForTag(tagLower) {
    let next = `/rawmodel`;
    while (next) {
      const data = await rpSafe(next, 'GET');
      if (data?.__rp_error) return null;
      const items = Array.isArray(data?.data) ? data.data : [];
      const hit = items.find((it) => {
        const tags = Array.isArray(it.tags) ? it.tags : [];
        return tags.some((t) => (t?.name || t)?.toLowerCase() === tagLower);
      });
      if (hit) return hit;
      const n = data?.links?.next;
      next = n ? n.replace(API_BASE, '') : null;
    }
    return null;
  }

  async function findByHash(hash) {
    const tagSafe = `sha256-${hash}`;
    const tagColon = `hash:${hash}`;

    const hit1 = await searchByQ(tagSafe);  if (hit1) return hit1;
    const hit2 = await searchByQ(hash);     if (hit2) return hit2;
    const hit3 = await searchByQ(tagColon); if (hit3) return hit3;

    const s1 = await scanAllPagesForTag(tagSafe.toLowerCase());  if (s1) return s1;
    const s2 = await scanAllPagesForTag(tagColon.toLowerCase()); if (s2) return s2;

    return null;
  }

  // ---------- Routes (mounted under your chosen base, e.g. /mesh-optimizer) ----------

  // Health
  router.get('/health', async (req, res) => {
    const ping = await rpSafe('/rawmodel?q=health', 'GET');
    res.json({ ok: !ping.__rp_error, upstream_error: ping.__rp_message || null });
  });

  // Idempotency check by content hash
  router.get('/api/find-by-hash', async (req, res) => {
    try {
      const { hash } = req.query || {};
      if (!hash) return res.status(400).json({ error: 'hash required' });
      const hit = await findByHash(hash);
      if (!hit) return res.json({ found: false });
      res.json({ found: true, id: hit.id, name: hit.name });
    } catch (e) {
      res.status(200).json({ found: false, note: 'fallback: suppressed error', detail: String(e) });
    }
  });

  // Add/merge tags on a base asset
  router.post('/api/rawmodel/:id/tags', async (req, res) => {
    try {
      const id = req.params.id;
      const incoming = Array.isArray(req.body?.tags) ? req.body.tags : [];
      const cur = await rp(`/rawmodel/${id}`, 'GET');
      const currentTags = (cur?.data?.tags || []).map((t) => t?.name || t).filter(Boolean);
      const nextTags = Array.from(new Set([...currentTags, ...incoming]));
      const out = await rp(`/rawmodel/${id}`, 'PUT', { tags: nextTags });
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Start upload (short-circuits if same-hash exists)
  router.post('/api/start-upload', async (req, res) => {
    try {
      const { modelName, filename, contentHash } = req.body || {};
      if (!modelName || !filename) {
        return res.status(400).json({ error: 'modelName and filename required' });
      }

      if (contentHash) {
        const hit = await findByHash(contentHash);
        if (hit) return res.json({ id: hit.id, exists: true });
      }

      const start = await rp('/rawmodel/api-upload/start', 'POST', {
        model_name: modelName,
        filenames: [filename],
        is_zip: false,
      });

      const id = start.id;
      const signedUrl = start.links?.s3_upload_urls?.[filename];
      if (!id || !signedUrl) return res.status(502).json({ error: 'Failed to create upload' });

      res.json({ id, signedUrl, exists: false });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Complete upload
  router.post('/api/complete-upload/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/api-upload/complete`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Read base asset
  router.get('/api/rawmodel/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Request optimize → ALWAYS use bulk endpoint; try multiple payload shapes
  router.post('/api/optimize', async (req, res) => {
    try {
      const { rawmodelId, presetId, presetKey } = req.body || {};
      if (!rawmodelId) return res.status(400).json({ error: 'rawmodelId required' });

      const effectivePresetId = Number.isFinite(Number(presetId))
        ? Number(presetId)
        : DEFAULT_PRESET_ID;

      const bodies = [];

      if (Number.isFinite(effectivePresetId)) {
        bodies.push({ optimizations: [{ model_id: rawmodelId, preset_id: effectivePresetId }] });
        bodies.push({ optimizations: [{ model_id: rawmodelId, config: { preset_id: effectivePresetId } }] });
      }

      if (presetKey) {
        bodies.push({ optimizations: [{ model_id: rawmodelId, preset_key: presetKey }] });
        bodies.push({ optimizations: [{ model_id: rawmodelId, config: { preset_key: presetKey } }] });
      }

      bodies.push({ optimizations: [{ model_id: rawmodelId }] }); // last resort

      let lastErr = null;
      for (const b of bodies) {
        try {
          const out = await rp('/rawmodel/optimize', 'POST', b); // BULK endpoint
          return res.json(out);
        } catch (e) { lastErr = e; }
      }
      throw lastErr ?? new Error('All optimize payload variants failed');
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // List rapid models for a base asset
  router.get('/api/rawmodel/:id/rapidmodels', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/rapidmodels`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Downloads for a rapid model
  router.get('/api/rapidmodel/:id/downloads', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rapidmodel/${id}/downloads`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Request conversion to GLB (fallback when optimize path fails)
  router.post('/api/rawmodel/:id/add-formats', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/addFormats`, 'POST', { formats: ['glb'] });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Downloads for a base asset (converted files)
  router.get('/api/rawmodel/:id/downloads', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/downloads`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // FIXED: Proxy actual file download so RP links stay private

router.get('/api/proxy-download', async (req, res) => {
  try {
    let url = req.query.url || '';
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    // Robust URL decoding - handle multiple levels of encoding
    let decodedUrl = url;
    let previousUrl = '';
    let attempts = 0;
    const maxAttempts = 5;

    // Keep decoding until we get a stable result or hit max attempts
    while (decodedUrl !== previousUrl && attempts < maxAttempts) {
      previousUrl = decodedUrl;
      try {
        decodedUrl = decodeURIComponent(decodedUrl);
        attempts++;
      } catch (e) {
        decodedUrl = previousUrl;
        break;
      }
    }

    // Validate that we have a proper HTTP/HTTPS URL
    if (!decodedUrl.match(/^https?:\/\//)) {
      console.error('[Proxy] Invalid URL after decoding:', decodedUrl);
      return res.status(400).json({ 
        error: 'Invalid URL format',
        originalUrl: url,
        decodedUrl: decodedUrl
      });
    }

    console.log(`[Proxy] Downloading: ${decodedUrl}`);

    // Fetch the file from the decoded URL
    const response = await fetch(decodedUrl);
    
    if (!response.ok) {
      console.error(`[Proxy] Upstream failed: ${response.status} ${response.statusText}`);
      return res.status(502).json({ 
        error: 'Failed to download from upstream', 
        status: response.status,
        statusText: response.statusText
      });
    }

    // Get content info
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    
    // Extract filename from URL or use default
    let filename = 'model.glb';
    try {
      const urlPath = new URL(decodedUrl).pathname;
      const pathParts = urlPath.split('/');
      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.includes('.')) {
        filename = decodeURIComponent(lastPart);
      }
    } catch (e) {
      console.warn('[Proxy] Could not extract filename from URL');
    }

    // CRITICAL: Set headers to force download
    res.setHeader('Content-Type', 'application/octet-stream'); // Force binary download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache'); // Prevent caching issues
    
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    
    console.log(`[Proxy] Forcing download of ${filename} (${contentLength || 'unknown size'})`);

    // Get the response as a buffer to ensure we can stream it properly
    const buffer = await response.arrayBuffer();
    
    // Send the buffer directly
    res.send(Buffer.from(buffer));

  } catch (error) {
    console.error('[Proxy] Download error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Download failed', 
        message: error.message || String(error) 
      });
    } else {
      res.end();
    }
  }
});
// Replace the existing status endpoint in meshOptimizer.js with this complete version
 router.get('/api/status/:id', async (req, res) => {
    try {
      const rawmodelId = req.params.id;
      
      // Get the base rawmodel
      const rawmodel = await rpSafe(`/rawmodel/${rawmodelId}`, 'GET');
      if (rawmodel?.__rp_error) {
        return res.status(404).json({ error: 'Asset not found', detail: rawmodel.__rp_message });
      }

      // Check for rapidmodels (optimized versions)
      const rapidmodels = await rpSafe(`/rawmodel/${rawmodelId}/rapidmodels`, 'GET');
      const rapidList = Array.isArray(rapidmodels?.data) ? rapidmodels.data : [];
      
      let stage = 'waiting';
      let progress = 0;
      let downloads = [];
      let rapidmodelId = null;

      console.log(`[Status] Found ${rapidList.length} rapidmodels for rawmodel ${rawmodelId}`);

      if (rapidList.length > 0) {
        // Get the most recent rapidmodel
        const latestRapid = rapidList[rapidList.length - 1];
        rapidmodelId = latestRapid.id;
        
        const rapidStatus = String(latestRapid.optimization_status || '').toLowerCase();
        const rapidProgress = Number(latestRapid.meta?.progress || 0);
        
        console.log(`[Status] Latest RapidModel ${rapidmodelId}: status=${rapidStatus}, progress=${rapidProgress}`);
        
        // Map status to our stages
        switch (rapidStatus) {
          case 'queued':
          case 'pending':
          case 'waiting':
            stage = 'queued';
            progress = Math.max(20, Math.min(50, rapidProgress));
            break;
            
          case 'processing':
          case 'running':
          case 'optimizing':
            stage = 'processing';
            progress = Math.max(50, Math.min(95, rapidProgress || 75));
            break;
            
          case 'done':
          case 'completed':
          case 'finished':
          case 'ready':
          case 'success':
            stage = 'ready';
            progress = 100;
            
            // Extract downloads from the rapidmodel data itself
            console.log(`[Status] Processing downloads from rapidmodel data`);
            
            if (latestRapid.downloads) {
              const dlData = latestRapid.downloads;
              
              // Handle different download structures
              if (dlData.glb) {
                downloads.push({
                  format: 'glb',
                  url: dlData.glb
                });
              }
              
              if (dlData.all && typeof dlData.all === 'object') {
                Object.entries(dlData.all).forEach(([key, url]) => {
                  if (url && typeof url === 'string') {
                    downloads.push({
                      format: key.includes('.') ? key.split('.').pop() : key,
                      url: url
                    });
                  }
                });
              }
              
              // Handle any other direct download URLs
              Object.entries(dlData).forEach(([key, value]) => {
                if (key !== 'all' && key !== 'glb' && typeof value === 'string' && value.startsWith('http')) {
                  downloads.push({
                    format: key,
                    url: value
                  });
                }
              });
              
              console.log(`[Status] Extracted ${downloads.length} downloads:`, downloads.map(d => d.format));
            }
            
            // Fallback: if no downloads in rapidmodel, check rawmodel
            if (downloads.length === 0) {
              console.log(`[Status] No downloads in rapidmodel, checking rawmodel fallback`);
              
              if (rawmodel?.data?.downloads && typeof rawmodel.data.downloads === 'object') {
                Object.entries(rawmodel.data.downloads).forEach(([filename, url]) => {
                  if (typeof url === 'string' && url.startsWith('http')) {
                    const format = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'file';
                    downloads.push({
                      format: format,
                      url: url
                    });
                  }
                });
                
                console.log(`[Status] Found ${downloads.length} fallback downloads from rawmodel`);
              }
            }
            break;
            
          case 'failed':
          case 'error':
          case 'cancelled':
            stage = 'error';
            progress = 0;
            console.log(`[Status] RapidModel failed with status: ${rapidStatus}`);
            break;
            
          default:
            stage = 'processing';
            progress = Math.max(50, Math.min(90, rapidProgress || 60));
            console.log(`[Status] Unknown status '${rapidStatus}', defaulting to processing`);
        }
        
      } else {
        console.log(`[Status] No rapidmodels found, checking rawmodel downloads`);
        
        // No rapidmodels - check if rawmodel has any converted downloads
        if (rawmodel?.data?.downloads && typeof rawmodel.data.downloads === 'object') {
          Object.entries(rawmodel.data.downloads).forEach(([filename, url]) => {
            if (typeof url === 'string' && url.startsWith('http') && !filename.includes('error') && !filename.includes('info')) {
              const format = filename.includes('.') ? filename.split('.').pop().toLowerCase() : 'file';
              downloads.push({
                format: format,
                url: url
              });
            }
          });
          
          if (downloads.length > 0) {
            stage = 'ready';
            progress = 100;
            console.log(`[Status] Using rawmodel downloads: ${downloads.length} files`);
          } else {
            stage = 'queued';
            progress = 30;
          }
        } else {
          stage = 'queued';
          progress = 30;
        }
      }

      const response = {
        stage,
        progress: Math.round(progress),
        rapidmodelId,
        downloads: downloads.filter(d => d.url) // Only include downloads with valid URLs
      };
      
      console.log(`[Status] Final response:`, response);
      res.json(response);

    } catch (e) {
      console.error('Status endpoint error:', e);
      res.status(500).json({ 
        error: e.message || String(e),
        stage: 'error',
        progress: 0,
        downloads: []
      });
    }
  });

  // Also add a debug endpoint to help troubleshoot
  router.get('/api/debug/:id', async (req, res) => {
    try {
      const rawmodelId = req.params.id;
      
      const rawmodel = await rpSafe(`/rawmodel/${rawmodelId}`, 'GET');
      const rapidmodels = await rpSafe(`/rawmodel/${rawmodelId}/rapidmodels`, 'GET');
      const rawDownloads = await rpSafe(`/rawmodel/${rawmodelId}/downloads`, 'GET');
      
      let rapidDownloads = null;
      const rapidList = Array.isArray(rapidmodels?.data) ? rapidmodels.data : [];
      if (rapidList.length > 0) {
        const latestRapid = rapidList[rapidList.length - 1];
        rapidDownloads = await rpSafe(`/rapidmodel/${latestRapid.id}/downloads`, 'GET');
      }
      
      res.json({
        rawmodel: rawmodel?.__rp_error ? { error: rawmodel.__rp_message } : rawmodel?.data,
        rapidmodels: rapidmodels?.__rp_error ? { error: rapidmodels.__rp_message } : rapidmodels?.data,
        rawDownloads: rawDownloads?.__rp_error ? { error: rawDownloads.__rp_message } : rawDownloads?.data,
        rapidDownloads: rapidDownloads?.__rp_error ? { error: rapidDownloads.__rp_message } : rapidDownloads?.data,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });
  return router;
};