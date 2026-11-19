/* Extractor — pestaña de SampledHead App (v1.0.0)
 * Cargas un audio, pides con texto lo que quieres sacar y lo devuelve separado, cortado en pads o transcrito en notas.
 *
 * Motores, según la plataforma:
 *   Windows y Mac con el motor local instalado:  BS-RoFormer + htdemucs (audio-separator), SAM Audio,
 *                                                Whisper large-v3 (faster-whisper) y MuScriptor, con la tarjeta gráfica.
 *   Navegador (y apps sin motor):                BS-RoFormer SW / Mel-RoFormer / htdemucs_6s (unblend, WebGPU o WASM),
 *                                                Whisper con tiempo por palabra (Transformers.js) y Basic Pitch.
 *   Móvil:                                       lo mismo que el navegador, con avisos y modelos ligeros.
 *
 * Usa del sampler: pads, sel, select, labels, resetPad, stop, nextEmpty, status, save, zip, wav, ctx, bank, BANKS,
 * audioOnsets, showTab. Usa de sh-core.js: SH.bridge, SH.ui, SH.models, SH.engine.
 */
(function () {
  'use strict';
  const EXT_VERSION = '1.0.1';
  const BASE = new URL('extractor/', document.baseURI).href;
  const $x = s => document.querySelector(s);
  const SH = window.SH;
  const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = p => NOTE[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  const STEM_ES = { vocals: 'voz', drums: 'bateria', bass: 'bajo', other: 'otros', guitar: 'guitarra', piano: 'piano' };
  const STEM_LABEL = { voz: 'Voz', bateria: 'Batería', bajo: 'Bajo', otros: 'Otros', guitarra: 'Guitarra', piano: 'Piano', instrumental: 'Instrumental', objetivo: 'Extraído', resto: 'Resto' };
  const MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && !(SH && SH.isDesktop);

  /* ---------------- Estado ---------------- */
  const X = {
    src: null, srcName: '', sel: null,            // sel = [inicio, fin] en segundos, o null = todo
    region: null, regionKey: '',                   // región procesada
    stems: {}, stemModel: '', words: [], wordsKey: '', notes: [], notesStem: '', notesKey: '',
    chops: [], chopBuf: null, chopName: '', chopSel: -1, riffs: [], riffSel: -1, tempo: 0,
    busy: false, cancel: false, steps: [], log: [], last: null, engine: null, webgpu: null, f16: false,
    view: 'stems', tabInst: 'bass4', speed: 1, playing: null
  };
  const LOG = (...a) => { const s = new Date().toISOString().slice(11, 23) + ' ' + a.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' '); X.log.push(s); if (X.log.length > 300) X.log.shift(); console.log('[Extractor]', ...a); };

  /* ---------------- Utilidades de audio ---------------- */
  function sliceBuf(b, a, z) {
    const sr = b.sampleRate, i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(b.length, Math.max(i0 + 1, Math.ceil(z * sr)));
    const o = ctx.createBuffer(b.numberOfChannels, i1 - i0, sr);
    for (let c = 0; c < b.numberOfChannels; c++) o.copyToChannel(b.getChannelData(c).subarray(i0, i1), c);
    return o;
  }
  function fadeEdges(b, ms) {
    const n = Math.min(Math.floor(b.sampleRate * (ms || 4) / 1000), b.length >> 1);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) { const g = i / n; d[i] *= g; d[d.length - 1 - i] *= g; } }
    return b;
  }
  async function resample(b, sr, mono) {
    const ch = mono ? 1 : Math.min(2, b.numberOfChannels);
    const oc = new OfflineAudioContext(ch, Math.max(1, Math.ceil(b.duration * sr)), sr);
    const s = oc.createBufferSource(); s.buffer = b;
    if (mono && b.numberOfChannels > 1) { const g = oc.createGain(); g.gain.value = 1 / b.numberOfChannels; s.connect(g); g.connect(oc.destination); g.channelCountMode = 'explicit'; g.channelCount = 1; }
    else s.connect(oc.destination);
    s.start(); return oc.startRendering();
  }
  function fromInterleaved(f, sr) { const n = f.length >> 1, b = ctx.createBuffer(2, n, sr), L = b.getChannelData(0), R = b.getChannelData(1); for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; } return b; }
  function peakOf(b) { let m = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 3) { const v = Math.abs(d[i]); if (v > m) m = v; } } return m; }
  function rmsAt(b, t0, t1) { const d = b.getChannelData(0), sr = b.sampleRate, a = Math.max(0, t0 * sr | 0), z = Math.min(d.length, t1 * sr | 0); let s = 0; for (let i = a; i < z; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, z - a)); }
  const decodeAB = ab => ctx.decodeAudioData(ab.slice(0));
  const fmt = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0'); };
  const cleanName = s => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'extracto';

  async function detectGpu() {
    if (X.webgpu !== null) return X.webgpu;
    X.webgpu = false;
    try {
      if (navigator.gpu) {
        const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (a) {
          let info = a.info || null; try { if (!info && a.requestAdapterInfo) info = await a.requestAdapterInfo(); } catch (e) {}
          const desc = info ? [info.vendor, info.architecture, info.device, info.description].join(' ') : '';
          X.gpuName = desc.trim();
          // WebGPU por software (SwiftShader, adaptador de reserva): más lento que WASM y poco fiable con modelos grandes
          if (a.isFallbackAdapter || (info && info.isFallbackAdapter) || /swiftshader|llvmpipe|software/i.test(desc)) { X.webgpu = false; LOG('WebGPU por software: se usa la CPU', desc); }
          else { X.webgpu = true; X.f16 = a.features.has('shader-f16'); }
        }
      }
    } catch (e) {}
    return X.webgpu;
  }
  async function engineState() {
    if (!SH || !SH.engine || !SH.engine.available) return (X.engine = { available: false, installed: false });
    try { X.engine = await SH.engine.status(); } catch (e) { X.engine = { available: true, installed: false, error: e.message }; }
    return X.engine;
  }
  const useMotor = () => !!(X.engine && X.engine.installed);
  const motorHas = p => useMotor() && (X.engine.parts || []).includes(p);

  /* ---------------- Interpretar la frase ---------------- */
  const INST = [
    ['voz', /\b(voz|voces|vocal(es)?|voice|vocals?|cantante|canto|singer|acapella|a capella)\b/],
    ['bateria', /\b(bater[ií]a|drums?|percusi[oó]n|bombo|caja|charles|hi-?hats?|platos?|kick|snare|golpes?)\b/],
    ['bajo', /\b(bajo|bass|bajista|bassline|l[ií]nea de bajo)\b/],
    ['guitarra', /\b(guitarras?|guitar)\b/],
    ['piano', /\b(piano|teclados?|keys|keyboard|rhodes)\b/],
    ['instrumental', /\b(instrumental|sin voz|karaoke|base)\b/],
    ['otros', /\b(otros|resto|other)\b/]
  ];
  const CUSTOM = { trompeta: 'trumpet', trompetas: 'trumpet', saxo: 'saxophone', 'saxofón': 'saxophone', saxofon: 'saxophone', trombón: 'trombone', trombon: 'trombone',
    violín: 'violin', violin: 'violin', violines: 'violins', chelo: 'cello', violonchelo: 'cello', flauta: 'flute', clarinete: 'clarinet', armónica: 'harmonica', armonica: 'harmonica',
    órgano: 'organ', organo: 'organ', sintetizador: 'synthesizer', sinte: 'synthesizer', synth: 'synthesizer', cuerdas: 'string section', vientos: 'brass section', metales: 'brass section',
    coros: 'backing vocals', aplausos: 'clapping', 'pandereta': 'tambourine', congas: 'congas', bongós: 'bongos', bongos: 'bongos', marimba: 'marimba', vibráfono: 'vibraphone',
    acordeón: 'accordion', acordeon: 'accordion', banjo: 'banjo', ukelele: 'ukulele', arpa: 'harp', 'scratch': 'turntable scratching', scratches: 'turntable scratching', sitar: 'sitar' };
  const FALLBACK = { synthesizer: 'otros', organ: 'piano', 'string section': 'otros', violin: 'otros', violins: 'otros', cello: 'otros', trumpet: 'otros', saxophone: 'otros', trombone: 'otros',
    flute: 'otros', clarinet: 'otros', harmonica: 'otros', 'brass section': 'otros', 'backing vocals': 'voz', clapping: 'bateria', tambourine: 'bateria', congas: 'bateria', bongos: 'bateria',
    marimba: 'otros', vibraphone: 'otros', accordion: 'otros', banjo: 'guitarra', ukulele: 'guitarra', harp: 'otros', 'turntable scratching': 'otros', sitar: 'guitarra' };
  function parseTime(s) { const m = String(s).match(/^(\d+):(\d+(?:[.,]\d+)?)$/); if (m) return +m[1] * 60 + parseFloat(m[2].replace(',', '.')); return parseFloat(String(s).replace(',', '.')); }
  function parse(text) {
    const raw = String(text || '').trim(), t = raw.toLowerCase();
    const cmd = { raw, stems: [], custom: null, customEs: '', part: 'all', range: null, phrase: null, chop: null, piece: null, transcribe: false, riff: false, solo: false, onlyNotes: false };
    // frase de la letra: entre comillas o tras «que dice / dice / says»
    let m = raw.match(/[«"“'‘]([^«»"“”'’]{1,200})[»"”'’]/) || raw.match(/\b(?:que dice|dice|diciendo|that says|says|la frase|la palabra|the phrase|the word)\s+(.+?)(?:\s+y\s+(?:pon|ponla|ponlas|corta|chopea|separa)\b|\s+and\s+(?:put|chop|cut)\b|[.,;]|$)/i);
    if (!m) m = raw.match(/^(?:extrae|saca|extract|get)\s+(.+?)\s+y\s+pon\s+cada\s+palabra/i);
    if (m) cmd.phrase = m[1].trim();
    for (const [k, re] of INST) if (re.test(t)) { if (k === 'bateria' && /\bcaja de ritmos\b/.test(t)) continue; cmd.stems.push(k); }
    if (/\b(bombo|kick)\b/.test(t)) cmd.piece = 'bombo'; else if (/\b(caja|snare)\b/.test(t) && !/caja de/.test(t)) cmd.piece = 'caja'; else if (/\b(charles|hi-?hats?)\b/.test(t)) cmd.piece = 'charles';
    for (const w of Object.keys(CUSTOM)) if (new RegExp('\\b' + w + '\\b', 'i').test(t)) { cmd.custom = CUSTOM[w]; cmd.customEs = w; break; }
    if (!cmd.custom) { const mm = t.match(/\b(?:extrae|saca|separa|a[ií]sla|isolate|extract)\s+(?:el|la|los|las|the)?\s*([a-záéíóúñ ]{3,30}?)(?:\s+(?:de|del|en|y|que|and|from)\b|$)/); if (mm && !cmd.stems.length && !cmd.phrase) { cmd.custom = mm[1].trim(); cmd.customEs = mm[1].trim(); } }
    if (cmd.phrase && !cmd.stems.includes('voz')) cmd.stems.unshift('voz');
    if (/\b(esta parte|este (?:trozo|fragmento|cacho)|la selecci[oó]n|lo marcado|this part|the selection|selected)\b/.test(t)) cmd.part = 'sel';
    m = t.match(/(?:del?|desde|from)\s+(?:el\s+)?(?:segundo\s+)?(\d+(?::\d+(?:[.,]\d+)?|[.,]\d+)?)\s*s?\s*(?:al?|hasta|to)\s+(?:el\s+)?(?:segundo\s+)?(\d+(?::\d+(?:[.,]\d+)?|[.,]\d+)?)/);
    if (m) { cmd.range = [parseTime(m[1]), parseTime(m[2])]; cmd.part = 'range'; }
    if (/\bcada\s+s[ií]laba\b|\beach syllable\b|\bpor s[ií]labas\b/.test(t)) cmd.chop = 'syllable';
    else if (/\bcada\s+palabra\b|\beach word\b|\bpor palabras\b|\bpalabra por palabra\b/.test(t)) cmd.chop = 'word';
    else if (/\bcada\s+nota\b|\beach note\b|\bpor notas\b|\bnota por nota\b/.test(t)) cmd.chop = 'note';
    else if (/\bcada\s+golpe\b|\beach (?:hit|drum)\b|\bpor golpes\b|\bgolpe a golpe\b|\bcada\s+(?:bombo|caja|charles)\b/.test(t)) cmd.chop = 'hit';
    else if (/\b(chop(?:ea|ear|éa|ealo|eala)?|trocea|corta en pads|en pads|en un pad|a pads)\b/.test(t)) cmd.chop = cmd.stems[0] === 'bateria' ? 'hit' : cmd.stems[0] === 'voz' ? 'word' : 'note';
    if (/\b(transcrib\w*|notas|tablatura|tab|piano ?roll|partitura|midi|qu[eé] notas|sheet|notes)\b/.test(t)) cmd.transcribe = true;
    if (/\briffs?\b|\bpatr[oó]n principal\b|\bmain riff\b/.test(t)) { cmd.riff = true; cmd.transcribe = true; }
    if (/\b(?:el|un|este|ese|the|a) solo\b/.test(t) || /\bsolo de (?:guitarra|trompeta|saxo\w*|piano|bajo|teclado|violin|violín|flauta|sinte\w*|bater\w*|trombon|trombón|armonica|armónica|[a-záéíóúñ]+ista)\b/.test(t)) { cmd.solo = true; cmd.transcribe = true; }
    if (cmd.chop === 'note' || cmd.transcribe) cmd.onlyNotes = !cmd.stems.length;
    if (!cmd.stems.length && !cmd.custom) cmd.stems = cmd.chop === 'hit' ? ['bateria'] : cmd.chop === 'word' || cmd.chop === 'syllable' ? ['voz'] : cmd.chop === 'note' || cmd.transcribe ? ['bajo'] : [];
    if (cmd.custom && !useMotor()) cmd.fallback = FALLBACK[cmd.custom] || 'otros';
    return cmd;
  }
  function describe(cmd) {
    const p = [];
    if (cmd.custom) p.push('separar «' + (cmd.customEs || cmd.custom) + '»' + (useMotor() && motorHas('sam') ? ' con SAM Audio' : ' (sin SAM Audio: pista «' + (STEM_LABEL[cmd.fallback] || cmd.fallback) + '»)'));
    else if (cmd.stems.length) p.push('separar ' + cmd.stems.map(s => STEM_LABEL[s] || s).join(', '));
    if (cmd.part === 'sel') p.push('solo en la parte marcada'); if (cmd.part === 'range') p.push('de ' + fmt(cmd.range[0]) + ' a ' + fmt(cmd.range[1]));
    if (cmd.phrase) p.push('buscar «' + cmd.phrase + '» en la letra');
    if (cmd.chop) p.push({ word: 'una palabra por pad', syllable: 'una sílaba por pad', note: 'una nota por pad', hit: 'un golpe por pad' }[cmd.chop] + (cmd.piece ? ' (' + cmd.piece + ')' : ''));
    if (cmd.riff) p.push('buscar el riff principal'); else if (cmd.solo) p.push('transcribir el solo entero'); else if (cmd.transcribe) p.push('transcribir las notas');
    return p.join(' · ') || 'separar todas las pistas';
  }

  /* ---------------- Progreso ---------------- */
  function steps(list) { X.steps = list.map(s => ({ t: s, st: 'wait', p: 0, info: '' })); drawSteps(); }
  function stepGo(i, info) { X.steps.forEach((s, k) => { if (k < i && s.st !== 'error') s.st = 'done'; }); if (X.steps[i]) { X.steps[i].st = 'run'; X.steps[i].info = info || ''; X.steps[i].p = 0; } drawSteps(); LOG('paso', X.steps[i] ? X.steps[i].t : i, info || ''); }
  function stepProg(i, p, info) { const s = X.steps[i]; if (!s) return; s.p = p; if (info != null) s.info = info; drawSteps(); crumb(); }
  function stepsDone() { X.steps.forEach(s => { if (s.st !== 'error') s.st = 'done'; }); drawSteps(); }
  function drawSteps() {
    const box = $x('#exSteps'); if (!box) return;
    box.innerHTML = '';
    X.steps.forEach(s => {
      const r = document.createElement('div'); r.className = 'exstep ' + s.st;
      r.innerHTML = '<span class="ic"></span><span class="tx"></span><span class="bar"><i></i></span>';
      r.querySelector('.tx').textContent = s.t + (s.info ? ' · ' + s.info : '');
      r.querySelector('i').style.width = (s.st === 'done' ? 100 : Math.round(s.p * 100)) + '%';
      box.appendChild(r);
    });
  }

  /* ---------------- Separación ---------------- */
  /* 1.67: en móviles y equipos con poca memoria el modelo de separación se descarga en cuanto termina (el cierre de la app al final del proceso era falta de memoria) */
  const LOWMEM = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
  /* registro de la sesión: si la app se cierra sola, al volver se sabe en qué paso fue */
  const CRUMB = 'sh_ex_crumb'; let crumbT = 0;
  function crumb(force) {
    const n = Date.now(); if (!force && n - crumbT < 1500) return; crumbT = n;
    try {
      const s = (X.steps || []).filter(x => x.st === 'run' || x.st === 'error').map(x => x.t + ' ' + Math.round(x.p * 100) + '% ' + (x.info || '')).join(' | ');
      localStorage.setItem(CRUMB, JSON.stringify({ ts: n, step: s, file: X.srcName || '', secs: X.src ? Math.round(X.src.duration) : 0, model: X.stemModel || '', q: X.quality,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, vis: document.visibilityState }));
    } catch (e) {}
  }
  const crumbClear = () => { try { localStorage.removeItem(CRUMB); } catch (e) {} };
  let unblendMod = null, sepInst = null, sepKey = '';
  async function unblend() { if (!unblendMod) unblendMod = await import(BASE + 'vendor/unblend.js'); return unblendMod; }
  function webModelFor(stems) {
    const need = new Set(stems), big = X.webgpu && !MOBILE && X.quality !== 'fast';
    if (big && [...need].every(s => s === 'voz' || s === 'instrumental')) return 'melband_roformer_kim';   // la mejor voz (MIT)
    if (big) return 'bs_roformer_sw';                                                                       // 6 pistas, la mejor calidad
    return need.has('guitarra') || need.has('piano') ? 'htdemucs_6s' : 'htdemucs';                          // CPU o móvil: lo ligero
  }
  async function separateWeb(buf, stems, si) {
    await detectGpu();
    const U = await unblend();
    let model = webModelFor(stems);
    const tryLoad = async (mdl, forceWasm) => {
      const prec = (mdl === 'bs_roformer_sw' || mdl === 'melband_roformer_kim') ? (X.f16 ? 'fp16' : 'fp32') : 'fp16';
      const be = (X.webgpu && !forceWasm) ? 'webgpu' : 'wasm', key = mdl + '|' + prec + '|' + be;
      if (sepInst && sepKey === key) return sepInst;
      if (sepInst) { try { await sepInst.unload(); } catch (e) {} sepInst = null; }
      const art = U.MODEL_ARTIFACTS[mdl][prec];
      stepProg(si, 0, 'descargando ' + mdl + ' (' + Math.round(art.sizeBytes / 1048576) + ' MB, una sola vez)');
      const ab = await SH.models.get(art.url, { name: mdl + '_' + prec + '.onnx', size: art.sizeBytes, onProgress: f => stepProg(si, f * 0.4, 'descargando ' + mdl + ' · ' + Math.round(f * 100) + '%') });
      const url = URL.createObjectURL(new Blob([ab]));
      try {
        sepInst = await U.Separator.load(mdl, { backend: be, precision: prec, modelUrl: url, cache: false,
          wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/', numThreads: Math.min(4, navigator.hardwareConcurrency || 2) });
      } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
      sepKey = key; X.stemModel = mdl + (prec === 'fp16' ? ' (fp16)' : '') + ' · ' + sepInst.backend;
      return sepInst;
    };
    let sep;
    try { sep = await tryLoad(model); }
    catch (e) {
      LOG('no se pudo cargar', model, e.message);
      if (model === 'htdemucs_6s') throw e;
      model = 'htdemucs_6s'; stepProg(si, 0, 'tu equipo no puede con el modelo grande; uso htdemucs_6s');
      sep = await tryLoad(model);
    }
    const b44 = buf.sampleRate === 44100 ? buf : await resample(buf, 44100, false);
    stepProg(si, 0.42, 'separando con ' + X.stemModel);
    /* Se vigila la separación: si la tarjeta gráfica da error o no avanza en 120 s, se repite por CPU (WASM) */
    const attempt = (inst) => new Promise((ok, ko) => {
      let last = Date.now(), done = false;
      const fin = (f, v) => { if (done) return; done = true; clearInterval(wd); window.removeEventListener('error', onErr); f(v); };
      const onErr = ev => { const m = String(ev.message || (ev.error && ev.error.message) || ''); if (/GPU|WebGPU|mapAsync|device lost/i.test(m)) fin(ko, new Error('Error de la tarjeta gráfica: ' + m)); };
      window.addEventListener('error', onErr);
      const wd = setInterval(() => { if (X.cancel) fin(ko, new Error('Cancelado')); else if (Date.now() - last > 120000) fin(ko, new Error('La separación no avanza')); }, 2000);
      inst.separate(b44, { shifts: X.quality === 'fast' ? 0 : 1, onProgress: p => { last = Date.now(); stepProg(si, 0.42 + 0.58 * (p.fraction || 0), 'separando con ' + X.stemModel + ' · ' + Math.round((p.fraction || 0) * 100) + '%'); } })
        .then(v => fin(ok, v), e => fin(ko, e));
    });
    let res;
    try { res = await attempt(sep); }
    catch (e) {
      LOG('separación fallida', X.stemModel, e.message);
      try { await sep.unload(); } catch (x) {} sepInst = null; sepKey = '';
      if (e.message === 'Cancelado' || sep.backend === 'wasm') throw e;
      stepProg(si, 0.42, 'la tarjeta gráfica ha fallado; repito por CPU (más lento)');
      const mdl2 = model === 'bs_roformer_sw' ? 'htdemucs_6s' : model;     // BS-RoFormer SW solo funciona con WebGPU
      sep = await tryLoad(mdl2, true);
      res = await attempt(sep);
    }
    if (LOWMEM) { try { await sep.unload(); } catch (x) {} sepInst = null; sepKey = ''; LOG('modelo de separación descargado (poca memoria)'); }
    const out = {};
    for (const [k, v] of Object.entries(res.stems)) { const es = STEM_ES[k] || k; out[es] = fromInterleaved(v, 44100); }
    if (out.voz && (stems.includes('instrumental'))) {
      const ins = ctx.createBuffer(2, b44.length, 44100);
      for (let c = 0; c < 2; c++) { const m = b44.getChannelData(Math.min(c, b44.numberOfChannels - 1)), v = out.voz.getChannelData(c), o = ins.getChannelData(c); for (let i = 0; i < o.length; i++) o[i] = m[i] - v[i]; }
      out.instrumental = ins;
    }
    return out;
  }
  async function separateMotor(buf, stems, si) {
    const want = stems.map(s => s === 'instrumental' ? 'instrumental' : s);
    const r = await SH.engine.run('separate', { wav: SH.wav.encode(buf, 24) }, { stems: want }, p => stepProg(si, p.frac || 0, p.stage || ''));
    const out = {};
    for (const f of r.files) if (f.wav) out[f.stem] = await decodeAB(f.wav);
    X.stemModel = (r.data.models || []).join(' + ') + ' · motor local (' + (r.device || '') + ')';
    return out;
  }
  async function separateSam(buf, desc, si) {
    const r = await SH.engine.run('sam', { wav: SH.wav.encode(buf, 24) }, { description: desc }, p => stepProg(si, p.frac || 0, p.stage || ''));
    const out = {};
    for (const f of r.files) if (f.wav) out[f.stem] = await decodeAB(f.wav);
    X.stemModel = 'SAM Audio ' + (r.data.size || '') + ' · motor local';
    return out;
  }

  /* ---------------- Letra (Whisper) ---------------- */
  let asrW = null;
  function asrWorker() { if (!asrW) asrW = new Worker(BASE + 'vendor/asr-worker.js', { type: 'module' }); return asrW; }
  async function lyricsWeb(voice, si, lang) {
    await detectGpu();
    const big = X.webgpu && !MOBILE && X.quality !== 'fast';
    const model = big ? 'onnx-community/whisper-large-v3-turbo_timestamped' : 'onnx-community/whisper-base_timestamped';
    const a16 = (await resample(voice, 16000, true)).getChannelData(0);
    const w = asrWorker();
    return new Promise((ok, ko) => {
      w.onmessage = e => {
        const m = e.data;
        if (m.type === 'load') stepProg(si, (m.p || 0) * 0.5, 'descargando Whisper ' + (big ? 'large-v3 turbo' : 'base') + ' (una sola vez)');
        else if (m.type === 'stage') stepProg(si, 0.55, m.stage + ' con Whisper ' + (big ? 'large-v3 turbo' : 'base'));
        else if (m.type === 'done') ok({ words: (m.chunks || []).map(c => ({ w: String(c.text || '').trim(), s: c.timestamp[0], e: c.timestamp[1] == null ? c.timestamp[0] + 0.3 : c.timestamp[1] })).filter(x => x.w), model: 'Whisper ' + (big ? 'large-v3 turbo' : 'base') + ' · navegador' });
        else if (m.type === 'error') { const er = new Error(m.message); er.stack = m.stack; asrW && asrW.terminate(); asrW = null; ko(er); }
      };
      w.onerror = e => { asrW = null; ko(new Error('Worker de Whisper: ' + (e.message || 'error'))); };
      w.postMessage({ type: 'run', audio: a16, model, device: X.webgpu ? 'webgpu' : 'wasm', language: lang || null }, [a16.buffer]);
    });
  }
  async function lyricsMotor(voice, si, lang, hint) {
    const r = await SH.engine.run('lyrics', { wav: SH.wav.encode(voice, 16) }, { language: lang || null, lyrics: hint || null }, p => stepProg(si, p.frac || 0, p.stage || ''));
    return { words: r.data.words || [], model: 'Whisper ' + (r.data.model || '') + ' · motor local' };
  }

  /* ---------------- Notas ---------------- */
  let notesW = null;
  async function notesWeb(buf, si, stem, backend) {
    const a = (await resample(buf, 22050, true)).getChannelData(0);
    if (!notesW) notesW = new Worker(BASE + 'vendor/notes-worker.js', { type: 'module' });
    const range = stem === 'bajo' ? { maxFreq: 500, minFreq: 28 } : {};
    try {
      return await new Promise((ok, ko) => {
        let last = Date.now(), moved = false;
        const wd = setInterval(() => { if (Date.now() - last > (moved ? 120000 : 45000)) { clearInterval(wd); ko(new Error('atascado')); } }, 2000);
        notesW.onmessage = e => {
          const m = e.data; last = Date.now();
          if (m.type === 'progress') { if (m.p > 0) moved = true; stepProg(si, m.p, 'Basic Pitch · ' + Math.round(m.p * 100) + '%'); }
          else if (m.type === 'done') { clearInterval(wd); ok({ notes: m.notes.sort((x, y) => x.t - y.t), model: 'Basic Pitch · navegador (' + m.backend + ')' }); }
          else if (m.type === 'error') { clearInterval(wd); ko(new Error(m.message)); }
        };
        notesW.onerror = e => { clearInterval(wd); ko(new Error('Worker de notas: ' + (e.message || 'error'))); };
        notesW.postMessage(Object.assign({ type: 'run', audio: a, backend: backend || null }, range), [a.buffer]);
      });
    } catch (e) {
      notesW.terminate(); notesW = null;
      if (backend === 'cpu') throw e;
      LOG('Basic Pitch con GPU falló (' + e.message + '); repito por CPU');
      stepProg(si, 0, 'Basic Pitch por CPU');
      return notesWeb(buf, si, stem, 'cpu');
    }
  }
  const MUS_INST = { bajo: ['bass'], guitarra: ['guitar'], piano: ['piano'], voz: ['vocals'], bateria: ['drums'] };
  async function notesMotor(buf, si, stem) {
    const r = await SH.engine.run('notes', { wav: SH.wav.encode(buf, 16) }, { instruments: null }, p => stepProg(si, p.frac || 0, p.stage || ''));
    let notes = r.data.notes || [];
    if (stem && stem !== 'otros' && notes.some(n => !n.drum)) notes = notes.filter(n => stem === 'bateria' ? n.drum : !n.drum);
    return { notes, midi: r.data.midi_b64 ? Uint8Array.from(atob(r.data.midi_b64), c => c.charCodeAt(0)) : null, model: 'MuScriptor ' + (r.data.model || '') + ' · motor local' };
  }
  /* Respaldo sin modelos: YIN monofónico (bajo y melodías de una nota) */
  function notesYin(buf, stem) {
    const sr = buf.sampleRate, d = buf.getChannelData(0), W = Math.round(sr * (stem === 'bajo' ? 0.08 : 0.04)), H = Math.round(sr * 0.01);
    const fmin = stem === 'bajo' ? 30 : 70, fmax = stem === 'bajo' ? 450 : 1400, tmin = Math.floor(sr / fmax), tmax = Math.min(W - 1, Math.ceil(sr / fmin));
    const frames = [], dif = new Float32Array(tmax + 1);
    let gmax = 1e-6; for (let i = 0; i < d.length; i += 64) gmax = Math.max(gmax, Math.abs(d[i]));
    for (let i = 0; i + W + tmax < d.length; i += H) {
      let e = 0; for (let k = 0; k < W; k += 2) e += d[i + k] * d[i + k]; e = Math.sqrt(2 * e / W);
      if (e < gmax * 0.04) { frames.push(0); continue; }
      for (let t = tmin; t <= tmax; t++) { let s = 0; for (let k = 0; k < W; k += 2) { const v = d[i + k] - d[i + k + t]; s += v * v; } dif[t] = s; }
      let run = 0, best = -1; for (let t = tmin; t <= tmax; t++) { run += dif[t]; const n = dif[t] * (t - tmin + 1) / (run || 1); if (n < 0.15) { while (t + 1 <= tmax && dif[t + 1] < dif[t]) t++; best = t; break; } }
      frames.push(best > 0 ? Math.round(69 + 12 * Math.log2(sr / best / 440)) : 0);
    }
    const notes = []; let cur = 0, st = 0;
    const flush = (i) => { if (cur && (i - st) * H / sr >= 0.06) notes.push({ t: st * H / sr, d: (i - st) * H / sr, p: cur, v: 100 }); };
    for (let i = 0; i <= frames.length; i++) { const p = frames[i] || 0; if (p !== cur) { flush(i); cur = p; st = i; } }
    return { notes, model: 'YIN (sin modelo)' };
  }
  function monophonic(notes) {   // para tablatura y riff: una nota cada vez (la más fuerte; si empatan, la más grave)
    const s = notes.slice().sort((a, b) => a.t - b.t || (b.v || 0) - (a.v || 0) || a.p - b.p), out = [];
    for (const n of s) { const l = out[out.length - 1]; if (l && n.t < l.t + l.d - 0.03) { if (n.t - l.t < 0.04) continue; l.d = Math.max(0.03, n.t - l.t); } out.push(Object.assign({}, n)); }
    return out;
  }

  /* ---------------- Golpes, palabras y sílabas ---------------- */
  function hitsOf(buf) {
    let on = [];
    try { on = typeof audioOnsets === 'function' ? audioOnsets(buf) : []; } catch (e) { on = []; }
    if (!on.length) {   // respaldo: subidas de energía
      const d = buf.getChannelData(0), sr = buf.sampleRate, h = Math.round(sr * 0.005); let prev = 0, last = -1;
      for (let i = 0; i + h < d.length; i += h) { let s = 0; for (let k = 0; k < h; k++) s += d[i + k] * d[i + k]; s = Math.sqrt(s / h); if (s > prev * 2.2 && s > 0.02 && i / sr - last > 0.07) { on.push(i / sr); last = i / sr; } prev = prev * 0.7 + s * 0.3; }
    }
    return on;
  }
  function classifyHit(buf, t) {   // bombo / caja / charles por reparto de energía en bandas
    const sr = buf.sampleRate, d = buf.getChannelData(0), N = 2048, i0 = Math.max(0, Math.round(t * sr)), re = new Float32Array(N), im = new Float32Array(N);
    for (let i = 0; i < N; i++) re[i] = (d[i0 + i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    fftInPlace(re, im);
    let lo = 0, mid = 0, hi = 0; const bin = sr / N;
    for (let k = 1; k < N / 2; k++) { const f = k * bin, m = re[k] * re[k] + im[k] * im[k]; if (f < 150) lo += m; else if (f < 4000) mid += m; else hi += m; }
    const tot = lo + mid + hi + 1e-12;
    if (lo / tot > 0.45) return 'bombo';
    if (hi / tot > 0.55) return 'charles';
    return 'caja';
  }
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr; re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
    }
  }
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  /* Busca la frase en la lista de palabras (tolera errores de reconocimiento). Devuelve [i0, i1] */
  function findPhrase(words, phrase) {
    const P = norm(phrase).split(' ').filter(Boolean); if (!P.length || !words.length) return null;
    const W = words.map(w => norm(w.w));
    let best = null, bestScore = -1;
    for (let i = 0; i < W.length; i++) {
      for (let len = Math.max(1, P.length - 2); len <= P.length + 2 && i + len <= W.length; len++) {
        const seg = W.slice(i, i + len).join(' '), sc = similarity(seg, P.join(' '));
        if (sc > bestScore) { bestScore = sc; best = [i, i + len - 1]; }
      }
    }
    return bestScore >= 0.55 ? { range: best, score: bestScore } : null;
  }
  function similarity(a, b) {
    if (a === b) return 1; const m = a.length, n = b.length; if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return 1 - prev[n] / Math.max(m, n);
  }
  /* Ajusta un corte a donde de verdad suena: quita silencio al principio y al final (Whisper da tiempos holgados) */
  function tighten(buf, a, b) {
    const sr = buf.sampleRate, d = buf.getChannelData(0), h = Math.max(1, Math.round(sr * 0.005)), i0 = Math.max(0, Math.floor(a * sr)), i1 = Math.min(d.length, Math.ceil(b * sr));
    if (i1 - i0 < h * 6) return [a, b];
    const env = []; let mx = 0;
    for (let i = i0; i + h <= i1; i += h) { let s = 0; for (let k = 0; k < h; k++) s += d[i + k] * d[i + k]; const v = Math.sqrt(s / h); env.push(v); if (v > mx) mx = v; }
    // tramos con sonido (huecos de menos de 120 ms no cortan); se queda el de más energía y lo que esté pegado a él
    const th = Math.max(mx * 0.2, 0.004), gap = Math.round(0.15 * sr / h), runs = [];
    let cur = null;
    env.forEach((v, k) => { if (v > th) { if (cur && k - cur.z <= gap) { cur.z = k; cur.e += v; } else { cur = { a: k, z: k, e: v }; runs.push(cur); } } });
    if (!runs.length) return [a, b];
    const best = runs.reduce((p, q) => q.e > p.e ? q : p);
    // umbral bajo para no comerse el ataque ni la cola de ese tramo
    let f = best.a, l = best.z; const lo = Math.max(mx * 0.05, 0.003);
    while (f > 0 && env[f - 1] > lo) f--; while (l < env.length - 1 && env[l + 1] > lo) l++;
    return [Math.max(a, i0 / sr + f * h / sr - 0.012), Math.min(b, i0 / sr + (l + 1) * h / sr + 0.045)];
  }
  /* Cortes por palabra (o sílaba): cada palabra empieza después de la anterior para no repetir el mismo sonido */
  function wordChops(ws, vb, syl) {
    const out = []; let prev = 0;
    ws.forEach(w => {
      const s0 = Math.max(prev, w.s - 0.05), e0 = Math.max(s0 + 0.05, Math.min(vb.duration, w.e + 0.15)), tt = tighten(vb, s0, e0);
      if (syl) { const sy = syllables(w.w); splitBySyllables(vb, tt[0], tt[1], sy.length).forEach((q, j) => out.push({ a: q[0], b: q[1], label: sy[j] || w.w })); }
      else out.push({ a: tt[0], b: tt[1], label: w.w });
      prev = tt[1] - 0.03;
    });
    return out;
  }
  function syllables(word) {   // sílabas aproximadas (castellano e inglés): grupos de vocales
    const w = norm(word).replace(/[^a-zñ]/g, ''); if (!w) return [word];
    let parts = w.match(/[^aeiouáéíóúüy]*[aeiouáéíóúüy]+(?:[^aeiouáéíóúüy]*$|[^aeiouáéíóúüy](?=[^aeiouáéíóúüy]))?/g) || [w];
    if (parts.length > 1 && /^[^aeiouáéíóúüy]*e$/.test(parts[parts.length - 1]) && /[^aeiou]e$/.test(w)) { const l = parts.pop(); parts[parts.length - 1] += l; }   // «love», «make»: la e final no suena
    return parts.length ? parts : [w];
  }
  function splitBySyllables(buf, s, e, n) {   // corta en los valles de energía más cercanos a un reparto igual
    if (n <= 1) return [[s, e]];
    const out = [], step = (e - s) / n; let a = s;
    for (let k = 1; k < n; k++) {
      const guess = s + step * k; let bt = guess, bv = Infinity;
      for (let t = guess - step * 0.35; t <= guess + step * 0.35; t += 0.005) { const v = rmsAt(buf, t, t + 0.01); if (v < bv) { bv = v; bt = t; } }
      out.push([a, bt]); a = bt;
    }
    out.push([a, e]); return out;
  }

  /* ---------------- Riff principal ---------------- */
  function estimateTempo(notes, dur) {
    const on = notes.map(n => n.t); if (on.length < 4) return 0;
    let best = 0, bs = -1;
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const p = 60 / bpm, t0 = on[0]; let s = 0;
      for (const t of on) { const x = (t - t0) / p; s += Math.cos(2 * Math.PI * x) + 0.5 * Math.cos(4 * Math.PI * x) + 0.25 * Math.cos(8 * Math.PI * x); }
      const sc = s / on.length / 1.75 + (bpm >= 80 && bpm <= 140 ? 0.06 : 0) - Math.abs(bpm - 105) / 3000;
      if (sc > bs) { bs = sc; best = bpm; }
    }
    return best;
  }
  function findRiffs(notes, bpm) {
    if (!bpm || notes.length < 6) return [];
    const bar = 240 / bpm, q = bar / 16, t0 = notes[0].t - ((notes[0].t / q) % 1) * q * 0;   // compases desde el primer golpe
    const first = notes[0].t, nb = Math.ceil((notes[notes.length - 1].t - first + 0.01) / bar);
    const sig = len => {
      const map = new Map();
      for (let b = 0; b + len <= nb; b++) {
        const a = first + b * bar, z = a + len * bar;
        const ns = notes.filter(n => n.t >= a - q / 2 && n.t < z - q / 2);
        if (ns.length < 2) continue;
        const key = ns.map(n => Math.round((n.t - a) / q) + ':' + n.p).join(',');
        if (!map.has(key)) map.set(key, { key, len, bars: [], notes: ns.map(n => Object.assign({}, n, { t: n.t - a })) });
        map.get(key).bars.push(b);
      }
      return [...map.values()];
    };
    // patrones de 1, 2 y 4 compases; se cuentan solo apariciones que no se pisan
    let all = [];
    for (const len of [4, 2, 1]) for (const r of sig(len)) {
      const bars = []; r.bars.forEach(b => { if (!bars.length || b >= bars[bars.length - 1] + len) bars.push(b); });
      if (bars.length >= 2) all.push(Object.assign(r, { bars, count: bars.length, score: bars.length * len * 100 - len }));   // más compases cubiertos; a igualdad, el patrón más corto
    }
    // un patrón largo que contiene a otro corto y aparece casi tanto, gana
    all.sort((a, b) => b.score - a.score);
    const out = [];
    for (const r of all) {
      if (out.some(o => r.bars.every(b => o.bars.some(ob => b < ob + o.len && b + r.len > ob)))) continue;   // ya cubierto por un riff mejor
      out.push(r); if (out.length >= 3) break;
    }
    return out.map((r, i) => Object.assign(r, { name: 'Riff ' + (i + 1), start: first + r.bars[0] * bar, barDur: bar }));
  }

  /* ---------------- Tablatura ---------------- */
  const TUNINGS = { bass4: { name: 'Bajo 4 cuerdas', s: [28, 33, 38, 43], l: ['E', 'A', 'D', 'G'] }, bass5: { name: 'Bajo 5 cuerdas', s: [23, 28, 33, 38, 43], l: ['B', 'E', 'A', 'D', 'G'] },
    guitar: { name: 'Guitarra', s: [40, 45, 50, 55, 59, 64], l: ['E', 'A', 'D', 'G', 'B', 'e'] } };
  function tabOf(notes, inst, bpm) {
    const T = TUNINGS[inst] || TUNINGS.bass4, S = T.s, ns = monophonic(notes);
    if (!ns.length) return '(sin notas)';
    let pos = 3; const placed = [];
    for (const n of ns) {
      let best = null, bc = 1e9;
      S.forEach((o, si) => { const f = n.p - o; if (f < 0 || f > 22) return; const c = Math.abs(f - pos) + (f > 12 ? 3 : 0) + si * 0.1; if (c < bc) { bc = c; best = { si, f }; } });
      if (!best) { const o = n.p < S[0] ? 0 : S.length - 1; best = { si: o, f: Math.max(0, n.p - S[o]) }; }
      pos = best.f || pos; placed.push(Object.assign({ t: n.t }, best));
    }
    const beat = bpm ? 60 / bpm : 0.5, slot = beat / 4, barSlots = 16, first = ns[0].t, lines = [];
    const nbars = Math.max(1, Math.ceil((ns[ns.length - 1].t - first + 0.001) / (slot * barSlots)));
    for (let b0 = 0; b0 < nbars; b0 += 4) {
      const rows = S.map(() => []);
      for (let b = b0; b < Math.min(nbars, b0 + 4); b++) {
        const cells = S.map(() => Array(barSlots).fill('--'));
        placed.forEach(p => { const k = Math.round((p.t - first) / slot) - b * barSlots; if (k >= 0 && k < barSlots) cells[p.si][k] = String(p.f).padEnd(2, '-'); });
        cells.forEach((c, si) => rows[si].push(c.join('')));
      }
      lines.push('Compás ' + (b0 + 1));
      for (let si = S.length - 1; si >= 0; si--) lines.push(T.l[si].padEnd(2) + '|' + rows[si].join('|') + '|');
      lines.push('');
    }
    return T.name + (bpm ? ' · ' + Math.round(bpm) + ' BPM (aprox.)' : '') + '\n\n' + lines.join('\n');
  }

  /* ---------------- MIDI ---------------- */
  function midiFile(notes, bpm) {
    bpm = bpm || 120; const tpq = 480, us = Math.round(60e6 / bpm), sec2t = s => Math.round(s * tpq * bpm / 60);
    const vlq = n => { const b = [n & 127]; while ((n >>= 7) > 0) b.unshift((n & 127) | 128); return b; };
    const ev = [];
    notes.forEach(n => { const ch = n.drum ? 9 : 0; ev.push([sec2t(n.t), 0x90 | ch, n.p & 127, Math.max(1, Math.min(127, n.v || 100))]); ev.push([sec2t(n.t + n.d), 0x80 | ch, n.p & 127, 0]); });
    ev.sort((a, b) => a[0] - b[0] || (a[1] & 0xf0) - (b[1] & 0xf0));
    const trk = [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255]; let last = 0;
    ev.forEach(e => { trk.push(...vlq(e[0] - last), e[1], e[2], e[3]); last = e[0]; });
    trk.push(0, 0xff, 0x2f, 0);
    const hd = [77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, tpq >> 8, tpq & 255], tl = trk.length;
    return new Uint8Array([...hd, 77, 84, 114, 107, (tl >> 24) & 255, (tl >> 16) & 255, (tl >> 8) & 255, tl & 255, ...trk]);
  }

  /* ---------------- Reproducción ---------------- */
  function stopPlay() { const p = X.playing; X.playing = null; if (!p) return; try { if (p.src) p.src.stop(); } catch (e) {} if (p.el) { p.el.pause(); URL.revokeObjectURL(p.el.src); } if (p.oscs) p.oscs.forEach(o => { try { o.stop(); } catch (e) {} }); }
  function play(buf, a, z, rate) {
    stopPlay(); if (!buf) return;
    try { ctx.resume(); } catch (e) {}
    rate = rate || 1;
    if (rate !== 1) {   // más lento sin cambiar el tono: <audio> con preservesPitch
      const b = a != null ? sliceBuf(buf, a, z) : buf, el = new Audio(URL.createObjectURL(new Blob([SH.wav.encode(b, 16)], { type: 'audio/wav' })));
      el.preservesPitch = true; el.mozPreservesPitch = true; el.webkitPreservesPitch = true; el.playbackRate = rate; el.play().catch(() => {});
      X.playing = { el, t0: performance.now(), a: a || 0, rate }; return;
    }
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination);
    s.start(0, a || 0, z != null ? Math.max(0.01, z - (a || 0)) : undefined);
    X.playing = { src: s, t0: performance.now(), a: a || 0, rate: 1 };
  }
  function playNotes(notes, rate) {
    stopPlay(); try { ctx.resume(); } catch (e) {}
    rate = rate || 1; const t0 = ctx.currentTime + 0.05, first = notes.length ? notes[0].t : 0, oscs = [];
    notes.slice(0, 2000).forEach(n => {
      const o = ctx.createOscillator(), g = ctx.createGain(), st = t0 + (n.t - first) / rate, du = Math.max(0.05, n.d / rate);
      o.type = n.p < 48 ? 'triangle' : 'sawtooth'; o.frequency.value = 440 * Math.pow(2, (n.p - 69) / 12);
      g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(0.18, st + 0.01); g.gain.setTargetAtTime(0, st + du * 0.8, 0.04);
      o.connect(g); g.connect(ctx.destination); o.start(st); o.stop(st + du + 0.3); oscs.push(o);
    });
    X.playing = { oscs, t0: performance.now(), a: first, rate };
  }

  /* ---------------- Proceso completo ---------------- */
  async function run(text) {
    if (X.busy) return;
    if (!X.src) { status('Extractor: primero carga un audio'); flash('Carga un audio o usa el pad seleccionado.'); return; }
    const cmd = parse(text); X.last = cmd; LOG('orden', cmd);
    if (cmd.part === 'sel' && !X.sel) { flash('Has pedido «esta parte» pero no hay nada marcado: arrastra sobre la onda para marcarla.'); return; }
    if (!cmd.stems.length && !cmd.custom) cmd.stems = ['voz', 'bateria', 'bajo', 'otros'];
    $x('#exPlan').textContent = 'Entendido: ' + describe(cmd) + '.';
    X.busy = true; X.cancel = false; setBusy(true); crumb(true);
    await engineState(); await detectGpu();
    const plan = [];
    plan.push('Preparar el audio');
    plan.push(cmd.custom && motorHas('sam') ? 'Separar «' + (cmd.customEs || cmd.custom) + '» (SAM Audio)' : 'Separar pistas');
    if (cmd.phrase || cmd.chop === 'word' || cmd.chop === 'syllable') plan.push('Transcribir la letra');
    if (cmd.transcribe || cmd.chop === 'note') plan.push('Transcribir las notas');
    if (cmd.chop) plan.push('Cortar en pads');
    if (cmd.riff) plan.push('Buscar el riff principal');
    steps(plan);
    let si = 0;
    try {
      /* 1. región */
      stepGo(si);
      let a = 0, z = X.src.duration;
      if (cmd.part === 'sel' && X.sel) [a, z] = X.sel;
      else if (cmd.part === 'range') [a, z] = [Math.max(0, cmd.range[0]), Math.min(X.src.duration, cmd.range[1])];
      else if (X.sel && cmd.part === 'all' && X.selAuto) [a, z] = X.sel;
      if (!(z > a + 0.05)) throw new Error('El fragmento está vacío');
      const region = (a === 0 && z === X.src.duration) ? X.src : sliceBuf(X.src, a, z);
      const rkey = X.srcName + '|' + a.toFixed(3) + '|' + z.toFixed(3);
      if (rkey !== X.regionKey) { X.stems = {}; X.words = []; X.wordsKey = ''; X.notes = []; X.notesKey = ''; X.riffs = []; }
      X.region = region; X.regionKey = rkey; X.regionStart = a;
      stepProg(si, 1, fmt(a) + ' – ' + fmt(z) + ' (' + (z - a).toFixed(1) + ' s)'); si++;
      if (MOBILE && region.duration > 90) flash('En móvil la separación de más de 90 s puede cerrar la página por falta de memoria. Si falla, marca un trozo más corto.');

      /* 2. separación */
      stepGo(si);
      let target = null;
      if (cmd.custom && motorHas('sam')) {
        const key = 'sam:' + cmd.custom;
        if (!X.stems[key]) { const r = await separateSam(region, cmd.custom, si); X.stems[key] = r.objetivo; X.stems['resto (' + (cmd.customEs || cmd.custom) + ')'] = r.resto; }
        target = key; X.stemLabels = Object.assign(X.stemLabels || {}, { [key]: cap(cmd.customEs || cmd.custom) });
      } else {
        const want = cmd.custom ? [cmd.fallback] : cmd.stems.slice();
        const missing = want.filter(s => !X.stems[s]);
        if (missing.length) {
          const all = useMotor() && motorHas('separar') ? await separateMotor(region, missing.includes('guitarra') || missing.includes('piano') ? Array.from(new Set(missing.concat(['voz', 'bateria', 'bajo', 'otros']))) : Array.from(new Set(missing.concat(['bateria', 'bajo', 'otros', 'voz']))), si)
            : await separateWeb(region, missing, si);
          Object.assign(X.stems, all);
        }
        target = want[0];
        if (cmd.custom) flash('«' + (cmd.customEs || cmd.custom) + '» necesita SAM Audio, que solo funciona con el motor local de Windows o Mac. Te dejo la pista «' + (STEM_LABEL[cmd.fallback] || cmd.fallback) + '», donde suele estar.');
      }
      stepProg(si, 1, X.stemModel); si++;
      let tbuf = X.stems[target];
      if (!tbuf) throw new Error('El modelo no ha devuelto la pista «' + target + '»');

      /* 3. letra */
      let phraseRange = null;
      if (cmd.phrase || cmd.chop === 'word' || cmd.chop === 'syllable') {
        stepGo(si);
        const voice = X.stems.voz || tbuf;
        if (X.wordsKey !== rkey) {
          const lang = $x('#exLang').value || null;
          const r = useMotor() && motorHas('letra') ? await lyricsMotor(voice, si, lang, cmd.phrase) : await lyricsWeb(voice, si, lang);
          X.words = r.words; X.wordsKey = rkey; X.wordsModel = r.model;
        }
        stepProg(si, 1, X.words.length + ' palabras · ' + (X.wordsModel || ''));
        if (cmd.phrase) {
          const f = findPhrase(X.words, cmd.phrase);
          if (!f) throw new Error('No encuentro «' + cmd.phrase + '» en la letra. Mira la pestaña Letra: puedes elegir las palabras a mano.');
          phraseRange = f.range;
          X.phraseRange = f.range;
        }
        si++;
      }

      /* 4. notas */
      if (cmd.transcribe || cmd.chop === 'note') {
        stepGo(si);
        const nkey = rkey + '|' + target;
        if (X.notesKey !== nkey) {
          let r;
          try { r = useMotor() && motorHas('notas') ? await notesMotor(tbuf, si, target) : await notesWeb(tbuf, si, target); }
          catch (e) { LOG('notas con modelo fallaron', e.message); flash('No se pudo usar el modelo de notas (' + e.message + '). Uso el detector sencillo, válido para una nota cada vez.'); r = notesYin(tbuf, target); }
          X.notes = r.notes; X.notesMidi = r.midi || null; X.notesModel = r.model; X.notesKey = nkey; X.notesStem = target;
        }
        X.tempo = estimateTempo(monophonic(X.notes), tbuf.duration);
        stepProg(si, 1, X.notes.length + ' notas · ' + X.notesModel); si++;
      }

      /* 5. chopeo */
      if (cmd.chop) {
        stepGo(si);
        X.chops = []; X.chopSel = -1;
        if (cmd.chop === 'word' || cmd.chop === 'syllable') {
          let ws = X.words; if (phraseRange) ws = ws.slice(phraseRange[0], phraseRange[1] + 1);
          const vb = X.stems.voz || tbuf; X.chopBuf = vb; X.chopName = 'Voz';
          X.chops = wordChops(ws, vb, cmd.chop === 'syllable');
        } else if (cmd.chop === 'note') {
          X.chopBuf = tbuf; X.chopName = stemLabel(target);
          const ns = monophonic(X.notes);
          ns.forEach((n, k) => { const nx = ns[k + 1]; X.chops.push({ a: Math.max(0, n.t - 0.01), b: Math.min(tbuf.duration, nx ? Math.max(n.t + n.d, Math.min(nx.t - 0.003, n.t + n.d + 0.25)) : n.t + n.d + 0.15), label: noteName(n.p), p: n.p }); });
          // una nota por pad: si se repite la misma nota, se queda la más larga
          if ($x('#exUniq').checked) { const m = new Map(); X.chops.forEach(c => { const o = m.get(c.label); if (!o || c.b - c.a > o.b - o.a) m.set(c.label, c); }); X.chops = [...m.values()].sort((a, b) => a.p - b.p); }
        } else if (cmd.chop === 'hit') {
          X.chopBuf = tbuf; X.chopName = stemLabel(target);
          const on = hitsOf(tbuf);
          on.forEach((t, k) => { const nx = on[k + 1]; X.chops.push({ a: Math.max(0, t - 0.004), b: Math.min(tbuf.duration, nx ? Math.min(nx - 0.002, t + 1.2) : t + 0.6), label: classifyHit(tbuf, t) }); });
          if (cmd.piece) X.chops = X.chops.filter(c => c.label === cmd.piece);
          if ($x('#exUniq').checked) { const best = {}; X.chops.forEach(c => { const e = rmsAt(tbuf, c.a, c.a + 0.05); if (!best[c.label] || e > best[c.label].e) best[c.label] = Object.assign({ e }, c); }); X.chops = Object.values(best).concat(X.chops.filter(c => !best[c.label] || best[c.label].a !== c.a)).slice(0, 64); }
        }
        if (X.chops.length > 64) { flash('Hay ' + X.chops.length + ' trozos; se quedan los 64 primeros (lo que cabe en los cuatro bancos).'); X.chops = X.chops.slice(0, 64); }
        stepProg(si, 1, X.chops.length + ' pads'); si++;
      } else if (phraseRange) {    // frase sin chopeo: un solo trozo con la frase
        const vb = X.stems.voz || tbuf, ws = X.words;
        X.chopBuf = vb; X.chopName = 'Voz';
        const tt = tighten(vb, Math.max(0, ws[phraseRange[0]].s - 0.05), Math.min(vb.duration, ws[phraseRange[1]].e + 0.12));
        X.chops = [{ a: tt[0], b: tt[1], label: cmd.phrase }];
      }

      /* 6. riff */
      if (cmd.riff) { stepGo(si); X.riffs = findRiffs(monophonic(X.notes), X.tempo); X.riffSel = X.riffs.length ? 0 : -1; stepProg(si, 1, X.riffs.length ? X.riffs.map(r => r.name + ' ×' + r.count).join(', ') : 'no hay un patrón que se repita'); si++; }
      if (cmd.solo) X.riffs = [];

      stepsDone();
      X.view = cmd.chop || phraseRange ? 'chops' : (cmd.transcribe ? 'notes' : 'stems');
      X.selStem = target;
      render();
      crumbClear();
      status('Extractor: ' + describe(cmd));
    } catch (e) {
      crumbClear();
      const s = X.steps.find(x => x.st === 'run'); if (s) { s.st = 'error'; s.info = e.message; } drawSteps();
      LOG('error', e.message, e.stack || '');
      reportError('proceso del Extractor', e, cmd);
      flash('No se pudo completar: ' + e.message, true);
    }
    X.busy = false; setBusy(false);
  }
  const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
  const stemLabel = k => (X.stemLabels && X.stemLabels[k]) || STEM_LABEL[k] || cap(k);

  /* ---------------- Retoques por texto ---------------- */
  function refine(text) {
    const t = norm(text); if (!X.chops.length) { flash('Primero crea pads (por ejemplo «pon cada palabra en un pad»).'); return; }
    const amt = /\bmucho\b/.test(t) ? 0.12 : /\bun poco\b|\bpoco\b|\bligeramente\b/.test(t) ? 0.03 : 0.06;
    const find = () => { const m = t.match(/\bde\s+(?:la |el )?(.+)$/) || t.match(/\b(?:pad|trozo)\s+(\d+)\b/); if (!m) return X.chopSel >= 0 ? X.chopSel : -1; if (/^\d+$/.test(m[1])) return +m[1] - 1; const w = norm(m[1]).replace(/^(nota|palabra|silaba|golpe)\s+/, ''); return X.chops.findIndex(c => norm(c.label) === w || norm(c.label).startsWith(w)); };
    let i = find();
    const say = s => { flash(s); drawChops(); };
    if (/\b(alarga|extiende|amplia)\b/.test(t) && /\bfinal\b/.test(t)) { if (i < 0) return say('¿De qué pad? Ejemplo: «alarga un poco el final de Love».'); X.chops[i].b = Math.min(X.chopBuf.duration, X.chops[i].b + amt); return say('Final de «' + X.chops[i].label + '» alargado ' + Math.round(amt * 1000) + ' ms.'); }
    if (/\b(acorta|recorta)\b/.test(t) && /\bfinal\b/.test(t)) { if (i < 0) return say('¿De qué pad?'); X.chops[i].b = Math.max(X.chops[i].a + 0.02, X.chops[i].b - amt); return say('Final de «' + X.chops[i].label + '» acortado ' + Math.round(amt * 1000) + ' ms.'); }
    if (/\b(adelanta|alarga)\b/.test(t) && /\b(inicio|principio|comienzo)\b/.test(t)) { if (i < 0) return say('¿De qué pad?'); X.chops[i].a = Math.max(0, X.chops[i].a - amt); return say('Inicio de «' + X.chops[i].label + '» adelantado ' + Math.round(amt * 1000) + ' ms.'); }
    if (/\b(acorta|recorta|retrasa)\b/.test(t) && /\b(inicio|principio|comienzo)\b/.test(t)) { if (i < 0) return say('¿De qué pad?'); X.chops[i].a = Math.min(X.chops[i].b - 0.02, X.chops[i].a + amt); return say('Inicio de «' + X.chops[i].label + '» retrasado ' + Math.round(amt * 1000) + ' ms.'); }
    if (/\b(une|junta|merge)\b/.test(t)) { const m = t.match(/\bune\s+(.+?)\s+(?:y|con)\s+(.+)$/); let a = i, b = i + 1; if (m) { a = X.chops.findIndex(c => norm(c.label) === norm(m[1])); b = X.chops.findIndex(c => norm(c.label) === norm(m[2])); } if (a < 0 || b < 0 || a === b) return say('No sé qué pads unir. Ejemplo: «une I y love».'); merge(Math.min(a, b), Math.max(a, b)); return say('Pads unidos.'); }
    if (/\b(divide|parte|separa)\b/.test(t)) { if (i < 0) return say('¿Qué pad divido?'); split(i); return say('Pad dividido en dos.'); }
    if (/\b(borra|quita|elimina)\b/.test(t)) { if (i < 0) return say('¿Qué pad borro?'); const l = X.chops[i].label; X.chops.splice(i, 1); X.chopSel = -1; return say('Pad «' + l + '» borrado.'); }
    // si no es un retoque, es una orden nueva
    run(text);
  }
  function merge(a, b) { const A = X.chops[a], B = X.chops[b]; A.b = Math.max(A.b, B.b); A.a = Math.min(A.a, B.a); A.label = A.label + ' ' + B.label; X.chops.splice(b, 1); X.chopSel = a; drawChops(); }
  function split(i) { const c = X.chops[i], m = (c.a + c.b) / 2; X.chops.splice(i + 1, 0, { a: m, b: c.b, label: c.label + ' (2)' }); c.b = m; drawChops(); }

  /* ---------------- Exportar ---------------- */
  function chopBuffer(c) { return fadeEdges(sliceBuf(X.chopBuf, c.a, c.b), 3); }
  function toPads() {
    if (!X.chops.length) return flash('No hay pads que asignar.');
    const b0 = typeof bank === 'number' ? bank : 0, room = 64 - b0 * 16;
    let n = Math.min(X.chops.length, room);
    if (X.chops.length > room && !confirm('Hay ' + X.chops.length + ' trozos y desde el banco ' + BANKS[b0] + ' caben ' + room + '. Se asignan los primeros ' + room + '. ¿Seguir?')) return;
    const used = Array.from({ length: n }, (_, k) => b0 * 16 + k).filter(t => pads[t].buf).length;
    if (used && !confirm(used + ' pad' + (used === 1 ? '' : 's') + ' del banco ' + BANKS[b0] + ' ya tienen sonido y se sustituirán. ¿Seguir?')) return;
    for (let k = 0; k < n; k++) { const t = b0 * 16 + k, p = pads[t]; stop(t); resetPad(p); Object.assign(p, { buf: chopBuffer(X.chops[k]), name: cleanName(X.chops[k].label) }); labels(t); }
    select(b0 * 16); status('Extractor: ' + n + ' pads en el banco ' + BANKS[b0] + (n > 16 ? ' y siguientes' : ''));
    flash(n + ' pads asignados desde ' + BANKS[b0] + '1. Vuelve a la pestaña Sampler para tocarlos.');
  }
  function stemToPad(k) { const b = X.stems[k]; if (!b) return; const t = pads[sel] && pads[sel].buf ? nextEmpty(sel) : sel; if (t == null || t < 0) return flash('No quedan pads libres.'); const p = pads[t]; stop(t); resetPad(p); Object.assign(p, { buf: b, name: cleanName(stemLabel(k) + ' ' + X.srcName) }); labels(t); select(t); flash('«' + stemLabel(k) + '» en el pad ' + (t + 1) + '.'); }
  const fileBase = () => cleanName(X.srcName).replace(/\s+/g, '_');
  function stemWav(k) { save(new Blob([SH.wav.encode(X.stems[k], 24)], { type: 'audio/wav' }), fileBase() + '_' + cleanName(stemLabel(k)).replace(/\s+/g, '_') + '.wav'); }
  function allStemsZip() { const f = Object.keys(X.stems).map(k => ({ name: fileBase() + '_' + cleanName(stemLabel(k)).replace(/\s+/g, '_') + '.wav', data: new Uint8Array(SH.wav.encode(X.stems[k], 24)) })); save(new Blob([zip(f)], { type: 'application/zip' }), fileBase() + '_pistas.zip'); }
  function chopsZip() { const f = X.chops.map((c, i) => ({ name: String(i + 1).padStart(2, '0') + '_' + cleanName(c.label).replace(/\s+/g, '_') + '.wav', data: new Uint8Array(SH.wav.encode(chopBuffer(c), 24)) })); save(new Blob([zip(f)], { type: 'application/zip' }), fileBase() + '_pads.zip'); }
  function notesForView() { const r = X.riffs[X.riffSel]; return r ? r.notes.map(n => Object.assign({}, n, { t: n.t })) : X.notes; }
  function midiSave() { const ns = notesForView(); if (!ns.length) return; const data = (X.notesMidi && X.riffSel < 0) ? X.notesMidi : midiFile(ns.map(n => Object.assign({}, n, { t: n.t - (X.riffSel < 0 ? 0 : 0) })), X.tempo || 120); save(new Blob([data], { type: 'audio/midi' }), fileBase() + '_' + cleanName(stemLabel(X.notesStem)) + (X.riffSel >= 0 ? '_riff' + (X.riffSel + 1) : '') + '.mid'); }
  function tabSave() { save(new Blob([$x('#exTab').textContent], { type: 'text/plain' }), fileBase() + '_tab.txt'); }
  function sendSheet(kind) {
    const items = async () => {
      if (kind === 'stems') return Object.keys(X.stems).map(k => ({ name: stemLabel(k) + ' · ' + X.srcName, kind: 'stem', audio: X.stems[k], meta: { stem: k } }));
      if (kind === 'stem') return [{ name: stemLabel(X.selStem) + ' · ' + X.srcName, kind: 'stem', audio: X.stems[X.selStem] }];
      if (kind === 'chops') return X.chops.map(c => ({ name: c.label, kind: X.chops.length === 1 ? 'phrase' : 'pad', audio: chopBuffer(c) }));
      if (kind === 'notes') return [{ name: 'Notas · ' + stemLabel(X.notesStem) + ' · ' + X.srcName, kind: 'notes', audio: X.stems[X.notesStem] || null, notes: notesForView(), bpm: X.tempo || null }];
      return [];
    };
    SH.ui.sendSheet({ from: 'sampler', kinds: kind === 'chops' ? ['pad', 'phrase'] : kind === 'notes' ? ['notes', 'stem'] : ['stem', 'loop'], getItems: items, count: kind === 'stems' ? Object.keys(X.stems).length : kind === 'chops' ? X.chops.length : 1 });
  }

  /* ---------------- Informe de error ---------------- */
  function reportError(where, err, opts) {
    try {
      const nav = navigator, txt = [
        'INFORME DE ERROR · SampledHead App · Extractor ' + EXT_VERSION + ' (app ' + (window.APP_VERSION || (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?')) + ', sh-core ' + (SH && SH.core) + ')',
        'Fecha: ' + new Date().toString(), 'Dónde: ' + where,
        'Etapa: ' + (X.steps.filter(s => s.st !== 'wait').map(s => s.t + ' [' + s.st + ' ' + Math.round(s.p * 100) + '%] ' + s.info).join(' | ') || '-'),
        'Mensaje: ' + (err && err.message || err), 'Stack: ' + (err && err.stack || '-'), '',
        'Navegador/UA: ' + nav.userAgent, 'Plataforma: ' + (nav.platform || '?') + ' · SH: ' + (SH ? SH.platform : '-'), 'Núcleos: ' + (nav.hardwareConcurrency || '?') + ' · RAM: ' + (nav.deviceMemory || '?') + ' GB',
        'Pantalla: ' + screen.width + 'x' + screen.height + ' @' + devicePixelRatio, 'URL/protocolo: ' + location.href, 'Contexto seguro: ' + isSecureContext + ' · COOP/COEP (aislado): ' + (window.crossOriginIsolated ? 'sí' : 'no'),
        'WebGPU: ' + (X.webgpu ? 'sí' + (X.f16 ? ' (shader-f16)' : '') : 'no'), 'Audio: ' + (ctx ? ctx.state + ' ' + ctx.sampleRate + ' Hz' : '?'),
        'Memoria JS: ' + (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) + ' / ' + Math.round(performance.memory.jsHeapSizeLimit / 1048576) + ' MB' : '?'),
        'Motor local: ' + JSON.stringify(X.engine || null), 'Opciones: ' + JSON.stringify({ orden: opts || X.last, calidad: X.quality, idioma: ($x('#exLang') || {}).value }),
        'Archivo: ' + (X.src ? X.srcName + ' · ' + X.src.duration.toFixed(2) + ' s · ' + X.src.numberOfChannels + ' canales · ' + X.src.sampleRate + ' Hz' : '(ninguno)'),
        'Resultado parcial: pistas [' + Object.keys(X.stems).join(', ') + '] · palabras ' + X.words.length + ' · notas ' + X.notes.length + ' · pads ' + X.chops.length,
        '', '--- Cronología y consola (últimas ' + X.log.length + ' líneas) ---', ...X.log
      ].join('\n');
      X.lastReport = txt;
      const b = $x('#exReport'); if (b) b.hidden = false;
      if ((X.autoReports = (X.autoReports || 0) + 1) <= 3) save(new Blob([txt], { type: 'text/plain' }), 'extractor-' + EXT_VERSION + '-informe-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt');
    } catch (e) { console.error(e); }
  }
  window.addEventListener('unhandledrejection', e => { const s = String(e.reason && e.reason.stack || e.reason || ''); if (/extractor|unblend|whisper|basic|asr-worker|notes-worker/i.test(s)) { LOG('promesa rechazada', s); reportError('promesa sin capturar', e.reason); } });

  /* ---------------- Interfaz ---------------- */
  const CSS = `
#extpanel{display:none;padding:2px 2px 12px}
.unit.ext #extpanel{display:block}
.unit.ext .padzone,.unit.ext .lcd,.unit.ext .ctl,.unit.ext .chips,.unit.ext .lpbar,.unit.ext .lpexp,.unit.ext .tuner,.unit.ext #banks{display:none}
.unit.ext{--acc:#ffb000}#tabE{--tc:#ffb000}
#extpanel .exc{background:var(--panel);border-radius:12px;padding:10px 12px;margin:0 0 10px}
#extpanel h4{margin:0 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
#extpanel .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#extpanel button,#extpanel .btn{background:var(--chip);color:var(--ink);border:0;border-radius:9px;padding:7px 11px;font:600 13px Barlow,system-ui,sans-serif;cursor:pointer}
#extpanel button.pri{background:var(--acc);color:#111}
#extpanel button:disabled{opacity:.45;cursor:default}
#extpanel select,#extpanel input[type=text],#extpanel input[type=password],#extpanel textarea{background:var(--chip);color:var(--ink);border:1px solid #333a45;border-radius:9px;padding:7px 9px;font:14px Barlow,system-ui,sans-serif;-webkit-user-select:text;user-select:text}
#extpanel textarea{width:100%;box-sizing:border-box;min-height:52px;resize:vertical}
#extpanel .ex-src{font-size:13px;color:var(--mute);margin-left:4px}
#extpanel canvas{width:100%;display:block;border-radius:8px;background:#0b0d10;touch-action:none}
#exWave{height:84px;margin-top:8px}#exChopWave{height:110px}#exRoll{height:220px}
#extpanel .chipz{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
#extpanel .chipz button{font-weight:500;background:#20252d;font-size:12.5px;padding:5px 9px}
#extpanel .note{font-size:12.5px;color:var(--mute);margin-top:6px}
#extpanel .flash{font-size:13px;margin-top:8px;padding:8px 10px;border-radius:9px;background:#2a2412;color:#ffd68a}
#extpanel .flash.err{background:#2c1515;color:#ff9b9b}
#extpanel .exstep{display:grid;grid-template-columns:18px 1fr 90px;gap:8px;align-items:center;font-size:13px;padding:3px 0}
#extpanel .exstep .ic::before{content:'○';color:var(--mute)}#extpanel .exstep.run .ic::before{content:'◐';color:var(--acc)}
#extpanel .exstep.done .ic::before{content:'✓';color:#7fe08a}#extpanel .exstep.error .ic::before{content:'✕';color:#ff7b7b}
#extpanel .exstep .bar{height:5px;background:#2a2f38;border-radius:3px;overflow:hidden}#extpanel .exstep .bar i{display:block;height:100%;background:var(--acc)}
#extpanel .exstep.error .tx{color:#ff9b9b}
#extpanel .rtabs{display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap}#extpanel .rtabs button.on{background:var(--acc);color:#111}
#extpanel .srow{display:flex;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid #262b34;flex-wrap:wrap}
#extpanel .srow b{flex:1;min-width:110px}
#extpanel .pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;margin-top:8px}
#extpanel .pgrid button{min-height:46px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#extpanel .pgrid button.on{outline:2px solid var(--acc)}
#extpanel pre{background:#0b0d10;border-radius:8px;padding:10px;overflow:auto;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;-webkit-user-select:text;user-select:text;max-height:320px}
#extpanel .words{display:flex;flex-wrap:wrap;gap:4px}#extpanel .words button{font-weight:500;padding:4px 8px}#extpanel .words button.on{background:var(--acc);color:#111}
#extpanel .eng{font-size:12.5px}#extpanel .eng b{color:var(--acc)}
#extpanel details summary{cursor:pointer;color:var(--mute);font-size:13px;margin-top:6px}
@media(min-width:900px){#extpanel .cols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:12px}}
`;
  const EXAMPLES = ['Extrae la voz', 'Extrae la batería de esta parte', 'Extrae la voz que dice «I love you»', 'Extrae «I love you» y pon cada palabra en un pad',
    'Extrae el bajo y pon cada nota en un pad', 'Sácame las notas del riff principal del bajo', 'Transcribe el solo de guitarra', 'Pon cada golpe de la batería en un pad', 'Extrae la trompeta'];
  function html() {
    return `
<div class="cols"><div>
<div class="exc"><h4>Audio</h4>
  <div class="row"><label class="btn">Cargar audio<input id="exFile" type="file" accept="audio/*,video/*" hidden></label>
  <button id="exFromPad">Usar el pad seleccionado</button><button id="exInbox">Recibido</button><span class="ex-src" id="exSrc">Ningún audio</span></div>
  <canvas id="exWave" aria-label="Forma de onda: arrastra para marcar «esta parte»"></canvas>
  <div class="row" style="margin-top:6px"><button id="exPlaySrc">▶ Escuchar</button><button id="exSelAll">Toda la canción</button><span class="ex-src" id="exSelInfo">Arrastra sobre la onda para marcar «esta parte».</span></div>
</div>
<div class="exc"><h4>¿Qué quieres extraer?</h4>
  <textarea id="exText" placeholder="Por ejemplo: extrae la voz que dice «I love you» y pon cada palabra en un pad"></textarea>
  <div class="row" style="margin-top:6px"><button class="pri" id="exGo">Extraer</button><button id="exStop" hidden>Cancelar</button>
  <select id="exQual" aria-label="Calidad"><option value="max">Máxima calidad</option><option value="fast">Rápida</option></select>
  <select id="exLang" aria-label="Idioma de la letra"><option value="">Letra: detectar idioma</option><option value="es">Letra en castellano</option><option value="en">Letra en inglés</option><option value="pt">Portugués</option><option value="fr">Francés</option><option value="it">Italiano</option></select>
  <label class="ex-src"><input type="checkbox" id="exUniq"> una de cada (nota o golpe)</label></div>
  <div class="chipz" id="exEx"></div>
  <div class="note" id="exPlan"></div><div id="exFlash"></div>
  <div id="exSteps" style="margin-top:6px"></div>
  <div class="row" style="margin-top:6px"><button id="exReport" hidden>Descargar informe (.txt)</button></div>
</div>
<div class="exc eng" id="exEng"></div>
</div><div>
<div class="exc" id="exRes"><h4>Resultado</h4>
  <div class="rtabs"><button data-v="stems">Pistas</button><button data-v="chops">Pads</button><button data-v="notes">Notas</button><button data-v="words">Letra</button></div>
  <div id="exV_stems"></div>
  <div id="exV_chops" hidden>
    <canvas id="exChopWave" aria-label="Cortes: arrastra los bordes del pad elegido"></canvas>
    <div class="pgrid" id="exPads"></div>
    <div class="row" style="margin-top:8px"><button id="exNaM">◀ inicio</button><button id="exNaP">inicio ▶</button><button id="exNbM">◀ final</button><button id="exNbP">final ▶</button><button id="exMerge">Unir con el siguiente</button><button id="exSplit">Dividir</button><button id="exDel">Borrar</button></div>
    <div class="row" style="margin-top:6px"><input type="text" id="exRefine" placeholder="Retocar con texto: «alarga un poco el final de Love»" style="flex:1;min-width:200px"><button id="exRefGo">Aplicar</button></div>
    <div class="row" style="margin-top:8px"><button class="pri" id="exToPads">Asignar al banco</button><button id="exChopsZip">WAV (zip)</button><button id="exChopsSend">Enviar a…</button></div>
  </div>
  <div id="exV_notes" hidden>
    <div class="row"><select id="exRiffs"></select><select id="exInst"><option value="bass4">Bajo 4 cuerdas</option><option value="bass5">Bajo 5 cuerdas</option><option value="guitar">Guitarra</option></select>
    <select id="exSpeed"><option value="1">Velocidad 100 %</option><option value="0.75">75 %</option><option value="0.5">50 %</option></select></div>
    <canvas id="exRoll" aria-label="Piano roll" style="margin-top:8px"></canvas>
    <div class="row" style="margin-top:6px"><button id="exPlayStem">▶ Pista</button><button id="exPlayNotes">▶ Notas</button><button id="exStopPlay">■</button><button id="exMidi">MIDI</button><button id="exTabTxt">Tab (.txt)</button><button id="exNotesSend">Enviar a…</button><button id="exNotesPads">Una nota por pad</button></div>
    <pre id="exTab"></pre><div class="note" id="exNotesInfo"></div>
  </div>
  <div id="exV_words" hidden><div class="note">Toca una palabra para escucharla; toca otra para marcar un tramo.</div><div class="words" id="exWords"></div>
    <div class="row" style="margin-top:8px"><button id="exWordsCut">Recortar el tramo</button><button id="exWordsChop">Cada palabra en un pad</button><button id="exWordsSyl">Cada sílaba en un pad</button></div></div>
</div>
</div></div>`;
  }
  function flash(msg, err) { const f = $x('#exFlash'); if (!f) return; f.innerHTML = ''; if (!msg) return; const d = document.createElement('div'); d.className = 'flash' + (err ? ' err' : ''); d.textContent = msg; f.appendChild(d); }
  function setBusy(b) { $x('#exGo').disabled = b; $x('#exStop').hidden = !b; }

  async function drawEngine() {
    const box = $x('#exEng'); if (!box) return;
    await engineState(); await detectGpu();
    const E = X.engine, plat = SH ? SH.platform : 'web';
    let h = '<h4>Motor de IA</h4>';
    if (plat === 'mobile') h += '<div>📱 <b>Móvil</b>: modelos ligeros (htdemucs, Whisper base, Basic Pitch). Los modelos grandes funcionan en ordenador.</div>';
    if (E.available) {
      if (E.installed) {
        h += '<div>🖥️ <b>Motor local instalado</b> · ' + (E.gpu || '') + ' · partes: ' + ((E.parts || []).join(', ') || 'ninguna') + '</div>';
        if (E.error) h += '<div class="flash err">' + esc(E.error) + '</div>';
        const miss = ['separar', 'letra', 'notas', 'sam'].filter(p => !(E.parts || []).includes(p));
        if (miss.length) h += '<div class="row" style="margin-top:6px"><button id="exEngInst">Instalar lo que falta (' + miss.join(', ') + ')</button></div>';
      } else {
        h += '<div>🖥️ <b>Motor local sin instalar</b>. Con él se usan BS-RoFormer, SAM Audio (instrumentos por texto), Whisper large-v3 y MuScriptor con tu tarjeta gráfica. Ocupa unos 6–10 GB en Documentos/SampledHead/Motor.</div>' +
          '<div class="row" style="margin-top:6px"><button class="pri" id="exEngInst">Instalar el motor local</button></div>';
      }
      h += '<details><summary>Cuenta de Hugging Face (para MuScriptor y SAM Audio)</summary><div class="note">Son gratuitos pero piden aceptar su licencia: crea una cuenta en huggingface.co, acepta en <a href="https://huggingface.co/MuScriptor/muscriptor-large" target="_blank" rel="noopener">MuScriptor</a> y <a href="https://huggingface.co/facebook/sam-audio-base" target="_blank" rel="noopener">SAM Audio</a>, y pega aquí un token de lectura (<a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">crear token</a>). Se guarda solo en este ordenador.</div>' +
        '<div class="row" style="margin-top:6px"><input type="password" id="exHfTok" placeholder="hf_…" style="flex:1"><button id="exHfSave">Guardar</button></div></details>' +
        '<div id="exEngProg" class="note"></div>';
    } else if (plat !== 'mobile') {
      h += '<div>🌐 <b>Navegador</b> · ' + (X.webgpu ? 'WebGPU disponible' + (X.f16 ? ' (fp16)' : '') + ': BS-RoFormer SW y Whisper large-v3 turbo.' : 'sin WebGPU: htdemucs y Whisper base por CPU (más lento).') + ' Basic Pitch para las notas.</div>' +
        '<div class="note">SAM Audio (cualquier instrumento por texto) y MuScriptor necesitan la app de Windows o Mac con el motor local. Los modelos se descargan una vez y los comparten todas las apps.</div>';
    }
    box.innerHTML = h;
    const ib = $x('#exEngInst'); if (ib) ib.onclick = installEngine;
    const hs = $x('#exHfSave'); if (hs) hs.onclick = async () => { await SH.desktop.engine.setToken($x('#exHfTok').value); $x('#exHfTok').value = ''; flash('Token guardado en este ordenador.'); };
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function installEngine() {
    const b = $x('#exEngInst'); b.disabled = true; const pr = $x('#exEngProg');
    try {
      await SH.engine.install(['separar', 'letra', 'notas', 'sam'], p => { pr.textContent = Math.round((p.frac || 0) * 100) + '% · ' + (p.stage || '') + (p.line ? ' · ' + p.line : ''); });
      flash('Motor local instalado.');
    } catch (e) { flash('No se pudo instalar el motor: ' + e.message, true); reportError('instalación del motor local', e); }
    drawEngine();
  }

  /* --- onda de la fuente con selección --- */
  function drawWave() {
    const c = $x('#exWave'); if (!c) return; const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = c.clientHeight * devicePixelRatio, g = c.getContext('2d');
    g.clearRect(0, 0, w, h); if (!X.src) return;
    const d = X.src.getChannelData(0), step = Math.max(1, Math.floor(d.length / w));
    if (X.sel) { const a = X.sel[0] / X.src.duration * w, z = X.sel[1] / X.src.duration * w; g.fillStyle = 'rgba(255,176,0,.18)'; g.fillRect(a, 0, z - a, h); }
    g.fillStyle = '#8fb3c9';
    for (let x = 0; x < w; x++) { let mn = 1, mx = -1; const o = x * step; for (let i = 0; i < step; i += 4) { const v = d[o + i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; } g.fillRect(x, (1 - mx) * h / 2, 1, Math.max(1, (mx - mn) * h / 2)); }
    if (X.sel) { g.fillStyle = '#ffb000'; [X.sel[0], X.sel[1]].forEach(t => g.fillRect(t / X.src.duration * w - 1, 0, 2, h)); }
    $x('#exSelInfo').textContent = X.sel ? 'Parte marcada: ' + fmt(X.sel[0]) + ' – ' + fmt(X.sel[1]) + ' (' + (X.sel[1] - X.sel[0]).toFixed(2) + ' s)' : 'Arrastra sobre la onda para marcar «esta parte».';
  }
  function bindWaveDrag(c, getDur, onSel) {
    let a = null;
    const t = e => { const r = c.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * getDur(); };
    c.addEventListener('pointerdown', e => { if (!getDur()) return; a = t(e); c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', e => { if (a == null) return; const b = t(e); onSel(Math.min(a, b), Math.max(a, b), false); });
    c.addEventListener('pointerup', e => { if (a == null) return; const b = t(e); onSel(Math.min(a, b), Math.max(a, b), true); a = null; });
  }
  function setSource(buf, name) {
    stopPlay(); X.src = buf; X.srcName = String(name || 'audio').replace(/\.[^.]+$/, ''); X.sel = null; X.regionKey = ''; X.stems = {}; X.words = []; X.notes = []; X.chops = []; X.riffs = [];
    $x('#exSrc').textContent = X.srcName + ' · ' + buf.duration.toFixed(1) + ' s'; drawWave(); render(); flash('');
  }

  /* --- resultados --- */
  function render() {
    document.querySelectorAll('#extpanel .rtabs button').forEach(b => b.classList.toggle('on', b.dataset.v === X.view));
    ['stems', 'chops', 'notes', 'words'].forEach(v => { $x('#exV_' + v).hidden = v !== X.view; });
    drawStems(); drawChops(); drawNotes(); drawWords();
  }
  function drawStems() {
    const box = $x('#exV_stems'); box.innerHTML = '';
    const ks = Object.keys(X.stems);
    if (!ks.length) { box.innerHTML = '<div class="note">Aquí salen las pistas separadas. Escribe qué quieres y pulsa Extraer.</div>'; return; }
    const info = document.createElement('div'); info.className = 'note'; info.textContent = 'Modelo: ' + (X.stemModel || '?'); box.appendChild(info);
    ks.forEach(k => {
      const r = document.createElement('div'); r.className = 'srow';
      r.innerHTML = '<button>▶</button><b></b><span class="ex-src"></span><button>Al pad</button><button>WAV</button><button>Notas</button><button>Enviar a…</button>';
      r.querySelector('b').textContent = stemLabel(k); r.querySelector('span').textContent = X.stems[k].duration.toFixed(1) + ' s';
      const bs = r.querySelectorAll('button');
      bs[0].onclick = () => play(X.stems[k]); bs[1].onclick = () => stemToPad(k); bs[2].onclick = () => stemWav(k);
      bs[3].onclick = () => { $x('#exText').value = 'Transcribe las notas de ' + (k === 'otros' ? 'otros' : stemLabel(k).toLowerCase()); run($x('#exText').value); };
      bs[4].onclick = () => { X.selStem = k; sendSheet('stem'); };
      box.appendChild(r);
    });
    const r = document.createElement('div'); r.className = 'row'; r.style.marginTop = '8px';
    r.innerHTML = '<button>Todas en WAV (zip)</button><button>Enviar todas a…</button>';
    r.children[0].onclick = allStemsZip; r.children[1].onclick = () => sendSheet('stems'); box.appendChild(r);
  }
  function drawChops() {
    const grid = $x('#exPads'); if (!grid) return; grid.innerHTML = '';
    X.chops.forEach((c, i) => {
      const b = document.createElement('button'); b.textContent = (i + 1) + ' · ' + c.label; b.title = fmt(c.a) + ' – ' + fmt(c.b);
      b.classList.toggle('on', i === X.chopSel);
      b.onclick = () => { X.chopSel = i; play(X.chopBuf, c.a, c.b); drawChops(); };
      grid.appendChild(b);
    });
    if (!X.chops.length) grid.innerHTML = '<div class="note">Pide por ejemplo «pon cada palabra en un pad», «cada nota» o «cada golpe».</div>';
    const cv = $x('#exChopWave'); if (!cv || $x('#exV_chops').hidden) return;
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio, g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
    if (!X.chopBuf) return;
    // vista: alrededor de los cortes
    const a0 = X.chops.length ? Math.max(0, Math.min(...X.chops.map(c => c.a)) - 0.2) : 0, z0 = X.chops.length ? Math.min(X.chopBuf.duration, Math.max(...X.chops.map(c => c.b)) + 0.2) : X.chopBuf.duration;
    X.chopView = [a0, z0];
    const d = X.chopBuf.getChannelData(0), sr = X.chopBuf.sampleRate, i0 = a0 * sr, span = (z0 - a0) * sr, step = Math.max(1, Math.floor(span / w));
    X.chops.forEach((c, i) => { const x0 = (c.a - a0) / (z0 - a0) * w, x1 = (c.b - a0) / (z0 - a0) * w; g.fillStyle = i === X.chopSel ? 'rgba(255,176,0,.28)' : (i % 2 ? 'rgba(80,140,255,.12)' : 'rgba(80,220,160,.12)'); g.fillRect(x0, 0, x1 - x0, h); });
    g.fillStyle = '#9bb7c8';
    for (let x = 0; x < w; x++) { let mn = 1, mx = -1; const o = Math.floor(i0 + x * span / w); for (let k = 0; k < step; k += 3) { const v = d[o + k] || 0; if (v < mn) mn = v; if (v > mx) mx = v; } g.fillRect(x, (1 - mx) * h / 2, 1, Math.max(1, (mx - mn) * h / 2)); }
    g.font = (11 * devicePixelRatio) + 'px Barlow,sans-serif';
    X.chops.forEach((c, i) => { const x0 = (c.a - a0) / (z0 - a0) * w, x1 = (c.b - a0) / (z0 - a0) * w; g.fillStyle = i === X.chopSel ? '#ffb000' : '#cfd6df'; g.fillRect(x0, 0, 1.5, h); g.fillRect(x1 - 1, h * 0.6, 1, h * 0.4); g.fillText(c.label, x0 + 3, 12 * devicePixelRatio); });
  }
  function bindChopDrag() {
    const cv = $x('#exChopWave'); let drag = null;
    const tAt = e => { const r = cv.getBoundingClientRect(), v = X.chopView || [0, 1]; return v[0] + (e.clientX - r.left) / r.width * (v[1] - v[0]); };
    cv.addEventListener('pointerdown', e => {
      if (!X.chops.length) return; const t = tAt(e), v = X.chopView, tol = (v[1] - v[0]) * 0.012;
      let best = null; X.chops.forEach((c, i) => { if (Math.abs(c.a - t) < tol) best = { i, k: 'a' }; else if (Math.abs(c.b - t) < tol) best = best || { i, k: 'b' }; });
      if (!best) { const i = X.chops.findIndex(c => t >= c.a && t <= c.b); if (i >= 0) { X.chopSel = i; play(X.chopBuf, X.chops[i].a, X.chops[i].b); drawChops(); } return; }
      drag = best; X.chopSel = best.i; cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => { if (!drag) return; const c = X.chops[drag.i], t = tAt(e); if (drag.k === 'a') c.a = Math.max(0, Math.min(c.b - 0.01, t)); else c.b = Math.min(X.chopBuf.duration, Math.max(c.a + 0.01, t)); drawChops(); });
    cv.addEventListener('pointerup', () => { if (drag) { const c = X.chops[drag.i]; play(X.chopBuf, c.a, c.b); } drag = null; });
  }
  function drawNotes() {
    const sel = $x('#exRiffs'); if (!sel) return;
    sel.innerHTML = '<option value="-1">Todas las notas (' + X.notes.length + ')</option>' + X.riffs.map((r, i) => '<option value="' + i + '">' + r.name + ' · se repite ' + r.count + ' veces · ' + r.len + ' compás' + (r.len > 1 ? 'es' : '') + '</option>').join('');
    sel.value = String(X.riffSel);
    const ns = notesForView();
    $x('#exTab').textContent = ns.length ? tabOf(ns, X.tabInst, X.tempo) : 'Pide por ejemplo «sácame las notas del bajo» o «transcribe el solo de guitarra».';
    $x('#exNotesInfo').textContent = X.notes.length ? 'Modelo: ' + X.notesModel + ' · pista: ' + stemLabel(X.notesStem) + (X.tempo ? ' · tempo estimado ' + Math.round(X.tempo) + ' BPM' : '') + (X.riffs.length ? ' · las variaciones sueltas no salen como riff' : '') : '';
    const cv = $x('#exRoll'); if (!cv || $x('#exV_notes').hidden) return;
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio, g = cv.getContext('2d');
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, w, h); if (!ns.length) return;
    const t0 = Math.min(...ns.map(n => n.t)), t1 = Math.max(...ns.map(n => n.t + n.d)), p0 = Math.min(...ns.map(n => n.p)) - 2, p1 = Math.max(...ns.map(n => n.p)) + 2, rows = p1 - p0 + 1, rh = h / rows;
    for (let p = p0; p <= p1; p++) { const y = h - (p - p0 + 1) * rh; g.fillStyle = [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12) ? '#11151b' : '#161b22'; g.fillRect(0, y, w, rh); if (p % 12 === 0) { g.fillStyle = '#5c6675'; g.font = (10 * devicePixelRatio) + 'px sans-serif'; g.fillText(noteName(p), 2, y + rh - 2); } }
    if (X.tempo) { const beat = 60 / X.tempo; g.fillStyle = '#232a33'; for (let t = 0; t < t1 - t0; t += beat) g.fillRect(28 * devicePixelRatio + t / (t1 - t0 + 0.001) * (w - 30 * devicePixelRatio), 0, 1, h); }
    ns.forEach(n => { const x = 28 * devicePixelRatio + (n.t - t0) / (t1 - t0 + 0.001) * (w - 30 * devicePixelRatio), ww = Math.max(2, n.d / (t1 - t0 + 0.001) * (w - 30 * devicePixelRatio)), y = h - (n.p - p0 + 1) * rh; g.fillStyle = n.drum ? '#ff7a59' : '#ffb000'; g.fillRect(x, y + 1, ww, Math.max(2, rh - 2)); });
  }
  function drawWords() {
    const box = $x('#exWords'); if (!box) return; box.innerHTML = '';
    if (!X.words.length) { box.innerHTML = '<div class="note">Pide algo con la letra («extrae la voz que dice…») para ver aquí las palabras con su tiempo.</div>'; return; }
    const sel = X.wsel || [];
    X.words.forEach((w, i) => {
      const b = document.createElement('button'); b.textContent = w.w; b.title = fmt(w.s) + ' – ' + fmt(w.e);
      if (sel.length && i >= Math.min(...sel) && i <= Math.max(...sel)) b.classList.add('on');
      b.onclick = () => { const vb = X.stems.voz; if (vb) play(vb, Math.max(0, w.s - 0.03), w.e + 0.08); X.wsel = !sel.length || sel.length === 2 ? [i] : [sel[0], i]; drawWords(); };
      box.appendChild(b);
    });
  }
  function wordsRange() { const s = X.wsel || []; if (!s.length) return null; return [Math.min(...s), Math.max(...s)]; }

  function bind() {
    $x('#exFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { ctx.resume(); status('Extractor: leyendo…'); setSource(await ctx.decodeAudioData(await f.arrayBuffer()), f.name); status('Extractor: ' + f.name); } catch (er) { flash('No se pudo leer ese archivo.', true); } };
    $x('#exFromPad').onclick = () => { const p = pads[sel]; if (!p || !p.buf) return flash('El pad seleccionado está vacío.'); const b = p.buf, n = b.length, a = Math.floor((p.s || 0) * n), z = Math.ceil((p.e == null ? 1 : p.e) * n); setSource(a > 0 || z < n ? sliceBuf(b, a / b.sampleRate, z / b.sampleRate) : b, p.name || 'Pad ' + (sel + 1)); };
    $x('#exInbox').onclick = () => openInbox(false);
    $x('#exPlaySrc').onclick = () => { if (X.playing) return stopPlay(); if (X.src) play(X.src, X.sel ? X.sel[0] : 0, X.sel ? X.sel[1] : undefined); };
    $x('#exSelAll').onclick = () => { X.sel = null; drawWave(); };
    bindWaveDrag($x('#exWave'), () => X.src ? X.src.duration : 0, (a, z, end) => { X.sel = z - a > 0.05 ? [a, z] : null; drawWave(); if (end && X.sel) play(X.src, a, z); });
    $x('#exGo').onclick = () => { const t = $x('#exText').value.trim(); if (!t) return flash('Escribe qué quieres extraer.'); run(t); };
    $x('#exText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $x('#exGo').click(); });
    $x('#exStop').onclick = () => { X.cancel = true; flash('Se detendrá en cuanto termine el paso actual. Si tarda, recarga la página.'); };
    $x('#exQual').onchange = e => { X.quality = e.target.value; if (sepInst) { try { sepInst.unload(); } catch (x) {} } sepInst = null; sepKey = ''; };
    $x('#exReport').onclick = () => save(new Blob([X.lastReport || 'Sin errores registrados'], { type: 'text/plain' }), 'extractor-' + EXT_VERSION + '-informe.txt');
    const ex = $x('#exEx'); EXAMPLES.forEach(t => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { $x('#exText').value = t; }; ex.appendChild(b); });
    document.querySelectorAll('#extpanel .rtabs button').forEach(b => b.onclick = () => { X.view = b.dataset.v; render(); });
    bindChopDrag();
    const nud = (k, d) => () => { const c = X.chops[X.chopSel]; if (!c) return flash('Elige un pad.'); c[k] = Math.max(0, Math.min(X.chopBuf.duration, c[k] + d)); if (c.b < c.a + 0.01) c.b = c.a + 0.01; drawChops(); play(X.chopBuf, c.a, c.b); };
    $x('#exNaM').onclick = nud('a', -0.01); $x('#exNaP').onclick = nud('a', 0.01); $x('#exNbM').onclick = nud('b', -0.01); $x('#exNbP').onclick = nud('b', 0.01);
    $x('#exMerge').onclick = () => { if (X.chopSel < 0 || X.chopSel >= X.chops.length - 1) return flash('Elige un pad que tenga otro detrás.'); merge(X.chopSel, X.chopSel + 1); };
    $x('#exSplit').onclick = () => { if (X.chopSel < 0) return flash('Elige un pad.'); split(X.chopSel); };
    $x('#exDel').onclick = () => { if (X.chopSel < 0) return flash('Elige un pad.'); X.chops.splice(X.chopSel, 1); X.chopSel = -1; drawChops(); };
    $x('#exRefGo').onclick = () => { const t = $x('#exRefine').value.trim(); if (t) refine(t); };
    $x('#exRefine').addEventListener('keydown', e => { if (e.key === 'Enter') $x('#exRefGo').click(); });
    $x('#exToPads').onclick = toPads; $x('#exChopsZip').onclick = () => X.chops.length && chopsZip(); $x('#exChopsSend').onclick = () => X.chops.length && sendSheet('chops');
    $x('#exRiffs').onchange = e => { X.riffSel = +e.target.value; drawNotes(); };
    $x('#exInst').onchange = e => { X.tabInst = e.target.value; drawNotes(); };
    $x('#exSpeed').onchange = e => { X.speed = +e.target.value; };
    $x('#exPlayStem').onclick = () => { const b = X.stems[X.notesStem]; if (!b) return; const r = X.riffs[X.riffSel]; if (r) play(b, r.start, r.start + r.len * r.barDur, X.speed); else play(b, 0, undefined, X.speed); };
    $x('#exPlayNotes').onclick = () => playNotes(notesForView(), X.speed);
    $x('#exStopPlay').onclick = stopPlay;
    $x('#exMidi').onclick = () => notesForView().length && midiSave();
    $x('#exTabTxt').onclick = () => notesForView().length && tabSave();
    $x('#exNotesSend').onclick = () => X.notes.length && sendSheet('notes');
    $x('#exNotesPads').onclick = () => { if (!X.notes.length) return; const b = X.stems[X.notesStem]; X.chopBuf = b; X.chopName = stemLabel(X.notesStem); const r = X.riffs[X.riffSel], ns = monophonic(r ? X.notes.filter(n => n.t >= r.start - 0.01 && n.t < r.start + r.len * r.barDur) : X.notes);
      X.chops = ns.map((n, k) => ({ a: Math.max(0, n.t - 0.01), b: Math.min(b.duration, (ns[k + 1] ? Math.min(ns[k + 1].t - 0.003, n.t + n.d + 0.25) : n.t + n.d + 0.15)), label: noteName(n.p), p: n.p })).slice(0, 64); X.chopSel = -1; X.view = 'chops'; render(); };
    $x('#exWordsCut').onclick = () => { const r = wordsRange(), vb = X.stems.voz; if (!r || !vb) return flash('Toca la primera y la última palabra.'); X.chopBuf = vb; X.chops = [{ a: Math.max(0, X.words[r[0]].s - 0.05), b: Math.min(vb.duration, X.words[r[1]].e + 0.12), label: X.words.slice(r[0], r[1] + 1).map(w => w.w).join(' ') }]; X.chopSel = 0; X.view = 'chops'; render(); };
    const wchop = syl => () => { const r = wordsRange() || [0, X.words.length - 1], vb = X.stems.voz; if (!vb) return; X.chopBuf = vb; X.chops = wordChops(X.words.slice(r[0], r[1] + 1), vb, syl); X.chops = X.chops.slice(0, 64); X.chopSel = -1; X.view = 'chops'; render(); };
    $x('#exWordsChop').onclick = wchop(false); $x('#exWordsSyl').onclick = wchop(true);
    window.addEventListener('resize', () => { if ($x('.unit') && $x('.unit').classList.contains('ext')) { drawWave(); render(); } });
  }

  /* --- bandeja: lo que llega para el sampler --- */
  async function openInbox(auto) {
    if (!SH) return;
    const items = await SH.bridge.inbox('sampler');
    if (!items.length) { if (!auto) flash('La bandeja está vacía. Desde otra app usa «Enviar a… → SampledHead App».'); return; }
    SH.ui.receiveSheet('sampler', async list => {
      let n = 0;
      for (const it of list) {
        if (!it.wav) continue;
        const buf = await decodeAB(it.wav);
        const ext = $x('.unit') && $x('.unit').classList.contains('ext');
        if (ext && list.length === 1) { setSource(buf, it.name); n++; continue; }
        const t = pads[sel] && pads[sel].buf ? nextEmpty(sel) : sel; if (t == null || t < 0) break;
        const p = pads[t]; stop(t); resetPad(p); Object.assign(p, { buf, name: cleanName(it.name) }); labels(t); n++;
      }
      status('Recibidos ' + n + ' sonido' + (n === 1 ? '' : 's') + ' de otras apps');
      return true;
    }, items);
  }
  window.shSamplerInbox = openInbox;

  /* ---------------- Arranque ---------------- */
  function init() {
    if (!document.querySelector('.unit')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    let panel = $x('#extpanel'); if (!panel) { panel = document.createElement('div'); panel.id = 'extpanel'; $x('.unit').appendChild(panel); }
    panel.innerHTML = html();
    bind(); render(); drawEngine();
    X.quality = LOWMEM ? 'fast' : 'max'; if (LOWMEM) { const q = $x('#exQual'); if (q) q.value = 'fast'; }
    try {
      const c = JSON.parse(localStorage.getItem(CRUMB) || 'null');
      if (c) { crumbClear(); const msg = 'La sesión anterior se cerró sola durante el Extractor (paso: ' + (c.step || '?') + (c.file ? ' · ' + c.file : '') + (c.secs ? ' · ' + c.secs + ' s' : '') + '). Casi seguro fue falta de memoria del móvil. Ahora el modelo se descarga al terminar la separación y la calidad por defecto es «Rápida».';
        flash(msg, true); reportError('Cierre inesperado de la sesión anterior', new Error(msg), c); }
    } catch (e) {}
    if (location.protocol === 'file:') flash('Abierta desde un archivo: aquí los modelos de IA no pueden funcionar (el navegador no deja usar workers ni guardar modelos). Usa la web (sampledhead-dot.github.io/sampledhead-app) o la app de Windows/Mac.', true);
    if (SH) SH.bridge.watch('sampler', () => openInbox(true));
    LOG('Extractor ' + EXT_VERSION + ' listo · ' + (SH ? SH.platform : 'sin sh-core'));
  }
  window.extShow = () => { drawWave(); render(); drawEngine(); };
  window.EXTRACTOR = { version: EXT_VERSION, parse, describe, findPhrase, findRiffs, tabOf, midiFile, syllables, monophonic, estimateTempo, notesYin, classifyHit, state: X, setSource, run };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
