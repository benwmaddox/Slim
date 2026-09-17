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
      return {
        frequency: {},
        connect() {},
        start() {},
        stop() {}
      };
    }
    createGain() {
      return {
        gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}},
        connect() {}
      };
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
