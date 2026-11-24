/* sh-core.js — base común de las apps de Sampled Head (v1.5.0: menú común «☰ Menú» igual en todas las apps · v1.4.1: copias que se suman sin cambiar la versión de la base · v1.4.0: app única SampledHead para Android · v1.3.0: envío directo entre apps Android instaladas · v1.2.2: + biblioteca del Editor (shed-projects) · v1.2.1: GlitchHead)
 * Copia de este archivo en cada app (no editar allí: se edita en SH-apps/sh-core y se reparte con
 * `node sh-core/sync.js`).
 *
 *  SH.APPS                     lista de apps (id, nombre, dirección web, qué reciben)
 *  SH.bridge.send(to, items)   deja audio/notas en la bandeja de otra app
 *  SH.bridge.inbox(me)         lo que han mandado a esta app
 *  SH.bridge.watch(me, cb)     avisa cuando llega algo (al abrir, al volver a la pestaña y al instante)
 *  SH.open(id)                 abre otra app (escritorio: el programa instalado; web: pestaña nueva)
 *  SH.ui.sendSheet(opts)       hoja «Enviar a…» con todas las apps
 *  SH.ui.receiveSheet(me, cb)  hoja «Recibido» con lo que hay en la bandeja
 *  SH.ui.menu(opts)            1.5.0: menú común «☰ Menú» (mismas secciones desplegables y en el mismo orden en todas las apps)
 *  SH.models.get(url, opts)    descarga un modelo una sola vez para todas las apps
 *  SH.engine                   motor local de IA (solo Windows y Mac)
 *  SH.wav.encode / decode      WAV de 16/24 bits
 *
 * Bandeja: en la web es la base IndexedDB «sh-bridge» (compartida por todas las apps del mismo dominio de
 * GitHub Pages); en Windows y Mac es la carpeta Documentos/SampledHead/Bandeja, que comparten todos los
 * programas. Cada app tiene su buzón «v2:in:<id>» con una lista de elementos:
 *   { id, name, from, ts, kind:'pad'|'loop'|'stem'|'phrase'|'notes'|'kit', wav:ArrayBuffer|null, sr, secs,
 *     bpm?, key?, notes?:[{t,d,p,v}], meta?:{} }
 */
