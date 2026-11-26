// Local server for the charting app.
// - Serves the web UI and the Lightweight Charts library.
// - Talks to tastytrade's REST API (OAuth2) to mint a DXLink quote token and resolve symbols.
// - Credentials live ONLY in ./config.json (git-ignored) and never leave this machine
//   except to api.tastyworks.com. The browser never sees the client secret or refresh token.
// Read-only market data: no accounts, positions or orders are touched.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const USER_AGENT = 'local-charts/0.1';
const FORCE_DEMO = process.argv.includes('--demo');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function ttConfig() {
  const t = loadConfig().tastytrade || {};
  const ok = (v) => typeof v === 'string' && v.trim() && !v.startsWith('PASTE_');
  return {
    base: (t.apiBaseUrl || 'https://api.tastyworks.com').replace(/\/$/, ''),
    clientSecret: ok(t.clientSecret) ? t.clientSecret.trim() : null,
    refreshToken: ok(t.refreshToken) ? t.refreshToken.trim() : null,
  };
}
function isConfigured() {
  const c = ttConfig();
  return !FORCE_DEMO && !!(c.clientSecret && c.refreshToken);
}

// ---------------- tastytrade REST ----------------
let access = { token: null, exp: 0 };
let quote = { data: null, exp: 0 };
let lastError = null;

async function getAccessToken() {
  if (access.token && Date.now() < access.exp) return access.token;
  const c = ttConfig();
  if (!c.clientSecret || !c.refreshToken) throw new Error('tastytrade credentials are not configured');
  let r;
  try {
    r = await fetch(`${c.base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_secret: c.clientSecret }),
    });
  } catch (e) { throw new Error(`Could not reach ${c.base} (${e.cause?.code || e.message}). Check your internet connection.`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new Error(`OAuth refresh failed (${r.status}): ${body.error_description || body.error || JSON.stringify(body).slice(0, 200)}`);
  }
  const ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : 900;
  access = { token: body.access_token, exp: Date.now() + (ttl - 60) * 1000 };
  return access.token;
}

async function tt(pathname, retry = true) {
  const c = ttConfig();
  const token = await getAccessToken();
  const r = await fetch(c.base + pathname, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (r.status === 401 && retry) { access = { token: null, exp: 0 }; return tt(pathname, false); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`tastytrade ${pathname} -> ${r.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}

async function getQuoteToken(force) {
  if (!force && quote.data && Date.now() < quote.exp) return quote.data;
  const d = await tt('/api-quote-tokens');
  quote = { data: { token: d.token, dxlinkUrl: d['dxlink-url'], level: d.level }, exp: Date.now() + 20 * 3600 * 1000 };
  return quote.data;
}

const resolveCache = new Map();
async function resolveSymbol(sym) {
  sym = String(sym || '').trim().toUpperCase();
  if (!sym) throw new Error('empty symbol');
  if (resolveCache.has(sym)) return resolveCache.get(sym);
  let out;
  if (sym.startsWith('/')) {
    // Futures. "/ES" = product root -> front (active) month. "/ESZ6" = explicit contract.
    const root = sym.slice(1);
    let items = [];
    try { items = (await tt(`/instruments/futures?product-code[]=${encodeURIComponent(root)}`)).items || []; } catch { items = []; }
    let pick = null;
    if (items.length) {
      const live = items.filter((f) => !f['is-closing-only'] && new Date(f['expiration-date']) >= new Date(Date.now() - 864e5));
      pick = live.find((f) => f['active-month']) || live.find((f) => f['next-active-month'])
        || live.sort((a, b) => new Date(a['expiration-date']) - new Date(b['expiration-date']))[0];
    } else {
      pick = await tt(`/instruments/futures/${encodeURIComponent(sym)}`);
    }
    if (!pick || !pick['streamer-symbol']) throw new Error(`No futures contract found for ${sym}`);
    out = { symbol: sym, streamer: pick['streamer-symbol'], contract: pick.symbol,
      name: `${pick['product-code'] || root} futures ${pick.symbol} (exp ${pick['expiration-date']})`, kind: 'future',
      tick: Number(pick['tick-size']) || undefined };
  } else if (/^[A-Z]+\/[A-Z]+$/.test(sym)) {
    const c = await tt(`/instruments/cryptocurrencies/${encodeURIComponent(sym)}`);
    out = { symbol: sym, streamer: c['streamer-symbol'] || sym, name: c.description || sym, kind: 'crypto' };
  } else {
    let name = sym; let streamer = sym; let kind = 'equity';
    try {
      const e = await tt(`/instruments/equities/${encodeURIComponent(sym)}`);
      name = e.description || sym; streamer = e['streamer-symbol'] || sym;
      if (e['is-index']) kind = 'index';
    } catch { /* indexes like SPX aren't equities; stream the plain symbol */ kind = 'index'; }
    out = { symbol: sym, streamer, name, kind };
  }
  resolveCache.set(sym, out);
  return out;
}

async function searchSymbols(q) {
  const items = (await tt(`/symbols/search/${encodeURIComponent(q)}`)).items || [];
  return items.slice(0, 20).map((i) => ({ symbol: i.symbol, name: i.description, kind: i['instrument-type'] }));
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { reject(e); } });
  });
}
// Only accept state-changing requests from this app's own page (blocks other websites from poking the local server).
function sameOrigin(req) {
  const host = req.headers.host || '';
  const origin = req.headers.origin;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  return !origin || origin === `http://${host}`;
}

