# SampledHead App — Hoja de proyecto (v1.70)

## Descripción
Sampler de pads en el navegador (PWA) y en Windows/Mac/Android: graba, edita, haz loops, genera bases, extrae pistas
con IA y exporta a Koala, Ableton, MPC, Move y SP-404MKII. Pestañas: Sampler, Looper, Bajo, Teclas, Mixer, FX, Gen,
**Extractor** (nueva en 1.65) y **mid-box** (nueva en 1.69: voz → batería y voz → bajo).

## Arquitectura
- `index.html` — la app (UI, motor de audio, pads `pads[64]` en bancos A–D, exportadores). `APP_VERSION` en el código.
- `sh-core.js` — base común de todas las apps (copia de `SH-apps/sh-core`; no se edita aquí): bandeja entre apps,
  «Enviar a…», modelos compartidos, motor local, WAV.
- `extractor/extractor.js` — pestaña Extractor (ver abajo). Usa funciones globales del sampler: `pads`, `sel`, `select`,
  `labels`, `resetPad`, `stop`, `nextEmpty`, `status`, `save`, `zip`, `ctx`, `bank`, `BANKS`, `audioOnsets`.
- `midbox/midbox.js` — pestaña mid-box (ver abajo). Módulo propio (IIFE) que usa globales del sampler: `ctx`, `pads`,
  `sel`, `select`, `labels`, `resetPad`, `stop`, `nextEmpty`, `status`, `save`, `region`, `sampBus`, `bassBus`, `mkBass`, `BP`,
  `BS`, `BSCALES`, `bMidi`, `lp`, `lpClear`, `lpTempoUpdate`, `lpUI`, `G`, `gSave`, `gUI`, `gGrid`, `gResizeLocked`, `gBspb`,
  `cvApply`. `showTab(8)` llama a `window.mbxShow`; al salir de la pestaña, `window.mbxHide` apaga el micro.
  API de pruebas: `window.MIDBOX`.
- `extractor/vendor/` — librerías empaquetadas (no se editan a mano):
  - `unblend.js` + `workers/` — separación en el navegador (unblend 1.0.1, onnxruntime-web 1.26; WASM desde jsDelivr).
  - `asr-worker.js` + `transformers.min.js` — Whisper con tiempo por palabra (Transformers.js 3.8.1).
  - `notes-worker.js` — Basic Pitch 1.0.1 + TensorFlow.js (notas; modelo desde jsDelivr).
  - Se regeneran con esbuild (ver «Reconstruir vendor»).
- `sw.js` — caché `sampledhead-v1.68`. **Solo borra sus propias cachés** (`sampledhead-v*`): antes borraba las de todas
  las apps del dominio y los modelos de IA.

## Extractor
Cargas un audio (archivo, pad seleccionado o bandeja), escribes qué quieres y pulsas Extraer.

| Frase | Qué hace |
| --- | --- |
| «Extrae la voz» | Separa la voz |
| «Extrae la batería de esta parte» | Separa la batería solo en la parte marcada (arrastrar sobre la onda) |
| «Extrae la voz que dice «I love you»» | Separa la voz, transcribe la letra (Whisper) y recorta esa frase |
| «Extrae I love you y pon cada palabra en un pad» | Igual, un pad por palabra (también «cada sílaba») |
| «Extrae el bajo y pon cada nota en un pad» | Separa el bajo, saca las notas y corta una por pad con su nombre (E2, G2…) |
| «Sácame las notas del riff principal del bajo» | Transcribe y busca los patrones de 1, 2 o 4 compases que más se repiten |
| «Transcribe el solo de guitarra» | Transcribe la frase entera (sin buscar riff) |
| «Pon cada golpe de la batería en un pad» / «cada caja» | Golpes clasificados en bombo, caja y charles |
| «Extrae la trompeta» | SAM Audio (motor local); en la web, la pista «otros» con aviso |
| «del segundo 10 al 20», «de 0:30 a 0:45» | Fragmento por tiempo |

- **Retoques por texto** en la pestaña Pads: «alarga un poco el final de love», «acorta el inicio de 3», «une I y love»,
  «divide love», «borra you». Si no es un retoque, se toma como orden nueva.
- **Edición**: onda con los cortes; arrastrar bordes, ◀▶ de 10 ms, unir, dividir, borrar, escuchar cada pad.
- **Notas**: piano roll, tablatura (bajo 4/5 cuerdas, guitarra), escuchar la pista o las notas al 100/75/50 % sin
  cambiar el tono, MIDI, tab .txt, riffs (las variaciones sueltas no salen).
