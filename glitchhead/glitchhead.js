/* GlitchHead — motor DSP de referencia (JavaScript). By Sampled Head.
 * Tres motores en cadena (orden configurable):
 *   SHRED  · trocea la entrada en wavesets (de cruce por cero a cruce por cero), los agrupa en «colecciones»
 *            y las reproduce con probabilidades (desorden, repetición, ausencia, sueño fuente/proceso).
 *   HAZE   · memoria corta que mezcla pasado y presente y la lee con granos: halos, sostenidos, drones.
 *   SPLIT  · puerta partida: lo que supera el umbral (ARRIBA, filtro tipo low-pass gate) y lo que queda
 *            debajo (ABAJO, inverso) se procesan por separado.
 * El mismo diseño está en vst/Source/dsp/GlitchDSP.h (C++). PARIDAD: cualquier cambio de sonido en los dos.
 * Todo el azar sale de Rng (xorshift32) con semillas fijas: mismo resultado en JS y C++.
 * Funciona en navegador (global GlitchHeadDSP), AudioWorklet y Node (module.exports).
 */
(function (g, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else g.GlitchHeadDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function factory() {
'use strict';

// ---------------------------------------------------------------- parámetros
// [id, nombre, min, max, defecto, tipo, descripción]  tipo: f (continuo), i (entero), b (interruptor), c:<opciones>
const PARAMS = [
  ['inputDb', 'Input', -24, 24, 0, 'f', 'Ganancia de entrada antes de los tres motores.'],
  ['mix', 'Mix', 0, 1, 1, 'f', 'Mezcla global entre la señal original y la procesada.'],
  ['outputDb', 'Output', -24, 24, 0, 'f', 'Volumen de salida.'],
  ['order', 'Orden', 0, 5, 0, 'c:Shred>Haze>Split|Shred>Split>Haze|Haze>Shred>Split|Haze>Split>Shred|Split>Shred>Haze|Split>Haze>Shred', 'Orden de los tres motores en la cadena.'],
  // SHRED
  ['sOn', 'Shred On', 0, 1, 1, 'b', 'Enciende o apaga SHRED.'],
  ['sFloor', 'Floor', 0, 3, 1, 'c:0 ms|25 ms|50 ms|100 ms', 'Duración mínima de cada colección (0, 25, 50 o 100 ms).'],
  ['sLength', 'Length', 1, 64, 8, 'i', 'Cuántos wavesets (de cruce por cero a cruce por cero) forman una colección.'],
  ['sStuck', 'Stuck', 0, 1, 0, 'f', 'Probabilidad de no grabar colecciones nuevas: el pasado se queda pegado.'],
  ['sEnv', 'Envelope', 0, 1, 0, 'b', 'Ventana suave en cada colección: transiciones más redondas.'],
  ['sDisorder', 'Disorder', 0, 1, 0.2, 'f', 'Probabilidad de saltar a colecciones anteriores (orden no lineal).'],
  ['sRate', 'Rate', -24, 24, 0, 'f', 'Velocidad de reproducción de las colecciones, en semitonos.'],
  ['sAbsence', 'Absence', -1, 1, 0, 'f', 'Izquierda: volumen aleatorio por colección. Derecha: silencios aleatorios.'],
  ['sRepeat', 'Repeat', 0, 1, 0.2, 'f', 'Probabilidad de repetir la misma colección.'],
  ['sFreeze', 'Freeze', 0, 1, 0, 'b', 'Repite la colección actual sin fin (Repeat al 100 %).'],
  ['sDream', 'Dream', 0, 1, 1, 'f', 'En cada colección, probabilidad de oír el proceso en vez de la fuente.'],
  ['sSync', 'Sync', 0, 1, 0, 'b', 'Dream decide igual en los dos canales (mono).'],
  ['sLean', 'Lean', -1, 1, 0, 'f', 'Reparte Dream entre izquierda y derecha.'],
  ['sSmoo', 'Smoo', 0, 1, 0.2, 'f', 'Suaviza el paso entre fuente y proceso (de corte seco a fundido).'],
  ['sMonitor', 'Monitor', 0, 1, 0.5, 'f', 'Balance de salida entre la fuente y el proceso.'],
  ['sSustain', 'Sustain', 0, 1, 0, 'b', 'Sigue sonando aunque deje de entrar audio.'],
  // HAZE
  ['hOn', 'Haze On', 0, 1, 0, 'b', 'Enciende o apaga HAZE.'],
  ['hRaw', 'Raw', 0, 1, 0, 'b', 'Apagado suaviza los ataques de la entrada; encendido, sonido más afilado.'],
  ['hMemory', 'Memory', 0, 1, 0.5, 'f', 'Cuánto del pasado se conserva al grabar encima: persistencia de los recuerdos.'],
  ['hFreeze', 'Freeze', 0, 1, 0, 'b', 'Congela la memoria: textura sostenida infinita.'],
  ['hSize', 'Size', 20, 2000, 300, 'f', 'Longitud de la memoria: densidad de la textura.'],
  ['hRate', 'Rate', -24, 24, 0, 'f', 'Velocidad de las cabezas de lectura, en semitonos.'],
  ['hLo', 'Lo', -12, 12, 0, 'f', 'Recorta o realza los graves de la textura.'],
  ['hHi', 'Hi', -12, 12, 0, 'f', 'Recorta o realza los agudos de la textura.'],
  ['hTemp', 'Temperature', 0, 1, 0.2, 'f', 'Distorsión; en la mitad alta añade modulación de amplitud con ruido.'],
  ['hWidth', 'Mid/Side', 0, 2, 1, 'f', 'Anchura estéreo de la textura (Mid/Side).'],
  ['hWet', 'Wet', 0, 1, 0.5, 'f', 'Volumen de la textura.'],
  ['hDry', 'Dry', 0, 1, 1, 'f', 'Volumen de la señal que entra en HAZE.'],
  // SPLIT
  ['xOn', 'Split On', 0, 1, 0, 'b', 'Enciende o apaga SPLIT.'],
  ['xMode', 'Mode', 0, 2, 0, 'c:Direct|Crossed|Summed', 'Direct: cada canal se controla a sí mismo. Crossed: al contrario. Summed: los dos juntos.'],
  ['xVerge', 'Verge', -60, 0, -30, 'f', 'Umbral: lo que lo supera va ARRIBA y genera la envolvente.'],
  ['xBoost', 'Boost', 0, 24, 0, 'f', 'Sube la entrada del detector.'],
  ['xSmooth', 'Smooth', 1, 200, 20, 'f', 'Suaviza la envolvente.'],
  ['xRetain', 'Retain', 0, 1, 0, 'f', 'Alarga la caída de la envolvente con ráfagas aleatorias.'],
  ['xDriveA', 'Drive Above', 0, 1, 0.2, 'f', 'Distorsión de ARRIBA.'],
  ['xCutA', 'Cut Above', 0, 1, 0, 'f', 'Quita graves de ARRIBA.'],
  ['xVolA', 'Vol Above', 0, 1, 0.7, 'f', 'Volumen de ARRIBA.'],
  ['xSide', 'Sidechain', 0, 1, 0, 'f', 'La envolvente de ARRIBA agacha más a ABAJO (ducking).'],
  ['xDrift', 'Drift', 0, 1, 0.2, 'f', 'Retardo corto aleatorio en ABAJO: afinación inestable.'],
  ['xMelt', 'Melt', 0, 1, 0.3, 'f', 'Difumina ABAJO.'],
  ['xDriveB', 'Drive Below', 0, 1, 0.2, 'f', 'Distorsión de ABAJO.'],
  ['xCutB', 'Cut Below', 0, 1, 0, 'f', 'Quita agudos de ABAJO.'],
  ['xVolB', 'Vol Below', 0, 1, 0.5, 'f', 'Volumen de ABAJO.'],
];
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const FLOOR_MS = [0, 25, 50, 100];

function defaults() { const p = {}; for (const d of PARAMS) p[d[0]] = d[4]; return p; }

// Presets de fábrica (solo los valores distintos del defecto). Se copian a vst/Source/Presets.h con tests/gen_cpp.js
const PRESETS = [
  { name: 'Default', cat: 'General', v: {} },
  // SHRED
  { name: 'Rasguño leve', cat: 'Shred', v: { sLength: 12, sDisorder: 0.08, sRepeat: 0.1, sDream: 0.6, sSmoo: 0.5 } },
  { name: 'Tartamudo', cat: 'Shred', v: { sLength: 24, sFloor: 3, sRepeat: 0.7, sDisorder: 0.1 } },
  { name: 'Cinta rota', cat: 'Shred', v: { sLength: 16, sFloor: 2, sStuck: 0.4, sDisorder: 0.5, sAbsence: 0.35, sRate: -2 } },
  { name: 'Fuzz de wavesets', cat: 'Shred', v: { sLength: 1, sFloor: 0, sAbsence: 0.55, sRepeat: 0.3, sDisorder: 0 } },
  { name: 'Sueño estéreo', cat: 'Shred', v: { sLength: 20, sDream: 0.5, sLean: 0.3, sSmoo: 0.8, sEnv: 1, sDisorder: 0.3 } },
  { name: 'Octava fantasma', cat: 'Shred', v: { sLength: 6, sRate: 12, sEnv: 1, sRepeat: 0.5, sMonitor: 0.45 } },
  { name: 'Congelado', cat: 'Shred', v: { sLength: 32, sFloor: 3, sFreeze: 1, sEnv: 1, sSustain: 1 } },
  // HAZE
  { name: 'Halo', cat: 'Haze', v: { sOn: 0, hOn: 1, hMemory: 0.55, hSize: 450, hWet: 0.45, hHi: 3, hTemp: 0.1 } },
  { name: 'Dron infinito', cat: 'Haze', v: { sOn: 0, hOn: 1, hMemory: 0.92, hSize: 1600, hWet: 0.7, hDry: 0.6, hLo: 2, hHi: -4 } },
  { name: 'Metal que grita', cat: 'Haze', v: { sOn: 0, hOn: 1, hRaw: 1, hMemory: 0.6, hSize: 60, hRate: 7, hTemp: 0.8, hWet: 0.6, hHi: 4 } },
  { name: 'Viento helado', cat: 'Haze', v: { sOn: 0, hOn: 1, hMemory: 0.8, hSize: 900, hRate: 12, hLo: -10, hHi: 6, hWidth: 1.8, hWet: 0.5 } },
  { name: 'Plomo fundido', cat: 'Haze', v: { sOn: 0, hOn: 1, hMemory: 0.7, hSize: 250, hRate: -12, hTemp: 0.65, hLo: 6, hHi: -6, hWet: 0.6 } },
  // SPLIT
  { name: 'Puerta oscura', cat: 'Split', v: { sOn: 0, xOn: 1, xVerge: -24, xDriveA: 0.5, xVolA: 0.7, xVolB: 0 } },
  { name: 'Caídas', cat: 'Split', v: { sOn: 0, xOn: 1, xVerge: -20, xRetain: 0.7, xSmooth: 8, xVolA: 0.8, xVolB: 0.2 } },
  { name: 'Textura temblorosa', cat: 'Split', v: { sOn: 0, xOn: 1, xVerge: -18, xVolA: 0.3, xVolB: 0.8, xDrift: 0.7, xMelt: 0.6, xSide: 0.3 } },
  { name: 'Monstruo cruzado', cat: 'Split', v: { sOn: 0, xOn: 1, xMode: 1, xVerge: -26, xBoost: 6, xDriveA: 0.8, xDriveB: 0.6, xVolA: 0.6, xVolB: 0.5 } },
  // Combinaciones
  { name: 'Bestia', cat: 'Combo', v: { sLength: 4, sAbsence: 0.3, sRepeat: 0.4, xOn: 1, xVerge: -22, xDriveA: 0.7, xVolB: 0.3, order: 0 } },
  { name: 'Desintegrar loop', cat: 'Combo', v: { sLength: 16, sFloor: 2, sStuck: 0.3, sDisorder: 0.45, hOn: 1, hMemory: 0.6, hSize: 700, hWet: 0.35 } },
  { name: 'Sombra granular', cat: 'Combo', v: { sLength: 10, sDream: 0.7, sEnv: 1, hOn: 1, hMemory: 0.75, hSize: 1200, hWet: 0.4, xOn: 1, xVerge: -30, xVolA: 0.6, xVolB: 0.4, xMelt: 0.5, order: 2 } },
];

// ---------------------------------------------------------------- utilidades
const TAU = 2 * Math.PI;
const dbToGain = d => Math.pow(10, d / 20);
const clamp = (x, a, b) => x < a ? a : (x > b ? b : x);
const BUF_BITS = 18, BUF_N = 1 << BUF_BITS, BUF_MASK = BUF_N - 1;

class Rng {               // xorshift32 → [0,1)
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  next() { let s = this.s; s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; this.s = s; return s / 4294967296; }
}

// Biquad RBJ (forma directa I, doble precisión)
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  shelf(sr, f, db, high) {
    const A = Math.pow(10, db / 40), w = TAU * f / sr, cs = Math.cos(w), sn = Math.sin(w);
    const al = sn / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    let b0, b1, b2, a0, a1, a2;
    if (!high) {
      b0 = A * ((A + 1) - (A - 1) * cs + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sA);
      a0 = (A + 1) + (A - 1) * cs + sA; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sA;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA);
      a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y;
  }
}

// SVF TPT (Zavalishin): lp / hp
class Svf {
  constructor() { this.g = 0; this.k = Math.SQRT2; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.hp = 0; }
  set(sr, f, q) {
    f = clamp(f, 10, sr * 0.45); this.g = Math.tan(Math.PI * f / sr); this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k)); this.a2 = this.g * this.a1; this.a3 = this.g * this.a2;
  }
  run(v0) {
    const v3 = v0 - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.hp = v0 - this.k * v1 - v2; return v2;
  }
}

