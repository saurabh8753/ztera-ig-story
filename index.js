/**
 * ZInsta Aggregator — Cloudflare Worker
 * ---------------------------------------------------------------
 * Ek single endpoint jo multiple upstream Instagram Story APIs ko
 * round-robin + auto-failover ke saath call karta hai.
 *
 * Endpoints:
 *   GET /story?username=xxx   -> aggregated result (cache + failover)
 *   GET /dashboard            -> live HTML dashboard (up/down status)
 *   GET /api/status           -> JSON health check (dashboard isi ko use karta hai)
 *
 * ENV / SECRETS (Cloudflare Worker settings me set karein):
 *   API_LIST              (secret, required) - comma separated base URLs
 *                          e.g. "https://igstory.jaanewale6.workers.dev,https://igstory2.jaanewale6.workers.dev"
 *                          Naya API add karna ho to bas is secret me URL
 *                          jod do — code change ki zarurat nahi (unlimited APIs).
 *   CACHE_TTL_SECONDS     (optional, default 300) - same username cache time
 *   REQUEST_TIMEOUT_MS    (optional, default 8000) - per-upstream timeout
 *   HEALTH_CHECK_USERNAME (optional, default "instagram") - dashboard probe ke liye
 *
 * KV BINDING (required):
 *   CACHE  -> ek KV namespace jisme cache, health-status aur rotation
 *             pointer store hota hai. wrangler.toml me bind karein.
 * ---------------------------------------------------------------
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Preflight CORS support
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (pathname === '/story') {
        return await handleStory(request, env, ctx);
      }
      if (pathname === '/dashboard' || pathname === '/') {
        return new Response(DASHBOARD_HTML, {
          headers: { 'content-type': 'text/html;charset=UTF-8', ...corsHeaders() },
        });
      }
      if (pathname === '/api/status') {
        return await handleStatus(env, ctx);
      }
      if (pathname === '/api/stats') {
        return await handleStats(env);
      }
      return jsonResponse(
        {
          error: 'Not found',
          endpoints: ['/story?username=xxx', '/dashboard', '/api/status', '/api/stats'],
        },
        404
      );
    } catch (err) {
      return jsonResponse({ error: 'Internal error', message: err.message }, 500);
    }
  },
};

/* ------------------------- helpers ------------------------- */

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

function getApiList(env) {
  const raw = env.API_LIST || '';
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

async function fetchWithTimeout(targetUrl, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const start = Date.now();
  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: { 'user-agent': 'ZInsta-Aggregator/1.0' },
    });
    return { res, timeMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

// Rotation pointer taaki har request alag API se start ho (round robin).
// KV eventual-consistency ki wajah se 100% atomic nahi hai, but load
// evenly spread karne ke liye kaafi hai.
async function getRotationStart(env, len) {
  if (len <= 1) return 0;
  try {
    const cur = await env.CACHE.get('meta:rr');
    const next = cur ? (parseInt(cur, 10) + 1) % len : 0;
    await env.CACHE.put('meta:rr', String(next));
    return next;
  } catch {
    return Math.floor(Math.random() * len);
  }
}

// Aaj ki date IST (Asia/Kolkata) me — taaki "today" user ke local din se match kare
function getTodayKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`; // YYYY-MM-DD
}

// Best-effort counter — KV me atomic increment nahi hota, read+write karte hain.
// Traffic-split/dashboard jaisi approximate stats ke liye ye kaafi accurate hai.
async function incrementCounter(env, key) {
  try {
    const cur = await env.CACHE.get(key);
    const next = (cur ? parseInt(cur, 10) : 0) + 1;
    await env.CACHE.put(key, String(next), { expirationTtl: 172800 }); // 2 din rakho
    return next;
  } catch {
    return null;
  }
}

async function recordRequestStat(env, ctx, { apiIndex, cacheHit }) {
  const date = getTodayKey();
  ctx.waitUntil(incrementCounter(env, `stats:${date}:total`));
  if (cacheHit) {
    ctx.waitUntil(incrementCounter(env, `stats:${date}:cache`));
  } else if (apiIndex !== null && apiIndex !== undefined) {
    ctx.waitUntil(incrementCounter(env, `stats:${date}:api:${apiIndex}`));
  }
}

async function updateHealth(env, index, apiUrl, status, extra = {}) {
  const key = `health:${index}`;
  const data = {
    url: apiUrl,
    status, // 'up' | 'down'
    lastChecked: new Date().toISOString(),
    ...extra,
  };
  try {
    await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 3600 });
  } catch {
    /* health tracking best-effort hai, request ko block nahi karna */
  }
}

/* ------------------------- /story ------------------------- */

async function handleStory(request, env, ctx) {
  const url = new URL(request.url);
  const username = url.searchParams.get('username');
  if (!username) {
    return jsonResponse({ error: 'username query param required' }, 400);
  }

  const apis = getApiList(env);
  if (apis.length === 0) {
    return jsonResponse({ error: 'No upstream APIs configured. Set API_LIST secret.' }, 500);
  }

  const cacheKey = `cache:${username.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    ctx.waitUntil(recordRequestStat(env, ctx, { apiIndex: null, cacheHit: true }));
    return new Response(cached, {
      headers: { 'content-type': 'application/json', 'x-cache': 'HIT', ...corsHeaders() },
    });
  }

  const start = await getRotationStart(env, apis.length);
  const order = apis.map((_, i) => apis[(start + i) % apis.length]);
  const timeoutMs = parseInt(env.REQUEST_TIMEOUT_MS || '8000', 10);
  const ttl = parseInt(env.CACHE_TTL_SECONDS || '300', 10);

  const errors = [];
  for (const base of order) {
    const index = apis.indexOf(base);
    const target = `${base}/story?username=${encodeURIComponent(username)}`;
    try {
      const { res, timeMs } = await fetchWithTimeout(target, timeoutMs);
      if (res.ok) {
        const text = await res.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new Error('Invalid JSON from upstream');
        }
        await updateHealth(env, index, base, 'up', { responseTimeMs: timeMs });
        ctx.waitUntil(env.CACHE.put(cacheKey, text, { expirationTtl: ttl }));
        ctx.waitUntil(recordRequestStat(env, ctx, { apiIndex: index, cacheHit: false }));
        return new Response(text, {
          headers: {
            'content-type': 'application/json',
            'x-cache': 'MISS',
            'x-served-by': base,
            ...corsHeaders(),
          },
        });
      }
      await updateHealth(env, index, base, 'down', { httpStatus: res.status, responseTimeMs: timeMs });
      errors.push({ api: base, status: res.status });
    } catch (err) {
      await updateHealth(env, index, base, 'down', { error: err.message });
      errors.push({ api: base, error: err.message });
    }
  }

  return jsonResponse({ error: 'All upstream APIs failed', tried: errors }, 502);
}