- **Exportar**: asignar al banco (desde el banco actual, hasta 64), WAV sueltos o zip, pistas al pad, «Enviar a…» a
  cualquier app (pistas, pads, frase o notas).
- **Informe de error** propio: .txt automático (máx. 3 por sesión) y botón «Descargar informe (.txt)».

### Motores por plataforma
| Paso | Windows/Mac con motor local | Navegador con WebGPU | Navegador sin WebGPU / móvil |
| --- | --- | --- | --- |
| Pistas | BS-RoFormer (voz) + htdemucs_ft / htdemucs_6s | BS-RoFormer SW (6 pistas) / Mel-RoFormer Kim (voz) | htdemucs / htdemucs_6s (WASM) |
| Instrumento por texto | SAM Audio | — (pista «otros» + aviso) | — |
| Letra | Whisper large-v3 (medium sin CUDA) | Whisper large-v3 turbo | Whisper base |
| Notas | MuScriptor (multi-instrumento) | Basic Pitch | Basic Pitch (CPU) |
| Respaldo de notas | YIN | YIN | YIN |
- WebGPU por software (SwiftShader) se trata como «sin WebGPU». Si la GPU falla o la separación no avanza en 120 s, se
  repite por CPU. Basic Pitch con WebGL que no avanza en 45 s se repite por CPU.
- Modelos web: caché común `sh-models-v1` (en escritorio, Documentos/SampledHead/Modelos). unblend se carga con
  `modelUrl` (blob) para usar esa caché.

## mid-box (1.69)
Arriba: 🥁 Batería / 🎸 Bajo, tempo, compases (1–16 o auto), metrónomo y cuenta de un compás.

- **Directo** (`micOn`): `getUserMedia` sin cancelación de eco ni control de ganancia → AudioWorklet `mbx-tap` (blob; si
  falla, ScriptProcessor de 512) → bloques al hilo principal con su `currentTime`.
- **Batería** (`DrumDet` + `feats` + `classify`): envolventes de ataque 0,5 ms / caída 30 ms de la señal y de su derivada
  (agudos); golpe = salto ×2,2 (×2,6 en agudos) sobre lo de los 20 ms anteriores y sobre el ruido de fondo; 50 ms de
  refractario. Rasgos en una ventana de 25 ms («Rápida», directo) o 45 ms («Precisa», y siempre al convertir): 8 bandas
  (40 Hz–16 kHz), centroide, cruces por cero y caída. Sin calibrar, reglas (grave = bombo, agudo = hat, resto = caja;
  abierto si dura > 160 ms al convertir o si no cae en la ventana en directo). **Calibrado** (≥3 ejemplos de bombo, caja
  y hat cerrado, guardados en `localStorage` `sampledhead.midbox.cal` con rasgos de las dos ventanas): k-NN (k = 5,
  rasgos normalizados; al convertir también la duración). Fuerza = pico frente al de los ejemplos o la media de la sesión.
- **Bajo** (`PitchTrk` + `NoteSeg`): paso bajo a 1,4 kHz, diezmado a ~12 kHz, YIN (ventana 256, 60–700 Hz, umbral 0,2)
  cada ~5 ms; nota nueva tras 3 marcos seguidos con la misma nota; reataque si la energía sube ×2,2; fin tras 3 marcos sin
  voz. Octava −2…+1 (−1 por defecto) y ajuste opcional a la escala de la pestaña Bajo. Suena con `mkBass(ctx, bassBus, BP)`.
- **Grabar**: con metrónomo (o con la otra parte ya grabada, que suena mientras grabas) la toma va a tempo desde el final
  de la cuenta, restando el «Ajuste de latencia» (por defecto salida + base + 10 ms). Sin metrónomo ni otra parte, la toma
  empieza en el primer golpe y el tempo se estima (`estTempo`, rejilla de corcheas 70–160 BPM con preferencia suave por 95).
  Se guarda el audio de la toma para **Reconvertir** con el análisis completo. **Sobregrabar** suma a lo que hay.
- **Convertir** un archivo o el pad seleccionado (máx. 2 min; se normaliza si está flojo).
- **Notas en tiempos (beats), sin cuantizar**: `{t,l,v}` batería, `{t,p,d,v}` bajo. Cambiar el BPM mueve todo como en un DAW.
- **Editor** (canvas): elegir, Mayús para varias, arrastrar (tiempo y fila), borde derecho = duración (bajo), doble toque
  = nota nueva, Imán + rejilla (1/4…1/32, tresillos), ◀▶ 5 ms, fuerza, transportar, **Cuantizar** con fuerza 10–100 %,
  Deshacer/Rehacer (60 pasos). La otra parte se ve en sombra arriba.