// ---------------------------------------------------------------- SHRED (un canal)
const HIST = 32;
class ShredChannel {
  constructor(seed) {
    this.buf = new Float32Array(BUF_N); this.rng = new Rng(seed);
    this.hs = new Float64Array(HIST); this.hl = new Float64Array(HIST); this.reset();
  }
  reset() {
    this.buf.fill(0); this.w = 0; this.prev = 0; this.quiet = 0; this.colStart = 0; this.ws = 0;
    this.hHead = 0; this.hCount = 0; this.env = 0;
    this.playing = false; this.cs = 0; this.cl = 0; this.pos = 0; this.g = 1; this.hasCur = false;
    this.dream = 1; this.gate = 1; this.newCol = false;
  }
  push(start, len) { this.hs[this.hHead] = start; this.hl[this.hHead] = len; this.hHead = (this.hHead + 1) % HIST; if (this.hCount < HIST) this.hCount++; }
  valid(k) { return this.w - this.hs[k] < BUF_N - 4; }
  // escribe una muestra de entrada y cierra colecciones
  record(x, P, sr) {
    this.buf[this.w & BUF_MASK] = x;
    const ax = Math.abs(x); this.env = ax > this.env ? ax : this.env * P.envDecay;
    const silent = this.env < 0.001;
    this.quiet = silent ? this.quiet + 1 : 0;
    // sin Sustain, tras 0,2 s de silencio se olvida la memoria y el proceso se calla (salvo Freeze)
    if (!P.sustain && !P.freeze && this.quiet === P.forgetN) { this.hCount = 0; this.hasCur = false; }
    const hold = P.sustain && silent;                     // Sustain: sin entrada, no se graba nada nuevo
    if (hold) { this.colStart = this.w + 1; this.ws = 0; }
    else {
      const cross = this.prev < 0 && x >= 0;
      const len = this.w - this.colStart;
      if (cross) this.ws++;
      if ((cross && this.ws >= P.length && len >= P.floorN) || len >= P.maxN) {
        if (len > 0) {
          if (this.rng.next() >= P.stuck) this.push(this.colStart, len);
        }
        this.colStart = this.w; this.ws = 0;
      }
    }
    this.prev = x; this.w++;
  }
  pick(P) {
    let same = false;
    if (this.hasCur) {
      if (P.freeze) same = true;
      else if (this.rng.next() < P.repeat) same = true;
    }
    if (!same) {
      if (this.hCount === 0) { this.hasCur = false; return false; }
      let k = (this.hHead - 1 + HIST) % HIST;               // la más reciente
      if (this.rng.next() < P.disorder) {
        const j = Math.floor(this.rng.next() * this.hCount);
        const kk = (this.hHead - 1 - j + 2 * HIST) % HIST;
        if (this.valid(kk)) k = kk;
      }
      this.cs = this.hs[k]; this.cl = this.hl[k]; this.hasCur = true;
    }
    // Absence: izquierda = volumen aleatorio, derecha = silencio aleatorio
    const a = P.absence;
    if (a < 0) this.g = 1 + a * this.rng.next();
    else if (a > 0) this.g = this.rng.next() < a ? 0 : 1;
    else this.g = 1;
    this.pos = 0; this.playing = true; this.newCol = true;
    return true;
  }
  play(P) {
    if (!this.playing && !this.pick(P)) return 0;
    if (this.pos >= this.cl && !this.pick(P)) return 0;
    const p = this.pos, i = Math.floor(p), fr = p - i;
    const a = this.buf[(this.cs + i) & BUF_MASK], b = this.buf[(this.cs + i + 1) & BUF_MASK];
    let y = (a + (b - a) * fr) * this.g;
    if (P.envOn) { const s = Math.sin(Math.PI * p / this.cl); y *= s * s; }
    this.pos += P.rate;
    if (this.pos >= this.cl) this.playing = false;
    return y;
  }
}

