// Indicator registry. Each definition has params and create(ctx, params) -> handle.
// handle: { update(bars), destroy(), legend(time) -> [{ v, c }], prepare?() }
import { LineSeries, HistogramSeries, LineStyle } from '/vendor/lightweight-charts.mjs';
import { ProfilePrimitive, BandFillPrimitive, volumeProfile, tpoProfile } from './profile.js';
import { fmtPrice, fmtVol, niceStep } from './util.js';

// ---------- math ----------
const src = (b, s) => (s === 'open' ? b.open : s === 'high' ? b.high : s === 'low' ? b.low : s === 'hl2' ? (b.high + b.low) / 2 : s === 'hlc3' ? (b.high + b.low + b.close) / 3 : s === 'ohlc4' ? (b.open + b.high + b.low + b.close) / 4 : b.close);
export function sma(vals, n) { const out = new Array(vals.length).fill(null); let s = 0; for (let i = 0; i < vals.length; i++) { s += vals[i]; if (i >= n) s -= vals[i - n]; if (i >= n - 1) out[i] = s / n; } return out; }
export function ema(vals, n) { const out = new Array(vals.length).fill(null); const k = 2 / (n + 1); let e = null, s = 0, c = 0; for (let i = 0; i < vals.length; i++) { const v = vals[i]; if (v == null) continue; if (e == null) { s += v; c++; if (c === n) { e = s / n; out[i] = e; } } else { e = v * k + e * (1 - k); out[i] = e; } } return out; }
function rma(vals, n) { const out = new Array(vals.length).fill(null); let r = null, s = 0; for (let i = 0; i < vals.length; i++) { if (r == null) { s += vals[i]; if (i === n - 1) { r = s / n; out[i] = r; } } else { r = (r * (n - 1) + vals[i]) / n; out[i] = r; } } return out; }
function stdev(vals, n, means) { return vals.map((_, i) => { if (means[i] == null) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (vals[j] - means[i]) ** 2; return Math.sqrt(s / n); }); }
export function sessions(bars, keyFn) {
  const out = []; let cur = null;
  bars.forEach((b, i) => { const k = keyFn(b.time); if (!cur || cur.key !== k) { cur = { key: k, from: i, to: i }; out.push(cur); } else cur.to = i; });
  return out;
}

// ---------- helpers ----------
const lineOpts = (color, width = 1, extra = {}) => ({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, ...extra });
function toLine(bars, vals) { const out = []; for (let i = 0; i < bars.length; i++) if (vals[i] != null && isFinite(vals[i])) out.push({ time: bars[i].time, value: vals[i] }); return out; }
function indexer(bars) { const m = new Map(); bars.forEach((b, i) => m.set(b.time, i)); return m; }
const fmt = (v) => fmtPrice(v);

function makeHandle(ctx) {
  const series = [];
  const prims = [];
  const lines = [];
  return {
    series, prims, lines,
    add(type, opts, pane = 0) { const s = ctx.chart.addSeries(type, opts, pane); series.push(s); return s; },
    prim(p, s = ctx.main) { s.attachPrimitive(p); prims.push([s, p]); return p; },
    pline(opts) { const l = ctx.main.createPriceLine({ lineVisible: false, axisLabelVisible: true, price: 0, ...opts }); lines.push(l); return l; },
    destroy() {
      for (const [s, p] of prims) { try { s.detachPrimitive(p); } catch {} }
      for (const l of lines) { try { ctx.main.removePriceLine(l); } catch {} }
      for (const s of series) { try { ctx.chart.removeSeries(s); } catch {} }
    },
  };
}

