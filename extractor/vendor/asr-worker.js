/* Letra con Whisper (Transformers.js) y tiempo de cada palabra. Recibe audio mono a 16 000 Hz. */
import { pipeline, env } from './transformers.min.js';
env.allowLocalModels = false;
let pipe = null, cur = '';
self.onmessage = async e => {
  const m = e.data;
  try {
    if (m.type !== 'run') return;
    const key = m.model + '|' + m.device;
    if (!pipe || cur !== key) {
      pipe = await pipeline('automatic-speech-recognition', m.model, {
        device: m.device,
        dtype: m.device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: p => { if (p && p.status === 'progress') self.postMessage({ type: 'load', file: p.file, p: (p.progress || 0) / 100 }); }
      });
      cur = key;
    }
    self.postMessage({ type: 'stage', stage: 'Transcribiendo la voz' });
    const out = await pipe(m.audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5, language: m.language || null, task: 'transcribe' });
    self.postMessage({ type: 'done', chunks: out.chunks || [], text: out.text || '' });
  } catch (err) { self.postMessage({ type: 'error', message: String(err && err.message || err), stack: String(err && err.stack || '') }); }
};