class Shred {
  constructor(sr) { this.sr = sr; this.ch = [new ShredChannel(0x1234567), new ShredChannel(0x89ABCDE)]; this.drng = new Rng(0x5EED5); this.P = {}; }
  reset() { for (const c of this.ch) c.reset(); this.drng = new Rng(0x5EED5); }
  set(p) {
    const sr = this.sr, P = this.P;
    P.length = Math.round(p.sLength); P.floorN = Math.round(FLOOR_MS[clamp(Math.round(p.sFloor), 0, 3)] * 0.001 * sr);
    P.maxN = Math.round(sr * 0.75); P.stuck = p.sStuck; P.envOn = p.sEnv >= 0.5; P.disorder = p.sDisorder;
    P.rate = Math.pow(2, p.sRate / 12); P.absence = p.sAbsence; P.repeat = p.sRepeat; P.freeze = p.sFreeze >= 0.5;
    P.sustain = p.sSustain >= 0.5; P.forgetN = Math.round(0.2 * sr); P.envDecay = Math.exp(-1 / (0.05 * sr));
    P.dream = p.sDream; P.sync = p.sSync >= 0.5; P.lean = p.sLean;
    P.smooK = p.sSmoo <= 0 ? 1 : 1 - Math.exp(-1 / (p.sSmoo * 0.06 * sr));
    P.srcLvl = Math.min(1, 2 * (1 - p.sMonitor)); P.prcLvl = Math.min(1, 2 * p.sMonitor);
  }
  run(L, R, n) {
    const P = this.P, c0 = this.ch[0], c1 = this.ch[1];
    const pL = P.dream * Math.min(1, 1 - P.lean), pR = P.dream * Math.min(1, 1 + P.lean);
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      c0.record(xl, P, this.sr); c1.record(xr, P, this.sr);
      c0.newCol = false; c1.newCol = false;
      const yl = c0.play(P), yr = c1.play(P);
      // Dream: en cada colección nueva se sortea si suena el proceso o la fuente
      if (c0.newCol) c0.dream = this.drng.next() < pL ? 1 : 0;
      if (P.sync) { if (c0.newCol) c1.dream = c0.dream; }
      else if (c1.newCol) c1.dream = this.drng.next() < pR ? 1 : 0;
      c0.gate += (c0.dream - c0.gate) * P.smooK; c1.gate += (c1.dream - c1.gate) * P.smooK;
      L[i] = xl * P.srcLvl * (1 - c0.gate) + yl * P.prcLvl * c0.gate;
      R[i] = xr * P.srcLvl * (1 - c1.gate) + yr * P.prcLvl * c1.gate;
    }
  }
  leds() { return [this.ch[0].gate, this.ch[1].gate]; }
}

