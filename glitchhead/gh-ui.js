/* GlitchHead — panel de mandos web (común a la app GlitchHead, la pestaña de CrazyHead y la de SampledHead App).
 * Necesita GlitchHeadDSP (dsp/glitchhead.js) cargado antes.
 *
 *   const ui = GlitchHeadUI.mount(contenedor, { onChange(params, id) {}, storageKey })
 *   ui.params            parámetros actuales (objeto plano con los ids de PARAMS)
 *   ui.set(obj)          aplica valores (sin llamar a onChange)
 *   ui.leds([sL,sR,xL,xR])   pilotos de actividad (0..1)
 *   ui.presetName        nombre del preset elegido
 *
 * Presets de usuario en localStorage «glitchhead.userPresets» (compartidos por las apps del mismo dominio).
 */
(function (G) {
'use strict';
const D = G.GlitchHeadDSP;
const DEF = {}; const BYID = {};
for (const p of D.PARAMS) { DEF[p[0]] = p[4]; BYID[p[0]] = { id: p[0], name: p[1], min: p[2], max: p[3], def: p[4], type: p[5], desc: p[6] }; }
const LOGP = { hSize: 1, xSmooth: 1 };
const ORDERS = D.ORDERS, MODS = ['SHRED', 'HAZE', 'SPLIT'];

const CSS = `
.ghui{--plate:#f3efe9;--plate2:#e8e2d9;--line:#d6cec2;--ink:#111;--ink2:#2b2622;--muted:#6f675e;--or:#d9600b;--orl:#ef7a22;--ord:#a94a07;
  --shred:#d9600b;--haze:#3f7f8c;--split:#8c3f6e;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--heavy:"Arial Black","Helvetica Neue",Impact,system-ui,sans-serif;
  color:var(--ink);font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ghui *{box-sizing:border-box}
.ghui .gh-top{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between;background:var(--plate);border-radius:8px;padding:12px;box-shadow:0 5px 0 rgba(0,0,0,.35);margin-bottom:10px}
.ghui .gh-pre{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1;min-width:250px}
.ghui select{background:var(--ink);color:var(--orl);border:0;border-radius:6px;padding:9px;font:inherit;font-family:var(--mono);font-weight:700;min-width:170px;flex:1}
.ghui .gh-b{background:var(--ink);color:var(--plate);border:0;border-radius:6px;padding:6px 10px;min-height:34px;font:inherit;font-size:13px;font-weight:800;cursor:pointer}
.ghui .gh-b.on{background:var(--or);color:var(--ink)}
.ghui .gh-b:disabled{opacity:.35;cursor:default}
.ghui .gh-flow{font-family:var(--mono);font-size:12px;opacity:.75;margin:4px 2px 8px;color:var(--gh-flow,#f3efe9)}
.ghui .gh-grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.ghui .gh-mod{background:var(--plate);border-radius:8px;padding:12px 10px 14px;position:relative;box-shadow:0 2px 0 var(--line) inset,0 5px 0 rgba(0,0,0,.35)}
.ghui .gh-mod::after{content:"";position:absolute;bottom:8px;left:8px;width:6px;height:6px;border-radius:50%;background:var(--ord);opacity:.7}
.ghui .gh-h{display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:3px solid var(--c);margin-bottom:8px}
.ghui .gh-nm{background:var(--ink);color:var(--plate);font-family:var(--heavy);font-size:14px;letter-spacing:.06em;padding:3px 9px 4px;border-radius:3px;transform:rotate(-1.5deg);box-shadow:inset 0 -4px 0 var(--c)}
.ghui .gh-sub{font-size:11px;font-style:italic;color:var(--muted);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ghui .gh-led{width:11px;height:11px;border-radius:50%;background:#ff4a2a;border:2px solid var(--ink);opacity:.2;flex:none}
.ghui .gh-mv{background:var(--plate2);border:2px solid var(--ink);border-radius:4px;width:24px;height:22px;font-weight:900;font-size:11px;cursor:pointer;padding:0}
.ghui .gh-mv:disabled{opacity:.3;cursor:default}
.ghui .gh-sw{width:44px;height:24px;border-radius:999px;background:var(--plate2);border:2px solid var(--ink);position:relative;cursor:pointer;flex:none;padding:0}
.ghui .gh-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--ink);transition:.12s}
.ghui .gh-sw.on{background:var(--c,var(--or))}
.ghui .gh-sw.on::after{left:22px}
.ghui .gh-mod.off .gh-body{opacity:.38}
.ghui .gh-sec{font-size:10px;font-weight:900;letter-spacing:.12em;color:var(--muted);display:flex;align-items:center;gap:8px;margin:6px 2px 2px}
.ghui .gh-sec::after{content:"";flex:1;height:1px;background:var(--line)}
.ghui .gh-row{display:flex;flex-wrap:wrap;justify-content:space-around;gap:2px}
.ghui .gh-pads{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin:2px 0 4px}
.ghui .gh-pad{background:var(--plate);border:2px solid var(--c);color:var(--ink);padding:5px 10px;border-radius:5px;font:inherit;font-size:12px;font-weight:900;cursor:pointer;min-width:52px}
.ghui .gh-pad.on{background:var(--c);color:var(--plate)}
.ghui .gh-k{display:flex;flex-direction:column;align-items:center;width:62px;user-select:none;-webkit-user-select:none}
.ghui .gh-k svg{width:50px;height:50px;touch-action:none;cursor:ns-resize}
.ghui .gh-k .l{font-size:9.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.ghui .gh-k .v{font-family:var(--mono);font-size:10.5px;color:var(--muted);white-space:nowrap}
.ghui .gh-t{display:flex;flex-direction:column;align-items:center;gap:3px;width:70px;font-size:9.5px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}
.ghui .gh-hint{font-size:12px;opacity:.7;margin:0 2px 6px;color:var(--gh-flow,#f3efe9)}
.ghui .gh-info{display:none;position:sticky;bottom:58px;background:var(--ink);color:var(--orl);border-radius:6px;padding:7px 10px;font-size:13px;margin-top:10px;min-height:34px;z-index:2;box-shadow:0 4px 14px rgba(0,0,0,.4)}
.ghui .gh-info.show{display:block}
.ghui .gh-glob{display:flex;gap:2px}
.ghui .gh-glob .gh-k .l{color:inherit}
@media (max-width:520px){.ghui .gh-k{width:58px}.ghui .gh-k svg{width:46px;height:46px}.ghui .gh-grid{grid-template-columns:1fr}}
`;

function fmt(id, v) {
  const d = BYID[id];
  if (d.type === 'i') return String(Math.round(v));
  if (d.type.startsWith('c:')) return d.type.slice(2).split('|')[Math.round(v)] || '';
  if (id === 'hSize' || id === 'xSmooth') return v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms';
  if (/Db$/.test(id) || id === 'hLo' || id === 'hHi' || id === 'xVerge' || id === 'xBoost') return (v > 0.04 ? '+' : '') + v.toFixed(1) + ' dB';
  if (id === 'sRate' || id === 'hRate') return (v > 0.04 ? '+' : '') + v.toFixed(1) + ' st';
  if (id === 'sAbsence' || id === 'sLean') return (v > 0.004 ? '+' : '') + Math.round(v * 100) + ' %';
  return Math.round(v * 100) + ' %';
}
function toN(id, v) { const d = BYID[id]; if (LOGP[id]) return Math.log(v / d.min) / Math.log(d.max / d.min); return (v - d.min) / (d.max - d.min); }
function fromN(id, t) {
  const d = BYID[id]; t = Math.min(1, Math.max(0, t));
  let v = LOGP[id] ? d.min * Math.pow(d.max / d.min, t) : d.min + t * (d.max - d.min);
  if (d.type === 'i') v = Math.round(v); else if (id === 'sRate' || id === 'hRate') v = Math.round(v * 10) / 10; else v = Math.round(v * 1000) / 1000;
  return v;
}
function arc(t0, t1) {
  const r = 24, cx = 32, cy = 32, A = t => (-135 + 270 * t) * Math.PI / 180;
  const a0 = A(Math.min(t0, t1)), a1 = A(Math.max(t0, t1));
  const x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0), x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${(a1 - a0) > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function mount(root, opts) {
  opts = opts || {};
  if (!document.getElementById('ghui-css')) { const st = document.createElement('style'); st.id = 'ghui-css'; st.textContent = CSS; document.head.appendChild(st); }
  const KEY = 'glitchhead.userPresets', LOCK = 'glitchhead.lock';
  const P = Object.assign({}, DEF);
  const ui = { params: P, presetName: 'Default' };
  const knobs = {}, sws = {}, pads = {};
  let lock = false; try { lock = localStorage.getItem(LOCK) === '1'; } catch (e) {}

  root.classList.add('ghui');
  root.innerHTML = `
  <div class="gh-top">
    <div class="gh-pre">
      <select class="gh-sel" aria-label="Preset"></select>
      <button class="gh-b" data-a="prev" title="Preset anterior">◀</button><button class="gh-b" data-a="next" title="Preset siguiente">▶</button>
      <button class="gh-b" data-a="save" title="Guardar como preset de usuario">💾</button><button class="gh-b" data-a="del" title="Borrar preset de usuario">🗑</button>
      <button class="gh-b" data-a="lock" title="Candado: al cambiar de preset se conservan Input, Mix y Output">🔒</button>
      <button class="gh-b" data-a="rand" title="Ajustes al azar (sin tocar Input, Mix ni Output)">🎲</button>
      <button class="gh-b" data-a="exp" title="Exportar presets de usuario (.json)">Exportar</button>
      <label class="gh-b" title="Importar presets (.json)">Importar<input type="file" accept=".json,application/json" hidden></label>
    </div>
    <div class="gh-glob"></div>
  </div>
  <div class="gh-flow"></div>
  <div class="gh-hint">Toca o pasa el ratón por un mando para ver qué hace · doble toque = valor por defecto · arrastra arriba/abajo para girar.</div>
  <div class="gh-grid"></div>
  <div class="gh-info" role="status"></div>`;
  const $ = s => root.querySelector(s);
  const sel = $('.gh-sel'), grid = $('.gh-grid'), info = $('.gh-info'), flow = $('.gh-flow');

  let infoT = 0;
  function say(t) { info.textContent = t; info.classList.add('show'); clearTimeout(infoT); infoT = setTimeout(() => info.classList.remove('show'), 6000); }
  function showInfo(id) {
    if (id === 'lock') { say('Candado: al cambiar de preset se conservan Input, Mix y Output.'); return; }
    const d = BYID[id]; if (d) say(d.name + ': ' + d.desc);
  }
  function emit(id) { if (opts.onChange) opts.onChange(Object.assign({}, P), id); }
  function setP(id, v, silent) {
    if (!(id in P)) return; P[id] = v;
    if (knobs[id]) knobs[id].upd(); if (sws[id]) sws[id].upd(); if (pads[id]) pads[id].upd();
    if (id === 'order' || /On$/.test(id)) layout();
    if (id === 'sFreeze' && knobs.sRepeat) knobs.sRepeat.el.style.opacity = v >= 0.5 ? .4 : 1;
    if (!silent) emit(id);
  }

  function knob(id, label, parent, light) {
    const d = BYID[id], bip = d.min < 0 && d.max > 0;
    const el = document.createElement('div'); el.className = 'gh-k';
    el.innerHTML = `<svg viewBox="0 0 64 64" role="slider" tabindex="0" aria-label="${d.name}">
      <path d="${arc(0, 1)}" stroke="${light ? '#3d3631' : '#d6cec2'}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path class="a" stroke="${light ? '#f3efe9' : '#111'}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <circle cx="32" cy="33.5" r="16" fill="#a94a07"/><circle cx="32" cy="32" r="16" fill="#d9600b"/>
      <circle cx="32" cy="32" r="10" fill="none" stroke="#ef7a22" stroke-width="1.4"/>
      <line class="p" x1="32" y1="31" x2="32" y2="19" stroke="#f3efe9" stroke-width="3.2" stroke-linecap="round"/></svg>
      <div class="l">${label}</div><div class="v"></div>`;
    parent.appendChild(el);
    const svg = el.querySelector('svg'), a = el.querySelector('.a'), p = el.querySelector('.p'), val = el.querySelector('.v');
    const k = { el, upd() { const t = Math.min(1, Math.max(0, toN(id, P[id]))), f = bip ? 0.5 : 0; a.setAttribute('d', Math.abs(t - f) > 0.004 ? arc(f, t) : ''); p.setAttribute('transform', `rotate(${-135 + 270 * t} 32 32)`); val.textContent = fmt(id, P[id]); svg.setAttribute('aria-valuetext', fmt(id, P[id])); } };
    let y0 = 0, t0 = 0, drag = false, lastTap = 0;
    svg.addEventListener('pointerdown', e => {
      showInfo(id);
      const now = Date.now(); if (now - lastTap < 320) { setP(id, d.def); lastTap = 0; return; } lastTap = now;
      drag = true; y0 = e.clientY; t0 = toN(id, P[id]); try { svg.setPointerCapture(e.pointerId); } catch (er) {} e.preventDefault();
    });
    svg.addEventListener('pointermove', e => { if (!drag) return; const s = e.shiftKey ? 0.0015 : 0.006; const v = fromN(id, t0 + (y0 - e.clientY) * s); if (v !== P[id]) setP(id, v); });
    svg.addEventListener('pointerup', () => { drag = false; }); svg.addEventListener('pointercancel', () => { drag = false; });
    svg.addEventListener('wheel', e => { e.preventDefault(); setP(id, fromN(id, toN(id, P[id]) - Math.sign(e.deltaY) * (d.type === 'i' ? 1 / (d.max - d.min) : 0.02))); }, { passive: false });
    svg.addEventListener('keydown', e => { const s = (e.key === 'ArrowUp' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowDown' || e.key === 'ArrowLeft') ? -1 : 0; if (s) { e.preventDefault(); setP(id, fromN(id, toN(id, P[id]) + s * (d.type === 'i' ? 1 / (d.max - d.min) : 0.02))); } });
    el.addEventListener('pointerenter', () => showInfo(id));
    knobs[id] = k; k.upd(); return k;
  }
  function toggle(id, label, parent, color) {
    const el = document.createElement('div'); el.className = 'gh-t';
    el.innerHTML = `<button class="gh-sw" style="--c:${color}" aria-label="${BYID[id].name}"></button><span>${label}</span>`;
    parent.appendChild(el);
    const b = el.querySelector('button');
    b.onclick = () => { showInfo(id); setP(id, P[id] >= 0.5 ? 0 : 1); };
    el.addEventListener('pointerenter', () => showInfo(id));
    const s = { el, upd() { b.classList.toggle('on', P[id] >= 0.5); b.setAttribute('aria-pressed', P[id] >= 0.5); } };
    sws[id] = s; s.upd(); return s;
  }
  function padRow(id, labels, parent) {
    const row = document.createElement('div'); row.className = 'gh-pads'; parent.appendChild(row);
    const bs = labels.map((t, i) => { const b = document.createElement('button'); b.className = 'gh-pad'; b.textContent = t; b.onclick = () => { showInfo(id); setP(id, i); }; b.addEventListener('pointerenter', () => showInfo(id)); row.appendChild(b); return b; });
    pads[id] = { upd() { bs.forEach((b, i) => b.classList.toggle('on', Math.round(P[id]) === i)); } }; pads[id].upd();
  }
  function sec(parent, t) { const s = document.createElement('div'); s.className = 'gh-sec'; s.textContent = t; parent.appendChild(s); }
  function row(parent) { const r = document.createElement('div'); r.className = 'gh-row'; parent.appendChild(r); return r; }

  // globales
  const gl = $('.gh-glob');
  knob('inputDb', 'Input', gl); knob('mix', 'Mix', gl); knob('outputDb', 'Output', gl);

  // módulos
  const color = ['var(--shred)', 'var(--haze)', 'var(--split)'];
  const onIds = ['sOn', 'hOn', 'xOn'], subs = ['trocea en wavesets', 'memoria y granos', 'puerta partida'];
  const mods = [0, 1, 2].map(m => {
    const el = document.createElement('div'); el.className = 'gh-mod'; el.style.setProperty('--c', color[m]);
    el.innerHTML = `<div class="gh-h"><span class="gh-nm">${MODS[m]}</span><span class="gh-sub">${subs[m]}</span>
      ${m !== 1 ? '<span class="gh-led"></span><span class="gh-led"></span>' : ''}
      <button class="gh-mv" data-d="-1" title="Mover a la izquierda">◀</button><button class="gh-mv" data-d="1" title="Mover a la derecha">▶</button>
      <button class="gh-sw" style="--c:${color[m]}" aria-label="${MODS[m]} on"></button></div><div class="gh-body"></div>`;
    const sw = el.querySelector('.gh-h .gh-sw');
    sw.onclick = () => { showInfo(onIds[m]); setP(onIds[m], P[onIds[m]] >= 0.5 ? 0 : 1); };
    sws[onIds[m]] = { upd() { sw.classList.toggle('on', P[onIds[m]] >= 0.5); el.classList.toggle('off', P[onIds[m]] < 0.5); } };
    el.querySelectorAll('.gh-mv').forEach(b => { b.onclick = () => { showInfo('order'); move(m, +b.dataset.d); }; });
    return { el, body: el.querySelector('.gh-body'), leds: el.querySelectorAll('.gh-led'), mv: el.querySelectorAll('.gh-mv') };
  });
  { // SHRED
    const b = mods[0].body;
    sec(b, 'FLOOR'); padRow('sFloor', ['0', '25', '50', '100 ms'], b);
    const r1 = row(b); ['sLength:Length', 'sStuck:Stuck', 'sDisorder:Disorder', 'sRepeat:Repeat', 'sRate:Rate'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r1); });
    const r2 = row(b); ['sAbsence:Absence', 'sDream:Dream', 'sLean:Lean', 'sSmoo:Smoo', 'sMonitor:Monitor'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r2); });
    sec(b, 'MODO'); const r3 = row(b); ['sEnv:Envelope', 'sFreeze:Freeze', 'sSync:Sync', 'sSustain:Sustain'].forEach(s => { const [i, l] = s.split(':'); toggle(i, l, r3, 'var(--shred)'); });
  }
  { // HAZE
    const b = mods[1].body;
    const r0 = row(b); toggle('hRaw', 'Raw', r0, 'var(--haze)'); toggle('hFreeze', 'Freeze', r0, 'var(--haze)');
    const r1 = row(b); ['hMemory:Memory', 'hSize:Size', 'hRate:Rate', 'hTemp:Temp', 'hWidth:Mid/Side'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r1); });
    sec(b, 'EQ Y MEZCLA'); const r2 = row(b); ['hLo:Lo', 'hHi:Hi', 'hWet:Wet', 'hDry:Dry'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r2); });
  }
  { // SPLIT
    const b = mods[2].body;
    sec(b, 'MODE'); padRow('xMode', ['Direct', 'Crossed', 'Summed'], b);
    const r1 = row(b); ['xVerge:Verge', 'xBoost:Boost', 'xSmooth:Smooth', 'xRetain:Retain', 'xSide:Sidechain'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r1); });
    sec(b, 'ARRIBA'); const r2 = row(b); ['xDriveA:Drive', 'xCutA:Cut', 'xVolA:Vol'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r2); });
    sec(b, 'ABAJO'); const r3 = row(b); ['xDrift:Drift', 'xMelt:Melt', 'xDriveB:Drive', 'xCutB:Cut', 'xVolB:Vol'].forEach(s => { const [i, l] = s.split(':'); knob(i, l, r3); });
  }
  Object.values(sws).forEach(s => s.upd());

  function layout() {
    const o = ORDERS[Math.max(0, Math.min(5, Math.round(P.order)))];
    o.forEach((m, slot) => { grid.appendChild(mods[m].el); mods[m].mv[0].disabled = slot === 0; mods[m].mv[1].disabled = slot === 2; });
    flow.textContent = 'Input › ' + o.map(m => MODS[m] + (P[onIds[m]] >= 0.5 ? '' : ' (off)')).join(' › ') + ' › Mix › Output';
    Object.values(sws).forEach(s => s.upd());
  }
  function move(m, dir) {
    const o = ORDERS[Math.round(P.order)].slice(), pos = o.indexOf(m), np = pos + dir;
    if (np < 0 || np > 2) return; [o[pos], o[np]] = [o[np], o[pos]];
    const idx = ORDERS.findIndex(x => x[0] === o[0] && x[1] === o[1] && x[2] === o[2]); setP('order', idx);
  }
  layout();

  // presets
  function userPresets() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function saveUser(obj) { try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch (e) {} }
  function fill(selVal) {
    sel.innerHTML = ''; let cat = '', og = null;
    D.PRESETS.forEach((p, i) => { if (p.cat !== cat) { cat = p.cat; og = document.createElement('optgroup'); og.label = 'Fábrica · ' + cat; sel.appendChild(og); } const o = document.createElement('option'); o.value = 'f:' + i; o.textContent = p.name; og.appendChild(o); });
    const u = userPresets(), names = Object.keys(u).sort();
    if (names.length) { og = document.createElement('optgroup'); og.label = 'Usuario'; sel.appendChild(og); names.forEach(n => { const o = document.createElement('option'); o.value = 'u:' + n; o.textContent = n; og.appendChild(o); }); }
    if (selVal) sel.value = selVal;
  }
  function apply(vals, name) {
    const keep = lock ? { inputDb: P.inputDb, mix: P.mix, outputDb: P.outputDb } : {};
    Object.assign(P, DEF, vals || {}, keep);
    Object.values(knobs).forEach(k => k.upd()); Object.values(pads).forEach(k => k.upd());
    if (knobs.sRepeat) knobs.sRepeat.el.style.opacity = P.sFreeze >= 0.5 ? .4 : 1;
    layout(); ui.presetName = name || 'Default'; emit('preset');
  }
  function choose(v) {
    if (v.startsWith('f:')) { const p = D.PRESETS[+v.slice(2)]; apply(p.v, p.name); }
    else { const n = v.slice(2), u = userPresets()[n]; if (u) apply(u, n); }
  }
  sel.onchange = () => choose(sel.value);
  fill('f:0');
  const btn = a => root.querySelector(`[data-a="${a}"]`);
  btn('prev').onclick = () => { sel.selectedIndex = (sel.selectedIndex - 1 + sel.options.length) % sel.options.length; choose(sel.value); };
  btn('next').onclick = () => { sel.selectedIndex = (sel.selectedIndex + 1) % sel.options.length; choose(sel.value); };
  btn('save').onclick = () => {
    let n = prompt('Nombre del preset:', ui.presetName === 'Default' ? '' : ui.presetName); if (!n) return; n = n.trim(); if (!n || n === 'Default') return;
    const u = userPresets(); if (u[n] && !confirm('Ya existe «' + n + '». ¿Sobrescribir?')) return;
    const vals = {}; for (const k in P) if (P[k] !== DEF[k]) vals[k] = P[k];
    u[n] = vals; saveUser(u); ui.presetName = n; fill('u:' + n);
  };
  btn('del').onclick = () => {
    if (!sel.value.startsWith('u:')) { say('Solo se pueden borrar los presets de usuario.'); return; }
    const n = sel.value.slice(2); if (!confirm('¿Borrar el preset «' + n + '»?')) return;
    const u = userPresets(); delete u[n]; saveUser(u); fill('f:0'); choose('f:0');
  };
  const lb = btn('lock'); lb.classList.toggle('on', lock);
  lb.onclick = () => { lock = !lock; lb.classList.toggle('on', lock); try { localStorage.setItem(LOCK, lock ? '1' : '0'); } catch (e) {} showInfo('lock'); };
  lb.addEventListener('pointerenter', () => showInfo('lock'));
  btn('rand').onclick = () => {
    const r = Math.random;
    for (const d of D.PARAMS) {
      const id = d[0]; if (/^(inputDb|mix|outputDb|order|sOn|hOn|xOn)$/.test(id)) continue;
      if (d[5] === 'b') P[id] = r() < 0.25 ? 1 : 0; else P[id] = fromN(id, r());
    }
    P.sFreeze = 0; P.hFreeze = r() < 0.15 ? 1 : 0; P.sMonitor = 0.4 + r() * 0.3; P.xVolA = 0.4 + r() * 0.5; P.xVolB = 0.2 + r() * 0.6; P.hWet = 0.3 + r() * 0.5;
    Object.values(knobs).forEach(k => k.upd()); Object.values(pads).forEach(k => k.upd()); layout(); ui.presetName = 'Azar'; emit('rand');
    say('Ajustes al azar en los motores encendidos. Guarda con 💾 si te gusta.');
  };
  btn('exp').onclick = () => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'GlitchHead', presets: userPresets() }, null, 1)], { type: 'application/json' }));
    a.download = 'glitchhead-presets.json'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  };
  root.querySelector('.gh-pre input[type=file]').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const j = JSON.parse(await f.text()); const u = userPresets(); Object.assign(u, j.presets || j); saveUser(u); fill(sel.value); say('Presets importados.'); }
    catch (er) { say('No se pudo leer el archivo de presets.'); }
  };

  ui.set = obj => { Object.assign(P, obj); Object.values(knobs).forEach(k => k.upd()); Object.values(pads).forEach(k => k.upd()); layout(); };
  ui.leds = v => {
    if (!v) return;
    mods[0].leds.forEach((l, i) => { l.style.opacity = (0.2 + 0.8 * Math.min(1, v[i] || 0)).toFixed(2); });
    mods[2].leds.forEach((l, i) => { l.style.opacity = (0.2 + 0.8 * Math.min(1, v[2 + i] || 0)).toFixed(2); });
  };
  ui.showInfo = say;
  return ui;
}

