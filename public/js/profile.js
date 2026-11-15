// Volume profile + TPO computation and canvas rendering (as Lightweight Charts series primitives).
import { fmtVol } from './util.js';

// ---------- computation ----------
export function volumeProfile(bars, rowSize, vaPct = 0.7) {
  if (!bars.length || !(rowSize > 0)) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, Math.floor(b.low / rowSize)); hi = Math.max(hi, Math.floor(b.high / rowSize)); }
  const n = hi - lo + 1; if (n <= 0 || n > 5000) return null;
  const buy = new Float64Array(n), sell = new Float64Array(n);
  for (const b of bars) {
    const v = b.volume || 0; if (!v) continue;
    const a = Math.floor(b.low / rowSize) - lo, z = Math.floor(b.high / rowSize) - lo;
    const per = v / (z - a + 1);
    const range = b.high - b.low;
    const bf = range > 0 ? (b.close - b.low) / range : 0.5; // buying-pressure estimate from bar shape
    for (let i = a; i <= z; i++) { buy[i] += per * bf; sell[i] += per * (1 - bf); }
  }
  const tot = new Float64Array(n); let total = 0, poc = 0;
  for (let i = 0; i < n; i++) { tot[i] = buy[i] + sell[i]; total += tot[i]; if (tot[i] > tot[poc]) poc = i; }
  const [vaLo, vaHi] = valueArea(tot, poc, total * vaPct);
  return { kind: 'vp', lo, n, rowSize, buy, sell, tot, total, poc, vaLo, vaHi, max: tot[poc],
    pocPrice: (lo + poc + 0.5) * rowSize, vah: (lo + vaHi + 1) * rowSize, val: (lo + vaLo) * rowSize };
}

function valueArea(arr, poc, target) {
  let a = poc, z = poc, acc = arr[poc];
  while (acc < target && (a > 0 || z < arr.length - 1)) {
    const up = (z + 1 < arr.length ? arr[z + 1] : -1) + (z + 2 < arr.length ? arr[z + 2] : 0);
    const dn = (a - 1 >= 0 ? arr[a - 1] : -1) + (a - 2 >= 0 ? arr[a - 2] : 0);
    if (up >= dn) { z = Math.min(arr.length - 1, z + 2); acc += up; } else { a = Math.max(0, a - 2); acc += dn; }
  }
  return [a, z];
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function tpoProfile(bars, sessionStart, periodSec, rowSize, vaPct = 0.7, ibPeriods = 2) {
  if (!bars.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, Math.floor(b.low / rowSize)); hi = Math.max(hi, Math.floor(b.high / rowSize)); }
  const n = hi - lo + 1; if (n <= 0 || n > 5000) return null;
  const periods = new Map();
  for (const b of bars) {
    const p = Math.floor((b.time - sessionStart) / periodSec);
    const cur = periods.get(p);
    if (!cur) periods.set(p, { lo: b.low, hi: b.high }); else { cur.lo = Math.min(cur.lo, b.low); cur.hi = Math.max(cur.hi, b.high); }
  }
  const keys = [...periods.keys()].sort((a, b) => a - b);
  const rows = Array.from({ length: n }, () => []);
  keys.forEach((k, order) => {
    const pr = periods.get(k);
    for (let i = Math.floor(pr.lo / rowSize) - lo; i <= Math.floor(pr.hi / rowSize) - lo; i++) rows[i].push(order);
  });
  const cnt = rows.map((r) => r.length);
  let total = 0, poc = 0; const mid = (n - 1) / 2;
  for (let i = 0; i < n; i++) { total += cnt[i]; if (cnt[i] > cnt[poc] || (cnt[i] === cnt[poc] && Math.abs(i - mid) < Math.abs(poc - mid))) poc = i; }
  const [vaLo, vaHi] = valueArea(Float64Array.from(cnt), poc, total * vaPct);
  let ibLo = Infinity, ibHi = -Infinity;
  keys.slice(0, ibPeriods).forEach((k) => { const p = periods.get(k); ibLo = Math.min(ibLo, p.lo); ibHi = Math.max(ibHi, p.hi); });
  return { kind: 'tpo', lo, n, rowSize, rows, cnt, total, poc, vaLo, vaHi, max: cnt[poc], nPeriods: keys.length,
    letters: keys.map((_, i) => LETTERS[i % LETTERS.length]),
    open: bars[0].open, close: bars[bars.length - 1].close, ibLo, ibHi,
    pocPrice: (lo + poc + 0.5) * rowSize, vah: (lo + vaHi + 1) * rowSize, val: (lo + vaLo) * rowSize };
}

// ---------- rendering ----------
// layer = { profiles: [{ prof, x0, x1 | anchor:'left'|'right', widthPct }], style }
// The owning indicator fills `this.items` in prepare() (called on every viewport change).
export class ProfilePrimitive {
  constructor(owner) { this.owner = owner; this.items = []; this._views = [{ renderer: () => this, zOrder: () => owner.zOrder || 'bottom' }]; }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = null; }
  updateAllViews() { try { this.owner.prepare?.(); } catch (e) { console.error(e); } }
  paneViews() { return this._views; }
  draw(target) {
    if (!this.series) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const it of this.items) {
        if (it.prof.kind === 'vp') drawVP(ctx, mediaSize, this.series, it, this.owner.style);
        else drawTPO(ctx, mediaSize, this.series, it, this.owner.style);
      }
    });
  }
}

