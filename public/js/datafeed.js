// Data feeds. Both expose the same interface:
//   await feed.init()
//   await feed.resolve(symbol)           -> { symbol, streamer, name, kind }
//   feed.subscribeChart(info, tf, opts, onBars) -> unsubscribe()   onBars(bars, 'reset'|'update'|'nodata')
//   (any number of charts can subscribe at once)
//   feed.setQuoteSymbols(infos); feed.onQuote = (q) => {}
//   feed.onStatus = (state, text, label?) => {}   // text = full detail (tooltip), label = short status-bar text
// Bars: { time: unixSeconds, open, high, low, close, volume }

import { parts, symbolKind } from './util.js';

// ======================= tastytrade / DXLink =======================
const CANDLE_FIELDS = ['eventType', 'eventSymbol', 'time', 'eventFlags', 'open', 'high', 'low', 'close', 'volume'];
const QUOTE_FIELDS = {
  Quote: ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'],
  Trade: ['eventType', 'eventSymbol', 'price', 'dayVolume'],
  TradeETH: ['eventType', 'eventSymbol', 'price', 'dayVolume'], // pre-market / after-hours last trade
  Summary: ['eventType', 'eventSymbol', 'dayOpenPrice', 'dayHighPrice', 'dayLowPrice', 'prevDayClosePrice'],
};
const CH_CANDLE = 1, CH_QUOTE = 3, CH_ETH = 5; // CH_ETH: hourly candles used for watchlist pre/after-hours prices
// "SPY{=5m,tho=true}" -> "5m"; dxFeed may echo "=1d" back as "=d", so treat a missing count as 1.
export function periodKey(sym) {
  const m = /[{,]=(\d*\.?\d*)([a-zA-Z]+)/.exec(String(sym));
  return m ? `${Number(m[1] || 1)}${m[2].toLowerCase()}` : '';
}
const num = (v) => (v === null || v === undefined || v === 'NaN' || v === '' ? NaN : Number(v));

export class TastyFeed {
  constructor() {
    this.mode = 'live';
    this.ws = null; this.authorized = false; this.open = { [CH_CANDLE]: false, [CH_QUOTE]: false, [CH_ETH]: false };
    this.subs = new Map(); this.quoteInfos = []; this.byStreamer = new Map(); this.quotes = new Map();
    this.onQuote = () => {}; this.onStatus = () => {};
    this.retry = 0; this.level = null;
  }
  async init() { await this.connect(); }

  async connect(refresh = false) {
    this.onStatus('connecting', 'Connecting to tastytrade…');
    const r = await fetch('/api/quote-token' + (refresh ? '?refresh' : ''));
    const tok = await r.json();
    if (!r.ok) throw new Error(tok.error || 'quote token failed');
    this.level = tok.level;
    const ws = new WebSocket(tok.dxlinkUrl);
    this.ws = ws; this.authorized = false; this.open = { [CH_CANDLE]: false, [CH_QUOTE]: false, [CH_ETH]: false };
    let authFailures = 0;
    ws.onopen = () => this.send({ type: 'SETUP', channel: 0, version: '0.1-DXF-JS/0.3.0', keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      switch (msg.type) {
        case 'AUTH_STATE':
          if (msg.state === 'UNAUTHORIZED') {
            if (authFailures++ > 0) { ws.close(); this.connect(true).catch((e) => this.fail(e)); return; }
            this.send({ type: 'AUTH', channel: 0, token: tok.token });
          } else if (msg.state === 'AUTHORIZED') {
            this.authorized = true; this.retry = 0;
            this.send({ type: 'CHANNEL_REQUEST', channel: CH_CANDLE, service: 'FEED', parameters: { contract: 'AUTO' } });
            this.send({ type: 'CHANNEL_REQUEST', channel: CH_QUOTE, service: 'FEED', parameters: { contract: 'AUTO' } });
            this.send({ type: 'CHANNEL_REQUEST', channel: CH_ETH, service: 'FEED', parameters: { contract: 'AUTO' } });
            this.onStatus('live', `tastytrade · DXLink${this.level && this.level !== 'api' ? ' (' + this.level + ')' : ''}`);
          }
          break;
        case 'CHANNEL_OPENED':
          this.open[msg.channel] = true;
          if (msg.channel === CH_CANDLE) {
            this.send({ type: 'FEED_SETUP', channel: CH_CANDLE, acceptAggregationPeriod: 0.25, acceptDataFormat: 'COMPACT', acceptEventFields: { Candle: CANDLE_FIELDS } });
            this.resubscribeAll();
          } else if (msg.channel === CH_QUOTE) {
            this.send({ type: 'FEED_SETUP', channel: CH_QUOTE, acceptAggregationPeriod: 0.5, acceptDataFormat: 'COMPACT', acceptEventFields: QUOTE_FIELDS });
            this.subscribeQuotesNow();
          } else if (msg.channel === CH_ETH) {
            this.send({ type: 'FEED_SETUP', channel: CH_ETH, acceptAggregationPeriod: 1, acceptDataFormat: 'COMPACT', acceptEventFields: { Candle: CANDLE_FIELDS } });
            this.subscribeEthNow();
          }
          break;
        case 'FEED_DATA': this.onFeedData(msg); break;
        case 'KEEPALIVE': break;
        case 'ERROR': console.warn('DXLink error', msg); this.onStatus('err', `DXLink: ${msg.message || msg.error}`); break;
      }
    };
    ws.onclose = () => {
      clearInterval(this.ka);
      if (this.ws !== ws) return;
      this.onStatus('err', 'Disconnected, reconnecting…', 'Reconnecting…');
      const wait = Math.min(30000, 1000 * 2 ** this.retry++);
      setTimeout(() => this.connect(this.retry > 2).catch((e) => this.fail(e)), wait);
    };
    clearInterval(this.ka);
    this.ka = setInterval(() => this.send({ type: 'KEEPALIVE', channel: 0 }), 30000);
  }
  fail(e) { console.error(e); this.onStatus('err', e.message); }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  async resolve(symbol) {
    const r = await fetch('/api/resolve?symbol=' + encodeURIComponent(symbol));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Symbol not found');
    return j;
  }
  async search(q) {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    return r.ok ? r.json() : [];
  }

  // ---- candles ----
  // Several charts can be open at once (multi-chart layouts), so candle subscriptions are kept per
  // DXLink symbol and shared: two charts on the same symbol + timeframe use one subscription.
  subscribeChart(info, tf, opts, onBars) {
    const attrs = [`=${tf.dx}`]; if (opts.rth && (info.kind === 'equity' || info.kind === 'index') && tf.sec < 86400) attrs.push('tho=true');
    const sym = `${info.streamer}{${attrs.join(',')}}`;
    let st = this.subs.get(sym);
    if (!st) {
      st = { sym, base: info.streamer + '{', pkey: periodKey(sym), listeners: new Set(), bars: new Map(), lastTime: 0, loaded: false,
        needReset: false, pending: new Set(), timer: null, fromTime: Date.now() - tf.lookbackDays * 864e5 };
      this.subs.set(sym, st);
      st.listeners.add(onBars);
      this.subscribeCandleNow(st);
    } else {
      st.listeners.add(onBars);
      if (st.loaded && st.bars.size) {
        const arr = [...st.bars.values()].sort((a, b) => a.time - b.time).map((b) => ({ ...b }));
        setTimeout(() => { if (st.listeners.has(onBars)) onBars(arr, 'reset'); }, 0);
      }
    }
    return () => {
      st.listeners.delete(onBars);
      if (st.listeners.size || this.subs.get(sym) !== st) return;
      this.subs.delete(sym);
      this.send({ type: 'FEED_SUBSCRIPTION', channel: CH_CANDLE, remove: [{ type: 'Candle', symbol: sym }] });
      clearTimeout(st.timer); clearTimeout(st.noData);
    };
  }
  emit(st, arr, kind) { for (const fn of [...st.listeners]) { try { fn(arr.map((b) => ({ ...b })), kind); } catch (e) { console.error(e); } } }
  prepare(st) {
    st.bars.clear(); st.loaded = false; st.lastTime = 0; st.pending.clear(); st.needReset = false;
    clearTimeout(st.timer); st.timer = setTimeout(() => this.flush(st), 2500); // in case the snapshot never signals its end
    clearTimeout(st.noData);
    st.noData = setTimeout(() => { if (this.subs.get(st.sym) === st && !st.bars.size) this.emit(st, [], 'nodata'); }, 10000);
  }
  subscribeCandleNow(st) {
    if (!this.open[CH_CANDLE]) return;
    this.prepare(st);
    this.send({ type: 'FEED_SUBSCRIPTION', channel: CH_CANDLE, add: [{ type: 'Candle', symbol: st.sym, fromTime: st.fromTime }] });
  }
  resubscribeAll() {
    if (!this.open[CH_CANDLE]) return;
    const add = [];
    for (const st of this.subs.values()) { this.prepare(st); add.push({ type: 'Candle', symbol: st.sym, fromTime: st.fromTime }); }
    this.send({ type: 'FEED_SUBSCRIPTION', channel: CH_CANDLE, reset: true, add });
  }
  subFor(eventSymbol) {
    const exact = this.subs.get(eventSymbol); if (exact) return exact;
    const pk = periodKey(eventSymbol);
    for (const st of this.subs.values()) if (eventSymbol.startsWith(st.base) && pk === st.pkey) return st;
    return null;
  }
  onFeedData(msg) {
    const events = decode(msg.data, msg.channel === CH_CANDLE || msg.channel === CH_ETH ? { Candle: CANDLE_FIELDS } : QUOTE_FIELDS);
    if (msg.channel === CH_CANDLE) return this.onCandles(events);
    if (msg.channel === CH_ETH) return this.onEthCandles(events);
    for (const e of events) this.onQuoteEvent(e);
  }
  onCandles(events) {
    const touched = new Map(); // st -> snapshotEnd
    for (const e of events) {
      if (e.eventType !== 'Candle' || typeof e.eventSymbol !== 'string') continue;
      const st = this.subFor(e.eventSymbol); if (!st) continue;
      const flags = num(e.eventFlags) || 0;
      touched.set(st, touched.get(st) || !!(flags & 0x08 || flags & 0x10));
      const t = Math.floor(num(e.time) / 1000);
      if (!isFinite(t) || t <= 0) continue;
      const o = num(e.open), h = num(e.high), l = num(e.low), c = num(e.close);
      if (flags & 0x02 || !isFinite(o) || !isFinite(c)) { if (st.bars.delete(t)) st.needReset = true; continue; }
      st.bars.set(t, { time: t, open: o, high: isFinite(h) ? h : Math.max(o, c), low: isFinite(l) ? l : Math.min(o, c), close: c, volume: num(e.volume) || 0 });
      if (!st.loaded || !st.lastTime || t < st.lastTime) st.needReset = true; else st.pending.add(t);
    }
    for (const [st, snapshotEnd] of touched) {
      if (!st.loaded) {
        clearTimeout(st.timer);
        st.timer = setTimeout(() => this.flush(st), snapshotEnd ? 0 : 400);
      } else if (!st.timer) {
        st.timer = setTimeout(() => this.flush(st), 60);
      }
    }
  }
  flush(st) {
    st.timer = null;
    if (this.subs.get(st.sym) !== st) return;
    if (!st.bars.size) return; // nothing yet: stay in snapshot mode until candles arrive
    if (st.needReset || !st.loaded) {
      const arr = [...st.bars.values()].sort((a, b) => a.time - b.time);
      st.lastTime = arr.length ? arr[arr.length - 1].time : 0;
      st.loaded = true; st.needReset = false; st.pending.clear();
      this.emit(st, arr, 'reset');
    } else if (st.pending.size) {
      const arr = [...st.pending].sort((a, b) => a - b).map((t) => st.bars.get(t)).filter(Boolean);
      st.pending.clear();
      st.lastTime = Math.max(st.lastTime, arr[arr.length - 1]?.time || 0);
      this.emit(st, arr, 'update');
    }
  }

  // ---- quotes ----
  setQuoteSymbols(infos) { this.quoteInfos = infos; this.subscribeQuotesNow(); }
  subscribeQuotesNow() {
    if (!this.open[CH_QUOTE]) return;
    this.byStreamer = new Map(this.quoteInfos.map((i) => [i.streamer, i.symbol]));
    const add = [];
    for (const i of this.quoteInfos) for (const type of ['Trade', 'TradeETH', 'Quote', 'Summary']) add.push({ type, symbol: i.streamer });
    if (add.length || this._hadQuotes) this.send({ type: 'FEED_SUBSCRIPTION', channel: CH_QUOTE, reset: true, add });
    this._hadQuotes = add.length > 0;
    this.subscribeEthNow();
  }
  // Pre-market / after-hours price for stocks and ETFs: the close of the newest hourly candle (hourly candles
  // include extended hours). TradeETH events are used only if no candle has arrived.
  subscribeEthNow() {
    if (!this.open[CH_ETH]) return;
    this.ethBy = new Map(); this.ethLatest = new Map();
    const add = [];
    for (const i of this.quoteInfos) {
      if (i.kind && i.kind !== 'equity') continue;
      const sym = `${i.streamer}{=1h}`; this.ethBy.set(i.streamer, i.symbol);
      add.push({ type: 'Candle', symbol: sym, fromTime: Date.now() - 5 * 864e5 });
    }
    this.send({ type: 'FEED_SUBSCRIPTION', channel: CH_ETH, reset: true, add });
  }
  onEthCandles(events) {
    const changed = new Set();
    for (const e of events) {
      if (e.eventType !== 'Candle' || typeof e.eventSymbol !== 'string') continue;
      const streamer = e.eventSymbol.slice(0, e.eventSymbol.indexOf('{'));
      const symbol = this.ethBy?.get(streamer); if (!symbol) continue;
      const t = num(e.time), c = num(e.close), flags = num(e.eventFlags) || 0;
      if (!isFinite(t) || !isFinite(c) || c <= 0 || flags & 0x02) continue;
      const cur = this.ethLatest.get(symbol);
      if (cur && cur.t > t) continue;
      this.ethLatest.set(symbol, { t, c }); changed.add(symbol);
    }
    for (const symbol of changed) {
      const q = this.quotes.get(symbol) || { symbol };
      q.ethLast = this.ethLatest.get(symbol).c; this.quotes.set(symbol, q);
      this.onQuote({ ...q, last: q.last ?? q.mid });
    }
  }
  onQuoteEvent(e) {
    const symbol = this.byStreamer.get(e.eventSymbol); if (!symbol) return;
    const q = this.quotes.get(symbol) || { symbol };
    if (e.eventType === 'Trade') { if (isFinite(num(e.price))) q.last = num(e.price); if (isFinite(num(e.dayVolume))) q.volume = num(e.dayVolume); }
    if (e.eventType === 'TradeETH' && isFinite(num(e.price)) && num(e.price) > 0 && !this.ethLatest?.has(symbol)) q.ethLast = num(e.price);
    if (e.eventType === 'Quote') { q.bid = num(e.bidPrice); q.ask = num(e.askPrice); if (q.last == null && isFinite(q.bid) && isFinite(q.ask)) q.mid = (q.bid + q.ask) / 2; }
    if (e.eventType === 'Summary') {
      q.prevClose = num(e.prevDayClosePrice); q.open = num(e.dayOpenPrice); q.high = num(e.dayHighPrice); q.low = num(e.dayLowPrice);
    }
    this.quotes.set(symbol, q);
    this.onQuote({ ...q, last: q.last ?? q.mid });
  }
}

// COMPACT: ["Type", [v, v, v, v, ...], "Type2", [...]] (values repeat in FEED_SETUP field order). FULL: [{...}, ...]
function decode(data, fieldsByType) {
  const out = [];
  if (!Array.isArray(data)) return out;
  if (data.length && typeof data[0] === 'object' && !Array.isArray(data[0])) return data;
  for (let i = 0; i < data.length; i++) {
    let type = data[i], vals = data[i + 1];
    if (Array.isArray(type)) { [type, vals] = type; } else i++;
    const fields = fieldsByType[type]; if (!fields || !Array.isArray(vals)) continue;
    for (let j = 0; j + fields.length <= vals.length; j += fields.length) {
      const e = {}; fields.forEach((f, k) => { e[f] = vals[j + k]; }); out.push(e);
    }
  }
  return out;
}

// ======================= Demo feed (no credentials) =======================
const DEMO_BASE = { SPY: 580, QQQ: 505, IWM: 225, AAPL: 231, NVDA: 138, TSLA: 255, MSFT: 418, AMZN: 188, META: 575, AMD: 145,
  '/ES': 5820, '/NQ': 20350, '/CL': 69.5, '/GC': 2760, '/RTY': 2230, 'BTC/USD': 77500, 'ETH/USD': 2600, SPX: 5810 };
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

export class DemoFeed {
  constructor() { this.mode = 'demo'; this.onQuote = () => {}; this.onStatus = () => {}; this.prices = new Map(); this.quoteInfos = []; }
  async init() {
    this.onStatus('demo', 'Demo data (connect tastytrade in Settings for real data)');
    this.qTimer = setInterval(() => this.tickQuotes(), 1500);
  }
  async resolve(symbol) {
    symbol = symbol.trim().toUpperCase();
    const kind = symbolKind(symbol);
    return { symbol, streamer: symbol, name: `${symbol} (demo data)`, kind };
  }
  async search(q) {
    q = q.toUpperCase();
    return Object.keys(DEMO_BASE).filter((s) => s.includes(q)).map((s) => ({ symbol: s, name: 'Demo', kind: symbolKind(s) }));
  }
  base(sym) { return DEMO_BASE[sym] ?? (20 + (hash(sym) % 400)); }
  price(sym) { if (!this.prices.has(sym)) this.prices.set(sym, { last: this.base(sym), prevClose: this.base(sym) * (1 - 0.006 + 0.012 * rng(hash(sym))()) }); return this.prices.get(sym); }

  inSession(t, kind, rth) {
    if (kind === 'crypto') return true;
    const p = parts(t, 'America/New_York');
    const wd = p.weekday, m = +p.hour * 60 + +p.minute;
    if (kind === 'future') return !(wd === 'Sat' || (wd === 'Fri' && m >= 17 * 60) || (wd === 'Sun' && m < 18 * 60) || (m >= 17 * 60 && m < 18 * 60));
    if (wd === 'Sat' || wd === 'Sun') return false;
    return rth ? m >= 570 && m < 960 : m >= 240 && m < 1200;
  }
  volumeShape(t, kind) {
    const p = parts(t, 'America/New_York'); const m = +p.hour * 60 + +p.minute;
    if (kind === 'crypto') return 0.7 + 0.6 * Math.exp(-((m - 600) ** 2) / 20000);
    const x = (m - 570) / 390; // 0..1 over RTH
    if (x < 0 || x > 1) return 0.15;
    return 0.6 + 2.2 * (x - 0.5) ** 2 * 4 / 2;
  }
  generate(info, tf, rth) {
    const r = rng(hash(info.symbol + tf.id));
    const now = Math.floor(Date.now() / 1000);
    const end = Math.floor(now / tf.sec) * tf.sec;
    const daily = tf.sec >= 86400;
    const maxBars = daily ? 1500 : 12000;
    const start = Math.max(end - tf.lookbackDays * 86400, end - maxBars * tf.sec * (info.kind === 'equity' ? 4 : 1.4));
    const vol = (info.kind === 'crypto' ? 0.022 : info.kind === 'future' ? 0.011 : 0.016) * Math.sqrt(tf.sec / 86400 * (daily ? 1 : 3.5));
    const baseVol = info.kind === 'future' ? 2500 : info.kind === 'crypto' ? 40 : 90000;
    const bars = []; let px = 100; let drift = 0;
    for (let t = start; t <= end; t += tf.sec) {
      let tt = t;
      if (tf.id === 'W') { const d = new Date(t * 1000); tt = t - ((d.getUTCDay() + 6) % 7) * 86400; tt -= tt % 86400; if (bars.length && bars[bars.length - 1].time === tt) continue; }
      if (!daily && !this.inSession(tt, info.kind, rth)) continue;
      if (daily && info.kind !== 'crypto' && tf.id === 'D') { const wd = new Date(t * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue; }
      if (r() < 0.02) drift = (r() - 0.5) * vol * 0.6;
      const o = px;
      const c = o * (1 + drift + gauss(r) * vol);
      const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * vol * 0.5);
      const l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * vol * 0.5);
      const v = baseVol * (tf.sec / 300) ** 0.9 * this.volumeShape(tt, info.kind) * (0.5 + r()) * (1 + Math.abs(c - o) / o / vol * 0.4);
      bars.push({ time: tt, open: o, high: h, low: l, close: c, volume: Math.round(v) });
      px = c;
    }
    // scale so the series ends at the symbol's current demo price
    const target = this.price(info.symbol).last; const k = target / px;
    const dec = target > 1000 ? 2 : target > 20 ? 2 : 4; const rnd = (x) => +x.toFixed(dec);
    for (const b of bars) { b.open = rnd(b.open * k); b.high = rnd(b.high * k); b.low = rnd(b.low * k); b.close = rnd(b.close * k); }
    if (bars.length) { const b = bars[bars.length - 1]; b.close = rnd(target); b.high = Math.max(b.high, b.close); b.low = Math.min(b.low, b.close); }
    return bars;
  }
  subscribeChart(info, tf, opts, onBars) {
    const bars = this.generate(info, tf, opts.rth);
    const first = setTimeout(() => onBars(bars.slice(), 'reset'), 120);
    const r = rng(hash(info.symbol) ^ Date.now());
    const timer = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      if (tf.sec < 86400 && !this.inSession(now, info.kind, opts.rth)) return;
      const p = this.price(info.symbol);
      const last = bars[bars.length - 1]; if (!last) return;
      const step = p.last * 0.00025 * gauss(r);
      p.last = +(p.last + step).toFixed(p.last > 20 ? 2 : 4);
      const bt = tf.sec >= 86400 ? last.time : Math.floor(now / tf.sec) * tf.sec;
      let b = last;
      if (bt > last.time) { b = { time: bt, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0 }; bars.push(b); }
      b.close = p.last; b.high = Math.max(b.high, p.last); b.low = Math.min(b.low, p.last);
      b.volume += Math.round((info.kind === 'future' ? 20 : info.kind === 'crypto' ? 0.4 : 600) * (0.5 + r()) * Math.max(1, tf.sec / 300) ** 0.5);
      onBars([{ ...b }], 'update');
      this.emitQuote(info.symbol);
    }, 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }
  setQuoteSymbols(infos) { this.quoteInfos = infos; for (const i of infos) this.emitQuote(i.symbol); }
  tickQuotes() {
    const r = Math.random;
    for (const i of this.quoteInfos) {
      if (r() < 0.5) continue;
      const p = this.price(i.symbol); p.last = +(p.last * (1 + (r() - 0.5) * 0.0006)).toFixed(p.last > 20 ? 2 : 4);
      this.emitQuote(i.symbol);
    }
  }
  emitQuote(symbol) {
    const p = this.price(symbol);
    // demo after-hours price for stocks: a small move away from the last price
    const eth = symbolKind(symbol) === 'equity' ? +(p.last * (1 + ((hash(symbol) % 200) - 100) / 20000)).toFixed(2) : undefined;
    this.onQuote({ symbol, last: p.last, prevClose: +p.prevClose.toFixed(2), ethLast: eth, volume: ((hash(symbol) % 900) + 100) * 1e5 });
  }
}