// ---------- registry ----------
const SRC = { key: 'source', label: 'Source', type: 'select', options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'], def: 'close' };
const COLORS = { blue: '#2962ff', orange: '#ff9800', purple: '#ab47bc', teal: '#26a69a', red: '#ef5350', white: '#e0e3eb', yellow: '#f0b90b' };

export const INDICATORS = {
  volume: {
    name: 'Volume', cat: 'Technicals', desc: 'Volume bars at the bottom of the price pane',
    params: [{ key: 'ma', label: 'MA length (0 = off)', type: 'int', def: 0, min: 0 }],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const s = h.add(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      ctx.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
      const ma = p.ma > 0 ? h.add(LineSeries, lineOpts('#5d7bd6', 1, { priceScaleId: 'vol', lastValueVisible: false })) : null;
      let idx = new Map(), bars = [], maV = [];
      const col = (b) => (b.close >= b.open ? '#26a69a66' : '#ef535066');
      return {
        update(bs, kind, changed) {
          if (kind === 'update' && changed) { for (const b of changed) s.update({ time: b.time, value: b.volume, color: col(b) }); bars = bs; idx = indexer(bs); return; }
          bars = bs; idx = indexer(bs);
          s.setData(bs.map((b) => ({ time: b.time, value: b.volume, color: col(b) })));
          if (ma) { maV = sma(bs.map((b) => b.volume), p.ma); ma.setData(toLine(bs, maV)); }
        },
        legend(t) { const i = idx.get(t); return i == null ? [] : [{ v: fmtVol(bars[i].volume), c: bars[i].close >= bars[i].open ? '#26a69a' : '#ef5350' }]; },
        destroy: h.destroy,
      };
    },
  },

  sma: maDef('Moving Average Simple', 'SMA', (v, n) => sma(v, n), COLORS.blue),
  ema: maDef('Moving Average Exponential', 'EMA', (v, n) => ema(v, n), COLORS.orange),

  bb: {
    name: 'Bollinger Bands', short: 'BB', cat: 'Technicals', desc: 'SMA ± k standard deviations',
    params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 2 }, { key: 'mult', label: 'StdDev', type: 'float', def: 2 }, SRC, { key: 'color', label: 'Color', type: 'color', def: '#2196f3' }],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const mid = h.add(LineSeries, lineOpts(COLORS.orange, 1, { lastValueVisible: false }));
      const up = h.add(LineSeries, lineOpts(p.color, 1, { lastValueVisible: false }));
      const dn = h.add(LineSeries, lineOpts(p.color, 1, { lastValueVisible: false }));
      const fill = h.prim(new BandFillPrimitive(p.color + '14'));
      let idx = new Map(), m = [], u = [], d = [];
      return {
        update(bs) {
          const v = bs.map((b) => src(b, p.source)); m = sma(v, p.length); const sd = stdev(v, p.length, m);
          u = m.map((x, i) => (x == null ? null : x + p.mult * sd[i])); d = m.map((x, i) => (x == null ? null : x - p.mult * sd[i]));
          const U = toLine(bs, u), D = toLine(bs, d); mid.setData(toLine(bs, m)); up.setData(U); dn.setData(D); fill.setData(U, D); idx = indexer(bs);
        },
        legend(t) { const i = idx.get(t); return i == null || m[i] == null ? [] : [{ v: fmt(m[i]), c: COLORS.orange }, { v: fmt(u[i]), c: p.color }, { v: fmt(d[i]), c: p.color }]; },
        destroy: h.destroy,
      };
    },
  },

  vwap: {
    name: 'VWAP (session)', short: 'VWAP', cat: 'Technicals', desc: 'Volume-weighted average price, resets each session',
    params: [{ key: 'bands', label: 'Band multipliers (comma list, blank = none)', type: 'text', def: '' }, { key: 'color', label: 'Color', type: 'color', def: '#ab47bc' }],
    create(ctx, p) { return vwapLike(ctx, p, { session: true }); },
  },

  avwap: {
    name: 'Anchored VWAP', short: 'AVWAP', cat: 'Technicals', desc: 'VWAP from a chosen bar. Use the anchor tool in the left toolbar to place it.',
    params: [{ key: 'anchor', label: 'Anchor time', type: 'time', def: 0 }, { key: 'bands', label: 'Band multipliers (comma list, blank = none)', type: 'text', def: '1' },
      { key: 'color', label: 'Color', type: 'color', def: '#e0e3eb' }, { key: 'fill', label: 'Shade bands', type: 'bool', def: true }],
    create(ctx, p) { return vwapLike(ctx, p, { session: false }); },
  },

  levels: {
    name: 'Key levels (prev. session H/L/C, open)', short: 'Levels', cat: 'Technicals', desc: 'Previous session high, low, close and current session open',
    params: [{ key: 'color', label: 'Color', type: 'color', def: '#8a8d96' }],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const mk = (title) => h.pline({ title, color: p.color, lineVisible: true, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelColor: '#2a2e39', axisLabelTextColor: '#d1d4dc' });
      const L = { pdh: mk('PDH'), pdl: mk('PDL'), pdc: mk('PDC'), op: mk('Open') };
      return {
        update(bs) {
          if (ctx.tf.sec >= 86400) { Object.values(L).forEach((l) => l.applyOptions({ lineVisible: false, axisLabelVisible: false })); return; }
          const ss = sessions(bs, ctx.sessionKey); if (ss.length < 2) return;
          const prev = ss[ss.length - 2], cur = ss[ss.length - 1];
          let hi = -Infinity, lo = Infinity; for (let i = prev.from; i <= prev.to; i++) { hi = Math.max(hi, bs[i].high); lo = Math.min(lo, bs[i].low); }
          L.pdh.applyOptions({ price: hi }); L.pdl.applyOptions({ price: lo }); L.pdc.applyOptions({ price: bs[prev.to].close }); L.op.applyOptions({ price: bs[cur.from].open });
        },
        legend() { return []; },
        destroy: h.destroy,
      };
    },
  },

  rsi: {
    name: 'Relative Strength Index', short: 'RSI', cat: 'Technicals', pane: true, desc: 'Momentum oscillator 0-100',
    params: [{ key: 'length', label: 'Length', type: 'int', def: 14, min: 2 }, SRC, { key: 'color', label: 'Color', type: 'color', def: '#7e57c2' }],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const s = h.add(LineSeries, lineOpts(p.color, 1.5), ctx.paneIndex);
      for (const [v, c] of [[70, '#ef535088'], [50, '#8a8d9655'], [30, '#26a69a88']]) s.createPriceLine({ price: v, color: c, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      let vals = [], idx = new Map();
      return {
        update(bs) {
          const c = bs.map((b) => src(b, p.source)); const g = [0], l = [0];
          for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
          const ag = rma(g.slice(1), p.length), al = rma(l.slice(1), p.length);
          vals = [null, ...ag.map((a, i) => (a == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + a / al[i])))];
          s.setData(toLine(bs, vals)); idx = indexer(bs);
        },
        legend(t) { const i = idx.get(t); return i == null || vals[i] == null ? [] : [{ v: vals[i].toFixed(2), c: p.color }]; },
        destroy: h.destroy,
      };
    },
  },

  macd: {
    name: 'MACD', short: 'MACD', cat: 'Technicals', pane: true, desc: 'Moving average convergence/divergence',
    params: [{ key: 'fast', label: 'Fast', type: 'int', def: 12 }, { key: 'slow', label: 'Slow', type: 'int', def: 26 }, { key: 'signal', label: 'Signal', type: 'int', def: 9 }, SRC],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const hist = h.add(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, ctx.paneIndex);
      const m = h.add(LineSeries, lineOpts('#2962ff', 1.5), ctx.paneIndex);
      const sg = h.add(LineSeries, lineOpts('#ff6d00', 1.5), ctx.paneIndex);
      let M = [], S = [], H = [], idx = new Map();
      return {
        update(bs) {
          const c = bs.map((b) => src(b, p.source)); const f = ema(c, p.fast), sl = ema(c, p.slow);
          M = c.map((_, i) => (f[i] == null || sl[i] == null ? null : f[i] - sl[i]));
          const first = M.findIndex((x) => x != null);
          const sig = first < 0 ? [] : ema(M.slice(first), p.signal);
          S = M.map((_, i) => (i < first ? null : sig[i - first]));
          H = M.map((x, i) => (x == null || S[i] == null ? null : x - S[i]));
          m.setData(toLine(bs, M)); sg.setData(toLine(bs, S));
          hist.setData(bs.map((b, i) => (H[i] == null ? { time: b.time } : { time: b.time, value: H[i], color: H[i] >= 0 ? (H[i] >= (H[i - 1] ?? 0) ? '#26a69a' : '#b2dfdb') : (H[i] <= (H[i - 1] ?? 0) ? '#ef5350' : '#ffcdd2') })));
          idx = indexer(bs);
        },
        legend(t) { const i = idx.get(t); return i == null || M[i] == null ? [] : [{ v: (H[i] ?? 0).toFixed(3), c: '#26a69a' }, { v: M[i].toFixed(3), c: '#2962ff' }, { v: (S[i] ?? 0).toFixed(3), c: '#ff6d00' }]; },
        destroy: h.destroy,
      };
    },
  },

  atr: {
    name: 'Average True Range', short: 'ATR', cat: 'Technicals', pane: true, desc: 'Volatility (Wilder smoothing)',
    params: [{ key: 'length', label: 'Length', type: 'int', def: 14 }, { key: 'color', label: 'Color', type: 'color', def: '#ef5350' }],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const s = h.add(LineSeries, lineOpts(p.color, 1.5), ctx.paneIndex);
      let vals = [], idx = new Map();
      return {
        update(bs) {
          const tr = bs.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bs[i - 1].close), Math.abs(b.low - bs[i - 1].close)) : b.high - b.low));
          vals = rma(tr, p.length); s.setData(toLine(bs, vals)); idx = indexer(bs);
        },
        legend(t) { const i = idx.get(t); return i == null || vals[i] == null ? [] : [{ v: fmt(vals[i]), c: p.color }]; },
        destroy: h.destroy,
      };
    },
  },

  vpvr: profileDef('vpvr', 'Volume Profile, Visible Range', 'VPVR', 'Volume by price for the bars on screen, buy/sell estimated from bars'),
  svp: profileDef('svp', 'Session Volume Profile', 'SVP', 'Volume by price for each trading session'),
  frvp: profileDef('frvp', 'Volume Profile, Fixed Range', 'FRVP', 'Volume by price between two times. Use the range tool in the left toolbar to place it.'),
  tpo: profileDef('tpo', 'TPO (Market Profile)', 'TPO', 'Time-at-price letters per session with POC, value area and initial balance'),
};