function rowY(series, lo, i, rs) {
  const top = series.priceToCoordinate((lo + i + 1) * rs);
  const bot = series.priceToCoordinate((lo + i) * rs);
  return top == null || bot == null ? null : [top, bot];
}

function drawVP(ctx, size, series, it, st) {
  const p = it.prof;
  let x0, W, dir = 1;
  if (it.anchor === 'left') { x0 = 0; W = size.width * (st.widthPct / 100); }
  else if (it.anchor === 'right') { x0 = size.width; W = size.width * (st.widthPct / 100); dir = -1; }
  else { x0 = it.x0; W = Math.max(0, (it.x1 - it.x0)) * (st.widthPct / 100); if (W < 2) return; }
  const ext = it.x1 ?? size.width;
  ctx.save();
  ctx.font = '10px -apple-system, Segoe UI, sans-serif'; ctx.textBaseline = 'middle';
  for (let i = 0; i < p.n; i++) {
    const yy = rowY(series, p.lo, i, p.rowSize); if (!yy) continue;
    const [top, bot] = yy; if (bot < -2 || top > size.height + 2) continue;
    const h = Math.max(1, bot - top - (bot - top > 4 ? 1 : 0));
    const inVA = i >= p.vaLo && i <= p.vaHi;
    const total = p.tot[i] / p.max * W;
    if (st.split) {
      const bw = p.buy[i] / p.max * W, sw = p.sell[i] / p.max * W;
      ctx.fillStyle = inVA ? st.buyColor : st.buyColor + '55';
      ctx.fillRect(dir > 0 ? x0 : x0 - bw, top, bw, h);
      ctx.fillStyle = inVA ? st.sellColor : st.sellColor + '55';
      ctx.fillRect(dir > 0 ? x0 + bw : x0 - bw - sw, top, sw, h);
    } else {
      ctx.fillStyle = inVA ? st.vaColor : st.color;
      ctx.fillRect(dir > 0 ? x0 : x0 - total, top, total, h);
    }
    if (i === p.poc) {
      ctx.fillStyle = st.pocColor; ctx.fillRect(dir > 0 ? x0 : x0 - total, top + h / 2 - 1, total, 2);
    }
    if (st.labels && h >= 11 && p.tot[i] > 0) {
      ctx.fillStyle = '#d1d4dccc';
      const tx = dir > 0 ? x0 + total + 3 : x0 - total - 3;
      ctx.textAlign = dir > 0 ? 'left' : 'right';
      ctx.fillText(fmtVol(p.tot[i]), tx, top + h / 2);
    }
  }
  // POC / VA lines
  const yP = series.priceToCoordinate(p.pocPrice), yH = series.priceToCoordinate(p.vah), yL = series.priceToCoordinate(p.val);
  const xa = it.anchor === 'right' ? 0 : x0, xb = it.anchor === 'left' || it.anchor === 'right' ? size.width : ext;
  ctx.lineWidth = 1;
  if (st.lines) {
    ctx.strokeStyle = st.pocColor; ctx.setLineDash([]);
    if (yP != null) { ctx.beginPath(); ctx.moveTo(xa, Math.round(yP) + 0.5); ctx.lineTo(xb, Math.round(yP) + 0.5); ctx.stroke(); }
    ctx.strokeStyle = st.vaLineColor; ctx.setLineDash([4, 4]);
    for (const y of [yH, yL]) if (y != null) { ctx.beginPath(); ctx.moveTo(xa, Math.round(y) + 0.5); ctx.lineTo(xb, Math.round(y) + 0.5); ctx.stroke(); }
    ctx.setLineDash([]);
    if (it.anchor !== 'left' && it.anchor !== 'right' && it.x1 - it.x0 > 40) {
      ctx.fillStyle = '#d1d4dcaa'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      if (yP != null) ctx.fillText('POC', xb - 2, yP - 2);
      if (yH != null) ctx.fillText('VAH', xb - 2, yH - 2);
      if (yL != null) ctx.fillText('VAL', xb - 2, yL - 2);
    }
  }
  if (it.frame) { // fixed-range profile frame
    ctx.strokeStyle = '#2962ff66'; ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.round(it.x0) + 0.5, 0, Math.round(it.x1 - it.x0), size.height);
    ctx.setLineDash([]);
  }
  if (it.note) { ctx.fillStyle = '#8a8d96'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(it.note, 4, size.height - 4); }
  ctx.restore();
}

