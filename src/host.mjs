/**
 * Build the browser-only host for a Slim game.
 *
 * The compiler is deliberately kept out of the generated page.  The page
 * contains only the browser host and the game module.  WASM is embedded by
 * default, with an external URL available when that makes the ZIP smaller.
 */

const MATH_BUILTINS = ['sin', 'cos', 'atan2', 'pow'];
const BUILTINS = new Set(['tri', 'sound', 'input', 'text', ...MATH_BUILTINS]);
const SOUND_PACKINGS = new Set(['none', 'numbers', 'bytes']);
const SOUND_PRESETS = Object.freeze([
  Object.freeze([Object.freeze([0, 7, 0, .14, 1, .85])]),
  Object.freeze([
    Object.freeze([12, -2, 0, .15, 1, .72]),
    Object.freeze([19, -4, .035, .12, 0, .42])
  ]),
  Object.freeze([Object.freeze([0, -12, 0, .25, 3, .82])]),
  Object.freeze([
    Object.freeze([0, 0, 0, .34, 0, .52]),
    Object.freeze([4, 0, .055, .32, 0, .48]),
    Object.freeze([7, 0, .11, .30, 1, .42]),
    Object.freeze([12, 0, .165, .28, 0, .32])
  ]),
  Object.freeze([
    Object.freeze([7, 4, 0, .20, 1, .52]),
    Object.freeze([12, 0, .07, .24, 0, .38])
  ])
]);

function normalizeSoundPacking(value) {
  if (value === undefined) return 'none';
  if (!SOUND_PACKINGS.has(value)) {
    throw new TypeError('soundPacking must be one of "none", "numbers", or "bytes"');
  }
  return value;
}

function soundLiteral(value) {
  let text = Number(value).toFixed(3).replace(/0+$/, '');
  if (text.endsWith('.')) text = text.slice(0, -1);
  else if (text.slice(text.indexOf('.') + 1).length === 1) text += '0';
  return text.replace(/^-?0\./, (prefix) => prefix[0] === '-' ? '-.' : '.');
}

function quantizeSound(value, scale, field, index) {
  const packed = Math.round(value * scale);
  if (!Number.isFinite(value) || !Number.isSafeInteger(packed) || packed / scale !== value) {
    throw new RangeError(`Sound preset voice ${index} has an unrepresentable ${field}`);
  }
  return packed;
}

function packedSoundRecords() {
  const records = [];
  let index = 0;
  for (const preset of SOUND_PRESETS) {
    for (const record of preset) {
      records.push([
        record[0],
        record[1],
        quantizeSound(record[2], 200, 'delay', index),
        quantizeSound(record[3], 200, 'duration', index),
        record[4],
        quantizeSound(record[5], 100, 'gain', index)
      ]);
      index += 1;
    }
  }
  return records;
}