function maDef(name, short, fn, color) {
  return {
    name, short, cat: 'Technicals', desc: `${short} overlay`,
    params: [{ key: 'length', label: 'Length', type: 'int', def: 20, min: 1 }, SRC, { key: 'color', label: 'Color', type: 'color', def: color }, { key: 'width', label: 'Line width', type: 'int', def: 1, min: 1 }],
    create(ctx, p) {
      const h = makeHandle(ctx);
      const s = h.add(LineSeries, lineOpts(p.color, p.width));
      let vals = [], idx = new Map();
      return {
        update(bs) { vals = fn(bs.map((b) => src(b, p.source)), p.length); s.setData(toLine(bs, vals)); idx = indexer(bs); },
        legend(t) { const i = idx.get(t); return i == null || vals[i] == null ? [] : [{ v: fmt(vals[i]), c: p.color }]; },
        destroy: h.destroy,
      };
    },
  };
}

function vwapLike(ctx, p, { session }) {
  const h = makeHandle(ctx);
  const mults = String(p.bands || '').split(',').map(Number).filter((x) => x > 0).slice(0, 3);
  const main = h.add(LineSeries, lineOpts(p.color, 2, { title: session ? 'VWAP' : 'AVWAP' }));
  const bandSeries = mults.map(() => [h.add(LineSeries, lineOpts(p.color + '88', 1, { lastValueVisible: false })), h.add(LineSeries, lineOpts(p.color + '88', 1, { lastValueVisible: false }))]);
  const fill = p.fill !== false && mults.length ? h.prim(new BandFillPrimitive(p.color + '12')) : null;
  let V = [], SD = [], idx = new Map();
  return {
    update(bs) {
      V = new Array(bs.length).fill(null); SD = new Array(bs.length).fill(null);
      const resets = new Set();
      let pv = 0, vv = 0, p2v = 0, key = null;
      const start = session ? 0 : bs.findIndex((b) => b.time >= p.anchor);
      if (start < 0) { main.setData([]); bandSeries.forEach(([a, b]) => { a.setData([]); b.setData([]); }); return; }
      for (let i = start; i < bs.length; i++) {
        const b = bs[i];
        if (session) { const k = ctx.sessionKey(b.time); if (k !== key) { key = k; pv = vv = p2v = 0; resets.add(i); } }
        const tp = (b.high + b.low + b.close) / 3, v = b.volume || 0;
        pv += tp * v; vv += v; p2v += tp * tp * v;
        V[i] = vv > 0 ? pv / vv : tp;
        SD[i] = vv > 0 ? Math.sqrt(Math.max(0, p2v / vv - V[i] * V[i])) : 0;
      }
      const mk = (fn) => { const out = []; for (let i = start; i < bs.length; i++) { const d = { time: bs[i].time, value: fn(i) }; if (resets.has(i) && i > start) { d.color = 'transparent'; d.reset = true; } out.push(d); } return out; };
      main.setData(mk((i) => V[i]));
      bandSeries.forEach(([u, d], k) => { u.setData(mk((i) => V[i] + mults[k] * SD[i])); d.setData(mk((i) => V[i] - mults[k] * SD[i])); });
      if (fill) { const k = mults.length - 1; fill.setData(mk((i) => V[i] + mults[k] * SD[i]), mk((i) => V[i] - mults[k] * SD[i])); }
      idx = indexer(bs);
    },
    legend(t) { const i = idx.get(t); return i == null || V[i] == null ? [] : [{ v: fmt(V[i]), c: p.color }]; },
    destroy: h.destroy,
  };
}

