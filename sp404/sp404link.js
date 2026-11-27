/* Copiado de TonoPad v15.00 (repo Tono-Pad, GPL-3.0) para SampledHead App 1.81: mismo código, no cambiar aquí sin cambiar allí. */
/* TonoPad · sp404link.js — conexión por cable con la Roland SP-404MKII (v15.00).
   Protocolo tomado de la especificación libre de SparkyMK2 (github.com/TuscanPL/SparkyMK2, docs/re, GPL-3.0):
   puerto serie USB CDC-ACM 0582:02E7 a 921600 baudios; canal 5 = control y parámetros, canal 6 = ficheros.
   Transportes: APK de SampledHead (window.SHUsb), Web Serial (Chrome/Edge de escritorio) y WebUSB (Chrome Android).
   Uso: var d = await TP.sp404.connect(log); await d.status(); await d.importSmp(pad, smp, nombre); await d.close(); */
(function (root) {
  'use strict';
  var TP = root.TP = root.TP || {};
  var VID = 0x0582, PID = 0x02E7, BAUD = 921600;
  var CH_CTRL = 5, CH_FILE = 6, ROOT = '/SP404REMOTE//', CHUNK = 0x5000, BATCH = 15, BULK_READ = 0x20000;

  /* ---------------- MD5 (para la cabecera .SMP: MD5 de los bytes 4–19) ---------------- */
  function md5(bytes) {
    var K = [], S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21], i;
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    var n = bytes.length, len = ((n + 8) >> 6) + 1, w = new Uint32Array(len * 16);
    for (i = 0; i < n; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
    w[n >> 2] |= 0x80 << ((n % 4) * 8); w[len * 16 - 2] = (n * 8) >>> 0; w[len * 16 - 1] = Math.floor(n / 536870912);
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var bl = 0; bl < len; bl++) {
      var A = a0, B = b0, C = c0, D = d0;
      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        var s = S[(i >> 4) * 4 + (i % 4)], t = (A + F + K[i] + w[bl * 16 + g]) >>> 0;
        A = D; D = C; C = B; B = (B + ((t << s) | (t >>> (32 - s)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out = new Uint8Array(16), v = [a0, b0, c0, d0];
    for (i = 0; i < 16; i++) out[i] = (v[i >> 2] >>> ((i % 4) * 8)) & 255;
    return out;
  }

  /* ---------------- .SMP: cabecera de 512 bytes + PCM 16 bit big-endian ---------------- */
  function smpHeader(pcmBytes, channels) {
    var h = new Uint8Array(512), dv = new DataView(h.buffer), seed = (Date.now() ^ 0x404) >>> 0;
    dv.setUint32(0, 0x52465756); dv.setUint32(4, pcmBytes + 504); dv.setUint32(8, 48000); dv.setUint32(12, channels); dv.setUint32(16, 16);
    h.set(md5(h.subarray(4, 20)), 0x20);
    for (var i = 0x30; i < 512; i++) { seed = (seed * 1103515245 + 12345) >>> 0; h[i] = seed >>> 24; }   // relleno (la app oficial pone rand())
    return h;
  }
  /* Float32 L/R (48 kHz) → .SMP estéreo. Con dither TPDF, como TP.smpFile. */
  function smpFromFloat(L, R) {
    var n = L.length, out = new Uint8Array(512 + n * 4), dv = new DataView(out.buffer), seed = 7777;
    function tpdf() { seed = (seed * 1664525 + 1013904223) >>> 0; var a = seed / 4294967296; seed = (seed * 1664525 + 1013904223) >>> 0; return a - seed / 4294967296; }
    function q(v) { var x = Math.round(v * 32767 + tpdf()); return x > 32767 ? 32767 : x < -32768 ? -32768 : x; }
    out.set(smpHeader(n * 4, 2), 0);
    for (var i = 0, o = 512; i < n; i++, o += 4) { dv.setInt16(o, q(L[i])); dv.setInt16(o + 2, q(R ? R[i] : L[i])); }
    return out;
  }
  /* .SMP → { sr, channels, L, R } (Float32) */
  function smpParse(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 512 || dv.getUint32(0) !== 0x52465756) throw new Error('No es un archivo .SMP de la SP-404MKII');
    var sr = dv.getUint32(8) || 48000, ch = dv.getUint32(12) || 2, frames = Math.floor((u8.length - 512) / (2 * ch)), L = new Float32Array(frames), R = new Float32Array(frames);
    for (var i = 0, o = 512; i < frames; i++) { L[i] = dv.getInt16(o) / 32768; o += 2; if (ch > 1) { R[i] = dv.getInt16(o) / 32768; o += 2 * (ch - 1); } else R[i] = L[i]; }
    return { sr: sr, channels: ch, L: L, R: R };
  }
  /* Cambia la altura de un .SMP por remuestreo (más agudo = más corto), para notas fuera de ±12 del Pitch de la 404 */
  function smpShift(u8, semis) {
    var a = smpParse(u8), r = Math.pow(2, semis / 12), n = Math.max(1, Math.floor(a.L.length / r)), L = new Float32Array(n), R = new Float32Array(n);
    for (var k = 0; k < n; k++) { var q = k * r, q0 = Math.floor(q), f = q - q0, q1 = Math.min(a.L.length - 1, q0 + 1); L[k] = a.L[q0] * (1 - f) + a.L[q1] * f; R[k] = a.R[q0] * (1 - f) + a.R[q1] * f; }
    return smpFromFloat(L, R);
  }

  /* ---------------- tramas ---------------- */
  function msgShort(ch, payload) {
    var m = new Uint8Array(12); m[0] = 0x12; m[1] = 0x60; m[2] = 0xE0; m[3] = ch;
    m.set(payload, 4); m[11] = payload.length; return m;
  }
  function msgLong(ch, payload) {
    var m = new Uint8Array(16 + payload.length), dv = new DataView(m.buffer);
    m[0] = 0x13; m[1] = 0x60; m[2] = 0xE0; m[3] = ch; dv.setUint32(12, payload.length, true); m.set(payload, 16); return m;
  }
  function Decoder() { this.buf = new Uint8Array(0); }
  Decoder.prototype.push = function (b) { var n = new Uint8Array(this.buf.length + b.length); n.set(this.buf); n.set(b, this.buf.length); this.buf = n; };
  Decoder.prototype.next = function () {
    for (;;) {
      var b = this.buf; if (!b.length) return null;
      var kind = b[0], total;
      if (kind === 0x12) total = 12;
      else if (kind === 0x13) { if (b.length < 16) return null; var len = (b[12] | b[13] << 8 | b[14] << 16 | b[15] << 24) >>> 0; if (len > (1 << 24)) { this.buf = b.subarray(1); continue; } total = 16 + len; }
      else { var j = 1; while (j < b.length && b[j] !== 0x12 && b[j] !== 0x13) j++; this.buf = b.subarray(j); continue; }
      if (b.length < total) return null;
      var f = b.slice(0, total); this.buf = b.subarray(total);
      var payload = kind === 0x12 ? f.slice(4, 4 + Math.min(7, f[11])) : f.slice(16);
      return { ch: f[3], short: kind === 0x12, p: payload };
    }
  };

  /* ---------------- septetos (enteros de la API de ficheros) ---------------- */
  function sept(v, flags) {                      // i32 → 5 bytes (35 bits con signo extendido), big-endian
    var hi = v < 0 ? 0x7 : 0, lo = v >>> 0, o = new Uint8Array(5);
    o[0] = ((hi << 4) | (lo >>> 28)) & 0x7f; o[1] = (lo >>> 21) & 0x7f; o[2] = (lo >>> 14) & 0x7f; o[3] = (lo >>> 7) & 0x7f; o[4] = lo & 0x7f;
    if (flags) o[0] |= flags; return o;
  }
  function unsept(b, at) {
    var lo = ((b[at] & 0x0f) << 28 | b[at + 1] << 21 | b[at + 2] << 14 | b[at + 3] << 7 | b[at + 4]) >>> 0;
    return { u: lo, i: lo | 0, last: (b[at] & 0x40) !== 0 };
  }
  function cat() { var n = 0, i; for (i = 0; i < arguments.length; i++) n += arguments[i].length; var o = new Uint8Array(n), k = 0; for (i = 0; i < arguments.length; i++) { o.set(arguments[i], k); k += arguments[i].length; } return o; }
  function pathBytes(p) { var s = p.indexOf(ROOT) === 0 ? p : p.indexOf('SD:') === 0 ? '/' + p.slice(3).replace(/^[\/\\]+/, '') : ROOT + '/' + p.replace(/^[\/\\]+/, ''); var o = new Uint8Array(s.length + 1); for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0x7f; return o; }
  function freq(op, first, second, tail) { return cat([0xF0, 0x41, 0x7A, 0x03, op], first, second, tail, [0xF7]); }
  function fpath(op, first, path) { var pb = pathBytes(path); return freq(op, sept(first), sept(pb.length), pb); }
  function fhandle(op, h, arg) { return freq(op, sept(h), arg, [0]); }
  function parseFile(p) {
    if (p.length < 5 || p[0] !== 0xF0 || p[1] !== 0x41 || p[2] !== 0x7A) return null;
    var cmd = p[3];
    if (cmd === 0x7A) return { status: true, result: unsept(p, 4).i, extra: unsept(p, 9).i };
    if (cmd === 0x02) { var s2 = unsept(p, 9), len = s2.u; return { data: p.slice(14, 14 + len), handle: unsept(p, 4).i, last: s2.last }; }
    return { other: cmd };
  }
  function u16(v) { return [v & 255, (v >> 8) & 255]; }
  function i32le(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
  function rd32(p, at) { return (p[at] | p[at + 1] << 8 | p[at + 2] << 16 | p[at + 3] << 24) >>> 0; }
  function b64e(u8) { var s = '', i; for (i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function b64d(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var ERR = ['Success', 'Error', 'Media Full', 'Media Protect', 'Media Error', 'Unsupported Format', 'Media Unformatted', 'Media Damaged', 'Media Ejected', 'Media Busy', 'Too Long Rec', 'Invalid Format', 'Invalid Path', 'Cancelled', 'Not Found', 'Open Error', 'Read Error', 'Write Error', 'Duplicate Name', 'Not Found Empty Pad', 'Invalid Filename', 'Already Installed', 'Update Wave Info', 'Update Exp Info', 'Exp Check Wave', 'Exp Check Exp', 'Exp Slot Full', 'Memory Full (memoria llena)', 'Memory Fragmentation', 'Hash Check', 'Error', 'Too Short Sample (muestra demasiado corta)', 'License Error', 'Too Long Sample (muestra demasiado larga)', 'Kbd Sample Full', 'No Chop Points', 'BPM Detect Error', 'KEY Detect Error', 'BANK Protected (banco protegido)', 'One or more BANK Protected', 'Some IMPORT errors', 'Error', 'Import Error', 'Sampling Error', 'BPM Detect Error', 'Process Completed'];
  function errText(code) { return code === -1 ? 'Error' : code >= -128 && code <= -90 ? ERR[code + 130] || ('error ' + code) : 'error ' + code; }

  /* ---------------- transportes ---------------- */
  // Cada uno: { kind, write(u8) → Promise, close() → Promise, onData = fn(u8), onClose = fn(motivo) }
  function viaAndroid() {
    var U = root.SHUsb;
    return new Promise(function (res, rej) {
      var t = { kind: 'APK (USB del teléfono)', onData: null, onClose: null };
      var prev = root.__shUsbEv;
      root.__shUsbEv = function (type, text) {
        if (type === 'open') { if (text === 'ok') res(t); else rej(new Error(text)); }
        else if (type === 'data') { if (t.onData) t.onData(b64d(text)); }
        else if (type === 'closed') { if (t.onClose) t.onClose(text); }
        else if (prev) prev(type, text);
      };
      t.write = function (u8) { return Promise.resolve().then(function () { for (var i = 0; i < u8.length; i += 0x6000) if (!U.write(b64e(u8.subarray(i, i + 0x6000)))) throw new Error('No se pudo enviar por USB (¿se ha desconectado la SP?)'); }); };
      t.close = function () { try { U.close(); } catch (e) { } return Promise.resolve(); };
      try { U.open(VID, PID, BAUD); } catch (e) { rej(e); }
    });
  }
  async function viaSerial() {
    var ports = await navigator.serial.getPorts(), port = ports.filter(function (p) { var i = p.getInfo ? p.getInfo() : {}; return i.usbVendorId === VID && i.usbProductId === PID; })[0];
    if (!port) port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VID, usbProductId: PID }] });
    await port.open({ baudRate: BAUD, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 1 << 20 });
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (e) { }
    var t = { kind: 'Web Serial', onData: null, onClose: null }, writer = port.writable.getWriter(), reader = port.readable.getReader(), alive = true;
    (async function () {
      try { for (;;) { var r = await reader.read(); if (r.done) break; if (r.value && t.onData) t.onData(r.value); } }
      catch (e) { if (alive && t.onClose) t.onClose('Se ha cortado la conexión: ' + (e.message || e)); }
    })();
    t.write = function (u8) { return writer.write(u8); };
    t.close = async function () { alive = false; try { await reader.cancel(); } catch (e) { } try { reader.releaseLock(); } catch (e) { } try { writer.releaseLock(); } catch (e) { } try { await port.close(); } catch (e) { } };
    return t;
  }
  async function viaWebUsb() {
    var devs = await navigator.usb.getDevices(), d = devs.filter(function (x) { return x.vendorId === VID && x.productId === PID; })[0];
    if (!d) d = await navigator.usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
    await d.open(); if (!d.configuration) await d.selectConfiguration(1);
    var comm = null, data = null, epIn = 0, epOut = 0;
    d.configuration.interfaces.forEach(function (it) { var al = it.alternates[0]; if (al.interfaceClass === 2 && !comm) comm = it; if (al.interfaceClass === 10 && !data) { data = it; al.endpoints.forEach(function (e) { if (e.type === 'bulk') { if (e.direction === 'in') epIn = e.endpointNumber; else epOut = e.endpointNumber; } }); } });
    if (!data) throw new Error('No se encuentra el puerto serie de la SP en el USB');
    if (comm) { try { await d.claimInterface(comm.interfaceNumber); } catch (e) { } }
    await d.claimInterface(data.interfaceNumber);
    var idx = comm ? comm.interfaceNumber : 0;
    await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: idx }, new Uint8Array([BAUD & 255, (BAUD >> 8) & 255, (BAUD >> 16) & 255, 0, 0, 0, 8]));
    await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 3, index: idx });
    var t = { kind: 'WebUSB', onData: null, onClose: null }, alive = true;
    (async function () {
      while (alive) { try { var r = await d.transferIn(epIn, 16384); if (r.data && r.data.byteLength && t.onData) t.onData(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)); } catch (e) { if (alive && t.onClose) t.onClose('Se ha cortado la conexión USB: ' + (e.message || e)); break; } }
    })();
    t.write = function (u8) { return d.transferOut(epOut, u8); };
    t.close = async function () { alive = false; try { await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0, index: idx }); } catch (e) { } try { await d.close(); } catch (e) { } };
    return t;
  }
  function available() {
    if (root.SHUsb && root.SHUsb.open) return 'apk';
    if (root.navigator && navigator.serial) return 'serial';
    if (root.navigator && navigator.usb) return 'webusb';
    return '';
  }

  /* ---------------- la SP-404MKII ---------------- */
  function Device(t, log) {
    var self = this; this.t = t; this.log = log || function () { }; this.dec = new Decoder(); this.waiters = []; this.events = []; this.closed = false;
    this.queue = Promise.resolve(); this.busy = 0; this.lastSent = Date.now(); this.onLost = null; this.state = {};
    t.onData = function (b) { self.dec.push(b); var m; while ((m = self.dec.next())) self._in(m); };
    t.onClose = function (why) { self._lost(why || 'Conexión cerrada'); };
  }
  Device.prototype._in = function (m) {
    if (m.ch === CH_CTRL && m.p[0] === 0x32 && m.p.length >= 5) {        // error de la SP (llega aparte)
      var code = rd32(m.p, 1) | 0; this.lastError = { code: code, text: errText(code), at: Date.now() }; this.log('SP error ' + code + ' ' + errText(code));
    }
    for (var i = 0; i < this.waiters.length; i++) { var w = this.waiters[i]; if (w.match(m)) { this.waiters.splice(i, 1); clearTimeout(w.timer); w.res(m); return; } }
    this.events.push(m); if (this.events.length > 64) this.events.shift();
  };
  Device.prototype._lost = function (why) {
    if (this.closed) return; this.closed = true; clearInterval(this.poller);
    this.waiters.splice(0).forEach(function (w) { clearTimeout(w.timer); w.rej(new Error(why)); });
    if (this.onLost) this.onLost(why);
  };
  Device.prototype.send = function (u8) { var self = this; if (this.closed) return Promise.reject(new Error('La SP-404MKII no está conectada')); this.lastSent = Date.now(); return this.t.write(u8).catch(function (e) { self._lost('Se ha perdido la conexión: ' + (e.message || e)); throw e; }); };
  Device.prototype.wait = function (match, ms, what) {
    var self = this;
    return new Promise(function (res, rej) {
      var w = { match: match, res: res, rej: rej }; w.timer = setTimeout(function () { var i = self.waiters.indexOf(w); if (i >= 0) self.waiters.splice(i, 1); rej(new Error('La SP-404MKII no responde (' + what + ')')); }, ms || 3000);
      self.waiters.push(w);
    });
  };
  Device.prototype.call = function (u8, match, ms, what) { var p = this.wait(match, ms, what); return this.send(u8).then(function () { return p; }); };
  Device.prototype.ctrl = function (payload, match, ms, what) {     // payload corto o largo según tamaño
    var m = payload.length <= 7 ? msgShort(CH_CTRL, payload) : msgLong(CH_CTRL, payload);
    return this.call(m, function (r) { return r.ch === CH_CTRL && match(r.p); }, ms, what).then(function (r) { return r.p; });
  };
  Device.prototype.fire = function (payload) { return this.send(payload.length <= 7 ? msgShort(CH_CTRL, payload) : msgLong(CH_CTRL, payload)); };
  Device.prototype.cmd = function (payload, expect, what) {
    return this.ctrl(payload, function (p) { return p[0] === expect; }, 3000, what).then(function (p) { if (p.length > 1 && p[1] !== 0) throw new Error(what + ': la SP responde ' + p[1]); return p; });
  };
  // una operación cada vez (importar, leer…), y el sondeo de estado solo cuando no hay ninguna
  Device.prototype.op = function (fn) { var self = this, r = this.queue.then(function () { self.busy++; return fn(); }); this.queue = r.then(function () { self.busy--; }, function () { self.busy--; }); return r; };

  // ----- estado y proyecto -----
  Device.prototype.status = function () {
    var self = this;
    return this.ctrl([0xFE, 0x66, 0x00], function (p) { return p[0] === 0x7E; }, 3000, 'estado').then(function (p) {
      self.state = { project: p[1], bank: p[3], pad: p[5], mode: p[12] || 0, menu: p[12] === 4 }; return self.state;
    });
  };
  Device.prototype.projectNames = async function (project) {
    var names = [], self = this, got = 0;
    var all = new Promise(function (res) {
      var w = { match: function (m) { if (m.ch === CH_CTRL && m.p[0] === 0x35 && m.p.length > 2) { names[m.p[1]] = TP_ascii(m.p.slice(2)); got++; } return got >= 16; }, res: res, rej: res };
      w.timer = setTimeout(function () { var i = self.waiters.indexOf(w); if (i >= 0) self.waiters.splice(i, 1); res(); }, 3000); self.waiters.push(w);
    });
    var set = await this.ctrl([0xFD, project, 0x00], function (p) { return p[0] === 0x7D && p[1] === project; }, 3000, 'ajustes del proyecto');
    await all;
    // el banco protegido: palabra 12 + banco, bit 0 (ajustes: 28 palabras LE desde el byte 3)
    var prot = []; for (var b = 0; b < 10; b++) prot[b] = (rd32(set, 3 + (12 + b) * 4) & 1) === 1;
    return { names: names, name: TP_ascii(set.slice(115, 147)), protected: prot };
  };
  function TP_ascii(u8) { var s = ''; for (var i = 0; i < u8.length; i++) { if (!u8[i]) break; s += String.fromCharCode(u8[i]); } return s.trim(); }

  // ----- pads -----
  Device.prototype.padBlock = function (pad) {
    var id = u16(pad);
    return this.ctrl([0x9E].concat(id), function (p) { return p[0] === 0x1E && p.length > 3 && p[1] === id[0] && p[2] === id[1]; }, 3000, 'pad ' + padName(pad)).then(function (p) {
      return { pad: pad, raw: p, size: rd32(p, 3), start: rd32(p, 7), end: rd32(p, 11), name: TP_ascii(p.slice(175, 199)), pitch: rd32(p, 3 + (0x73 - 0x66) * 4) | 0, gate: rd32(p, 3 + (0x6A - 0x66) * 4), has: rd32(p, 3) !== 0 };
    });
  };
  Device.prototype.bank = function (bank, onEach) {
    var self = this;
    return this.op(async function () { var out = []; for (var i = 0; i < 16; i++) { out.push(await self.padBlock(bank * 16 + i)); if (onEach) onEach(i); } return out; });
  };
  Device.prototype.setParam = function (id, target, value) {
    var pl = [0x01, id, 0x00].concat(u16(target), i32le(value)), head = pl.slice(0, 5);
    return this.ctrl(pl, function (p) { for (var i = 0; i < 5; i++) if (p[i] !== head[i]) return false; return true; }, 3000, 'ajuste ' + id.toString(16));
  };
  Device.prototype.preview = function (pad, on) {
    var id = u16(pad), self = this;
    return this.op(function () { return on ? self.cmd([0x8E].concat(id, [0x7F, 0xFF]), 0x0E, 'tocar pad').catch(function () { }) : self.cmd([0x8F].concat(id, [0x00]), 0x0F, 'parar pad').catch(function () { }); });
  };

  // ----- API de ficheros (canal 6) -----
  Device.prototype.file = function (payload, ms, what) {
    return this.call(msgLong(CH_FILE, payload), function (m) { return m.ch === CH_FILE && !m.short; }, ms || 5000, what).then(function (m) { var r = parseFile(m.p); if (!r) throw new Error('Respuesta rara de la SP (' + what + ')'); return r; });
  };
  Device.prototype.fstatus = function (payload, what, ms) { return this.file(payload, ms, what).then(function (r) { if (!r.status) throw new Error('Respuesta inesperada (' + what + ')'); if (r.result === -1) throw new Error('La SP rechaza: ' + what + (r.extra > 0 ? ' (errno ' + r.extra + ')' : '')); return r.result; }); };
  Device.prototype.fopen = function (path, flags) { return this.fstatus(fpath(0x00, flags, path), 'abrir ' + path); };
  Device.prototype.fclose = function (h, ms) { return this.fstatus(fhandle(0x03, h, sept(0)), 'cerrar', ms); };
  Device.prototype.fseek = function (h, off) { return this.fstatus(fhandle(0x07, h, sept(off)), 'posición'); };
  Device.prototype.unlink = function (path) { return this.file(fpath(0x0A, 0, path), 5000, 'borrar ' + path); };
  Device.prototype.stat = function (path) {
    return this.file(fpath(0x12, 0, path), 5000, 'stat ' + path).then(function (r) { if (r.data) return { mode: rd32(r.data, 0), size: rd32(r.data, 4) }; return null; });
  };
  Device.prototype.fwrite = async function (h, data, prog) {
    var chunks = []; for (var i = 0; i < data.length; i += CHUNK) chunks.push(data.subarray(i, Math.min(data.length, i + CHUNK)));
    var done = 0;
    for (var b = 0; b < chunks.length; b += BATCH) {
      var batch = chunks.slice(b, b + BATCH), expected = 0, self = this;
      batch.forEach(function (c) { expected += c.length; });
      var reply = this.wait(function (m) { return m.ch === CH_FILE && !m.short; }, 8000, 'escribir');
      for (var k = 0; k < batch.length; k++) await this.send(msgLong(CH_FILE, freq(0x06, sept(h), sept(batch[k].length, k === batch.length - 1 ? 0x40 : 0), batch[k])));
      var r = parseFile((await reply).p);
      if (!r || !r.status || r.result !== expected) throw new Error('La SP solo aceptó ' + (r && r.status ? r.result : '?') + ' de ' + expected + ' bytes');
      done += expected; if (prog) prog(done, data.length);
    }
  };
  Device.prototype.fread = async function (h, count) {
    var self = this, parts = [], got = 0, flags = count > CHUNK ? 0x20 : 0;
    var all = new Promise(function (res, rej) {
      var w = { match: function (m) { if (m.ch !== CH_FILE || m.short) return false; var r = parseFile(m.p); if (!r) return false; if (r.status) { if (r.result === -1) { w.err = true; return true; } return true; } parts.push(r.data); got += r.data.length; return r.last || got >= count; }, res: res, rej: rej };
      var arm = function () { clearTimeout(w.timer); w.timer = setTimeout(function () { var i = self.waiters.indexOf(w); if (i >= 0) self.waiters.splice(i, 1); rej(new Error('La SP no responde (leer)')); }, 5000); };
      var m0 = w.match; w.match = function (m) { var r = m0(m); if (!r && m.ch === CH_FILE) arm(); return r; }; arm();
      self.waiters.push(w);
    });
    await this.send(msgLong(CH_FILE, fhandle(0x04, h, sept(count, flags))));
    await all;
    return cat.apply(null, parts);
  };
  Device.prototype.readFile = function (path, prog) {
    var self = this;
    return this.op(async function () {
      var st = await self.stat(path); if (!st) throw new Error('No existe ' + path);
      var h = await self.fopen(path, 0), out = new Uint8Array(st.size), off = 0;
      try {
        while (off < st.size) { var part = await self.fread(h, Math.min(BULK_READ, st.size - off)); if (!part.length) break; out.set(part.subarray(0, st.size - off), off); off += part.length; if (prog) prog(off, st.size); }
      } finally { await self.fclose(h).catch(function () { }); }
      return off === st.size ? out : out.subarray(0, off);
    });
  };
  function padName(pad) { return 'ABCDEFGHIJ'[pad >> 4] + ((pad & 15) + 1); }
  function smpPath(project1, pad) { return 'ROLAND/SP-404MKII/PROJECT_' + ('0' + project1).slice(-2) + '/SMPL/BANK' + ((pad >> 4) + 1) + '-' + ('0' + ((pad & 15) + 1)).slice(-2) + '.SMP'; }
  Device.prototype.readPad = async function (pad, prog) { var st = await this.op(this.status.bind(this)); return this.readFile(smpPath(st.project + 1, pad), prog); };

  /* Importa un .SMP completo a un pad del proyecto ACTUAL (la misma secuencia que la app oficial, según SparkyMK2).
     opts: { gate: 0/1, pitch: −12..12, name } */
  Device.prototype.importSmp = function (pad, smp, name, opts, prog) {
    var self = this; opts = opts || {};
    return this.op(async function () {
      var st = await self.status(); if (st.menu) throw new Error('La SP está en un menú: sal del menú en la máquina y vuelve a probar');
      var path = smpPath(st.project + 1, pad), tmp = path.replace('.SMP', '.TMP');
      var block = await self.padBlock(pad);
      await self.fire([0xFB, 0xA0, 0x00]);
      try {
        await self.cmd([0x91].concat(u16(pad), [0x01, 0x00]), 0x11, 'liberar el pad');
        await self.cmd([0x9D], 0x1D, 'parar');
        await self.unlink(tmp).catch(function () { }); await self.unlink(path).catch(function () { });
        var h = await self.fopen(path, 0x602), werr = null;
        try { await self.fseek(h, 512); await self.fwrite(h, smp.subarray(512), prog); await self.fseek(h, 0); await self.fwrite(h, smp.subarray(0, 512)); }
        catch (e) { werr = e; }
        await self.fclose(h, 20000); if (werr) throw werr;
        var s2 = await self.stat(path); if (!s2 || s2.size !== smp.length) throw new Error('El archivo quedó mal en la SP (' + (s2 ? s2.size : 0) + ' de ' + smp.length + ' bytes)');
        // ficha del pad: tamaño, Start = 512, End = tamaño, Loop Top = 512, nombre
        var w = block.raw.slice(0, 199), dv = new DataView(w.buffer);
        dv.setUint32(3, smp.length, true); dv.setUint32(7, 512, true); dv.setUint32(11, smp.length, true); dv.setUint32(3 + 11 * 4, 512, true);
        w.fill(0, 175, 199); var nm = String(name || 'TonoPad').replace(/[^\x20-\x7e]/g, '').slice(0, 23); for (var i = 0; i < nm.length; i++) w[175 + i] = nm.charCodeAt(i);
        var id = u16(pad);
        await self.ctrl(Array.prototype.slice.call(w), function (p) { return p[0] === 0x1E && (p.length <= 2 || (p[1] === id[0] && p[2] === id[1])); }, 3000, 'ficha del pad');
        var c = await self.ctrl([0x9F].concat(id), function (p) { return p.length >= 4 && p[0] === 0x1F && p[1] === id[0] && p[2] === id[1]; }, 5000, 'confirmar');
        if (c[3] !== 0) throw new Error('La SP no acepta la muestra en ' + padName(pad) + ' (estado ' + c[3] + (self.lastError ? ', ' + self.lastError.text : '') + ')');
        if (opts.gate != null) await self.setParam(0x6A, pad, opts.gate ? 1 : 0);
        if (opts.pitch) await self.setParam(0x73, pad, Math.max(-12, Math.min(12, opts.pitch | 0)));
      } finally { await self.fire([0xFC, 0x00, 0x00]).catch(function () { }); }
    });
  };

  Device.prototype.close = async function () {
    if (this.closed) return; var self = this;
    clearInterval(this.poller);
    try { await this.queue; } catch (e) { }
    try { await this.cmd([0x9D], 0x1D, 'parar'); } catch (e) { }
    try { await this.fire([0x3A, 0x00, 0x00, 0x00]); } catch (e) { }   // MKII EXIT
    // SparkyMK2: cerrar el puerto en plena sesión puede bloquear la SP; se espera a que la sesión caduque (~3 s)
    var left = 3000 - (Date.now() - this.lastSent); if (left > 0) await sleep(left);
    this.closed = true; this.waiters.splice(0).forEach(function (w) { clearTimeout(w.timer); w.rej(new Error('Desconectado')); });
    await this.t.close();
  };

  async function connect(log, which) {
    var k = typeof which === 'object' && which ? 'given' : which || available(), t = typeof which === 'object' ? which : null;
    if (!k) throw new Error('Este navegador no puede usar el puerto USB. En el móvil usa el APK de SampledHead (o TonoPad); en el ordenador, Chrome o Edge.');
    if (!t) t = k === 'apk' ? await viaAndroid() : k === 'serial' ? await viaSerial() : await viaWebUsb();
    var d = new Device(t, log); d.kind = t.kind;
    await sleep(350);                                     // la app oficial espera antes del primer mensaje
    var st = null, err = null;
    for (var i = 0; i < 3 && !st; i++) { try { st = await d.status(); } catch (e) { err = e; } }
    if (!st) { try { await t.close(); } catch (e) { } throw new Error('La SP-404MKII no contesta. Comprueba que tiene el firmware 4.0 o posterior, que no esté abierta la app de Roland y vuelve a conectar. (' + (err && err.message) + ')'); }
    // sondeo cada 500 ms, como la app oficial: mantiene viva la sesión y sigue el pad que pulsas en la SP
    d.poller = setInterval(function () { if (!d.busy && !d.closed && Date.now() - d.lastSent > 400) d.op(d.status.bind(d)).then(function (s) { if (d.onStatus) d.onStatus(s); }).catch(function () { }); }, 500);
    return d;
  }

  TP.sp404 = { connect: connect, available: available, smpFromFloat: smpFromFloat, smpParse: smpParse, smpShift: smpShift, smpHeader: smpHeader, md5: md5, padName: padName, smpPath: smpPath,
    _test: { msgShort: msgShort, msgLong: msgLong, Decoder: Decoder, sept: sept, unsept: unsept, freq: freq, fpath: fpath, parseFile: parseFile, Device: Device, errText: errText } };
})(typeof window !== 'undefined' ? window : globalThis);
