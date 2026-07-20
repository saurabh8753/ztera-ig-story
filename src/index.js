const IG = 'https://www.instagram.com';
const APP_ID = '936619743392459';

const TTL_USER  = 60 * 60;
const TTL_STORY = 5  * 60;

const FETCH_TIMEOUT_MS  = 10000;   // per-request timeout guard
const RATE_PER_MIN       = 4;      // hard cap per session — conservative for a 5-account pool
const COOLDOWN_SECONDS   = 30 * 60; // how long a flagged session sits out
const RATE_WINDOW_SEC    = 65;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

const ok  = (data)         => new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json', ...CORS } });
const err = (msg, s = 400) => new Response(JSON.stringify({ success: false, error: msg }), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

// ── Fetch with timeout ────────────────────────────────────────────────────────
async function fetchT(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Instagram request timed out.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Data cache (profiles / stories) ───────────────────────────────────────────
async function cget(env, key) {
  if (!env.IG_CACHE) return null;
  try { const v = await env.IG_CACHE.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
async function cset(env, key, val, ttl) {
  if (!env.IG_CACHE) return;
  try { await env.IG_CACHE.put(key, JSON.stringify(val), { expirationTtl: ttl }); } catch {}
}

// ── Session pool ───────────────────────────────────────────────────────────────
// env.IG_SESSIONS_JSON secret — a JSON array of exactly the sessions you want pooled:
// [{"label":"acct1","sessionid":"...","csrf":"..."}, ... up to 5]
function loadSessions(env) {
  if (!env.IG_SESSIONS_JSON) throw new Error('IG_SESSIONS_JSON secret set nahi hai.');
  let list;
  try { list = JSON.parse(env.IG_SESSIONS_JSON); } catch { throw new Error('IG_SESSIONS_JSON invalid JSON hai.'); }
  if (!Array.isArray(list) || !list.length) throw new Error('IG_SESSIONS_JSON mein koi session nahi mila.');
  return list;
}

function igHeaders(session) {
  const sid = session.sessionid;
  const csrf = session.csrf;
  return {
    'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229258)',
    'Accept': '*/*',
    'Accept-Language': 'en-US',
    'X-CSRFToken': csrf,
    'X-IG-App-ID': APP_ID,
    'X-IG-Capabilities': '3brTvw==',
    'X-IG-Connection-Type': 'WIFI',
    'Cookie': `sessionid=${sid}; csrftoken=${csrf}; ds_user_id=${sid.split('%3A')[0]}`,
  };
}

function currentMinuteBucket() {
  return Math.floor(Date.now() / 60000);
}

async function isCoolingDown(env, label) {
  if (!env.IG_CACHE) return false;
  const v = await env.IG_CACHE.get(`cooldown:${label}`);
  return !!v;
}
async function getCooldownInfo(env, label) {
  if (!env.IG_CACHE) return null;
  const v = await env.IG_CACHE.get(`cooldown:${label}`);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return { reason: v, at: null }; }
}
async function putCooldown(env, label, reason) {
  if (!env.IG_CACHE) return;
  const payload = JSON.stringify({ reason: reason || 'flagged', at: new Date().toISOString() });
  await env.IG_CACHE.put(`cooldown:${label}`, payload, { expirationTtl: COOLDOWN_SECONDS });
}
async function clearCooldown(env, label) {
  if (!env.IG_CACHE) return;
  await env.IG_CACHE.delete(`cooldown:${label}`);
}

function currentDateStr() {
  return new Date().toISOString().slice(0, 10); // UTC day bucket, e.g. 2026-07-20
}
async function incrDaily(env, label) {
  if (!env.IG_CACHE) return;
  const key = `daily:${label}:${currentDateStr()}`;
  const current = parseInt((await env.IG_CACHE.get(key)) || '0', 10);
  await env.IG_CACHE.put(key, String(current + 1), { expirationTtl: 26 * 3600 });
}
async function getDaily(env, label) {
  if (!env.IG_CACHE) return null;
  const key = `daily:${label}:${currentDateStr()}`;
  return parseInt((await env.IG_CACHE.get(key)) || '0', 10);
}

// ── Requests analytics (per-day counters, kept for 8 days) ───────────────────
async function bumpCounter(env, key) {
  if (!env.IG_CACHE) return;
  const current = parseInt((await env.IG_CACHE.get(key)) || '0', 10);
  await env.IG_CACHE.put(key, String(current + 1), { expirationTtl: 8 * 24 * 3600 });
}

async function trackRequest(env, path, status) {
  if (!env.IG_CACHE) return;
  const date = currentDateStr();
  const isError = status >= 400;
  await bumpCounter(env, `analytics:total:${date}`);
  if (path === '/story') {
    await bumpCounter(env, `analytics:story:${date}`);
    if (isError) await bumpCounter(env, `analytics:story_error:${date}`);
  } else if (path === '/download') {
    await bumpCounter(env, `analytics:download:${date}`);
    if (isError) await bumpCounter(env, `analytics:download_error:${date}`);
  }
}

async function getAnalytics(env) {
  if (!env.IG_CACHE) return ok({ success: true, note: 'IG_CACHE KV binding nahi hai — analytics available nahi.', today: null, last_7_days: [] });

  const readDay = async (d) => {
    const get = async (k) => parseInt((await env.IG_CACHE.get(`analytics:${k}:${d}`)) || '0', 10);
    const total = await get('total');
    const story = await get('story');
    const storyErr = await get('story_error');
    const dl = await get('download');
    const dlErr = await get('download_error');
    return { date: d, total, story_requests: story, story_errors: storyErr, download_requests: dl, download_errors: dlErr };
  };

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    days.push(await readDay(d));
  }
  return ok({ success: true, today: days[days.length - 1], last_7_days: days });
}

async function tryConsumeRate(env, label) {
  if (!env.IG_CACHE) return true; // no KV = no limiter, fail-open
  const bucketKey = `rl:${label}:${currentMinuteBucket()}`;
  const current = parseInt((await env.IG_CACHE.get(bucketKey)) || '0', 10);
  if (current >= RATE_PER_MIN) return false;
  await env.IG_CACHE.put(bucketKey, String(current + 1), { expirationTtl: RATE_WINDOW_SEC });
  return true;
}

// Round-robin across the pool, skipping sessions that are cooling down or at cap.
async function pickSession(env) {
  const sessions = loadSessions(env);
  const n = sessions.length;

  let start = 0;
  if (env.IG_CACHE) {
    const p = parseInt((await env.IG_CACHE.get('rr:pointer')) || '0', 10);
    start = p % n;
  }

  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const session = sessions[idx];
    const label = session.label || `session${idx}`;

    if (await isCoolingDown(env, label)) continue;
    if (!(await tryConsumeRate(env, label))) continue;

    if (env.IG_CACHE) {
      await env.IG_CACHE.put('rr:pointer', String((idx + 1) % n), { expirationTtl: 3600 });
    }
    await incrDaily(env, label);
    return { session, label };
  }
  return null;
}

// ── Auth ───────────────────────────────────────────────────────────────────────
// Two separate keys, on purpose:
//  - WORKER_API_KEY: for the public /story and /download endpoints.
//  - ADMIN_KEY: for /admin and everything under it (pool status, cooldown reset,
//    analytics). Fails CLOSED if not set — an admin panel with no key configured
//    should not be reachable at all, unlike the public API which is optional.
function requireAuth(req, sp, env) {
  if (!env.WORKER_API_KEY && !env.ADMIN_KEY) return;
  const provided = sp.get('key') || req.headers.get('X-API-Key');
  const valid = (env.WORKER_API_KEY && provided === env.WORKER_API_KEY) || (env.ADMIN_KEY && provided === env.ADMIN_KEY);
  if (!valid) throw Object.assign(new Error('Unauthorized. Valid API key required.'), { status: 401 });
}

function requireAdminAuth(req, sp, env) {
  if (!env.ADMIN_KEY) {
    throw Object.assign(new Error('ADMIN_KEY secret set nahi hai — admin panel ke liye pehle isko configure karo.'), { status: 503 });
  }
  const provided = sp.get('key') || req.headers.get('X-API-Key');
  if (provided !== env.ADMIN_KEY) {
    throw Object.assign(new Error('Unauthorized. Valid admin key required.'), { status: 401 });
  }
}

// ── Instagram calls ───────────────────────────────────────────────────────────
async function igCall(env, label, session, path) {
  const r = await fetchT(`${IG}${path}`, { headers: igHeaders(session), redirect: 'follow' });

  if (r.status === 401 || r.status === 403) {
    await putCooldown(env, label, `HTTP ${r.status} — sessionid/csrftoken cookie rejected by Instagram`);
    throw new Error(`Session "${label}" flagged (${r.status}) — cooldown mein daal diya.`);
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    await putCooldown(env, label, 'Login page returned — cookie expired ya invalidated');
    throw new Error(`Session "${label}" ka response login page tha — cooldown mein daal diya.`);
  }
  return r;
}

async function getUser(username, env, label, session) {
  const cached = await cget(env, `u:${username}`);
  if (cached) return cached;

  const r = await igCall(env, label, session, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  if (r.status === 404) throw new Error(`@${username} nahi mila.`);
  if (!r.ok) throw new Error(`Profile error: ${r.status}`);

  const d = await r.json();
  const u = d?.data?.user;
  if (!u) throw new Error(`@${username} nahi mila.`);

  const info = { id: u.id, username: u.username, full_name: u.full_name, is_private: u.is_private, profile_pic: u.profile_pic_url_hd || u.profile_pic_url };
  await cset(env, `u:${username}`, info, TTL_USER);
  return info;
}

async function getStories(userId, env, label, session) {
  const cached = await cget(env, `s:${userId}`);
  if (cached) return cached;

  const r = await igCall(env, label, session, `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`);
  if (!r.ok) throw new Error(`Stories error: ${r.status}`);

  const d = await r.json();
  const data = d?.reels?.[userId] ?? null;
  if (data) await cset(env, `s:${userId}`, data, TTL_STORY);
  return data;
}

// ── Media parser ───────────────────────────────────────────────────────────────
function parseMedia(item, base) {
  const isVideo = item.media_type !== 1;
  const list = isVideo ? item.video_versions : item.image_versions2?.candidates;
  if (!list?.length) return null;
  const best = list.reduce((a, b) => a.width >= b.width ? a : b);
  const ext = isVideo ? 'mp4' : 'jpg';
  const filename = `${item.pk}.${ext}`;
  return {
    id: item.pk,
    type: isVideo ? 'video' : 'image',
    url: best.url,
    download_url: `${base}/download?url=${encodeURIComponent(best.url)}&filename=${filename}`,
    filename,
    width: best.width,
    height: best.height,
    taken_at: item.taken_at,
  };
}
function parseAll(items, base) {
  return (items || []).map(i => parseMedia(i, base)).filter(Boolean);
}

// ── Download-proxy safety check ───────────────────────────────────────────────
const ALLOWED_HOSTS = ['cdninstagram.com', 'instagram.com', 'fbcdn.net'];
function isAllowedMediaUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_HOSTS.some(d => host === d || host.endsWith(`.${d}`));
}

// ── Route handlers ────────────────────────────────────────────────────────────
async function withSession(env, fn) {
  const picked = await pickSession(env);
  if (!picked) return { busy: true };
  const { session, label } = picked;
  const result = await fn(env, label, session);
  return { busy: false, result, label };
}

async function story(sp, env, base) {
  const username = sp.get('username');
  if (!username) return err('?username required. Example: ?username=cristiano');

  const out = await withSession(env, async (env, label, session) => {
    const user = await getUser(username, env, label, session);
    if (user.is_private) return { forbidden: true, user };
    const data = await getStories(user.id, env, label, session);
    return { user, data };
  });
  if (out.busy) return err('Saare sessions abhi capacity par hain ya cooldown mein hain. Thodi der baad try karo.', 429);

  const { user, data, forbidden } = out.result;
  if (forbidden) return err(`@${username} private hai.`, 403);
  if (!data?.items?.length) return ok({ success: true, message: `@${username} ki koi active story nahi.`, user, media: [] });
  const media = parseAll(data.items, base);
  return ok({ success: true, user, count: media.length, media });
}

async function download(sp) {
  const mediaUrl = sp.get('url');
  const filename  = sp.get('filename') || 'media';
  if (!mediaUrl) return err('?url required');
  if (!isAllowedMediaUrl(mediaUrl)) return err('Only Instagram CDN URLs allowed', 403);

  const r = await fetchT(mediaUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' },
    redirect: 'follow',
  });
  if (!r.ok) return err(`Media fetch failed: ${r.status}`, r.status);
  const ct = r.headers.get('Content-Type') || (filename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg');
  return new Response(r.body, {
    headers: {
      'Content-Type': ct,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=3600',
      ...CORS,
    },
  });
}

// Pool health — no cookie/session values ever exposed, but the cooldown reason is.
async function poolStatus(env) {
  const sessions = loadSessions(env);
  const rows = [];
  for (const s of sessions) {
    const label = s.label || 'unlabeled';
    const cooldownInfo = await getCooldownInfo(env, label);
    const bucketKey = `rl:${label}:${currentMinuteBucket()}`;
    const used = env.IG_CACHE ? parseInt((await env.IG_CACHE.get(bucketKey)) || '0', 10) : null;
    const dailyUsed = await getDaily(env, label);
    rows.push({
      label,
      cooling_down: !!cooldownInfo,
      cooldown_reason: cooldownInfo?.reason || null,
      cooldown_since: cooldownInfo?.at || null,
      requests_this_minute: used,
      cap_per_minute: RATE_PER_MIN,
      requests_today: dailyUsed,
    });
  }
  return ok({ success: true, pool_size: sessions.length, sessions: rows });
}

// Manually clear a session's cooldown — for when you've confirmed by hand
// (e.g. logged into the account and it's fine) that it's safe to reuse early.
async function resetCooldown(sp, env) {
  const label = sp.get('label');
  if (!label) return err('?label required. Example: ?label=acct1');
  const sessions = loadSessions(env);
  if (!sessions.some(s => (s.label || '') === label)) return err(`Unknown session label: ${label}`, 404);
  await clearCooldown(env, label);
  return ok({ success: true, message: `Session "${label}" cooldown clear kar diya.` });
}

function adminDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Story Gateway · Pool Console</title>
<style>
  :root{
    --bg:#0d1117;--panel:#141a22;--line:#232b36;--text:#dbe2ea;--dim:#7a8699;
    --ok:#3ecf8e;--warn:#e8a33d;--bad:#e8543d;--accent:#5b8def;
    --mono:'IBM Plex Mono','SF Mono',Consolas,monospace;
    --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;}
  .wrap{max-width:960px;margin:0 auto;padding:32px 20px 80px;}
  header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:28px;flex-wrap:wrap;gap:8px;}
  header h1{font-family:var(--mono);font-size:18px;font-weight:600;letter-spacing:0.02em;margin:0;}
  header h1 span{color:var(--dim);font-weight:400;}
  .clock{font-family:var(--mono);font-size:12px;color:var(--dim);}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:20px;}
  .panel h2{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--dim);margin:0 0 16px;font-weight:600;}
  .config-row{display:flex;gap:10px;flex-wrap:wrap;}
  .field{flex:1 1 220px;display:flex;flex-direction:column;gap:6px;}
  label{font-size:11px;color:var(--dim);font-family:var(--mono);}
  input{background:#0a0e14;border:1px solid var(--line);color:var(--text);padding:9px 11px;border-radius:6px;font-family:var(--mono);font-size:13px;outline:none;}
  input:focus{border-color:var(--accent);}
  button{background:var(--accent);color:#0a0e14;border:none;padding:9px 16px;border-radius:6px;font-family:var(--sans);font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;}
  button:hover{filter:brightness(1.08);}
  button:disabled{opacity:0.4;cursor:default;}
  button.ghost{background:transparent;border:1px solid var(--line);color:var(--text);}
  button.small{padding:5px 10px;font-size:12px;}
  button.danger{background:var(--bad);color:#fff;}
  .status-line{font-family:var(--mono);font-size:12px;color:var(--dim);margin-top:10px;min-height:16px;}
  .status-line.err{color:var(--bad);}
  .status-line.good{color:var(--ok);}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--dim);font-weight:600;padding:0 10px 10px;border-bottom:1px solid var(--line);}
  td{padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:middle;}
  tr:last-child td{border-bottom:none;}
  .label-cell{font-family:var(--mono);font-weight:600;}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;}
  .dot.ok{background:var(--ok);box-shadow:0 0 8px rgba(62,207,142,0.6);}
  .dot.bad{background:var(--bad);box-shadow:0 0 8px rgba(232,84,61,0.6);}
  .dot.warn{background:var(--warn);box-shadow:0 0 8px rgba(232,163,61,0.6);}
  .state-text{font-family:var(--mono);font-size:12px;}
  .reason-text{font-family:var(--mono);font-size:11px;color:var(--bad);display:block;margin-top:2px;}
  .since-text{font-family:var(--mono);font-size:10px;color:var(--dim);display:block;}
  .bar-track{background:#0a0e14;border-radius:4px;height:6px;width:100px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:8px;}
  .bar-fill{height:100%;border-radius:4px;background:var(--accent);}
  .bar-fill.hot{background:var(--warn);}
  .bar-fill.full{background:var(--bad);}
  .rate-text{font-family:var(--mono);font-size:12px;color:var(--dim);}
  .empty{color:var(--dim);font-family:var(--mono);font-size:13px;padding:20px 0;text-align:center;}
  .tester-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;}
  .media-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-top:16px;}
  .media-grid img,.media-grid video{width:100%;border-radius:6px;display:block;border:1px solid var(--line);}
  .media-cap{font-family:var(--mono);font-size:10px;color:var(--dim);margin-top:4px;word-break:break-all;}
  footer{text-align:center;color:var(--dim);font-family:var(--mono);font-size:11px;margin-top:30px;}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>pool<span>·</span>console</h1>
    <div class="clock" id="clock">—</div>
  </header>

  <div class="panel">
    <h2>Connection</h2>
    <div class="config-row">
      <div class="field">
        <label for="apiKey">Admin key</label>
        <input id="apiKey" type="password" placeholder="ADMIN_KEY" />
      </div>
      <div class="field" style="flex:0 0 auto;justify-content:flex-end;">
        <label>&nbsp;</label>
        <div style="display:flex;gap:8px;">
          <button id="connectBtn">Connect</button>
          <button id="autoBtn" class="ghost">Auto-refresh: off</button>
        </div>
      </div>
    </div>
    <div class="status-line" id="connStatus">Not connected.</div>
  </div>

  <div class="panel">
    <h2>Session pool</h2>
    <div id="poolTableWrap"><div class="empty">Connect to load pool status.</div></div>
  </div>

  <div class="panel">
    <h2>Requests analytics · last 7 days</h2>
    <div id="analyticsWrap"><div class="empty">Connect to load analytics.</div></div>
  </div>

  <div class="panel">
    <h2>Story lookup</h2>
    <div class="tester-row">
      <div class="field" style="flex:1 1 200px;">
        <label for="username">Username</label>
        <input id="username" type="text" placeholder="e.g. cristiano" />
      </div>
      <button id="fetchStoryBtn">Fetch stories</button>
    </div>
    <div class="status-line" id="storyStatus"></div>
    <div class="media-grid" id="mediaGrid"></div>
  </div>

  <footer>Runs from this worker. API key isn't stored — reconnect after refresh.</footer>