function soundDataFor(mode) {
  const records = packedSoundRecords();
  const starts = [];
  let start = 0;
  for (const preset of SOUND_PRESETS) {
    starts.push(start, preset.length);
    start += preset.length;
  }

  if (mode === 'none') {
    const presets = SOUND_PRESETS.map((preset) =>
      `  [${preset.map((record) => `[${record.map(soundLiteral).join(', ')}]`).join(', ')}]`
    ).join(',\n');
    return {
      declaration: `presets = [\n${presets}\n], waves = ['sine', 'triangle', 'square', 'sawtooth'];`,
      presetCount: 'presets.length',
      voiceParameter: 'd',
      voiceSetup: '',
      pitch: 'd[0]',
      sweep: 'd[1]',
      delay: 'd[2]',
      duration: 'd[3]',
      wave: 'd[4]',
      gain: 'd[5]',
      loop: 'for (var j = 0, set = presets[id]; j < set.length; j++) voice(p, n, set[j]);'
    };
  }

  const numbers = records.flat();
  const numberSource = numbers.join(', ');
  const startSource = starts.join(', ');
  if (mode === 'numbers') {
    return {
      declaration: `soundData = [${numberSource}], soundSets = [${startSource}], waves = ['sine', 'triangle', 'square', 'sawtooth'];`,
      presetCount: '(soundSets.length / 2)',
      voiceParameter: 'index',
      voiceSetup: 'var k = index * 6, pitchOffset = soundData[k], sweep = soundData[k + 1], delay = soundData[k + 2] / 200, duration = soundData[k + 3] / 200, wave = soundData[k + 4], gain = soundData[k + 5] / 100;',
      pitch: 'pitchOffset',
      sweep: 'sweep',
      delay: 'delay',
      duration: 'duration',
      wave: 'wave',
      gain: 'gain',
      loop: 'for (var j = soundSets[id * 2], end = j + soundSets[id * 2 + 1]; j < end; j++) voice(p, n, j);'
    };
  }

  const chars = [];
  for (const record of records) {
    const codes = [
      record[0] + 81,
      record[1] + 81,
      record[2] + 33,
      record[3] + 33,
      record[4] + 33,
      record[5] + 33
    ];
    if (codes.some((code) => code < 33 || code > 126)) {
      throw new RangeError('Sound preset data does not fit printable ASCII');
    }
    chars.push(...codes.map((code) => String.fromCharCode(code)));
  }
  const packed = chars.join('').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return {
    declaration: `soundData = '${packed}', soundSets = [${startSource}], waves = ['sine', 'triangle', 'square', 'sawtooth'];`,
    presetCount: '(soundSets.length / 2)',
    voiceParameter: 'index',
    voiceSetup: 'var k = index * 6, pitchOffset = soundData.charCodeAt(k) - 81, sweep = soundData.charCodeAt(k + 1) - 81, delay = (soundData.charCodeAt(k + 2) - 33) / 200, duration = (soundData.charCodeAt(k + 3) - 33) / 200, wave = soundData.charCodeAt(k + 4) - 33, gain = (soundData.charCodeAt(k + 5) - 33) / 100;',
    pitch: 'pitchOffset',
    sweep: 'sweep',
    delay: 'delay',
    duration: 'duration',
    wave: 'wave',
    gain: 'gain',
    loop: 'for (var j = soundSets[id * 2], end = j + soundSets[id * 2 + 1]; j < end; j++) voice(p, n, j);'
  };
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('wasmBytes must be an ArrayBuffer or a byte view');
}

