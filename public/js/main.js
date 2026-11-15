import { createChart, createTextWatermark, CandlestickSeries, BarSeries, LineSeries, AreaSeries, CrosshairMode, LineStyle } from '/vendor/lightweight-charts.mjs';
import { symbolKind } from './util.js';
import { TIMEFRAMES, tfById, ICONS, hydrateIcons, $, $$, el, uid, fmtPrice, decimalsFor, fmtVol, TZ_CHOICES, fmtTick, fmtCrosshair, sessionKeyFn, parts } from './util.js';
import { TastyFeed, DemoFeed } from './datafeed.js';
import { INDICATORS, CATEGORIES, defaults } from './indicators.js';
import { Drawings, DRAW_TOOLS, SPECIAL_TOOLS, DRAW_COLORS } from './drawings.js';

// ===================== layouts =====================
// Each layout is a list of chart rectangles [x, y, w, h] in fractions of the chart area.
const grid = (cols, rows) => { const r = []; for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) r.push([x / cols, y / rows, 1 / cols, 1 / rows]); return r; };
const LAYOUTS = [
  { id: '1', name: '1 chart', r: grid(1, 1) },
  { id: '2v', name: '2 charts, side by side', r: grid(2, 1) },
  { id: '2h', name: '2 charts, stacked', r: grid(1, 2) },
  { id: '3v', name: '3 charts, columns', r: grid(3, 1) },
  { id: '3l', name: '3 charts, 1 left + 2 right', r: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  { id: '3t', name: '3 charts, 1 top + 2 bottom', r: [[0, 0, 1, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] },
  { id: '4', name: '4 charts, 2 × 2', r: grid(2, 2) },
  { id: '4v', name: '4 charts, columns', r: grid(4, 1) },
  { id: '6', name: '6 charts, 3 × 2', r: grid(3, 2) },
  { id: '8', name: '8 charts, 4 × 2', r: grid(4, 2) },
];
const layoutById = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
const layoutIcon = (l) => `<svg viewBox="0 0 24 24" class="lay-ic">${l.r.map(([x, y, w, h]) => `<rect x="${3 + x * 18 + 0.8}" y="${4 + y * 16 + 0.8}" width="${w * 18 - 1.6}" height="${h * 16 - 1.6}" rx="1"/>`).join('')}</svg>`;
ICONS.maximize = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
ICONS.restore = '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/></svg>';

// ===================== persisted state =====================
const KEY = 'charts.state.v1';
const defaultIndicators = () => [{ id: uid(), type: 'volume', params: defaults('volume') }, { id: uid(), type: 'vpvr', params: defaults('vpvr') }];
const DEFAULT_STATE = {
  tz: 'local', rth: false, grid: false, showWatch: true,
  watchlist: ['SPY', 'QQQ', 'IWM', 'AAPL', 'NVDA', 'TSLA', '/ES', '/NQ', '/CL', '/GC', 'BTC/USD'],
  favorites: ['vpvr', 'tpo', 'avwap', 'vwap'],
  perSymbol: {},
  layout: '1', active: 0,
  panes: [],   // one config per chart: { symbol, tf, chartType, indicators }
  sync: { symbol: false, interval: false, crosshair: true, time: false },
};
let S;
try { S = { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { S = { ...DEFAULT_STATE }; }
// Migrate the single-chart state (symbol / tf / chartType / indicators at the top level) to chart #1.
if (!Array.isArray(S.panes) || !S.panes.length) {
  S.panes = [{ symbol: S.symbol || 'SPY', tf: S.tf || '5m', chartType: S.chartType || 'candles', indicators: Array.isArray(S.indicators) ? S.indicators : defaultIndicators() }];
}
delete S.symbol; delete S.tf; delete S.chartType; delete S.indicators;
S.sync = { ...DEFAULT_STATE.sync, ...(S.sync || {}) };
S.panes.forEach((c) => { c.id ||= uid(); }); // stable id per chart, used to keep drawings on their own chart
S.indicatorDefaults ||= {};
S.alerts ||= []; S.alertLog ||= []; if (S.alertSound === undefined) S.alertSound = true; // price alerts
S.views ||= {}; // remembered zoom/scroll per chart and timeframe: { 'paneId|tf': { back, ahead } } in bars from the last bar
if (S.watermark === undefined) S.watermark = true;  // big faint symbol + description behind the candles
if (S.shadeEth === undefined) S.shadeEth = true; // shade pre-market / after-hours bars on intraday stock charts
// Several named watchlists; S.watchlist is always the one being shown.
if (!S.watchlists || !Object.keys(S.watchlists).length) S.watchlists = { Watchlist: Array.isArray(S.watchlist) ? S.watchlist : [...DEFAULT_STATE.watchlist] };
if (!S.watchlists[S.wlName]) S.wlName = Object.keys(S.watchlists)[0];
S.watchlist = S.watchlists[S.wlName];
S.wlCols = { last: true, chg: true, pct: true, vol: false, ext: true, ...(S.wlCols || {}) }; // watchlist columns // per indicator type: settings saved with "Save as default"
let saveT = null;
let renderSavedBtn = null; // set below
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { S.watchlists[S.wlName] = S.watchlist; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} renderSavedBtn?.(); }, 200); };
S.layouts ||= {};          // saved layouts by name: { layout, panes, sync, active }
if (S.layoutName === undefined) S.layoutName = null; // name of the saved layout that is open (null = not saved yet)
const symState = (sym) => (S.perSymbol[sym] ||= { drawings: [], indicators: [] });
const clone = (x) => JSON.parse(JSON.stringify(x));

let feed = null;
const quotes = new Map();
const panes = [];        // ChartPane instances currently shown
let active = null;       // the chart the top bar, toolbar and watchlist act on
let maximized = null;    // a chart temporarily filling the whole layout
let syncing = false;     // guards against sync feedback loops
const drawFlags = { magnet: false, locked: false, hidden: false };
let currentTool = null;

// ===================== extended-hours shading =====================
// Draws a soft background band behind pre-market and after-hours bars (US stocks/ETFs, intraday timeframes),
// like TradingView's "extended hours" background.
const ETH_SHADE = 'rgba(41, 98, 255, 0.07)';
const nyMinute = (() => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const cache = new Map();
  return (t) => {
    let v = cache.get(t);
    if (v === undefined) { const p = f.formatToParts(new Date(t * 1000)); v = +p.find((x) => x.type === 'hour').value * 60 + +p.find((x) => x.type === 'minute').value; if (cache.size > 200000) cache.clear(); cache.set(t, v); }
    return v;
  };
})();
class EthShade {
  constructor(pane) { this.p = pane; this._views = [{ zOrder: () => 'bottom', renderer: () => this }]; }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  paneViews() { return this._views; }
  updateAllViews() {}
  active() { const p = this.p; return S.shadeEth && !S.rth && p.tf.sec < 86400 && p.info.kind === 'equity'; }
  draw(target) {
    if (!this.active()) return;
    const p = this.p, bars = p.bars, ts = p.chart.timeScale(); if (!bars.length) return;
    const r = ts.getVisibleLogicalRange(); if (!r) return;
    const from = Math.max(0, Math.floor(r.from) - 1), to = Math.min(bars.length - 1, Math.ceil(r.to) + 1);
    const half = (ts.options().barSpacing || 6) / 2;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: sz }) => {
      ctx.fillStyle = ETH_SHADE;
      let runStart = null;
      const flush = (endIdx) => {
        const x0 = ts.logicalToCoordinate(runStart), x1 = ts.logicalToCoordinate(endIdx);
        if (x0 != null && x1 != null) ctx.fillRect(Math.floor(x0 - half), 0, Math.ceil(x1 - x0 + 2 * half), sz.height);
      };
      for (let i = from; i <= to; i++) {
        const m = nyMinute(bars[i].time);
        const eth = m < 570 || m >= 960; // outside 9:30-16:00 New York (bar start time)
        if (eth && runStart === null) runStart = i;
        if (!eth && runStart !== null) { flush(i - 1); runStart = null; }
      }
      if (runStart !== null) flush(to);
    });
  }
}

// ===================== one chart =====================
class ChartPane {
  constructor(cfg) {
    this.cfg = cfg;
    this.bars = []; this.shown = [];
    this.info = { symbol: cfg.symbol, streamer: cfg.symbol, name: cfg.symbol, kind: 'equity' };
    this.tf = tfById(cfg.tf);
    this.unsub = null; this.needFit = true; this.mainSeries = null; this.handles = new Map(); this.hoverTime = null; this.loadSeq = 0;

    this.root = el('div', { class: 'pane' });
    this.host = el('div', { class: 'chart-host' });
    this.legendEl = el('div', { class: 'legend' });
    this.drawBar = el('div', { class: 'floating drawbar hidden' });
    this.root.append(this.host, this.legendEl, this.drawBar);
    $('#panes').append(this.root);
    // Must be registered before the drawing handlers so a click on another chart activates it first.
    this.root.addEventListener('pointerdown', () => setActive(this), { capture: true });
    this.alertLines = [];
    this.root.addEventListener('pointerdown', (e) => this.alertDragStart(e), { capture: true });
    this.root.addEventListener('mousedown', (e) => { if (this.alertDrag) { e.stopImmediatePropagation(); e.preventDefault(); } }, { capture: true });
    this.root.addEventListener('pointermove', (e) => { if (!this.alertDrag) this.root.classList.toggle('alert-hover', !!this.alertAt(e)); });
    this.root.addEventListener('contextmenu', (e) => this.chartMenu(e));

    const self = this;
    this.chart = createChart(this.host, {
      autoSize: true,
      layout: { background: { type: 'solid', color: '#0f0f0f' }, textColor: '#b2b5be', fontSize: 12, fontFamily: getComputedStyle(document.body).fontFamily,
        panes: { separatorColor: '#262626', separatorHoverColor: '#2962ff33', enableResize: true }, attributionLogo: false }, // credit is in the status bar instead
      grid: { vertLines: { color: '#1a1a1a', visible: S.grid }, horzLines: { color: '#1a1a1a', visible: S.grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#787b86', style: LineStyle.Dashed, labelBackgroundColor: '#363a45' }, horzLine: { color: '#787b86', style: LineStyle.Dashed, labelBackgroundColor: '#363a45' } },
      rightPriceScale: { borderColor: '#262626', scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: '#262626', rightOffset: 12, barSpacing: 7, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (t, type) => fmtTick(t, type, S.tz) },
      localization: { timeFormatter: (t) => fmtCrosshair(t, S.tz, self.tf.sec) },
    });

    // time <-> coordinate helpers that also work left/right of the loaded data
    const coords = this.coords = {
      width: () => self.chart.timeScale().width(),
      timeToLogical(t) {
        const bars = self.bars, sec = self.tf.sec; const n = bars.length; if (!n) return 0;
        if (t <= bars[0].time) return (t - bars[0].time) / sec;
        if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / sec;
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (bars[m].time <= t) lo = m; else hi = m; }
        return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
      },
      logicalToTime(l) {
        const bars = self.bars, sec = self.tf.sec; const n = bars.length; if (!n) return 0;
        if (l <= 0) return bars[0].time + Math.round(l) * sec;
        if (l >= n - 1) return bars[n - 1].time + Math.round(l - (n - 1)) * sec;
        const i = Math.floor(l), f = l - i; return Math.round(bars[i].time + f * (bars[i + 1].time - bars[i].time));
      },
      timeToX(t) { return self.chart.timeScale().logicalToCoordinate(coords.timeToLogical(t)); },
      xToLogical(x) { return self.chart.timeScale().coordinateToLogical(x) ?? 0; },
      xToTime(x) { return coords.logicalToTime(Math.round(coords.xToLogical(x))); },
      barAt(t) { const l = Math.round(coords.timeToLogical(t)); return self.bars[l] || null; },
    };

    this.drawings = new Drawings({
      chart: this.chart, container: this.root, coords,
      getSeries: () => this.mainSeries, getBars: () => this.bars,
      onCommit: (list) => {
        // keep drawings that belong to other charts, replace the ones this chart shows
        const ss = symState(this.info.symbol);
        ss.drawings = [...ss.drawings.filter((d) => d.pane && d.pane !== this.cfg.id), ...clone(list.filter((d) => d.type !== 'frvp'))];
        save(); shareDrawings(this); syncLineAlerts(this.info.symbol, list);
      },
      onSpecial: (kind, params) => this.addIndicator(kind, params, true),
      onSelect: (d) => this.renderDrawBar(d),
    });
    Object.assign(this.drawings, drawFlags);
    // New drawings stay on this chart; horizontal lines/rays show on every chart of the symbol.
    this.drawings.decorate = (d) => { if (!SHARED_BY_DEFAULT.includes(d.type)) d.pane = this.cfg.id; };
    this.drawings.onTool = (t) => { if (this === active) { currentTool = t; paintTools(t); } };

    this.chart.subscribeCrosshairMove((p) => { this.hoverPrice = p.point && this.mainSeries ? this.mainSeries.coordinateToPrice(p.point.y) : null; this.updateLegendMain(p.time ?? null); syncCrosshair(this, p); });
    this.chart.timeScale().subscribeVisibleTimeRangeChange(() => syncTimeRange(this));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => this.rememberView(r));
    this.chart.timeScale().subscribeSizeChange?.(() => setTimeout(() => this.placePaneLegends(), 0));
    this.width = 9999;
    this.ro = new ResizeObserver(() => { this.width = this.host.clientWidth; this.updateLegendMain(undefined); this.updateWatermark(); setTimeout(() => this.placePaneLegends(), 30); }); this.ro.observe(this.host);
    this.host.addEventListener('mouseup', () => setTimeout(() => this.placePaneLegends(), 30));
  }

