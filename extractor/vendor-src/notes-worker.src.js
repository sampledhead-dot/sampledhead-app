/* Notas con Basic Pitch (Spotify) en el navegador. Recibe audio mono a 22 050 Hz. */
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } from '@spotify/basic-pitch';
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';
let bp = null;
self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type !== 'run') return;
    if (!bp) {
      const want = m.backend || (typeof OffscreenCanvas !== 'undefined' ? 'webgl' : 'cpu');
      let okB = false; try { okB = await tf.setBackend(want); } catch (x) { okB = false; }
      if (!okB) await tf.setBackend('cpu');
      await tf.ready();
      bp = new BasicPitch(tf.loadGraphModel(MODEL_URL));
    }
    const frames = [], onsets = [], contours = [];
    await bp.evaluateModel(m.audio, (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
      p => self.postMessage({ type: 'progress', p }));
    const ev = noteFramesToTime(addPitchBendsToNoteEvents(contours,
      outputToNotesPoly(frames, onsets, m.onset ?? 0.5, m.frame ?? 0.3, m.minFrames ?? 5, true, m.maxFreq ?? null, m.minFreq ?? null, true)));
    const notes = ev.map(n => ({ t: n.startTimeSeconds, d: n.durationSeconds, p: n.pitchMidi, v: Math.round(Math.min(1, n.amplitude) * 127) }));
    self.postMessage({ type: 'done', notes, backend: tf.getBackend() });
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err), stack: String(err && err.stack || '') }); }
};
