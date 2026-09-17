import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {compile} from '../src/compiler.mjs';
import {makeHtml, makeJavaScriptHtml} from '../src/host.mjs';

const inputSource = 'fn init() {} fn frame() { input(0); }';
const soundSource = 'fn init() {} fn frame() { sound(0, 0, 0); }';
const jsFactory = '(e => { captureHost(e); return {init() {}, frame() {}} })';

function scriptOf(page) {
  return page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
}

async function bootPage(page, {audio = false, javascript = false} = {}) {
  const globalHandlers = new Map();
  const canvasHandlers = new Map();
  const audioStats = {contexts: 0, oscillators: 0};
  const audioNodes = [];
  let capturedImports;
  let frameCallback;
  const captureHost = (host) => { capturedImports = host; };
  const listen = (map, type, handler) => {
    const handlers = map.get(type) || [];
    handlers.push(handler);
    map.set(type, handlers);
  };
  const canvas = {
    addEventListener(type, handler) { listen(canvasHandlers, type, handler); },
    getBoundingClientRect() { return {left: 0, top: 0, width: 800, height: 600}; },
    setPointerCapture() {}
  };
  const dispatch = (map, type, event) => {
    for (const handler of map.get(type) || []) handler(event);
  };
  class AudioContextMock {
    constructor() {
      audioStats.contexts += 1;
      this.currentTime = 0;
      this.destination = {};
    }
    createOscillator() {
      audioStats.oscillators += 1;
      const node = {
        kind: 'oscillator', type: '', frequency: {value: 0, sets: [], ramps: []},
        connections: [], starts: [], stops: [], connected: false, disconnected: false, onended: null,
        connect(target) { this.connections.push(target); this.connected = true; },
        disconnect() { this.connected = false; this.disconnected = true; },
        start(time) { this.starts.push(time); },
        stop(time) { this.stops.push(time); }
      };
      node.frequency.setValueAtTime = (value, time) => node.frequency.sets.push([value, time]);
      node.frequency.exponentialRampToValueAtTime = (value, time) => node.frequency.ramps.push([value, time]);
      node.frequency.linearRampToValueAtTime = (value, time) => node.frequency.ramps.push([value, time]);
      audioNodes.push(node);
      return node;
    }
    createGain() {
      const node = {
        kind: 'gain', gain: {value: 0, sets: [], ramps: []},
        connections: [], connected: false, disconnected: false,
        connect(target) { this.connections.push(target); this.connected = true; },
        disconnect() { this.connected = false; this.disconnected = true; }
      };
      node.gain.setValueAtTime = (value, time) => node.gain.sets.push([value, time]);
      node.gain.exponentialRampToValueAtTime = (value, time) => node.gain.ramps.push([value, time]);
      node.gain.linearRampToValueAtTime = (value, time) => node.gain.ramps.push([value, time]);
      audioNodes.push(node);
      return node;
    }
    resume() {}
  }
  const browser = {
    document: {querySelector(selector) {
      assert.equal(selector, 'canvas');
      return canvas;
    }},
    WebAssembly: {
      instantiate(_bytes, imports) {
        capturedImports = imports;
        return Promise.resolve({instance: {exports: {init() {}, frame() {}}}});
      }
    },
    atob: globalThis.atob,
    performance: {now: () => 0},
    requestAnimationFrame(callback) {
      frameCallback = callback;
      return 1;
    },
    captureHost,
    addEventListener(type, handler) { listen(globalHandlers, type, handler); },
    AudioContext: audio ? AudioContextMock : undefined,
    webkitAudioContext: undefined,
    console,
    Error,
    Math,
    Promise,
    Uint8Array,
    Float32Array
  };
  browser.window = browser;
  const context = vm.createContext(browser);
  vm.runInContext(scriptOf(page), context, {filename: 'slim-generated-host.js'});
  await new Promise((resolve) => setImmediate(resolve));
  if (javascript) capturedImports = {e: capturedImports};
  assert.ok(capturedImports, 'generated host should initialize a host object');
  assert.equal(typeof frameCallback, 'function');
  return {
    page,
    imports: capturedImports,
    audioStats,
    audioNodes,
    finishAudio: () => {
      for (const node of audioNodes) if (typeof node.onended === 'function') node.onended();
    },
    tick: () => frameCallback(1000 / 60),
    globalEventTypes: () => [...globalHandlers.keys()],
    canvasEventTypes: () => [...canvasHandlers.keys()],
    dispatchGlobal: (type, event) => dispatch(globalHandlers, type, event),
    dispatchCanvas: (type, event) => dispatch(canvasHandlers, type, event)
  };
}

async function boot(source, options = {}) {
  return bootPage(makeHtml(compile(source), {title: 'host test', keyboardOnly: options.keyboardOnly}), options);
}