// ---------------------------------------------------------------- HAZE (un canal)
const GRAINS = 4;
class HazeChannel {
  constructor(seed) { this.buf = new Float32Array(BUF_N); this.rng = new Rng(seed); this.lo = new Biquad(); this.hi = new Biquad(); this.reset(); }
  reset() {
    this.buf.fill(0); this.wp = 0; this.ef = 0; this.es = 0; this.nz = 0;
    this.gs = new Float64Array(GRAINS); this.gp = new Float64Array(GRAINS); this.gl = 0;
    this.lo.x1 = this.lo.x2 = this.lo.y1 = this.lo.y2 = 0; this.hi.x1 = this.hi.x2 = this.hi.y1 = this.hi.y2 = 0;
    this.started = false;
  }
  run(x, P) {
    // Raw apagado: se suavizan los transitorios de la entrada (seguidor de envolvente)
    if (!P.raw) {
      const a = Math.abs(x);
      this.ef += (a - this.ef) * (a > this.ef ? P.kf1 : P.kf2);
      this.es += (a - this.es) * P.ks;
      x *= this.ef > 1e-9 ? Math.min(1, this.es / this.ef) : 1;
    }
    const S = P.S;
    if (this.wp >= S) this.wp = 0;
    if (!P.freeze) this.buf[this.wp] = this.buf[this.wp] * P.mem + x * (1 - P.mem);
    this.wp++;
    // granos con ventana de Hann, 4 voces escalonadas
    const gl = P.gl;
    if (!this.started) { for (let v = 0; v < GRAINS; v++) { this.gs[v] = this.rng.next() * S; this.gp[v] = gl * v / GRAINS; } this.started = true; }
    let y = 0;
    for (let v = 0; v < GRAINS; v++) {
      if (this.gp[v] >= gl) { this.gp[v] -= gl; this.gs[v] = this.rng.next() * S; }
      const ph = this.gp[v];
      let r = this.gs[v] + ph * P.rate; r -= Math.floor(r / S) * S;
      const i = Math.floor(r), fr = r - i, i2 = i + 1 >= S ? 0 : i + 1;
      const s = this.buf[i] + (this.buf[i2] - this.buf[i]) * fr;
      const w = Math.sin(Math.PI * ph / gl);
      y += s * w * w;
      this.gp[v] = ph + 1;
    }
    y *= 0.5;
    // Temperature: saturación y, en la mitad alta, modulación de amplitud con ruido
    if (P.temp > 0) {
      const d = 1 + 6 * P.temp;
      y = Math.tanh(y * d) / (1 + 1.5 * P.temp);
      if (P.temp > 0.5) {
        this.nz += ((this.rng.next() * 2 - 1) - this.nz) * P.kn;
        const k = (P.temp - 0.5) * 1.8;
        y *= 1 - k * (0.5 + 0.5 * clamp(this.nz * 4, -1, 1));
      }
    }
    return this.hi.run(this.lo.run(y));
  }
}