  // drawings of this symbol that show on this chart: its own plus the ones set to "all charts"
  myDrawings() { return clone(symState(this.info.symbol).drawings.filter((d) => !d.pane || d.pane === this.cfg.id)); }

  destroy() {
    if (this.unsub) this.unsub(); this.unsub = null;
    for (const h of this.handles.values()) { try { h.destroy(); } catch {} }
    this.handles.clear();
    this.ro.disconnect();
    this.drawings.setTool(null);
    try { this.chart.remove(); } catch {}
    this.root.remove();
  }

  makeMainSeries() {
    const common = { priceLineVisible: true, lastValueVisible: true, priceLineStyle: LineStyle.Dotted };
    const up = '#26a69a', dn = '#ef5350';
    switch (this.cfg.chartType) {
      case 'bars': return this.chart.addSeries(BarSeries, { ...common, upColor: up, downColor: dn, thinBars: false });
      case 'line': return this.chart.addSeries(LineSeries, { ...common, color: '#2962ff', lineWidth: 2 });
      case 'area': return this.chart.addSeries(AreaSeries, { ...common, lineColor: '#2962ff', topColor: '#2962ff55', bottomColor: '#2962ff05', lineWidth: 2 });
      default: return this.chart.addSeries(CandlestickSeries, { ...common, upColor: up, downColor: dn, wickUpColor: up, wickDownColor: dn, borderVisible: false });
    }
  }
  transform(arr) {
    if (this.cfg.chartType !== 'ha') return arr;
    const out = []; let po = null, pc = null;
    for (const b of arr) {
      const c = (b.open + b.high + b.low + b.close) / 4; const o = po == null ? (b.open + b.close) / 2 : (po + pc) / 2;
      out.push({ time: b.time, open: o, high: Math.max(b.high, o, c), low: Math.min(b.low, o, c), close: c, volume: b.volume }); po = o; pc = c;
    }
    return out;
  }
  asSeries(b) { return this.cfg.chartType === 'line' || this.cfg.chartType === 'area' ? { time: b.time, value: b.close } : { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }; }
  priceFormat() {
    const last = this.bars[this.bars.length - 1]?.close || 100;
    const tick = this.info.tick || (last < 1 ? 0.0001 : 0.01);
    const precision = Math.max(0, Math.min(8, Math.ceil(-Math.log10(tick) - 1e-9)));
    return { type: 'price', precision, minMove: tick };
  }
  activeIndicators() { return [...this.cfg.indicators, ...symState(this.info.symbol).indicators]; }