- **Llevar a…** (batería, bajo o las dos): **pad** (render sin conexión + la cola vuelve al principio, `loop: true`),
  **Looper** (sustituye lo que haya, pide confirmación: sonidos de batería en pads libres —el sintetizado se renderiza—,
  pista 1 batería, pista 2 bajo con teclas `64+k` de la pestaña Bajo; el Looper no guarda la fuerza), **Generador**
  (`cvApply` con estilo «u:mid-box», máx. 4 compases, semicorcheas; copia los sonidos cargados a los huecos; bajo bloqueado),
  **MIDI** (PPQ 960, batería canal 10: 36/38/42/46, bajo canal 1), **WAV** 24 bit y **Enviar a…** (`loop` con notas).
- **Informe de error** propio (`mid-box-1.0.0-informe-….txt`, máx. 3 automáticos) y botón «Descargar informe (.txt)».

## Interconexión
- Menú Más → «Enviar pad a…» y «Recibido de otras apps». Lo recibido va al primer pad libre (en la pestaña Extractor,
  si llega un solo audio, pasa a ser la fuente).
- Se mantiene el puente antiguo con el Editor y CrazyHead (`toEditor`, `toSampler`, `toCrazyHead`, `fromCrazyHead`).

## Reconstruir vendor
```bash
npm i unblend@1.0.1 esbuild @spotify/basic-pitch@1.0.1 && npm i --ignore-scripts @huggingface/transformers@3
npx esbuild node_modules/unblend/dist/index.js --bundle --minify --format=esm --outfile=vendor/unblend.js
npx esbuild node_modules/unblend/dist/workers/*.js --bundle --minify --format=esm --outdir=vendor/workers
npx esbuild vendor-src/notes-worker.src.js --bundle --minify --format=esm --outfile=vendor/notes-worker.js
cp node_modules/@huggingface/transformers/dist/transformers.min.js vendor/
```

## Historial
- **1.70** (20-11-2026): **mid-box en los proyectos** (y en el autoguardado): `pjMeta().mbx` = notas de batería y bajo sin
  cuantizar, tempo, compases, parte, qué exportar, nombres de los sonidos, ajustes (sensibilidad, respuesta, latencia, octava,
  escala, metrónomo, cuenta, sobregrabar, imán, rejilla, fuerza de cuantizar) y la calibración (al cargar solo entra si el
  navegador no tiene otra); `pjCapture().mbxAu` = audio mono de los 4
  sonidos de la batería y de la última toma de cada parte (si dura ≤ 90 s) para poder reconvertir. Los proyectos sin
  `mbx` no tocan mid-box. «Nuevo proyecto» también lo vacía (envoltura de `newFxGen`). Los ganchos se instalan al cargar
  `midbox.js`, antes de que se recupere el autoguardado. mid-box 1.1.0.
- **1.69** (20-11-2026): pestaña **mid-box** (voz → batería con bombo/caja/hat cerrado/hat abierto y voz → bajo; en
  directo y desde grabación o audio; calibración; editor sin cuantizar; pad, Looper, Generador, MIDI, WAV, Enviar a…).
  Arreglo: en la vista de ordenador las pestañas **Extractor** y mid-box ocupan todo el ancho (antes los pads seguían a la
  derecha y el panel quedaba estrecho); en ordenador las 9 pestañas van en una fila.
- **1.68** (19-11-2026): los **proyectos guardan el Generador** (`pjMeta.gen` = `scSnap()`, `pjCapture.genAu` = audio de los 4 huecos; los proyectos antiguos sin `gen` no tocan el generador); **Looper → MIDI** (`lpMidiBytes`: pads canal 10 nota 36+n, bajo canal 1, teclas canal 2, tempo del bucle o 120); **Exportar .mid** en la vista previa del conversor de batería (lee la rejilla tal como se ve); **conversor fase 2: audio → bajo** (`cbAnalyze`: paso bajo + YIN cada 12 ms, notas por estabilidad de tono y reataques; `cbTempo`: rejilla de corcheas 70–160 BPM; `cbKey`: tónica y mayor/menor por histograma; notas al grado más cercano de la escala del Bajo; aplica al generador con el bajo bloqueado o exporta .mid con las notas reales). **Break troceado a CrazyHead**: «Enviar pad a CrazyHead» manda los cortes del Chop activo (`cuts` en segundos desde el inicio de la región). Código en el bloque `1.68` al final de `index.html`.
- **1.67** (19-11-2026): «Grabar audio del sistema» solo aparece en ordenador (Chrome/Edge en Windows y Mac; en Mac Chrome solo captura el audio de una pestaña); en móvil se oculta porque Chrome/WebView de Android no tienen getDisplayMedia. Al pulsarlo cierra el menú y avisa si algo falla; Extractor 1.0.1: en móviles/equipos de ≤4 GB descarga el modelo de separación al terminar y usa calidad «Rápida» por defecto (el cierre de la app al final del proceso era memoria); registro de sesión `sh_ex_crumb`: si la app se cierra sola, al volver avisa del paso y descarga un informe .txt.
- **1.66** (19-11-2026): menú Más → «Copia de tus datos»: guarda o recupera kits y ajustes en un archivo `.shdatos` (para pasarlos a SampledHead de escritorio u otro navegador).
- **1.65** (19-11-2026): pestaña **Extractor** (todas las funciones de la idea en una versión), «Enviar pad a…» y
  «Recibido» para todas las apps (sh-core), `sw.js` deja de borrar las cachés de las otras apps.