/* ------------------------- /api/status ------------------------- */

async function handleStatus(env) {
  const apis = getApiList(env);
  const timeoutMs = parseInt(env.REQUEST_TIMEOUT_MS || '8000', 10);
  const probeUser = env.HEALTH_CHECK_USERNAME || 'instagram';

  const results = await Promise.all(
    apis.map(async (base, index) => {
      const target = `${base}/story?username=${encodeURIComponent(probeUser)}`;
      try {
        const { res, timeMs } = await fetchWithTimeout(target, timeoutMs);
        const status = res.ok ? 'up' : 'down';
        await updateHealth(env, index, base, status, { httpStatus: res.status, responseTimeMs: timeMs });
        return {
          index,
          url: base,
          status,
          httpStatus: res.status,
          responseTimeMs: timeMs,
          lastChecked: new Date().toISOString(),
        };
      } catch (err) {
        await updateHealth(env, index, base, 'down', { error: err.message });
        return { index, url: base, status: 'down', error: err.message, lastChecked: new Date().toISOString() };
      }
    })
  );

  return jsonResponse({ apis: results, checkedAt: new Date().toISOString() });
}

/* ------------------------- /api/stats ------------------------- */

async function handleStats(env) {
  const apis = getApiList(env);
  const date = getTodayKey();

  const totalRaw = await env.CACHE.get(`stats:${date}:total`);
  const cacheRaw = await env.CACHE.get(`stats:${date}:cache`);
  const total = totalRaw ? parseInt(totalRaw, 10) : 0;
  const cacheHits = cacheRaw ? parseInt(cacheRaw, 10) : 0;

  const perApi = await Promise.all(
    apis.map(async (base, index) => {
      const raw = await env.CACHE.get(`stats:${date}:api:${index}`);
      const count = raw ? parseInt(raw, 10) : 0;
      return { index, url: base, count };
    })
  );

  const servedTotal = perApi.reduce((sum, a) => sum + a.count, 0);
  const perApiWithPercent = perApi.map((a) => ({
    ...a,
    percent: servedTotal > 0 ? Math.round((a.count / servedTotal) * 1000) / 10 : 0,
  }));

  return jsonResponse({
    date,
    total,
    cacheHits,
    servedByApi: servedTotal,
    perApi: perApiWithPercent,
  });
}