class Haze {
  constructor(sr) { this.sr = sr; this.ch = [new HazeChannel(0x2468ACE), new HazeChannel(0x13579BD)]; this.P = {}; this.eq = null; }
  reset() { for (const c of this.ch) c.reset(); }
  set(p) {
    const sr = this.sr, P = this.P;
    P.raw = p.hRaw >= 0.5; P.mem = p.hFreeze >= 0.5 ? 1 : p.hMemory; P.freeze = p.hFreeze >= 0.5;
    P.S = clamp(Math.round(p.hSize * 0.001 * sr), 64, BUF_N - 1);
    P.gl = clamp(Math.round(P.S * 0.5), Math.round(0.01 * sr), Math.round(0.25 * sr));
    P.rate = Math.pow(2, p.hRate / 12); P.temp = p.hTemp;
    P.kf1 = 1 - Math.exp(-1 / (0.0005 * sr)); P.kf2 = 1 - Math.exp(-1 / (0.03 * sr)); P.ks = 1 - Math.exp(-1 / (0.025 * sr));
    P.kn = 1 - Math.exp(-TAU * 40 / sr);
    P.width = p.hWidth; P.wet = p.hWet; P.dry = p.hDry;
    const eq = p.hLo + '|' + p.hHi;
    if (eq !== this.eq) { this.eq = eq; for (const c of this.ch) { c.lo.shelf(sr, 250, p.hLo, false); c.hi.shelf(sr, 3500, p.hHi, true); } }
  }
  run(L, R, n) {
    const P = this.P, c0 = this.ch[0], c1 = this.ch[1];
    for (let i = 0; i < n; i++) {
      let l = c0.run(L[i], P), r = c1.run(R[i], P);
      const m = 0.5 * (l + r), s = 0.5 * (l - r) * P.width;
      l = m + s; r = m - s;
      L[i] = L[i] * P.dry + l * P.wet; R[i] = R[i] * P.dry + r * P.wet;
    }
  }
}

