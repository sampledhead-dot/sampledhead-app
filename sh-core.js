/* sh-core.js — base común de las apps de Sampled Head (v1.0.0)
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
  const VERSION = '1.0.0';
  const BASE = 'https://sampledhead-dot.github.io/';
  const D = G.shDesktop || null;                 // API del envoltorio de escritorio (preload), si existe

  const APPS = [
    { id: 'sampler', name: 'SampledHead App', path: 'sampledhead-app/', takes: ['pad', 'loop', 'stem', 'phrase', 'kit', 'notes'], desc: 'Pads, bancos, Looper y Extractor' },
    { id: 'editor', name: 'SampledHead Editor', path: 'sampledhead-editor/', takes: ['pad', 'loop', 'stem', 'phrase'], desc: 'Editar, limpiar y masterizar' },
    { id: 'crazyhead', name: 'CrazyHead', path: 'CrazyHead/', takes: ['loop', 'stem', 'pad', 'phrase'], desc: 'Trocear loops y generar secuencias' },
    { id: 'fuzzhead', name: 'FuzzHead', path: 'FuzzHead/', takes: ['stem', 'loop', 'phrase', 'pad'], desc: 'Convertir bajo o guitarra en sinte' },
    { id: 'spb', name: 'Sample Pack Builder', path: 'spb-head/', takes: ['stem', 'loop'], desc: 'Hacer un pack de samples' },
    { id: 'tuner', name: 'SampledHead Tuner', path: 'Sampledhead-tuner/', takes: ['stem', 'loop', 'notes'], desc: 'Acordes y línea de bajo' },
    { id: 'tonopad', name: 'TonoPad', path: 'Tono-Pad/', takes: ['stem', 'loop', 'pad', 'notes'], desc: 'Tono, escala y pads afinados' },
    { id: 'poppads', name: 'Pop!Pads', path: 'poppads/', takes: ['pad', 'phrase', 'kit'], desc: 'Beat maker de pads' }
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

  const bridge = {
    /* items: [{name, kind, audio:AudioBuffer | wav:ArrayBuffer, bpm, key, notes, meta}] */
    async send(to, items, from) {
      const list = (Array.isArray(items) ? items : [items]).map(it => normItem(it, from || bridge.me));
      if (D && D.bridge) { await D.bridge.put(to, list); }
      else {
        const k = 'v2:in:' + to; let cur = []; try { cur = (await IDB.get(k)) || []; } catch (e) {}
        cur = cur.concat(list).slice(-64);
        await IDB.set(k, cur);
      }
      try { chan && chan.postMessage({ to, n: list.length, from: from || bridge.me }); } catch (e) {}
      return list.length;
    },
    async inbox(me) {
      me = me || bridge.me;
      if (D && D.bridge) return (await D.bridge.list(me)) || [];
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
      let busy = false, lastSig = '';
      const check = async () => {
        if (busy) return; busy = true;
        try {
          const items = await bridge.inbox(me);
          const sig = items.map(x => x.id).join(',');
          if (items.length && sig !== lastSig) { lastSig = sig; await cb(items); }
          if (!items.length) lastSig = '';
        } catch (e) { console.warn('[sh-core] bandeja:', e); }
        busy = false;
      };
      setTimeout(check, 1200);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
      G.addEventListener('focus', check);
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
        (D ? 'Se guarda en Documentos/SampledHead/Bandeja.' : 'Se guarda en este navegador para las demás apps de Sampled Head.'));
      const openChk = el('label', 'shc-chk'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = opts.openAfter !== false;
      openChk.appendChild(cb); openChk.appendChild(document.createTextNode('Abrir la app al enviar'));
      APPS.filter(a => a.id !== from).forEach(a => {
        const ok = kinds.some(k => a.takes.includes(k));
        const row = el('div', 'shc-row'), info = el('div');
        info.appendChild(el('b', null, a.name)); info.appendChild(el('small', null, a.desc));
        const b = el('button', 'shc-b pri', 'Enviar'); b.disabled = !ok; if (!ok) b.title = 'Esta app no recibe ' + kinds.map(k => KIND[k] || k).join(' ni ');
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
          } catch (e) { console.error(e); b.textContent = 'Error'; b.disabled = false; if (opts.onError) opts.onError(e); }
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
      const paint = n => { b.textContent = '⇄ Apps'; if (n) { const i = el('i', null, String(n)); b.appendChild(i); } };
      paint(0);
      const refresh = async () => { try { paint((await bridge.inbox(opts.me)).length); } catch (e) {} };
      b.onclick = async () => {
        const n = (await bridge.inbox(opts.me)).length;
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
        r2.appendChild(i2); r2.appendChild(b2); sh.appendChild(r2);
        if (D && D.openFolder) { const r3 = el('div', 'shc-foot'), b3 = el('button', 'shc-b', 'Abrir la carpeta compartida'); b3.onclick = () => D.openFolder(); r3.appendChild(b3); sh.appendChild(r3); }
      };
      document.body.appendChild(b);
      bridge.watch(opts.me, async items => { paint(items.length); if (opts.autoOpen !== false) await ui.receiveSheet(opts.me, async l => { const ok = await opts.accept(l); setTimeout(refresh, 300); return ok; }, items); });
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

  G.SH = Object.assign(G.SH || {}, {
    core: VERSION, APPS, app: appById, isDesktop: !!D, desktop: D, platform: D ? (D.platform || 'desktop') : (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? 'mobile' : 'web'),
    bridge, open, models, engine, ui, wav: { encode, decode },
    toFile: it => ui.toFile(it), feedInput: (i, f) => ui.feedInput(i, f)
  });
})(typeof window !== 'undefined' ? window : self);