async function bootJavaScript(imports, options = {}) {
  return bootPage(makeJavaScriptHtml(jsFactory, {title: 'host test', imports, keyboardOnly: options.keyboardOnly}), {...options, javascript: true});
}

function keyboard(key, code = key, repeat = false) {
  return {key, code, repeat, preventDefault() {}};
}

function pointer(button = 0) {
  return {button, pointerId: 1, clientX: 400, clientY: 300};
}

test('input-only host pointerdown has no undefined audio unlock reference', async () => {
  const host = await boot(inputSource);
  assert.equal(host.page.includes('function sound'), false);
  assert.doesNotThrow(() => host.dispatchCanvas('pointerdown', pointer()));
});

test('mouse movement does not make Space report pointer-active', async () => {
  const host = await boot(inputSource);
  host.dispatchCanvas('pointermove', pointer(-1));
  host.dispatchGlobal('keydown', keyboard(' ', 'Space'));
  assert.equal(host.imports.e.input(4), 1);
  assert.equal(host.imports.e.input(8), 0);
});

test('direction keys do not set the primary pressed edge', async () => {
  const host = await boot(inputSource);
  host.dispatchGlobal('keydown', keyboard('ArrowLeft'));
  assert.equal(host.imports.e.input(0), 1);
  assert.equal(host.imports.e.input(5), 0);
});

test('JavaScript factory shares the input host contract', async () => {
  const hosts = [await boot(inputSource), await bootJavaScript(['input'])];
  for (const host of hosts) {
    host.dispatchCanvas('pointermove', pointer(-1));
    host.dispatchGlobal('keydown', keyboard(' ', 'Space'));
    assert.equal(host.imports.e.input(4), 1);
    assert.equal(host.imports.e.input(8), 0);
  }
});

test('pointercancel clears pointer-held input even with button -1', async () => {
  const host = await boot(inputSource);
  host.dispatchCanvas('pointerdown', pointer());
  assert.equal(host.imports.e.input(8), 1);
  host.dispatchCanvas('pointercancel', pointer(-1));
  assert.equal(host.imports.e.input(8), 0);
  assert.equal(host.imports.e.input(4), 0);
});

test('zero-gain sound does not construct audio or oscillator nodes', async () => {
  const hosts = [await boot(soundSource, {audio: true}), await bootJavaScript(['sound'], {audio: true})];
  for (const host of hosts) {
    host.imports.e.sound(0, 0, 0);
    assert.deepEqual(host.audioStats, {contexts: 0, oscillators: 0});
    host.imports.e.sound(0, 0, 0.5);
    assert.deepEqual(host.audioStats, {contexts: 1, oscillators: 1});
  }
});

test('sound presets schedule finite, distinct musical gestures', async () => {
  const host = await boot(soundSource, {audio: true});
  for (let event = 0; event <= 4; event += 1) host.imports.e.sound(event, 0, 0.5);

  const oscillators = host.audioNodes.filter((node) => node.kind === 'oscillator');
  assert.equal(oscillators.length, 10, 'the five presets should expand to their planned voices');
  assert.equal(oscillators[0].type, 'triangle');
  assert.ok(oscillators[0].frequency.ramps[0][0] > oscillators[0].frequency.sets[0][0], 'jump should rise in pitch');

  const pickup = oscillators.slice(1, 3);
  assert.equal(new Set(pickup.map((node) => node.type)).size, 2, 'pickup should layer bright waveforms');
  assert.ok(new Set(pickup.map((node) => node.starts[0])).size > 1, 'pickup voices should have a small offset');

  const loss = oscillators[3];
  assert.equal(loss.type, 'sawtooth');
  assert.ok(loss.frequency.ramps[0][0] < loss.frequency.sets[0][0], 'loss should descend in pitch');

  const win = oscillators.slice(4, 8);
  assert.equal(win.length, 4, 'win should be a short arpeggio');
  assert.ok(new Set(win.map((node) => node.frequency.sets[0][0])).size >= 3, 'win should contain a chord');
  assert.ok(new Set(win.map((node) => node.starts[0])).size >= 3, 'win notes should be staggered');

  for (const node of oscillators) {
    for (const [value, time] of [...node.frequency.sets, ...node.frequency.ramps]) {
      assert.ok(Number.isFinite(value), `${node.kind} schedule value should be finite`);
      assert.ok(Number.isFinite(time), `${node.kind} schedule time should be finite`);
    }
    assert.ok(node.frequency.sets[0][0] > 0, 'oscillator frequency should stay positive');
    assert.ok(node.stops[0] > node.starts[0], 'oscillator should have a finite release');
  }
  for (const node of host.audioNodes.filter((node) => node.kind === 'gain')) {
    for (const [value, time] of [...node.gain.sets, ...node.gain.ramps]) {
      assert.ok(Number.isFinite(value), 'gain schedule value should be finite');
      assert.ok(Number.isFinite(time), 'gain schedule time should be finite');
    }
  }
});

