// routes/meshOptimizer.js
// Express Router that wraps the RapidPipeline "mesh optimizer" API flows

const express = require('express');
const path = require('path');

// If you're on Node 18+, global fetch exists. Otherwise uncomment:
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

module.exports = function meshOptimizer(opts = {}) {
  const router = express.Router();

  const API_BASE = String(opts.apiBase || 'https://api.rapidpipeline.com/api/v2');
  const RP_TOKEN = String(opts.token || '');
  const DEFAULT_PRESET_ID = Number.isFinite(Number(opts.presetId)) ? Number(opts.presetId) : 9547;

  if (!RP_TOKEN) {
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

  // ---------- IMPROVED Resilient helpers ----------
  async function rpSafe(endpoint, method = 'GET', body) {
    try { return await rp(endpoint, method, body); }
    catch (e) { 
      console.warn(`[RP-Safe] ${method} ${endpoint} failed:`, e.message);
      return { __rp_error: true, __rp_message: e.message || String(e) }; 
    }
  }

  // ENHANCED: More robust search with better logging
  async function searchByQ(query) {
    console.log(`[Search] Searching with q="${query}"`);
    let next = `/rawmodel?q=${encodeURIComponent(query)}`;
    let pageCount = 0;
    const maxPages = 10; // Prevent infinite loops
    
    while (next && pageCount < maxPages) {
      console.log(`[Search] Checking page ${pageCount + 1}: ${next}`);
      const data = await rpSafe(next, 'GET');
      
      if (data?.__rp_error) {
        console.warn(`[Search] Page ${pageCount + 1} failed:`, data.__rp_message);
        return null;
      }
      
      const items = Array.isArray(data?.data) ? data.data : [];
      console.log(`[Search] Page ${pageCount + 1} has ${items.length} items`);
      
      // Check each item for matching tags
      for (const item of items) {
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const tagNames = tags.map(t => (t?.name || t)?.toLowerCase()).filter(Boolean);
        
        console.log(`[Search] Item ${item.id} tags:`, tagNames);
        
        if (tagNames.includes(query.toLowerCase())) {
          console.log(`[Search] FOUND match for "${query}" in item ${item.id}`);
          return item;
        }
      }
      
      const n = data?.links?.next;
      next = n ? n.replace(API_BASE, '') : null;
      pageCount++;
    }
    
    console.log(`[Search] No match found for "${query}" after ${pageCount} pages`);
    return null;
  }

  // ENHANCED: Broader scan with multiple strategies
  async function scanAllPagesForTag(tagLower) {
    console.log(`[Scan] Full scan for tag: "${tagLower}"`);
    let next = `/rawmodel`;
    let pageCount = 0;
    const maxPages = 20; // Allow more pages for full scan
    
    while (next && pageCount < maxPages) {
      const data = await rpSafe(next, 'GET');
      if (data?.__rp_error) return null;
      
      const items = Array.isArray(data?.data) ? data.data : [];
      console.log(`[Scan] Page ${pageCount + 1}: ${items.length} items`);
      
      for (const item of items) {
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const tagNames = tags.map(t => (t?.name || t)?.toLowerCase()).filter(Boolean);
        
        if (tagNames.includes(tagLower)) {
          console.log(`[Scan] FOUND via full scan: item ${item.id}`);
          return item;
        }
      }
      
      const n = data?.links?.next;
      next = n ? n.replace(API_BASE, '') : null;
      pageCount++;
    }
    
    console.log(`[Scan] Full scan completed, no match for: "${tagLower}"`);
    return null;
  }

  // ENHANCED: More comprehensive hash search with multiple strategies
  async function findByHash(hash) {
    console.log(`[Hash-Search] Starting search for hash: ${hash}`);
    
    if (!hash || typeof hash !== 'string') {
      console.warn('[Hash-Search] Invalid hash provided');
      return null;
    }

    // Multiple tag formats to try
    const searchVariants = [
      `sha256-${hash}`,                    // Safe format (primary)
      `hash:${hash}`,                      // Legacy colon format
      hash,                                // Direct hash
      `content-hash-${hash.substring(0, 16)}`, // Shortened version
      `filename:${hash}`,                  // In case hash was used as filename
    ];

    // Strategy 1: Try targeted searches first (fastest)
    console.log('[Hash-Search] Strategy 1: Targeted searches');
    for (const variant of searchVariants) {
      console.log(`[Hash-Search] Trying variant: "${variant}"`);
      const hit = await searchByQ(variant);
      if (hit) {
        console.log(`[Hash-Search] SUCCESS via targeted search: ${hit.id} (variant: "${variant}")`);
        return hit;
      }
    }

    // Strategy 2: Full page scans for each variant
    console.log('[Hash-Search] Strategy 2: Full page scans');
    for (const variant of searchVariants) {
      console.log(`[Hash-Search] Full scan for: "${variant}"`);
      const hit = await scanAllPagesForTag(variant.toLowerCase());
      if (hit) {
        console.log(`[Hash-Search] SUCCESS via full scan: ${hit.id} (variant: "${variant}")`);
        return hit;
      }
    }

    // Strategy 3: Partial hash matches (last resort)
    console.log('[Hash-Search] Strategy 3: Partial hash matching');
    const shortHash = hash.substring(0, 16);
    const partialVariants = [
      `sha256-${shortHash}`,
      `hash:${shortHash}`,
      shortHash
    ];
    
    for (const variant of partialVariants) {
      const hit = await scanAllPagesForTag(variant.toLowerCase());
      if (hit) {
        console.log(`[Hash-Search] SUCCESS via partial match: ${hit.id} (variant: "${variant}")`);
        return hit;
      }
    }

    console.log('[Hash-Search] No matches found with any strategy');
    return null;
  }

  // ---------- Routes ----------

  // Health check
  router.get('/health', async (req, res) => {
    const ping = await rpSafe('/rawmodel?q=health', 'GET');
    res.json({ ok: !ping.__rp_error, upstream_error: ping.__rp_message || null });
  });

  // ENHANCED: More robust hash lookup
  router.get('/api/find-by-hash', async (req, res) => {
    try {
      const { hash } = req.query || {};
      if (!hash) return res.status(400).json({ error: 'hash required' });
      
      console.log(`[API] find-by-hash request for: ${hash}`);
      const hit = await findByHash(hash);
      
      if (!hit) {
        console.log(`[API] No existing asset found for hash: ${hash}`);
        return res.json({ found: false });
      }
      
      console.log(`[API] Found existing asset: ${hit.id} (${hit.name})`);
      res.json({ 
        found: true, 
        id: hit.id, 
        name: hit.name,
        created_at: hit.created_at
      });
      
    } catch (e) {
      console.error('[API] find-by-hash error:', e);
      res.status(200).json({ 
        found: false, 
        note: 'fallback: suppressed error', 
        detail: String(e) 
      });
    }
  });

  // ENHANCED: Better tag management
  router.post('/api/rawmodel/:id/tags', async (req, res) => {
    try {
      const id = req.params.id;
      const incoming = Array.isArray(req.body?.tags) ? req.body.tags : [];
      
      console.log(`[API] Adding tags to asset ${id}:`, incoming);
      
      // Get current tags
      const cur = await rp(`/rawmodel/${id}`, 'GET');
      const currentTags = (cur?.data?.tags || []).map((t) => t?.name || t).filter(Boolean);
      
      // Merge with incoming tags (remove duplicates)
      const nextTags = Array.from(new Set([...currentTags, ...incoming]));
      
      console.log(`[API] Asset ${id} tags: ${currentTags.length} current + ${incoming.length} new = ${nextTags.length} total`);
      
      const out = await rp(`/rawmodel/${id}`, 'PUT', { tags: nextTags });
      
      console.log(`[API] Successfully updated tags for asset ${id}`);
      res.json(out);
      
    } catch (e) {
      console.error(`[API] Failed to add tags to asset ${req.params.id}:`, e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // ENHANCED: Start upload with better deduplication
  router.post('/api/start-upload', async (req, res) => {
    try {
      const { modelName, filename, contentHash } = req.body || {};
      if (!modelName || !filename) {
        return res.status(400).json({ error: 'modelName and filename required' });
      }

      console.log(`[API] start-upload: ${filename} (hash: ${contentHash || 'none'})`);

      // Check for existing asset if hash provided
      if (contentHash) {
        console.log(`[API] Checking for existing asset with hash: ${contentHash}`);
        const hit = await findByHash(contentHash);
        
        if (hit) {
          console.log(`[API] Found existing asset ${hit.id}, skipping upload`);
          return res.json({ 
            id: hit.id, 
            exists: true, 
            foundAsset: {
              id: hit.id,
              name: hit.name,
              created_at: hit.created_at
            }
          });
        }
        console.log(`[API] No existing asset found, proceeding with upload`);
      }

      // Create new upload session
      console.log(`[API] Creating new upload session for: ${filename}`);
      const start = await rp('/rawmodel/api-upload/start', 'POST', {
        model_name: modelName,
        filenames: [filename],
        is_zip: false,
      });

      const id = start.id;
      const signedUrl = start.links?.s3_upload_urls?.[filename];
      
      if (!id || !signedUrl) {
        console.error('[API] Failed to create upload session:', start);
        return res.status(502).json({ error: 'Failed to create upload' });
      }

      console.log(`[API] Created upload session: ${id}`);
      res.json({ id, signedUrl, exists: false });
      
    } catch (e) {
      console.error('[API] start-upload error:', e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Rest of the routes remain the same...
  router.post('/api/complete-upload/:id', async (req, res) => {
    try {
      const id = req.params.id;
      console.log(`[API] Completing upload for asset: ${id}`);
      const data = await rp(`/rawmodel/${id}/api-upload/complete`, 'GET');
      console.log(`[API] Upload completed for asset: ${id}`);
      res.json(data);
    } catch (e) {
      console.error(`[API] complete-upload error for ${req.params.id}:`, e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.get('/api/rawmodel/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.post('/api/optimize', async (req, res) => {
    try {
      const { rawmodelId, presetId, presetKey } = req.body || {};
      if (!rawmodelId) return res.status(400).json({ error: 'rawmodelId required' });

      console.log(`[API] Starting optimization for asset ${rawmodelId} with preset ${presetId || 'default'}`);

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

      bodies.push({ optimizations: [{ model_id: rawmodelId }] });

      let lastErr = null;
      for (const b of bodies) {
        try {
          const out = await rp('/rawmodel/optimize', 'POST', b);
          console.log(`[API] Optimization started for asset ${rawmodelId}`);
          return res.json(out);
        } catch (e) { lastErr = e; }
      }
      throw lastErr ?? new Error('All optimize payload variants failed');
    } catch (e) {
      console.error(`[API] optimize error for asset ${req.body?.rawmodelId}:`, e);
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.get('/api/rawmodel/:id/rapidmodels', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/rapidmodels`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.get('/api/rapidmodel/:id/downloads', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rapidmodel/${id}/downloads`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.post('/api/rawmodel/:id/add-formats', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/addFormats`, 'POST', { formats: ['glb'] });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.get('/api/rawmodel/:id/downloads', async (req, res) => {
    try {
      const id = req.params.id;
      const data = await rp(`/rawmodel/${id}/downloads`, 'GET');
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  // Proxy download (unchanged)
  router.get('/api/proxy-download', async (req, res) => {
    try {
      let url = req.query.url || '';
      
      if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
      }

      let decodedUrl = url;
      let previousUrl = '';
      let attempts = 0;
      const maxAttempts = 5;

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

      if (!decodedUrl.match(/^https?:\/\//)) {
        console.error('[Proxy] Invalid URL after decoding:', decodedUrl);
        return res.status(400).json({ 
          error: 'Invalid URL format',
          originalUrl: url,
          decodedUrl: decodedUrl
        });
      }

      console.log(`[Proxy] Downloading: ${decodedUrl}`);

      const response = await fetch(decodedUrl);
      
      if (!response.ok) {
        console.error(`[Proxy] Upstream failed: ${response.status} ${response.statusText}`);
        return res.status(502).json({ 
          error: 'Failed to download from upstream', 
          status: response.status,
          statusText: response.statusText
        });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const contentLength = response.headers.get('content-length');
      
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

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-cache');
      
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      
      console.log(`[Proxy] Forcing download of ${filename} (${contentLength || 'unknown size'})`);

      const buffer = await response.arrayBuffer();
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

  // Status endpoint (unchanged from your version)
  router.get('/api/status/:id', async (req, res) => {
    try {
      const rawmodelId = req.params.id;
      
      const rawmodel = await rpSafe(`/rawmodel/${rawmodelId}`, 'GET');
      if (rawmodel?.__rp_error) {
        return res.status(404).json({ error: 'Asset not found', detail: rawmodel.__rp_message });
      }

      const rapidmodels = await rpSafe(`/rawmodel/${rawmodelId}/rapidmodels`, 'GET');
      const rapidList = Array.isArray(rapidmodels?.data) ? rapidmodels.data : [];
      
      let stage = 'waiting';
      let progress = 0;
      let downloads = [];
      let rapidmodelId = null;

      console.log(`[Status] Found ${rapidList.length} rapidmodels for rawmodel ${rawmodelId}`);

      if (rapidList.length > 0) {
        const latestRapid = rapidList[rapidList.length - 1];
        rapidmodelId = latestRapid.id;
        
        const rapidStatus = String(latestRapid.optimization_status || '').toLowerCase();
        const rapidProgress = Number(latestRapid.meta?.progress || 0);
        
        console.log(`[Status] Latest RapidModel ${rapidmodelId}: status=${rapidStatus}, progress=${rapidProgress}`);
        
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
            
            console.log(`[Status] Processing downloads from rapidmodel data`);
            
            if (latestRapid.downloads) {
              const dlData = latestRapid.downloads;
              
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
        downloads: downloads.filter(d => d.url)
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

  // Debug endpoint (unchanged)
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