  // Rebuild main series + all indicators (on chart type change, indicator add/remove, symbol load).
  rebuildAll() {
    const chart = this.chart;
    for (const h of this.handles.values()) { try { h.destroy(); } catch (e) { console.error(e); } }
    this.handles.clear();
    if (this.mainSeries) { try { this.mainSeries.detachPrimitive(this.drawings.primitive); } catch {} try { if (this.ethShade) this.mainSeries.detachPrimitive(this.ethShade); } catch {} chart.removeSeries(this.mainSeries); }
    for (let i = chart.panes().length - 1; i > 0; i--) { try { chart.removePane(i); } catch {} }
    this.mainSeries = this.makeMainSeries();
    this.mainSeries.applyOptions({ priceFormat: this.priceFormat() });
    this.mainSeries.attachPrimitive(this.ethShade ||= new EthShade(this));
    this.drawings.attach(this.mainSeries);
    this.shown = this.transform(this.bars);
    this.mainSeries.setData(this.shown.map((b) => this.asSeries(b)));
    let pane = 1;
    for (const inst of this.activeIndicators()) {
      if (inst.hidden) continue;
      const def = INDICATORS[inst.type]; if (!def) continue;
      const ctx = { chart, main: this.mainSeries, coords: this.coords, tf: this.tf, info: this.info, sessionKey: sessionKeyFn(this.info.kind), paneIndex: def.pane ? pane++ : 0 };
      try {
        const h = def.create(ctx, { ...defaults(inst.type), ...inst.params });
        h.paneIndex = ctx.paneIndex;
        this.handles.set(inst.id, h);
        if (this.bars.length) h.update(this.bars, 'reset');
      } catch (e) { console.error('indicator failed', inst.type, e); }
    }
    chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 4 : 1));
    this.renderLegend();
    this.renderAlertLines();
    setTimeout(() => this.placePaneLegends(), 50);
  }

  onBars(arr, kind) {
    if (kind === 'nodata') { toast(`No ${this.tf.id} candles received for ${this.info.symbol} yet. If this persists, send a screenshot of the browser console (F12).`, 8000); return; }
    if (kind === 'reset') {
      const first = this.needFit; // stays true until the view is restored, so the default range is not remembered
      this.bars = arr;
      this.shown = this.transform(this.bars);
      this.mainSeries.applyOptions({ priceFormat: this.priceFormat() });
      this.mainSeries.setData(this.shown.map((b) => this.asSeries(b)));
      for (const h of this.handles.values()) try { h.update(this.bars, 'reset'); } catch (e) { console.error(e); }
      if (first) { this.resetView(true); this.needFit = false; }
      this.drawings.redraw();
    } else {
      const bars = this.bars; const changed = [];
      for (const b of arr) {
        const last = bars[bars.length - 1];
        if (last && b.time === last.time) { Object.assign(last, b); changed.push(last); }
        else if (!last || b.time > last.time) { bars.push({ ...b }); changed.push(bars[bars.length - 1]); }
      }
      if (!changed.length) return;
      if (this.cfg.chartType === 'ha') { this.shown = this.transform(bars); this.mainSeries.update(this.asSeries(this.shown[this.shown.length - 1])); }
      else for (const b of changed) this.mainSeries.update(this.asSeries(b));
      for (const h of this.handles.values()) try { h.update(bars, 'update', changed); } catch (e) { console.error(e); }
    }
    this.updateLegendMain(undefined);
    if (this === active) renderDetail();
  }

  // ---- price alerts on this chart ----
  renderAlertLines() {
    for (const l of this.alertLines) try { this.mainSeries.removePriceLine(l.line); } catch {}
    this.alertLines = [];
    if (!this.mainSeries) return;
    for (const a of S.alerts) {
      if (!a.active || a.symbol !== this.info.symbol) continue;
      const line = this.mainSeries.createPriceLine({ price: a.price, color: ALERT_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
        title: `Alert${a.cond === 'up' ? ' ↑' : a.cond === 'down' ? ' ↓' : ''}`, axisLabelColor: ALERT_COLOR, axisLabelTextColor: '#000' });
      this.alertLines.push({ a, line });
    }
  }
  // the alert line under the pointer (within 4px), if any
  alertAt(e) {
    if (!this.mainSeries || !this.alertLines.length || currentTool) return null;
    const r = this.host.getBoundingClientRect(), y = e.clientY - r.top;
    if (y > (this.chart.panes()[0]?.getHeight() ?? r.height)) return null;
    for (const { a } of this.alertLines) { const ly = this.mainSeries.priceToCoordinate(a.price); if (ly != null && Math.abs(ly - y) <= 4) return a; }
    return null;
  }
  alertDragStart(e) {
    if (e.button !== 0) return;
    const a = this.alertAt(e); if (!a) return;
    e.stopImmediatePropagation(); e.preventDefault();
    this.alertDrag = a; this.drawings.select(null);
    this.chart.applyOptions({ handleScroll: false, handleScale: false });
    const r = this.host.getBoundingClientRect(), start = a.price;
    const move = (ev) => {
      const p = this.mainSeries.coordinateToPrice(ev.clientY - r.top); if (p == null) return;
      a.price = roundPrice(p, a.symbol);
      for (const p2 of panes) for (const l of p2.alertLines) if (l.a === a) l.line.applyOptions({ price: a.price });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      this.chart.applyOptions({ handleScroll: true, handleScale: true });
      setTimeout(() => { this.alertDrag = null; }, 0);
      if (a.price !== start) { delete a.drawingId; save(); alertsChanged(); toast(`${a.symbol} alert moved to ${fmtPrice(a.price)}`, 1500); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  chartMenu(e) {
    const r = this.host.getBoundingClientRect();
    if (!this.mainSeries || e.clientY - r.top > (this.chart.panes()[0]?.getHeight() ?? r.height)) return;
    e.preventDefault();
    const sym = this.info.symbol, onLine = this.alertAt(e);
    const p = this.mainSeries.coordinateToPrice(e.clientY - r.top); const price = p == null ? null : roundPrice(p, sym);
    const items = [];
    if (onLine) {
      items.push([`Edit alert at ${fmtPrice(onLine.price)}…`, () => openAlertDialog({}, onLine)]);
      items.push(['Delete this alert', () => deleteAlert(onLine)]);
    } else if (price != null) items.push([`Add alert on ${sym} at ${fmtPrice(price)}…`, () => openAlertDialog({ symbol: sym, price })]);
    items.push(['Reset chart view', () => this.resetView()]);
    showCtxMenu(e.clientX, e.clientY, items);
  }
  viewKey() { return `${this.cfg.id}|${this.tf.id}`; }
  // Remember how far back / ahead of the last bar this chart is zoomed, so it reopens the same way.
  rememberView(r) {
    const n = this.bars.length; if (!r || !n || this.needFit) return;
    const v = { back: +(n - 1 - r.from).toFixed(2), ahead: +(r.to - (n - 1)).toFixed(2) };
    const old = S.views[this.viewKey()];
    if (old && old.back === v.back && old.ahead === v.ahead) return;
    S.views[this.viewKey()] = v; save();
  }
  resetView(useSaved = false) {
    const n = this.bars.length; if (!n) return;
    const v = useSaved && S.views[this.viewKey()];
    if (v && v.back > 1 && isFinite(v.ahead)) {
      this.chart.timeScale().setVisibleLogicalRange({ from: n - 1 - v.back, to: n - 1 + v.ahead });
      this.chart.priceScale('right').applyOptions({ autoScale: true });
      return;
    }
    const vis = Math.min(n, this.tf.sec >= 86400 ? 200 : 160);
    this.chart.timeScale().setVisibleLogicalRange({ from: n - vis, to: n - 1 + 12 });
    this.chart.priceScale('right').applyOptions({ autoScale: true });
  }

  subscribe() {
    if (this.unsub) this.unsub();
    this.bars = []; this.needFit = true;
    this.rebuildAll();
    this.unsub = feed.subscribeChart(this.info, this.tf, { rth: S.rth }, (arr, kind) => { if (kind === 'reset' && this === active) hideToast(); this.onBars(arr, kind); });
  }

  async loadSymbol(sym, fromSync = false) {
    sym = sym.trim().toUpperCase(); if (!sym) return;
    const seq = ++this.loadSeq;
    if (this === active) toast(`Loading ${sym}…`);
    let info;
    try { const i = await feed.resolve(sym); info = { ...i, kind: i.kind || 'equity' }; }
    catch (e) { toast(`${sym}: ${e.message}`, 4000); return; }
    if (seq !== this.loadSeq || !panes.includes(this)) return;
    this.info = info;
    this.cfg.symbol = sym; save();
    this.drawings.load(this.myDrawings());
    this.subscribe();
    if (this === active) { renderTopbar(); renderWatchlist(); }
    if (S.sync.symbol && !fromSync) for (const p of panes) if (p !== this && p.cfg.symbol !== sym) p.loadSymbol(sym, true);
  }
  setTimeframe(id, fromSync = false) {
    this.tf = tfById(id); this.cfg.tf = this.tf.id; save();
    if (this === active) renderTf();
    this.subscribe();
    if (S.sync.interval && !fromSync) for (const p of panes) if (p !== this && p.cfg.tf !== this.tf.id) p.setTimeframe(this.tf.id, true);
  }
  setChartType(t) { this.cfg.chartType = t; save(); this.rebuildAll(); }

  // ---- legend ----
  renderLegend() {
    const L = this.legendEl; L.innerHTML = '';
    const multi = panes.length > 1;
    const main = el('div', { class: 'l-main' }, `<span class="l-title" title="Change symbol">${this.info.symbol} · ${this.tf.id}${feed?.mode === 'live' ? '' : ' · Demo'}</span><span class="l-ohlc"></span>`);
    main.querySelector('.l-title').addEventListener('click', (e) => { e.stopPropagation(); setActive(this); openSymbol(); });
    if (multi) {
      const mx = el('button', { class: 'l-max', title: maximized === this ? 'Restore layout (Alt+Enter)' : 'Maximize this chart (Alt+Enter)' }, `<span class="ic small">${maximized === this ? ICONS.restore : ICONS.maximize}</span>`);
      mx.addEventListener('click', (e) => { e.stopPropagation(); setActive(this); toggleMaximize(); });
      main.prepend(mx);
    }
    L.append(main);
    this.updateWatermark();
    $$('.pane-legend', this.root).forEach((x) => x.remove());
    const box = el('div', { class: 'l-inds' + (this.cfg.legendCollapsed ? ' collapsed' : '') });
    let nMain = 0;
    for (const inst of this.activeIndicators()) {
      const def = INDICATORS[inst.type]; if (!def) continue;
      const h = this.handles.get(inst.id);
      const row = el('div', { class: 'l-ind' + (inst.hidden ? ' off' : ''), 'data-id': inst.id });
      row.innerHTML = `<span class="nm">${this.legendName(inst)}</span><span class="vals"></span><span class="acts">
        <button title="${inst.hidden ? 'Show' : 'Hide'}" data-a="eye"><span class="ic small">${inst.hidden ? ICONS.eyeoff : ICONS.eye}</span></button>
        <button title="Settings" data-a="set"><span class="ic small">${ICONS.settings}</span></button>
        <button title="Remove" data-a="del"><span class="ic small">${ICONS.close}</span></button></span>`;
      row.addEventListener('click', (e) => {
        const a = e.target.closest('button')?.dataset.a; if (!a) return;
        if (a === 'eye') { inst.hidden = !inst.hidden; save(); this.rebuildFor(inst); }
        if (a === 'set') openParams(inst, this);
        if (a === 'del') this.removeIndicator(inst.id);
      });
      if (h && h.paneIndex > 0) { row.classList.add('pane-legend'); row.dataset.pane = h.paneIndex; this.root.append(row); }
      else { box.append(row); nMain++; }
    }
    if (nMain) {
      // collapse / expand the indicator rows so they don't cover the chart
      const c = !!this.cfg.legendCollapsed;
      const tg = el('button', { class: 'l-toggle', title: c ? 'Show indicator legend' : 'Hide indicator legend' },
        `<svg viewBox="0 0 24 24"><path d="${c ? 'M6 9l6 6 6-6' : 'M6 15l6-6 6 6'}"/></svg>${c ? `<span>${nMain} indicator${nMain > 1 ? 's' : ''}</span>` : ''}`);
      tg.addEventListener('click', (e) => { e.stopPropagation(); this.cfg.legendCollapsed = !c; save(); this.renderLegend(); });
      L.append(box, tg);
    }
    this.placePaneLegends();
    this.updateLegendMain(undefined);
  }
  // symbol description, e.g. "NVIDIA Corporation" (tastytrade's name, without the demo suffix)
  description() { const n = (this.info.name || '').replace(/\s*\(demo data\)$/, ''); return n && n !== this.info.symbol ? n : ''; }
  updateWatermark() {
    const lines = [];
    if (S.watermark) {
      const h = this.host.clientHeight || 400, w = this.host.clientWidth || 600;
      const big = Math.round(Math.max(28, Math.min(96, Math.min(h / 5, w / 7))));
      const tfName = { D: '1D', W: '1W' }[this.tf.id] || this.tf.id;
      lines.push({ text: `${this.info.symbol}, ${tfName}`, color: 'rgba(178, 181, 190, 0.12)', fontSize: big, fontStyle: '600' });
      const ds = this.description(); if (ds) lines.push({ text: ds.length > 40 ? ds.slice(0, 38).trim() + '…' : ds, color: 'rgba(178, 181, 190, 0.12)', fontSize: Math.round(big * 0.32) });
    }
    try {
      if (!this.wm) this.wm = createTextWatermark(this.chart.panes()[0], { horzAlign: 'center', vertAlign: 'center', lines });
      else this.wm.applyOptions({ lines });
    } catch (e) { console.warn('watermark', e); }
  }
  legendName(inst) {
    const d = INDICATORS[inst.type]; const p = { ...defaults(inst.type), ...inst.params };
    const args = { sma: [p.length, p.source], ema: [p.length, p.source], bb: [p.length, p.mult], rsi: [p.length], macd: [p.fast, p.slow, p.signal], atr: [p.length], vpvr: [p.rows], tpo: [p.period + 'm'], svp: [p.rows] }[inst.type];
    let extra = '';
    if (inst.type === 'avwap' && p.anchor) extra = ` <span class="muted">${fmtCrosshair(p.anchor, S.tz, this.tf.sec)}</span>`;
    return `${d.short || d.name}${args ? ' ' + args.join(' ') : ''}${extra}`;
  }
  placePaneLegends() {
    let top = 0; let ps; try { ps = this.chart.panes(); } catch { return; }
    const tops = ps.map((p) => { const t = top; top += p.getHeight() + 1; return t; });
    $$('.pane-legend', this.root).forEach((r) => { r.style.top = (tops[+r.dataset.pane] ?? 0) + 4 + 'px'; });
  }
  updateLegendMain(t) {
    if (t !== undefined) this.hoverTime = t;
    const bars = this.bars, shown = this.shown;
    const i = this.hoverTime == null ? bars.length - 1 : bars.findIndex((b) => b.time === this.hoverTime);
    const b = shown[i] || shown[shown.length - 1]; const o = $('.l-ohlc', this.legendEl);
    if (o && b) {
      const prev = shown[i - 1]; const ch = prev ? b.close - prev.close : 0; const pc = prev ? ch / prev.close * 100 : 0;
      const cls = b.close >= b.open ? 'up' : 'down';
      // narrow charts (big layouts) show less so the legend stays on one line
      const w = this.width, ohlc = w >= 480, vol = w >= 760;
      const chg = `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${fmtPrice(ch, decimalsFor(b.close))} (${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%)</span>`;
      o.innerHTML = ohlc
        ? `<span><b>O</b><i class="${cls}">${fmtPrice(b.open)}</i></span><span><b>H</b><i class="${cls}">${fmtPrice(b.high)}</i></span><span><b>L</b><i class="${cls}">${fmtPrice(b.low)}</i></span><span><b>C</b><i class="${cls}">${fmtPrice(b.close)}</i></span>${chg}${vol ? `<span><b>Vol</b>${fmtVol(bars[i]?.volume)}</span>` : ''}`
        : `<span><i class="${cls}">${fmtPrice(b.close)}</i></span>${chg}`;
      o.querySelectorAll('i').forEach((x) => (x.style.fontStyle = 'normal'));
    }
    const time = b?.time;
    $$('.l-ind', this.root).forEach((row) => {
      const h = this.handles.get(row.dataset.id); const v = row.querySelector('.vals'); if (!v) return;
      v.innerHTML = h && time != null ? (h.legend(time) || []).map((x) => `<span style="color:${x.c}">${x.v}</span>`).join('') : '';
    });
  }
  // the bar that contains time t (for crosshair sync between different timeframes)
  barContaining(t) {
    const bars = this.bars; if (!bars.length || t < bars[0].time) return null;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].time <= t) lo = m; else hi = m - 1; }
    const b = bars[lo]; return t - b.time < Math.max(this.tf.sec, 86400 * (this.tf.sec >= 86400 ? 7 : 0)) ? b : null;
  }

  // ---- indicators ----
  isPerSymbol(inst) { return symState(this.info.symbol).indicators.some((i) => i.id === inst.id); }
  rebuildFor(inst) { if (this.isPerSymbol(inst)) rebuildSymbol(this.info.symbol); else this.rebuildAll(); }
  addIndicator(type, params = {}, perSymbol = false) {
    const inst = { id: uid(), type, params: { ...defaults(type), ...(S.indicatorDefaults[type] || {}), ...params } };
    if (perSymbol || type === 'avwap' || type === 'frvp') { symState(this.info.symbol).indicators.push(inst); save(); rebuildSymbol(this.info.symbol); }
    else { this.cfg.indicators.push(inst); save(); this.rebuildAll(); }
    toast(`${INDICATORS[type].name} added`, 1500);
  }
  removeIndicator(id) {
    const ss = symState(this.info.symbol); const wasSym = ss.indicators.some((i) => i.id === id);
    this.cfg.indicators = this.cfg.indicators.filter((i) => i.id !== id);
    ss.indicators = ss.indicators.filter((i) => i.id !== id);
    save();
    if (wasSym) rebuildSymbol(this.info.symbol); else this.rebuildAll();
  }

  renderDrawBar(d) {
    const bar = this.drawBar;
    if (!d) { bar.classList.add('hidden'); return; }
    const dr = this.drawings;
    bar.innerHTML = '';
    for (const c of DRAW_COLORS) bar.append(el('div', { class: 'sw' + (d.color === c ? ' on' : ''), style: `background:${c}`, title: c, onclick: () => { dr.updateSelected({ color: c }); this.renderDrawBar(dr.selected()); } }));
    bar.append(el('div', { class: 'sep' }));
    const shared = !d.pane;
    bar.append(el('button', { class: 'tb-btn small scope-btn' + (shared ? ' on' : ''), title: shared ? 'Showing on every chart of this symbol. Click to keep it on this chart only' : 'Showing on this chart only. Click to show it on every chart of this symbol',
      onclick: () => { dr.updateSelected({ pane: shared ? this.cfg.id : undefined }); this.renderDrawBar(dr.selected()); } }, shared ? 'All charts' : 'This chart'));
    bar.append(el('button', { class: 'tb-btn small', title: 'Line width', onclick: () => { dr.updateSelected({ width: (d.width % 3) + 1 }); this.renderDrawBar(dr.selected()); } }, `${d.width || 1}px`));
    if (d.type === 'text') bar.append(el('button', { class: 'tb-btn small', onclick: () => { const t = prompt('Text', d.text); if (t != null) dr.updateSelected({ text: t }); } }, 'Edit'));
    if (d.type === 'hline' || d.type === 'hray') {
      const linked = S.alerts.find((a) => a.drawingId === d.id && a.symbol === this.info.symbol);
      bar.append(el('button', { class: 'tb-btn small' + (linked?.active ? ' on' : ''), title: linked ? 'Edit the alert on this line' : 'Alert me when price crosses this line',
        onclick: () => linked ? openAlertDialog({}, linked) : openAlertDialog({ symbol: this.info.symbol, price: roundPrice(d.pts[0].p, this.info.symbol), drawingId: d.id }) }, `<span class="ic">${ICONS.bell}</span>${linked ? 'Alert' : 'Add alert'}`));
    }
    if (d.type === 'fib') bar.append(el('button', { class: 'tb-btn small' + (d.extend ? ' on' : ''), onclick: () => { dr.updateSelected({ extend: !d.extend }); this.renderDrawBar(dr.selected()); } }, 'Extend'));
    bar.append(el('button', { class: 'tb-btn icon-btn small', title: 'Delete (Del)', onclick: () => dr.removeSelected() }, `<span class="ic">${ICONS.trash}</span>`));
    bar.classList.remove('hidden');
  }
}