/* ------------------------- dashboard ------------------------- */

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>ZInsta Aggregator — Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0b0f14; color: #e6edf3; padding: 24px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 20px; }
  .summary { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
    padding: 12px 16px; min-width: 120px;
  }
  .card .num { font-size: 22px; font-weight: 700; }
  .card .label { font-size: 12px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #30363d; }
  th { color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 11px; }
  tr:last-child td { border-bottom: none; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 8px; }
  .up { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .down { background: #f85149; box-shadow: 0 0 6px #f85149; }
  .checking { background: #d29922; }
  .refresh-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  button {
    background: #238636; color: #fff; border: none; padding: 8px 14px;
    border-radius: 6px; font-size: 13px; cursor: pointer;
  }
  button:hover { background: #2ea043; }
  .muted { color: #8b949e; }
  .url { font-family: ui-monospace, Menlo, monospace; }
  .section-title { font-size: 14px; margin: 28px 0 10px; color: #e6edf3; }
  .bar-track { background: #21262d; border-radius: 4px; height: 8px; width: 100%; overflow: hidden; }
  .bar-fill { background: #58a6ff; height: 100%; border-radius: 4px; }
  .pct { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <h1>ZInsta Aggregator</h1>
  <div class="sub">Upstream Instagram Story API health &amp; status</div>

  <div class="summary" id="summary"></div>

  <div class="refresh-row">
    <span class="muted" id="lastChecked">Checking...</span>
    <button onclick="loadStatus()">Refresh now</button>
  </div>

  <table>
    <thead>
      <tr><th>Status</th><th>API</th><th>Response time</th><th>Last checked</th></tr>
    </thead>
    <tbody id="rows">
      <tr><td colspan="4" class="muted">Loading...</td></tr>
    </tbody>
  </table>

  <div class="section-title">Traffic today</div>
  <div class="summary" id="trafficSummary"></div>
  <table>
    <thead>
      <tr><th>API</th><th>Requests</th><th>Share</th><th style="width:35%">Split</th></tr>
    </thead>
    <tbody id="trafficRows">
      <tr><td colspan="4" class="muted">Loading...</td></tr>
    </tbody>
  </table>

<script>
async function loadStatus() {
  document.getElementById('lastChecked').textContent = 'Checking...';
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const rows = document.getElementById('rows');
    const summary = document.getElementById('summary');
    const upCount = data.apis.filter(a => a.status === 'up').length;
    const downCount = data.apis.length - upCount;

    summary.innerHTML =
      '<div class="card"><div class="num">' + data.apis.length + '</div><div class="label">Total APIs</div></div>' +
      '<div class="card"><div class="num" style="color:#3fb950">' + upCount + '</div><div class="label">Up</div></div>' +
      '<div class="card"><div class="num" style="color:#f85149">' + downCount + '</div><div class="label">Down</div></div>';

    rows.innerHTML = data.apis.map(a => (
      '<tr>' +
        '<td><span class="dot ' + (a.status === 'up' ? 'up' : 'down') + '"></span>' + (a.status === 'up' ? 'Up' : 'Down') + '</td>' +
        '<td class="url">' + a.url + '</td>' +
        '<td>' + (a.responseTimeMs ? a.responseTimeMs + ' ms' : (a.error || '—')) + '</td>' +
        '<td class="muted">' + new Date(a.lastChecked).toLocaleTimeString() + '</td>' +
      '</tr>'
    )).join('');

    document.getElementById('lastChecked').textContent = 'Last checked: ' + new Date(data.checkedAt).toLocaleTimeString();
  } catch (e) {
    document.getElementById('lastChecked').textContent = 'Failed to load status';
  }
}
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    const trafficSummary = document.getElementById('trafficSummary');
    const trafficRows = document.getElementById('trafficRows');

    trafficSummary.innerHTML =
      '<div class="card"><div class="num">' + data.total + '</div><div class="label">Total requests today</div></div>' +
      '<div class="card"><div class="num" style="color:#58a6ff">' + data.cacheHits + '</div><div class="label">Served from cache</div></div>' +
      '<div class="card"><div class="num">' + data.servedByApi + '</div><div class="label">Served by upstream APIs</div></div>';

    const sorted = [...data.perApi].sort((a, b) => b.count - a.count);
    trafficRows.innerHTML = sorted.map(a => (
      '<tr>' +
        '<td class="url">' + a.url + '</td>' +
        '<td>' + a.count + '</td>' +
        '<td class="pct">' + a.percent + '%</td>' +
        '<td><div class="bar-track"><div class="bar-fill" style="width:' + a.percent + '%"></div></div></td>' +
      '</tr>'
    )).join('') || '<tr><td colspan="4" class="muted">No requests yet today</td></tr>';
  } catch (e) {
    // stats fail ho to dashboard ka baaki hissa kaam karta rahe
  }
}

loadStatus();
loadStats();
setInterval(() => { loadStatus(); loadStats(); }, 30000); // auto refresh every 30s
</script>
</body>
</html>`;