// Carga un módulo de AudioWorklet desde texto: blob: y, si falla (file:// en Chrome), data:
async function addModule(ctx, code) {
  try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))); }
  catch (e) {
    const b64 = btoa(unescape(encodeURIComponent(code)));
    await ctx.audioWorklet.addModule('data:application/javascript;base64,' + b64);
  }
}

// Conecta un nodo de tiempo real (AudioWorklet). Devuelve el nodo; los LED llegan por onLeds.
async function createNode(ctx, onLeds) {
  if (!ctx.audioWorklet) throw new Error('Este navegador no tiene AudioWorklet (hace falta para el efecto en tiempo real).');
  if (!ctx.__ghReady) ctx.__ghReady = addModule(ctx, D.workletSource());
  await ctx.__ghReady;
  const node = new AudioWorkletNode(ctx, 'glitchhead', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  node.port.onmessage = e => { if (e.data && e.data.leds && onLeds) onLeds(e.data.leds); };
  node.setParams = p => node.port.postMessage({ params: p });
  node.resetEngine = () => node.port.postMessage({ reset: true });
  node.setBypass = b => node.port.postMessage({ bypass: !!b });
  return node;
}

// Procesado offline en un Worker (no bloquea la interfaz). chans: [Float32Array L, R]
function renderOffline(chans, sr, params, tailSec, onProgress) {
  const L0 = new Float32Array(chans[0]), R0 = new Float32Array(chans[1] || chans[0]);
  const local = () => D.processBuffers([L0, R0], sr, params, { tail: tailSec || 0 });   // sin Worker: hilo principal
  return new Promise((resolve, reject) => {
    let w, done = false;
    const fallback = why => { if (done) return; done = true; try { if (w) w.terminate(); } catch (e) {} console.warn('GlitchHead: procesado sin Worker (' + why + ')'); try { resolve(local()); } catch (er) { reject(er); } };
    try { w = new Worker(URL.createObjectURL(new Blob([D.engineSource() + '(' + workerMain.toString() + ')(__GH);'], { type: 'application/javascript' }))); }
    catch (e) { fallback(e.message); return; }
    w.onmessage = e => {
      const d = e.data;
      if (d.progress != null) { if (onProgress) onProgress(d.progress); return; }
      done = true; w.terminate();
      if (d.error) { const er = new Error(d.error); er.stack = d.stack; reject(er); } else resolve([d.L, d.R]);
    };
    w.onerror = e => fallback('Worker: ' + (e.message || 'no se pudo crear'));
    const L = new Float32Array(L0), R = new Float32Array(R0);
    w.postMessage({ L, R, sr, params, tail: tailSec || 0 }, [L.buffer, R.buffer]);
  });
}
function workerMain(api) {
  self.onmessage = e => {
    const { L, R, sr, params, tail } = e.data;
    try {
      const n = L.length, T = Math.round(tail * sr), N = n + T;
      const oL = new Float32Array(N), oR = new Float32Array(N); oL.set(L); oR.set(R);
      const eng = new api.Engine(sr); eng.setParams(params);
      const B = 4096;
      for (let o = 0; o < N; o += B) {
        const m = Math.min(B, N - o); eng.process(oL.subarray(o, o + m), oR.subarray(o, o + m), m);
        if ((o / B) % 32 === 0) self.postMessage({ progress: o / N });
      }
      self.postMessage({ L: oL, R: oR }, [oL.buffer, oR.buffer]);
    } catch (er) { self.postMessage({ error: String(er && er.message || er), stack: er && er.stack }); }
  };
}

G.GlitchHeadUI = { mount, createNode, renderOffline, addModule, fmt, PARAM_INFO: BYID };
})(typeof globalThis !== 'undefined' ? globalThis : this);
