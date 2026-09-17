/**
 * Build the browser-only host for a Slim game.
 *
 * The compiler is deliberately kept out of the generated page.  The page
 * contains only the browser host and the game module.  WASM is embedded by
 * default, with an external URL available when that makes the ZIP smaller.
 */

const BUILTINS = new Set(['tri', 'sound', 'input']);

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

function triangleHost() {
  return `
var v=[],gl,buf;
function tri(a,b,d,e,f,h,r,g,k){v.push(a,b,r,g,k,d,e,r,g,k,f,h,r,g,k);return 0}
function gpu(){
 gl=c.getContext('webgl',{antialias:false});
 if(!gl)throw Error('WebGL unavailable');
 var q=function(t,s){var x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);if(!gl.getShaderParameter(x,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(x)||'shader compile failed');return x};
 var p=gl.createProgram();
 gl.attachShader(p,q(gl.VERTEX_SHADER,'attribute vec2 a;attribute vec3 q;varying vec3 c;void main(){gl_Position=vec4(a.x*.0025-1.,1.-a.y*.003333333,0.,1.);c=q;}'));
 gl.attachShader(p,q(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 c;void main(){gl_FragColor=vec4(c,1.);}'));
 gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p)||'shader link failed');gl.useProgram(p);buf=gl.createBuffer();
 var a=gl.getAttribLocation(p,'a'),q=gl.getAttribLocation(p,'q');
 gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.enableVertexAttribArray(a);gl.enableVertexAttribArray(q);
 gl.vertexAttribPointer(a,2,gl.FLOAT,false,20,0);gl.vertexAttribPointer(q,3,gl.FLOAT,false,20,8);
 gl.clearColor(0,0,0,1)
}
function draw(){gl.clear(gl.COLOR_BUFFER_BIT);if(v.length){gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(v),gl.STREAM_DRAW);gl.drawArrays(gl.TRIANGLES,0,v.length/5)}}`;
}

// Sound pitch is a semitone offset from 220 Hz. Gain is 0..1; zero is silent.
function soundHost() {
  return `
var ac;
function unlock(){var A=window.AudioContext||window.webkitAudioContext;if(!A)return;try{ac||(ac=new A);ac.resume()}catch(e){}}
function sound(i,p,g){if(g!=null&&g<=0)return 0;var A=window.AudioContext||window.webkitAudioContext;if(!A)return 0;try{ac||(ac=new A);var o=ac.createOscillator(),q=ac.createGain(),t=ac.currentTime,n=Math.max(.0001,Math.min(1,g==null?0.12:g));o.type=i%2?'square':'sine';o.frequency.value=220*Math.pow(2,(p||0)/12);q.gain.setValueAtTime(.0001,t);q.gain.exponentialRampToValueAtTime(n,t+.005);q.gain.exponentialRampToValueAtTime(.0001,t+.12);o.connect(q);q.connect(ac.destination);o.start(t);o.stop(t+.13)}catch(e){}return 0}`;
}

// Pointer coordinates stay available after release; input(8) reports the
// pointer's current primary-button state so keyboard control cannot teleport.
function inputHost(gesture = '') {
  return `
var held=[0,0,0,0,0],pressed=0,restart=0,px=0,py=0,ph=0;
function point(e){var r=c.getBoundingClientRect();px=Math.max(0,Math.min(800,(e.clientX-r.left)*800/r.width));py=Math.max(0,Math.min(600,(e.clientY-r.top)*600/r.height))}
function key(e,on){var k=e.key.toLowerCase(),i=k==='arrowleft'||k==='a'?0:k==='arrowright'||k==='d'?1:k==='arrowup'||k==='w'?2:k==='arrowdown'||k==='s'?3:k===' '||e.code==='Space'?4:-1;if(i>=0){held[i]=on;if(on&&!e.repeat&&i===4)pressed=1;e.preventDefault()}if(on&&k==='r'&&!e.repeat)restart=1}
function input(i){switch(i|0){case 0:return held[0];case 1:return held[1];case 2:return held[2];case 3:return held[3];case 4:return held[4]||ph;case 5:return pressed;case 6:return px;case 7:return py;case 8:return ph;case 9:return restart;default:return 0}}
addEventListener('keydown',function(e){key(e,1);${''}});
addEventListener('keyup',function(e){key(e,0)});
addEventListener('blur',function(){held[0]=held[1]=held[2]=held[3]=held[4]=ph=0;pressed=restart=0});
c.addEventListener('pointerdown',function(e){point(e);if(e.button===0){ph=1;pressed=1}try{c.setPointerCapture(e.pointerId)}catch(x){}${gesture}});
c.addEventListener('pointermove',point);
c.addEventListener('pointerup',function(e){point(e);if(e.button===0)ph=0});
c.addEventListener('pointercancel',function(e){point(e);ph=0});`;
}