// ===================== layout management =====================
function rebuildSymbol(sym) { for (const p of panes) if (p.info.symbol === sym) p.rebuildAll(); }
const SHARED_BY_DEFAULT = ['hline', 'hray'];
function shareDrawings(src) {
  // other charts on the same symbol pick up changes to drawings set to "all charts"
  for (const p of panes) if (p !== src && p.info.symbol === src.info.symbol) p.drawings.load(p.myDrawings());
}
function newPaneConfig(i) {
  const used = new Set(S.panes.map((c) => c.symbol));
  const symbol = S.watchlist.find((s) => !used.has(s)) || S.watchlist[i % Math.max(1, S.watchlist.length)] || 'SPY';
  const base = S.panes[0];
  return { id: uid(), symbol, tf: base?.tf || '5m', chartType: base?.chartType || 'candles', indicators: (base?.indicators || defaultIndicators()).map((x) => ({ ...clone(x), id: uid() })) };
}
function applyLayout(id) {
  const L = layoutById(id); S.layout = L.id;
  const n = L.r.length;
  while (S.panes.length < n) S.panes.push(newPaneConfig(S.panes.length));
  maximized = null;
  // remove charts beyond the new count (their settings stay saved for next time)
  while (panes.length > n) { const p = panes.pop(); if (p === active) active = null; p.destroy(); }
  // add missing charts
  const fresh = [];
  for (let i = panes.length; i < n; i++) { const p = new ChartPane(S.panes[i]); panes.push(p); fresh.push(p); }
  positionPanes();
  if (!active) setActive(panes[(S.active || 0) < n ? S.active || 0 : 0], true);
  for (const p of panes) if (!fresh.includes(p)) p.renderLegend(); // compact legends follow the chart count
  for (const p of fresh) p.loadSymbol(p.cfg.symbol, true);
  renderLayoutMenu();
  save();
}
function positionPanes() {
  const L = layoutById(S.layout);
  const multi = panes.length > 1;
  $('#panes').classList.toggle('multi', multi && !maximized);
  panes.forEach((p, i) => {
    let [x, y, w, h] = L.r[i];
    const hide = maximized && maximized !== p;
    if (maximized === p) [x, y, w, h] = [0, 0, 1, 1];
    const g = multi && !maximized ? 1 : 0; // 1px each side -> 2px separator
    Object.assign(p.root.style, {
      display: hide ? 'none' : '',
      left: `calc(${x * 100}% + ${x > 0 ? g : 0}px)`, top: `calc(${y * 100}% + ${y > 0 ? g : 0}px)`,
      width: `calc(${w * 100}% - ${(x > 0 ? g : 0) + (x + w < 0.999 ? g : 0)}px)`,
      height: `calc(${h * 100}% - ${(y > 0 ? g : 0) + (y + h < 0.999 ? g : 0)}px)`,
    });
  });
}
function toggleMaximize() {
  if (panes.length < 2 || !active) return;
  maximized = maximized === active ? null : active;
  positionPanes();
  panes.forEach((p) => p.renderLegend());
}
function setActive(p, force = false) {
  if (!p || (p === active && !force)) return;
  const old = active;
  active = p;
  if (old && old !== p) { old.drawings.setTool(null); old.root.classList.remove('active'); }
  p.root.classList.add('active');
  S.active = panes.indexOf(p); save();
  p.drawings.setTool(currentTool);
  paintTools(currentTool);
  renderTopbar(); renderWatchlist();
}

// ---- sync between charts ----
function syncCrosshair(src, p) {
  if (syncing || !S.sync.crosshair || panes.length < 2 || !p.sourceEvent && p.point) return;
  syncing = true;
  try {
    for (const o of panes) {
      if (o === src || !o.mainSeries) continue;
      const b = p.time != null && p.point ? o.barContaining(p.time) : null;
      if (b) { o.chart.setCrosshairPosition(b.close, b.time, o.mainSeries); o.updateLegendMain(b.time); }
      else { o.chart.clearCrosshairPosition(); o.updateLegendMain(null); }
    }
  } finally { syncing = false; }
}
function syncTimeRange(src) {
  if (syncing || !S.sync.time || src !== active || panes.length < 2) return;
  const r = src.chart.timeScale().getVisibleRange(); if (!r) return;
  syncing = true;
  try { for (const o of panes) if (o !== src && o.bars.length) { try { o.chart.timeScale().setVisibleRange(r); } catch {} } }
  finally { syncing = false; }
}

// ===================== indicators dialog =====================
let indCat = 'All';
function openIndicators() {
  openModal('#indModal');
  $('#indSearch').value = ''; $('#indSearch').focus();
  renderIndCats(); renderIndRows();
}
function renderIndCats() {
  const nav = $('#indCats'); nav.innerHTML = '';
  const cat = (name, icon) => el('div', { class: 'cat' + (indCat === name ? ' on' : ''), onclick: () => { indCat = name; renderIndCats(); renderIndRows(); } }, `<span class="ic small">${ICONS[icon]}</span>${name}`);
  nav.append(el('div', { class: 'cat-h' }, 'Personal'), cat('Favorites', 'star'));
  nav.append(el('div', { class: 'cat-h' }, 'Built-in'), cat('All', 'list'), cat('Technicals', 'line'), cat('Volume & profile', 'vprange'));
}
function renderIndRows() {
  const q = $('#indSearch').value.trim().toLowerCase();
  const rows = $('#indRows'); rows.innerHTML = '';
  Object.entries(INDICATORS)
    .filter(([id, d]) => (indCat === 'All' || (indCat === 'Favorites' ? S.favorites.includes(id) : d.cat === indCat)))
    .filter(([id, d]) => !q || `${d.name} ${d.short || ''} ${d.desc || ''} ${id}`.toLowerCase().includes(q))
    .forEach(([id, d]) => {
      const fav = S.favorites.includes(id);
      const r = el('div', { class: 'ind-row' }, `<span class="star ${fav ? 'on' : ''}"><span class="ic small">${ICONS.star}</span></span><span>${d.name}<span class="desc">${d.desc || ''}</span></span><span class="cat-l">${d.cat}</span>`);
      r.querySelector('.star').addEventListener('click', (e) => { e.stopPropagation(); S.favorites = fav ? S.favorites.filter((x) => x !== id) : [...S.favorites, id]; save(); renderIndRows(); });
      r.addEventListener('click', () => {
        if (id === 'avwap') { closeModals(); setTool('avwap'); toast('Click a bar to anchor the VWAP', 2500); return; }
        if (id === 'frvp') { closeModals(); setTool('frvp'); toast('Drag across the time range for the profile', 2500); return; }
        active.addIndicator(id);
      });
      rows.append(r);
    });
  if (!rows.children.length) rows.append(el('div', { class: 'muted', style: 'padding:12px' }, 'No matches'));
}
$('#indSearch').addEventListener('input', renderIndRows);

let paramInst = null, paramPane = null;
function openParams(inst, pane) {
  paramInst = inst; paramPane = pane; const def = INDICATORS[inst.type]; const p = { ...defaults(inst.type), ...inst.params };
  $('#paramTitle').textContent = def.name;
  const f = $('#paramForm'); f.innerHTML = '';
  for (const pr of def.params) {
    const v = p[pr.key]; let input;
    if (pr.type === 'bool') { const l = el('label', { class: 'row' }); input = el('input', { type: 'checkbox', name: pr.key }); input.checked = !!v; l.append(input, pr.label); f.append(l); continue; }
    if (pr.type === 'select') { input = el('select', { name: pr.key }); pr.options.forEach((o) => input.append(el('option', { value: o }, o))); input.value = v; }
    else if (pr.type === 'color') input = el('input', { type: 'color', name: pr.key, value: v });
    else if (pr.type === 'time') { input = el('input', { type: 'datetime-local', name: pr.key }); if (v) input.value = toLocalInput(v); }
    else input = el('input', { type: pr.type === 'text' ? 'text' : 'number', name: pr.key, value: v, step: pr.type === 'float' ? 'any' : '1' });
    const l = el('label', {}, pr.label); l.append(input); f.append(l);
  }
  openModal('#paramModal');
}
function readParams() {
  const def = INDICATORS[paramInst.type]; const out = {};
  for (const pr of def.params) {
    const i = $(`#paramForm [name="${pr.key}"]`); if (!i) continue;
    out[pr.key] = pr.type === 'bool' ? i.checked : pr.type === 'int' ? Math.max(pr.min ?? -1e9, parseInt(i.value, 10) || pr.def) : pr.type === 'float' ? parseFloat(i.value) || pr.def : pr.type === 'time' ? (i.value ? Math.floor(new Date(i.value).getTime() / 1000) : 0) : i.value;
  }
  return out;
}
// Settings that can be shared between copies of an indicator: everything except anchors / time ranges,
// which belong to one particular chart.
function shareable(type, params) {
  const out = {};
  for (const pr of INDICATORS[type].params) if (pr.type !== 'time' && !['anchor', 'from', 'to'].includes(pr.key) && pr.key in params) out[pr.key] = params[pr.key];
  return out;
}
// "Apply to all charts": copy the style/settings to every copy of this indicator on every chart
// (including charts not in the current layout, and per-symbol ones like anchored VWAP).
function applyToAll(type, params) {
  const shared = shareable(type, params);
  const lists = [...S.panes.map((c) => c.indicators), ...Object.values(S.perSymbol).map((x) => x.indicators || [])];
  for (const list of lists) for (const inst of list) if (inst.type === type) inst.params = { ...inst.params, ...shared };
  save();
  for (const p of panes) if (p.activeIndicators().some((i) => i.type === type)) p.rebuildAll();
}
function finishParams(mode) {
  const out = readParams(); const type = paramInst.type;
  paramInst.params = out;
  if (mode === 'default') { S.indicatorDefaults[type] = shareable(type, out); }
  save(); closeModals();
  if (mode === 'all') { applyToAll(type, out); toast(`Applied to every ${INDICATORS[type].name} on all charts`, 2500); return; }
  if (mode === 'default') toast(`Saved as the default for new ${INDICATORS[type].name}`, 2500);
  if (paramPane && panes.includes(paramPane)) paramPane.rebuildFor(paramInst);
}
$('#paramDDBtn').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); $('#paramDD').classList.toggle('open'); });
$('#paramDD').addEventListener('click', () => $('#paramDD').classList.remove('open'));
$('#paramAll').addEventListener('click', (e) => { e.preventDefault(); finishParams('all'); });
$('#paramDef').addEventListener('click', (e) => { e.preventDefault(); finishParams('default'); });
$('#paramReset').addEventListener('click', (e) => {
  e.preventDefault();
  // put the dialog back to the saved defaults (does not apply until OK)
  const keep = paramInst.params; paramInst.params = { ...keep, ...defaults(paramInst.type), ...(S.indicatorDefaults[paramInst.type] || {}), ...Object.fromEntries(Object.entries(keep).filter(([k]) => !(k in shareable(paramInst.type, keep)))) };
  const pane = paramPane; const inst = paramInst; openParams(inst, pane); inst.params = keep;
});
$('#paramOk').addEventListener('click', (e) => {
  e.preventDefault(); finishParams('one');
});
function toLocalInput(sec) { const d = new Date(sec * 1000); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; }

