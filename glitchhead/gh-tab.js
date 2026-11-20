/* GlitchHead — pestaña de SampledHead App (1.74)
 * Tres efectos en cadena (SHRED · HAZE · SPLIT), el mismo motor que el plugin GlitchHead y su app web.
 *   - En vivo: se inserta en el máster (después de los FX del máster, antes del EQ) o en un canal del mixer.
 *   - Procesar pad: procesa la región del pad seleccionado (offline, en Worker) y la deja en el mismo pad
 *     (con Deshacer) o en el siguiente pad libre. También ⬇ WAV y «Enviar a…».
 * glitchhead.js y gh-ui.js son copias del repo GlitchHead (dsp/ y web/): no se editan aquí.
 * Usa del sampler (globales): ctx, pads, sel, select, labels, resetPad, stop, nextEmpty, status, save, chOut, chDry,
 * fxEnd, mixEq, MXN, showTab. De sh-core.js: SH.ui.sendSheet, SH.wav.
 */
(function () {
  'use strict';
  const GT_VERSION = '1.0.0';
  const $g = s => document.querySelector(s);
  const KEY = 'sampledhead.glitchhead';
  const X = { t: 'off', p: null, node: null, at: null, ui: null, bak: {}, busy: false, shown: false };
  try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j) { X.t = j.t == null ? 'off' : j.t; X.p = j.p || null; } } catch (e) {}
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ t: X.t, p: X.ui ? X.ui.params : X.p })); } catch (e) {} };
  const params = () => X.ui ? X.ui.params : Object.assign(GlitchHeadDSP.defaults(), X.p || {});
  const padLabel = i => (typeof pl === 'function' ? pl(i) : 'Pad ' + (i + 1));
  const msg = (t, warn) => { const m = $g('#ghxmsg'); if (m) { m.textContent = t; m.style.color = warn ? '#ff8a6a' : ''; } };
  const log = (...a) => console.info('[GlitchHead]', ...a);

  /* ---------------- En vivo ---------------- */
  function unroute() {
    if (!X.node || X.at == null) return;
    try { X.node.disconnect(); } catch (e) {}
    if (X.at === 'm') { try { fxEnd.disconnect(X.node); } catch (e) {} fxEnd.connect(mixEq[0]); }
    else { try { chOut[X.at].disconnect(X.node); } catch (e) {} chOut[X.at].connect(chDry[X.at]); }
    X.at = null;
  }
  async function route() {
    unroute();
    if (X.t !== 'off') {
      try {
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
        if (!X.node) { X.node = await GlitchHeadUI.createNode(ctx, l => { if (X.ui) X.ui.leds(l); }); X.node.setParams(params()); }
        if (X.t === 'm') { fxEnd.disconnect(mixEq[0]); fxEnd.connect(X.node); X.node.connect(mixEq[0]); }
        else { chOut[X.t].disconnect(chDry[X.t]); chOut[X.t].connect(X.node); X.node.connect(chDry[X.t]); }
        X.at = X.t; log('en vivo', X.t);
      } catch (e) { console.error('[GlitchHead] insertar', e); X.t = 'off'; msg('GlitchHead no puede sonar en vivo en este navegador: ' + (e.message || e), true); }
    }
    whereUI();
  }
  function whereUI() {
    document.querySelectorAll('#ghxwhere button').forEach(b => b.classList.toggle('on', String(X.t) === b.dataset.t));
    const st = $g('#ghxst'); if (!st) return;
    st.textContent = X.t === 'off' ? 'Apagado: no actúa en vivo. Puedes procesar un pad abajo.'
      : 'Suena en vivo en ' + (X.t === 'm' ? 'el máster (después de los FX del máster)' : 'el canal «' + MXN[X.t] + '» del mixer (los envíos de delay y reverb salen antes)') + '. Grabar y remuestrear lo incluyen.';
  }

  /* ---------------- Procesar pad ---------------- */
  function padRegion(i) {
    const p = pads[i]; if (!p || !p.buf) return null;
    const b = p.buf, n = b.length, a = Math.max(0, Math.floor((p.s || 0) * n)), z = Math.min(n, Math.max(a + 1, Math.ceil((p.e == null ? 1 : p.e) * n)));
    return { ch: [b.getChannelData(0).subarray(a, z), (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).subarray(a, z)], sr: b.sampleRate };
  }
  async function renderPad(i, tail) {
    const r = padRegion(i); if (!r) throw new Error('El pad está vacío');
    const out = await GlitchHeadUI.renderOffline(r.ch, r.sr, params(), tail || 0, f => msg('Procesando… ' + Math.round(f * 100) + ' %'));
    let pk = 0; for (const c of out) for (let k = 0; k < c.length; k++) { const a = Math.abs(c[k]); if (a > pk) pk = a; }
    if (pk > 0.98) { const g = 0.98 / pk; for (const c of out) for (let k = 0; k < c.length; k++) c[k] *= g; }
    const b = ctx.createBuffer(2, out[0].length, r.sr); b.copyToChannel(out[0], 0); b.copyToChannel(out[1], 1);
    return b;
  }
  async function processPad() {
    if (X.busy) return;
    const i = sel, p = pads[i];
    if (!p || !p.buf) return msg('Selecciona un pad con sonido.', true);
    const where = $g('#ghxdst').value, tail = $g('#ghxtail').checked ? 2 : 0;
    let t = i;
    if (where === 'free') { t = nextEmpty(i); if (t == null || t < 0) return msg('No quedan pads libres: vacía uno o elige «el mismo pad».', true); }
    X.busy = true;
    try {
      const b = await renderPad(i, tail), name = 'GlitchHead · ' + (p.name || padLabel(i)) + (X.ui ? ' · ' + X.ui.presetName : '');
      const q = pads[t];
      if (t === i) X.bak[t] = { buf: q.buf, s: q.s, e: q.e, name: q.name };
      const keepLoop = !!p.loop;
      stop(t); resetPad(q); Object.assign(q, { buf: b, name, loop: keepLoop }); labels(t);
      try { select(t); } catch (e) {}
      msg('Hecho: ' + padLabel(i) + ' → ' + padLabel(t) + (t === i ? ' (Deshacer lo recupera)' : '') + '.');
      log('procesado', i, '→', t);
    } catch (e) { console.error('[GlitchHead] procesar pad', e); msg('Error al procesar: ' + (e.message || e), true); }
    X.busy = false;
  }
  function undo() {
    const i = sel, b = X.bak[i];
    if (!b) return msg('Nada que deshacer en ' + padLabel(i) + '.', true);
    const q = pads[i]; stop(i); resetPad(q); Object.assign(q, { buf: b.buf, s: b.s, e: b.e, name: b.name }); labels(i); delete X.bak[i];
    try { select(i); } catch (e) {}
    msg('Recuperado ' + padLabel(i) + '.');
  }
  async function wav() {
    const i = sel; if (!pads[i] || !pads[i].buf) return msg('Selecciona un pad con sonido.', true);
    try { const b = await renderPad(i, $g('#ghxtail').checked ? 2 : 0); save(new Blob([SH && SH.wav ? SH.wav.encode(b, 24) : new ArrayBuffer(0)], { type: 'audio/wav' }), 'GlitchHead - ' + (pads[i].name || padLabel(i)).replace(/[\\/:*?"<>|]+/g, '') + '.wav'); msg('WAV descargado.'); }
    catch (e) { console.error('[GlitchHead] WAV', e); msg('Error: ' + (e.message || e), true); }
  }
  function send() {
    const i = sel; if (!pads[i] || !pads[i].buf) return msg('Selecciona un pad con sonido.', true);
    if (!window.SH || !SH.ui || !SH.ui.sendSheet) return msg('«Enviar a…» no está disponible.', true);
    SH.ui.sendSheet({ from: 'sampler', kinds: ['pad', 'loop'], count: 1, getItems: async () => { const b = await renderPad(i, $g('#ghxtail').checked ? 2 : 0); return [{ name: 'GlitchHead · ' + (pads[i].name || padLabel(i)), kind: b.duration > 4 ? 'loop' : 'pad', audio: b }]; } });
  }

  /* ---------------- Interfaz ---------------- */
  const CSS = `
#ghxpanel{display:none;padding:2px 2px 12px}
.unit.ghx #ghxpanel{display:block}
.unit.ghx>.padzone{display:none!important}
.unit.ghx>#ghxpanel{grid-column:1/-1}
.unit.ghx .padzone,.unit.ghx .lcd,.unit.ghx .ctl,.unit.ghx .chips,.unit.ghx .lpbar,.unit.ghx .lpexp,.unit.ghx .tuner,.unit.ghx #banks{display:none}
#ghxpanel .ghc{background:var(--panel);border-radius:12px;padding:10px 12px;margin:0 0 10px}
#ghxpanel h4{margin:0 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
#ghxpanel .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
#ghxpanel .ghc button,#ghxpanel .ghc select{background:var(--chip);color:var(--ink);border:0;border-radius:9px;padding:7px 11px;font:600 13px Barlow,system-ui,sans-serif;cursor:pointer}
#ghxpanel .ghc button.pri,#ghxpanel .ghc button.on{background:#d9600b;color:#111}
#ghxpanel .small{font-size:12px;color:var(--mute)}
`;
  function build() {
    if (X.ui || !window.GlitchHeadUI || !document.querySelector('.unit')) return;
    if (!document.getElementById('ghx-css')) { const st = document.createElement('style'); st.id = 'ghx-css'; st.textContent = CSS; document.head.appendChild(st); }
    let panel = $g('#ghxpanel'); if (!panel) { panel = document.createElement('div'); panel.id = 'ghxpanel'; $g('.unit').appendChild(panel); }
    const chs = MXN.map((n, k) => `<button data-t="${k}">${n}</button>`).join('');
    panel.innerHTML = `
    <div class="ghc"><h4>GlitchHead en vivo</h4>
      <div class="row" id="ghxwhere"><button data-t="off">Apagado</button><button data-t="m">Máster</button>${chs}</div>
      <div class="small" id="ghxst" style="margin-top:6px"></div></div>
    <div class="ghc"><h4>Procesar el pad seleccionado</h4>
      <div class="row"><span class="small" id="ghxpad"></span><span class="small">→</span>
        <select id="ghxdst"><option value="same">el mismo pad</option><option value="free">el siguiente pad libre</option></select>
        <label class="small"><input type="checkbox" id="ghxtail"> cola 2 s</label></div>
      <div class="row"><button class="pri" id="ghxgo">⚡ Procesar</button><button id="ghxundo">↶ Deshacer</button><button id="ghxwav">⬇ WAV</button><button id="ghxsend">Enviar a…</button></div>
      <div class="small" id="ghxmsg" style="margin-top:6px">Procesa la región del pad con los ajustes de abajo. Mismo resultado cada vez.</div></div>
    <div id="ghxui"></div>
    <div class="small" style="margin:6px 2px">GlitchHead ${GlitchHeadDSP.VERSION} · también como plugin VST3/AU y app web.</div>`;
    X.ui = GlitchHeadUI.mount($g('#ghxui'), { onChange(p) { if (X.node) X.node.setParams(p); persist(); } });
    if (X.p) X.ui.set(Object.assign(GlitchHeadDSP.defaults(), X.p));
    document.querySelectorAll('#ghxwhere button').forEach(b => b.onclick = () => { X.t = b.dataset.t === 'off' || b.dataset.t === 'm' ? b.dataset.t : +b.dataset.t; persist(); route(); });
    $g('#ghxgo').onclick = processPad; $g('#ghxundo').onclick = undo; $g('#ghxwav').onclick = wav; $g('#ghxsend').onclick = send;
    whereUI();
  }
  function padInfo() {
    const el = $g('#ghxpad'); if (!el) return;
    const p = pads[sel]; el.textContent = p && p.buf ? padLabel(sel) + ' · ' + (p.name || '') + ' · ' + ((((p.e == null ? 1 : p.e) - (p.s || 0)) * p.buf.duration)).toFixed(2) + ' s' : padLabel(sel) + ' (vacío: elige un pad con sonido en la pestaña Sampler)';
  }
  window.ghxShow = () => { build(); padInfo(); whereUI(); X.shown = true; };
  window.ghxHide = () => {};
  // si estaba insertado en vivo, se vuelve a insertar al abrir la app (tras el primer toque, cuando el audio arranca)
  if (X.t !== 'off') { const go = () => { document.removeEventListener('pointerdown', go, true); route(); }; document.addEventListener('pointerdown', go, true); }
  window.GLITCHTAB = { X, route, processPad, undo, renderPad, version: GT_VERSION };
})();