function profileDef(kind, name, short, desc) {
  const common = [
    { key: 'vaPct', label: 'Value area %', type: 'int', def: 70, min: 10 },
    { key: 'pocColor', label: 'POC color', type: 'color', def: kind === 'tpo' ? '#f0b90b' : '#e0e3eb' },
    { key: 'vaLineColor', label: 'VAH / VAL line color', type: 'color', def: '#8a8d96' },
    { key: 'axisLabels', label: 'POC / VAH / VAL labels on price axis', type: 'bool', def: true },
  ];
  const vpStyle = [
    { key: 'split', label: 'Split buy / sell (estimated from bars)', type: 'bool', def: true },
    { key: 'buyColor', label: 'Buy color', type: 'color', def: '#26a69a' },
    { key: 'sellColor', label: 'Sell color', type: 'color', def: '#ef5350' },
    { key: 'color', label: 'Volume color (no split)', type: 'color', def: '#4a5a7a' },
    { key: 'vaColor', label: 'Value-area color (no split)', type: 'color', def: '#5d7bd6' },
    { key: 'labels', label: 'Show volume numbers', type: 'bool', def: kind === 'vpvr' },
    { key: 'lines', label: 'Show POC / VA lines', type: 'bool', def: true },
  ];
  const params = {
    vpvr: [{ key: 'rows', label: 'Rows', type: 'int', def: 30, min: 5 }, { key: 'placement', label: 'Placement', type: 'select', options: ['left', 'right'], def: 'left' },
      { key: 'widthPct', label: 'Width (% of chart)', type: 'int', def: 28, min: 5 }, ...vpStyle, ...common],
    svp: [{ key: 'rows', label: 'Rows per session (approx.)', type: 'int', def: 30, min: 5 }, { key: 'widthPct', label: 'Width (% of session)', type: 'int', def: 45, min: 5 }, ...vpStyle, ...common],
    frvp: [{ key: 'from', label: 'From', type: 'time', def: 0 }, { key: 'to', label: 'To', type: 'time', def: 0 }, { key: 'rows', label: 'Rows', type: 'int', def: 40, min: 5 },
      { key: 'widthPct', label: 'Width (% of range)', type: 'int', def: 60, min: 5 }, ...vpStyle, ...common],
    tpo: [{ key: 'period', label: 'Period (minutes)', type: 'int', def: 30, min: 1 }, { key: 'rows', label: 'Rows per session (approx.)', type: 'int', def: 40, min: 5 },
      { key: 'ibPeriods', label: 'Initial balance periods', type: 'int', def: 2, min: 1 }, { key: 'letters', label: 'Draw letters (blocks when zoomed out)', type: 'bool', def: true },
      { key: 'ib', label: 'Show initial balance', type: 'bool', def: true }, { key: 'extendPoc', label: 'Extend last POC to the right', type: 'bool', def: true }, ...common],
  }[kind];
  return {
    name, short, cat: 'Volume & profile', desc, params,
    create(ctx, p) {
      const h = makeHandle(ctx);
      const owner = { style: { ...p, widthPct: p.widthPct ?? 100 }, zOrder: 'bottom', prepare: null };
      const prim = h.prim(new ProfilePrimitive(owner));
      const lab = (title, c, tc) => h.pline({ title, color: c, axisLabelColor: c, axisLabelTextColor: tc, axisLabelVisible: false });
      const pre = kind === 'svp' || kind === 'tpo' ? 'd' : '';
      const L = { poc: lab(pre + 'POC', p.pocColor, '#131313'), vah: lab(pre + 'VAH', '#2a2e39', '#d1d4dc'), val: lab(pre + 'VAL', '#2a2e39', '#d1d4dc') };
      const setLabels = (prof) => {
        const on = !!(p.axisLabels && prof);
        L.poc.applyOptions({ axisLabelVisible: on, price: prof?.pocPrice || 0 });
        L.vah.applyOptions({ axisLabelVisible: on, price: prof?.vah || 0 });
        L.val.applyOptions({ axisLabelVisible: on, price: prof?.val || 0 });
      };
      const va = p.vaPct / 100;
      let bars = [], profs = [], cacheKey = '', lastProf = null, note = '';
      const intraday = () => ctx.tf.sec < 86400;

      function rowSizeForSessions(ss) {
        const ranges = ss.map((s) => { let hi = -Infinity, lo = Infinity; for (let i = s.from; i <= s.to; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); } return hi - lo; }).filter((x) => x > 0).sort((a, b) => a - b);
        return niceStep((ranges[Math.floor(ranges.length / 2)] || 1) / p.rows);
      }

      function rebuild() {
        profs = []; lastProf = null; note = '';
        if (kind === 'svp' || kind === 'tpo') {
          if (!intraday()) { note = `${short} needs an intraday time frame`; return; }
          const ss = sessions(bars, ctx.sessionKey).slice(-60);
          const rs = rowSizeForSessions(ss);
          const per = Math.max(p.period * 60, ctx.tf.sec);
          for (const s of ss) {
            const sb = bars.slice(s.from, s.to + 1);
            const prof = kind === 'svp' ? volumeProfile(sb, rs, va) : tpoProfile(sb, sb[0].time, per, rs, va, p.ibPeriods);
            if (prof) profs.push({ prof, t0: sb[0].time, t1: sb[sb.length - 1].time });
          }
          lastProf = profs[profs.length - 1]?.prof || null;
        } else if (kind === 'frvp') {
          const from = p.from || bars[Math.max(0, bars.length - 100)]?.time, to = p.to || bars[bars.length - 1]?.time;
          const sb = bars.filter((b) => b.time >= Math.min(from, to) && b.time <= Math.max(from, to));
          if (sb.length) {
            let hi = -Infinity, lo = Infinity; for (const b of sb) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
            const prof = volumeProfile(sb, niceStep((hi - lo) / p.rows), va);
            if (prof) { profs.push({ prof, t0: Math.min(from, to), t1: Math.max(from, to) }); lastProf = prof; }
          }
        }
        setLabels(lastProf);
      }

      owner.prepare = () => {
        const tsApi = ctx.chart.timeScale();
        const spacing = tsApi.options().barSpacing;
        if (kind === 'vpvr') {
          const r = tsApi.getVisibleLogicalRange(); if (!r || !bars.length) { prim.items = []; return; }
          const a = Math.max(0, Math.floor(r.from)), z = Math.min(bars.length - 1, Math.ceil(r.to));
          const key = `${a}:${z}:${bars.length}:${bars[z]?.close}:${bars[z]?.volume}`;
          if (key !== cacheKey) {
            cacheKey = key;
            const sb = bars.slice(a, z + 1);
            let hi = -Infinity, lo = Infinity; for (const b of sb) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); }
            lastProf = sb.length ? volumeProfile(sb, niceStep((hi - lo) / p.rows), va) : null;
            setLabels(lastProf);
          }
          prim.items = lastProf ? [{ prof: lastProf, anchor: p.placement, note: p.split ? '≈ buy/sell from bars' : '' }] : [];
          return;
        }
        const items = [];
        const w = ctx.coords.width();
        profs.forEach((pr, i) => {
          const x0 = ctx.coords.timeToX(pr.t0) - spacing / 2;
          const x1 = ctx.coords.timeToX(pr.t1) + spacing / 2;
          if (x1 < 0 || x0 > w) return;
          items.push({ prof: pr.prof, x0, x1, frame: kind === 'frvp', extendPoc: p.extendPoc && i === profs.length - 1 });
        });
        if (note) items.length = 0;
        prim.items = items;
      };

      return {
        update(bs, kindOfUpdate, changed) {
          bars = bs;
          // live ticks: only recompute the session profiles every few seconds (cheap enough, but avoid jank)
          if (kindOfUpdate === 'update' && kind !== 'vpvr') {
            const now = Date.now(); if (now - (this._t || 0) < 2000) return; this._t = now;
          }
          if (kind !== 'vpvr') rebuild();
          cacheKey = '';
          prim.requestUpdate?.();
        },
        legend() { return note ? [{ v: note, c: '#8a8d96' }] : lastProf ? [{ v: `POC ${fmt(lastProf.pocPrice)}`, c: p.pocColor }] : []; },
        destroy: h.destroy,
      };
    },
  };
}

export const CATEGORIES = ['Technicals', 'Volume & profile'];
export function defaults(type) { const o = {}; for (const pr of INDICATORS[type].params) o[pr.key] = pr.def; return o; }