function makeRuntime({ used, modules, wasm, wasmUrl }) {
  const pieces = [];
  if (used.has('tri')) pieces.push(triangleHost());
  if (used.has('sound')) pieces.push(soundHost());
  if (used.has('input')) pieces.push(inputHost(used.has('sound') ? 'unlock()' : ''));

  const imports = [];
  for (const module of modules) imports.push(`I[${JSON.stringify(module)}]=E`);
  const e = [];
  if (used.has('tri')) e.push('tri:tri');
  if (used.has('sound')) e.push('sound:sound');
  if (used.has('input')) e.push('input:input');
  const setupGpu = used.has('tri') ? 'gpu()' : '';
  const draw = used.has('tri') ? 'draw()' : '';
  const clear = used.has('tri') ? 'v.length=0;' : '';
  const inputTick = used.has('input') ? 'pressed=restart=0;' : '';
  const audioUnlock = used.has('sound') ? 'addEventListener("keydown",unlock);addEventListener("pointerdown",unlock)' : '';

  const load = wasmUrl == null
    ? `var z=atob('${wasm}'),w=new Uint8Array(z.length),j=0;for(;j<z.length;j++)w[j]=z.charCodeAt(j);WebAssembly.instantiate(w,I)`
    : `fetch(${JSON.stringify(wasmUrl).replace(/</g, '\\u003c')}).then(function(r){if(!r.ok)throw Error('WASM '+r.status);return r.arrayBuffer()}).then(function(w){return WebAssembly.instantiate(w,I)})`;
  return `(function(){var c=document.querySelector('canvas'),E={${e.join(',')}},I={};${imports.join(';')};${pieces.join('')}${audioUnlock};${load}.then(function(x){var g=x.instance.exports;${setupGpu};g.init();${draw};var d=1000/60,a=0,p=performance.now();function f(t){a=Math.min(a+Math.min(250,t-p),d*5);p=t;var n=Math.min(5,a/d|0);for(var i=0;i<n;i++){${clear}g.frame();${inputTick}}a-=n*d;${draw};requestAnimationFrame(f)}requestAnimationFrame(f)})})()`;
}

/**
 * @param {ArrayBuffer|ArrayBufferView} wasmBytes
 * @param {{title?: string, wasmUrl?: string}} [options]
 * `wasmUrl` selects an external fetch layout; otherwise the module is embedded.
 * Sound pitch uses semitone offsets from 220 Hz and gain 0..1, where zero is silent.
 * @returns {string} a complete, self-contained HTML document
 */
export function makeHtml(wasmBytes, options = {}) {
  const bytes = bytesOf(wasmBytes);
  const { used, modules } = scanImports(bytes);
  const title = html(options.title);
  const runtime = makeRuntime({ used, modules, wasm: options.wasmUrl == null ? base64(bytes) : null, wasmUrl: options.wasmUrl });
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><link rel=icon href="data:,"><title>${title}</title><style>html,body{margin:0;width:100%;height:100%;background:#111;color:#fff;font:14px system-ui}main{height:100%;display:grid;place-items:center;align-content:center;gap:4px;text-align:center}canvas{display:block;width:min(100vw,calc((100vh - 24px)*4/3));height:auto;aspect-ratio:4/3;touch-action:none}p{margin:0;opacity:.7}</style><main><canvas width=800 height=600></canvas><p>Arrows/WASD · Space · Mouse/Touch · R restarts</p></main><script>${runtime}</script>`;
}

export default makeHtml;