const TPO_COLORS = ['#5c9ded', '#4fb8c9', '#4cc59a', '#8bc34a', '#cddc39', '#ffc107', '#ff9800', '#ff7043', '#ec407a', '#ab47bc', '#7e57c2', '#5c6bc0'];
function drawTPO(ctx, size, series, it, st) {
  const p = it.prof;
  const x0 = it.x0 + 3, avail = Math.max(0, it.x1 - it.x0 - 6);
  if (avail < 6 || it.x1 < 0 || it.x0 > size.width) return;
  const y0 = series.priceToCoordinate(p.lo * p.rowSize), y1 = series.priceToCoordinate((p.lo + 1) * p.rowSize);
  if (y0 == null || y1 == null) return;
  const rowH = Math.abs(y0 - y1);
  let cw = Math.min(Math.max(rowH * 0.85, 4), 10);
  if (p.max * cw > avail) cw = avail / p.max;
  const useText = rowH >= 9 && cw >= 6 && st.letters;
  ctx.save();
  ctx.font = `${Math.min(11, Math.floor(rowH - 1))}px Menlo, Consolas, monospace`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < p.n; i++) {
    const yy = rowY(series, p.lo, i, p.rowSize); if (!yy) continue;
    const [top, bot] = yy; if (bot < -2 || top > size.height + 2) continue;
    const h = Math.max(1, bot - top - (bot - top > 3 ? 1 : 0));
    const inVA = i >= p.vaLo && i <= p.vaHi;
    if (i === p.poc) { ctx.fillStyle = st.pocColor + '33'; ctx.fillRect(x0 - 1, top, p.cnt[i] * cw + 2, h); }
    p.rows[i].forEach((per, k) => {
      const c = TPO_COLORS[per % TPO_COLORS.length];
      const x = x0 + k * cw;
      if (useText) { ctx.fillStyle = inVA ? c : c + '77'; ctx.fillText(p.letters[per], x + cw / 2, top + h / 2 + 0.5); }
      else { ctx.fillStyle = inVA ? c + 'cc' : c + '55'; ctx.fillRect(x, top, Math.max(1, cw - (cw > 3 ? 1 : 0)), h); }
    });
  }
  // initial balance bar + open/close marks
  const yIbH = series.priceToCoordinate(p.ibHi), yIbL = series.priceToCoordinate(p.ibLo);
  if (st.ib && yIbH != null && yIbL != null) { ctx.fillStyle = '#f0b90b'; ctx.fillRect(x0 - 3, yIbH, 2, yIbL - yIbH); }
  const yO = series.priceToCoordinate(p.open), yC = series.priceToCoordinate(p.close);
  ctx.fillStyle = '#d1d4dc';
  if (yO != null) ctx.fillRect(x0 - 6, yO - 1, 4, 2);
  if (yC != null) { ctx.beginPath(); ctx.arc(x0 - 4, yC, 2, 0, 7); ctx.fill(); }
  // POC / VA lines for the session
  ctx.lineWidth = 1;
  const xe = it.x1 - 2;
  const yP = series.priceToCoordinate(p.pocPrice);
  if (yP != null) { ctx.strokeStyle = st.pocColor; ctx.beginPath(); ctx.moveTo(x0, Math.round(yP) + .5); ctx.lineTo(it.extendPoc ? size.width : xe, Math.round(yP) + .5); ctx.stroke(); }
  ctx.strokeStyle = st.vaLineColor; ctx.setLineDash([3, 3]);
  for (const v of [p.vah, p.val]) { const y = series.priceToCoordinate(v); if (y != null) { ctx.beginPath(); ctx.moveTo(x0, Math.round(y) + .5); ctx.lineTo(xe, Math.round(y) + .5); ctx.stroke(); } }
  ctx.setLineDash([]);
  ctx.restore();
}

// Fill between two line series (VWAP / Bollinger bands)
export class BandFillPrimitive {
  constructor(color) { this.color = color; this.upper = []; this.lower = []; this._views = [{ renderer: () => this, zOrder: () => 'bottom' }]; }
  attached({ chart, series }) { this.chart = chart; this.series = series; }
  detached() { this.chart = null; }
  paneViews() { return this._views; }
  setData(upper, lower) { this.upper = upper; this.lower = lower; }
  draw(target) {
    if (!this.chart || this.upper.length < 2) return;
    const ts = this.chart.timeScale(), s = this.series;
    const vr = ts.getVisibleRange(); if (!vr) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.fillStyle = this.color;
      let seg = [];
      const flush = () => {
        if (seg.length > 1) {
          ctx.beginPath();
          seg.forEach(([x, yu], i) => (i ? ctx.lineTo(x, yu) : ctx.moveTo(x, yu)));
          for (let i = seg.length - 1; i >= 0; i--) ctx.lineTo(seg[i][0], seg[i][2]);
          ctx.closePath(); ctx.fill();
        }
        seg = [];
      };
      let prevT = null;
      for (let i = 0; i < this.upper.length; i++) {
        const u = this.upper[i], l = this.lower[i];
        if (u.value == null || u.break) { flush(); continue; }
        if (u.time < vr.from - 86400 * 7 || u.time > vr.to + 86400 * 7) { flush(); continue; }
        if (u.reset && prevT != null) flush();
        prevT = u.time;
        const x = ts.timeToCoordinate(u.time), yu = s.priceToCoordinate(u.value), yl = s.priceToCoordinate(l.value);
        if (x == null || yu == null || yl == null) continue;
        seg.push([x, yu, yl]);
      }
      flush();
    });
  }
}