test('sound voice count stays bounded and ended nodes disconnect', async () => {
  const host = await boot(soundSource, {audio: true});
  for (let index = 0; index < 12; index += 1) host.imports.e.sound(3, index, 0.5);

  const connected = () => host.audioNodes.filter((node) => node.connected);
  assert.ok(connected().filter((node) => node.kind === 'oscillator').length <= 8, 'active oscillator voices should be capped');
  assert.ok(host.audioNodes.some((node) => node.disconnected), 'old voices should be disconnected when the cap is reached');
  host.finishAudio();
  assert.equal(connected().length, 0, 'ended oscillator and gain nodes should be disconnected');
});

test('sound clamps pitch and gain before scheduling WebAudio parameters', async () => {
  const host = await boot(soundSource, {audio: true});
  host.imports.e.sound(0, 100000, 10);
  host.imports.e.sound(2, -100000, 0.5);
  host.imports.e.sound(1, Number.NaN, Number.NaN);

  const oscillators = host.audioNodes.filter((node) => node.kind === 'oscillator');
  assert.equal(oscillators.length, 2, 'invalid gain should remain silent');
  for (const node of oscillators) {
    assert.ok(node.frequency.sets[0][0] > 0);
    assert.ok(node.frequency.sets[0][0] < 10000);
  }
  for (const node of host.audioNodes.filter((node) => node.kind === 'gain')) {
    assert.ok(node.gain.ramps.every(([value]) => value > 0 && value <= 1));
  }
});

test('pointer gesture unlocks one shared audio context', async () => {
  const host = await boot(soundSource, {audio: true});
  assert.equal(host.audioStats.contexts, 0);
  host.dispatchCanvas('pointerdown', pointer());
  host.dispatchGlobal('keydown', keyboard('ArrowLeft'));
  host.imports.e.sound(3, 0, 0.5);
  assert.equal(host.audioStats.contexts, 1);
});

test('keyboard-only WASM and JavaScript hosts expose keyboard input without pointer state', async () => {
  const hosts = [await boot(inputSource, {keyboardOnly: true}), await bootJavaScript(['input'], {keyboardOnly: true})];
  for (const host of hosts) {
    assert.equal(host.page.includes('pointerdown'), false);
    assert.equal(host.page.includes('pointermove'), false);
    assert.equal(host.page.includes('pointerup'), false);
    assert.equal(host.page.includes('pointercancel'), false);
    assert.equal(host.page.includes('setPointerCapture'), false);
    assert.equal(host.page.includes('getBoundingClientRect'), false);
    assert.equal(host.page.includes('Arrows/A-D: move · Space: jump · R: restart'), true);
    assert.deepEqual(host.canvasEventTypes(), []);

    host.dispatchGlobal('keydown', keyboard('ArrowLeft'));
    assert.equal(host.imports.e.input(0), 1);
    assert.equal(host.imports.e.input(5), 0);
    assert.equal(host.imports.e.input(6), 0);
    assert.equal(host.imports.e.input(7), 0);
    assert.equal(host.imports.e.input(8), 0);

    host.dispatchGlobal('keydown', keyboard(' ', 'Space'));
    assert.equal(host.imports.e.input(4), 1);
    assert.equal(host.imports.e.input(5), 1);
    host.dispatchGlobal('keydown', keyboard(' ', 'Space', true));
    assert.equal(host.imports.e.input(5), 1);
    host.tick();
    assert.equal(host.imports.e.input(5), 0);
    host.dispatchGlobal('keydown', keyboard(' ', 'Space'));
    assert.equal(host.imports.e.input(5), 1);

    host.dispatchGlobal('keydown', keyboard('r'));
    assert.equal(host.imports.e.input(9), 1);
    host.dispatchGlobal('keydown', keyboard('r', 'r', true));
    assert.equal(host.imports.e.input(9), 1);
    host.dispatchGlobal('blur', {});
    for (let index = 0; index <= 9; index += 1) assert.equal(host.imports.e.input(index), 0, `input(${index}) after blur`);
  }
});

test('keyboard-only sound unlock listens for keydown without pointer unlock', async () => {
  const hosts = [await boot(soundSource, {audio: true, keyboardOnly: true}), await bootJavaScript(['sound'], {audio: true, keyboardOnly: true})];
  for (const host of hosts) {
    assert.equal(host.page.includes('addEventListener("pointerdown",unlock)'), false);
    assert.deepEqual(host.globalEventTypes(), ['keydown']);
    host.dispatchGlobal('keydown', keyboard('ArrowLeft'));
    assert.equal(host.audioStats.contexts, 1);
  }
});

test('default host keeps pointer controls and the original footer', async () => {
  const host = await boot(inputSource);
  assert.equal(host.page.includes('Arrows/WASD · Space · Mouse/Touch · R restarts'), true);
  assert.deepEqual(host.canvasEventTypes(), ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']);
});