// ===================== left toolbar =====================
const toolbar = $('#toolbar');
function tbBtn(id, icon, title, onclick) { const b = el('button', { class: 'tb-btn', title, 'data-tool': id, onclick }, `<span class="ic">${ICONS[icon]}</span>`); toolbar.append(b); return b; }
tbBtn('cursor', 'cursor', 'Cursor (Esc)', () => setTool(null));
toolbar.append(el('div', { class: 'tsep' }));
for (const t of DRAW_TOOLS) tbBtn(t.id, t.icon, t.title, () => setTool(currentTool === t.id ? null : t.id));
toolbar.append(el('div', { class: 'tsep' }));
for (const t of SPECIAL_TOOLS) tbBtn(t.id, t.icon, t.title, () => setTool(currentTool === t.id ? null : t.id));
toolbar.append(el('div', { class: 'tsep' }));
const setFlag = (k, v) => { drawFlags[k] = v; for (const p of panes) { p.drawings[k] = v; p.drawings.select(null); p.drawings.redraw(); } };
const magBtn = tbBtn('magnet', 'magnet', 'Magnet: snap drawings to open/high/low/close', () => { setFlag('magnet', !drawFlags.magnet); magBtn.classList.toggle('on', drawFlags.magnet); });
const lockBtn = tbBtn('lock', 'lock', 'Lock all drawings', () => { setFlag('locked', !drawFlags.locked); lockBtn.classList.toggle('on', drawFlags.locked); });
const hideBtn = tbBtn('hide', 'eye', 'Hide all drawings', () => { setFlag('hidden', !drawFlags.hidden); hideBtn.classList.toggle('on', drawFlags.hidden); hideBtn.innerHTML = `<span class="ic">${drawFlags.hidden ? ICONS.eyeoff : ICONS.eye}</span>`; });
tbBtn('trash', 'trash', 'Remove all drawings on this chart', () => { const d = active.drawings; if (d.list.length && confirm(`Remove all ${d.list.length} drawings on this ${active.info.symbol} chart? (Lines set to "All charts" are removed from every chart.)`)) d.clear(); });
function setTool(t) { currentTool = t; active?.drawings.setTool(t); paintTools(t); }
function paintTools(t) {
  $$('#toolbar [data-tool]').forEach((b) => { if (!['magnet', 'lock', 'hide', 'trash'].includes(b.dataset.tool)) b.classList.toggle('on', (b.dataset.tool === 'cursor' && !t) || b.dataset.tool === t); });
}

// ===================== saved layouts =====================
// Everything is still auto-saved for next time; named layouts let you keep several setups and switch between them.
const snapshot = () => clone({ layout: S.layout, panes: S.panes, sync: S.sync, active: S.active });
const isDirty = () => !S.layoutName || !S.layouts[S.layoutName] || JSON.stringify(snapshot()) !== JSON.stringify(S.layouts[S.layoutName]);
function askName(title, def) {
  const n = (prompt(title, def || '') || '').trim();
  if (!n) return null;
  if (n !== def && S.layouts[n] && !confirm(`A layout called "${n}" already exists. Replace it?`)) return null;
  return n;
}
function saveLayout() {
  if (!S.layoutName) return saveLayoutAs();
  S.layouts[S.layoutName] = snapshot(); save(); renderSavedBtn(); toast(`Layout "${S.layoutName}" saved`, 1500);
}
function saveLayoutAs() {
  const n = askName('Save layout as', S.layoutName ? `${S.layoutName} copy` : 'My layout'); if (!n) return;
  if (S.layoutName && n !== S.layoutName) {
    // a copy gets its own charts, so drawings kept on one chart are copied rather than shared with the original
    for (const c of S.panes) {
      const oldId = c.id; c.id = uid();
      for (const ss of Object.values(S.perSymbol)) for (const d of [...(ss.drawings || [])]) if (d.pane === oldId) ss.drawings.push({ ...clone(d), id: uid(), pane: c.id });
    }
    reloadPanes();
  }
  S.layoutName = n; saveLayout();
}
function renameLayout() {
  if (!S.layoutName) return saveLayoutAs();
  const n = askName('Rename layout', S.layoutName); if (!n || n === S.layoutName) return;
  S.layouts[n] = S.layouts[S.layoutName]; delete S.layouts[S.layoutName]; S.layoutName = n; save(); renderSavedBtn();
}
function loadLayout(name) {
  const L = S.layouts[name]; if (!L || name === S.layoutName && !isDirty()) return;
  if (S.layoutName && isDirty() && !confirm(`Discard the unsaved changes to "${S.layoutName}"?`)) return;
  Object.assign(S, clone(L)); S.layoutName = name; save();
  reloadPanes(); renderSavedBtn(); toast(`Layout "${name}" loaded`, 1500);
}
function deleteLayout(name) {
  if (!confirm(`Delete the saved layout "${name}"? Your charts stay as they are.`)) return;
  delete S.layouts[name]; if (S.layoutName === name) S.layoutName = null; save(); renderSavedBtn(); renderSavedMenu();
}
function reloadPanes() {
  // rebuild every chart from S.panes (after loading a layout)
  while (panes.length) panes.pop().destroy();
  active = null; maximized = null;
  applyLayout(S.layout);
}
renderSavedBtn = function () {
  const b = $('#savedName'); if (!b) return;
  b.textContent = S.layoutName || 'Unsaved layout';
  $('#savedBtn').classList.toggle('dirty', isDirty());
  $('#savedBtn').title = S.layoutName ? (isDirty() ? `"${S.layoutName}" has unsaved changes (Ctrl+S to save)` : `Layout "${S.layoutName}" (saved)`) : 'Save this layout (Ctrl+S)';
}
function renderSavedMenu() {
  const m = $('#savedMenu'); m.innerHTML = '';
  const item = (label, key, fn) => { const b = el('button', { class: 'dd-item' }, `<span>${label}</span>${key ? `<span class="kbd">${key}</span>` : ''}`); b.addEventListener('click', () => { $('#savedDD').classList.remove('open'); fn(); }); m.append(b); };
  item('Save layout', 'Ctrl+S', saveLayout);
  item('Save as new layout…', '', saveLayoutAs);
  if (S.layoutName) item('Rename…', '', renameLayout);
  const names = Object.keys(S.layouts).sort((a, b) => a.localeCompare(b));
  m.append(el('div', { class: 'dd-h' }, names.length ? 'Saved layouts' : 'No saved layouts yet'));
  for (const n of names) {
    const L = S.layouts[n]; const cnt = layoutById(L.layout).r.length;
    const row = el('div', { class: 'saved-row' + (n === S.layoutName ? ' on' : ''), title: `Open "${n}"` },
      `<span class="lay-mini">${layoutIcon(layoutById(L.layout))}</span><span class="nm"></span><span class="meta">${cnt} chart${cnt > 1 ? 's' : ''}</span><button class="del" title="Delete">×</button>`);
    row.querySelector('.nm').textContent = n;
    row.addEventListener('click', (e) => { if (e.target.closest('.del')) { e.stopPropagation(); deleteLayout(n); return; } $('#savedDD').classList.remove('open'); loadLayout(n); });
    m.append(row);
  }
}
$('#savedBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#layoutDD').classList.remove('open'); $('#chartTypeDD').classList.remove('open'); renderSavedMenu(); $('#savedDD').classList.toggle('open'); });
$('#savedMenu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#savedDD').classList.remove('open'));