// ---------------------------------------------------------------- SPLIT
const AP_MS = [3.2, 2.4, 8.6, 6.3];
class SplitChannel {
  constructor(seed, sr) {
    this.rng = new Rng(seed); this.sr = sr;
    this.lpg = new Svf(); this.cutA = new Svf(); this.cutB = new Svf();
    this.dl = new Float32Array(4096); this.apN = AP_MS.map(ms => Math.round(ms * 0.001 * sr));
    this.ap = this.apN.map(n => new Float32Array(n)); this.reset();
  }
  reset() {
    this.pk = 0; this.es = 0; this.g = 0; this.burst = 0; this.act = 0;
    for (const f of [this.lpg, this.cutA, this.cutB]) { f.ic1 = 0; f.ic2 = 0; }
    this.dl.fill(0); this.dw = 0; this.lfo = 0; this.lfoT = 0; this.lfoC = 0;
    for (const a of this.ap) a.fill(0); this.apI = [0, 0, 0, 0];
  }
  detect(x, P) {   // envolvente sobre el umbral (0..1) con Retain
    const a = Math.abs(x) * P.boost;
    this.pk = a > this.pk ? a : this.pk * P.pkRel;
    this.es += (this.pk - this.es) * P.ks;
    const db = 20 * Math.log10(this.es + 1e-12);
    let g = clamp((db - P.verge) / 24, 0, 1);
    if (g > 0.05) this.act = P.actN;
    else if (this.act > 0) this.act--;
    if (P.retain > 0 && this.act > 0 && this.rng.next() < P.burstP) this.burst = Math.max(this.burst, this.rng.next() * P.retain);
    this.burst *= P.burstDecay;
    this.g = g > this.burst ? g : this.burst;
  }
  above(x, g, P, upd) {
    if (upd) this.lpg.set(this.sr, 60 * Math.pow(2, g * 8.3), 0.8);
    let y = this.lpg.run(x) * Math.min(1, g * 4);
    if (P.driveA > 0) { const k = 1 + 15 * P.driveA; y = Math.tanh(y * k) / (1 + 2 * P.driveA); }
    if (P.cutA > 0) { this.cutA.run(y); y = this.cutA.hp; }
    return y * P.volA;
  }
  below(x, g, gs, P, upd) {
    let y = x * (1 - Math.min(1, g * (1 + 15 * P.side)));
    // Drift: retardo corto aleatorio (inestabilidad de afinación)
    this.dl[this.dw & 4095] = y;
    if (P.drift > 0) {
      if (--this.lfoC <= 0) { this.lfoC = P.lfoN; this.lfoT = this.rng.next(); }
      this.lfo += (this.lfoT - this.lfo) * P.lfoK;
      const d = P.drift * (P.d0 + P.d1 * this.lfo);
      const r = this.dw - d, i = Math.floor(r), fr = r - i;
      const a = this.dl[i & 4095], b = this.dl[(i + 1) & 4095];
      y = a + (b - a) * fr;
    }
    this.dw++;
    // Melt: difusión con 4 pasatodos
    if (P.melt > 0) {
      let z = y;
      for (let k = 0; k < 4; k++) {
        const buf = this.ap[k], j = this.apI[k], v = buf[j];
        const u = z + 0.7 * v; buf[j] = u; z = v - 0.7 * u;
        this.apI[k] = j + 1 >= this.apN[k] ? 0 : j + 1;
      }
      y = y * (1 - P.melt) + z * P.melt;
    }
    if (P.driveB > 0) { const k = 1 + 15 * P.driveB; y = Math.tanh(y * k) / (1 + 2 * P.driveB); }
    if (P.cutB > 0) y = this.cutB.run(y);
    return y * P.volB;
  }
}

