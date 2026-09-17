import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

function makeJavaScriptRuntime(source, imports = {}, precision = 'native') {
  const result = compileJavaScript(source, {precision});
  const factory = Function(`return (${result.code});`)();
  assert.equal(typeof factory, 'function');
  return {result, runtime: factory(imports)};
}

function makeWasmRuntime(source, imports = {}) {
  const module = new WebAssembly.Module(compile(source));
  return new WebAssembly.Instance(module, imports).exports;
}

test('generates a factory with the same mutable state and entry behavior as WASM', () => {
  const source = `
    global value = 2;
    fn twice(x) { return x * 2; }
    fn init() { value = 3; }
    fn frame() { value = twice(value) + 1; return value; }
  `;
  const {runtime} = makeJavaScriptRuntime(source);
  runtime.init();
  assert.equal(runtime.frame(), 7);
  assert.equal(runtime.frame(), 15);
});

test('native precision is labeled and keeps JavaScript double arithmetic', () => {
  const source = 'fn init() {} fn frame() { return 16777216 + 1 - 16777216; }';
  const native = makeJavaScriptRuntime(source, {}, 'native');
  const f32 = makeJavaScriptRuntime(source, {}, 'f32');
  assert.equal(native.result.precision, 'native');
  assert.equal(f32.result.precision, 'f32');
  assert.equal(native.runtime.frame(), 1);
  assert.equal(f32.runtime.frame(), 0);
  assert.equal(native.result.imports.length, 0);
});

test('f32 precision matches WASM for literals, calls, control flow, and modulo', () => {
  const source = `
    global value = 1.25;
    fn adjust(v) { return v * 1.1; }
    fn init() { value = adjust(value); }
    fn frame() {
      value = value + input(0);
      if (value > 5 && input(1) > 0) {
        sound(2, value, 0.25);
      }
      return value % 3;
    }
  `;
  const input = (index) => index === 0 ? 2.75 : 1;
  const jsSounds = [];
  const wasmSounds = [];
  // The factory consumes the host object directly; use a fresh runtime with
  // the same callbacks for each backend so state and event order are clear.
  const jsRuntime = makeJavaScriptRuntime(source, {
    input,
    sound: (...args) => jsSounds.push(args),
  }, 'f32').runtime;
  const wasmRuntime = makeWasmRuntime(source, {
    e: {
      input,
      sound: (...args) => wasmSounds.push(args),
    },
  });
  jsRuntime.init();
  wasmRuntime.init();
  assert.equal(Object.is(jsRuntime.frame(), wasmRuntime.frame()), true);
  assert.deepEqual(jsSounds, wasmSounds);
  assert.equal(jsRuntime.frame(), wasmRuntime.frame());
});

test('binds tri, sound, and input callbacks and prunes unreachable functions/imports', () => {
  const source = `
    fn dead() {
      tri(0, 0, 1, 0, 0, 1, 1, 0, 0);
      sound(1, 1, 1);
    }
    fn init() {}
    fn frame() {
      tri(1, 2, 3, 4, 5, 6, 0.1, 0.2, 0.3);
      sound(2, 1.5, 0.25);
      return input(8);
    }
  `;
  const calls = [];
  const {result, runtime} = makeJavaScriptRuntime(source, {
    tri: (...args) => { calls.push(['tri', args]); return 0; },
    sound: (...args) => { calls.push(['sound', args]); return 0; },
    input: (index) => { calls.push(['input', index]); return 8; },
  });
  assert.deepEqual(result.imports, ['tri', 'sound', 'input']);
  assert.equal(result.code.includes('function fn_init_0'), true);
  assert.equal(result.code.includes('dead'), false);
  assert.equal(runtime.frame(), 8);
  assert.deepEqual(calls, [
    ['tri', [1, 2, 3, 4, 5, 6, 0.1, 0.2, 0.3]],
    ['sound', [2, 1.5, 0.25]],
    ['input', 8],
  ]);
});

test('short-circuits imports, preserves NaN truth, and handles negative zero', () => {
  const calls = [];
  const source = `
    fn init() {}
    fn frame() {
      let skipped = (0 && input(0)) + (1 || input(1));
      if (input(2) && 1) {
        return skipped + (!input(3));
      }
      return skipped;
    }
  `;
  const {runtime} = makeJavaScriptRuntime(source, {
    input: (index) => {
      calls.push(index);
      if (index === 2) return Number.NaN;
      if (index === 3) return -0;
      return 9;
    },
  });
  assert.equal(runtime.frame(), 2);
  assert.deepEqual(calls, [2, 3]);
});

test('functions without returns produce numeric zero and f32 callbacks round results', () => {
  const source = `
    fn helper() { input(0); }
    fn init() {}
    fn frame() { helper(); }
  `;
  const {runtime} = makeJavaScriptRuntime(source, {
    input: () => 7,
  }, 'f32');
  assert.equal(runtime.frame(), 0);
});

test('rejects unsupported precision without changing compiler diagnostics', () => {
  assert.throws(
    () => compileJavaScript('fn init() {} fn frame() {}', {precision: 'decimal'}),
    /Slim JavaScript compile error: unsupported precision "decimal"/,
  );
  assert.throws(
    () => compileJavaScript('fn init() {}'),
    /Slim compile error at 1:1: missing required exported function "frame"/,
  );
});
