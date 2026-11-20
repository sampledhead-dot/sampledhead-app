/* mid-box — pestaña de SampledHead App (v1.0.0)
 * La voz se convierte en batería (bombo, caja, hat cerrado, hat abierto) o en línea de bajo.
 *   - En directo: el micro dispara los sonidos al momento.
 *   - Grabando o desde un audio (archivo o pad): se analiza con más detalle.
 *   - Las notas se guardan SIN cuantizar (en tiempos, a la posición exacta en que se tocaron); se pueden mover,
 *     borrar, añadir y cuantizar después con un % de fuerza.
 *   - Sale a: pad en bucle (WAV), Looper (secuencia), Generador, MIDI, WAV y «Enviar a…» (otras apps).
 *
 * Usa del sampler (globales): ctx, pads, sel, select, labels, resetPad, stop, nextEmpty, status, save, region,
 * sampBus, bassBus, mkBass, BP, BS, BSCALES, bMidi, lp, lpClear, lpTempoUpdate, lpUI, G, GDRUM, gSave, gUI, gGrid,
 * gResizeLocked, gBspb, gGenBass, cvApply, showTab. De sh-core.js: SH.ui.sendSheet, SH.wav.
 */
(function () {
  'use strict';
  const MB_VERSION = '1.4.0';
  const $m = s => document.querySelector(s);
  const SH = window.SH;
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const nName = p => NOTE[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  const LANES = [
    { id: 'k', n: 'Bombo', voz: '«bum», «b»', m: 36, c: '#ff5d5d' },
    { id: 's', n: 'Caja', voz: '«pf», «k», «ch»', m: 38, c: '#ffb000' },
    { id: 'h', n: 'Hat cerrado', voz: '«ts» corto', m: 42, c: '#4fe3c1' },
    { id: 'o', n: 'Hat abierto', voz: '«tsss» largo', m: 46, c: '#31d0ff' }];
  const BARS = [1, 2, 4, 8, 16];
  const CALKEY = 'sampledhead.midbox.cal', SETKEY = 'sampledhead.midbox.set';
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  /* ---------------- Registro, consola e informe de error ---------------- */
  const LOGS = [];
  const LOG = (...a) => { const s = new Date().toISOString().slice(11, 23) + ' [mid-box] ' + a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' '); LOGS.push(s); if (LOGS.length > 300) LOGS.shift(); };
  ['log', 'warn', 'error'].forEach(k => { const o = console[k]; if (!o || o.__mbx) return; const f = function (...a) { try { LOGS.push(new Date().toISOString().slice(11, 23) + ' ' + k + ' ' + a.map(v => { try { return typeof v === 'string' ? v : v && v.stack ? v.stack : JSON.stringify(v); } catch (e) { return String(v); } }).join(' ')); if (LOGS.length > 300) LOGS.shift(); } catch (e) {} return o.apply(console, a); }; f.__mbx = 1; console[k] = f; });

  /* ---------------- Estado ---------------- */
  const M = {
    part: 'd', bpm: 90, bars: 2, ls: 0, metro: true, count: true, overdub: false,
    sens: 5, resp: 'fast', comp: null, monRec: false, noise: null, spk: null, aec: false, latMeasured: false, own: [], micByRec: false, lastTake: null, oct: -1, snap: true, magnet: false, grid: 0.25, qStr: 100,
    playD: true, playB: true, exp: 'both',
    d: { notes: [], src: null }, b: { notes: [], src: null },
    sel: new Set(), undo: [], redo: [], nid: 1,
    slots: LANES.map(() => ({ buf: null, name: '' })),
    cal: { k: [], s: [], h: [], o: [] }, calKnn: null,
    live: null, take: null, player: null, mic: null, peakRef: { k: .25, s: .2, h: .12, o: .12 }, bassRef: .1,
    steps: [], lastFile: null, autoReports: 0, lastHit: '', level: 0
  };
  const step = (t, info) => { M.steps.push({ t: new Date().toISOString().slice(11, 19), s: t, info: info || '' }); if (M.steps.length > 40) M.steps.shift(); LOG(t, info || ''); };
  const spb = () => 60 / M.bpm;
  const loopBeats = () => M.bars * 4;
  const loopSec = () => loopBeats() * spb();
  /* región del loop: desde M.ls (inicio, en tiempos) durante loopBeats(). Lo que suena y se exporta es solo eso, contado desde el inicio. */
  const inR = n => n.t >= M.ls - 1e-6 && n.t < M.ls + loopBeats() - 1e-6;
  const RN = k => M[k].notes.filter(inR).map(n => Object.assign({}, n, { t: n.t - M.ls }, n.d != null ? { d: Math.min(n.d, loopBeats() - (n.t - M.ls)) } : {}));
  const P = () => M[M.part];

  function loadSettings() {
    try { const s = JSON.parse(localStorage.getItem(SETKEY) || 'null'); if (s) ['bpm', 'bars', 'metro', 'count', 'overdub', 'sens', 'resp', 'comp', 'oct', 'snap', 'magnet', 'grid', 'qStr', 'exp', 'monRec', 'noise', 'spk', 'aec', 'latMeasured'].forEach(k => { if (s[k] != null) M[k] = s[k]; }); } catch (e) {}
    try { const c = JSON.parse(localStorage.getItem(CALKEY) || 'null'); if (c) LANES.forEach(L => { if (Array.isArray(c[L.id])) M.cal[L.id] = c[L.id]; }); } catch (e) {}
    if (M.comp == null) M.comp = defComp();
    if (M.spk == null) M.spk = matchMedia('(pointer:coarse)').matches;   // en el móvil se supone altavoz hasta que digas lo contrario
  }
  function saveSettings() { try { const s = {}; ['bpm', 'bars', 'metro', 'count', 'overdub', 'sens', 'resp', 'comp', 'oct', 'snap', 'magnet', 'grid', 'qStr', 'exp', 'monRec', 'noise', 'spk', 'aec', 'latMeasured'].forEach(k => s[k] = M[k]); localStorage.setItem(SETKEY, JSON.stringify(s)); } catch (e) {} }
  function saveCal() { M.calKnn = null; try { localStorage.setItem(CALKEY, JSON.stringify(M.cal)); } catch (e) {} }
  function defComp() { let l = 0; try { l = (ctx.outputLatency || 0) + (ctx.baseLatency || 0); } catch (e) {} return Math.round(clamp(l * 1000 + 10, 10, 120)); }

  /* ---------------- FFT y rasgos de un golpe ---------------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a), h = len >> 1;
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let j = 0; j < h; j++) { const u = i + j, v = u + h, xr = re[v] * cr - im[v] * ci, xi = re[v] * ci + im[v] * cr; re[v] = re[u] - xr; im[v] = im[u] - xi; re[u] += xr; im[u] += xi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
  }
  const BANDS = [40, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];
  /* umbrales: sensibilidad 1 = solo golpes muy fuertes (−19 dBFS) … 10 = todo (−60 dBFS); nunca por debajo del ruido medido */
  const drumGate = () => Math.max(Math.pow(10, (-14.4 - 4.6 * M.sens) / 20), M.noise ? M.noise.env * 2 : 0);
  const drumGateH = () => Math.max(Math.pow(10, (-14.4 - 4.6 * M.sens) / 20), M.noise ? M.noise.envH * 2 : 0);
  const voiceGate = () => Math.max(Math.pow(10, (-20 - 4 * M.sens) / 20), M.noise ? M.noise.rms * 2.2 : 0);
  /* soplido o aire contra el micro: sube despacio o es flojo → no es un golpe */
  /* cola de un golpe fuerte (o aire justo detrás): muy flojo y pegado al anterior */
  const masked = (prev, t, peak) => prev && t - prev.t < .18 && peak < prev.peak * .33;
  /* clic del metrónomo oído por el altavoz: tono puro entre 1 y 2 kHz */
  const clickLike = f => M.spk && f.frac[5] > .7;
  const noiseLike = (f, W, sr) => clickLike(f) || f.att > (W / sr) * 1000 * .5 || f.decay >= 1.3 || f.peak < drumGate() * 1.6;
  const winSec = mode => mode === 'precise' ? 0.045 : 0.025;
  /* seg: muestras desde el inicio del golpe (al menos W) */
  function feats(seg, sr, W) {
    W = Math.min(W, seg.length);
    const N = W > 2048 ? 4096 : 2048, re = new Float32Array(N), im = new Float32Array(N);
    let pk = 0, zc = 0, e1 = 0, e3 = 0, tot2 = 0; const th = Math.floor(W / 3);
    for (let i = 0; i < W; i++) {
      const v = seg[i]; re[i] = v * (0.5 - 0.5 * Math.cos(2 * Math.PI * (i + .5) / W));
      const a = Math.abs(v); if (a > pk) pk = a; tot2 += v * v;
      if (i && (v >= 0) !== (seg[i - 1] >= 0)) zc++;
      if (i < th) e1 += v * v; else if (i >= W - th) e3 += v * v;
    }
    let att = 0; { const F = Math.max(8, Math.round(sr * .003)), ev = []; for (let i = 0; i + F <= W; i += F) { let q = 0; for (let j = 0; j < F; j++) q += seg[i + j] * seg[i + j]; ev.push(q); } const mx = Math.max(...ev); att = ev.findIndex(q => q >= mx * .5) * F / sr * 1000; }
    fft(re, im);
    const bw = sr / N, be = new Float64Array(8); let sc = 0, se = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = k * bw, e = re[k] * re[k] + im[k] * im[k];
      sc += f * e; se += e;
      for (let b = 0; b < 8; b++) if (f >= BANDS[b] && f < BANDS[b + 1]) { be[b] += e; break; }
    }
    const tot = be.reduce((a, b) => a + b, 0) || 1e-12, frac = Array.from(be, e => e / tot);
    const cent = sc / (se || 1e-12), decay = clamp(Math.sqrt(e3 / (e1 || 1e-12)), 0, 1.5);
    return {
      v: [...frac.map(Math.sqrt), Math.log2(Math.max(50, cent)) / 14, Math.min(1, zc / W * 2), decay],
      frac, cent, decay, att, zc: zc / W, peak: pk, rms: Math.sqrt(tot2 / W),
      low: frac[0] + frac[1] + frac[2], high: frac[6] + frac[7]
    };
  }
  /* cuánto dura el golpe: desde el pico hasta que la envolvente cae al 15 % */
  function hitDur(x, s0, sr, sEnd) {
    const F = Math.max(8, Math.round(sr * .005)), lim = Math.min(x.length, sEnd, s0 + Math.round(sr * .6)); let pk = 0, pki = s0;
    const env = [];
    for (let i = s0; i + F <= lim; i += F) { let s = 0; for (let j = 0; j < F; j++) s += x[i + j] * x[i + j]; const r = Math.sqrt(s / F); env.push(r); if (i < s0 + sr * .06 && r > pk) { pk = r; pki = env.length - 1; } }
    if (!pk) return 0;
    for (let k = pki; k < env.length; k++) if (env[k] < pk * .15) return (k * F) / sr;
    return env.length * F / sr;
  }

  /* ---------------- Clasificación ---------------- */
  function calReady() { return ['k', 's', 'h'].every(id => M.cal[id].filter(e => e.v25 && e.v45).length >= 3); }
  function knnModel(w) {
    M.calKnn = M.calKnn || {}; if (M.calKnn[w]) return M.calKnn[w];
    const key = w === 'precise' ? 'v45' : 'v25', ex = []; LANES.forEach(L => M.cal[L.id].forEach(e => { if (e[key]) ex.push({ id: L.id, v: e[key], dur: e.dur }); }));
    if (!ex.length) return null;
    const D = ex[0].v.length, mu = new Array(D).fill(0), sd = new Array(D).fill(0);
    ex.forEach(e => e.v.forEach((x, i) => mu[i] += x / ex.length));
    ex.forEach(e => e.v.forEach((x, i) => sd[i] += (x - mu[i]) ** 2 / ex.length));
    for (let i = 0; i < D; i++) sd[i] = Math.max(.04, Math.sqrt(sd[i]));
    const dl = d => Math.log2(Math.max(.01, d || .01) * 100);
    const dm = ex.reduce((a, e) => a + dl(e.dur), 0) / ex.length, ds = Math.max(.3, Math.sqrt(ex.reduce((a, e) => a + (dl(e.dur) - dm) ** 2, 0) / ex.length));
    return (M.calKnn[w] = { ex, mu, sd, dl, dm, ds });
  }
  function ruleClass(f, dur) {
    if (f.low > .45 && f.cent < 700) return 'k';
    if (f.high > .35 || f.cent > 3500) return (dur != null ? dur > .16 : f.decay > .7) ? 'o' : 'h';
    if (f.low > .62) return 'k';
    return 's';
  }
  function classify(f, dur, w) {
    if (!calReady()) return ruleClass(f, dur);
    const K = knnModel(w || 'precise'); if (!K) return ruleClass(f, dur);
    const z = v => v.map((x, i) => (x - K.mu[i]) / K.sd[i]), q = z(f.v);
    const useDur = dur != null && K.ex.every(e => e.dur != null), qd = useDur ? (K.dl(dur) - K.dm) / K.ds : 0;
    const d = K.ex.map(e => { const ev = z(e.v); let s = 0; for (let i = 0; i < q.length; i++) s += (q[i] - ev[i]) ** 2; if (useDur) s += 1.5 * ((K.dl(e.dur) - K.dm) / K.ds - qd) ** 2; return { id: e.id, d: Math.sqrt(s) }; }).sort((a, b) => a.d - b.d);
    const k = Math.min(5, d.length), vote = {};
    for (let i = 0; i < k; i++) vote[d[i].id] = (vote[d[i].id] || 0) + 1 / (d[i].d + .05);
    let best = 'k', bv = -1; for (const id in vote) if (vote[id] > bv) { bv = vote[id]; best = id; }
    if ((best === 'h' || best === 'o') && M.cal.o.length < 3) best = (dur != null ? dur > .16 : f.decay > .7) ? 'o' : 'h';   // sin ejemplos de hat abierto: decide la cola
    return best;
  }
  function velOf(id, peak) {
    const ref = M.cal[id] && M.cal[id].length ? M.cal[id].reduce((a, e) => a + (e.peak || 0), 0) / M.cal[id].length : M.peakRef[id];
    if (!(M.cal[id] && M.cal[id].length) && peak > M.peakRef[id]) M.peakRef[id] = M.peakRef[id] * .7 + peak * .3;
    return Math.round(clamp(38 + 89 * Math.pow(Math.min(1.25, peak / (ref || .2)) / 1.25, .7), 20, 127));
  }

  /* ---------------- Detector de golpes (en directo y sobre un audio) ---------------- */
  function DrumDet(sr, onOnset) {
    /* envolventes con ataque rápido (0,5 ms) y caída lenta (30 ms): la de la señal y la de su derivada (agudos).
       Un golpe = la envolvente salta por encima del ruido de fondo y de lo que había justo antes. La caída lenta evita
       que las ondas graves de un bombo largo (más lentas que la ventana) parezcan golpes nuevos. */
    const H = 128, RB = 1 << 17, ring = new Float32Array(RB), kA = 1 - Math.exp(-1 / (.0005 * sr)), kR = Math.exp(-1 / (.03 * sr));
    let n = 0, hop = 0, env = 0, envH = 0, prev = 0, floor = 1e-5, lastOn = -1e9; const eh = [], hh = [];
    function evalHop() {
      const pm = eh.length ? Math.min(...eh) : env, hm = hh.length ? Math.min(...hh) : envH;
      floor = env < floor ? env : floor * 1.0008;
      const g = drumGate(), gh = drumGateH();
      const up = (env > Math.max(g, floor * 5) && env > pm * 2.4) || (envH > Math.max(gh, floor * 5) && envH > hm * 3 && env > Math.max(g * .6, floor * 4));
      eh.push(env); hh.push(envH); if (eh.length > 8) { eh.shift(); hh.shift(); }
      if (up && n - lastOn > sr * .05) {
        let pk = 0; for (let i = n - 384; i < n; i++) { const v = Math.abs(ring[i & (RB - 1)]); if (v > pk) pk = v; }
        let s0 = n - 384; for (let i = n - 384; i < n; i++) if (Math.abs(ring[i & (RB - 1)]) > pk * .25) { s0 = i; break; }
        s0 = Math.max(0, s0 - 24); lastOn = n; onOnset(s0);
      }
    }
    return {
      ring, RB, get n() { return n; },
      push(x) {
        for (let i = 0; i < x.length; i++) {
          const v = x[i], a = Math.abs(v), d = Math.abs(v - prev); prev = v;
          env = a > env ? env + (a - env) * kA : env * kR; envH = d > envH ? envH + (d - envH) * kA : envH * kR;
          ring[n & (RB - 1)] = v; n++;
          if (++hop >= H) { hop = 0; if (n >= 400) evalHop(); }
        }
      },
      read(s0, len) { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = ring[(s0 + i) & (RB - 1)]; return o; }
    };
  }
  /* audio completo → golpes [{t (s), id, vel, f, dur}] */
  function analyzeDrums(x, sr) {
    const ons = []; const det = DrumDet(sr, s0 => ons.push(s0));
    for (let i = 0; i < x.length; i += 1024) det.push(x.subarray(i, Math.min(x.length, i + 1024)));
    const W = Math.round(sr * winSec('precise'));
    let prev = null;
    return ons.map((s0, i) => {
      const seg = x.subarray(s0, Math.min(x.length, s0 + W)); if (seg.length < W * .6) return null;
      const f = feats(seg, sr, W); if (noiseLike(f, W, sr) || masked(prev, s0 / sr, f.peak)) return null; prev = { t: s0 / sr, peak: f.peak }; const dur = hitDur(x, s0, sr, i + 1 < ons.length ? ons[i + 1] : x.length), id = classify(f, dur, 'precise');
      return { t: s0 / sr, id, vel: velOf(id, f.peak), f, dur };
    }).filter(Boolean);
  }

  /* ---------------- Altura (YIN) y notas de bajo ---------------- */
  function PitchTrk(sr, onFrame) {
    const D = Math.max(1, Math.round(sr / 12000)), r = sr / D, W = 256, TM = Math.floor(r / 60), TN = Math.floor(r / 700), NB = W + TM + 2, HOP = 64;
    const buf = new Float32Array(4096); let n = 0, hop = 0, acc = 0, ac = 0, z1 = 0, z2 = 0;
    const a = Math.exp(-2 * Math.PI * 1400 / sr), d = new Float32Array(TM + 1);
    function frame() {
      const s = n - NB; let e = 0;
      for (let j = 0; j < W; j++) { const v = buf[(s + j) & 4095]; e += v * v; }
      const rms = Math.sqrt(e / W); let f = 0, conf = 0;
      if (rms > 1e-4) {
        d[0] = 1; let run = 0, tau = -1;
        for (let t = 1; t <= TM; t++) {
          let q = 0; for (let j = 0; j < W; j++) { const x = buf[(s + j) & 4095] - buf[(s + j + t) & 4095]; q += x * x; }
          run += q; d[t] = run ? q * t / run : 1;
          if (tau < 0 && t >= TN && d[t] < .2) { while (t + 1 <= TM) { let q2 = 0; for (let j = 0; j < W; j++) { const x = buf[(s + j) & 4095] - buf[(s + j + t + 1) & 4095]; q2 += x * x; } const run2 = run + q2, d2 = run2 ? q2 * (t + 1) / run2 : 1; if (d2 < d[t]) { t++; run = run2; d[t] = d2; } else break; } tau = t; break; }
        }
        if (tau > 0) {
          let tf = tau; if (tau > 1 && tau < TM) { const a0 = d[tau - 1], b0 = d[tau], c0 = d[tau + 1] != null ? d[tau + 1] : b0, den = a0 - 2 * b0 + c0; if (den > 0) tf = tau + (a0 - c0) / (2 * den); }
          f = r / tf; conf = 1 - d[tau];
        }
      }
      onFrame({ t: (n - NB / 2) / r, f, conf, rms });
    }
    return {
      push(x) {
        for (let i = 0; i < x.length; i++) {
          z1 = (1 - a) * x[i] + a * z1; z2 = (1 - a) * z1 + a * z2; acc += z2;
          if (++ac >= D) { buf[n & 4095] = acc / D; n++; acc = 0; ac = 0; if (++hop >= HOP) { hop = 0; if (n > NB) frame(); } }
        }
      }
    };
  }
  function scalePcs() { try { const sc = BSCALES[BS.scale]; return new Set(sc.iv.map(s => ((BS.root + s) % 12 + 12) % 12)); } catch (e) { return null; } }
  function snapNote(m) {
    const r = Math.round(m); if (!M.snap) return r;
    const pcs = scalePcs(); if (!pcs || !pcs.size) return r;
    let best = r, bd = 99; for (let k = -6; k <= 6; k++) { const c = r + k; if (pcs.has(((c % 12) + 12) % 12)) { const dd = Math.abs(c - m); if (dd < bd) { bd = dd; best = c; } } }
    return best;
  }
  /* segmentación en notas (la misma en directo y sobre un audio) */
  function NoteSeg(cb) {
    let cur = null, cand = [], unv = 0, hist = [], pk = 0;
    const gate = voiceGate;
    return {
      frame(F) {
        const g = gate(), voiced = F.rms > g && F.f >= 55 && F.f <= 750 && F.conf > .72;
        const minR = hist.length ? Math.min(...hist) : F.rms; hist.push(F.rms); if (hist.length > 8) hist.shift();
        if (!voiced) { cand = []; if (cur && ++unv >= 3) { cb.off(cur, F.t - .01); cur = null; } return; }
        unv = 0;
        const raw = 69 + 12 * Math.log2(F.f / 440) + 12 * M.oct, tgt = snapNote(raw);
        if (cur && tgt === cur.p) { cand = []; if (F.rms > pk) pk = F.rms; if (F.rms > minR * 2.2 && F.rms > g * 2.5 && F.t - cur.t > .09) { cb.off(cur, F.t - .005); cur = { p: tgt, t: F.t - .005, rms: F.rms }; pk = F.rms; cb.on(cur); } return; }
        cand.push({ p: tgt, t: F.t, rms: F.rms, raw });
        if (cand.length > 3) cand.shift();
        if (cand.length >= 3 && cand.every(c => c.p === tgt)) {
          if (cur) cb.off(cur, cand[0].t - .005);
          cur = { p: tgt, t: cand[0].t - (cur ? .005 : .012), rms: Math.max(...cand.map(c => c.rms)), raw: cand.reduce((a, c) => a + c.raw, 0) / 3 };
          pk = cur.rms; cand = []; cb.on(cur);
        }
      },
      end(t) { if (cur) cb.off(cur, t); cur = null; }
    };
  }
  function bassVel(rms) { if (rms > M.bassRef) M.bassRef = M.bassRef * .6 + rms * .4; return Math.round(clamp(45 + 80 * Math.pow(rms / (M.bassRef || .1), .6), 30, 127)); }
  function analyzeBass(x, sr) {
    const out = []; let open = null;
    const seg = NoteSeg({ on(c) { open = { t: c.t, p: c.p, rms: c.rms }; }, off(c, t) { if (open) { open.d = Math.max(0, t - open.t); out.push(open); open = null; } } });
    const tr = PitchTrk(sr, F => seg.frame(F));
    for (let i = 0; i < x.length; i += 2048) tr.push(x.subarray(i, Math.min(x.length, i + 2048)));
    seg.end(x.length / sr);
    const mx = Math.max(.02, ...out.map(o => o.rms));
    return out.filter(o => o.d >= .05).map(o => ({ t: Math.max(0, o.t), p: o.p, d: o.d, vel: Math.round(clamp(45 + 80 * Math.pow(o.rms / mx, .6), 30, 127)) }));
  }
  /* tempo que mejor encaja los inicios en una rejilla de corcheas (preferencia suave por ~95 BPM) */
  function estTempo(times) {
    if (times.length < 3) return 0; const t0 = times[0]; let best = 0, bs = 1e9;
    for (let b = 70; b <= 160; b += .25) { const g = 30 / b; let e = 0; times.forEach(t => { const u = (t - t0) / g, dd = u - Math.round(u); e += dd * dd; }); e = e / times.length + .02 * Math.abs(Math.log2(b / 95)); if (e < bs) { bs = e; best = b; } }
    return Math.round(best * 4) / 4;
  }
  function autoBars(endBeats) { return clamp(Math.ceil((endBeats - .2) / 4), 1, 16); }
  /* largo del loop en texto: «2 compases», «2 compases + 1 tiempo», «3 tiempos» */
  function barsTxt() { const b = Math.round(loopBeats() * 1000) / 1000, c = Math.floor(b / 4 + 1e-6), r = Math.round((b - c * 4) * 1000) / 1000; const ct = c ? c + (c === 1 ? ' compás' : ' compases') : ''; const rt = r ? (String(r).replace('.', ',') + (r === 1 ? ' tiempo' : ' tiempos')) : ''; return ct && rt ? ct + ' + ' + rt : ct || rt || '0 tiempos'; }
  /* Después de grabar libre o convertir: el loop empieza en el primer sonido (ya en 0). Busca dónde acaba:
     1) si el patrón se repite (1, 2, 3, 4, 6 u 8 compases), se queda con la primera vuelta y ajusta el tempo a lo que tardaste;
     2) si el último golpe cae justo en un compás y es como el primero (el «uno» de la vuelta siguiente), lo quita y cierra ahí;
     3) si no, redondea al compás entero siguiente. Devuelve un texto para el aviso. */
  function fitLoop(part, allowTempo) {
    M.ls = 0;
    const ns = M[part].notes.slice().sort((a, b) => a.t - b.t); if (ns.length < 2) { M.bars = autoBars(endBeats()); return ''; }
    const key = n => part === 'd' ? n.l : n.p, last = ns[ns.length - 1].t;
    const rescale = (L, real) => { const k = L / real; if (!allowTempo || Math.abs(1 - k) > .08) return false; M.bpm = Math.round(M.bpm / k * 4) / 4; M[part].notes.forEach(n => { n.t *= k; if (n.d != null) n.d *= k; }); return true; };
    for (const P of [1, 2, 3, 4, 6, 8]) {
      const L = P * 4; if (last < L * 1.35) continue;
      const first = ns.filter(n => n.t < L - .3), later = ns.filter(n => n.t >= L - .3); if (first.length < 2 || later.length < 3) continue;
      let ok = 0; later.forEach(n => { const u = n.t % L; if (first.some(q => key(q) === key(n) && Math.min(Math.abs(u - q.t), L - Math.abs(u - q.t)) < .3)) ok++; });
      if (ok / later.length < .9) continue;
      // al revés: lo de la primera vuelta tiene que volver a sonar (si no, la 2.ª vuelta es una variación y el loop es más largo)
      const chk = first.filter(q => q.t + L <= last + .3); let back = 0;
      chk.forEach(q => { if (later.some(n => key(n) === key(q) && Math.abs(n.t - (q.t + L)) < .3)) back++; });
      if (!chk.length || back / chk.length < .9) continue;
      const nx = ns.find(n => n.t >= L - .4 && key(n) === key(ns[0]));   // el «uno» de la segunda vuelta marca el largo real
      let tempo = false; if (nx) tempo = rescale(L, nx.t);
      const reps = Math.round(last / L + .3);
      M[part].notes = M[part].notes.filter(n => n.t < L - .2);
      M.bars = P;
      return 'Has repetido el loop ' + (reps > 1 ? reps + ' veces' : '') + ': me quedo con la primera vuelta (' + barsTxt() + ')' + (tempo ? ' y ajusto el tempo a ' + M.bpm + ' BPM' : '') + '.';
    }
    const ln = ns[ns.length - 1], B = Math.round(ln.t / 4) * 4;
    if (B >= 4 && Math.abs(ln.t - B) < .35 && (key(ln) === key(ns[0]) || (part === 'd' && ln.l === 0))) {
      const tempo = rescale(B, ln.t);
      M[part].notes = M[part].notes.filter(n => n !== ln); M.bars = B / 4;
      return 'El último golpe era el «uno» de la vuelta siguiente: lo quito y el loop dura ' + barsTxt() + (tempo ? ' (tempo ajustado a ' + M.bpm + ' BPM)' : '') + '.';
    }
    M.bars = autoBars(endBeats());
    return 'Loop de ' + barsTxt() + ' (desde el primer sonido). Si sobra o falta, arrastra el final ▼ en el editor.';
  }

  /* ---------------- Sonidos ---------------- */
  let noiseBuf = null;
  function noise(c) { if (!noiseBuf || noiseBuf.sampleRate !== c.sampleRate) { const b = new AudioBuffer({ length: c.sampleRate, numberOfChannels: 1, sampleRate: c.sampleRate }), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; noiseBuf = b; } return noiseBuf; }
  function synthHit(c, dest, id, t, v) {
    const a = Math.pow(v / 127, 1.3), g = c.createGain(); g.connect(dest);
    const nz = (hp, dec, vol) => { const s = c.createBufferSource(), f = c.createBiquadFilter(); s.buffer = noise(c); f.type = 'highpass'; f.frequency.value = hp; s.connect(f); f.connect(g); g.gain.setValueAtTime(a * vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dec); s.start(t); s.stop(t + dec + .02); return s; };
    if (id === 'k') { const o = c.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + .12); g.gain.setValueAtTime(a, t); g.gain.exponentialRampToValueAtTime(.001, t + .3); o.connect(g); o.start(t); o.stop(t + .32); return { g, src: o }; }
    if (id === 's') { const s = nz(1200, .16, .8), o = c.createOscillator(), g2 = c.createGain(); o.frequency.value = 190; g2.gain.setValueAtTime(a * .5, t); g2.gain.exponentialRampToValueAtTime(.001, t + .1); o.connect(g2); g2.connect(dest); o.start(t); o.stop(t + .12); return { g, src: s }; }
    return { g, src: nz(7000, id === 'h' ? .05 : .35, .5) };
  }
  function hitIn(c, dest, li, t, v, chk) {
    const id = LANES[li].id, b = M.slots[li].buf; let h;
    if (b) { const s = c.createBufferSource(), g = c.createGain(); s.buffer = b; g.gain.value = Math.pow(v / 127, 1.3); s.connect(g); g.connect(dest); s.start(t); h = { g, src: s }; }
    else h = synthHit(c, dest, id, t, v);
    if (chk) { if (id === 'o') chk.open = h; else if (id === 'h' && chk.open) { const o = chk.open; chk.open = null; try { o.g.gain.cancelScheduledValues(t); o.g.gain.setTargetAtTime(0, t, .004); o.src.stop(t + .06); } catch (e) {} } }
    return h;
  }
  let drumOut = null, bassOut = null; const liveChk = {}, playChk = {};
  function outs() {
    if (!drumOut) { drumOut = ctx.createGain(); drumOut.gain.value = .9; drumOut.connect(typeof sampBus !== 'undefined' ? sampBus : ctx.destination); }
    if (!bassOut) { bassOut = ctx.createGain(); bassOut.connect(typeof bassBus !== 'undefined' ? bassBus : ctx.destination); }
  }
  /* realimentación: lo que suena por el altavoz vuelve al micro al cabo de la latencia de ida y vuelta.
     Con «altavoz», los golpes que llegan justo cuando volvería un sonido nuestro se ignoran. */
  function ownSound(t) { if (!M.spk) return; if (M.take && M.take.rec) M.take.own.push(t); M.own.push(t); const lim = ctx.currentTime - 2; while (M.own.length && M.own[0] < lim) M.own.shift(); }
  function isEcho(tc, list) {
    list = list || M.own; if (!M.spk || !list.length) return false;
    let lo, hi; if (M.latMeasured) { const l = (M.comp || 0) / 1000; lo = l - .07; hi = l + .17; } else { const e = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) + .03; lo = Math.max(.01, e * .5 - .03); hi = e * 2.5 + .2; }
    return list.some(t => tc - t >= lo && tc - t <= hi);
  }
  function hitLive(li, v, t) { ownSound(t || ctx.currentTime); M.liveHits = (M.liveHits || 0) + 1; outs(); hitIn(ctx, drumOut, li, t || ctx.currentTime, v, liveChk); }
  function click(t, strong) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = strong ? 1760 : 1175; g.gain.setValueAtTime(strong ? .35 : .22, t); g.gain.exponentialRampToValueAtTime(.001, t + .05); o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .06); }
  function newBass(c, dest) { try { return mkBass(c, dest, BP); } catch (e) { LOG('mkBass falla', e.message); return null; } }

  /* ---------------- Micro (en directo) ---------------- */
  const WORKLET = 'class T extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage({t:currentTime,d:c.slice(0)});return true}}registerProcessor("mbx-tap",T)';
  async function micOn(o) {
    o = o || {}; const aec = o.aec != null ? o.aec : !!(M.spk && M.aec);
    if (M.mic && M.mic.aec !== aec) micOff();
    if (M.mic) return true;
    try { await ctx.resume(); } catch (e) {}
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { flash('Este navegador no deja usar el micrófono.', true); return false; }
    let st;
    try { st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: aec, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { flash('Sin acceso al micrófono: ' + (e.name || e.message) + '. Da permiso al micro en el navegador.', true); step('micro denegado', e.name || e.message); return false; }
    const src = ctx.createMediaStreamSource(st), sil = ctx.createGain(); sil.gain.value = 0; sil.connect(ctx.destination);
    let node = null, kind = 'worklet';
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url); URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'mbx-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = e => onBlock(e.data.d, e.data.t);
    } catch (e) {
      kind = 'scriptprocessor'; LOG('AudioWorklet no disponible, uso ScriptProcessor', e.message);
      node = ctx.createScriptProcessor(512, 1, 1);
      node.onaudioprocess = e => onBlock(e.inputBuffer.getChannelData(0).slice(0), (e.playbackTime || ctx.currentTime) - 512 / ctx.sampleRate);
    }
    src.connect(node); node.connect(sil);
    M.mic = { st, src, node, sil, kind, sr: ctx.sampleRate, map: null, aec };
    resetLive();
    step('micro activo', kind + (aec ? ' · cancelación de eco' : '') + ' · ' + ctx.sampleRate + ' Hz · latencia salida ' + Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000) + ' ms');
    return true;
  }
  function micOff() {
    const m = M.mic; if (!m) return; M.mic = null;
    try { m.src.disconnect(); m.node.disconnect(); m.sil.disconnect(); } catch (e) {}
    try { m.st.getTracks().forEach(t => t.stop()); } catch (e) {}
    if (M.liveBass) try { M.liveBass.silence(ctx.currentTime); } catch (e) {}
    M.live = null; step('micro apagado');
  }
  /* detectores en directo: se recrean al cambiar de parte o de sensibilidad */
  function resetLive() {
    const sr = M.mic ? M.mic.sr : ctx.sampleRate;
    const L = { n0: null, t0: null, ns: 0, pend: [], cur: null };
    L.det = DrumDet(sr, s0 => L.pend.push(s0));
    L.seg = NoteSeg({
      on(c) { outs(); if (!M.liveBass) M.liveBass = newBass(ctx, bassOut); const t = ctx.currentTime, v = bassVel(c.rms); if (M.liveBass && monitorOn()) { M.liveBass.on('v', t, c.p); ownSound(t); } L.cur = { p: c.p, ctxT: L.toCtx(c.t), v }; show(nName(c.p)); takeNote({ t: L.toCtx(c.t), p: c.p, vel: v, open: true }); },
      off(c, t) { if (M.liveBass) M.liveBass.off('v', ctx.currentTime); takeClose(L.toCtx(t)); L.cur = null; }
    });
    L.trk = PitchTrk(sr, F => { if (M.part === 'b') L.seg.frame(F); });
    L.toCtx = s => (L.t0 == null ? ctx.currentTime : L.t0 + s - L.n0 / sr);   // s = segundos desde que se creó el detector activo
    M.live = L;
  }
  function onBlock(x, t) {
    const L = M.live, m = M.mic; if (!L || !m) return;
    if (L.t0 == null) { L.t0 = t; L.n0 = L.ns; }
    else { const exp = L.t0 + (L.ns - L.n0) / m.sr; if (Math.abs(exp - t) > .05) { L.t0 = t; L.n0 = L.ns; } }   // si el reloj salta, se vuelve a fijar
    let pk = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
    M.level = Math.max(pk, M.level * .9);
    if (M.take && M.take.rec) { if (!M.take.chunks.length) M.take.capT0 = t; M.take.chunks.push(x); }
    if (M.calib) M.calib.chunks.push(x);
    if (M.meas) { if (!M.meas.chunks.length) M.meas.t0 = t; M.meas.chunks.push(x); return; }
    if (M.part === 'd') {
      L.det.push(x); L.ns += x.length;
      const W = Math.round(m.sr * winSec(M.resp));
      while (L.pend.length && L.det.n >= L.pend[0] + W) {
        const s0 = L.pend.shift(), seg = L.det.read(s0, W), f = feats(seg, m.sr, W);
        if (noiseLike(f, W, m.sr) || masked(L.prev, s0 / m.sr, f.peak)) { LOG('descartado (soplido, cola o flojo)', Math.round(f.att) + ' ms', f.peak.toFixed(3)); continue; }
        if (isEcho(L.t0 + (s0 - L.n0) / m.sr)) { M.echoes = (M.echoes || 0) + 1; LOG('descartado: eco del altavoz'); continue; }
        L.prev = { t: s0 / m.sr, peak: f.peak };
        const id = classify(f, null, M.resp), li = LANES.findIndex(q => q.id === id), v = velOf(id, f.peak);
        if (!M.calib) { if (monitorOn()) hitLive(li, v); show(LANES[li].n); }
        const tc = L.t0 + (s0 - L.n0) / m.sr;
        takeNote({ t: tc, l: li, vel: v });
      }
    } else { L.trk.push(x); L.ns += x.length; }
  }
  const monitorOn = () => !(M.take && M.take.rec && !M.monRec);
  function show(txt) { M.lastHit = txt; const e = $m('#mbHit'); if (e) { e.textContent = txt; e.classList.remove('pop'); void e.offsetWidth; e.classList.add('pop'); } }

  /* ---------------- Grabación (toma) ---------------- */
  function busy() { return !!(M.take || M.calib); }
  async function recStart() {
    if (busy() || M.meas) return;
    const had = !!M.mic;
    if (!(await micOn())) return;
    if (!had) M.micByRec = true;   // el micro se encendió solo para grabar: se apaga al terminar
    stopPlay();
    const part = M.part, other = part === 'd' ? 'b' : 'd', hasOther = M[other].notes.length > 0;
    const timed = M.metro || hasOther, now = ctx.currentTime + .12, bar = 4 * spb();
    const t0 = timed ? now + (M.count ? bar : 0) : null;
    const auto = M.barsAuto;
    M.take = { part, timed, t0, end: timed && !auto ? t0 + loopSec() : null, notes: [], chunks: [], rec: true, own: [], capT0: ctx.currentTime, sr: M.mic.sr, before: snapNotes(), prevSrc: M[part].src, pendOpen: null };
    pushUndo();
    if (timed) {
      if (M.count) for (let b = 0; b < 4; b++) click(now + b * spb(), b === 0);
      startPlay(t0, { metro: M.metro, skip: M.overdub ? null : part, rec: true });
      flash((M.count ? 'Cuenta de un compás y graba ' + (auto ? 'hasta que pulses ■' : barsTxt()) + '…' : 'Grabando…') + (M.monRec ? '' : ' (sin oír ' + (part === 'd' ? 'la batería' : 'el bajo') + ')'));
    } else flash('Grabando: empieza cuando quieras. Pulsa ■ para terminar.' + (M.monRec ? '' : ' (sin oír ' + (part === 'd' ? 'la batería' : 'el bajo') + ')'));
    step('grabar', JSON.stringify({ part, timed, bpm: M.bpm, bars: auto ? 'auto' : M.bars, overdub: M.overdub, oir: M.monRec }));
    ui();
  }
  function takeNote(n) {
    const T = M.take; if (!T || !T.rec || T.part !== M.part) return;
    const comp = (M.comp || 0) / 1000, t = n.t - comp;
    if (T.timed) { if (t < T.t0 - .06) return; if (T.end != null && t >= T.end) return; }
    if (n.p != null) { T.pendOpen = { t, p: n.p, vel: n.vel }; return; }
    T.notes.push({ t, l: n.l, vel: n.vel });
  }
  function takeClose(tc) { const T = M.take; if (!T || !T.pendOpen) return; const o = T.pendOpen; T.pendOpen = null; o.d = Math.max(.03, tc - (M.comp || 0) / 1000 - o.t); if (T.end != null && o.t + o.d > T.end) o.d = T.end - o.t; if (o.d >= .04) T.notes.push(o); }
  function recTick() { const T = M.take; if (T && T.rec && T.end != null && ctx.currentTime > T.end + .15) recStop(); }
  /* análisis completo de un audio de voz → notas en segundos del propio audio */
  function analyzeX(x, sr, part) {
    const raw = part === 'd' ? analyzeDrums(x, sr) : analyzeBass(x, sr);
    return raw.map(n => part === 'd' ? { t: n.t, l: LANES.findIndex(q => q.id === n.id), vel: n.vel } : { t: n.t, p: n.p, d: n.d, vel: n.vel });
  }
  /* toma o audio (src) → notas en tiempos, siempre con el análisis completo */
  function srcRaw(src, part) {
    const x = src.buf.getChannelData(0), sr = src.buf.sampleRate;
    let raw = analyzeX(src.norm ? normCopy(x) : x, sr, part);
    if (src.own && src.own.length) raw = raw.filter(n => !isEcho(src.capT0 + n.t, src.own));   // ecos del altavoz grabados en la toma
    src.ons = raw.map(n => ({ t: n.t, l: n.l, p: n.p }));   // para el editor de la toma
    return raw;
  }
  function notesFromSrc(src, part, keepTempo) {
    let raw = srcRaw(src, part);
    if (src.timed) { raw = raw.filter(n => n.t - src.offset >= -.06 && (src.len == null || n.t - src.offset < src.len)); return { conv: toBeats(raw, src.offset, part), n: raw.length }; }
    if (!raw.length) return { conv: [], n: 0 };
    if (!keepTempo && M.tempoAuto !== false && !(part === 'd' ? M.b : M.d).notes.length) { const bpm = estTempo(raw.map(n => n.t)); if (bpm) M.bpm = bpm; }
    return { conv: toBeats(raw, raw[0].t, part), n: raw.length };
  }
  function normCopy(x) { let pk = 0; for (let i = 0; i < x.length; i += 2) { const a = Math.abs(x[i]); if (a > pk) pk = a; } if (!(pk > 1e-4 && pk < .5)) return x; const g = .5 / pk, o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x[i] * g; return o; }
  function recStop() {
    const T = M.take; if (!T) return;
    T.rec = false; M.take = null;
    if (T.pendOpen) takeClose(ctx.currentTime);
    if (M.liveBass) try { M.liveBass.silence(ctx.currentTime); } catch (e) {}
    stopPlay();
    if (M.micByRec) { M.micByRec = false; micOff(); }
    const len = T.chunks.reduce((a, c) => a + c.length, 0), sr = T.sr || ctx.sampleRate;
    let buf = null; if (len) { buf = ctx.createBuffer(1, len, sr); let o = 0; const d = buf.getChannelData(0); T.chunks.forEach(c => { d.set(c, o); o += c.length; }); }
    const comp = (M.comp || 0) / 1000;
    // la toma se analiza entera (mejor que lo oído en directo: ve la duración de los hats, la escala, etc.)
    const base = M.overdub ? M[T.part].notes.map(n => Object.assign({}, n)) : [];
    const src = buf ? { buf, timed: T.timed, offset: T.timed ? T.t0 - T.capT0 + comp : null, len: T.end != null ? T.end - T.t0 : null, name: 'Toma ' + new Date().toLocaleTimeString().slice(0, 5), base, live: T.timed, own: T.own.slice(), capT0: T.capT0 } : null;
    let conv = [], how = 'análisis completo';
    if (src) conv = notesFromSrc(src, T.part).conv;
    if (!conv.length && T.notes.length) {   // respaldo: lo detectado en directo
      const notes = T.notes.slice().sort((a, b) => a.t - b.t); how = 'directo';
      let origin = T.timed ? T.t0 : notes[0].t;
      if (!T.timed) { const bpm = estTempo(notes.map(n => n.t)); if (bpm && !M[T.part === 'd' ? 'b' : 'd'].notes.length) M.bpm = bpm; }
      conv = toBeats(notes, origin, T.part);
    }
    if (!conv.length) { M.undo.pop(); flash('No se ha detectado nada. Sube la sensibilidad o acércate al micro.', true); ui(); return; }
    M[T.part].notes = base.concat(conv);
    if (src) M[T.part].src = src;
    M.lastTake = { part: T.part, before: T.before, prevSrc: T.prevSrc };
    let fit = ''; if (!M.overdub) M.ls = 0;
    if (!T.timed && !M.overdub) fit = fitLoop(T.part, !M[T.part === 'd' ? 'b' : 'd'].notes.length);
    else if (M.barsAuto || !T.timed) M.bars = autoBars(endBeats());
    M.sel.clear();
    step('toma', conv.length + ' notas (' + how + ') · ' + M.bpm + ' BPM · ' + barsTxt());
    flash((T.part === 'd' ? conv.length + ' golpes' : conv.length + ' notas') + ' sin cuantizar · ' + M.bpm + ' BPM · ' + barsTxt() + '. ' + (fit ? fit + ' ' : '') + 'Si no te convence: cambia la sensibilidad y pulsa ⟳ Regenerar, o ↺ Descartar la toma.');
    saveSettings(); ui(); draw();
  }
  /* ---------- Editor de la toma: la onda de tu voz, con inicio y final del loop ---------- */
  const TK = { drag: null, act: 'e', node: null, peaks: null, pkKey: '' };
  function tkSel(src) {
    if (src.sel) return src.sel;
    if (!src.ons) srcRaw(src, M.part);
    const d = src.buf.duration;
    let a = src.timed ? src.offset : (src.ons.length ? Math.max(0, src.ons[0].t - .005) : 0);
    let b = a + (src.timed ? loopSec() : (P().notes.length ? loopBeats() * spb() : d - a));
    return (src.sel = { s: clamp(a, 0, d), e: clamp(b, a + .05, d) });
  }
  function tkPeaks(src, W) {
    const k = W + ':' + src.buf.length; if (TK.pkKey === k && TK.peaks) return TK.peaks;
    const x = src.buf.getChannelData(0), n = x.length, pk = new Float32Array(W); let mx = 1e-6;
    for (let i = 0; i < W; i++) { let m = 0; const a = Math.floor(i * n / W), b = Math.floor((i + 1) * n / W); for (let j = a; j < b; j += 2) { const v = Math.abs(x[j]); if (v > m) m = v; } pk[i] = m; if (m > mx) mx = m; }
    for (let i = 0; i < W; i++) pk[i] /= mx;
    TK.pkKey = k; return (TK.peaks = pk);
  }
  function tkDraw() {
    const box = $m('#mbTake'), src = P().src; if (!box) return;
    box.hidden = !(src && src.buf); if (box.hidden) return;
    const cv = $m('#mbWave'), W = Math.max(240, $m('#mbWaveBox').clientWidth - 2), H = 96, dpr = window.devicePixelRatio || 1;
    cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const d = src.buf.duration, X = t => t / d * W, sel = tkSel(src), pk = tkPeaks(src, W);
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#5b6573'; for (let i = 0; i < W; i++) { const h = pk[i] * (H - 22) / 2; g.fillRect(i, 14 + (H - 14) / 2 - h, 1, Math.max(1, h * 2)); }
    (src.ons || []).forEach(o => { g.fillStyle = M.part === 'd' && o.l != null && LANES[o.l] ? LANES[o.l].c : '#9be564'; g.fillRect(X(o.t), 14, 1.5, H - 14); });
    const xs = X(sel.s), xe = X(sel.e);
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 14, xs, H - 14); g.fillRect(xe, 14, W - xe, H - 14);
    [[xs, '#4fe3a0', 's'], [xe, '#c08bff', 'e']].forEach(([x, c, k]) => { g.strokeStyle = c; g.lineWidth = TK.act === k ? 3 : 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillStyle = c; g.fillRect(x - 7, 0, 14, 12); });
    if (TK.node && TK.node.pos != null) { g.fillStyle = '#fff'; g.fillRect(X(TK.node.pos), 14, 2, H - 14); }
    const inf = $m('#mbTakeInfo'); if (inf) { const dur = sel.e - sel.s, N = tkBars(dur); inf.textContent = 'Inicio ' + sel.s.toFixed(3).replace('.', ',') + ' s · duración ' + dur.toFixed(3).replace('.', ',') + ' s' + (N ? ' → ' + N + (N === 1 ? ' compás' : ' compases') + ' a ' + (Math.round(N * 240 / dur * 4) / 4) + ' BPM' : ' → ' + (Math.round(dur / spb() * 4) / 4) + ' tiempos a ' + M.bpm + ' BPM'); }
  }
  /* cuántos compases hay en la selección (auto: los que dan el tempo más parecido al actual, entre 65 y 170 BPM). 0 = mantener tempo */
  function tkBars(dur) {
    const v = ($m('#mbTakeBars') || {}).value || 'auto', other = (M.part === 'd' ? M.b : M.d).notes.length > 0;
    if (v === 'tempo' || other) return 0;
    if (v !== 'auto') return +v;
    let best = 1, bd = 1e9; [1, 2, 3, 4, 6, 8].forEach(N => { const b = N * 240 / dur; if (b < 65 || b > 170) return; const dd = Math.abs(Math.log(b / M.bpm)); if (dd < bd) { bd = dd; best = N; } });
    return best;
  }
  function tkBind() {
    const cv = $m('#mbWave'); if (!cv) return;
    const tAt = e => { const r = cv.getBoundingClientRect(), src = P().src; return clamp((e.clientX - r.left) / r.width, 0, 1) * src.buf.duration; };
    const snapOn = t => { const src = P().src; if (!$m('#mbTakeSnap').checked || !src.ons) return t; const r = cv.getBoundingClientRect(), tol = 14 / r.width * src.buf.duration; let best = t, bd = tol; src.ons.forEach(o => { const v = Math.max(0, o.t - .004); if (Math.abs(v - t) < bd) { bd = Math.abs(v - t); best = v; } }); return best; };
    cv.addEventListener('pointerdown', e => { const src = P().src; if (!src) return; const sel = tkSel(src), t = tAt(e), r = cv.getBoundingClientRect(), px = 1 / r.width * src.buf.duration;
      const ds = Math.abs(t - sel.s), de = Math.abs(t - sel.e); cv.setPointerCapture(e.pointerId);
      if (Math.min(ds, de) < 22 * px) TK.drag = { k: ds < de ? 's' : 'e' }; else if (t > sel.s && t < sel.e) TK.drag = { k: 'm', t0: t, s: sel.s, e: sel.e }; else TK.drag = { k: t < sel.s ? 's' : 'e' };
      if (TK.drag.k !== 'm') TK.act = TK.drag.k; tkMove(e); });
    const tkMove = e => { const D = TK.drag, src = P().src; if (!D || !src) return; const sel = tkSel(src), t = tAt(e), d = src.buf.duration;
      if (D.k === 's') sel.s = clamp(snapOn(t), 0, sel.e - .05); else if (D.k === 'e') sel.e = clamp(snapOn(t), sel.s + .05, d);
      else { const dt = t - D.t0, len = D.e - D.s; sel.s = clamp(snapOn(D.s + dt), 0, d - len); sel.e = sel.s + len; }
      tkLoopPts(); tkDraw(); };
    cv.addEventListener('pointermove', tkMove);
    const up = () => { TK.drag = null; }; cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    const on = (id, f) => { const e = $m(id); if (e) e.addEventListener('click', f); };
    on('#mbTakePlay', () => TK.node ? tkStop() : tkPlay());
    document.querySelectorAll('#mbxpanel [data-tn]').forEach(b => b.addEventListener('click', () => { const src = P().src; if (!src) return; const sel = tkSel(src), dt = +b.dataset.tn / 1000; if (TK.act === 's') sel.s = clamp(sel.s + dt, 0, sel.e - .05); else sel.e = clamp(sel.e + dt, sel.s + .05, src.buf.duration); tkLoopPts(); tkDraw(); }));
    document.querySelectorAll('#mbxpanel [data-tk]').forEach(b => b.addEventListener('click', () => { TK.act = b.dataset.tk; tkDraw(); }));
    const bs = $m('#mbTakeBars'); if (bs) bs.addEventListener('change', tkDraw);
    on('#mbTakeUse', safe('usar selección', tkApply));
    on('#mbTakeAuto', () => { const src = P().src; if (!src) return; src.sel = null; srcRaw(src, M.part); tkDraw(); });
  }
  function tkLoopPts() { const n = TK.node, src = P().src; if (!n || !src) return; const sel = tkSel(src); n.src.loopStart = sel.s; n.src.loopEnd = sel.e; }
  function tkPlay() {
    const src = P().src; if (!src) return; ctx.resume(); stopPlay(true); const sel = tkSel(src);
    const b = ctx.createBufferSource(), g = ctx.createGain(); b.buffer = src.buf; b.loop = true; b.loopStart = sel.s; b.loopEnd = sel.e; g.gain.value = .9; b.connect(g); g.connect(ctx.destination);
    const t0 = ctx.currentTime + .03; b.start(t0, sel.s); TK.node = { src: b, t0, pos: sel.s };
    const tick = () => { if (!TK.node || TK.node.src !== b) return; const s2 = tkSel(src), L = s2.e - s2.s, el = ctx.currentTime - t0; TK.node.pos = el < 0 ? s2.s : s2.s + (el % L); tkDraw(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick); const pb = $m('#mbTakePlay'); if (pb) pb.textContent = '■ Parar';
  }
  function tkStop() { const n = TK.node; TK.node = null; if (n) try { n.src.stop(); } catch (e) {} const pb = $m('#mbTakePlay'); if (pb) pb.textContent = '▶ Escuchar la selección'; tkDraw(); }
  /* ✓ Usar esta selección: el loop es exactamente lo marcado. Las notas se sacan del audio de dentro, desde el inicio marcado */
  function tkApply() {
    const part = M.part, src = P().src; if (!src || !src.buf) return; const sel = tkSel(src), dur = sel.e - sel.s; tkStop();
    const raw = srcRaw(src, part).filter(n => n.t >= sel.s - .03 && n.t < sel.e - .03);
    if (!raw.length) return flash('No hay golpes dentro de la selección.', true);
    pushUndo();
    const N = tkBars(dur); let beats;
    if (N) { M.bpm = Math.round(N * 240 / dur * 4) / 4; beats = N * 4; } else beats = Math.max(.25, Math.round(dur / spb() * 4) / 4);
    const conv = toBeats(raw, sel.s, part);
    M[part].notes = (src.base || []).map(n => Object.assign({}, n, { id: M.nid++ })).concat(conv);
    M.ls = 0; M.bars = beats / 4; M.barsAuto = false; M.sel.clear(); M.lastTake = M.lastTake; saveSettings(); ui(); draw(); tkDraw();
    flash('Loop marcado: ' + conv.length + (part === 'd' ? ' golpes' : ' notas') + ' · ' + barsTxt() + ' a ' + M.bpm + ' BPM, empezando en lo que marcaste. Ajusta más en el editor de abajo o «Deshacer».');
    step('usar selección', sel.s.toFixed(3) + '–' + sel.e.toFixed(3) + ' s · ' + barsTxt() + ' · ' + M.bpm);
  }
  /* ⟳ Regenerar: vuelve a analizar el audio guardado con los ajustes actuales (sensibilidad, ruido, calibración, octava, escala) */
  async function regenerate() {
    const part = M.part, src = M[part].src; if (!src || !src.buf) return flash('No hay toma ni audio guardado que regenerar.');
    const { conv } = notesFromSrc(src, part, true);
    if (!conv.length) return flash('Con estos ajustes no sale nada: sube la sensibilidad y vuelve a pulsar ⟳ Regenerar.', true);
    pushUndo();
    M[part].notes = (src.base || []).map(n => Object.assign({}, n, { id: M.nid++ })).concat(conv);
    M.sel.clear(); ui(); draw();
    const cnt = {}; if (part === 'd') conv.forEach(n => cnt[n.l] = (cnt[n.l] || 0) + 1);
    flash('Regenerado con sensibilidad ' + M.sens + ': ' + (part === 'd' ? conv.length + ' golpes (' + LANES.map((L, i) => (cnt[i] || 0) + ' ' + L.n.toLowerCase()).join(', ') + ')' : conv.length + ' notas') + '. «Deshacer» vuelve al anterior.');
    step('regenerar', conv.length + ' notas · sens ' + M.sens);
  }
  /* ↺ Descartar la toma: todo como antes de grabarla */
  function discardTake() {
    const L = M.lastTake; if (!L || L.part !== M.part) return flash('No hay una toma reciente de ' + (M.part === 'd' ? 'batería' : 'bajo') + ' que descartar.');
    pushUndo(); restore(L.before); M[L.part].src = L.prevSrc; M.lastTake = null; ui();
    flash('Toma descartada. Pulsa ● Grabar para repetirla.'); step('descartar toma');
  }
  /* 🤫 Medir ruido: 2 s de silencio (o respirando como al hacer beatbox) → umbral por encima del ruido */
  async function measureNoise() {
    if (busy() || M.meas) return; const had = !!M.mic; if (!(await micOn())) return;
    M.meas = { chunks: [] }; ui(); flash('Midiendo el ruido 2,5 s: quédate en silencio, o respira como cuando haces beatbox (sin hacer sonidos)…');
    await new Promise(r => setTimeout(r, 2500));
    const C = M.meas; M.meas = null; if (!had) micOff();
    const x = new Float32Array(C.chunks.reduce((a, c) => a + c.length, 0)); let o = 0; C.chunks.forEach(c => { x.set(c, o); o += c.length; });
    const sr = ctx.sampleRate, kA = 1 - Math.exp(-1 / (.0005 * sr)), kR = Math.exp(-1 / (.03 * sr)); let e = 0, eh = 0, pv = 0, me = 0, mh = 0, mr = 0;
    const skip = Math.round(sr * .2), F = Math.round(sr * .02);
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]), d = Math.abs(x[i] - pv); pv = x[i]; e = a > e ? e + (a - e) * kA : e * kR; eh = d > eh ? eh + (d - eh) * kA : eh * kR; if (i > skip) { if (e > me) me = e; if (eh > mh) mh = eh; } }
    for (let i = skip; i + F <= x.length; i += F) { let q = 0; for (let j = 0; j < F; j++) q += x[i + j] * x[i + j]; mr = Math.max(mr, Math.sqrt(q / F)); }
    if (!me) return flash('No llega sonido del micro.', true);
    M.noise = { env: me, envH: mh, rms: mr }; saveSettings(); if (M.mic) resetLive(); ui();
    flash('Ruido medido: ' + (20 * Math.log10(me)).toFixed(0) + ' dB. Ya no se dispara nada por debajo del doble de eso. Si ahora cuesta que entren los golpes suaves, sube la sensibilidad o pulsa «Quitar».');
    step('ruido', JSON.stringify(M.noise));
  }
  /* ⏱ Medir latencia: suenan 6 clics por el altavoz y el micro los oye; el retraso (ida y vuelta) es el ajuste de latencia de las tomas */
  async function measureLatency() {
    if (busy() || M.meas) return; const had = !!M.mic; if (!(await micOn({ aec: false }))) return;   // sin cancelación: tiene que oír los clics
    stopPlay(); M.meas = { chunks: [] }; ui();
    flash('Midiendo: quítate los auriculares (o ponlos junto al micro), sube el volumen y no hables. Van a sonar 6 clics…');
    await new Promise(r => setTimeout(r, 300));
    const start = ctx.currentTime + .4, gap = 1, clicks = [];
    for (let k = 0; k < 6; k++) { const t = start + k * gap; clicks.push(t); const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'square'; o.frequency.value = 1500; g.gain.setValueAtTime(.9, t); g.gain.exponentialRampToValueAtTime(.001, t + .03); o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + .04); }
    await new Promise(r => setTimeout(r, (start - ctx.currentTime + 6 * gap + .5) * 1000));
    const C = M.meas; M.meas = null; micOff();
    if (!C || !C.chunks.length) { ui(); return flash('No llega sonido del micro.', true); }
    const x = new Float32Array(C.chunks.reduce((a, c) => a + c.length, 0)); let o = 0; C.chunks.forEach(c => { x.set(c, o); o += c.length; });
    const sr = ctx.sampleRate, ons = [], sens = M.sens, nz = M.noise; M.sens = 9; M.noise = null;
    try { const det = DrumDet(sr, s0 => ons.push(C.t0 + s0 / sr)); for (let i = 0; i < x.length; i += 1024) det.push(x.subarray(i, Math.min(x.length, i + 1024))); } finally { M.sens = sens; M.noise = nz; }
    const d = clicks.map(t => { const c = ons.filter(u => u - t > -.005 && u - t < .9); return c.length ? c[0] - t : null; }).filter(v => v != null).sort((a, b) => a - b);
    ui(); step('latencia (medida)', 'bloques ' + C.chunks.length + ' · golpes ' + ons.length + ' · ' + ons.slice(0, 8).map(u => u.toFixed(3)).join(',') + ' · clics ' + clicks.map(u => u.toFixed(3)).join(','));
    if (d.length < 4) return flash('Solo he oído ' + d.length + ' de 6 clics. Sube el volumen, quita los auriculares y repite.', true);
    const med = d[d.length >> 1], spread = d[d.length - 1] - d[0];
    M.comp = Math.round(clamp(med * 1000, 0, 500)); M.latMeasured = true; saveSettings(); if (had) await micOn(); ui();
    flash('Latencia medida: ' + M.comp + ' ms (ida y vuelta, ' + d.length + '/6 clics' + (spread > .03 ? ', variable ±' + Math.round(spread * 500) + ' ms' : '') + '). Ya está puesta en el ajuste: las tomas a tempo caen en su sitio. En directo ese retraso no se puede quitar: para grabar, desmarca «Oír mientras grabo».' + (M.comp > 150 ? ' Es alto: si usas auriculares Bluetooth, con cable baja mucho.' : ''));
    step('latencia', M.comp + ' ms · ' + d.map(v => Math.round(v * 1000)).join(','));
  }
  function toBeats(notes, origin, part) {
    const s = spb();
    return notes.map(n => part === 'd' ? { id: M.nid++, t: Math.max(0, (n.t - origin) / s), l: n.l, v: n.vel } : { id: M.nid++, t: Math.max(0, (n.t - origin) / s), p: n.p, d: Math.max(.05, n.d / s), v: n.vel });
  }
  const endBeats = () => Math.max(0, ...M.d.notes.map(n => n.t + .25), ...M.b.notes.map(n => n.t + n.d));

  /* ---------------- Convertir un audio (archivo, pad o la toma) ---------------- */
  async function toMono(b) {
    const sr = b.sampleRate, x = new Float32Array(b.length);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / b.numberOfChannels; }
    let pk = 0; for (let i = 0; i < x.length; i += 2) { const a = Math.abs(x[i]); if (a > pk) pk = a; }
    if (pk > 1e-4 && pk < .5) { const g = .5 / pk; for (let i = 0; i < x.length; i++) x[i] *= g; }   // un audio flojo se normaliza para que detecte igual
    return { x, sr };
  }
  async function convertBuffer(b, name, opts) {
    opts = opts || {};
    const part = opts.part || M.part; step('convertir', (name || '?') + ' · ' + b.duration.toFixed(2) + ' s · ' + (part === 'd' ? 'batería' : 'bajo'));
    if (b.duration > 120) { flash('El audio dura más de 2 minutos: corta antes el trozo en el sampler.', true); return 0; }
    const { x, sr } = await toMono(b);
    const raw = part === 'd' ? analyzeDrums(x, sr) : analyzeBass(x, sr);   // (toMono ya normaliza los archivos flojos)
    if (!raw.length) { flash('No encuentro ' + (part === 'd' ? 'golpes' : 'notas') + ' claros en ese audio.', true); return 0; }
    pushUndo();
    let origin = raw[0].t;
    if (opts.offset != null) origin = opts.offset;   // la toma grabada a tempo conserva su posición
    else if (M.tempoAuto !== false && !(part === 'd' ? M.b : M.d).notes.length) { const bpm = estTempo(raw.map(n => n.t)); if (bpm) M.bpm = bpm; }
    const conv = toBeats(raw.map(n => part === 'd' ? { t: n.t, l: LANES.findIndex(q => q.id === n.id), vel: n.vel } : { t: n.t, p: n.p, d: n.d, vel: n.vel }), origin, part);
    M[part].notes = conv;
    if (!opts.keepSrc) { const mb = ctx.createBuffer(1, x.length, sr); mb.copyToChannel(x, 0); M[part].src = { buf: mb, timed: false, offset: null, name: name || 'audio', live: false, base: [] }; M.lastTake = null; }
    let fit = '';
    if (opts.offset == null) fit = fitLoop(part, !(part === 'd' ? M.b : M.d).notes.length); else if (M.barsAuto) M.bars = autoBars(endBeats());
    M.sel.clear(); saveSettings(); ui(); draw();
    const cnt = {}; if (part === 'd') conv.forEach(n => cnt[n.l] = (cnt[n.l] || 0) + 1);
    flash((part === 'd' ? conv.length + ' golpes (' + LANES.map((L, i) => (cnt[i] || 0) + ' ' + L.n.toLowerCase()).join(', ') + ')' : conv.length + ' notas (' + nName(Math.min(...conv.map(n => n.p))) + '–' + nName(Math.max(...conv.map(n => n.p))) + ')') + ' · ' + M.bpm + ' BPM · ' + barsTxt() + ' · sin cuantizar.' + (fit ? ' ' + fit : ''));
    step('convertido', conv.length + ' notas'); return conv.length;
  }
  async function fromFile(f) {
    if (!f) return; M.lastFile = { name: f.name, size: f.size, type: f.type };
    try { const b = await ctx.decodeAudioData(await f.arrayBuffer()); await convertBuffer(b, f.name.replace(/\.[^.]+$/, '')); }
    catch (e) { flash('No se pudo leer ese audio: ' + (e.message || e), true); reportError('cargar audio', e); }
  }
  async function fromPad() {
    const p = pads[sel]; if (!p || !p.buf) return flash('Elige antes un pad con la grabación de tu voz.');
    let b; try { b = region(p); } catch (e) { b = p.buf; }
    M.lastFile = { name: 'pad ' + (sel + 1) + ' ' + (p.name || ''), size: b.length, type: 'pad' };
    await convertBuffer(b, p.name || 'Pad ' + (sel + 1));
  }

  /* ---------------- Calibración ---------------- */
  async function calibrate(li) {
    if (busy()) return; if (!(await micOn())) return;
    const L = LANES[li], secs = 3.5;
    M.calib = { li, chunks: [] }; ui();
    flash('Haz «' + L.n + '» (' + L.voz + ') 5 o 6 veces, con pausas, durante ' + secs + ' s…');
    step('calibrar', L.n);
    setTimeout(() => {
      const C = M.calib; M.calib = null; if (!C) return;
      const len = C.chunks.reduce((a, c) => a + c.length, 0), x = new Float32Array(len); let o = 0; C.chunks.forEach(c => { x.set(c, o); o += c.length; });
      const sr = M.mic ? M.mic.sr : ctx.sampleRate, ons = []; const det = DrumDet(sr, s0 => ons.push(s0));
      for (let i = 0; i < x.length; i += 1024) det.push(x.subarray(i, Math.min(x.length, i + 1024)));
      const Wf = Math.round(sr * winSec('fast')), Wp = Math.round(sr * winSec('precise'));
      const ex = ons.map((s0, i) => { if (s0 + Wp > x.length) return null; const ff = feats(x.subarray(s0, s0 + Wf), sr, Wf), fp = feats(x.subarray(s0, s0 + Wp), sr, Wp); return { v25: ff.v, v45: fp.v, peak: fp.peak, dur: hitDur(x, s0, sr, i + 1 < ons.length ? ons[i + 1] : x.length) }; }).filter(Boolean).slice(0, 12);
      if (ex.length < 2) { flash('Solo he oído ' + ex.length + ' golpe' + (ex.length === 1 ? '' : 's') + '. Repite más cerca del micro o sube la sensibilidad.', true); ui(); return; }
      M.cal[L.id] = ex; saveCal();
      flash(L.n + ': ' + ex.length + ' ejemplos guardados.' + (calReady() ? ' Calibración lista: ahora se usa tu voz para distinguir los golpes.' : ' Faltan: ' + ['k', 's', 'h'].filter(id => M.cal[id].length < 3).map(id => LANES.find(q => q.id === id).n).join(', ') + '.'));
      step('calibrado', L.n + ' ' + ex.length); ui();
    }, secs * 1000);
  }

  /* ---------------- Reproducción del bucle ---------------- */
  function startPlay(t0, o) {
    stopPlay(true); outs(); o = o || {};
    const pl = { t0: t0 || ctx.currentTime + .08, sched: 0, timer: 0, o, bass: newBass(ctx, bassOut), raf: 0 };
    pl.sched = pl.t0;
    const tick = () => {
      const now = ctx.currentTime, hz = now + .15, L = loopSec(), s = spb();
      if (!L) return;
      for (let c = Math.max(0, Math.floor((pl.sched - pl.t0) / L)); pl.t0 + c * L < hz; c++) {
        const cs = pl.t0 + c * L;
        if (pl.o.metro) for (let b = 0; b < loopBeats(); b++) { const a = cs + b * s; if (a >= pl.sched && a < hz) click(a, b % 4 === 0); }
        if (M.playD && pl.o.skip !== 'd') RN('d').forEach(n => { const a = cs + n.t * s; if (a >= pl.sched && a < hz) hitIn(ctx, drumOut, n.l, Math.max(a, now), n.v, playChk); });
        if (M.playB && pl.o.skip !== 'b' && pl.bass) RN('b').forEach(n => { const a = cs + n.t * s; if (a >= pl.sched && a < hz) { pl.bass.on(n.id, Math.max(a, now), n.p); pl.bass.off(n.id, Math.max(a, now) + Math.max(.03, n.d * s * .98)); } });
      }
      pl.sched = hz; recTick();
    };
    pl.timer = setInterval(tick, 25); tick();
    const paint = () => { if (M.player !== pl) return; drawHead(); pl.raf = requestAnimationFrame(paint); };
    M.player = pl; pl.raf = requestAnimationFrame(paint); ui();
  }
  function stopPlay(quiet) {
    const pl = M.player; if (!pl) return; M.player = null;
    clearInterval(pl.timer); cancelAnimationFrame(pl.raf);
    try { pl.bass && pl.bass.silence(ctx.currentTime); } catch (e) {}
    if (!quiet) { draw(); ui(); }
  }
  function playPos() { const pl = M.player; if (!pl) return null; const L = loopSec(), e = ctx.currentTime - pl.t0; if (e < 0) return null; return ((e % L) / spb()); }

  /* ---------------- Editor ---------------- */
  const ED = { lw: 56, rowH: 30, rows: [], ppb: 40, drag: null, lastTap: 0 };
  function snapNotes() { return JSON.stringify({ d: M.d.notes, b: M.b.notes, bpm: M.bpm, bars: M.bars, ls: M.ls }); }
  function pushUndo() { M.undo.push(snapNotes()); if (M.undo.length > 60) M.undo.shift(); M.redo = []; }
  function restore(s) { const o = JSON.parse(s); M.d.notes = o.d; M.b.notes = o.b; M.bpm = o.bpm; M.bars = o.bars; M.ls = o.ls || 0; M.sel.clear(); ui(); draw(); }
  function undo() { if (!M.undo.length) return flash('Nada que deshacer.'); M.redo.push(snapNotes()); restore(M.undo.pop()); }
  function redo() { if (!M.redo.length) return; M.undo.push(snapNotes()); restore(M.redo.pop()); }
  function rowsFor() {
    if (M.part === 'd') return [3, 2, 1, 0].map(li => ({ key: li, lab: LANES[li].n, c: LANES[li].c }));
    const ps = M.b.notes.map(n => n.p); let lo = ps.length ? Math.min(...ps) - 3 : 31, hi = ps.length ? Math.max(...ps) + 3 : 50;
    while (hi - lo < 16) { lo--; if (hi - lo < 16) hi++; }
    const pcs = scalePcs(), r = []; for (let p = hi; p >= lo; p--) r.push({ key: p, lab: nName(p), c: '#9be564', inSc: pcs ? pcs.has(((p % 12) + 12) % 12) : true }); return r;
  }
  function layout() {
    const cv = $m('#mbRoll'), box = $m('#mbRollBox'); if (!cv || !box) return null;
    ED.rows = rowsFor(); ED.rowH = M.part === 'd' ? 34 : (matchMedia('(pointer:coarse)').matches ? 19 : 15);
    const beats = visBeats(), avail = Math.max(260, box.clientWidth - 2);
    ED.ppb = Math.max((avail - ED.lw) / beats, 26);
    const W = Math.ceil(ED.lw + ED.ppb * beats), H = ED.rows.length * ED.rowH + 18, dpr = window.devicePixelRatio || 1;
    cv.style.width = W + 'px'; cv.style.height = H + 'px'; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, W, H };
  }
  const rowOf = n => M.part === 'd' ? ED.rows.findIndex(r => r.key === n.l) : ED.rows.findIndex(r => r.key === n.p);
  function noteRect(n) { const r = rowOf(n), x = ED.lw + n.t * ED.ppb, y = 18 + r * ED.rowH + 2, w = M.part === 'd' ? Math.max(7, ED.ppb * .14) : Math.max(5, n.d * ED.ppb), h = ED.rowH - 4; return { x, y, w, h, r }; }
  const visBeats = () => ED.fixVB || Math.max(M.ls + loopBeats() + 4, Math.ceil(Math.max(0, ...P().notes.map(n => n.t + (n.d || .25))) + .01));
  const maxT = () => visBeats() - 1e-3;
  function draw() {
    try { tkDraw(); } catch (e) {}
    const L = layout(); if (!L) return; const { g, W, H } = L, beats = loopBeats(), vb = visBeats();
    g.clearRect(0, 0, W, H); g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, H);
    ED.rows.forEach((r, i) => { const y = 18 + i * ED.rowH; g.fillStyle = M.part === 'b' ? (r.inSc ? (i % 2 ? '#151a20' : '#12161b') : '#0d0f12') : (i % 2 ? '#151a20' : '#11151a'); g.fillRect(ED.lw, y, W - ED.lw, ED.rowH); g.fillStyle = r.c; g.globalAlpha = M.part === 'b' && !r.inSc ? .45 : .9; g.font = (M.part === 'd' ? '600 12px' : '10px') + ' Barlow,system-ui,sans-serif'; g.fillText(r.lab, 6, y + ED.rowH / 2 + 4); g.globalAlpha = 1; });
    const q = M.grid; for (let b = 0; b <= vb + 1e-6; b += q) { const x = ED.lw + b * ED.ppb, bar = Math.abs(b / 4 - Math.round(b / 4)) < 1e-6, beat = Math.abs(b - Math.round(b)) < 1e-6; g.strokeStyle = bar ? '#5b6573' : beat ? '#323945' : '#1d222a'; g.lineWidth = bar ? 1.5 : 1; g.beginPath(); g.moveTo(x + .5, bar ? 0 : 18); g.lineTo(x + .5, H); g.stroke(); if (bar && b < beats) { g.fillStyle = '#8b95a3'; g.font = '11px Barlow,system-ui,sans-serif'; g.fillText(String(b / 4 + 1), x + 4, 13); } }
    P().notes.forEach(n => { const r = noteRect(n); if (r.r < 0) return; const c = M.part === 'd' ? LANES[n.l].c : '#9be564'; g.globalAlpha = .35 + .65 * n.v / 127; g.fillStyle = c; g.fillRect(r.x, r.y, r.w, r.h); g.globalAlpha = 1; if (M.sel.has(n.id)) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2); } if (n.t >= beats) { g.fillStyle = 'rgba(255,80,80,.5)'; g.fillRect(r.x, r.y, r.w, 3); } });
    { const xs = ED.lw + M.ls * ED.ppb, xe = xs + beats * ED.ppb; g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(xe, 18, W - xe, H - 18); g.fillRect(ED.lw, 18, xs - ED.lw, H - 18);   // fuera del loop: en sombra
      g.strokeStyle = '#4fe3a0'; g.lineWidth = 2; g.beginPath(); g.moveTo(xs, 0); g.lineTo(xs, H); g.stroke();
      g.fillStyle = '#4fe3a0'; g.beginPath(); g.moveTo(xs, 0); g.lineTo(xs + 13, 7); g.lineTo(xs, 15); g.closePath(); g.fill();
      g.strokeStyle = '#c08bff'; g.lineWidth = 2; g.beginPath(); g.moveTo(xe, 0); g.lineTo(xe, H); g.stroke();
      g.fillStyle = '#c08bff'; g.beginPath(); g.moveTo(xe - 9, 0); g.lineTo(xe + 9, 0); g.lineTo(xe, 15); g.closePath(); g.fill(); }
    const ghost = M.part === 'd' ? M.b.notes : M.d.notes;   // la otra parte, en sombra, como referencia
    g.fillStyle = 'rgba(255,255,255,.07)'; ghost.forEach(n => { const x = ED.lw + n.t * ED.ppb; g.fillRect(x, 18, M.part === 'd' ? Math.max(2, n.d * ED.ppb) : 2, 4); });
    drawHead();
    const info = $m('#mbSelInfo'); if (info) { const s = selNotes(); info.textContent = s.length ? s.length + ' seleccionada' + (s.length > 1 ? 's' : '') + (s.length === 1 ? ' · ' + (M.part === 'd' ? LANES[s[0].l].n : nName(s[0].p)) + ' · tiempo ' + (s[0].t / 4 + 1 | 0) + '.' + ((s[0].t % 4) + 1).toFixed(2) + ' · vel ' + s[0].v : '') : P().notes.length + (M.part === 'd' ? ' golpes' : ' notas'); }
    const vs = $m('#mbVel'); if (vs) { const s = selNotes(); vs.disabled = !s.length; if (s.length) vs.value = Math.round(s.reduce((a, n) => a + n.v, 0) / s.length); }
  }
  function drawHead() {
    const hd = $m('#mbHead'), cv = $m('#mbRoll'); if (!hd || !cv) return;
    const p = playPos(); if (p == null) { hd.style.display = 'none'; return; }
    hd.style.display = 'block'; hd.style.left = (ED.lw + (M.ls + p) * ED.ppb) + 'px'; hd.style.height = cv.style.height;
  }
  const selNotes = () => P().notes.filter(n => M.sel.has(n.id));
  function hitTest(x, y) { const ns = P().notes; for (let i = ns.length - 1; i >= 0; i--) { const r = noteRect(ns[i]); if (x >= r.x - 3 && x <= r.x + r.w + 3 && y >= r.y && y <= r.y + r.h) return { n: ns[i], r }; } return null; }
  const snapT = t => M.magnet ? Math.round(t / M.grid) * M.grid : t;
  function preview(n) { try { ctx.resume(); outs(); if (M.part === 'd') hitLive(n.l, n.v); else { const b = newBass(ctx, bassOut); if (b) { b.on('p', ctx.currentTime, n.p); b.off('p', ctx.currentTime + Math.min(.6, n.d * spb())); } } } catch (e) {} }
  function bindRoll() {
    const cv = $m('#mbRoll'); if (!cv) return;
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', e => {
      const p = pos(e), now = performance.now();
      cv.setPointerCapture(e.pointerId);
      { const xs = ED.lw + M.ls * ED.ppb, xe = xs + loopBeats() * ED.ppb;
        if (p.y < 34 && (p.y < 18 || Math.min(Math.abs(p.x - xs), Math.abs(p.x - xe)) < 12)) { ED.fixVB = visBeats(); ED.drag = { mode: Math.abs(p.x - xs) < Math.abs(p.x - xe) ? 'start' : 'end', moved: false }; return; } }
      const h = hitTest(p.x, p.y);
      if (h) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) { M.sel.has(h.n.id) ? M.sel.delete(h.n.id) : M.sel.add(h.n.id); }
        else if (!M.sel.has(h.n.id)) { M.sel.clear(); M.sel.add(h.n.id); }
        const mode = M.part === 'b' && p.x > h.r.x + h.r.w - 7 && h.r.w > 12 ? 'len' : 'move';
        ED.drag = { mode, x0: p.x, y0: p.y, anchor: h.n, moved: false, orig: selNotes().map(n => ({ n, t: n.t, d: n.d, r: rowOf(n) })) };
        preview(h.n); draw();
      } else {
        if (now - ED.lastTap < 350 && Math.abs(p.x - ED.lastX) < 14 && Math.abs(p.y - ED.lastY) < 14) { addAt(p); ED.lastTap = 0; return; }
        ED.lastTap = now; ED.lastX = p.x; ED.lastY = p.y;
        if (M.sel.size) { M.sel.clear(); draw(); }
      }
    });
    cv.addEventListener('pointermove', e => {
      const D = ED.drag; if (!D) return; const p = pos(e);
      if (D.mode === 'end' || D.mode === 'start') {
        const q = M.magnet ? M.grid : .25, x = Math.round((p.x - ED.lw) / ED.ppb / q) * q, e0 = M.ls + loopBeats();
        let ns = M.ls, nb = loopBeats();
        if (D.mode === 'end') nb = clamp(x - M.ls, q, Math.min(64, visBeats() - M.ls)); else { ns = clamp(x, 0, e0 - q); nb = e0 - ns; }
        if (Math.abs(ns - M.ls) > 1e-6 || Math.abs(nb - loopBeats()) > 1e-6) { if (!D.moved) { pushUndo(); D.moved = true; } M.ls = ns; M.bars = nb / 4; ui(); }
        draw(); return; } const dx = (p.x - D.x0) / ED.ppb, dr = Math.round((p.y - D.y0) / ED.rowH);
      if (!D.moved && Math.abs(p.x - D.x0) < 3 && Math.abs(p.y - D.y0) < 3) return;
      if (!D.moved) { pushUndo(); D.moved = true; }
      if (D.mode === 'len') { D.orig.forEach(o => { o.n.d = Math.max(1 / 32, M.magnet ? Math.max(M.grid, snapT(o.t + o.d + dx) - o.t) : o.d + dx); }); }
      else {
        const a = D.orig.find(o => o.n === D.anchor) || D.orig[0], nt = snapT(a.t + dx), delta = nt - a.t;
        D.orig.forEach(o => { o.n.t = clamp(o.t + delta, 0, maxT()); const ri = clamp(o.r + dr, 0, ED.rows.length - 1); if (M.part === 'd') o.n.l = ED.rows[ri].key; else o.n.p = ED.rows[ri].key; });
      }
      draw();
    });
    const up = () => { const D = ED.drag; ED.drag = null; if (D && (D.mode === 'end' || D.mode === 'start')) { ED.fixVB = 0; saveSettings(); draw(); ui(); if (D.moved) flash('Loop de ' + barsTxt() + (M.ls ? ', empieza en el tiempo ' + (M.ls + 1).toFixed(2).replace(/\.?0+$/, '').replace('.', ',') : '') + '. Lo que queda en sombra no suena ni se exporta. ✂ Consolidar lo deja como secuencia definitiva.'); return; } if (D && D.moved) { P().notes.sort((a, b) => a.t - b.t); if (M.part === 'd' && D.orig.length === 1) preview(D.orig[0].n); draw(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }
  function addAt(p) {
    const ri = Math.floor((p.y - 18) / ED.rowH); if (ri < 0 || ri >= ED.rows.length) return;
    const t = clamp(M.magnet ? Math.floor((p.x - ED.lw) / ED.ppb / M.grid) * M.grid : (p.x - ED.lw) / ED.ppb, 0, maxT());
    pushUndo();
    const n = M.part === 'd' ? { id: M.nid++, t, l: ED.rows[ri].key, v: 100 } : { id: M.nid++, t, p: ED.rows[ri].key, d: Math.max(M.grid, .25), v: 100 };
    P().notes.push(n); P().notes.sort((a, b) => a.t - b.t); M.sel.clear(); M.sel.add(n.id); preview(n); draw();
  }
  /* ✂ Consolidar (como Ctrl+J de Ableton): lo que hay entre el inicio y el final pasa a ser la secuencia; lo de fuera se borra */
  function consolidate() {
    const L = loopBeats(); if (!M.d.notes.length && !M.b.notes.length) return flash('No hay notas.');
    pushUndo();
    let out = 0; ['d', 'b'].forEach(k => { const keep = M[k].notes.filter(inR); out += M[k].notes.length - keep.length; M[k].notes = keep.map(n => Object.assign(n, { t: n.t - M.ls }, n.d != null ? { d: Math.min(n.d, L - (n.t - M.ls)) } : {})); });
    M.ls = 0; M.sel.clear(); saveSettings(); ui(); draw();
    flash('Consolidado: la secuencia es ahora el loop de ' + barsTxt() + ' (batería y bajo)' + (out ? '; ' + out + ' nota' + (out > 1 ? 's' : '') + ' de fuera borrada' + (out > 1 ? 's' : '') : '') + '. «Deshacer» lo devuelve.');
    step('consolidar', barsTxt() + ' · fuera ' + out);
  }
  function delSel() { const s = selNotes(); if (!s.length) return flash('Toca una nota para elegirla (Mayús para varias).'); pushUndo(); P().notes = P().notes.filter(n => !M.sel.has(n.id)); M.sel.clear(); draw(); }
  function nudge(ms) { const s = selNotes(); if (!s.length) return flash('Elige antes las notas a mover.'); pushUndo(); const db = ms / 1000 / spb(); s.forEach(n => n.t = clamp(n.t + db, 0, maxT())); P().notes.sort((a, b) => a.t - b.t); draw(); }
  function transpose(k) { if (M.part !== 'b') return; const s = selNotes().length ? selNotes() : M.b.notes; if (!s.length) return; pushUndo(); s.forEach(n => n.p = clamp(n.p + k, 12, 96)); draw(); }
  function quantize() {
    const s = selNotes().length ? selNotes() : P().notes; if (!s.length) return flash('No hay notas que cuantizar.');
    pushUndo(); const q = +$m('#mbQGrid').value || M.grid, k = M.qStr / 100;
    s.forEach(n => { const tq = Math.round(n.t / q) * q; n.t = clamp(n.t + (tq - n.t) * k, 0, maxT()); if (M.part === 'b' && k >= 1) { const e = Math.max(tq + q / 2, Math.round((tq + n.d) / q) * q); n.d = Math.max(q / 2, e - tq); } });
    P().notes.sort((a, b) => a.t - b.t); draw(); flash('Cuantizado al ' + M.qStr + ' % (' + (selNotes().length ? 'selección' : 'todo') + '). «Deshacer» lo devuelve como estaba.');
  }

  /* ---------------- Exportar ---------------- */
  const whatParts = () => M.exp === 'd' ? ['d'] : M.exp === 'b' ? ['b'] : ['d', 'b'];
  const hasNotes = parts => parts.some(p => M[p].notes.length);
  async function render(parts) {
    const sr = ctx.sampleRate, L = loopSec(), tail = 1.2, n = Math.ceil(L * sr), s = spb();
    const off = new OfflineAudioContext(2, Math.ceil((L + tail) * sr), sr), out = off.createGain(); out.gain.value = .9; out.connect(off.destination);
    const chk = {};
    if (parts.includes('d')) RN('d').forEach(x => hitIn(off, out, x.l, x.t * s, x.v, chk));
    if (parts.includes('b')) { const bo = newBass(off, out); if (bo) RN('b').forEach(x => { bo.on(x.id, x.t * s, x.p); bo.off(x.id, x.t * s + Math.max(.03, x.d * s * .98)); }); }
    const r = await off.startRendering(), o = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) { const a = r.getChannelData(c), d = o.getChannelData(c); d.set(a.subarray(0, n)); for (let i = n; i < a.length; i++) d[i - n] += a[i]; }   // la cola vuelve al principio: el bucle encaja
    return o;
  }
  const baseName = parts => 'mid-box ' + (parts.length === 2 ? 'bateria+bajo' : parts[0] === 'd' ? 'bateria' : 'bajo') + ' ' + Math.round(M.bpm) + 'bpm';
  const fileName = (parts, ext) => baseName(parts).replace(/\s+/g, '_').replace(/\+/g, '-') + ext;
  async function toPad() {
    const parts = whatParts(); if (!hasNotes(parts)) return flash('No hay nada que exportar.');
    let t = pads[sel] && !pads[sel].buf ? sel : nextEmpty(sel); if (t == null || t < 0) return flash('No quedan pads libres: vacía uno.', true);
    step('a pad', parts.join('+'));
    const b = await render(parts), p = pads[t]; stop(t); resetPad(p); Object.assign(p, { buf: b, name: baseName(parts), loop: true }); labels(t);
    try { select(t); } catch (e) {}
    flash('Bucle en el pad ' + (typeof pl === 'function' ? pl(t) : t + 1) + ' (en bucle, ' + barsTxt() + ' a ' + Math.round(M.bpm) + ' BPM).');
  }
  async function wavOut() { const parts = whatParts(); if (!hasNotes(parts)) return flash('No hay nada que exportar.'); step('wav', parts.join('+')); const b = await render(parts); save(new Blob([SH && SH.wav ? SH.wav.encode(b, 24) : wav(b)], { type: 'audio/wav' }), fileName(parts, '.wav')); }
  function midiBytes(parts) {
    const ppq = 960, tick = b => Math.max(0, Math.round(b * ppq)), us = Math.round(60e6 / M.bpm), ev = [];
    const vlq = n => { const b = [n & 127]; while ((n >>= 7) > 0) b.unshift((n & 127) | 128); return b; };
    if (parts.includes('d')) RN('d').forEach(n => { ev.push([tick(n.t), 0x99, LANES[n.l].m, n.v]); ev.push([tick(n.t + .125), 0x89, LANES[n.l].m, 0]); });
    if (parts.includes('b')) RN('b').forEach(n => { ev.push([tick(n.t), 0x90, n.p, n.v]); ev.push([tick(Math.min(loopBeats(), n.t + n.d)), 0x80, n.p, 0]); });
    ev.sort((a, b) => a[0] - b[0] || (a[1] & 0xf0) - (b[1] & 0xf0));
    const name = [...unescape(encodeURIComponent(baseName(parts)))].map(c => c.charCodeAt(0));
    const trk = [0, 0xff, 0x03, name.length, ...name, 0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xff, 0x58, 4, 4, 2, 24, 8]; let last = 0;
    ev.forEach(e => { trk.push(...vlq(e[0] - last), e[1], e[2] & 127, e[3] & 127); last = e[0]; });
    trk.push(...vlq(Math.max(0, tick(loopBeats()) - last)), 0xff, 0x2f, 0);
    const tl = trk.length;
    return new Uint8Array([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 255, 77, 84, 114, 107, (tl >> 24) & 255, (tl >> 16) & 255, (tl >> 8) & 255, tl & 255, ...trk]);
  }
  function midiOut() { const parts = whatParts(); if (!hasNotes(parts)) return flash('No hay nada que exportar.'); save(new Blob([midiBytes(parts)], { type: 'audio/midi' }), fileName(parts, '.mid')); flash('MIDI sin cuantizar: batería en el canal 10 (36 bombo, 38 caja, 42 hat cerrado, 46 hat abierto), bajo en el canal 1.'); }
  /* bajo → tecla de la pestaña Bajo (16 teclas de su escala y octava) */
  function bassKey(m) { let best = 0, bd = 1e9; for (let k = 0; k < 16; k++) { const d = Math.abs(bMidi(k) - m); if (d < bd) { bd = d; best = k; } } return { k: best, exact: bd === 0 }; }
  async function toLooper() {
    if (typeof lp === 'undefined') return flash('Looper no disponible.', true);
    const parts = whatParts(); if (!hasNotes(parts)) return flash('No hay nada que mandar.');
    if (lp.st === 'rec1' || lp.st === 'armed') return flash('El Looper está grabando: páralo antes.', true);
    if (lp.ev.length && !confirm('El Looper ya tiene una grabación. ¿Sustituirla por la de mid-box?')) return;
    const s = spb(), ev = [], used = parts.includes('d') ? [...new Set(M.d.notes.map(n => n.l))] : [], padOf = {};
    for (const li of used) {
      let b = M.slots[li].buf;
      if (!b) { const off = new OfflineAudioContext(1, Math.ceil(ctx.sampleRate * .5), ctx.sampleRate); synthHit(off, off.destination, LANES[li].id, 0, 110); b = await off.startRendering(); }
      let t = pads.findIndex(p => p.buf === b);
      if (t < 0) { t = nextEmpty(sel); if (t == null || t < 0) return flash('No hay pads libres para los ' + used.length + ' sonidos de la batería: vacía alguno.', true); const p = pads[t]; stop(t); resetPad(p); Object.assign(p, { buf: b, name: 'mid-box ' + LANES[li].n, grp: LANES[li].id === 'h' || LANES[li].id === 'o' ? 1 : 0 }); labels(t); }
      padOf[li] = t;
    }
    lpClear();
    if (parts.includes('d')) RN('d').forEach(n => ev.push({ t: n.t * s, k: 'h', i: padOf[n.l], layer: 0, sess: 0, pass: -1, trk: 0 }));
    let off = 0;
    if (parts.includes('b')) RN('b').forEach(n => { const q = bassKey(n.p); if (!q.exact) off++; ev.push({ t: n.t * s, k: 'h', i: 64 + q.k, layer: 0, sess: 0, pass: -1, trk: 1 }); ev.push({ t: Math.min(loopSec() - .001, (n.t + n.d) * s), k: 'r', i: 64 + q.k, layer: 0, sess: 0, pass: -1, trk: 1 }); });
    ev.sort((a, b) => a.t - b.t);
    lp.ev = ev.slice(0, typeof LP_MAX === 'number' ? LP_MAX : 4000); lp.len = loopSec(); lp.oct = 1; lp.over = false; lp.st = 'stopped';
    try { lpTempoUpdate(); } catch (e) {} try { lpUI(); } catch (e) {}
    step('al looper', ev.length + ' eventos');
    flash('Secuencia en el Looper' + (parts.includes('d') ? ': batería en la pista 1 (pads ' + used.map(li => (typeof pl === 'function' ? pl(padOf[li]) : padOf[li] + 1) + ' ' + LANES[li].n.toLowerCase()).join(', ') + ')' : '') + (parts.includes('b') ? (parts.includes('d') ? ' y' : ':') + ' bajo en la pista 2 con el sonido de la pestaña Bajo' : '') + '. Ve al Looper y pulsa Play.' + (off ? ' Ojo: ' + off + ' nota' + (off > 1 ? 's' : '') + ' de bajo no está' + (off > 1 ? 'n' : '') + ' en la escala u octava de la pestaña Bajo y se ha' + (off > 1 ? 'n' : '') + ' llevado a la más cercana.' : '') + ' (El Looper no guarda la fuerza de cada golpe.)');
  }
  function toGen() {
    if (typeof G === 'undefined') return flash('Generador no disponible.', true);
    const parts = whatParts(); if (!hasNotes(parts)) return flash('No hay nada que mandar.');
    const bars = [1, 2, 4].filter(b => b <= Math.max(1, Math.round(M.bars))).pop() || 1, L = 16 * bars, beatsMax = bars * 4;
    if (parts.includes('d') && M.d.notes.length) {
      const pat = { k: new Array(L).fill(0), s: new Array(L).fill(0), h: new Array(L).fill(0), o: new Array(L).fill(0) };
      RN('d').filter(n => n.t < beatsMax).forEach(n => { const st = Math.round(n.t * 4) % L, id = LANES[n.l].id; pat[id][st] = Math.max(pat[id][st], clamp(n.v, 30, 127)); });
      LANES.forEach((Ln, i) => { const b = M.slots[i].buf; if (b) { const S = G.sl[i]; S.buf = b; S.name = M.slots[i].name || ('mid-box ' + Ln.n); S.pb = null; S.pk = ''; } });
      try { cvApply({ bpm: M.bpm, bars, sw: 0, dk: 0, ds: 0, dh: 0, j: 0, pat }, 'mid-box'); } catch (e) { reportError('al generador', e); return; }
    } else { G.bpm = clamp(Math.round(M.bpm), 40, 240); G.bars = bars; G.ts = '4/4'; try { gResizeLocked(); } catch (e) {} }
    if (parts.includes('b') && M.b.notes.length) {
      G.ts = '4/4'; G.bTsOwn = false; try { gResizeLocked(); } catch (e) {}
      const sp = gBspb(), A = new Array(sp * G.bars).fill(0);
      RN('b').filter(n => n.t < beatsMax).forEach(n => { const i = Math.round(n.t * sp / 4) % A.length; const q = bassKey(n.p); if (!A[i] || A[i].v < n.v) A[i] = { k: q.k, v: clamp(n.v, 30, 127) }; });
      G.bas = A; G.lock.b = 1; G.useB = true;
    }
    try { gUI(); gGrid(); gSave(); } catch (e) {}
    step('al generador', parts.join('+'));
    flash('En el Generador (cuantizado a semicorcheas' + (loopBeats() > bars * 4 + 1e-6 ? ', solo los ' + bars + ' primeros compases: el Generador trabaja con 1, 2 o 4' : '') + '): ya puedes usar el dado, el swing o los efectos. Tu toma sin cuantizar sigue aquí.');
  }
  function sendTo() {
    if (!SH || !SH.ui) return flash('Falta sh-core.js', true);
    const parts = whatParts(); if (!hasNotes(parts)) return flash('No hay nada que mandar.');
    SH.ui.sendSheet({
      from: 'sampler', kinds: ['loop', 'notes'], count: 1, getItems: async () => {
        const s = spb(), notes = [];
        if (parts.includes('d')) RN('d').forEach(n => notes.push({ t: n.t * s, d: .125 * s, p: LANES[n.l].m, v: n.v, drum: true }));
        if (parts.includes('b')) RN('b').forEach(n => notes.push({ t: n.t * s, d: n.d * s, p: n.p, v: n.v }));
        return [{ name: baseName(parts), kind: 'loop', audio: await render(parts), bpm: M.bpm, notes, meta: { from: 'mid-box', bars: M.bars } }];
      }
    });
  }

  /* ---------------- Sonidos de la batería ---------------- */
  /* Sonidos de la batería: se guardan en el navegador (IndexedDB del sampler, claves «mbx:slot:N») y se recuperan al abrir.
     Si un hueco no tiene sonido guardado, lleva el sonido por defecto (DFB, midbox/drums-default.js). */
  const slotKey = i => 'mbx:slot:' + i;
  async function slotStore(i) {
    const x = M.slots[i]; if (typeof tx !== 'function') return;
    try { await tx('readwrite', st => x.buf && !x.def ? st.put({ sr: x.buf.sampleRate, ch: Array.from({ length: x.buf.numberOfChannels }, (_, c) => x.buf.getChannelData(c).slice()), name: x.name }, slotKey(i)) : st.delete(slotKey(i))); } catch (e) { LOG('no se pudo guardar el sonido', e.message); }
  }
  async function defaults() { try { return typeof shDefaultDrums === 'function' ? await shDefaultDrums(ctx) : []; } catch (e) { return []; } }
  async function slotDefault(i) { const d = await defaults(); M.slots[i] = { buf: d[i] || null, name: d[i] ? (window.SH_DRUM_NAMES || [])[i] || 'Por defecto' : '', def: true }; }
  async function slotsRestore() {
    for (let i = 0; i < 4; i++) {
      if (M.slots[i].buf) continue;   // ya puesto (p. ej. por un proyecto)
      let r = null; try { if (typeof tx === 'function') r = await tx('readonly', st => st.get(slotKey(i))); } catch (e) {}
      if (M.slots[i].buf) continue;
      if (r && r.ch && r.ch.length) { const b = ctx.createBuffer(r.ch.length, r.ch[0].length, r.sr); r.ch.forEach((d, c) => b.copyToChannel(d, c)); M.slots[i] = { buf: b, name: r.name || LANES[i].n }; }
      else await slotDefault(i);
    }
    drawSlots();
  }
  function setSlot(i, buf, name) { M.slots[i] = { buf, name }; slotStore(i); drawSlots(); }
  function fromGen(quiet) {
    if (typeof G === 'undefined') return 0; let n = 0;
    LANES.forEach((L, i) => { const S = G.sl[i]; if (S && S.buf) { setSlot(i, S.buf, S.name || ('Generador · ' + L.n)); n++; } });
    if (!quiet) flash(n ? n + ' sonidos copiados del Generador (quedan guardados).' : 'El Generador no tiene sonidos cargados en sus huecos.');
    drawSlots(); return n;
  }
  function slotFromPad(i) { const p = pads[sel]; if (!p || !p.buf) return flash('Elige antes en el Sampler un pad con sonido.'); let b; try { b = region(p); } catch (e) { b = p.buf; } setSlot(i, b, p.name || 'Pad ' + (sel + 1)); hitLive(i, 110); }
  async function slotFromFile(i, f) { if (!f) return; try { const b = await ctx.decodeAudioData(await f.arrayBuffer()); setSlot(i, b, f.name.replace(/\.[^.]+$/, '')); hitLive(i, 110); } catch (e) { flash('No se pudo leer ese sonido.', true); } }
  function drawSlots() {
    const box = $m('#mbSlots'); if (!box) return; box.innerHTML = '';
    LANES.forEach((L, i) => {
      const r = document.createElement('div'), x = M.slots[i]; r.className = 'mbrow';
      r.innerHTML = `<b style="color:${L.c}">${L.n}</b><span class="mbsm">${x.buf ? x.name + (x.def ? ' (por defecto)' : '') : 'sintetizado'}</span><label class="btn">Archivo<input type="file" accept="audio/*" hidden></label><button>Pad</button><button>▶</button><button title="Volver al sonido por defecto">↺</button>`;
      r.querySelector('input').onchange = e => slotFromFile(i, e.target.files[0]);
      const bs = r.querySelectorAll('button'); bs[0].onclick = () => slotFromPad(i); bs[1].onclick = () => { ctx.resume(); hitLive(i, 110); }; bs[2].onclick = async () => { await slotDefault(i); slotStore(i); drawSlots(); hitLive(i, 110); };
      box.appendChild(r);
    });
  }

  /* ---------------- Informe de error ---------------- */
  function report(where, err) {
    const nav = navigator, s = M;
    return [
      'INFORME DE ERROR · SampledHead App · mid-box ' + MB_VERSION + ' (app ' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?') + ', sh-core ' + (SH && SH.core) + ')',
      'Fecha: ' + new Date().toString(), 'Dónde: ' + where,
      'Etapa: ' + (s.take ? 'grabando (' + (s.take.part === 'd' ? 'batería' : 'bajo') + ')' : s.calib ? 'calibrando' : s.player ? 'reproduciendo' : 'en reposo') + ' · micro ' + (s.mic ? s.mic.kind : 'apagado'),
      'Mensaje: ' + (err && err.message || err || '-'), 'Stack: ' + (err && err.stack || '-'), '',
      'Navegador/UA: ' + nav.userAgent, 'Plataforma: ' + (nav.platform || '?') + ' · SH: ' + (SH ? SH.platform : '-'), 'Núcleos: ' + (nav.hardwareConcurrency || '?') + ' · RAM: ' + (nav.deviceMemory || '?') + ' GB',
      'Pantalla: ' + screen.width + 'x' + screen.height + ' @' + devicePixelRatio, 'URL/protocolo: ' + location.href, 'Contexto seguro: ' + isSecureContext + ' · COOP/COEP (aislado): ' + (window.crossOriginIsolated ? 'sí' : 'no'),
      'WebGPU: ' + (nav.gpu ? 'disponible' : 'no') + ' (mid-box no lo usa)', 'Audio: ' + (typeof ctx !== 'undefined' ? ctx.state + ' ' + ctx.sampleRate + ' Hz · latencia ' + Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000) + ' ms' : '?'),
      'Memoria JS: ' + (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' / ' + Math.round(performance.memory.jsHeapSizeLimit / 1048576) + ' MB' : '?'),
      'Opciones: ' + JSON.stringify({ parte: s.part, bpm: s.bpm, compases: s.bars, auto: s.barsAuto, metro: s.metro, cuenta: s.count, sobregrabar: s.overdub, sens: s.sens, respuesta: s.resp, latencia: s.comp, octava: s.oct, escala: s.snap, iman: s.magnet, rejilla: s.grid, exportar: s.exp, calibracion: LANES.map(L => L.id + ':' + s.cal[L.id].length).join(' ') }),
      'Archivo: ' + (s.lastFile ? s.lastFile.name + ' · ' + s.lastFile.size + ' · ' + (s.lastFile.type || '?') : '(ninguno)'),
      'Resultado parcial: batería ' + s.d.notes.length + ' golpes · bajo ' + s.b.notes.length + ' notas · sonidos ' + s.slots.map(x => x.buf ? 'sí' : 'no').join('/'),
      '', '--- Cronología ---', ...s.steps.map(x => x.t + ' ' + x.s + ' ' + x.info), '', '--- Consola (últimas ' + LOGS.length + ' líneas) ---', ...LOGS
    ].join('\n');
  }
  function reportError(where, err) {
    try {
      LOG('ERROR ' + where, err && err.stack || String(err)); M.lastReport = report(where, err);
      flash('Algo ha fallado (' + where + '): ' + (err && err.message || err) + '. Se ha descargado un informe .txt.', true);
      if (++M.autoReports <= 3) save(new Blob([M.lastReport], { type: 'text/plain' }), 'mid-box-' + MB_VERSION + '-informe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt');
    } catch (e) { console.error(e); }
  }
  const isOurs = s => /midbox|mid-box/i.test(String(s || ''));
  window.addEventListener('error', e => { if (isOurs(e.filename) || isOurs(e.error && e.error.stack)) reportError('error sin capturar', e.error || e.message); });
  window.addEventListener('unhandledrejection', e => { const s = String(e.reason && e.reason.stack || e.reason || ''); if (isOurs(s)) reportError('promesa sin capturar', e.reason); });
  const safe = (where, fn) => async (...a) => { try { return await fn(...a); } catch (e) { reportError(where, e); } };

  /* ---------------- Interfaz ---------------- */
  const CSS = `
#mbxpanel{display:none;padding:2px 2px 12px}
.unit.mbx #mbxpanel{display:block}
.unit.mbx .padzone,.unit.mbx .lcd,.unit.mbx .ctl,.unit.mbx .chips,.unit.mbx .lpbar,.unit.mbx .lpexp,.unit.mbx .tuner,.unit.mbx #banks{display:none}
.unit.mbx{--acc:#c08bff}#tabX{--tc:#c08bff}
#mbxpanel .mbc{background:var(--panel);border-radius:12px;padding:10px 12px;margin:0 0 10px}
#mbxpanel h4{margin:0 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
#mbxpanel .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
#mbxpanel button,#mbxpanel .btn{background:var(--chip);color:var(--ink);border:0;border-radius:9px;padding:7px 11px;font:600 13px Barlow,system-ui,sans-serif;cursor:pointer}
#mbxpanel button.pri{background:var(--acc);color:#111}#mbxpanel button.on{background:var(--acc);color:#111}
#mbxpanel button.rec{background:#c62f2f;color:#fff}#mbxpanel button.rec.live{animation:mbblink 1s infinite}
@keyframes mbblink{50%{opacity:.55}}
#mbxpanel button:disabled{opacity:.45;cursor:default}
#mbxpanel select,#mbxpanel input[type=number]{background:var(--chip);color:var(--ink);border:1px solid #333a45;border-radius:9px;padding:6px 8px;font:14px Barlow,system-ui,sans-serif}
#mbxpanel input[type=number]{width:64px}
#mbxpanel label.ck{font-size:13px;color:var(--ink);display:inline-flex;gap:4px;align-items:center}
#mbxpanel .mbsm{font-size:12.5px;color:var(--mute)}
#mbxpanel .seg{display:inline-flex;border-radius:10px;overflow:hidden}#mbxpanel .seg button{border-radius:0;padding:9px 16px;font-size:14px}
#mbxpanel .note{font-size:12.5px;color:var(--mute);margin-top:6px}
#mbxpanel .flash{font-size:13px;margin-top:8px;padding:8px 10px;border-radius:9px;background:#221a2e;color:#e2ccff}
#mbxpanel .flash.err{background:#2c1515;color:#ff9b9b}
#mbxpanel .mbrow{display:flex;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid #262b34;flex-wrap:wrap}
#mbxpanel .mbrow b{min-width:96px}#mbxpanel .mbrow .mbsm{flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mbHit{display:inline-block;min-width:110px;text-align:center;font:700 18px Barlow,system-ui,sans-serif;padding:6px 10px;border-radius:10px;background:#15111c;color:var(--acc)}
#mbHit.pop{animation:mbpop .25s}@keyframes mbpop{0%{transform:scale(1.18);background:#3a2a52}100%{transform:scale(1)}}
#mbMeter{width:120px;height:10px;border-radius:5px;background:#20252d;overflow:hidden;display:inline-block;vertical-align:middle}#mbMeter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#7fe08a,#ffd34d 70%,#ff6b6b)}
#mbRollBox{position:relative;overflow-x:auto;border-radius:8px;background:#0b0d10;-webkit-overflow-scrolling:touch}
#mbRoll{display:block;touch-action:none}
#mbHead{position:absolute;top:0;width:2px;background:#fff;opacity:.8;pointer-events:none;display:none}
#mbxpanel .cal{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
#mbxpanel .cal button{text-align:left;font-weight:500}#mbxpanel .cal button b{display:block}
@media(min-width:900px){#mbxpanel .cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);gap:12px}}
`;
  function html() {
    return `
<div class="mbc"><div class="row" style="margin-top:0;justify-content:space-between">
  <div class="seg"><button id="mbPd">🥁 Batería</button><button id="mbPb">🎸 Bajo</button></div>
  <div class="row" style="margin-top:0"><span class="mbsm">Tempo</span><button id="mbBpmM">−</button><input type="number" id="mbBpm" min="40" max="240" step="0.5"><button id="mbBpmP">+</button>
  <select id="mbBars" aria-label="Compases"><option value="auto">Compases: auto</option>${BARS.map(b => `<option value="${b}">${b} compás${b > 1 ? 'es' : ''}</option>`).join('')}</select>
  <label class="ck"><input type="checkbox" id="mbMetro">Metrónomo</label><label class="ck"><input type="checkbox" id="mbCount">Cuenta</label></div>
</div></div>
<div class="cols"><div>
<div class="mbc"><h4>Voz</h4>
  <div class="row" style="margin-top:0"><button id="mbLive">🎤 Directo</button><button class="rec" id="mbRec">● Grabar</button><button id="mbStop" disabled>■</button>
  <span id="mbHit">—</span><span id="mbMeter"><i></i></span></div>
  <div class="row"><label class="btn">Convertir un audio<input type="file" id="mbFile" accept="audio/*,video/*" hidden></label><button id="mbFromPad">Convertir el pad seleccionado</button></div>
  <div class="row"><button id="mbRegen" disabled title="Vuelve a analizar la toma o el audio con los ajustes de ahora">⟳ Regenerar</button><button id="mbDiscard" disabled title="Deja todo como antes de la última toma">↺ Descartar la toma</button></div>
  <div class="row"><label class="ck"><input type="checkbox" id="mbSpk">Uso el altavoz, sin cascos</label><label class="ck" id="mbAecL"><input type="checkbox" id="mbAec">Cancelación de eco del navegador</label></div>
  <div class="row"><label class="ck"><input type="checkbox" id="mbMonRec">Oír mientras grabo</label><label class="ck"><input type="checkbox" id="mbOver">Sobregrabar (añadir a lo que hay)</label></div>
  <div class="row"><span class="mbsm">Sensibilidad</span><input type="range" id="mbSens" min="1" max="10" step="1" style="width:110px"><span class="mbsm" id="mbSensV"></span>
    <span class="mbsm" id="mbRespL">Respuesta</span><select id="mbResp"><option value="fast">Rápida (25 ms)</option><option value="precise">Precisa (45 ms)</option></select></div>
  <div class="row" id="mbBassOpts"><span class="mbsm">Octava</span><select id="mbOct"><option value="-2">−2</option><option value="-1">−1 (voz a bajo)</option><option value="0">Como cantas</option><option value="1">+1</option></select>
    <label class="ck"><input type="checkbox" id="mbSnap">Ajustar a la escala de la pestaña Bajo</label><span class="mbsm" id="mbScale"></span></div>
  <div class="row"><button id="mbNoise">🤫 Medir ruido</button><span class="mbsm" id="mbNoiseV"></span><button id="mbNoiseX" hidden>Quitar</button></div>
  <div class="row"><span class="mbsm">Ajuste de latencia</span><input type="range" id="mbComp" min="0" max="500" step="1" style="width:110px"><span class="mbsm" id="mbCompV"></span><button id="mbLat">⏱ Medir latencia</button></div>
  <div class="note">Con cascos se oye mejor (mejor con cable: los Bluetooth retrasan mucho); sin cascos marca «Uso el altavoz». Al grabar, la toma se analiza entera al terminar; si no te convence, cambia la sensibilidad y pulsa ⟳ Regenerar. Sin metrónomo ni otra parte grabada, la toma empieza en tu primer golpe y el tempo se detecta solo.</div>
  <div id="mbFlash"></div>
  <div class="row"><button id="mbReport">Descargar informe (.txt)</button></div>
</div>
<div class="mbc" id="mbCalBox"><h4>Calibrar tu voz (opcional, recomendado)</h4>
  <div class="cal" id="mbCal"></div>
  <div class="note" id="mbCalNote"></div>
  <div class="row"><button id="mbCalClr">Borrar calibración</button></div>
</div>
<div class="mbc" id="mbSndBox"><h4>Sonidos de la batería</h4><div id="mbSlots"></div>
  <div class="row"><button id="mbFromGen">Usar los del Generador</button></div>
  <div class="note">Los sonidos que elijas se quedan guardados para la próxima vez; ↺ vuelve al sonido por defecto. El bajo suena con el sonido de la pestaña Bajo.</div>
</div>
</div><div>
<div class="mbc" id="mbTake" hidden><h4>Toma grabada · marca el loop</h4>
  <div id="mbWaveBox"><canvas id="mbWave" style="display:block;touch-action:none;border-radius:8px" aria-label="Onda de la toma: arrastra el inicio (verde) y el final (morado); arrastra el centro para mover la selección"></canvas></div>
  <div class="mbsm" id="mbTakeInfo" style="margin-top:4px"></div>
  <div class="row"><button id="mbTakePlay">▶ Escuchar la selección</button><label class="ck"><input type="checkbox" id="mbTakeSnap" checked>Imán a los golpes</label></div>
  <div class="row"><button data-tk="s" style="color:#4fe3a0">Inicio</button><button data-tk="e" style="color:#c08bff">Final</button><button data-tn="-10">◀ 10 ms</button><button data-tn="-2">◀ 2 ms</button><button data-tn="2">2 ms ▶</button><button data-tn="10">10 ms ▶</button></div>
  <div class="row"><span class="mbsm">Dentro hay</span><select id="mbTakeBars"><option value="auto">compases: auto</option><option value="1">1 compás</option><option value="2">2 compases</option><option value="3">3 compases</option><option value="4">4 compases</option><option value="6">6 compases</option><option value="8">8 compases</option><option value="tempo">mantener el tempo</option></select>
    <button class="pri" id="mbTakeUse">✓ Usar esta selección</button><button id="mbTakeAuto">Volver a la automática</button></div>
  <div class="note">Arrastra el inicio (verde) y el final (morado) para que el loop sea justo lo que quieres; con el imán se pegan a los golpes. Escúchalo en bucle y pulsa «Usar esta selección»: el tempo sale de la duración y los compases.</div>
</div>
<div class="mbc"><h4 id="mbEdT">Editor</h4>
  <div class="row" style="margin-top:0"><button id="mbPlay" class="pri">▶ Play</button><label class="ck"><input type="checkbox" id="mbPlayD">Batería</label><label class="ck"><input type="checkbox" id="mbPlayB">Bajo</label>
    <label class="ck"><input type="checkbox" id="mbMag">Imán</label><select id="mbGrid" aria-label="Rejilla"><option value="1">1/4</option><option value="0.5">1/8</option><option value="0.25">1/16</option><option value="0.125">1/32</option><option value="0.3333333333">1/8 tresillo</option><option value="0.1666666667">1/16 tresillo</option></select>
    <span class="mbsm" id="mbSelInfo"></span></div>
  <div id="mbRollBox" style="margin-top:8px"><canvas id="mbRoll" aria-label="Editor de notas: toca para elegir, arrastra para mover, doble toque en vacío para añadir"></canvas><div id="mbHead"></div></div>
  <div class="note">Toca una nota para elegirla (Mayús para varias), arrástrala para moverla (en el bajo, el borde derecho cambia la duración). Doble toque en un hueco: nota nueva.</div>
  <div class="row"><button id="mbDel">Borrar</button><button id="mbNL">◀ 5 ms</button><button id="mbNR">5 ms ▶</button><span class="mbsm">Fuerza</span><input type="range" id="mbVel" min="1" max="127" style="width:90px">
    <span id="mbTr"><button data-k="-12">−8va</button><button data-k="-1">−1</button><button data-k="1">+1</button><button data-k="12">+8va</button></span></div>
  <div class="row"><span class="mbsm">Cuantizar a</span><select id="mbQGrid"><option value="1">1/4</option><option value="0.5">1/8</option><option value="0.25">1/16</option><option value="0.125">1/32</option><option value="0.3333333333">1/8 tresillo</option><option value="0.1666666667">1/16 tresillo</option></select>
    <span class="mbsm">al</span><input type="range" id="mbQStr" min="10" max="100" step="10" style="width:90px"><span class="mbsm" id="mbQStrV"></span><button id="mbQ">Cuantizar</button></div>
  <div class="row"><span class="mbsm">Largo del loop</span><button data-l="-4">−1 compás</button><button data-l="-1">−1 tiempo</button><b id="mbLenV" class="mbsm" style="color:var(--ink)"></b><button data-l="1">+1 tiempo</button><button data-l="4">+1 compás</button><button id="mbLenFit" title="Vuelve a buscar dónde acaba el loop">Buscar el final</button></div>
  <div class="row"><span class="mbsm">Inicio</span><button data-s="-1">◀ 1 tiempo</button><button data-s="-0.25">◀ 1/16</button><b id="mbStartV" class="mbsm" style="color:var(--ink)"></b><button data-s="0.25">1/16 ▶</button><button data-s="1">1 tiempo ▶</button><button id="mbCons" class="pri" title="Ctrl+J">✂ Consolidar</button></div>
  <div class="row"><button id="mbUndo">↶ Deshacer</button><button id="mbRedo">↷ Rehacer</button><button id="mbClr">Vaciar esta parte</button></div>
</div>
<div class="mbc"><h4>Llevar a…</h4>
  <div class="row" style="margin-top:0"><select id="mbExp"><option value="both">Batería y bajo</option><option value="d">Solo batería</option><option value="b">Solo bajo</option></select></div>
  <div class="row"><button class="pri" id="mbToPad">A un pad (WAV en bucle)</button><button id="mbToLp">Al Looper (secuencia)</button><button id="mbToGen">Al Generador</button></div>
  <div class="row"><button id="mbMidi">MIDI (.mid)</button><button id="mbWav">WAV</button><button id="mbSend">Enviar a…</button></div>
  <div class="note">MIDI, WAV, pad y Looper salen sin cuantizar (tal como está en el editor). El Generador trabaja por pasos: ahí se cuantiza a semicorcheas.</div>
</div>
</div></div>
<div class="note" style="text-align:right">mid-box ${MB_VERSION}</div>`;
  }
  function flash(msg, err) { const f = $m('#mbFlash'); if (!f) return; f.innerHTML = ''; if (!msg) return; const d = document.createElement('div'); d.className = 'flash' + (err ? ' err' : ''); d.textContent = msg; f.appendChild(d); if (!err) try { status('mid-box: ' + msg.slice(0, 90)); } catch (e) {} }
  function ui() {
    const on = (id, v) => { const e = $m(id); if (e) e.classList.toggle('on', !!v); };
    on('#mbPd', M.part === 'd'); on('#mbPb', M.part === 'b'); on('#mbLive', !!M.mic); on('#mbPlay', !!M.player);
    const r = $m('#mbRec'); if (r) { r.classList.toggle('live', !!M.take); r.textContent = M.take ? '● Grabando' : '● Grabar'; r.disabled = !!M.calib; }
    const st = $m('#mbStop'); if (st) st.disabled = !(M.take || M.player);
    const pb = $m('#mbPlay'); if (pb) { pb.textContent = M.player ? '■ Stop' : '▶ Play'; pb.disabled = !!M.take; }
    const set = (id, v) => { const e = $m(id); if (e && document.activeElement !== e) e.value = v; };
    set('#mbBpm', M.bpm); { const sb = $m('#mbBars'); if (sb) { let c = sb.querySelector('option[data-c]'); const std = !M.barsAuto && BARS.includes(M.bars); if (!M.barsAuto && !std) { if (!c) { c = document.createElement('option'); c.dataset.c = 1; sb.appendChild(c); } c.value = String(M.bars); c.textContent = barsTxt(); } else if (c) c.remove(); if (document.activeElement !== sb) sb.value = M.barsAuto ? 'auto' : String(M.bars); } }
    { const lv = $m('#mbLenV'); if (lv) lv.textContent = barsTxt(); const sv = $m('#mbStartV'); if (sv) sv.textContent = M.ls ? 'tiempo ' + String(Math.round((M.ls + 1) * 100) / 100).replace('.', ',') : 'desde el principio'; } set('#mbSens', M.sens); set('#mbResp', M.resp); set('#mbOct', M.oct); set('#mbComp', M.comp); set('#mbGrid', M.grid); set('#mbQGrid', M.grid); set('#mbQStr', M.qStr); set('#mbExp', M.exp);
    const ck = (id, v) => { const e = $m(id); if (e) e.checked = !!v; };
    ck('#mbMetro', M.metro); ck('#mbSpk', M.spk); ck('#mbAec', M.aec); { const a = $m('#mbAecL'); if (a) a.hidden = !M.spk; } ck('#mbMonRec', M.monRec); ck('#mbCount', M.count); ck('#mbOver', M.overdub); ck('#mbSnap', M.snap); ck('#mbMag', M.magnet); ck('#mbPlayD', M.playD); ck('#mbPlayB', M.playB);
    const tx = (id, v) => { const e = $m(id); if (e) e.textContent = v; };
    tx('#mbCompV', M.comp + ' ms'); tx('#mbQStrV', M.qStr + ' %');
    try { tx('#mbScale', M.snap ? '(' + NOTE[BS.root] + ' ' + (BSCALES[BS.scale].full || BSCALES[BS.scale].name) + ')' : ''); } catch (e) {}
    tx('#mbEdT', 'Editor · ' + (M.part === 'd' ? 'batería' : 'bajo') + ' · ' + barsTxt() + ' · ' + M.bpm + ' BPM');
    const d = M.part === 'd';
    ['#mbCalBox', '#mbSndBox', '#mbResp', '#mbRespL'].forEach(id => { const e = $m(id); if (e) e.hidden = !d; });
    const bo = $m('#mbBassOpts'); if (bo) bo.hidden = d; const tr = $m('#mbTr'); if (tr) tr.hidden = d;
    const rc = $m('#mbRegen'); if (rc) rc.disabled = !(P().src && P().src.buf) || busy();
    const dc = $m('#mbDiscard'); if (dc) dc.disabled = !(M.lastTake && M.lastTake.part === M.part) || busy();
    tx('#mbSensV', M.sens <= 3 ? 'solo golpes fuertes' : M.sens >= 8 ? 'capta casi todo' : '');
    tx('#mbNoiseV', M.noise ? 'ruido ' + (20 * Math.log10(M.noise.env)).toFixed(0) + ' dB' : 'sin medir'); const nx = $m('#mbNoiseX'); if (nx) nx.hidden = !M.noise;
    ['#mbNoise', '#mbLat'].forEach(id => { const e = $m(id); if (e) e.disabled = busy() || !!M.meas; });
    const cal = $m('#mbCal');
    if (cal) { cal.innerHTML = ''; LANES.forEach((L, i) => { const b = document.createElement('button'), n = M.cal[L.id].length; b.innerHTML = `<b style="color:${L.c}">${M.calib && M.calib.li === i ? '● Escuchando…' : 'Enseñar ' + L.n.toLowerCase()}</b><span class="mbsm">${L.voz} · ${n ? n + ' ejemplos ✓' : 'sin ejemplos'}</span>`; b.disabled = busy(); b.onclick = safe('calibrar', () => calibrate(i)); cal.appendChild(b); }); }
    tx('#mbCalNote', calReady() ? 'Calibrado: los golpes se reconocen comparándolos con tus ejemplos.' + (M.cal.o.length < 3 ? ' Hat abierto sin ejemplos: se distingue del cerrado por lo que dura.' : '') : 'Sin calibrar se usan reglas generales (grave = bombo, ruido medio = caja, agudo = hat; largo = abierto). Con 3 o más ejemplos de bombo, caja y hat cerrado se usa tu voz.');
  }
  function bind() {
    const on = (id, ev, fn) => { const e = $m(id); if (e) e.addEventListener(ev, fn); };
    on('#mbPd', 'click', () => setPart('d')); on('#mbPb', 'click', () => setPart('b'));
    on('#mbBpm', 'change', e => setBpm(+e.target.value)); on('#mbBpmM', 'click', () => setBpm(M.bpm - 1)); on('#mbBpmP', 'click', () => setBpm(M.bpm + 1));
    on('#mbBars', 'change', e => { if (e.target.value === 'auto') { M.barsAuto = true; M.bars = autoBars(endBeats()); } else { M.barsAuto = false; pushUndo(); M.bars = +e.target.value; } saveSettings(); ui(); draw(); });
    on('#mbMetro', 'change', e => { M.metro = e.target.checked; saveSettings(); }); on('#mbCount', 'change', e => { M.count = e.target.checked; saveSettings(); });
    on('#mbOver', 'change', e => { M.overdub = e.target.checked; saveSettings(); });
    on('#mbSens', 'input', e => { M.sens = +e.target.value; saveSettings(); ui(); });
    on('#mbResp', 'change', e => { M.resp = e.target.value; saveSettings(); });
    on('#mbOct', 'change', e => { M.oct = +e.target.value; saveSettings(); });
    on('#mbSnap', 'change', e => { M.snap = e.target.checked; saveSettings(); ui(); draw(); });
    on('#mbComp', 'input', e => { M.comp = +e.target.value; M.latMeasured = false; saveSettings(); ui(); });
    on('#mbLive', 'click', safe('directo', async () => { if (M.mic && M.micByRec) { M.micByRec = false; flash('Directo activado.'); } else if (M.mic) { if (M.take) recStop(); micOff(); } else if (await micOn()) flash(M.part === 'd' ? 'Directo: haz beatbox y suena la batería. Grabar guarda la toma.' : 'Directo: tararea y suena el bajo. Grabar guarda la toma.'); ui(); }));
    on('#mbRec', 'click', safe('grabar', () => M.take ? recStop() : recStart()));
    on('#mbStop', 'click', safe('parar', () => { if (M.take) recStop(); else stopPlay(); }));
    on('#mbFile', 'change', safe('convertir audio', e => { const f = e.target.files[0]; e.target.value = ''; return fromFile(f); }));
    on('#mbFromPad', 'click', safe('convertir pad', fromPad)); on('#mbRegen', 'click', safe('regenerar', regenerate)); on('#mbDiscard', 'click', safe('descartar', discardTake));
    on('#mbSpk', 'change', safe('altavoz', async e => { M.spk = e.target.checked; saveSettings(); if (M.mic && !M.take) { const by = M.micByRec; await micOn(); M.micByRec = by; } ui(); flash(M.spk ? 'Modo altavoz: mid-box ignora el eco de lo que él mismo hace sonar (llega al micro al cabo de la latencia) y los clics del metrónomo. Pulsa ⏱ Medir latencia para que el filtro sea exacto. Si aun así se dispara solo, baja el volumen, prueba la cancelación de eco del navegador o usa cascos.' : 'Modo cascos: sin cancelación de eco (suena más natural). Si el micro oye el altavoz, se crea un bucle.'); }));
    on('#mbAec', 'change', safe('cancelar eco', async e => { M.aec = e.target.checked; saveSettings(); if (M.mic && !M.take) { const by = M.micByRec; await micOn(); M.micByRec = by; } flash(M.aec ? 'Cancelación de eco activada: quita aún más el altavoz, pero cambia el sonido del micro (puede quitar graves del bombo). Si la usas, calibra tu voz con ella puesta.' : 'Cancelación de eco desactivada.'); }));
    on('#mbMonRec', 'change', e => { M.monRec = e.target.checked; saveSettings(); });
    on('#mbNoise', 'click', safe('medir ruido', measureNoise)); on('#mbNoiseX', 'click', () => { M.noise = null; saveSettings(); ui(); flash('Umbral de ruido quitado: manda solo la sensibilidad.'); });
    on('#mbLat', 'click', safe('medir latencia', measureLatency));
    on('#mbReport', 'click', () => save(new Blob([M.lastReport || report('informe pedido a mano', null)], { type: 'text/plain' }), 'mid-box-' + MB_VERSION + '-informe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt'));
    on('#mbCalClr', 'click', () => { if (!confirm('¿Borrar los ejemplos de tu voz?')) return; LANES.forEach(L => M.cal[L.id] = []); saveCal(); ui(); flash('Calibración borrada: se vuelven a usar las reglas generales.'); });
    on('#mbFromGen', 'click', () => fromGen(false));
    on('#mbPlay', 'click', safe('play', () => { ctx.resume(); if (M.player) stopPlay(); else if (!M.d.notes.length && !M.b.notes.length) flash('Todavía no hay nada grabado.'); else startPlay(null, {}); }));
    on('#mbPlayD', 'change', e => { M.playD = e.target.checked; }); on('#mbPlayB', 'change', e => { M.playB = e.target.checked; });
    on('#mbMag', 'change', e => { M.magnet = e.target.checked; saveSettings(); });
    on('#mbGrid', 'change', e => { M.grid = +e.target.value; const q = $m('#mbQGrid'); if (q) q.value = e.target.value; saveSettings(); draw(); });
    on('#mbDel', 'click', delSel); on('#mbNL', 'click', () => nudge(-5)); on('#mbNR', 'click', () => nudge(5));
    let velU = false; on('#mbVel', 'input', e => { const s = selNotes(); if (!s.length) return; if (!velU) { pushUndo(); velU = true; } s.forEach(n => n.v = +e.target.value); draw(); }); on('#mbVel', 'change', () => { velU = false; });
    on('#mbTr', 'click', e => { const k = e.target && e.target.dataset && e.target.dataset.k; if (k) transpose(+k); });
    on('#mbQStr', 'input', e => { M.qStr = +e.target.value; ui(); saveSettings(); }); on('#mbQ', 'click', quantize);
    document.querySelectorAll('#mbxpanel [data-l]').forEach(b => b.addEventListener('click', () => { const nb = clamp(loopBeats() + +b.dataset.l, 1, 64); if (nb === loopBeats()) return; pushUndo(); M.bars = nb / 4; M.barsAuto = false; saveSettings(); ui(); draw(); }));
    document.querySelectorAll('#mbxpanel [data-s]').forEach(b => b.addEventListener('click', () => { const e0 = M.ls + loopBeats(), ns = clamp(M.ls + +b.dataset.s, 0, e0 - .25); if (Math.abs(ns - M.ls) < 1e-6) return; pushUndo(); M.ls = ns; M.bars = (e0 - ns) / 4; saveSettings(); ui(); draw(); }));
    on('#mbCons', 'click', consolidate);
    on('#mbLenFit', 'click', () => { if (!P().notes.length) return flash('No hay notas.'); pushUndo(); const ms = P().notes.slice().sort((a, b) => a.t - b.t), o = ms[0].t; ms.forEach(n => n.t -= o); const m = fitLoop(M.part, false); ui(); draw(); flash((o > .01 ? 'El loop empieza ahora en el primer sonido. ' : '') + (m || 'Loop de ' + barsTxt() + '.') + ' «Deshacer» lo devuelve.'); });
    on('#mbUndo', 'click', undo); on('#mbRedo', 'click', redo);
    on('#mbClr', 'click', () => { if (!P().notes.length) return; pushUndo(); P().notes = []; M.sel.clear(); draw(); flash('Parte vaciada. «Deshacer» la recupera.'); });
    on('#mbExp', 'change', e => { M.exp = e.target.value; saveSettings(); });
    on('#mbToPad', 'click', safe('a un pad', toPad)); on('#mbToLp', 'click', safe('al looper', toLooper)); on('#mbToGen', 'click', safe('al generador', toGen));
    on('#mbMidi', 'click', safe('midi', midiOut)); on('#mbWav', 'click', safe('wav', wavOut)); on('#mbSend', 'click', safe('enviar a', sendTo));
    document.addEventListener('keydown', e => { const u = $m('.unit'); if (!u || !u.classList.contains('mbx')) return; if (/INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || '')) return; if (e.key === 'Delete' || e.key === 'Backspace') { if (M.sel.size) { e.preventDefault(); delSel(); } } if ((e.ctrlKey || e.metaKey) && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); consolidate(); } });
    window.addEventListener('resize', () => { const u = $m('.unit'); if (u && u.classList.contains('mbx')) draw(); });
    bindRoll(); tkBind();
    (function meter() { const i = $m('#mbMeter i'); if (i) { i.style.width = Math.min(100, Math.round(M.level * 140)) + '%'; M.level *= .92; } requestAnimationFrame(meter); })();
  }
  function setPart(p) { if (M.take) return flash('Termina antes la grabación.'); if (M.part === p) return; tkStop(); M.part = p; M.sel.clear(); if (M.mic) resetLive(); if (M.liveBass) try { M.liveBass.silence(ctx.currentTime); } catch (e) {} ui(); draw(); show('—'); }
  function setBpm(v) { v = Math.round(clamp(v || 90, 40, 240) * 4) / 4; if (v === M.bpm) return; M.bpm = v; saveSettings(); ui(); draw(); }


  /* ---------------- Proyectos (1.70): las tomas, los sonidos y el audio para reconvertir viajan con el proyecto ---------------- */
  const SRC_MAX = 90;   // segundos de audio de toma que se guardan (más largo: solo las notas)
  const mono = b => { if (b.numberOfChannels === 1) return b.getChannelData(0).slice(); const n = b.length, o = new Float32Array(n); for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) o[i] += d[i] / b.numberOfChannels; } return o; };
  const packAu = b => b ? { sr: b.sampleRate, d: mono(b) } : null;
  const unpackAu = r => { if (!r || !r.d || !r.d.length) return null; const b = ctx.createBuffer(1, r.d.length, r.sr); b.copyToChannel(r.d instanceof Float32Array ? r.d : Float32Array.from(r.d), 0); return b; };
  function pjMb() {
    const src = k => { const x = M[k].src; return x && x.buf ? { offset: x.offset, live: !!x.live, timed: !!x.timed, len: x.len == null ? null : x.len, name: x.name || '', sel: x.sel || null, base: (x.base || []).map(n => k === 'd' ? { t: n.t, l: n.l, v: n.v } : { t: n.t, p: n.p, d: n.d, v: n.v }), au: x.buf.duration <= SRC_MAX } : null; };
    return { v: 1, part: M.part, bpm: M.bpm, bars: M.bars, ls: M.ls, barsAuto: !!M.barsAuto, exp: M.exp, playD: M.playD, playB: M.playB,
      d: M.d.notes.map(n => ({ t: n.t, l: n.l, v: n.v })), b: M.b.notes.map(n => ({ t: n.t, p: n.p, d: n.d, v: n.v })),
      slots: M.slots.map(x => x.buf ? x.name || '' : null), src: { d: src('d'), b: src('b') },
      set: Object.fromEntries(['metro', 'count', 'overdub', 'sens', 'resp', 'comp', 'oct', 'snap', 'magnet', 'grid', 'qStr', 'monRec', 'noise', 'spk', 'aec', 'latMeasured'].map(k => [k, M[k]])), cal: LANES.some(L => M.cal[L.id].length) ? M.cal : null };
  }
  function pjMbApply(o, au) {
    if (!o) return;
    if (M.take) recStop(); stopPlay(true);
    M.part = o.part === 'b' ? 'b' : 'd'; M.bpm = o.bpm || M.bpm; M.bars = o.bars || M.bars; M.ls = o.ls || 0; M.barsAuto = !!o.barsAuto; if (o.exp) M.exp = o.exp;
    M.playD = o.playD !== false; M.playB = o.playB !== false;
    M.d.notes = (o.d || []).map(n => ({ id: M.nid++, t: n.t, l: n.l, v: n.v }));
    M.b.notes = (o.b || []).map(n => ({ id: M.nid++, t: n.t, p: n.p, d: n.d, v: n.v }));
    au = au || {};
    LANES.forEach((L, i) => { const b = unpackAu(au.slots && au.slots[i]); if (b) M.slots[i] = { buf: b, name: (o.slots && o.slots[i]) || L.n }; });   // huecos sin sonido en el proyecto: se quedan los tuyos
    ['d', 'b'].forEach(k => { const m = o.src && o.src[k], b = unpackAu(au.src && au.src[k]); M[k].src = m && b ? { buf: b, sel: m.sel || null, offset: m.offset, live: m.live, timed: m.timed != null ? m.timed : !!m.live, len: m.len == null ? null : m.len, name: m.name, base: (m.base || []).map(n => Object.assign({ id: M.nid++ }, n)) } : null; }); M.lastTake = null;
    if (o.set) ['metro', 'count', 'overdub', 'sens', 'resp', 'comp', 'oct', 'snap', 'magnet', 'grid', 'qStr', 'monRec', 'noise', 'spk', 'aec', 'latMeasured'].forEach(k => { if (o.set[k] != null) M[k] = o.set[k]; });
    if (o.cal && !LANES.some(L => M.cal[L.id].length)) { LANES.forEach(L => M.cal[L.id] = o.cal[L.id] || []); saveCal(); }   // la calibración del proyecto solo entra si no hay otra
    saveSettings();
    M.sel.clear(); M.undo = []; M.redo = []; M.shown = true;
    try { drawSlots(); ui(); draw(); } catch (e) {}
    step('proyecto cargado', M.d.notes.length + ' golpes · ' + M.b.notes.length + ' notas');
  }
  function installProjectHooks() {
    if (typeof pjMeta !== 'function' || typeof pjCapture !== 'function' || typeof pjApply !== 'function') { LOG('sin proyectos: no se engancha'); return; }
    const oMeta = pjMeta, oSig = pjSig, oCap = pjCapture, oApply = pjApply;
    const ids = () => [...M.slots.map(x => x.buf ? pjId(x.buf) : 0), M.d.src && M.d.src.buf ? pjId(M.d.src.buf) : 0, M.b.src && M.b.src.buf ? pjId(M.b.src.buf) : 0].join(',');
    pjMeta = function () { const m = oMeta(); try { m.mbx = pjMb(); } catch (e) {} return m; };
    pjSig = function () { return oSig() + '|mbx:' + ids(); };
    pjCapture = function () {
      const c = oCap();
      try { if (!c.mbx) c.mbx = pjMb(); c.mbxAu = { slots: M.slots.map(x => packAu(x.buf)), src: { d: M.d.src && M.d.src.buf && M.d.src.buf.duration <= SRC_MAX ? packAu(M.d.src.buf) : null, b: M.b.src && M.b.src.buf && M.b.src.buf.duration <= SRC_MAX ? packAu(M.b.src.buf) : null } }; } catch (e) { LOG('no se pudo guardar el audio de mid-box', e.message); }
      return c;
    };
    if (typeof newFxGen === 'function') { const oNew = newFxGen; newFxGen = function (...a) { const r = oNew.apply(this, a); try { pjMbApply({ part: 'd', bpm: M.bpm, bars: 2, d: [], b: [] }, null); } catch (e) {} return r; }; }   // «Nuevo proyecto» también vacía mid-box
    pjApply = async function (d) {
      await oApply(d);
      if (d && d.mbx) { try { pjMbApply(d.mbx, d.mbxAu); } catch (e) { reportError('cargar proyecto', e); } }   // los proyectos sin mid-box no lo tocan
    };
  }

  /* ---------------- Arranque ---------------- */
  function init() {
    if (!document.querySelector('.unit')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    let panel = $m('#mbxpanel'); if (!panel) { panel = document.createElement('div'); panel.id = 'mbxpanel'; $m('.unit').appendChild(panel); }
    panel.innerHTML = html();
    bind(); drawSlots(); ui();
    LOG('mid-box ' + MB_VERSION + ' listo');
  }
  loadSettings(); M.barsAuto = false;
  try { installProjectHooks(); } catch (e) { LOG('proyectos', e.message); }   // ya, antes de que se cargue el autoguardado
  window.mbxShow = () => { M.shown = true; ui(); draw(); drawSlots(); };
  setTimeout(() => { slotsRestore(); }, 0);
  window.mbxHide = () => { tkStop(); if (M.take) recStop(); if (M.calib) M.calib = null; stopPlay(true); micOff(); ui(); };
  window.MIDBOX = { version: MB_VERSION, state: M, analyzeDrums, analyzeBass, feats, classify, estTempo, convertBuffer, render, midiBytes, toLooper, toGen, toPad, quantize, consolidate, RN, pjMb, pjMbApply, regenerate, discardTake, measureNoise, measureLatency, setPart, setBpm, draw, undo, startPlay, stopPlay, micOn, micOff, recStart, recStop, report };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