// ===================== price alerts =====================
// Checked in this window while the app is open: each new price for a symbol is compared with the previous one,
// and an alert fires when the price crosses its level.
const ALERT_COLOR = '#ff9800';
const ALERT_COND = { cross: 'Crossing', up: 'Crossing up', down: 'Crossing down' };
const lastPx = new Map();
let alertTab = 'alerts', unseenAlerts = 0, editingAlert = null, alertInit = null;
const alertSymbols = () => [...new Set(S.alerts.filter((a) => a.active).map((a) => a.symbol))];
function roundPrice(p, sym) { const ref = quotes.get(sym)?.last ?? p; return +p.toFixed(decimalsFor(ref)); }
// the live price: for stocks and ETFs outside regular hours, the pre-market / after-hours price
function alertPrice(q) {
  if (!q) return NaN;
  if (feed?.mode !== 'demo' && symbolKind(q.symbol) === 'equity' && extSession() && isFinite(q.ethLast)) return q.ethLast;
  return isFinite(q.last) ? q.last : NaN;
}
function currentPrice(sym) {
  const p = alertPrice(quotes.get(sym)); if (isFinite(p)) return p;
  const pane = panes.find((x) => x.info.symbol === sym); return pane?.bars.at(-1)?.close;
}
function checkAlerts(sym, p) {
  if (!isFinite(p)) return;
  const prev = lastPx.get(sym); lastPx.set(sym, p);
  if (prev === undefined || prev === p) return;
  const now = Date.now(); let fired = false;
  for (const a of S.alerts) {
    if (!a.active || a.symbol !== sym) continue;
    const up = prev < a.price && p >= a.price, down = prev > a.price && p <= a.price;
    if (!(a.cond === 'up' ? up : a.cond === 'down' ? down : up || down)) continue;
    if (a.mode === 'every' && a.lastFired && now - a.lastFired < 60000) continue;
    a.lastFired = now; fired = true;
    if (a.mode !== 'every') a.active = false;
    fireAlert(a, p, up ? 'up' : 'down');
  }
  if (fired) { save(); alertsChanged(); }
}
function fireAlert(a, px, dir) {
  const text = `${a.symbol} crossed ${dir} through ${fmtPrice(a.price)}`;
  const entry = { id: uid(), alertId: a.id, symbol: a.symbol, text, note: a.note || '', price: px, at: Date.now() };
  S.alertLog.unshift(entry); if (S.alertLog.length > 200) S.alertLog.length = 200;
  unseenAlerts++;
  playAlertSound();
  showAlertPop(entry);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`Alert: ${a.symbol}`, { body: `${text} (last ${fmtPrice(px)})${a.note ? `\n${a.note}` : ''}`, tag: entry.id, requireInteraction: true });
      n.onclick = () => { window.focus(); active?.loadSymbol(a.symbol); n.close(); };
    }
  } catch (e) { console.warn('notification', e); }
}
// sound: a short chime made with Web Audio (browsers allow sound only after the first click or key press)
let audioCtx = null;
function unlockAudio() { try { audioCtx ||= new AudioContext(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {} }
window.addEventListener('pointerdown', unlockAudio, { capture: true }); window.addEventListener('keydown', unlockAudio, { capture: true });
function playAlertSound() {
  if (!S.alertSound) return;
  unlockAudio(); const c = audioCtx; if (!c) return;
  const t0 = c.currentTime + 0.02;
  for (let k = 0; k < 2; k++) [880, 1175, 1568].forEach((f, i) => {
    const t = t0 + k * 0.6 + i * 0.13, o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.32);
  });
}
const fmtWhen = (ms) => { const p = parts(ms / 1000, S.tz); return `${p.month}/${p.day} ${p.hour}:${p.minute}`; };
function showAlertPop(entry) {
  const box = $('#alertPops');
  const pop = el('div', { class: 'al-pop' }, `<div class="t"><span class="ic">${ICONS.bell}</span><span></span></div>${entry.note ? '<div class="n"></div>' : ''}
    <div class="m"><span>${fmtWhen(entry.at)} · last ${fmtPrice(entry.price)}</span><span><button class="go">Open chart</button><button class="x" title="Dismiss">×</button></span></div>`);
  pop.querySelector('.t span:last-child').textContent = entry.text;
  if (entry.note) pop.querySelector('.n').textContent = entry.note;
  pop.querySelector('.go').addEventListener('click', () => { active?.loadSymbol(entry.symbol); pop.remove(); });
  pop.querySelector('.x').addEventListener('click', () => pop.remove());
  box.prepend(pop);
  while (box.children.length > 5) box.lastChild.remove();
}
function askNotifyPermission() { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {} }
function alertsChanged() {
  for (const p of panes) p.renderAlertLines();
  for (const p of panes) { const d = p.drawings.selected?.(); if (d) p.renderDrawBar(d); }
  renderAlertsBtn();
  if ($('#alertsDD').classList.contains('open')) renderAlertsMenu();
  const syms = alertSymbols().join(','); if (syms !== alertsChanged.syms) { alertsChanged.syms = syms; refreshQuoteSubs(); }
}
function renderAlertsBtn() {
  const n = S.alerts.filter((a) => a.active).length, b = $('#alertsBadge');
  b.textContent = unseenAlerts ? String(unseenAlerts) : String(n);
  b.classList.toggle('hidden', !n && !unseenAlerts);
  $('#alertsBtn').classList.toggle('unseen', unseenAlerts > 0);
}
function syncLineAlerts(sym, list) {
  let changed = false;
  for (const d of list) {
    if (d.type !== 'hline' && d.type !== 'hray') continue;
    for (const a of S.alerts) if (a.drawingId === d.id && a.symbol === sym) { const p = roundPrice(d.pts[0].p, sym); if (a.price !== p) { a.price = p; changed = true; } }
  }
  if (changed) { save(); alertsChanged(); }
}
function deleteAlert(a) { S.alerts = S.alerts.filter((x) => x !== a); save(); alertsChanged(); }
function openAlertDialog(init = {}, existing = null) {
  editingAlert = existing; alertInit = init;
  const sym = existing?.symbol || init.symbol || active.info.symbol;
  const price = existing?.price ?? init.price ?? currentPrice(sym);
  $('#alertTitle').textContent = existing ? `Edit alert · ${sym}` : `Create alert · ${sym}`;
  $('#alertOk').textContent = existing ? 'Save' : 'Create';
  $('#alSym').value = sym;
  $('#alCond').value = existing?.cond || 'cross';
  $('#alPrice').value = isFinite(price) ? roundPrice(price, sym) : '';
  $('#alMode').value = existing?.mode || 'once';
  $('#alNote').value = existing?.note || '';
  const last = currentPrice(sym); $('#alLast').textContent = isFinite(last) ? `Last price ${fmtPrice(last)}` : '';
  openModal('#alertModal');
  setTimeout(() => { $('#alPrice').focus(); $('#alPrice').select(); }, 0);
}
function submitAlert() {
  const symbol = $('#alSym').value.trim().toUpperCase(), price = Number($('#alPrice').value);
  if (!symbol) { $('#alSym').focus(); return; }
  if (!isFinite(price) || price <= 0 || $('#alPrice').value === '') { $('#alPrice').focus(); return; }
  const fields = { symbol, price, cond: $('#alCond').value, mode: $('#alMode').value, note: $('#alNote').value.trim() };
  if (editingAlert) {
    if (editingAlert.symbol !== symbol || editingAlert.price !== price) delete editingAlert.drawingId;
    Object.assign(editingAlert, fields, { active: true, lastFired: null });
  } else {
    const a = { id: uid(), ...fields, active: true, created: Date.now() };
    if (alertInit?.drawingId && alertInit.symbol === symbol) a.drawingId = alertInit.drawingId;
    S.alerts.push(a);
  }
  askNotifyPermission(); unlockAudio();
  save(); alertsChanged(); closeModals();
  toast(`Alert ${editingAlert ? 'saved' : 'set'}: ${symbol} ${ALERT_COND[fields.cond].toLowerCase()} ${fmtPrice(price)}`, 2000);
  editingAlert = null;
}
$('#alertOk').addEventListener('click', submitAlert);
$('#alertForm').addEventListener('submit', (e) => { e.preventDefault(); submitAlert(); });
function renderAlertsMenu() {
  const m = $('#alertsMenu'); m.innerHTML = '';
  const tabs = el('div', { class: 'al-tabs' });
  const tab = (id, label) => { const b = el('button', { class: 'al-tab' + (alertTab === id ? ' on' : '') }, label); b.addEventListener('click', () => { alertTab = id; renderAlertsMenu(); }); tabs.append(b); };
  tab('alerts', `Alerts${S.alerts.length ? ` (${S.alerts.length})` : ''}`); tab('log', `Log${S.alertLog.length ? ` (${S.alertLog.length})` : ''}`);
  tabs.append(el('span', { class: 'spacer' }));
  const snd = el('label', { class: 'al-snd', title: 'Play a sound when an alert fires' }); const cb = el('input', { type: 'checkbox' }); cb.checked = S.alertSound;
  cb.addEventListener('change', () => { S.alertSound = cb.checked; save(); if (cb.checked) playAlertSound(); }); snd.append(cb, el('span', {}, 'Sound'));
  tabs.append(snd);
  const add = el('button', { class: 'tb-btn small', title: 'Create an alert for the active chart (Alt+A)' }, '+ Create');
  add.addEventListener('click', () => { $('#alertsDD').classList.remove('open'); openAlertDialog({ symbol: active.info.symbol }); });
  tabs.append(add); m.append(tabs);
  if (alertTab === 'log') {
    unseenAlerts = 0; renderAlertsBtn();
    if (!S.alertLog.length) { m.append(el('div', { class: 'al-empty' }, 'No alerts have fired yet.')); return; }
    for (const x of S.alertLog) {
      const r = el('div', { class: 'al-row log', title: `Open ${x.symbol}` }, `<span class="sym"></span><span class="desc"></span><span class="st">${fmtWhen(x.at)}</span>${x.note ? '<span class="al-note"></span>' : ''}`);
      r.querySelector('.sym').textContent = x.symbol; r.querySelector('.desc').textContent = x.text.replace(`${x.symbol} `, '');
      if (x.note) r.querySelector('.al-note').textContent = x.note;
      r.addEventListener('click', () => { $('#alertsDD').classList.remove('open'); active.loadSymbol(x.symbol); });
      m.append(r);
    }
    const clr = el('button', { class: 'dd-item' }, 'Clear log'); clr.addEventListener('click', () => { S.alertLog = []; save(); renderAlertsMenu(); }); m.append(clr);
    return;
  }
  if (!S.alerts.length) { m.append(el('div', { class: 'al-empty' }, 'No alerts yet. Right-click a chart, press Alt+A, or click + Create.')); return; }
  const list = [...S.alerts].sort((a, b) => (b.active - a.active) || a.symbol.localeCompare(b.symbol) || a.price - b.price);
  for (const a of list) {
    const st = a.active ? 'Active' : a.lastFired ? 'Triggered' : 'Stopped';
    const r = el('div', { class: 'al-row' + (a.active ? '' : ' off'), title: `Open ${a.symbol}` },
      `<span class="sym"></span><span class="desc">${ALERT_COND[a.cond] || 'Crossing'} ${fmtPrice(a.price)}${a.mode === 'every' ? ' · every time' : ''}</span><span class="st${a.active ? ' on' : ''}">${st}</span>
      <span class="al-acts"><button class="tog" title="${a.active ? 'Stop' : 'Restart'}">${a.active ? '⏸' : '▶'}</button><button class="ed" title="Edit">✎</button><button class="del" title="Delete">×</button></span>${a.note ? '<span class="al-note"></span>' : ''}`);
    r.querySelector('.sym').textContent = a.symbol;
    if (a.note) r.querySelector('.al-note').textContent = a.note;
    r.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b?.classList.contains('tog')) { a.active = !a.active; if (a.active) a.lastFired = null; save(); alertsChanged(); return; }
      if (b?.classList.contains('ed')) { $('#alertsDD').classList.remove('open'); openAlertDialog({}, a); return; }
      if (b?.classList.contains('del')) { deleteAlert(a); return; }
      $('#alertsDD').classList.remove('open'); if (active.info.symbol !== a.symbol) active.loadSymbol(a.symbol);
    });
    m.append(r);
  }
}
$('#alertsBtn').addEventListener('click', (e) => { e.stopPropagation(); for (const id of ['#savedDD', '#layoutDD', '#chartTypeDD']) $(id)?.classList.remove('open'); if (unseenAlerts) alertTab = 'log'; renderAlertsMenu(); $('#alertsDD').classList.toggle('open'); });
$('#alertsMenu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#alertsDD').classList.remove('open'));
// right-click menu on a chart
function showCtxMenu(x, y, items) {
  const m = $('#ctxMenu'); m.innerHTML = '';
  for (const [label, fn] of items) { const b = el('button', { class: 'dd-item' }, label); b.addEventListener('click', () => { hideCtxMenu(); fn(); }); m.append(b); }
  m.style.display = 'block';
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.min(x, innerWidth - w - 4)}px`; m.style.top = `${Math.min(y, innerHeight - h - 4)}px`;
}
function hideCtxMenu() { $('#ctxMenu').style.display = 'none'; }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#ctxMenu')) hideCtxMenu(); }, { capture: true });
window.addEventListener('blur', hideCtxMenu);

// ===================== top bar =====================
function renderTopbar() {
  if (!active) return;
  $('#symbolText').textContent = active.info.symbol;
  document.title = `${active.info.symbol} · Charts`;
  renderTf(); renderChartType();
}
function renderTf() {
  const g = $('#tfGroup'); g.innerHTML = '';
  for (const t of TIMEFRAMES) g.append(el('button', { class: 'tb-btn' + (t.id === active?.tf.id ? ' on' : ''), onclick: () => active.setTimeframe(t.id) }, t.id));
}
const CHART_TYPES = [['candles', 'Candles', 'candles'], ['ha', 'Heikin Ashi', 'ha'], ['bars', 'Bars', 'bars'], ['line', 'Line', 'line'], ['area', 'Area', 'area']];
function renderChartType() {
  const curId = active?.cfg.chartType || 'candles';
  const cur = CHART_TYPES.find((c) => c[0] === curId) || CHART_TYPES[0];
  $('#chartTypeBtn').innerHTML = `<span class="ic">${ICONS[cur[2]]}</span>`;
  const m = $('#chartTypeMenu'); m.innerHTML = '';
  for (const [id, name, icon] of CHART_TYPES) m.append(el('button', { class: 'dd-item' + (id === curId ? ' on' : ''), onclick: () => { $('#chartTypeDD').classList.remove('open'); active.setChartType(id); renderChartType(); } }, `<span class="ic">${ICONS[icon]}</span>${name}`));
}
const SYNC_OPTS = [['symbol', 'Symbol', 'Changing the symbol on one chart changes it on all'], ['interval', 'Interval', 'Changing the timeframe on one chart changes it on all'],
  ['crosshair', 'Crosshair', 'Show the crosshair at the same time on every chart'], ['time', 'Date range', 'Scrolling or zooming one chart moves the others to the same dates']];
function renderLayoutMenu() {
  $('#layoutBtn').innerHTML = layoutIcon(layoutById(S.layout));
  const m = $('#layoutMenu'); m.innerHTML = '';
  m.append(el('div', { class: 'dd-h' }, 'Layout'));
  const g = el('div', { class: 'lay-grid' });
  for (const L of LAYOUTS) g.append(el('button', { class: 'lay-btn' + (L.id === S.layout ? ' on' : ''), title: L.name, onclick: () => { applyLayout(L.id); } }, layoutIcon(L)));
  m.append(g);
  m.append(el('div', { class: 'dd-h' }, 'Sync in layout'));
  for (const [k, name, tip] of SYNC_OPTS) {
    const row = el('label', { class: 'dd-check', title: tip });
    const cb = el('input', { type: 'checkbox' }); cb.checked = !!S.sync[k];
    cb.addEventListener('change', () => {
      S.sync[k] = cb.checked; save();
      if (!cb.checked) return;
      // apply right away from the active chart
      if (k === 'symbol') for (const p of panes) if (p !== active && p.cfg.symbol !== active.info.symbol) p.loadSymbol(active.info.symbol, true);
      if (k === 'interval') for (const p of panes) if (p !== active && p.cfg.tf !== active.tf.id) p.setTimeframe(active.tf.id, true);
      if (k === 'time') syncTimeRange(active);
    });
    row.append(cb, el('span', {}, name)); m.append(row);
  }
}
$('#layoutBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#chartTypeDD').classList.remove('open'); $('#layoutDD').classList.toggle('open'); });
$('#layoutMenu').addEventListener('click', (e) => e.stopPropagation());
$('#chartTypeBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#layoutDD').classList.remove('open'); $('#chartTypeDD').classList.toggle('open'); });
document.addEventListener('click', () => { $('#chartTypeDD').classList.remove('open'); $('#layoutDD').classList.remove('open'); });
$('#indicatorsBtn').addEventListener('click', openIndicators);
$('#undoBtn').addEventListener('click', () => active.drawings.undo());
$('#redoBtn').addEventListener('click', () => active.drawings.redo());
$('#fitBtn').addEventListener('click', () => active.resetView());
// Chart image = the chart canvas plus the HTML legend (symbol, OHLC, indicator names/values) painted on top,
// so the saved file looks like what is on screen.
function chartImage(pane) {
  const shot = pane.chart.takeScreenshot();
  const hostR = pane.host.getBoundingClientRect();
  const k = shot.width / hostR.width; // device pixels per CSS pixel in the screenshot
  const out = document.createElement('canvas'); out.width = shot.width; out.height = shot.height;
  const ctx = out.getContext('2d'); ctx.drawImage(shot, 0, 0); ctx.scale(k, k);
  const visible = (n) => { for (let e = n; e && e !== pane.root; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };
  const skip = '.acts, .l-max, .l-toggle, .floating, button';
  const roots = [pane.legendEl, ...$$('.pane-legend', pane.root)];
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const txt = t.nodeValue; if (!txt.trim()) continue;
      const elp = t.parentElement; if (!elp || elp.closest(skip) || !visible(elp)) continue;
      const range = document.createRange(); range.selectNodeContents(t);
      const r = range.getBoundingClientRect(); if (!r.width) continue;
      const cs = getComputedStyle(elp);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.textBaseline = 'alphabetic';
      const x = r.left - hostR.left, y = r.top - hostR.top + r.height * 0.78;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(15,15,15,0.9)'; ctx.lineJoin = 'round';
      ctx.strokeText(txt, x, y);
      ctx.fillStyle = cs.color; ctx.fillText(txt, x, y);
    }
  }
  return out;
}
$('#shotBtn').addEventListener('click', () => {
  active.drawings.select(null); // hide the selection handles / colour bar
  const c = chartImage(active);
  c.toBlob((b) => { const a = el('a', { href: URL.createObjectURL(b), download: `${active.info.symbol.replace(/\W/g, '')}_${active.tf.id}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png` }); a.click(); });
});
$('#watchToggle').addEventListener('click', () => { S.showWatch = !S.showWatch; save(); $('#app').classList.toggle('no-watch', !S.showWatch); });
$('#app').classList.toggle('no-watch', !S.showWatch);

// ===================== symbol search =====================
let symMode = 'load';
function openSymbol(prefill = '', mode = 'load') {
  symMode = mode;
  $('#symTitle').textContent = mode === 'add' ? 'Add to watchlist' : panes.length > 1 ? `Symbol search · chart ${panes.indexOf(active) + 1}` : 'Symbol search';
  openModal('#symModal'); const i = $('#symInput'); i.value = prefill; i.focus(); renderSymRows();
}
let symT = null, symSel = -1;
async function renderSymRows() {
  const q = $('#symInput').value.trim().toUpperCase();
  const rows = $('#symRows'); symSel = -1;
  const local = [...new Set([...S.watchlist, ...Object.keys(S.perSymbol)])].filter((s) => !q || s.includes(q)).slice(0, 8).map((s) => ({ symbol: s, name: '', kind: 'recent' }));
  const draw = (list) => {
    rows.innerHTML = '';
    for (const r of list) rows.append(el('div', { class: 'sym-row', onclick: () => pickSymbol(r.symbol) }, `<b>${r.symbol}</b><span class="muted">${r.name || ''}</span><span class="k">${r.kind || ''}</span>`));
  };
  draw(local);
  clearTimeout(symT);
  if (q.length >= 1) symT = setTimeout(async () => {
    try { const res = await feed.search(q); if ($('#symInput').value.trim().toUpperCase() === q) draw([...local, ...res.filter((r) => !local.some((l) => l.symbol === r.symbol))]); } catch {}
  }, 250);
}
function pickSymbol(sym) {
  closeModals();
  if (symMode === 'add') { sym = sym.toUpperCase(); if (!S.watchlist.includes(sym)) { S.watchlist.push(sym); save(); refreshQuoteSubs(); renderWatchlist(); } }
  else active.loadSymbol(sym);
}
$('#symInput').addEventListener('input', renderSymRows);
$('#symInput').addEventListener('keydown', (e) => {
  const rs = $$('.sym-row');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); symSel = Math.max(0, Math.min(rs.length - 1, symSel + (e.key === 'ArrowDown' ? 1 : -1))); rs.forEach((r, i) => r.classList.toggle('sel', i === symSel)); }
  if (e.key === 'Enter') { const v = symSel >= 0 && rs[symSel] ? rs[symSel].querySelector('b').textContent : $('#symInput').value; if (v.trim()) pickSymbol(v.trim()); }
});
$('#symbolBtn').addEventListener('click', () => openSymbol());

// ===================== watchlist =====================
const resolved = new Map();
async function refreshQuoteSubs() {
  const infos = [];
  await Promise.all([...new Set([...S.watchlist, ...alertSymbols()])].map(async (s) => {
    try { if (!resolved.has(s)) resolved.set(s, await feed.resolve(s)); infos.push(resolved.get(s)); } catch (e) { console.warn('resolve', s, e.message); }
  }));
  feed.setQuoteSymbols(infos);
}
// ---- watchlist columns (the ⋮ menu) ----
const WL_COLS = [['last', 'Last', 'Last', '1fr'], ['chg', 'Change', 'Chg', '.8fr'], ['pct', 'Change %', 'Chg%', '.8fr'], ['vol', 'Volume', 'Vol', '.8fr'], ['ext', 'Extended hours', 'Ext', '.8fr']];
function wlTemplate() { return ['1.3fr', ...WL_COLS.filter((c) => S.wlCols[c[0]]).map((c) => c[3])].join(' '); }
function renderWlCols() {
  $('#watchlist').style.setProperty('--wl-cols', wlTemplate());
  $('#wlCols').innerHTML = `<span>Symbol</span>${WL_COLS.filter((c) => S.wlCols[c[0]]).map((c) => `<span>${c[2]}</span>`).join('')}`;
}
function renderWlMenu() {
  const m = $('#wlMenu'); m.innerHTML = '';
  m.append(el('div', { class: 'dd-h' }, 'Customize columns'));
  const opts = WL_COLS.map((c) => [c[0], c[1]]);
  for (const [k, name] of opts) {
    const row = el('label', { class: 'dd-check', title: k === 'ext' ? 'Pre-market / after-hours change % for stocks and ETFs, outside regular hours (hover a value for the price)' : '' });
    const cb = el('input', { type: 'checkbox' }); cb.checked = !!S.wlCols[k];
    cb.addEventListener('change', () => { S.wlCols[k] = cb.checked; save(); renderWatchlist(); });
    row.append(cb, el('span', {}, name)); m.append(row);
  }
}
$('#wlMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#wlListDD').classList.remove('open'); renderWlMenu(); $('#wlDD').classList.toggle('open'); });
$('#wlMenu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#wlDD').classList.remove('open'));
// ---- several watchlists (the list-name menu) ----
function wlAskName(title, def) {
  const n = (prompt(title, def || '') || '').trim(); if (!n) return null;
  if (n !== def && S.watchlists[n]) { alert(`There is already a watchlist called "${n}".`); return null; }
  return n;
}
function switchWatchlist(name) {
  if (!S.watchlists[name]) return;
  S.watchlists[S.wlName] = S.watchlist; S.wlName = name; S.watchlist = S.watchlists[name];
  save(); renderWatchlist(); refreshQuoteSubs();
}
function newWatchlist(copy) {
  const n = wlAskName(copy ? 'Copy of this watchlist, name' : 'New watchlist name', copy ? `${S.wlName} copy` : ''); if (!n) return;
  S.watchlists[S.wlName] = S.watchlist; S.watchlists[n] = copy ? [...S.watchlist] : []; switchWatchlist(n);
  if (!copy) openSymbol('', 'add');
}
function renameWatchlist() {
  const n = wlAskName('Rename watchlist', S.wlName); if (!n || n === S.wlName) return;
  const lists = {}; for (const [k, v] of Object.entries(S.watchlists)) lists[k === S.wlName ? n : k] = k === S.wlName ? S.watchlist : v;
  S.watchlists = lists; S.wlName = n; save(); renderWatchlist();
}
function deleteWatchlist(name) {
  const names = Object.keys(S.watchlists); if (names.length < 2) return;
  if (!confirm(`Delete the watchlist "${name}"?`)) return;
  delete S.watchlists[name];
  if (name === S.wlName) { S.wlName = Object.keys(S.watchlists)[0]; S.watchlist = S.watchlists[S.wlName]; refreshQuoteSubs(); }
  save(); renderWatchlist(); renderWlListMenu();
}
function renderWlListMenu() {
  const m = $('#wlListMenu'); m.innerHTML = '';
  const item = (label, fn) => { const b = el('button', { class: 'dd-item' }, label); b.addEventListener('click', () => { $('#wlListDD').classList.remove('open'); fn(); }); m.append(b); };
  item('Create new list…', () => newWatchlist(false));
  item('Make a copy…', () => newWatchlist(true));
  item('Rename…', renameWatchlist);
  m.append(el('div', { class: 'dd-h' }, 'Watchlists'));
  const many = Object.keys(S.watchlists).length > 1;
  for (const n of Object.keys(S.watchlists).sort((a, b) => a.localeCompare(b))) {
    const cnt = (n === S.wlName ? S.watchlist : S.watchlists[n]).length;
    const row = el('div', { class: 'saved-row' + (n === S.wlName ? ' on' : ''), title: `Show "${n}"` },
      `<span class="nm"></span><span class="meta">${cnt} symbol${cnt === 1 ? '' : 's'}</span>${many ? '<button class="del" title="Delete">×</button>' : ''}`);
    row.querySelector('.nm').textContent = n;
    row.addEventListener('click', (e) => { if (e.target.closest('.del')) { e.stopPropagation(); deleteWatchlist(n); return; } $('#wlListDD').classList.remove('open'); switchWatchlist(n); });
    m.append(row);
  }
}
$('#wlListBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#wlDD').classList.remove('open'); renderWlListMenu(); $('#wlListDD').classList.toggle('open'); });
$('#wlListMenu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => $('#wlListDD').classList.remove('open'));
// Regular session for US stocks: 9:30-16:00 New York, Mon-Fri. Outside it: "Pre" before the open, "Post" after.
function extSession() {
  const p = parts(Date.now() / 1000, 'America/New_York'); const m = +p.hour * 60 + +p.minute;
  const wkend = p.weekday === 'Sat' || p.weekday === 'Sun';
  if (!wkend && m >= 570 && m < 960) return null;
  return !wkend && m < 570 ? 'Pre' : 'Post';
}
function extData(sym, q) {
  if (!S.wlCols.ext || !q || symbolKind(sym) !== 'equity' || !isFinite(q.ethLast) || !isFinite(q.last)) return null;
  const lab = extSession(); if (!lab) return null;
  const ch = q.ethLast - q.last; return { lab, price: q.ethLast, ch, pc: ch / q.last * 100 };
}
function extLine(sym, q) {
  const x = extData(sym, q); if (!x) return '';
  const { lab, ch, pc } = x, cls = ch >= 0 ? 'up' : 'down';
  return `<span class="ext-lab ${lab.toLowerCase()}">${lab}</span><span>${fmtPrice(q.ethLast)}</span><span class="${cls}">${ch >= 0 ? '+' : ''}${fmtPrice(ch, decimalsFor(q.last))}</span><span class="${cls}">${pc >= 0 ? '+' : ''}${pc.toFixed(2)}%</span>`;
}
function renderWatchlist() {
  renderWlCols();
  $('#wlName').textContent = S.wlName;
  const box = $('#wlRows'); box.innerHTML = '';
  const shown = new Set(panes.map((p) => p.info.symbol));
  const cols = WL_COLS.filter((c) => S.wlCols[c[0]]).map((c) => `<span class="${c[0]}"></span>`).join('');
  for (const s of S.watchlist) {
    const r = el('div', { class: 'wl-row' + (s === active?.info.symbol ? ' cur' : shown.has(s) ? ' inlayout' : ''), 'data-sym': s, onclick: (e) => { if (!e.target.closest('.del')) active.loadSymbol(s); } },
      `<span>${s}</span>${cols}<button class="del" title="Remove">×</button>`);
    r.querySelector('.del').addEventListener('click', () => { S.watchlist = S.watchlist.filter((x) => x !== s); save(); renderWatchlist(); refreshQuoteSubs(); });
    box.append(r);
    paintQuote(s);
  }
  renderDetail();
}
function paintQuote(sym) {
  const q = quotes.get(sym); const r = $(`.wl-row[data-sym="${CSS.escape(sym)}"]`); if (!q || !r) return;
  const ch = q.prevClose ? q.last - q.prevClose : null; const pc = ch != null ? ch / q.prevClose * 100 : null;
  const cls = ch == null ? '' : ch >= 0 ? 'up' : 'down';
  const set = (k, txt, c = '') => { const x = r.querySelector('.' + k); if (x) { x.className = k + (c ? ' ' + c : ''); x.textContent = txt; } };
  set('last', fmtPrice(q.last));
  set('chg', ch == null ? '' : (ch >= 0 ? '+' : '') + fmtPrice(ch, decimalsFor(q.last)), cls);
  set('pct', pc == null ? '' : (pc >= 0 ? '+' : '') + pc.toFixed(2) + '%', cls);
  set('vol', q.volume ? fmtVol(q.volume) : '');
  const ex = extData(sym, q); const ec = r.querySelector('.ext');
  if (ec) { set('ext', ex ? `${ex.pc >= 0 ? '+' : ''}${ex.pc.toFixed(2)}%` : '', ex ? (ex.ch >= 0 ? 'up' : 'down') : ''); ec.title = ex ? `${ex.lab}-market ${fmtPrice(ex.price)} (${ex.ch >= 0 ? '+' : ''}${fmtPrice(ex.ch, decimalsFor(q.last))})` : ''; }
}
function renderDetail() {
  if (!active) return;
  const info = active.info, bars = active.bars;
  const d = $('#wlDetail'); const q = quotes.get(info.symbol) || {};
  const last = bars[bars.length - 1]?.close ?? q.last;
  const ch = q.prevClose && last != null ? last - q.prevClose : null;
  d.innerHTML = `<div style="color:#fff;font-weight:600">${info.symbol}</div><div>${info.name || ''}</div>
    <div class="big">${fmtPrice(last)} <span style="font-size:13px" class="${ch == null ? '' : ch >= 0 ? 'up' : 'down'}">${ch == null ? '' : `${ch >= 0 ? '+' : ''}${fmtPrice(ch, decimalsFor(last))} (${(ch / q.prevClose * 100).toFixed(2)}%)`}</span></div>
    ${extLine(info.symbol, q) ? `<div class="wl-ext on detail">${extLine(info.symbol, q)}</div>` : ''}
    ${q.bid ? `<div>Bid ${fmtPrice(q.bid)} · Ask ${fmtPrice(q.ask)}</div>` : ''}${q.high ? `<div>Day range ${fmtPrice(q.low)} – ${fmtPrice(q.high)}</div>` : ''}${q.volume ? `<div>Volume ${fmtVol(q.volume)}</div>` : ''}`;
}
$('#wlAdd').addEventListener('click', () => openSymbol('', 'add'));

// ===================== settings =====================
async function openSettings() {
  openModal('#setModal');
  $('#cfgMsg').textContent = '';
  const st = await fetch('/api/status').then((r) => r.json()).catch(() => ({}));
  $('#connInfo').textContent = st.forcedDemo ? 'Started with --demo: using demo data.' : st.mode === 'live' ? `Connected (data level: ${st.level || 'api'}).` : st.configured ? `Credentials saved but connection failed: ${st.error || 'unknown error'}` : 'Not connected. Using demo data.';
  $('#tzSelect').value = S.tz; $('#optRth').checked = S.rth; $('#optGrid').checked = S.grid; $('#optShade').checked = S.shadeEth; $('#optWatermark').checked = S.watermark;
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#tzSelect').innerHTML = TZ_CHOICES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
$('#tzSelect').addEventListener('change', (e) => setTz(e.target.value));
$('#optRth').addEventListener('change', (e) => setRth(e.target.checked));
$('#optShade').addEventListener('change', (e) => { S.shadeEth = e.target.checked; save(); for (const p of panes) p.ethShade?.requestUpdate?.(); });
$('#optWatermark').addEventListener('change', (e) => { S.watermark = e.target.checked; save(); for (const p of panes) p.updateWatermark(); });
$('#optGrid').addEventListener('change', (e) => { S.grid = e.target.checked; save(); for (const p of panes) p.chart.applyOptions({ grid: { vertLines: { visible: S.grid }, horzLines: { visible: S.grid } } }); });
$('#cfgSave').addEventListener('click', async () => {
  $('#cfgMsg').textContent = 'Connecting…';
  const body = { sandbox: $('#cfgSandbox').checked };
  if ($('#cfgSecret').value) body.clientSecret = $('#cfgSecret').value;
  if ($('#cfgRefresh').value) body.refreshToken = $('#cfgRefresh').value;
  const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  $('#cfgSecret').value = ''; $('#cfgRefresh').value = '';
  if (r.ok) { $('#cfgMsg').textContent = 'Connected. Reloading…'; setTimeout(() => location.reload(), 700); }
  else $('#cfgMsg').textContent = 'Failed: ' + (r.error || 'unknown error');
});
$('#cfgClear').addEventListener('click', async () => {
  if (!confirm('Remove the saved tastytrade credentials from config.json?')) return;
  await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clear: true }) });
  location.reload();
});
function setTz(v) {
  S.tz = v; save();
  for (const p of panes) { p.chart.applyOptions({}); p.chart.timeScale().applyOptions({ tickMarkFormatter: (t, type) => fmtTick(t, type, S.tz) }); p.renderLegend(); }
  renderStatus();
}
function setRth(v) { S.rth = v; save(); renderStatus(); for (const p of panes) p.subscribe(); }

// ===================== status bar =====================
function renderStatus() {
  $('#rthBtn').textContent = S.rth ? 'RTH' : 'ETH';
  $('#rthBtn').classList.toggle('on', S.rth);
  const tzName = TZ_CHOICES.find((t) => t[0] === S.tz)?.[1] || S.tz;
  $('#tzBtn').textContent = S.tz === 'local' ? 'Local' : tzName;
}
$('#rthBtn').addEventListener('click', () => setRth(!S.rth));
$('#tzBtn').addEventListener('click', () => { const i = TZ_CHOICES.findIndex((t) => t[0] === S.tz); setTz(TZ_CHOICES[(i + 1) % TZ_CHOICES.length][0]); });
setInterval(() => { const p = parts(Date.now() / 1000, S.tz); $('#clock').textContent = `${p.weekday} ${p.day}/${p.month} ${p.hour}:${p.minute}`; }, 1000);
function setConn(state, text) { $('#connDot').className = 'dot ' + (state === 'live' ? 'live' : state === 'demo' ? 'demo' : state === 'err' ? 'err' : ''); $('#connText').textContent = text; }

// ===================== modals, toasts, keys =====================
function openModal(sel) { closeModals(); $('#modalBack').classList.remove('hidden'); $(sel).classList.remove('hidden'); }
function closeModals() { $('#modalBack').classList.add('hidden'); $$('.modal').forEach((m) => m.classList.add('hidden')); }
$('#modalBack').addEventListener('click', closeModals);
$$('[data-close]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); closeModals(); }));
let toastT = null;
function toast(msg, ms = 0) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); if (ms) toastT = setTimeout(hideToast, ms); }
function hideToast() { $('#toast').classList.add('hidden'); }

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
  const modalOpen = !$('#modalBack').classList.contains('hidden');
  if (e.key === 'Escape') hideCtxMenu();
  if (e.key === 'Escape') { if (modalOpen) closeModals(); else { active.drawings.creating = null; setTool(null); active.drawings.select(null); } return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!modalOpen) saveLayout(); return; }
  if (typing || modalOpen || !active) return;
  const d = active.drawings;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? d.redo() : d.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); d.redo(); return; }
  if (e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); openAlertDialog({ symbol: active.info.symbol, price: active.hoverPrice != null ? roundPrice(active.hoverPrice, active.info.symbol) : undefined }); return; }
  if (e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); active.resetView(); return; }
  if (e.altKey && e.key === 'Enter') { e.preventDefault(); toggleMaximize(); return; }
  if (e.key === 'Tab' && panes.length > 1 && !e.ctrlKey && !e.altKey) { e.preventDefault(); const i = panes.indexOf(active); setActive(panes[(i + (e.shiftKey ? panes.length - 1 : 1)) % panes.length]); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && d.sel) { e.preventDefault(); d.removeSelected(); return; }
  if (e.key === '/') { e.preventDefault(); openIndicators(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) { e.preventDefault(); openSymbol(e.key.toUpperCase()); }
});

// ===================== boot =====================
async function boot() {
  hydrateIcons();
  renderStatus();
  let status = {};
  try { status = await fetch('/api/status').then((r) => r.json()); } catch {}
  if (status.mode === 'live') {
    feed = new TastyFeed(); feed.onStatus = setConn;
    try { await feed.init(); } catch (e) { console.error(e); feed = null; }
  }
  if (!feed) {
    feed = new DemoFeed(); feed.onStatus = setConn; await feed.init();
    if (status.configured && status.error) setConn('err', `tastytrade login failed, showing demo data: ${status.error}`);
  }
  feed.onQuote = (q) => { quotes.set(q.symbol, { ...(quotes.get(q.symbol) || {}), ...Object.fromEntries(Object.entries(q).filter(([, v]) => v != null && !Number.isNaN(v))) }); paintQuote(q.symbol); if (q.symbol === active?.info.symbol) renderDetail(); checkAlerts(q.symbol, alertPrice(quotes.get(q.symbol))); };
  applyLayout(S.layout);
  renderSavedBtn(); renderAlertsBtn(); alertsChanged.syms = alertSymbols().join(',');
  refreshQuoteSubs();
}
boot();
window.__charts = { chartImage, checkAlerts, openAlertDialog, get quotes() { return quotes; }, get panes() { return panes; }, get active() { return active; }, applyLayout, setActive, S, LAYOUTS };