- 1.64 y anteriores: ver notas del proyecto (Move, CrazyHead, generador, MIDI medido…).

## Reglas permanentes
- Entrega `SampledHeadApp_vN.zip` con carpeta, versión en el pie, standalone de un archivo y esta hoja.
- Informe de error .txt automático y botón manual.
- Probar en Chrome headless y decir qué no se ha probado.
- `sh-core.js` se edita solo en `SH-apps/sh-core` y se reparte con `node sh-core/sync.js`.

## Límites conocidos
- mid-box (1.69): probado en Chrome headless (Linux) con beatbox y tarareo **sintéticos**: conversión 16/16 golpes bien
  clasificados (error < 1 ms) y 8/8 notas de bajo exactas; directo con micro falso (archivo): 16/16 golpes y 8/8 notas en
  la toma libre, tempo detectado. **No probado con voz real, micro real, móvil real ni Safari/iOS.** La latencia real
  (lo que tarda en sonar en directo y el «Ajuste de latencia» de las tomas a tempo) depende del equipo: no se pudo medir.
  En directo «Rápida» distingue peor el hat abierto del cerrado (la cola aún no ha pasado): al convertir o con
  «Reconvertir la toma» se mira la duración real. Sin auriculares, el altavoz puede disparar golpes.
- mid-box en proyectos: audio de toma > 90 s → solo se guardan las notas. La calibración de un proyecto no sustituye a una que ya tengas en ese navegador (para eso, «Borrar calibración» y volver a cargar el proyecto).
- Conversor audio → bajo (1.68): monofónico; probado solo con un bajo sintético (8 notas a 100 BPM: notas, tempo y rejilla exactos). Con una mezcla completa conviene separar antes el bajo con el Extractor. El tempo se busca entre 70 y 160 BPM (÷2/×2 para corregir).
- Proyectos con generador (1.68): el audio de los huecos ocupa espacio en el almacenamiento del navegador (máx. 6 s mono por hueco).
- Cierre de la app al final del Extractor en móvil (1.67): causa probable = memoria; **no reproducido ni confirmado en un móvil real**. El registro de sesión dirá el paso exacto si vuelve a pasar.
- Audio del sistema: Windows (Chrome/Edge) captura una pestaña o todo el sistema; Mac solo el audio de una pestaña. Móvil: oculto. Alternativa = grabar pantalla e Importar. No probado en Windows/Mac reales ni en el escritorio SampledHead (Electron).
- Probado en Chrome headless (Linux, sin GPU): separación htdemucs por WASM, Basic Pitch por CPU (notas exactas en una
  línea de bajo de prueba), Whisper base con tiempo por palabra (discurso de JFK mezclado con un bajo: frase encontrada y
  5 pads bien cortados), bandeja entre las 8 apps.
- **No probado**: WebGPU real (BS-RoFormer SW, Mel-RoFormer, Whisper large-v3 turbo), móvil real, Safari/iOS, motor local
  en Windows/Mac con GPU, MuScriptor y SAM Audio con modelos reales, canciones reales largas.
- Los tiempos de Whisper base son aproximados: los cortes se ajustan a la energía de la voz, pero conviene revisarlos.
- La clasificación de golpes (bombo/caja/charles) es por bandas de frecuencia, no por IA.
- El tempo y el riff se estiman de las notas; compás 4/4.
- La versión standalone (archivo local) no puede usar los modelos: avisa y remite a la web o a la app de escritorio.
- Licencias de modelos: BS-RoFormer SW y Mel-RoFormer (pesos CC BY-NC-SA / MIT), MuScriptor CC BY-NC 4.0, SAM Audio
  licencia propia de Meta: uso personal y gratuito, sin venta.