class Split {
  constructor(sr) { this.sr = sr; this.ch = [new SplitChannel(0x3C6EF37, sr), new SplitChannel(0x0BB67AE, sr)]; this.P = {}; this.cnt = 0; }
  reset() { for (const c of this.ch) c.reset(); this.cnt = 0; }
  set(p) {
    const sr = this.sr, P = this.P;
    P.mode = Math.round(p.xMode); P.verge = p.xVerge; P.boost = dbToGain(p.xBoost);
    P.pkRel = Math.exp(-1 / (0.05 * sr)); P.ks = 1 - Math.exp(-1 / (p.xSmooth * 0.001 * sr));
    P.retain = p.xRetain; P.actN = Math.round(sr * 1.0); P.burstP = 20 / sr * (0.3 + p.xRetain);
    P.burstDecay = Math.exp(-1 / (0.06 * sr));
    P.driveA = p.xDriveA; P.cutA = p.xCutA; P.volA = p.xVolA; P.side = p.xSide;
    P.drift = p.xDrift; P.melt = p.xMelt; P.driveB = p.xDriveB; P.cutB = p.xCutB; P.volB = p.xVolB;
    P.lfoN = Math.round(0.08 * sr); P.lfoK = 1 - Math.exp(-1 / (0.04 * sr)); P.d0 = 0.003 * sr; P.d1 = 0.010 * sr;
    const fa = 20 * Math.pow(150, p.xCutA), fb = 20000 * Math.pow(0.015, p.xCutB);
    for (const c of this.ch) { c.cutA.set(sr, fa, 0.707); c.cutB.set(sr, fb, 0.707); }
  }
  run(L, R, n) {
    const P = this.P, c0 = this.ch[0], c1 = this.ch[1];
    for (let i = 0; i < n; i++) {
      const xl = L[i], xr = R[i];
      c0.detect(xl, P); c1.detect(xr, P);
      let gl = c0.g, gr = c1.g;
      if (P.mode === 1) { const t = gl; gl = gr; gr = t; }
      else if (P.mode === 2) { gl = gr = 0.5 * (gl + gr); }
      const upd = (this.cnt++ & 31) === 0;
      L[i] = c0.above(xl, gl, P, upd) + c0.below(xl, gl, 0, P, upd);
      R[i] = c1.above(xr, gr, P, upd) + c1.below(xr, gr, 0, P, upd);
    }
  }
  leds() { return [this.ch[0].g, this.ch[1].g]; }
}