</div>

<script>
const baseUrl = window.location.origin;
let apiKey = '';
let autoTimer = null;
const $ = id => document.getElementById(id);

// If the page was opened as /admin?key=ADMIN_KEY, the server already validated
// that key to serve this page at all — reuse it so the dashboard opens straight
// into a connected state instead of asking again.
(function initFromUrl(){
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('key');
  if (fromUrl) {
    apiKey = fromUrl;
    $('apiKey').value = fromUrl;
  }
})();

function tick(){ $('clock').textContent = new Date().toLocaleTimeString(); }
tick(); setInterval(tick, 1000);

function setStatus(el, msg, cls){ el.textContent = msg; el.className = 'status-line' + (cls ? ' ' + cls : ''); }

async function apiGet(path){
  const url = baseUrl + path + (path.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(apiKey);
  const r = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || data.success === false) throw new Error((data && data.error) || ('Request failed (' + r.status + ')'));
  return data;
}

function rateBarClass(used, cap){
  const pct = cap ? used / cap : 0;
  if (pct >= 1) return 'full';
  if (pct >= 0.6) return 'hot';
  return '';
}

function renderPool(data){
  const wrap = $('poolTableWrap');
  if (!data.sessions || !data.sessions.length) { wrap.innerHTML = '<div class="empty">No sessions configured.</div>'; return; }
  const rows = data.sessions.map(s => {
    const used = s.requests_this_minute ?? 0;
    const cap = s.cap_per_minute ?? 0;
    const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
    const dot = s.cooling_down ? 'bad' : (pct >= 80 ? 'warn' : 'ok');
    const stateText = s.cooling_down ? 'cooldown' : 'available';
    const reasonHtml = s.cooling_down && s.cooldown_reason
      ? \`<span class="reason-text">\${s.cooldown_reason}</span>\${s.cooldown_since ? \`<span class="since-text">since \${new Date(s.cooldown_since).toLocaleString()}</span>\` : ''}\`
      : '';
    return \`
      <tr>
        <td class="label-cell">\${s.label}</td>
        <td><span class="dot \${dot}"></span><span class="state-text">\${stateText}</span>\${reasonHtml}</td>
        <td>
          <span class="bar-track"><span class="bar-fill \${rateBarClass(used, cap)}" style="width:\${pct}%"></span></span>
          <span class="rate-text">\${used}/\${cap} per min</span>
        </td>
        <td class="rate-text">\${s.requests_today ?? '—'}</td>
        <td>\${s.cooling_down ? \`<button class="small danger" data-reset="\${s.label}">Reset</button>\` : \`<button class="small ghost" disabled>—</button>\`}</td>
      </tr>\`;
  }).join('');
  wrap.innerHTML = \`<table><thead><tr><th>Session</th><th>State</th><th>Rate (this minute)</th><th>Today</th><th></th></tr></thead><tbody>\${rows}</tbody></table>\`;
  wrap.querySelectorAll('[data-reset]').forEach(btn => btn.addEventListener('click', () => resetCooldown(btn.getAttribute('data-reset'))));
}

async function loadPool(){
  try {
    const data = await apiGet('/pool-status');
    renderPool(data);
    setStatus($('connStatus'), 'Connected · pool size ' + data.pool_size, 'good');
  } catch (e) { setStatus($('connStatus'), e.message, 'err'); }
}

function renderAnalytics(data){
  const wrap = $('analyticsWrap');
  if (!data.last_7_days || !data.last_7_days.length) { wrap.innerHTML = '<div class="empty">No analytics data yet.</div>'; return; }
  const maxTotal = Math.max(1, ...data.last_7_days.map(d => d.total));
  const rows = data.last_7_days.map(d => {
    const pct = Math.round((d.total / maxTotal) * 100);
    const errRate = d.story_requests + d.download_requests
      ? Math.round(((d.story_errors + d.download_errors) / (d.story_requests + d.download_requests)) * 100)
      : 0;
    return \`
      <tr>
        <td class="rate-text">\${d.date}</td>
        <td>
          <span class="bar-track" style="width:140px;"><span class="bar-fill" style="width:\${pct}%"></span></span>
          <span class="rate-text">\${d.total}</span>
        </td>
        <td class="rate-text">\${d.story_requests} (\${d.story_errors} err)</td>
        <td class="rate-text">\${d.download_requests} (\${d.download_errors} err)</td>
        <td class="rate-text" style="color:\${errRate > 15 ? 'var(--bad)' : 'var(--dim)'}">\${errRate}%</td>
      </tr>\`;
  }).join('');
  wrap.innerHTML = \`<table><thead><tr><th>Date</th><th>Total</th><th>Story</th><th>Download</th><th>Error rate</th></tr></thead><tbody>\${rows}</tbody></table>\`;
}

async function loadAnalytics(){
  try {
    const data = await apiGet('/admin/analytics');
    renderAnalytics(data);
  } catch (e) { /* pool status already surfaces connection errors */ }
}

async function loadAll(){
  await loadPool();
  await loadAnalytics();
}

async function resetCooldown(label){
  try { await apiGet('/admin/reset-cooldown?label=' + encodeURIComponent(label)); await loadPool(); }
  catch (e) { setStatus($('connStatus'), 'Reset failed: ' + e.message, 'err'); }
}

$('connectBtn').addEventListener('click', () => {
  apiKey = $('apiKey').value.trim();
  if (!apiKey) { setStatus($('connStatus'), 'Enter the admin key first.', 'err'); return; }
  loadAll();
});

$('autoBtn').addEventListener('click', () => {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; $('autoBtn').textContent = 'Auto-refresh: off'; }
  else {
    if (!apiKey) { setStatus($('connStatus'), 'Connect first.', 'err'); return; }
    autoTimer = setInterval(loadAll, 5000);
    $('autoBtn').textContent = 'Auto-refresh: on (5s)';
  }
});

// Auto-connect if the admin key arrived via the URL (?key=ADMIN_KEY) — the
// server already required it to serve this page, so there's no extra step.
if (apiKey) loadAll();

$('fetchStoryBtn').addEventListener('click', async () => {
  const username = $('username').value.trim();
  const grid = $('mediaGrid');
  grid.innerHTML = '';
  if (!apiKey) { setStatus($('storyStatus'), 'Connect first.', 'err'); return; }
  if (!username) { setStatus($('storyStatus'), 'Enter a username.', 'err'); return; }
  setStatus($('storyStatus'), 'Fetching…');
  try {
    const data = await apiGet('/story?username=' + encodeURIComponent(username));
    if (!data.media || !data.media.length) { setStatus($('storyStatus'), data.message || 'No active stories.', ''); return; }
    setStatus($('storyStatus'), data.count + ' item(s) found.', 'good');
    grid.innerHTML = data.media.map(m => {
      const el = m.type === 'video' ? \`<video src="\${m.url}" controls muted></video>\` : \`<img src="\${m.url}" loading="lazy" />\`;
      return \`<div>\${el}<div class="media-cap">\${m.type} · \${m.width}×\${m.height}</div></div>\`;
    }).join('');
    loadAll();
  } catch (e) { setStatus($('storyStatus'), e.message, 'err'); }
});
</script>
</body>
</html>`;
}

function docs(base) {
  return ok({
    name: 'ZTERA Instagram Story Downloader (5-session gateway)',
    auth: 'Public API: ?key=... or X-API-Key header, matching WORKER_API_KEY. Admin routes: same, but matching the separate ADMIN_KEY secret.',
    endpoints: {
      [`${base}/story?username=cristiano`]: 'Active stories (WORKER_API_KEY or ADMIN_KEY)',
      [`${base}/download?url=<cdn_url>&filename=file.mp4`]: 'Download proxy (WORKER_API_KEY or ADMIN_KEY)',
      [`${base}/admin?key=<ADMIN_KEY>`]: 'Admin dashboard — requires ADMIN_KEY, not the public API key',
      [`${base}/pool-status`]: 'Session pool health (ADMIN_KEY only)',
      [`${base}/admin/analytics`]: 'Requests analytics (ADMIN_KEY only)',
      [`${base}/admin/reset-cooldown?label=acct1`]: 'Manually clear a session cooldown (ADMIN_KEY only)',
    },
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'GET') return err('Only GET supported', 405);

    const url  = new URL(req.url);
    const path = url.pathname;
    const sp   = url.searchParams;
    const base = url.origin;

    const ADMIN_ROUTES = ['/admin', '/pool-status', '/admin/reset-cooldown', '/admin/analytics'];

    try {
      if (ADMIN_ROUTES.includes(path)) {
        requireAdminAuth(req, sp, env);
      } else if (path !== '/') {
        requireAuth(req, sp, env);
      }

      if (path === '/')            return docs(base);
      if (path === '/admin')       return new Response(adminDashboardHtml(), { headers: { 'Content-Type': 'text/html; charset=UTF-8', ...CORS } });
      if (path === '/pool-status') return await poolStatus(env);
      if (path === '/admin/reset-cooldown') return await resetCooldown(sp, env);
      if (path === '/admin/analytics') return await getAnalytics(env);

      if (path === '/story') {
        let r;
        try { r = await story(sp, env, base); }
        catch (e) { r = err(e.message, e.status || 500); }
        await trackRequest(env, '/story', r.status);
        return r;
      }
      if (path === '/download') {
        let r;
        try { r = await download(sp); }
        catch (e) { r = err(e.message, e.status || 500); }
        await trackRequest(env, '/download', r.status);
        return r;
      }
      return err(`Unknown endpoint: ${path}`, 404);
    } catch (e) {
      return err(e.message, e.status || 500);
    }
  },
};
