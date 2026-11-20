// Drawing tools: rendering (series primitive) + mouse interaction.
import { fmtPrice, uid, clamp } from './util.js';

export const DRAW_TOOLS = [
  { id: 'trend', icon: 'trend', title: 'Trend line', n: 2 },
  { id: 'ray', icon: 'ray', title: 'Ray (extended line)', n: 2 },
  { id: 'hline', icon: 'hline', title: 'Horizontal line', n: 1 },
  { id: 'hray', icon: 'hray', title: 'Horizontal ray', n: 1 },
  { id: 'vline', icon: 'vline', title: 'Vertical line', n: 1 },
  { id: 'rect', icon: 'rect', title: 'Rectangle', n: 2 },
  { id: 'circle', icon: 'circle', title: 'Circle: drag from the centre out', n: 2 },
  { id: 'fib', icon: 'fib', title: 'Fib retracement', n: 2 },
  { id: 'text', icon: 'text', title: 'Text', n: 1 },
  { id: 'measure', icon: 'measure', title: 'Measure (price / time range)', n: 2 },
];
export const SPECIAL_TOOLS = [
  { id: 'avwap', icon: 'avwap', title: 'Anchored VWAP: click a bar to anchor', n: 1 },
  { id: 'frvp', icon: 'vprange', title: 'Fixed range volume profile: drag across a time range', n: 2 },
];
export const DRAW_COLORS = ['#2962ff', '#e0e3eb', '#26a69a', '#ef5350', '#f0b90b', '#ab47bc', '#ff9800', '#00bcd4'];
// Drawings whose outline can be solid / dashed / dotted.
export const STYLED_TYPES = ['trend', 'ray', 'hline', 'hray', 'vline', 'rect', 'circle'];
export const LINE_STYLES = ['solid', 'dashed', 'dotted'];
export const LINE_WIDTHS = [1, 2, 3, 4];
export function dashFor(style, w = 1) {
  if (style === 'dashed') return [4 + w * 3, 3 + w * 2];
  if (style === 'dotted') return [w, Math.max(2, w * 2)];
  return [];
}
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86'];

export class Drawings {
  constructor({ chart, container, coords, getSeries, getBars, onCommit, onSpecial, onSelect }) {
    Object.assign(this, { chart, container, coords, getSeries, getBars, onCommit, onSpecial, onSelect });
    this.list = []; this.sel = null; this.tool = null; this.creating = null; this.drag = null;
    this.magnet = false; this.locked = false; this.hidden = false;
    this.history = []; this.future = [];
    this.primitive = new DrawPrimitive(this);
    const opt = { capture: true };
    container.addEventListener('pointerdown', (e) => this.down(e), opt);
    container.addEventListener('pointermove', (e) => this.move(e), opt);
    window.addEventListener('pointerup', (e) => this.up(e), opt);
    container.addEventListener('dblclick', (e) => this.dbl(e), opt);
    // The chart pans on mousedown/touchstart; swallow those when we handled the pointerdown.
    for (const t of ['mousedown', 'touchstart']) container.addEventListener(t, (e) => { if (this.swallow) { e.stopPropagation(); } }, opt);
  }
  attach(series) { this.series = series; series.attachPrimitive(this.primitive); }
  load(list) { this.list = (list || []).map((d) => ({ ...d })); this.sel = null; this.history = []; this.future = []; this.redraw(); this.onSelect(null); }
  redraw() { this.primitive.requestUpdate?.(); }
  snapshot() { return JSON.stringify(this.list); }
  commit(before) {
    if (before !== undefined && before !== this.snapshot()) { this.history.push(before); if (this.history.length > 100) this.history.shift(); this.future = []; }
    this.onCommit(this.list); this.redraw();
  }
  undo() { if (!this.history.length) return; this.future.push(this.snapshot()); this.list = JSON.parse(this.history.pop()); this.sel = null; this.onSelect(null); this.onCommit(this.list); this.redraw(); }
  redo() { if (!this.future.length) return; this.history.push(this.snapshot()); this.list = JSON.parse(this.future.pop()); this.sel = null; this.onSelect(null); this.onCommit(this.list); this.redraw(); }
  setTool(t) { this.tool = t; this.creating = null; this.container.classList.toggle('tool-active', !!t); this.select(null); this.onTool?.(t); }
  select(id) { this.sel = id; this.redraw(); this.onSelect(this.selected()); }
  selected() { return this.list.find((d) => d.id === this.sel) || null; }
  removeSelected() { if (!this.sel) return; const b = this.snapshot(); this.list = this.list.filter((d) => d.id !== this.sel); this.select(null); this.commit(b); }
  clear() { const b = this.snapshot(); this.list = []; this.select(null); this.commit(b); }
  updateSelected(patch) { const d = this.selected(); if (!d) return; const b = this.snapshot(); Object.assign(d, patch); this.commit(b); }