// ---------------------------------------------------------------- cadena completa
class Engine {
  constructor(sr) {
    this.sr = sr; this.shred = new Shred(sr); this.haze = new Haze(sr); this.split = new Split(sr);
    this.p = defaults(); this.dirty = true;
    this.gIn = 1; this.gOut = 1; this.gMix = 1; this.kSm = 1 - Math.exp(-1 / (0.02 * sr));
    this.dL = new Float32Array(0); this.dR = new Float32Array(0); this.first = true;
  }
  setParams(obj) { for (const k in obj) if (k in this.p) { const v = +obj[k]; if (isFinite(v)) this.p[k] = v; } this.dirty = true; }
  setParam(k, v) { if (k in this.p && isFinite(+v)) { this.p[k] = +v; this.dirty = true; } }
  reset() { this.shred.reset(); this.haze.reset(); this.split.reset(); this.first = true; }
  // procesa n muestras en sitio (L, R: Float32Array o Float64Array)
  process(L, R, n) {
    const p = this.p;
    if (this.dirty) { this.shred.set(p); this.haze.set(p); this.split.set(p); this.dirty = false; }
    if (this.dL.length < n) { this.dL = new Float32Array(n); this.dR = new Float32Array(n); }
    const tIn = dbToGain(p.inputDb), tOut = dbToGain(p.outputDb), tMix = p.mix, k = this.kSm;
    if (this.first) { this.gIn = tIn; this.gOut = tOut; this.gMix = tMix; this.first = false; }
    let gi = this.gIn;
    for (let i = 0; i < n; i++) { gi += (tIn - gi) * k; L[i] *= gi; R[i] *= gi; this.dL[i] = L[i]; this.dR[i] = R[i]; }
    this.gIn = gi;
    const ord = ORDERS[clamp(Math.round(p.order), 0, 5)];
    for (let j = 0; j < 3; j++) {
      const m = ord[j];
      if (m === 0 && p.sOn >= 0.5) this.shred.run(L, R, n);
      else if (m === 1 && p.hOn >= 0.5) this.haze.run(L, R, n);
      else if (m === 2 && p.xOn >= 0.5) this.split.run(L, R, n);
    }
    let gm = this.gMix, go = this.gOut;
    for (let i = 0; i < n; i++) {
      gm += (tMix - gm) * k; go += (tOut - go) * k;
      let l = (this.dL[i] * (1 - gm) + L[i] * gm) * go, r = (this.dR[i] * (1 - gm) + R[i] * gm) * go;
      if (!(l === l) || !(r === r)) { l = 0; r = 0; }   // NaN → 0
      L[i] = l; R[i] = r;
    }
    this.gMix = gm; this.gOut = go;
  }
  leds() {   // actividad para la interfaz: [shredL, shredR, splitL, splitR]
    const a = this.p.sOn >= 0.5 ? this.shred.leds() : [0, 0], b = this.p.xOn >= 0.5 ? this.split.leds() : [0, 0];
    return [a[0], a[1], b[0], b[1]];
  }
}

// procesado offline de un archivo completo (para las apps web)
function processBuffers(chans, sr, params, opts) {
  opts = opts || {};
  const n = chans[0].length, L = new Float32Array(chans[0]), R = new Float32Array(chans[1] || chans[0]);
  const e = new Engine(sr); e.setParams(params || {});
  const B = 512;
  const tail = Math.round((opts.tail || 0) * sr);
  const N = n + tail, oL = new Float32Array(N), oR = new Float32Array(N);
  oL.set(L); oR.set(R);
  for (let o = 0; o < N; o += B) {
    const m = Math.min(B, N - o);
    e.process(oL.subarray(o, o + m), oR.subarray(o, o + m), m);
  }
  return [oL, oR];
}

// código del AudioWorkletProcessor (se registra con registerWorklet() o como texto con workletSource())
function installProcessor(scope) {
  scope.registerProcessor('glitchhead', class extends scope.AudioWorkletProcessor {
    constructor() {
      super(); this.e = new Engine(scope.sampleRate); this.on = true; this.t = 0;
      this.port.onmessage = ev => {
        const d = ev.data || {};
        if (d.params) this.e.setParams(d.params);
        if (d.reset) this.e.reset();
        if ('bypass' in d) this.on = !d.bypass;
      };
    }
    process(ins, outs) {
      const i = ins[0], o = outs[0]; if (!o || !o[0]) return true;
      const n = o[0].length, L = o[0], R = o[1] || o[0];
      if (i && i[0]) { L.set(i[0]); if (o[1]) R.set(i[1] || i[0]); } else { L.fill(0); if (o[1]) R.fill(0); }
      if (this.on) this.e.process(L, o[1] ? R : new Float32Array(L), n);
      if ((this.t += n) >= 2048) { this.t = 0; this.port.postMessage({ leds: this.e.leds() }); }
      return true;
    }
  });
}

const api = { VERSION: '1.0.0', PARAMS, PRESETS, ORDERS, FLOOR_MS, defaults, Engine, Rng, processBuffers, installProcessor };
// texto autocontenido para crear el módulo del worklet desde un Blob (apps de un solo archivo)
api.engineSource = function () { return 'var __GH = (' + factory.toString() + ')();\n'; };
api.workletSource = function () { return api.engineSource() + '__GH.installProcessor(globalThis);\n'; };
return api;
});