(function (G) {
  'use strict';
  if (G.SH && G.SH.core) return;
  const VERSION = '1.5.0';
  const BASE = 'https://sampledhead-dot.github.io/';
  const D = G.shDesktop || null;                 // API del envoltorio de escritorio (preload), si existe

  const APPS = [
    { id: 'sampler', name: 'SampledHead App', path: 'sampledhead-app/', takes: ['pad', 'loop', 'stem', 'phrase', 'kit', 'notes'], desc: 'Pads, bancos, Looper y Extractor' },
    { id: 'editor', name: 'SampledHead Editor', path: 'sampledhead-editor/', takes: ['pad', 'loop', 'stem', 'phrase'], desc: 'Editar, limpiar y masterizar' },
    { id: 'crazyhead', name: 'CrazyHead', path: 'CrazyHead/', takes: ['loop', 'stem', 'pad', 'phrase'], desc: 'Trocear loops y generar secuencias' },
    { id: 'fuzzhead', name: 'FuzzHead', path: 'FuzzHead/', takes: ['stem', 'loop', 'phrase', 'pad'], desc: 'Convertir bajo o guitarra en sinte' },
    { id: 'glitchhead', name: 'GlitchHead', path: 'GlitchHead/', takes: ['loop', 'stem', 'pad', 'phrase'], desc: 'Shred · Haze · Split: efectos salvajes' },
    { id: 'spb', name: 'Sample Pack Builder', path: 'spb-head/', takes: ['stem', 'loop'], desc: 'Hacer un pack de samples' },
    { id: 'tuner', name: 'SampledHead Tuner', path: 'Sampledhead-tuner/', takes: ['stem', 'loop', 'notes'], desc: 'Acordes y línea de bajo' },
    { id: 'tonopad', name: 'TonoPad', path: 'Tono-Pad/', takes: ['stem', 'loop', 'pad', 'notes'], desc: 'Tono, escala y pads afinados' }
  ];
  APPS.forEach(a => { a.url = BASE + a.path; });
  const appById = id => APPS.find(a => a.id === id) || null;

  /* ---------------- WAV ---------------- */
  function channelsOf(src) {
    if (!src) return { ch: [], sr: 44100 };
    if (typeof src.getChannelData === 'function') {
      const ch = []; for (let c = 0; c < src.numberOfChannels; c++) ch.push(src.getChannelData(c));
      return { ch, sr: src.sampleRate };
    }
    if (src.channels) return { ch: src.channels, sr: src.sampleRate || src.sr || 44100 };
    return { ch: [], sr: 44100 };
  }
  function encode(src, bits) {
    bits = bits === 16 ? 16 : 24;
    const { ch, sr } = channelsOf(src), nc = Math.max(1, Math.min(2, ch.length)), n = ch.length ? ch[0].length : 0;
    const bps = bits / 8, data = n * nc * bps, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, nc, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nc * bps, true);
    v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true); w(36, 'data'); v.setUint32(40, data, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
      let s = ch[c][i]; s = s > 1 ? 1 : s < -1 ? -1 : s || 0;
      if (bits === 16) { v.setInt16(o, Math.round(s * 32767), true); o += 2; }
      else { const x = Math.round(s * 8388607); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    }
    return buf;
  }
  async function decode(ab, ctx) {
    const own = !ctx; ctx = ctx || new (G.OfflineAudioContext || G.webkitOfflineAudioContext)(1, 1, 44100);
    const b = await ctx.decodeAudioData(ab.slice(0));
    if (own) { /* OfflineAudioContext no necesita cerrarse */ }
    return b;
  }

  /* ---------------- Bandeja (web: IndexedDB) ---------------- */
  const IDB = {
    _db: null,
    open() {
      return this._db || (this._db = new Promise((ok, ko) => {
        const q = indexedDB.open('sh-bridge', 1);
        q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains('kv')) q.result.createObjectStore('kv'); };
        q.onsuccess = () => ok(q.result); q.onerror = () => ko(q.error);
      }));
    },
    async get(k) { const d = await this.open(); return new Promise((ok, ko) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); }); },
    async set(k, v) { const d = await this.open(); return new Promise((ok, ko) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => ok(); t.onerror = () => ko(t.error); }); },
    async del(k) { const d = await this.open(); return new Promise((ok, ko) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => ok(); t.onerror = () => ko(t.error); }); }
  };
  let chan = null; try { chan = new BroadcastChannel('sh-bridge'); } catch (e) {}
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function normItem(it, from) {
    const o = Object.assign({}, it);
    o.id = o.id || uid(); o.from = o.from || from || '?'; o.ts = o.ts || Date.now(); o.kind = o.kind || 'pad';
    if (o.audio) { o.wav = encode(o.audio, 24); const c = channelsOf(o.audio); o.sr = c.sr; o.secs = c.ch.length ? c.ch[0].length / c.sr : 0; delete o.audio; }
    if (o.wav && !(o.wav instanceof ArrayBuffer) && o.wav.buffer) o.wav = o.wav.buffer.slice(o.wav.byteOffset, o.wav.byteOffset + o.wav.byteLength);
    o.name = String(o.name || 'Audio').slice(0, 120);
    return o;
  }

  /* ---------------- Android (1.3.0): cada APK tiene su almacenamiento, así que la bandeja viaja de una app a otra por el
     programa (SHAndroid.outBegin/sendTo → intent com.sampledhead.RECIBIR → bandeja propia, que se lee en /__bandeja__/).
     Con APK anteriores a la 1.4.0 no existe y se sigue como en el navegador. ---------------- */
  const AND = (!D && G.SHAndroid && typeof G.SHAndroid.outBegin === 'function') ? G.SHAndroid : null;
  /* 1.4.0: dentro de la app única SampledHead para Android todas las apps comparten origen (como en GitHub Pages): la
     bandeja es la de la web (IndexedDB) y SH.open cambia de vista sin salir de la app (SHSuite.open). */
  const SUITE = (!D && G.SHSuite && typeof G.SHSuite.open === 'function') ? G.SHSuite : null;
  function packItem(o) {
    const meta = Object.assign({}, o); delete meta.wav;
    const j = new TextEncoder().encode(JSON.stringify(meta)), w = o.wav ? new Uint8Array(o.wav) : new Uint8Array(0);
    const out = new Uint8Array(8 + j.length + w.length); out.set([83, 72, 73, 49]); new DataView(out.buffer).setUint32(4, j.length, true);
    out.set(j, 8); out.set(w, 8 + j.length); return out;
  }
  function unpackItem(ab) {
    const u = new Uint8Array(ab); if (u[0] !== 83 || u[1] !== 72 || u[2] !== 73 || u[3] !== 49) throw new Error('elemento no válido');
    const n = new DataView(ab).getUint32(4, true), meta = JSON.parse(new TextDecoder().decode(u.subarray(8, 8 + n)));
    if (u.length > 8 + n) meta.wav = ab.slice(8 + n); return meta;
  }
  function b64(u) { let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }
  async function pullNative(me) {   // pasa lo recibido por el programa Android a la bandeja de la web
    if (!AND) return 0;
    let names = []; try { names = JSON.parse(AND.inboxList() || '[]'); } catch (e) {}
    if (!names.length) return 0;
    const got = [], done = [];
    for (const n of names) {
      try { const r = await fetch('/__bandeja__/' + encodeURIComponent(n), { cache: 'no-store' }); if (!r.ok) continue; got.push(unpackItem(await r.arrayBuffer())); done.push(n); }
      catch (e) { console.warn('[sh-core] bandeja Android', n, e); done.push(n); }
    }
    if (got.length) { const k = 'v2:in:' + me; let cur = []; try { cur = (await IDB.get(k)) || []; } catch (e) {} await IDB.set(k, cur.concat(got).slice(-64)); }
    if (done.length) AND.inboxDone(done.join(','));
    return got.length;
  }

  const bridge = {
    /* items: [{name, kind, audio:AudioBuffer | wav:ArrayBuffer, bpm, key, notes, meta}] */
    async send(to, items, from) {
      const list = (Array.isArray(items) ? items : [items]).map(it => normItem(it, from || bridge.me));
      if (D && D.bridge) { await D.bridge.put(to, list); }
      else if (AND) {
        const a = appById(to);
        if (!AND.hasApp(to)) throw new Error((a ? a.name : to) + ' no está instalada en este móvil. Instálala desde el portal (Descargar apps → Android) o usa la versión web.');
        const names = [];
        for (const it of list) {
          const u = packItem(it), id = AND.outBegin(); if (id < 0) throw new Error('No se pudo preparar el envío');
          for (let i = 0; i < u.length; i += 393216) AND.chunk(id, b64(u.subarray(i, i + 393216)));
          const nm = AND.outEnd(id); if (!nm) throw new Error('No se pudo preparar el envío'); names.push(nm);
        }
        if (!AND.sendTo(to, names.join(','))) throw new Error('No se pudo abrir ' + (a ? a.name : to));
        bridge._sentAndroid = true;
      }
      else {
        const k = 'v2:in:' + to; let cur = []; try { cur = (await IDB.get(k)) || []; } catch (e) {}
        cur = cur.concat(list).slice(-64);
        await IDB.set(k, cur);
      }
      try { chan && chan.postMessage({ to, n: list.length, from: from || bridge.me }); } catch (e) {}
      if (SUITE) try { SUITE.notify(to); } catch (e) {}
      return list.length;
    },
    async inbox(me) {
      me = me || bridge.me;
      if (D && D.bridge) return (await D.bridge.list(me)) || [];
      try { await pullNative(me); } catch (e) { console.warn('[sh-core] bandeja Android:', e); }
      try { return (await IDB.get('v2:in:' + me)) || []; } catch (e) { return []; }
    },
    async remove(me, ids) {
      me = me || bridge.me;
      if (D && D.bridge) return D.bridge.remove(me, ids || null);
      if (!ids) return IDB.del('v2:in:' + me);
      const cur = ((await IDB.get('v2:in:' + me)) || []).filter(x => !ids.includes(x.id));
      return cur.length ? IDB.set('v2:in:' + me, cur) : IDB.del('v2:in:' + me);
    },
    /* Llama a cb(items) cuando hay algo nuevo en el buzón de «me» */
    watch(me, cb) {
      bridge.me = me;
      // 1.5.0: una sola vigilancia por app (el menú común puede tomar el relevo del botón «⇄ Apps»: se cambia el aviso)
      if (bridge._w && bridge._w.me === me) { bridge._w.cb = cb; return bridge._w.check; }
      const W = bridge._w = { me, cb };
      let busy = false, lastSig = '';
      const check = W.check = async () => {
        if (busy) return; busy = true;
        try {
          const items = await bridge.inbox(me);
          const sig = items.map(x => x.id).join(',');
          if (items.length && sig !== lastSig) { lastSig = sig; await W.cb(items); }
          if (!items.length) lastSig = '';
        } catch (e) { console.warn('[sh-core] bandeja:', e); }
        busy = false;
      };
      setTimeout(check, 1200);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      G.addEventListener('focus', check);
      G.addEventListener('sh-bandeja', check);   // Android: acaba de llegar algo de otra app
      if (chan) chan.onmessage = e => { if (e.data && e.data.to === me) check(); };
      if (D && D.bridge && D.bridge.onArrive) D.bridge.onArrive(me, check);
      return check;
    },
    me: null
  };

  /* ---------------- Abrir otra app ---------------- */
  async function open(id) {
    const a = appById(id); if (!a) return false;
    if (D && D.openApp) { try { if (await D.openApp(id)) return true; } catch (e) {} }
    if (SUITE) { if (SUITE.open(id)) return true; alert(a.name + ' no está dentro de esta versión de SampledHead.'); return false; }
    if (AND) { if (bridge._sentAndroid) { bridge._sentAndroid = false; return true; }   // el envío ya la ha abierto
      if (AND.openApp(id)) return true;
      alert(a.name + ' no está instalada en este móvil. Instálala desde el portal (Descargar apps → Android) o usa la versión web.'); return false; }
    const w = G.open(a.url, '_blank'); return !!w;
  }

  /* ---------------- Modelos (una sola descarga para todas las apps) ---------------- */
  const MODEL_CACHE = 'sh-models-v1';
  const models = {
    /* Devuelve el ArrayBuffer del modelo. onProgress(fracción 0–1, bytes, total) */
    async get(url, opts) {
      opts = opts || {}; const prog = opts.onProgress || (() => {});
      if (D && D.models) return D.models.get(url, opts.name || url.split('/').pop(), p => prog(p.frac, p.bytes, p.total));
      let cache = null; try { cache = await caches.open(MODEL_CACHE); const hit = await cache.match(url); if (hit) { prog(1); return await hit.arrayBuffer(); } } catch (e) {}
      // Sample Pack Builder guardaba los modelos aparte: se reaprovechan
      try { const old = await caches.open('spb-models-v1'); const hit = await old.match(url); if (hit) { const ab = await hit.arrayBuffer(); try { cache && await cache.put(url, new Response(ab.slice(0))); } catch (e) {} prog(1); return ab; } } catch (e) {}
      const r = await fetch(url); if (!r.ok) throw new Error('No se pudo descargar el modelo (' + r.status + '): ' + url);
      const total = +r.headers.get('content-length') || opts.size || 0;
      let ab;
      if (r.body && r.body.getReader) {
        const rd = r.body.getReader(), parts = []; let got = 0;
        for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; prog(total ? got / total : 0, got, total); }
        const u = new Uint8Array(got); let o = 0; for (const p of parts) { u.set(p, o); o += p.length; } ab = u.buffer;
      } else ab = await r.arrayBuffer();
      try { cache && await cache.put(url, new Response(ab.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { console.warn('[sh-core] no se pudo guardar el modelo en caché:', e); }
      prog(1); return ab;
    },
    async has(url) {
      if (D && D.models) return D.models.has(url);
      try { const c = await caches.open(MODEL_CACHE); return !!(await c.match(url)); } catch (e) { return false; }
    }
  };

  /* ---------------- Motor local (Windows y Mac) ---------------- */
  const engine = {
    available: !!(D && D.engine),
    async status() { return D && D.engine ? D.engine.status() : { installed: false, running: false, reason: 'Solo en las apps de Windows y Mac' }; },
    async install(parts, onProgress) { if (!D || !D.engine) throw new Error('El motor local solo está en las apps de Windows y Mac'); return D.engine.install(parts || [], onProgress || (() => {})); },
    /* task: 'separate' | 'sam' | 'lyrics' | 'notes'. input: {wav:ArrayBuffer} o {path}. Devuelve {files:[{name, wav:ArrayBuffer}], data:{}} */
    async run(task, input, params, onProgress) { if (!D || !D.engine) throw new Error('El motor local solo está en las apps de Windows y Mac'); return D.engine.run(task, input, params || {}, onProgress || (() => {})); }
  };

  /* ---------------- Copia de los datos de una app (.shdatos) ----------------
   * Para pasar una app de la web (o de otro navegador u ordenador) a la plataforma SampledHead de escritorio.
   * En la web todas las apps comparten el dominio, así que cada app solo copia lo suyo (OWN).
   * Formato: «SHDAT1» + u32 largo del JSON + JSON + datos binarios seguidos (ArrayBuffer, vistas tipadas y Blob). */
  const OWN = {
    sampler: { idb: ['sampler'], ls: k => (k.startsWith('sampledhead.') && !k.startsWith('sampledhead.tuner')) || k.startsWith('sh_'),
      state: (db, st, k) => k === 'proj:__auto__' || /^gen:\d+$/.test(String(k)) },   // autoguardado y sonidos actuales del generador
    editor: { idb: ['shed-projects'], ls: k => k.startsWith('shed.') },
    crazyhead: { idb: ['crazyhead'], ls: k => k.startsWith('crazyhead.'), state: (db, st) => st === 'aud' },   // loops A–D que están cargados ahora
    fuzzhead: { idb: [], ls: k => k.startsWith('fuzzhead-') || k.startsWith('trazo-gs1-') },
    glitchhead: { idb: [], ls: k => k.startsWith('glitchhead.') },
    tuner: { idb: [], ls: k => k.startsWith('sampledhead.tuner') },
    tonopad: { idb: ['tonopad'], ls: k => k.startsWith('tonopad.') },
    chuleta: { idb: [], ls: k => k.startsWith('chuleta') },
    spb: { idb: [], ls: k => k.startsWith('spb') }
  };
  const TA = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array'];
  async function enc(v, bins) {
    if (v == null || typeof v !== 'object') return v;
    if (v instanceof ArrayBuffer) { bins.push(new Uint8Array(v)); return { __b: bins.length - 1 }; }
    if (ArrayBuffer.isView(v)) { bins.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)); return { __t: v.constructor.name, __b: bins.length - 1 }; }
    if (typeof Blob !== 'undefined' && v instanceof Blob) { bins.push(new Uint8Array(await v.arrayBuffer())); return { __blob: v.type || '', __b: bins.length - 1, __name: v.name || null }; }
    if (v instanceof Date) return { __date: v.getTime() };
    if (v instanceof Map) return { __map: await enc([...v.entries()], bins) };
    if (v instanceof Set) return { __set: await enc([...v.values()], bins) };
    if (Array.isArray(v)) { const o = []; for (const x of v) o.push(await enc(x, bins)); return o; }
    const o = {}; for (const k of Object.keys(v)) o[k] = await enc(v[k], bins); return o;
  }
  function dec(v, bins) {
    if (v == null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(x => dec(x, bins));
    if (v.__b != null && v.__t) { const u = bins[v.__b], C = TA.includes(v.__t) ? G[v.__t] : Uint8Array, ab = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); return v.__t === 'DataView' ? new DataView(ab) : new C(ab); }
    if (v.__b != null && v.__blob != null) { const u = bins[v.__b]; return v.__name ? new File([u], v.__name, { type: v.__blob }) : new Blob([u], { type: v.__blob }); }
    if (v.__b != null && Object.keys(v).length === 1) { const u = bins[v.__b]; return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); }
    if (v.__date != null) return new Date(v.__date);
    if (v.__map) return new Map(dec(v.__map, bins));
    if (v.__set) return new Set(dec(v.__set, bins));
    const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k], bins); return o;
  }
  const req = r => new Promise((ok, ko) => { r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  function openDb(name, version, upgrade) {
    return new Promise((ok, ko) => {
      const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
      let t = setTimeout(() => ko(new Error('La base «' + name + '» está ocupada: cierra las otras pestañas de esta app y vuelve a intentarlo')), 6000);
      r.onupgradeneeded = e => { if (upgrade) upgrade(r.result, r.transaction, e.oldVersion); };
      r.onsuccess = () => { clearTimeout(t); ok(r.result); }; r.onerror = () => { clearTimeout(t); ko(r.error); }; r.onblocked = () => {};
    });
  }
  const keyStr = k => (typeof k) + ':' + (typeof k === 'object' ? JSON.stringify(k) : String(k));
  const copyName = (n, i) => String(n) + (i > 1 ? ' (copia ' + i + ')' : ' (copia)');
  const strip = (v, kp) => { if (!v || typeof v !== 'object' || ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof Blob !== 'undefined' && v instanceof Blob)) return v; const o = Object.assign({}, v); if (typeof kp === 'string') delete o[kp]; delete o.name; delete o.nombre; return o; };
  function setPath(v, kp, val) { if (typeof kp !== 'string') return v; const o = Object.assign({}, v); if (val === undefined) delete o[kp]; else o[kp] = val; return o; }
  async function same(a, b) {   // comparación profunda (también binarios y Blob)
    const bA = [], bB = []; const ja = JSON.stringify(await enc(a, bA)), jb = JSON.stringify(await enc(b, bB));
    if (ja !== jb || bA.length !== bB.length) return false;
    for (let i = 0; i < bA.length; i++) { const x = bA[i], y = bB[i]; if (x.byteLength !== y.byteLength) return false; for (let j = 0; j < x.length; j++) if (x[j] !== y[j]) return false; }
    return true;
  }
  function putAll(db, s, recs, clear) {
    return new Promise((ok, ko) => {
      const tx = db.transaction(s.name, 'readwrite'), st = tx.objectStore(s.name); if (clear) st.clear();
      for (const r of recs) { if (s.keyPath != null || r.k === undefined) st.put(r.v); else st.put(r.v, r.k); }
      tx.oncomplete = ok; tx.onerror = () => ko(tx.error); tx.onabort = () => ko(tx.error);
    });
  }
  /* Ajustes de localStorage: si ambos son listas o colecciones de objetos (escenas, presets propios, afinaciones…) se
     suman; cualquier otro ajuste se queda como está en este dispositivo. */
  function mergeLs(cur, inc) {
    let a, b; try { a = JSON.parse(cur); b = JSON.parse(inc); } catch (e) { return null; }
    const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
    if (Array.isArray(a) && Array.isArray(b) && b.length && b.every(isObj) && a.every(isObj)) {
      const seen = new Set(a.map(x => JSON.stringify(x))), out = a.slice();
      for (const x of b) { if (seen.has(JSON.stringify(x))) continue; let y = x;
        const nm = ['name', 'nombre', 'n', 'title'].find(f => typeof x[f] === 'string');
        let dup = false;
        if (nm) for (let n = 1; out.some(z => z[nm] === y[nm]) && n < 500; n++) { y = Object.assign({}, x, { [nm]: copyName(x[nm], n) }); if (seen.has(JSON.stringify(y))) { dup = true; break; } }
        if (dup) continue; out.push(y); seen.add(JSON.stringify(y)); }
      return JSON.stringify(out);
    }
    if (isObj(a) && isObj(b) && Object.keys(b).length && Object.values(b).every(isObj) && Object.values(a).every(isObj)) {
      const out = Object.assign({}, a);
      for (const [k, v] of Object.entries(b)) { if (!(k in out)) out[k] = v; else if (JSON.stringify(out[k]) !== JSON.stringify(v)) { for (let n = 1; n < 500; n++) { const nk = copyName(k, n); if (!(nk in out)) { out[nk] = v; break; } if (JSON.stringify(out[nk]) === JSON.stringify(v)) break; } } }
      return JSON.stringify(out);
    }
    return null;
  }
  const backup = {
    owned: me => OWN[me] || null,
    /* Devuelve un Blob con los datos de la app «me» */
    async export(me) {
      const own = OWN[me]; if (!own) throw new Error('Esta app no tiene datos que copiar');
      const bins = [], data = { app: me, core: VERSION, ts: Date.now(), from: location.href, ls: {}, idb: [] };
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (own.ls(k)) data.ls[k] = localStorage.getItem(k); }
      let have = null; try { if (indexedDB.databases) have = (await indexedDB.databases()).map(x => x.name); } catch (e) {}
      for (const name of own.idb) {
        if (have && !have.includes(name)) continue;          // no se crea una base vacía (la app no podría prepararla después)
        let db; try { db = await openDb(name); } catch (e) { continue; }
        const d = { name, version: db.version, stores: [] };
        for (const sn of [...db.objectStoreNames]) {
          const tx = db.transaction(sn, 'readonly'), st = tx.objectStore(sn);
          const s = { name: sn, keyPath: st.keyPath, autoIncrement: st.autoIncrement, indexes: [...st.indexNames].map(n => { const ix = st.index(n); return { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; }), records: [] };
          const keys = await req(st.getAllKeys()), vals = await req(st.getAll());
          for (let k = 0; k < keys.length; k++) s.records.push({ k: await enc(keys[k], bins), v: await enc(vals[k], bins) });
          d.stores.push(s);
        }
        db.close(); data.idb.push(d);
      }
      const js = new TextEncoder().encode(JSON.stringify(data)), hd = new Uint8Array(10);
      hd.set([83, 72, 68, 65, 84, 49]); new DataView(hd.buffer).setUint32(6, js.length, true);
      const lens = new Uint8Array(4 * bins.length); bins.forEach((b, i) => new DataView(lens.buffer).setUint32(i * 4, b.byteLength, true));
      const cnt = new Uint8Array(4); new DataView(cnt.buffer).setUint32(0, bins.length, true);
      return new Blob([hd, js, cnt, lens, ...bins], { type: 'application/octet-stream' });
    },
    parse(ab) {
      const u = new Uint8Array(ab); if (String.fromCharCode(...u.slice(0, 6)) !== 'SHDAT1') throw new Error('No es una copia de datos de Sampled Head (.shdatos)');
      const dv = new DataView(ab), n = dv.getUint32(6, true), data = JSON.parse(new TextDecoder().decode(u.slice(10, 10 + n)));
      let o = 10 + n; const cnt = dv.getUint32(o, true); o += 4; const lens = []; for (let i = 0; i < cnt; i++) { lens.push(dv.getUint32(o, true)); o += 4; }
      const bins = lens.map(l => { const b = u.subarray(o, o + l); o += l; return b; });
      return { data, bins };
    },
    /* Añade los datos de la copia a los de la app (sh-core 1.2.0: por defecto NO se borra ni se sobrescribe nada).
       - Proyectos, kits, presets…: lo que no existe se añade; lo idéntico se salta; si hay algo con el mismo nombre pero
         distinto, se guarda aparte con «(copia)» en el nombre.
       - Estado de trabajo (autoguardado, loops cargados…, ver OWN.state) y ajustes: se quedan los de este dispositivo
         (solo se añaden si faltan).
       - Listas guardadas en ajustes (escenas, presets propios, afinaciones…): se suman.
       Con { replace: true } hace lo de antes (sustituir). Devuelve un resumen. */
    async restore(me, ab, opt) {
      const { data, bins } = backup.parse(ab), own = OWN[me], replace = !!(opt && opt.replace);
      if (data.app !== me) throw new Error('Esta copia es de otra app (' + data.app + ')');
      const res = { nuevos: 0, iguales: 0, copias: 0, ajustes: 0, fecha: data.ts, modo: replace ? 'sustituir' : 'sumar' };
      if (replace) for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (own.ls(k)) localStorage.removeItem(k); }
      for (const [k, v] of Object.entries(data.ls)) {
        const cur = localStorage.getItem(k);
        if (replace || cur == null) { localStorage.setItem(k, v); res.ajustes++; continue; }
        if (cur === v) continue;
        const m = mergeLs(cur, v); if (m != null && m !== cur) { localStorage.setItem(k, m); res.ajustes++; }
      }
      for (const d of data.idb) {
        let db = await openDb(d.name);
        if (!db.objectStoreNames.length) {   // 1.4.1: base recién creada (la app aún no se había abierto): se hace con la MISMA versión que la copia
          db.close(); await new Promise(ok => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = () => ok(); });
          db = await openDb(d.name, d.version || 1, (udb, tx) => { for (const s of d.stores) { const st = udb.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement }); for (const ix of s.indexes) st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry }); } });
        }
        const missing = d.stores.some(s => !db.objectStoreNames.contains(s.name)) || db.version < d.version;
        if (missing) {
          // antes: Math.max(d.version, db.version + 1), que dejaba en la versión 2 una base que la app abre con la 1 → la app
          // no podía abrirla y no se veía nada (sampler en la app única de Android, 24-11-2026)
          const v = db.version < d.version ? d.version : db.version + 1; db.close();
          db = await openDb(d.name, v, (udb, tx) => {
            for (const s of d.stores) {
              let st = udb.objectStoreNames.contains(s.name) ? tx.objectStore(s.name) : udb.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
              for (const ix of s.indexes) if (!st.indexNames.contains(ix.name)) st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
            }
          });
        }
        const ren = new Map();   // claves cambiadas (p. ej. id de proyecto) para mover con ellas lo que cuelga de esa clave en otros almacenes
        const stores = d.stores.slice().sort((a, b) => (a.keyPath == null) - (b.keyPath == null));   // primero los de clave interna (proyectos)
        for (const s of stores) {
          const recs = s.records.map(r => ({ k: dec(r.k, bins), v: dec(r.v, bins) }));
          if (replace) { await putAll(db, s, recs, true); res.nuevos += recs.length; continue; }
          const ex = await new Promise((ok, ko) => { const tx = db.transaction(s.name, 'readonly'), st = tx.objectStore(s.name); const a = st.getAllKeys(), b = st.getAll(); tx.oncomplete = () => ok({ keys: a.result, vals: b.result }); tx.onerror = () => ko(tx.error); });
          const have = new Map(); ex.keys.forEach((k, i) => have.set(keyStr(k), ex.vals[i]));
          const out = [];
          for (const r of recs) {
            let k = r.k, v = r.v;
            for (const [o, n] of ren) if (typeof k === 'string' && (k === o || k.startsWith(o + '#'))) { k = n + k.slice(o.length); break; }   // audio de un proyecto renombrado
            const cur = have.get(keyStr(k));
            if (cur === undefined) { out.push({ k, v }); have.set(keyStr(k), v); res.nuevos++; continue; }
            if (await same(cur, v)) { res.iguales++; continue; }
            if (own.state && own.state(d.name, s.name, k)) { res.iguales++; continue; }   // estado de trabajo: manda este dispositivo
            if (typeof k === 'number' && s.autoIncrement) { if (s.keyPath != null) v = setPath(v, s.keyPath, undefined); out.push({ k: undefined, v }); res.copias++; continue; }
            let nk = null, dup = false;
            if (typeof k === 'number') { nk = Math.max(k, ...[...have.keys()].filter(x => x.startsWith('number:')).map(x => +x.slice(7))) + 1; }
            else for (let n = 1; n < 500; n++) {   // ¿ya se añadió antes como «(copia)»? (importar la misma copia dos veces no duplica)
              const ck = copyName(String(k), n), hv = have.get(keyStr(ck));
              if (hv === undefined) { nk = ck; break; }
              if (await same(strip(hv, s.keyPath), strip(v, s.keyPath))) { nk = ck; dup = true; break; }
            }
            if (typeof k === 'string' && s.keyPath != null) ren.set(k, nk);
            if (dup) { res.iguales++; continue; }
            if (v && typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && !(typeof Blob !== 'undefined' && v instanceof Blob)) {
              v = Object.assign({}, v);
              if (s.keyPath != null) v = setPath(v, s.keyPath, nk);
              if (typeof v.name === 'string') v.name = v.name === String(k) ? String(nk) : copyName(v.name);
              else if (typeof v.nombre === 'string') v.nombre = copyName(v.nombre);
            }
            out.push({ k: s.keyPath != null ? undefined : nk, v }); have.set(keyStr(nk), v); res.copias++;
          }
          await putAll(db, s, out, false);
        }
        db.close();
      }
      res.registros = res.nuevos + res.copias;   // compatibilidad con quien leía «registros»
      return res;
    },
    summary(r) { return 'Copia añadida: ' + r.nuevos + ' elementos nuevos' + (r.copias ? ', ' + r.copias + ' guardados como «(copia)» porque ya tenías uno distinto con el mismo nombre' : '') + (r.iguales ? ', ' + r.iguales + ' que ya tenías' : '') + (r.ajustes ? ' y ' + r.ajustes + ' listas o ajustes que faltaban' : '') + '. No se ha borrado nada.'; },
    fileName(me) { const a = appById(me); return (a ? a.name : me).replace(/[^A-Za-z0-9]+/g, '-') + '-datos-' + new Date().toISOString().slice(0, 10) + '.shdatos'; },
    download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
    /* Interfaz común: hoja con «Guardar copia» y «Recuperar copia» */
    sheet(me) {
      const { sh, close } = ui.sheet('Copia de tus datos', 'Kits, presets, proyectos y ajustes de esta app. Sirve para pasarlos a SampledHead para Windows y Mac (Inicio → «Traer mis datos») o a otro navegador.');
      backup.rows(me, sh);
      const foot = el('div', 'shc-foot'), c = el('button', 'shc-b', 'Cerrar'); c.onclick = close; foot.appendChild(c); sh.appendChild(foot);
    },
    /* Las dos filas «Guardar copia» y «Añadir una copia» (las usan la hoja de arriba y el menú común) */
    rows(me, sh) {
      const r1 = el('div', 'shc-row'), i1 = el('div'); i1.appendChild(el('b', null, 'Guardar copia (.shdatos)')); i1.appendChild(el('small', null, 'Descarga un archivo con todo lo que tiene guardado esta app'));
      const b1 = el('button', 'shc-b pri', 'Guardar');
      b1.onclick = async () => { b1.disabled = true; b1.textContent = 'Preparando…'; try { const bl = await backup.export(me); backup.download(bl, backup.fileName(me)); b1.textContent = 'Guardado (' + (bl.size / 1048576).toFixed(1) + ' MB)'; } catch (e) { b1.textContent = 'Error'; alert(e.message || e); b1.disabled = false; } };
      r1.appendChild(i1); r1.appendChild(b1); sh.appendChild(r1);
      const r2 = el('div', 'shc-row'), i2 = el('div'); i2.appendChild(el('b', null, 'Añadir una copia')); i2.appendChild(el('small', null, 'Suma a esta app los proyectos, kits y presets de un archivo .shdatos (de la web, del móvil o de otro ordenador). No se borra ni se sobrescribe nada: lo que se llame igual pero sea distinto se guarda como «(copia)».'));
      const b2 = el('button', 'shc-b', 'Elegir archivo'), fi = el('input'); fi.type = 'file'; fi.accept = '.shdatos'; fi.hidden = true;
      fi.onchange = async () => { const f = fi.files[0]; fi.value = ''; if (!f) return;
        if (!confirm('Se añadirá lo que trae «' + f.name + '» a lo que ya tienes en esta app (sin borrar nada) y se recargará. ¿Seguir?')) return;
        try { const r = await backup.restore(me, await f.arrayBuffer()); alert(backup.summary(r)); location.reload(); } catch (e) { alert('No se pudo recuperar: ' + (e.message || e)); } };
      b2.onclick = () => fi.click();
      r2.appendChild(i2); r2.appendChild(b2); r2.appendChild(fi); sh.appendChild(r2);
    }
  };
  /* En la plataforma de escritorio: si «Traer mis datos» dejó una copia para esta app, se aplica al abrirla */
  if (D && D.backup && D.info) {
    const tryPending = async () => {
      try {
        const info = await D.info(); const ab = await D.backup.pending(); if (!ab) return;
        let r, n = 0; const all = [];
        for (let buf = ab; buf && n < 20; buf = await D.backup.pending(), n++) { r = await backup.restore(info.appId, buf); all.push(r); }   // pueden venir varias (web, móvil…)
        console.log('[sh-core] copias añadidas', all); alert(all.map(backup.summary).join('\n')); location.reload();
      } catch (e) { console.error('[sh-core] no se pudo aplicar la copia', e); alert('No se pudieron traer los datos: ' + (e.message || e)); }
    };
    if (document.readyState === 'complete') setTimeout(tryPending, 800); else G.addEventListener('load', () => setTimeout(tryPending, 800));
  }

  /* ---------------- Interfaz: hojas «Enviar a…» y «Recibido» ---------------- */
  const CSS = '.shc-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:flex-end;justify-content:center;font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '@media(min-width:640px){.shc-ov{align-items:center}}' +
    '.shc-sh{background:#1b1712;color:#f3efe9;width:min(520px,100%);max-height:86vh;overflow:auto;border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));box-shadow:0 10px 40px rgba(0,0,0,.5)}' +
    '@media(min-width:640px){.shc-sh{border-radius:16px}}' +
    '.shc-sh h3{margin:0 0 4px;font-size:17px}.shc-sh .shc-sub{opacity:.7;font-size:12.5px;margin-bottom:10px}' +
    '.shc-row{display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;background:#2a241d;margin:6px 0}' +
    '.shc-row b{display:block}.shc-row small{opacity:.7}.shc-row>div{flex:1;min-width:0}' +
    '.shc-b{appearance:none;border:0;border-radius:9px;padding:8px 12px;font:600 13px system-ui,sans-serif;cursor:pointer;background:#3a3229;color:#f3efe9}' +
    '.shc-b.pri{background:#d65f00;color:#fff}.shc-b:disabled{opacity:.45;cursor:default}' +
    '.shc-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}' +
    '.shc-chk{display:flex;gap:8px;align-items:center;margin:8px 2px;font-size:13px}';
  function ensureCss() { if (document.getElementById('shc-css')) return; const s = document.createElement('style'); s.id = 'shc-css'; s.textContent = CSS; document.head.appendChild(s); }
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function sheet(title, sub) {
    ensureCss();
    const ov = el('div', 'shc-ov'), sh = el('div', 'shc-sh');
    sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', title);
    sh.appendChild(el('h3', null, title)); if (sub) sh.appendChild(el('div', 'shc-sub', sub));
    ov.appendChild(sh); document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    return { ov, sh, close };
  }
  const KIND = { pad: 'sonido', loop: 'loop', stem: 'pista', phrase: 'frase', notes: 'notas', kit: 'kit' };

  const ui = {
    /* opts: { from, title?, kinds:[...], count?:n, getItems: async (toApp)=>items, onDone? } */
    sendSheet(opts) {
      const from = opts.from || bridge.me, kinds = opts.kinds || ['pad'];
      const { sh, close } = sheet(opts.title || 'Enviar a…', (opts.count ? opts.count + ' elemento' + (opts.count === 1 ? '' : 's') + ' · ' : '') +
        (D ? 'Se guarda en Documentos/SampledHead/Bandeja.' : SUITE ? 'Llega al momento a la otra app de SampledHead.' : AND ? 'Se pasa a la app instalada en este móvil y se abre.' : 'Se guarda en este navegador para las demás apps de Sampled Head.'));
      const openChk = el('label', 'shc-chk'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = opts.openAfter !== false;
      if (AND) { cb.checked = true; openChk.hidden = true; }   // en Android la otra app se abre siempre al recibir
      openChk.appendChild(cb); openChk.appendChild(document.createTextNode('Abrir la app al enviar'));
      APPS.filter(a => a.id !== from).forEach(a => {
        const inst = SUITE ? SUITE.has(a.id) : !AND || AND.hasApp(a.id), ok = inst && kinds.some(k => a.takes.includes(k));
        const row = el('div', 'shc-row'), info = el('div');
        info.appendChild(el('b', null, a.name)); info.appendChild(el('small', null, a.desc));
        const b = el('button', 'shc-b pri', inst ? 'Enviar' : 'No instalada'); b.disabled = !ok; if (!inst) b.title = 'Instálala desde el portal (Descargar apps → Android)'; else if (!ok) b.title = 'Esta app no recibe ' + kinds.map(k => KIND[k] || k).join(' ni ');
        b.onclick = async () => {
          b.disabled = true; b.textContent = 'Enviando…';
          try {
            const items = await opts.getItems(a.id);
            if (!items || !items.length) { b.textContent = 'Nada que enviar'; return; }
            const n = await bridge.send(a.id, items, from);
            b.textContent = 'Enviado (' + n + ')';
            if (cb.checked) await open(a.id);
            opts.onDone && opts.onDone(a.id, n);
            setTimeout(close, 600);
          } catch (e) { console.error(e); b.textContent = 'Error'; b.disabled = false; if (opts.onError) opts.onError(e); else if (AND) alert(e.message || e); }
        };
        row.appendChild(info); row.appendChild(b); sh.appendChild(row);
      });
      sh.appendChild(openChk);
      const foot = el('div', 'shc-foot'), c = el('button', 'shc-b', 'Cerrar'); c.onclick = close; foot.appendChild(c); sh.appendChild(foot);
      return close;
    },
    /* Muestra lo recibido. onTake(items) debe cargarlos; devuelve true si se han usado (se borran de la bandeja) */
    async receiveSheet(me, onTake, items) {
      items = items || await bridge.inbox(me);
      if (!items.length) return false;
      const { sh, close } = sheet('Recibido de otras apps', items.length + ' elemento' + (items.length === 1 ? '' : 's') + ' en la bandeja');
      const take = async list => {
        try { const used = await onTake(list); if (used !== false) await bridge.remove(me, list.map(x => x.id)); }
        catch (e) { console.error(e); alert('No se pudo cargar: ' + (e && e.message || e)); }
      };
      items.slice().reverse().forEach(it => {
        const row = el('div', 'shc-row'), info = el('div'), src = appById(it.from);
        info.appendChild(el('b', null, it.name));
        info.appendChild(el('small', null, (KIND[it.kind] || it.kind) + ' · de ' + (src ? src.name : it.from) +
          (it.secs ? ' · ' + it.secs.toFixed(1) + ' s' : '') + (it.bpm ? ' · ' + Math.round(it.bpm) + ' BPM' : '') + (it.notes ? ' · ' + it.notes.length + ' notas' : '')));
        const b = el('button', 'shc-b pri', 'Cargar'); b.onclick = async () => { b.disabled = true; await take([it]); row.remove(); if (!sh.querySelector('.shc-row')) close(); };
        row.appendChild(info); row.appendChild(b); sh.appendChild(row);
      });
      const foot = el('div', 'shc-foot');
      const all = el('button', 'shc-b pri', 'Cargar todo'); all.onclick = async () => { all.disabled = true; await take(items); close(); };
      const del = el('button', 'shc-b', 'Vaciar bandeja'); del.onclick = async () => { await bridge.remove(me, null); close(); };
      const later = el('button', 'shc-b', 'Más tarde'); later.onclick = close;
      foot.appendChild(del); foot.appendChild(later); if (items.length > 1) foot.appendChild(all); sh.appendChild(foot);
      return true;
    },
    sheet,
    /* Botón flotante «⇄ Apps» para las apps que no tienen un menú propio para esto.
     * opts: { me, kinds:[...], provide: async ()=>items|null, accept: async (items)=>bool, pos:'left'|'right', bottom:px } */
    dock(opts) {
      // 1.5.0: si la app tiene el menú común, «Enviar a…», «Recibido» y la copia de datos van dentro del menú (sin botón flotante)
      ui._dockOpts = opts;
      if (ui._menu) { ui._menu.adoptDock(opts); return { refresh: () => ui._menu.refresh(), button: null }; }
      const h = { refresh: () => (h._r ? h._r() : ui._menu && ui._menu.refresh()), button: null };
      const go = () => { if (ui._menu) { ui._menu.adoptDock(opts); return; } const r = ui._dockFloat(opts); h._r = r.refresh; h.button = r.button; };
      if (document.readyState === 'complete') setTimeout(go, 0); else G.addEventListener('load', () => setTimeout(go, 0), { once: true });
      return h;
    },
    _dockFloat(opts) {
      ensureCss();
      if (!document.getElementById('shc-dock-css')) {
        const s = document.createElement('style'); s.id = 'shc-dock-css';
        s.textContent = '.shc-dock{position:fixed;z-index:9990;bottom:calc(var(--shc-bottom,14px) + env(safe-area-inset-bottom));border:0;border-radius:999px;padding:9px 13px;font:700 13px system-ui,sans-serif;background:#d65f00;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;opacity:.92}' +
          '.shc-dock:hover{opacity:1}.shc-dock i{font-style:normal;background:#fff;color:#d65f00;border-radius:999px;padding:0 6px;margin-left:6px;font-size:12px}' +
          '@media print{.shc-dock{display:none}}';
        document.head.appendChild(s);
      }
      const b = el('button', 'shc-dock'); b.type = 'button'; b.title = 'Enviar a otras apps de Sampled Head o recoger lo recibido';
      b.style[opts.pos === 'right' ? 'right' : 'left'] = 'calc(14px + env(safe-area-inset-' + (opts.pos === 'right' ? 'right' : 'left') + '))';
      if (opts.bottom != null) b.style.setProperty('--shc-bottom', opts.bottom + 'px');
      const paint = n => { b.textContent = opts.label || '⇄ Apps'; if (n) { const i = el('i', null, String(n)); b.appendChild(i); } };
      paint(0);
      const refresh = async () => { if (opts.backupOnly) return; try { paint((await bridge.inbox(opts.me)).length); } catch (e) {} };
      b.onclick = async () => {
        const n = opts.backupOnly ? 0 : (await bridge.inbox(opts.me)).length;
        const { sh, close } = sheet('Apps de Sampled Head', n ? n + ' elemento' + (n === 1 ? '' : 's') + ' recibido' + (n === 1 ? '' : 's') : 'Bandeja vacía');
        const r1 = el('div', 'shc-row'), i1 = el('div'); i1.appendChild(el('b', null, 'Recibido')); i1.appendChild(el('small', null, 'Lo que te han enviado las otras apps'));
        const b1 = el('button', 'shc-b pri', 'Ver'); b1.disabled = !n; b1.onclick = async () => { close(); await ui.receiveSheet(opts.me, async l => { const ok = await opts.accept(l); setTimeout(refresh, 300); return ok; }); };
        r1.appendChild(i1); r1.appendChild(b1); sh.appendChild(r1);
        const r2 = el('div', 'shc-row'), i2 = el('div'); i2.appendChild(el('b', null, 'Enviar a…')); i2.appendChild(el('small', null, opts.sendHint || 'Manda el audio actual a otra app'));
        const b2 = el('button', 'shc-b pri', 'Elegir app'); b2.disabled = !opts.provide;
        b2.onclick = async () => {
          const items = opts.provide ? await opts.provide() : null;
          if (!items || !items.length) { b2.textContent = 'No hay audio que enviar'; return; }
          close(); ui.sendSheet({ from: opts.me, kinds: opts.kinds || items.map(x => x.kind || 'pad'), count: items.length, getItems: async () => items });
        };
        r2.appendChild(i2); r2.appendChild(b2); if (!opts.backupOnly) sh.appendChild(r2); else r1.remove();
        if (OWN[opts.me]) { const r3 = el('div', 'shc-row'), i3 = el('div'); i3.appendChild(el('b', null, 'Copia de tus datos')); i3.appendChild(el('small', null, 'Guardar o recuperar kits, presets y proyectos (para pasarlos a SampledHead de escritorio u otro navegador)'));
          const b3 = el('button', 'shc-b', 'Abrir'); b3.onclick = () => { close(); backup.sheet(opts.me); }; r3.appendChild(i3); r3.appendChild(b3); sh.appendChild(r3); }
        if (D && D.openFolder) { const r3 = el('div', 'shc-foot'), b3 = el('button', 'shc-b', 'Abrir la carpeta compartida'); b3.onclick = () => D.openFolder(); r3.appendChild(b3); sh.appendChild(r3); }
      };
      document.body.appendChild(b); ui._dockBtn = b;
      if (!opts.backupOnly) bridge.watch(opts.me, async items => { paint(items.length); if (opts.autoOpen !== false) await ui.receiveSheet(opts.me, async l => { const ok = await opts.accept(l); setTimeout(refresh, 300); return ok; }, items); });
      return { refresh, button: b };
    },
    /* Convierte un elemento recibido en un File de audio (para las apps que cargan desde un <input type=file>) */
    toFile(it) { return new File([it.wav], String(it.name || 'audio').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) + '.wav', { type: 'audio/wav' }); },
    /* Mete un archivo en un <input type=file> de la app como si lo hubiera elegido el usuario */
    feedInput(input, file) {
      if (typeof input === 'string') input = document.querySelector(input);
      if (!input) return false;
      const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true })); input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
  };


  /* ---------------- 1.5.0: informe de error común (.txt) ----------------
   * SH.report.install({ me, version, options: ()=>({…}), auto: false }) recoge errores, pasos y las últimas 300 líneas de
   * consola; SH.report.download(where?, err?) descarga el .txt con lo que piden las normas de entrega de las apps. */
  const report = (() => {
    const lines = [], steps = []; let cfg = { me: 'app' }, autos = 0, installed = false;
    const now = () => new Date().toISOString().slice(11, 23);
    function push(kind, args) { try { lines.push(now() + ' [' + kind + '] ' + Array.from(args).map(a => a && a.stack ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')); if (lines.length > 300) lines.splice(0, lines.length - 300); } catch (e) {} }
    function install(o) {
      cfg = Object.assign(cfg, o || {}); if (installed) return; installed = true;
      ['log', 'info', 'warn', 'error'].forEach(k => { const f = console[k]; console[k] = function () { push(k, arguments); return f.apply(console, arguments); }; });
      G.addEventListener('error', e => { push('window.onerror', [e.message + ' ' + (e.filename || '') + ':' + (e.lineno || '') + (e.error && e.error.stack ? '\n' + e.error.stack : '')]); if (cfg.auto && autos++ < 2) download('window.onerror', e.error || e.message); });
      G.addEventListener('unhandledrejection', e => { push('unhandledrejection', [e.reason && e.reason.stack || e.reason]); if (cfg.auto && autos++ < 2) download('promesa sin capturar', e.reason); });
    }
    function step(t) { steps.push(now() + '  ' + t); if (steps.length > 200) steps.shift(); }
    function text(where, err) {
      const a = appById(cfg.me), n = navigator, sc = G.screen || {}, mem = performance && performance.memory;
      let o = ''; try { o = JSON.stringify(cfg.options ? cfg.options() : {}, null, 1); } catch (e) { o = '(no se pudieron leer)'; }
      return ['INFORME DE ERROR · ' + (a ? a.name : cfg.me), 'Versión: ' + (typeof cfg.version === 'function' ? cfg.version() : cfg.version || '?') + ' · sh-core ' + VERSION,
        'Fecha: ' + new Date().toString(), 'Dónde: ' + (where || 'informe manual'), 'Mensaje: ' + (err ? (err.message || err) : '(informe manual)'), 'Stack: ' + (err && err.stack || '-'), '',
        'Navegador/UA: ' + n.userAgent, 'Plataforma: ' + (n.platform || '') + ' · ' + (D ? 'escritorio' : SUITE ? 'Android (app única)' : AND ? 'Android' : 'web'),
        'Núcleos: ' + (n.hardwareConcurrency || '?') + ' · RAM: ' + (n.deviceMemory ? n.deviceMemory + ' GB' : '?') + ' · Pantalla: ' + (sc.width || '?') + 'x' + (sc.height || '?') + ' @' + (G.devicePixelRatio || 1) + 'x',
        'URL: ' + location.href + ' · contexto seguro: ' + (G.isSecureContext ? 'sí' : 'no') + ' · COOP/COEP (aislado): ' + (G.crossOriginIsolated ? 'sí' : 'no') + ' · WebGPU: ' + ('gpu' in n ? 'sí' : 'no'),
        'Memoria JS: ' + (mem ? Math.round(mem.usedJSHeapSize / 1048576) + '/' + Math.round(mem.jsHeapSizeLimit / 1048576) + ' MB' : '?'),
        'Opciones: ' + o, '', '--- Cronología ---'].concat(steps, ['', '--- Consola (últimas ' + lines.length + ' líneas) ---'], lines).join('\n');
    }
    function download(where, err) {
      const a = appById(cfg.me), name = (a ? a.name : cfg.me).replace(/[^A-Za-z0-9]+/g, '-') + '-v' + (typeof cfg.version === 'function' ? cfg.version() : cfg.version || '') + '-informe-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
      backup.download(new Blob([text(where, err)], { type: 'text/plain' }), name);
    }
    return { install, step, text, download };
  })();

  /* ---------------- 1.5.0: menú común «☰ Menú» ----------------
   * Las mismas secciones, con el mismo nombre y en el mismo orden en todas las apps (petición del usuario, 24-11-2026):
   *   Proyecto · Importar · Exportar · Otras apps · Copia de tus datos · Ajustes · Ayuda
   * opts: {
   *   me, name?, version?, lang?: ()=>'es'|'en', button?: elemento o selector (el botón de la app que abre el menú),
   *   proyecto, importar, exportar, ajustes, ayuda: [elemento…]   (una sección sin elementos no sale)
   *   apps: { kinds, provide: async ()=>items, accept: async items=>bool, sendHint, extra:[elemento…] } | false
   *   guide: ()=>…, report: ()=>…, button: 'auto' (crea un botón ☰ fijo arriba a la derecha), onOpen: ()=>…
 *   Si la app llama a SH.ui.dock (antes o después), sus opciones pasan a «Otras apps» y no sale el botón flotante.
   * }
   * elemento: { label?, hint?, icon?, pri?, click: '#selector' (pulsa ese botón de la app) | run: fn | node: elemento/selector
   *             (se mueve dentro del menú tal cual, con sus eventos), show?: ()=>bool }
   *   Si no se da label, se usa el texto del botón de «click» (así sale ya traducido por la app). */
  const MCSS = '.shm-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99990;display:none;justify-content:flex-end;font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.shm-ov.on{display:flex}' +
    '.shm{background:#1b1712;color:#f3efe9;width:min(420px,100%);height:100%;overflow:auto;padding:calc(12px + env(safe-area-inset-top)) 12px calc(18px + env(safe-area-inset-bottom));box-shadow:-10px 0 40px rgba(0,0,0,.5);-webkit-overflow-scrolling:touch}' +
    '.shm-h{display:flex;align-items:center;gap:10px;margin:2px 2px 10px}.shm-h b{font-size:18px;flex:1}.shm-h small{display:block;font-weight:500;opacity:.65;font-size:12px}' +
    '.shm-x{appearance:none;border:0;background:#3a3229;color:#f3efe9;border-radius:10px;min-width:40px;height:40px;font:700 18px system-ui;cursor:pointer}' +
    '.shm details{background:#241f19;border-radius:12px;margin:8px 0;border:1px solid #3a3229}' +
    '.shm summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:12px 12px;font-weight:700;font-size:15px;min-height:48px}' +
    '.shm summary::-webkit-details-marker{display:none}.shm summary::after{content:"\\25BE";margin-left:auto;opacity:.6;transition:transform .15s}' +
    '.shm details[open] summary::after{transform:rotate(180deg)}.shm summary .ic{width:26px;text-align:center;font-size:17px}' +
    '.shm summary small{font-weight:500;opacity:.6;font-size:12px;margin-left:4px}' +
    '.shm-in{padding:0 8px 10px}' +
    '.shm-it{appearance:none;display:flex;width:100%;text-align:left;align-items:center;gap:10px;border:0;border-radius:10px;background:#2f2820;color:#f3efe9;padding:10px 12px;margin:5px 0;min-height:44px;font:600 14px system-ui,sans-serif;cursor:pointer}' +
    '.shm-it:hover{background:#3a3229}.shm-it.pri{background:#d65f00;color:#fff}.shm-it .ic{width:22px;text-align:center;flex:none}' +
    '.shm-it span{flex:1;min-width:0}.shm-it small{display:block;font-weight:500;opacity:.7;font-size:12px;margin-top:1px}' +
    '.shm-t{font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.6;margin:12px 2px 2px}.shm-in>.shm-t:first-child{margin-top:4px}' +
    '.shm-node{margin:6px 0}.shm .shc-row{margin:5px 0}.shm-foot{opacity:.55;font-size:12px;text-align:center;margin-top:14px}' +
    '.shm-badge{display:inline-block;min-width:18px;padding:0 5px;margin-left:5px;border-radius:999px;background:#d65f00;color:#fff;font:700 11px/18px system-ui;text-align:center;vertical-align:middle}' +
    '.shm-fab{position:fixed;z-index:9991;top:calc(10px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right));width:44px;height:44px;border-radius:12px;border:0;background:#d65f00;color:#fff;font:700 21px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer}' +
    '@media print{.shm-ov,.shm-fab{display:none!important}}';
  const MT = {
    es: { menu: 'Menú', proyecto: 'Proyecto', importar: 'Importar', exportar: 'Exportar', apps: 'Otras apps', datos: 'Copia de tus datos', ajustes: 'Ajustes', ayuda: 'Ayuda',
      proyectoS: 'nuevo, guardar, abrir', importarS: 'traer audio', exportarS: 'archivos y máquinas', appsS: 'enviar y recibir', datosS: 'pasar a otro dispositivo', ajustesS: 'preferencias', ayudaS: 'guía e informe',
      send: 'Enviar a otra app…', sendH: 'Lo que tienes ahora, a otra app de Sampled Head', recv: 'Recibido de otras apps', recvH: 'Lo que te han enviado', recv0: 'La bandeja está vacía',
      openApp: 'Abrir otra app', folder: 'Abrir la carpeta compartida', guide: 'Guía de uso', report: 'Descargar informe (.txt)', reportH: 'Para mandarlo si algo falla', close: 'Cerrar' },
    en: { menu: 'Menu', proyecto: 'Project', importar: 'Import', exportar: 'Export', apps: 'Other apps', datos: 'Backup of your data', ajustes: 'Settings', ayuda: 'Help',
      proyectoS: 'new, save, open', importarS: 'bring audio in', exportarS: 'files and devices', appsS: 'send and receive', datosS: 'move to another device', ajustesS: 'preferences', ayudaS: 'guide and report',
      send: 'Send to another app…', sendH: 'What you have now, to another Sampled Head app', recv: 'Received from other apps', recvH: 'What other apps sent you', recv0: 'The inbox is empty',
      openApp: 'Open another app', folder: 'Open the shared folder', guide: 'User guide', report: 'Download report (.txt)', reportH: 'To send it if something fails', close: 'Close' }
  };
  const SECS = [['proyecto', '📁'], ['importar', '📥'], ['exportar', '⬇'], ['apps', '⇄'], ['datos', '💾'], ['ajustes', '⚙'], ['ayuda', '?']];
  ui.menu = function (opts) {
    if (!document.getElementById('shm-css')) { const st = document.createElement('style'); st.id = 'shm-css'; st.textContent = MCSS; document.head.appendChild(st); }
    ensureCss();
    const me = opts.me, a = appById(me), L = () => MT[(opts.lang && opts.lang()) === 'en' ? 'en' : 'es'];
    const ov = el('div', 'shm-ov'), pn = el('div', 'shm'); pn.setAttribute('role', 'dialog'); pn.setAttribute('aria-modal', 'true');
    ov.appendChild(pn); document.body.appendChild(ov);
    const KEY = 'shc-menu-' + me; let inboxN = 0;
    let btn = typeof opts.button === 'string' && opts.button !== 'auto' ? document.querySelector(opts.button) : opts.button;
    if (opts.button === 'auto' || !btn) { btn = el('button', 'shm-fab'); btn.type = 'button'; document.body.appendChild(btn); }   // apps sin sitio en la cabecera
    function q(x) { return typeof x === 'string' ? document.querySelector(x) : x; }
    // los bloques que se mueven al menú se buscan ya, antes de que el menú los saque de su sitio
    for (const [id] of SECS) for (const it of (id === 'apps' ? (opts.apps && opts.apps.extra) || [] : Array.isArray(opts[id]) ? opts[id] : [])) if (it && typeof it.node === 'string') it.node = q(it.node);
    function itemEl(it) {
      if (it.title) return el('div', 'shm-t', typeof it.title === 'function' ? it.title() : it.title);
      if (it.node) { const n = q(it.node); if (!n) return null; const w = el('div', 'shm-node'); w.appendChild(n); if (n.hidden) n.hidden = false; return w; }
      const tg = it.click ? q(it.click) : null; if (it.click && !tg) return null;
      const b = el('button', 'shm-it' + (it.pri ? ' pri' : '')); b.type = 'button';
      const lab = () => it.label ? (typeof it.label === 'function' ? it.label() : it.label) : (tg ? (tg.getAttribute('aria-label') && !tg.textContent.trim() ? tg.getAttribute('aria-label') : tg.textContent.trim()) : '');
      b.innerHTML = ''; b.appendChild(el('span', 'ic', it.icon || '•')); const sp = el('span'); sp.textContent = lab(); if (it.hint) sp.appendChild(el('small', null, typeof it.hint === 'function' ? it.hint() : it.hint)); b.appendChild(sp);
      b.onclick = async () => {
        close();
        try {
          if (it.run) await it.run();
          else if (tg) { if (tg.tagName === 'LABEL') { const inp = tg.querySelector('input'); (inp || tg).click(); } else tg.click(); }
        } catch (e) { console.error('[sh-core] menú', e); alert(e.message || e); }
      };
      b._upd = () => { const t = lab(); sp.firstChild.nodeValue = t; b.hidden = (it.show && !it.show()) || (tg && tg.disabled && it.hideDisabled); if (tg) b.disabled = !!tg.disabled && !it.ignoreDisabled; };
      return b;
    }
    function build() {
      pn.innerHTML = ''; const t = L();
      const h = el('div', 'shm-h'), hb = el('b', null, (opts.name || (a ? a.name : me))); if (opts.version) hb.appendChild(el('small', null, 'v' + (typeof opts.version === 'function' ? opts.version() : opts.version)));
      const x = el('button', 'shm-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', t.close); x.onclick = close;
      h.appendChild(hb); h.appendChild(x); pn.appendChild(h);
      let saved = null; try { saved = localStorage.getItem(KEY); } catch (e) {}
      for (const [id, ic] of SECS) {
        let items = [];
        if (id === 'apps') {
          if (opts.apps === false) continue;
          const ap = opts.apps || {};
          if (ap.provide) items.push({ icon: '➜', label: t.send, hint: ap.sendHint || t.sendH, run: async () => { const its = await ap.provide(); if (!its || !its.length) { alert((opts.lang && opts.lang() === 'en') ? 'Nothing to send.' : 'No hay nada que enviar.'); return; } ui.sendSheet({ from: me, kinds: ap.kinds || its.map(i => i.kind || 'pad'), count: its.length, getItems: async () => its }); } });
          if (ap.accept) items.push({ icon: '⬅', label: () => t.recv + (inboxN ? ' (' + inboxN + ')' : ''), hint: () => inboxN ? t.recvH : t.recv0, run: async () => { if (!await ui.receiveSheet(me, async l => { const ok = await ap.accept(l); setTimeout(refresh, 300); return ok; })) alert(t.recv0); } });
          (ap.extra || []).forEach(i => items.push(i));
          items.push({ icon: '↗', label: t.openApp, run: () => openPicker() });
          if (D && D.openFolder) items.push({ icon: '📂', label: t.folder, run: () => D.openFolder() });
        } else if (id === 'datos') {
          if (!OWN[me]) continue;
        } else if (id === 'ayuda') {
          items = (opts.ayuda || []).slice();
          if (opts.guide) items.unshift({ icon: '📖', label: t.guide, run: opts.guide });
          if (opts.report) items.push({ icon: '⚠', label: t.report, hint: t.reportH, run: opts.report });
        } else items = (opts[id] || []).slice();
        const els = id === 'datos' ? [] : items.map(itemEl).filter(Boolean);
        if (id !== 'datos' && !els.length) continue;
        const d = el('details'); d.dataset.sec = id; if (saved === id) d.open = true;
        const sm = el('summary'); sm.appendChild(el('span', 'ic', ic)); const nm = el('span', null, t[id]); nm.appendChild(el('small', null, t[id + 'S'])); sm.appendChild(nm); d.appendChild(sm);
        const inn = el('div', 'shm-in'); d.appendChild(inn);
        if (id === 'datos') backup.rows(me, inn); else els.forEach(e => inn.appendChild(e));
        d.addEventListener('toggle', () => { if (!d.open) return; try { localStorage.setItem(KEY, id); } catch (e) {} pn.querySelectorAll('details').forEach(o => { if (o !== d) o.open = false; }); });
        pn.appendChild(d);
      }
      pn.appendChild(el('div', 'shm-foot', (a ? a.name : me) + (opts.version ? ' ' + (typeof opts.version === 'function' ? opts.version() : opts.version) : '') + ' · sh-core ' + VERSION + ' · By SampledHead'));
    }
    function refreshItems() { pn.querySelectorAll('.shm-it').forEach(b => b._upd && b._upd()); }
    function openPicker() {
      const { sh, close: c2 } = sheet(L().openApp);
      APPS.filter(x => x.id !== me && (!SUITE || SUITE.has(x.id)) && (!AND || AND.hasApp(x.id))).forEach(x => {
        const row = el('div', 'shc-row'), info = el('div'); info.appendChild(el('b', null, x.name)); info.appendChild(el('small', null, x.desc));
        const b = el('button', 'shc-b pri', '↗'); b.onclick = () => { c2(); open(x.id); }; row.appendChild(info); row.appendChild(b); sh.appendChild(row);
      });
      const foot = el('div', 'shc-foot'), c = el('button', 'shc-b', L().close); c.onclick = c2; foot.appendChild(c); sh.appendChild(foot);
    }
    function paintBtn() {
      if (!btn) return; let i = btn.querySelector('.shm-badge');
      if (inboxN) { if (!i) { i = el('i', 'shm-badge'); btn.appendChild(i); } i.textContent = inboxN; } else if (i) i.remove();
    }
    async function refresh() { if (opts.apps === false || !(opts.apps && opts.apps.accept)) return; try { inboxN = (await bridge.inbox(me)).length; } catch (e) { inboxN = 0; } paintBtn(); refreshItems(); }
    let built = false;
    function openM(sec) {
      build(); built = true;   // se rehace cada vez: textos ya traducidos por la app y estados al día
      refreshItems(); ov.classList.add('on'); try { opts.onOpen && opts.onOpen(); } catch (e) {}
      if (sec) pn.querySelectorAll('details').forEach(d => d.open = d.dataset.sec === sec);
      if (!pn.querySelector('details[open]')) { const f = pn.querySelector('details'); if (f) f.open = true; }
      document.addEventListener('keydown', escK);
      refresh();
    }
    function close() { ov.classList.remove('on'); document.removeEventListener('keydown', escK); }
    const escK = e => { if (e.key === 'Escape') close(); };
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    if (btn) {
      btn.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); openM(); }, true);   // sustituye a lo que hiciera antes ese botón
      if (!opts.keepLabel) { btn.textContent = '☰'; btn.setAttribute('aria-label', L().menu); btn.title = L().menu; }
    }
    function watch() { if (opts.apps && opts.apps.accept) bridge.watch(me, async items => { inboxN = items.length; paintBtn(); if (opts.apps.autoOpen !== false) await ui.receiveSheet(me, async l => { const ok = await opts.apps.accept(l); setTimeout(refresh, 300); return ok; }, items); }); }
    function adoptDock(d) {
      if (ui._dockBtn) { ui._dockBtn.remove(); ui._dockBtn = null; }
      if (opts.apps === false) return;
      opts.apps = Object.assign({}, opts.apps || {}, { kinds: d.kinds, sendHint: d.sendHint, provide: d.backupOnly ? null : d.provide, accept: d.backupOnly ? null : d.accept, autoOpen: d.autoOpen });
      watch(); refresh();
    }
    const M = { open: openM, close, refresh, el: ov, adoptDock };
    ui._menu = M;
    watch();
    if (ui._dockOpts) adoptDock(ui._dockOpts);
    refresh();
    return M;
  };

  G.SH = Object.assign(G.SH || {}, {
    core: VERSION, _pack: packItem, _unpack: unpackItem, APPS, app: appById, isDesktop: !!D, isAndroid: !!AND || !!SUITE, isSuite: !!SUITE, desktop: D, platform: D ? (D.platform || 'desktop') : (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'web'),
    bridge, open, models, engine, ui, backup, report, wav: { encode, decode },
    toFile: it => ui.toFile(it), feedInput: (i, f) => ui.feedInput(i, f)
  });
})(typeof window !== 'undefined' ? window : self);