// ---------------------------------------------------------------------------
// Update notice
// ---------------------------------------------------------------------------
// A release zip contains a VERSION file (written by .github/workflows/release.yml).
// The page asks /api/version, which compares it with the newest GitHub release and
// shows "Update available" in the status bar. It only reads the public release
// number; nothing about you (and nothing from config.json) is sent. A git clone has
// no VERSION file and skips the check. Turn it off with --no-update-check or
// CHARTS_NO_UPDATE_CHECK=1.
const UPDATE_REPO = 'trader-larry/desktop-charts';
const UPDATE_CHECK = !process.argv.includes('--no-update-check')
  && !/^(1|true|yes|on)$/i.test(process.env.CHARTS_NO_UPDATE_CHECK || '');
const UPDATE_CHECK_MS = 12 * 3600 * 1000;
let update = { at: 0, latest: null, url: null, pending: null };

function currentVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim() || null; } catch { return null; }
}
// 'v1.10.2' -> [1, 10, 2]. Anything that isn't a plain number counts as 0.
function versionKey(v) {
  const parts = String(v).trim().replace(/^v/i, '').split('-')[0].split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  while (parts.length < 3) parts.push(0);
  return parts;
}
function isNewer(a, b) {
  const x = versionKey(a), y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
// Newest published release on GitHub, asked at most every 12 hours (also after a
// failure, so an offline computer isn't retried on every page load).
async function latestRelease() {
  if (Date.now() - update.at < UPDATE_CHECK_MS) return update;
  if (!update.pending) {
    update.at = Date.now();
    update.pending = (async () => {
      try {
        const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'desktop-charts-update-check' },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const rel = await r.json();
          update.latest = String(rel.tag_name || '').trim() || null;
          update.url = rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`;
        }
      } catch { /* offline, rate-limited or no release yet: just show nothing */ }
      update.pending = null;
    })();
  }
  await update.pending;
  return update;
}
async function versionInfo() {
  const current = currentVersion();
  const out = { current, latest: null, url: null, update: false };
  if (!current || !UPDATE_CHECK) return out;
  const { latest, url } = await latestRelease();
  return { ...out, latest, url, update: !!latest && isNewer(latest, current) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }

    if (p === '/api/status') {
      const configured = isConfigured();
      let level = null;
      if (configured) {
        try { level = (await getQuoteToken()).level; lastError = null; } catch (e) { lastError = e.message; }
      }
      return send(res, 200, { mode: configured && !lastError ? 'live' : 'demo', configured, forcedDemo: FORCE_DEMO, level, error: lastError });
    }
    if (p === '/api/version') return send(res, 200, await versionInfo());
    if (p === '/api/quote-token') {
      if (!isConfigured()) return send(res, 400, { error: 'not configured' });
      return send(res, 200, await getQuoteToken(url.searchParams.has('refresh')));
    }
    if (p === '/api/resolve') {
      if (!isConfigured()) return send(res, 400, { error: 'not configured' });
      return send(res, 200, await resolveSymbol(url.searchParams.get('symbol')));
    }
    if (p === '/api/search') {
      if (!isConfigured()) return send(res, 200, []);
      return send(res, 200, await searchSymbols(url.searchParams.get('q') || ''));
    }
    if (p === '/api/config' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      const cfg = loadConfig();
      cfg.tastytrade = cfg.tastytrade || {};
      if (body.clear) { delete cfg.tastytrade.clientSecret; delete cfg.tastytrade.refreshToken; }
      else {
        if (body.clientSecret) cfg.tastytrade.clientSecret = String(body.clientSecret).trim();
        if (body.refreshToken) cfg.tastytrade.refreshToken = String(body.refreshToken).trim();
        if (body.sandbox !== undefined) cfg.tastytrade.apiBaseUrl = body.sandbox ? 'https://api.cert.tastyworks.com' : 'https://api.tastyworks.com';
      }
      saveConfig(cfg);
      access = { token: null, exp: 0 }; quote = { data: null, exp: 0 }; resolveCache.clear(); lastError = null;
      if (!body.clear && isConfigured()) {
        try { await getQuoteToken(true); } catch (e) { lastError = e.message; return send(res, 200, { ok: false, error: e.message }); }
      }
      return send(res, 200, { ok: true });
    }

    const file = path.normalize(path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    return serveFile(res, file);
  } catch (e) {
    lastError = e.message;
    return send(res, 500, { error: e.message });
  }
});

const PORT = Number(process.env.PORT) || loadConfig().port || 8787;
server.listen(PORT, '127.0.0.1', () => {
  const ver = currentVersion();
  console.log(`\n  Charts ${ver ? ver + ' ' : ''}running at  http://localhost:${PORT}\n`);
  console.log(isConfigured() ? '  Data: tastytrade (DXLink)\n' : '  Data: DEMO (no tastytrade credentials in config.json yet; add them in the app under Settings)\n');
  console.log('  Keep this window open while you chart.');
  console.log('  To stop the app: close this window, or press Ctrl+C here (answer Y if asked "Terminate batch job").\n');
});
process.on('SIGINT', () => { console.log('\n  Charts stopped. You can close this window.\n'); process.exit(0); });
