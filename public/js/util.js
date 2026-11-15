// Shared helpers: icons, time-frames, formatting, session math.

export const TIMEFRAMES = [
  // lookbackDays = calendar days of history requested (weekends and holidays included)
  { id: '1m', sec: 60, dx: '1m', lookbackDays: 10 },
  { id: '2m', sec: 120, dx: '2m', lookbackDays: 15 },
  { id: '5m', sec: 300, dx: '5m', lookbackDays: 30 },
  { id: '15m', sec: 900, dx: '15m', lookbackDays: 60 },
  { id: '30m', sec: 1800, dx: '30m', lookbackDays: 90 },
  { id: '1h', sec: 3600, dx: '1h', lookbackDays: 180 },
  { id: 'D', sec: 86400, dx: '1d', lookbackDays: 365 * 6 },
  { id: 'W', sec: 604800, dx: '1w', lookbackDays: 365 * 20 },
];
export const tfById = (id) => TIMEFRAMES.find((t) => t.id === id) || TIMEFRAMES.find((t) => t.id === '5m');

const P = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
export const ICONS = {
  cursor: P('<path d="M6 3l12 9-5.5 1L15 20l-2.5 1-2.5-6.5L6 18z"/>'),
  cross: P('<path d="M12 3v18M3 12h18"/>'),
  trend: P('<path d="M4 19L20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>'),
  ray: P('<path d="M4 18L21 6"/><circle cx="4" cy="18" r="1.6"/><circle cx="12" cy="12.3" r="1.6"/>'),
  hline: P('<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>'),
  hray: P('<path d="M6 12h15"/><circle cx="6" cy="12" r="1.6"/>'),
  vline: P('<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6"/>'),
  rect: P('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  circle: P('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="1.3"/>'),
  fib: P('<path d="M3 5h18M3 9.5h18M3 13h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>'),
  channel: P('<path d="M3 15L15 4M9 20L21 9"/>'),
  text: P('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  measure: P('<path d="M4 17L17 4l3 3L7 20z"/><path d="M8 13l2 2M11 10l2 2M14 7l2 2"/>'),
  avwap: P('<path d="M3 18c4 0 5-9 9-9s5 4 9 4"/><path d="M3 21V15" /><circle cx="3" cy="15" r="1.5"/>'),
  vprange: P('<path d="M4 4v16M4 6h9M4 9h13M4 12h16M4 15h10M4 18h6"/>'),
  magnet: P('<path d="M6 4v8a6 6 0 0012 0V4h-4v8a2 2 0 01-4 0V4z"/><path d="M6 8h4M14 8h4"/>'),
  lock: P('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/>'),
  eye: P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeoff: P('<path d="M3 3l18 18M10.6 6.1A10 10 0 0112 6c6 0 10 6 10 6a17 17 0 01-3 3.6M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7c1.7 0 3.2-.5 4.5-1.2"/>'),
  trash: P('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  fx: P('<path d="M9 20c2 0 2-2 2.5-6S12 4 15 4M7 10h7M14 12l5 6M19 12l-5 6"/>'),
  undo: P('<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 010 10h-2"/>'),
  redo: P('<path d="M15 7l5 5-5 5"/><path d="M20 12H9a5 5 0 000 10h2"/>'),
  fit: P('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  camera: P('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  gear: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 01-4 0v-.1A1.6 1.6 0 009 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 14.2H3a2 2 0 010-4h.1A1.6 1.6 0 004.6 9a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 009 4.6h0A1.6 1.6 0 0010 3.1V3a2 2 0 014 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v0a1.6 1.6 0 001.5 1h.2a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1z"/>'),
  list: P('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  save: P('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
  dots: P('<circle cx="12" cy="5.5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18.5" r="1.3"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  star: P('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
  candles: P('<path d="M7 3v4M7 17v4M17 5v3M17 16v3"/><rect x="5" y="7" width="4" height="10"/><rect x="15" y="8" width="4" height="8"/>'),
  bars: P('<path d="M7 4v16M4 8h3M7 16h3M17 4v16M14 7h3M17 15h3"/>'),
  line: P('<path d="M3 17l5-6 4 3 8-9"/>'),
  area: P('<path d="M3 17l5-6 4 3 8-9v15H3z"/>'),
  ha: P('<rect x="5" y="6" width="4" height="12"/><rect x="15" y="4" width="4" height="10"/><path d="M7 3v3M17 14v6"/>'),
  close: P('<path d="M6 6l12 12M18 6L6 18"/>'),
  settings: P('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
};
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { if (!el.innerHTML) el.innerHTML = ICONS[el.dataset.icon] || ''; });
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  if (html) e.innerHTML = html;
  return e;
};
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const uid = () => Math.random().toString(36).slice(2, 10);

export function decimalsFor(price) {
  const a = Math.abs(price);
  if (a >= 1000) return 2; if (a >= 1) return 2; if (a >= 0.1) return 4; return 6;
}
export function fmtPrice(p, dec) {
  if (p == null || !isFinite(p)) return '—';
  return p.toLocaleString('en-US', { minimumFractionDigits: dec ?? decimalsFor(p), maximumFractionDigits: dec ?? decimalsFor(p) });
}
export function fmtVol(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(v));
}

// ---- time zones ----
export const TZ_CHOICES = [
  ['local', 'Local (' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')'],
  ['America/New_York', 'New York'], ['America/Chicago', 'Chicago'], ['America/Los_Angeles', 'Los Angeles'],
  ['Europe/London', 'London'], ['Europe/Oslo', 'Oslo'], ['UTC', 'UTC'], ['Asia/Tokyo', 'Tokyo'],
];
const fmtCache = new Map();
function dtf(tz, opts) {
  const key = tz + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz === 'local' ? undefined : tz }));
  return fmtCache.get(key);
}
export function parts(sec, tz) {
  const o = {};
  for (const p of dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date(sec * 1000))) o[p.type] = p.value;
  return o;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtTick(sec, type, tz) {
  const p = parts(sec, tz);
  switch (type) {
    case 0: return p.year;
    case 1: return MONTHS[+p.month - 1];
    case 2: return String(+p.day);
    default: return `${p.hour}:${p.minute}`;
  }
}
export function fmtCrosshair(sec, tz, tfSec) {
  const p = parts(sec, tz);
  const d = `${p.weekday} ${+p.day} ${MONTHS[+p.month - 1]} '${p.year.slice(2)}`;
  return tfSec >= 86400 ? d : `${d}  ${p.hour}:${p.minute}`;
}

// Trading-session key for session-based studies (VWAP, session profile, TPO).
// Futures: CME day starts 18:00 New York. Crypto: UTC day. Everything else: New York calendar day.
export function sessionKeyFn(kind) {
  const ny = dtf('America/New_York', { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (kind === 'crypto') return (t) => Math.floor(t / 86400);
  if (kind === 'future') return (t) => ny.format(new Date((t + 6 * 3600) * 1000));
  return (t) => ny.format(new Date(t * 1000));
}
export function symbolKind(sym) {
  if (sym.startsWith('/')) return 'future';
  if (/^[A-Z]+\/[A-Z]+$/.test(sym)) return 'crypto';
  return 'equity';
}

// Nice row size for profiles.
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 2.25 ? 2 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10) * p;
}