  // ---- geometry ----
  local(e) { const r = this.container.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  inPane({ x, y }) { const s = this.chart.paneSize(0); return x >= 0 && y >= 0 && x <= s.width && y <= s.height; }
  toXY(pt) { const x = this.coords.timeToX(pt.t); const y = this.series.priceToCoordinate(pt.p); return x == null || y == null ? null : { x, y }; }
  fromXY({ x, y }, snap = this.magnet) {
    let t = this.coords.xToTime(x); let p = this.series.coordinateToPrice(y);
    if (snap) {
      const b = this.coords.barAt(t);
      if (b) {
        let best = p, bd = 30;
        for (const v of [b.open, b.high, b.low, b.close]) { const yy = this.series.priceToCoordinate(v); if (yy != null && Math.abs(yy - y) < bd) { bd = Math.abs(yy - y); best = v; } }
        p = best;
      }
    }
    return { t, p };
  }

  hit(pos) {
    if (this.hidden) return null;
    const W = this.chart.paneSize(0).width;
    for (let k = this.list.length - 1; k >= 0; k--) {
      const d = this.list[k];
      const P = d.pts.map((p) => this.toXY(p));
      if (P.some((p) => !p) && d.type !== 'hline' && d.type !== 'vline') continue;
      for (let i = 0; i < P.length; i++) if (P[i] && dist(pos, P[i]) < 8 && this.sel === d.id) return { d, handle: i };
      if (this.hitShape(d, P, pos, W)) return { d, handle: -1 };
    }
    return null;
  }
  hitShape(d, P, q, W) {
    const tol = 6;
    switch (d.type) {
      case 'trend': return segDist(q, P[0], P[1]) < tol;
      case 'ray': return segDist(q, P[0], extend(P[0], P[1], W)) < tol;
      case 'hline': return P[0] ? Math.abs(q.y - P[0].y) < tol : Math.abs(q.y - this.series.priceToCoordinate(d.pts[0].p)) < tol;
      case 'hray': return Math.abs(q.y - P[0].y) < tol && q.x >= P[0].x - tol;
      case 'vline': return P[0] && Math.abs(q.x - P[0].x) < tol;
      case 'rect': case 'measure': {
        const [a, b] = P; const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        return q.x >= x0 - tol && q.x <= x1 + tol && q.y >= y0 - tol && q.y <= y1 + tol;
      }
      case 'circle': { const [a, b] = P; const r = dist(a, b); return dist(q, a) <= r + tol; }
      case 'fib': {
        const [a, b] = P; const x0 = Math.min(a.x, b.x), x1 = d.extend ? W : Math.max(a.x, b.x);
        if (q.x < x0 - tol || q.x > x1 + tol) return false;
        return FIB.some((f) => Math.abs(q.y - (b.y + (a.y - b.y) * f)) < tol) || segDist(q, a, b) < tol;
      }
      case 'text': { const w = (d.text || '').length * 8 + 8; return q.x >= P[0].x - 4 && q.x <= P[0].x + w && q.y >= P[0].y - 18 && q.y <= P[0].y + 4; }
    }
    return false;
  }

  // ---- events ----
  down(e) {
    this.swallow = false;
    if (e.button !== 0) return;
    // clicks on the floating colour bar, legend and other overlays are not chart clicks
    if (e.target?.closest?.('.floating, .legend, .pane-legend')) return;
    this._down(e);
    this.swallow = lastStopped === e;
  }
  _down(e) {
    const pos = this.local(e);
    if (!this.inPane(pos) || !this.series) return;
    if (this.creating && this.creating.phase === 'follow') { this.finishCreate(); stop(e); return; }
    if (this.tool) {
      stop(e);
      const tool = [...DRAW_TOOLS, ...SPECIAL_TOOLS].find((t) => t.id === this.tool);
      const pt = this.fromXY(pos);
      if (this.tool === 'avwap') { const b = this.coords.barAt(pt.t); this.onSpecial('avwap', { anchor: b ? b.time : pt.t }); this.setTool(null); return; }
      if (tool.n === 1) {
        const d = { id: uid(), type: this.tool, pts: [pt], color: this.tool === 'text' ? '#e0e3eb' : '#2962ff', width: 1 };
        if (this.tool === 'text') { const txt = prompt('Text'); if (!txt) { this.setTool(null); return; } d.text = txt; }
        this.decorate?.(d); const b = this.snapshot(); this.list.push(d); this.setTool(null); this.select(d.id); this.commit(b);
        return;
      }
      this.creating = { d: { id: uid(), type: this.tool, pts: [pt, { ...pt }], color: this.tool === 'measure' ? '#2962ff' : '#2962ff', width: 1 }, phase: 'drag', start: pos };
      this.redraw();
      return;
    }
    if (this.locked) return;
    const h = this.hit(pos);
    if (h) {
      stop(e);
      if (this.sel !== h.d.id) this.select(h.d.id);
      this.drag = { d: h.d, handle: h.handle, start: pos, orig: h.d.pts.map((p) => ({ ...p })), before: this.snapshot(), moved: false };
      this.container.setPointerCapture?.(e.pointerId);
    } else if (this.sel) this.select(null);
  }
  move(e) {
    const pos = this.local(e);
    if (this.creating) {
      stop(e);
      this.creating.d.pts[1] = this.fromXY(pos);
      if (this.creating.d.type === 'measure' || this.creating.d.type === 'frvp') this.creating.d.pts[1] = this.fromXY(pos, false);
      this.redraw();
      return;
    }
    if (this.drag) {
      stop(e);
      const g = this.drag; g.moved = true;
      if (g.handle >= 0) g.d.pts[g.handle] = this.fromXY(pos);
      else {
        const dl = Math.round(this.coords.xToLogical(pos.x) - this.coords.xToLogical(g.start.x));
        const p0 = this.series.coordinateToPrice(g.start.y), p1 = this.series.coordinateToPrice(pos.y);
        g.d.pts = g.orig.map((p) => ({ t: this.coords.logicalToTime(this.coords.timeToLogical(p.t) + dl), p: p.p + (p1 - p0) }));
      }
      this.redraw();
      return;
    }
    if (!this.tool && !this.locked && this.inPane(pos)) {
      const h = this.hit(pos);
      this.container.style.cursor = h ? (h.handle >= 0 ? 'move' : 'pointer') : '';
    }
  }
  up(e) {
    if (this.creating) {
      const pos = this.local(e);
      if (this.creating.phase === 'drag') {
        if (dist(pos, this.creating.start) < 4) { this.creating.phase = 'follow'; return; }
        this.finishCreate();
      }
      return;
    }
    if (this.drag) { const g = this.drag; this.drag = null; if (g.moved) this.commit(g.before); }
  }
  dbl(e) {
    const pos = this.local(e); if (!this.inPane(pos)) return;
    const h = this.hit(pos);
    if (h && h.d.type === 'text') { stop(e); const t = prompt('Text', h.d.text); if (t != null) this.updateSelected({ text: t }); }
    else if (h && h.d.type !== 'frvp') { stop(e); if (this.sel !== h.d.id) this.select(h.d.id); this.onEdit?.(h.d); }
  }
  finishCreate() {
    const d = this.creating.d; this.creating = null;
    if (d.type === 'frvp') { this.onSpecial('frvp', { from: Math.min(d.pts[0].t, d.pts[1].t), to: Math.max(d.pts[0].t, d.pts[1].t) }); this.setTool(null); return; }
    this.decorate?.(d); const b = this.snapshot(); this.list.push(d); this.setTool(null); this.select(d.id); this.commit(b);
  }
}

// ------------- renderer -------------
class DrawPrimitive {
  constructor(owner) { this.o = owner; this._views = [{ renderer: () => this, zOrder: () => 'normal' }]; this._axis = []; }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  paneViews() { return this._views; }
  updateAllViews() {
    const o = this.o; if (!o.series || o.hidden) { this._axis = []; return; }
    const views = [];
    const all = o.creating ? [...o.list, o.creating.d] : o.list;
    for (const d of all) {
      if (d.type === 'hline' || d.type === 'hray' || (d.id === o.sel && d.type !== 'vline')) {
        for (const p of d.type === 'hline' || d.type === 'hray' ? [d.pts[0]] : d.pts) {
          const y = o.series.priceToCoordinate(p.p); if (y == null) continue;
          views.push({ coordinate: () => y, text: () => fmtPrice(p.p), textColor: () => '#fff', backColor: () => d.color, visible: () => true, tickVisible: () => true });
        }
      }
    }
    this._axis = views;
  }
  priceAxisViews() { return this._axis; }
  draw(target) {
    const o = this.o; if (!o.series || o.hidden) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: sz }) => {
      const all = o.creating ? [...o.list, o.creating.d] : o.list;
      for (const d of all) this.drawOne(ctx, sz, d, d.id === o.sel || (o.creating && d === o.creating.d));
    });
  }
  drawOne(ctx, sz, d, selected) {
    const o = this.o;
    const P = d.pts.map((p) => o.toXY(p));
    ctx.save();
    ctx.strokeStyle = d.color; ctx.fillStyle = d.color; ctx.lineWidth = d.width || 1;
    if (STYLED_TYPES.includes(d.type)) ctx.setLineDash(dashFor(d.style, d.width || 1));
    const line = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    switch (d.type) {
      case 'trend': if (P[0] && P[1]) line(P[0], P[1]); break;
      case 'ray': if (P[0] && P[1]) line(P[0], extend(P[0], P[1], sz.width)); break;
      case 'hline': { const y = o.series.priceToCoordinate(d.pts[0].p); if (y != null) line({ x: 0, y }, { x: sz.width, y }); break; }
      case 'hray': if (P[0]) line(P[0], { x: sz.width, y: P[0].y }); break;
      case 'vline': if (P[0]) line({ x: P[0].x, y: 0 }, { x: P[0].x, y: sz.height }); break;
      case 'rect': if (P[0] && P[1]) {
        ctx.fillStyle = d.color + '22'; ctx.fillRect(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y);
        ctx.strokeRect(P[0].x, P[0].y, P[1].x - P[0].x, P[1].y - P[0].y);
      } break;
      case 'circle': if (P[0] && P[1]) {
        const r = dist(P[0], P[1]);
        ctx.beginPath(); ctx.arc(P[0].x, P[0].y, r, 0, Math.PI * 2);
        ctx.fillStyle = d.color + '22'; ctx.fill(); ctx.stroke();
      } break;
      case 'fib': if (P[0] && P[1]) {
        const [a, b] = P; const x0 = Math.min(a.x, b.x), x1 = d.extend ? sz.width : Math.max(a.x, b.x);
        ctx.font = '11px -apple-system, Segoe UI, sans-serif'; ctx.textBaseline = 'bottom';
        let prevY = null;
        FIB.forEach((f, i) => {
          const y = b.y + (a.y - b.y) * f; const price = d.pts[1].p + (d.pts[0].p - d.pts[1].p) * f;
          if (prevY != null) { ctx.fillStyle = FIB_COLORS[i] + '18'; ctx.fillRect(x0, prevY, x1 - x0, y - prevY); }
          ctx.strokeStyle = FIB_COLORS[i]; line({ x: x0, y }, { x: x1, y });
          ctx.fillStyle = FIB_COLORS[i]; ctx.fillText(`${f} (${fmtPrice(price)})`, x0 + 3, y - 1);
          prevY = y;
        });
        ctx.strokeStyle = '#787b8688'; ctx.setLineDash([4, 4]); line(a, b); ctx.setLineDash([]);
      } break;
      case 'text': if (P[0]) {
        ctx.font = `${d.size || 14}px -apple-system, Segoe UI, sans-serif`; ctx.textBaseline = 'bottom';
        ctx.fillText(d.text || '', P[0].x, P[0].y);
      } break;
      case 'measure': case 'frvp': if (P[0] && P[1]) {
        const [a, b] = P; const up = d.pts[1].p >= d.pts[0].p;
        const col = d.type === 'frvp' ? '#2962ff' : up ? '#2962ff' : '#ef5350';
        ctx.fillStyle = col + '30'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
        if (d.type === 'frvp') break;
        ctx.strokeStyle = col; ctx.beginPath(); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        ctx.moveTo(mx, a.y); ctx.lineTo(mx, b.y); ctx.moveTo(a.x, my); ctx.lineTo(b.x, my); ctx.stroke();
        const dp = d.pts[1].p - d.pts[0].p, pct = dp / d.pts[0].p * 100;
        const bars = Math.round(o.coords.timeToLogical(d.pts[1].t) - o.coords.timeToLogical(d.pts[0].t));
        const txt = [`${dp >= 0 ? '+' : ''}${fmtPrice(dp)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`, `${bars} bars, ${durationText(Math.abs(d.pts[1].t - d.pts[0].t))}`];
        ctx.font = '12px -apple-system, Segoe UI, sans-serif';
        const w = Math.max(...txt.map((t) => ctx.measureText(t).width)) + 14;
        const bx = mx - w / 2, by = up ? Math.min(a.y, b.y) - 44 : Math.max(a.y, b.y) + 6;
        ctx.fillStyle = col; roundRect(ctx, bx, clamp(by, 2, sz.height - 40), w, 38, 4); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        txt.forEach((t, i) => ctx.fillText(t, mx, clamp(by, 2, sz.height - 40) + 5 + i * 16));
      } break;
    }
    if (selected && d.type !== 'frvp') {
      ctx.setLineDash([]);
      for (const p of P) if (p) { ctx.beginPath(); ctx.fillStyle = '#131313'; ctx.strokeStyle = d.color; ctx.lineWidth = 1.5; ctx.arc(p.x, p.y, 4.5, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }
}

// ------------- helpers -------------
let lastStopped = null;
function stop(e) { e.stopPropagation(); e.preventDefault(); lastStopped = e; }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y; const L = dx * dx + dy * dy;
  const t = L ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function extend(a, b, W) {
  const dx = b.x - a.x, dy = b.y - a.y; if (Math.abs(dx) < 1e-6) return { x: b.x, y: dy > 0 ? 1e5 : -1e5 };
  const k = ((dx > 0 ? W + 50 : -50) - a.x) / dx; return k > 1 ? { x: a.x + dx * k, y: a.y + dy * k } : b;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function durationText(s) { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