function base64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[n >>> 18] + alphabet[(n >>> 12) & 63] + alphabet[(n >>> 6) & 63] + alphabet[n & 63];
  }
  if (i < bytes.length) {
    const n = bytes[i] << 16 | (i + 1 < bytes.length ? bytes[i + 1] << 8 : 0);
    out += alphabet[n >>> 18] + alphabet[(n >>> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=') + '=';
  }
  return out;
}

function html(value) {
  return String(value == null ? 'Slim' : value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function scanImports(wasm) {
  let source;
  try {
    source = WebAssembly.Module.imports(new WebAssembly.Module(wasm));
  } catch (error) {
    throw new TypeError(`wasmBytes must be a valid WASM module: ${error.message}`);
  }
  const used = new Set();
  const modules = new Set();
  for (const descriptor of source) {
    if (descriptor.kind !== 'function') {
      throw new Error(`Unsupported WASM import ${descriptor.module}.${descriptor.name} (${descriptor.kind})`);
    }
    if (descriptor.module !== 'e' || !BUILTINS.has(descriptor.name)) {
      throw new Error(`Unsupported WASM import ${descriptor.module}.${descriptor.name}`);
    }
    used.add(descriptor.name);
    modules.add(descriptor.module);
  }

  return { used, modules };
}

function scanJavaScriptImports(source) {
  // JavaScript output has no binary import table, so the compiler supplies
  // the reachable host names alongside its factory expression.
  if (source == null) source = ['tri', 'sound', 'input'];
  if (typeof source === 'string') source = [source];
  if (!Array.isArray(source) && !(source && source[Symbol.iterator])) {
    source = Object.keys(source).filter((name) => source[name]);
  }
  const used = new Set();
  for (const item of source) {
    const raw = typeof item === 'string' ? item : item && (item.name || item.field);
    const name = raw && raw.slice(raw.lastIndexOf('.') + 1);
    if (!BUILTINS.has(name)) throw new Error(`Unsupported JavaScript host import ${raw}`);
    used.add(name);
  }
  return { used, modules: used.size ? new Set(['e']) : new Set() };
}

// Text is drawn on a transparent 2D canvas stacked over the WebGL one. Each
// string is a <template id="t<N>"> in the page, read once and cached; the
// overlay is cleared before every simulation tick like the triangle buffer.
function textHost() {
  return `
var o = document.getElementById('o'), q = o.getContext('2d'), C = [], P = ['#fff', '#f4c04a', '#7ee8a2', '#8d9ac0'];
function fit() {
  var r = o.getBoundingClientRect(), d = devicePixelRatio || 1;
  o.width = r.width * d;
  o.height = r.height * d;
  q.setTransform(o.width / 800, 0, 0, o.height / 600, 0, 0);
  q.textAlign = 'center';
  q.lineJoin = 'round';
}
function text(i, x, y, s, k) {
  var t = C[i] || (C[i] = document.getElementById('t' + i).content.textContent);
  q.font = 'bold ' + s + 'px system-ui,sans-serif';
  q.lineWidth = s / 5;
  q.strokeStyle = '#080a16';
  q.strokeText(t, x, y);
  q.fillStyle = P[k | 0] || '#fff';
  q.fillText(t, x, y);
  return 0;
}
addEventListener('resize', fit);
fit();`;
}

function triangleHost() {
  return `
var v = [], gl, buf;
function tri(a, b, d, e, f, h, r, g, k) {
  v.push(a, b, r, g, k, d, e, r, g, k, f, h, r, g, k);
  return 0;
}
function gpu() {
  gl = c.getContext('webgl', {antialias: false});
  if (!gl) throw Error('WebGL unavailable');
  var q = function (t, s) {
    var x = gl.createShader(t);
    gl.shaderSource(x, s);
    gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) {
      throw Error(gl.getShaderInfoLog(x) || 'shader compile failed');
    }
    return x;
  };
  var p = gl.createProgram();
  gl.attachShader(p, q(gl.VERTEX_SHADER, 'attribute vec2 a;attribute vec3 q;varying vec3 c;void main(){gl_Position=vec4(a.x*.0025-1.,1.-a.y*.003333333,0.,1.);c=q;}'));
  gl.attachShader(p, q(gl.FRAGMENT_SHADER, 'precision mediump float;varying vec3 c;void main(){gl_FragColor=vec4(c,1.);}'));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw Error(gl.getProgramInfoLog(p) || 'shader link failed');
  }
  gl.useProgram(p);
  buf = gl.createBuffer();
  var a = gl.getAttribLocation(p, 'a');
  var q = gl.getAttribLocation(p, 'q');
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(a);
  gl.enableVertexAttribArray(q);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 20, 0);
  gl.vertexAttribPointer(q, 3, gl.FLOAT, false, 20, 8);
  gl.clearColor(0, 0, 0, 1);
}
function draw() {
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (v.length) {
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, v.length / 5);
  }
}`;
}

// Sound pitch is a semitone offset from 220 Hz. Gain is 0..1; zero is silent.
function soundHost(soundPacking = 'none') {
  const data = soundDataFor(normalizeSoundPacking(soundPacking));
  return `
var ac, voices = [], ${data.declaration}
function unlock() {
  var A = window.AudioContext || window.webkitAudioContext;
  if (!A) return;
  try {
    ac || (ac = new A);
    if (ac.resume) ac.resume();
  } catch (e) {}
}
function forget(x) {
  if (!x || x.dead) return;
  x.dead = 1;
  var i = voices.indexOf(x);
  if (i >= 0) voices.splice(i, 1);
  try { x.o.disconnect(); } catch (e) {}
  try { x.q.disconnect(); } catch (e) {}
}
function setAt(a, v, t) {
  a.value = v;
  if (a.setValueAtTime) a.setValueAtTime(v, t);
}
function rampTo(a, v, t) {
  a.value = v;
  if (a.exponentialRampToValueAtTime) a.exponentialRampToValueAtTime(v, t);
  else if (a.linearRampToValueAtTime) a.linearRampToValueAtTime(v, t);
}
function voice(p, n, ${data.voiceParameter}) {
  while (voices.length >= 8) {
    var old = voices.shift();
    try { old.o.stop(); } catch (e) {}
    forget(old);
  }
  var o, q, x;
  try {
    o = ac.createOscillator();
    q = ac.createGain();
    x = {o: o, q: q};
    ${data.voiceSetup ? `${data.voiceSetup}\n    ` : ''}var t = (isFinite(ac.currentTime) ? ac.currentTime : 0) + ${data.delay};
    var f = 220 * Math.pow(2, (p + ${data.pitch}) / 12);
    var z = f * Math.pow(2, ${data.sweep} / 12);
    o.type = waves[${data.wave}];
    setAt(o.frequency, f, t);
    if (${data.sweep}) rampTo(o.frequency, z, t + ${data.duration});
    var a = Math.min(.006, ${data.duration} * .2), level = Math.max(.0001, n * ${data.gain});
    setAt(q.gain, .0001, t);
    rampTo(q.gain, level, t + a);
    rampTo(q.gain, .0001, t + ${data.duration});
    o.connect(q);
    q.connect(ac.destination);
    o.onended = function () { forget(x); };
    voices.push(x);
    o.start(t);
    o.stop(t + ${data.duration} + .025);
  } catch (e) {
    forget(x);
    try { if (o) o.disconnect(); } catch (x) {}
    try { if (q) q.disconnect(); } catch (x) {}
  }
}
function sound(i, p, g) {
  if (g == null) g = .12;
  else {
    g = +g;
    if (!(g > 0)) return 0;
  }
  var A = window.AudioContext || window.webkitAudioContext;
  if (!A) return 0;
  try {
    ac || (ac = new A);
    p = +p;
    if (!isFinite(p)) p = 0;
    p = Math.max(-48, Math.min(48, p));
    var id = (i | 0) % ${data.presetCount};
    if (id < 0) id += ${data.presetCount};
    var n = Math.min(1, g);
    ${data.loop}
  } catch (e) {}
  return 0;
}`;
}

// Pointer coordinates stay available after release; input(8) reports the
// pointer's current primary-button state so keyboard control cannot teleport.
function inputHost(gesture = '', keyboardOnly = false) {
  const pointerState = keyboardOnly ? '' : ', px = 0, py = 0, ph = 0';
  const jumpInput = keyboardOnly ? 'held[4]' : 'held[4] || ph';
  const pointerInputs = keyboardOnly
    ? `
    case 6:
    case 7:
    case 8: return 0;`
    : `
    case 6: return px;
    case 7: return py;
    case 8: return ph;`;
  const pointerListeners = keyboardOnly ? '' : `
function point(e) {
  var r = c.getBoundingClientRect();
  px = Math.max(0, Math.min(800, (e.clientX - r.left) * 800 / r.width));
  py = Math.max(0, Math.min(600, (e.clientY - r.top) * 600 / r.height));
}
`;
  const pointerEvents = keyboardOnly ? '' : `
c.addEventListener('pointerdown', function (e) {
  point(e);
  if (e.button === 0) { ph = 1; pressed = 1; }
  try { c.setPointerCapture(e.pointerId); } catch (x) {}
  ${gesture}
});
c.addEventListener('pointermove', point);
c.addEventListener('pointerup', function (e) {
  point(e);
  if (e.button === 0) ph = 0;
});
c.addEventListener('pointercancel', function (e) {
  point(e);
  ph = 0;
});`;
  return `
var held = [0, 0, 0, 0, 0], pressed = 0, restart = 0, menu = 0${pointerState};
${pointerListeners}
function key(e, on) {
  var k = e.key.toLowerCase();
  var i = k === 'arrowleft' || k === 'a' ? 0 : k === 'arrowright' || k === 'd' ? 1 : k === 'arrowup' || k === 'w' ? 2 : k === 'arrowdown' || k === 's' ? 3 : k === ' ' || e.code === 'Space' ? 4 : -1;
  if (i >= 0) {
    held[i] = on;
    if (on && !e.repeat && i === 4) pressed = 1;
    e.preventDefault();
  }
  if (on && k === 'r' && !e.repeat) restart = 1;
  if (on && (k === 'escape' || k === 'm') && !e.repeat) menu = 1;
}
function input(i) {
  switch (i | 0) {
    case 0: return held[0];
    case 1: return held[1];
    case 2: return held[2];
    case 3: return held[3];
    case 4: return ${jumpInput};
    case 5: return pressed;
${pointerInputs}
    case 9: return restart;
    case 10: return menu;
    default: return 0;
  }
}
addEventListener('keydown', function (e) { key(e, 1); });
addEventListener('keyup', function (e) { key(e, 0); });
addEventListener('blur', function () {
  held[0] = held[1] = held[2] = held[3] = held[4]${keyboardOnly ? '' : ' = ph'} = 0;
  pressed = restart = menu = 0;
});
${pointerEvents}`;
}

function makeRuntime({ used, modules, boot, keyboardOnly = false, soundPacking = 'none' }) {
  const pieces = [];
  if (used.has('tri')) pieces.push(triangleHost());
  if (used.has('sound')) pieces.push(soundHost(soundPacking));
  if (used.has('input')) pieces.push(inputHost(used.has('sound') ? 'unlock()' : '', keyboardOnly));
  if (used.has('text')) pieces.push(textHost());

  const imports = [];
  for (const module of modules) imports.push(`I[${JSON.stringify(module)}]=E`);
  const e = [];
  if (used.has('tri')) e.push('tri:tri');
  if (used.has('sound')) e.push('sound:sound');
  if (used.has('input')) e.push('input:input');
  if (used.has('text')) e.push('text:text');
  for (const name of MATH_BUILTINS) if (used.has(name)) e.push(`${name}:Math.${name}`);
  const setupGpu = used.has('tri') ? 'gpu()' : '';
  const draw = used.has('tri') ? 'draw()' : '';
  const clear = (used.has('tri') ? 'v.length=0;' : '') + (used.has('text') ? 'q.clearRect(0,0,800,600);' : '');
  const inputTick = used.has('input') ? 'pressed=restart=menu=0;' : '';
  const audioUnlock = used.has('sound')
    ? keyboardOnly ? 'addEventListener("keydown",unlock)' : 'addEventListener("keydown",unlock);addEventListener("pointerdown",unlock)'
    : '';

  return `(function () {
  var c = document.querySelector('canvas');
  var E = {${e.join(',')}};
  var I = {};
  ${imports.join(';')};
  ${pieces.join('')}
  ${audioUnlock};
  function start(g) {
    ${setupGpu}
    g.init();
    ${draw}
    var d = 1000 / 60, a = 0, p = performance.now();
    function f(t) {
      a = Math.min(a + Math.min(250, t - p), d * 5);
      p = t;
      var n = Math.min(5, a / d | 0);
      for (var i = 0; i < n; i++) {
        ${clear}
        g.frame();
        ${inputTick}
      }
      a -= n * d;
      ${draw}
      requestAnimationFrame(f);
    }
    requestAnimationFrame(f);
  }
  ${boot}.then(start);
})()`;
}

/**
 * @param {ArrayBuffer|ArrayBufferView} wasmBytes
 * @param {{title?: string, wasmUrl?: string, keyboardOnly?: boolean, soundPacking?: 'none'|'numbers'|'bytes', footer?: string}} [options]
 * `wasmUrl` selects an external fetch layout; otherwise the module is embedded.
 * Sound pitch uses semitone offsets from 220 Hz and gain 0..1, where zero is silent.
 * @returns {string} a complete, self-contained HTML document
 */
export function makeHtml(wasmBytes, options = {}) {
  const soundPacking = normalizeSoundPacking(options.soundPacking);
  const bytes = bytesOf(wasmBytes);
  const { used, modules } = scanImports(bytes);
  const title = html(options.title);
  const keyboardOnly = options.keyboardOnly === true;
  const boot = options.wasmUrl == null
    ? `var z=atob('${base64(bytes)}'),w=new Uint8Array(z.length),j=0;for(;j<z.length;j++)w[j]=z.charCodeAt(j);WebAssembly.instantiate(w,I).then(function(x){return x.instance.exports})`
    : `fetch(${JSON.stringify(options.wasmUrl).replace(/</g, '\\u003c')}).then(function(r){if(!r.ok)throw Error('WASM '+r.status);return r.arrayBuffer()}).then(function(w){return WebAssembly.instantiate(w,I)}).then(function(x){return x.instance.exports})`;
  const runtime = makeRuntime({ used, modules, boot, keyboardOnly, soundPacking });
  return page(title, runtime, keyboardOnly, options.footer, options.texts, used);
}

function page(title, runtime, keyboardOnly = false, footerText, texts = [], used = new Set()) {
  if (used.has('text') && !texts.length) throw new Error('The game draws text but the page has no texts; add `// text:` lines to the source');
  const overlay = used.has('text') ? '<canvas id=o width=800 height=600></canvas>' : '';
  const templates = texts.map((text, index) => `<template id=t${index}>${html(text)}</template>`).join('');
  const footer = footerText ?? (keyboardOnly ? 'Arrows/A-D: move · Space: jump · R: restart' : 'Arrows/WASD · Space · Mouse/Touch · R restarts');
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=icon href="data:,"><title>${title}</title><style>html,body{margin:0;width:100%;height:100%;background:#111;color:#fff;font:14px system-ui}main{height:100%;display:grid;place-items:center;align-content:center;gap:4px;text-align:center}canvas{display:block;width:min(100vw,calc((100vh - 24px)*4/3));height:auto;aspect-ratio:4/3;touch-action:none;grid-area:1/1}#o{pointer-events:none}p{margin:0;opacity:.7}</style><main><div style=display:grid><canvas width=800 height=600></canvas>${overlay}</div><p>${html(footer)}</p></main>${templates}<script>${runtime}</script>`;
}

/**
 * @param {string} code a factory expression accepting the host object `e`
 * @param {{title?: string, imports?: Iterable<string>|Record<string, boolean>, keyboardOnly?: boolean, soundPacking?: 'none'|'numbers'|'bytes', footer?: string}} [options]
 * @returns {string} a complete, self-contained HTML document
 */
export function makeJavaScriptHtml(code, options = {}) {
  const soundPacking = normalizeSoundPacking(options.soundPacking);
  if (typeof code !== 'string' || !code.trim()) throw new TypeError('JavaScript game code must be a factory expression');
  const { used, modules } = scanJavaScriptImports(options.imports);
  const title = html(options.title);
  const keyboardOnly = options.keyboardOnly === true;
  const boot = `Promise.resolve((${code})(E))`;
  return page(title, makeRuntime({ used, modules, boot, keyboardOnly, soundPacking }), keyboardOnly, options.footer, options.texts, used);
}

export default makeHtml;
