import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.mjs';
import {
  MINIFIED_WASM_EXPORT_NAMES,
  MINIFIED_WASM_IMPORT_NAMES,
} from '../src/host.mjs';
import {minifyWasmInterface} from '../tools/wasm-interface.mjs';

const source = `
fn init() {}
fn frame() {
  let value = sin(0) + cos(0) + atan2(0, 1) + pow(2, 1);
  input(0);
  tri(0, 0, 1, 0, 0, 1, 1, 1, 1);
  sound(0, value, .5);
  text(0, 0, 0, 8, 0);
}`;

function varUint(value) {
  const result = [];
  do {
    const low = value & 0x7f;
    value >>>= 7;
    result.push(low | (value ? 0x80 : 0));
  } while (value);
  return result;
}

function appendCustomSection(wasm, name, data = []) {
  const nameBytes = new TextEncoder().encode(name);
  const payload = [...varUint(nameBytes.length), ...nameBytes, ...data];
  return Uint8Array.from([...wasm, 0, ...varUint(payload.length), ...payload]);
}

function executionTrace(wasm, minified) {
  const module = new WebAssembly.Module(wasm);
  const calls = [];
  const callbacks = {
    tri(...args) { calls.push(['tri', ...args]); return 0; },
    sound(...args) { calls.push(['sound', ...args]); return 0; },
    input(index) { calls.push(['input', index]); return 7; },
    text(...args) { calls.push(['text', ...args]); return 0; },
    sin: Math.sin,
    cos: Math.cos,
    atan2: Math.atan2,
    pow: Math.pow,
  };
  const imports = {e: {}};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const sourceName = minified
      ? Object.keys(MINIFIED_WASM_IMPORT_NAMES).find((name) => MINIFIED_WASM_IMPORT_NAMES[name] === descriptor.name)
      : descriptor.name;
    const fieldName = minified ? MINIFIED_WASM_IMPORT_NAMES[sourceName] : sourceName;
    imports[descriptor.module][fieldName] = callbacks[sourceName];
  }
  const game = new WebAssembly.Instance(module, imports).exports;
  const initName = minified ? MINIFIED_WASM_EXPORT_NAMES.init : 'init';
  const frameName = minified ? MINIFIED_WASM_EXPORT_NAMES.frame : 'frame';
  game[initName]();
  game[frameName]();
  return calls;
}

test('shipping WASM interface preserves execution while compacting only the external ABI', () => {
  const original = compile(source);
  const originalCopy = new Uint8Array(original);
  const originalModule = new WebAssembly.Module(original);
  assert.deepEqual(WebAssembly.Module.exports(originalModule).map(({name, kind}) => [name, kind]), [
    ['init', 'function'],
    ['frame', 'function'],
    ['memory', 'memory'],
  ]);

  const compact = minifyWasmInterface(original);
  assert.deepEqual(original, originalCopy, 'the public compiler output must remain unchanged');
  assert.ok(WebAssembly.validate(compact));
  const compactModule = new WebAssembly.Module(compact);
  assert.deepEqual(WebAssembly.Module.imports(compactModule).map(({module, name, kind}) => [module, name, kind]), [
    ['e', 'a', 'function'],
    ['e', 'b', 'function'],
    ['e', 'c', 'function'],
    ['e', 'd', 'function'],
    ['e', 'e', 'function'],
    ['e', 'f', 'function'],
    ['e', 'g', 'function'],
    ['e', 'h', 'function'],
  ]);
  assert.deepEqual(WebAssembly.Module.exports(compactModule).map(({name, kind}) => [name, kind]), [
    ['a', 'function'],
    ['b', 'function'],
  ]);
  assert.deepEqual(executionTrace(compact, true), executionTrace(original, false));
});

test('shipping WASM interface removes name metadata and preserves unrelated custom sections', () => {
  const original = compile(source);
  const withMetadata = appendCustomSection(appendCustomSection(original, 'name'), 'app-metadata', [1, 2, 3]);
  assert.ok(WebAssembly.validate(withMetadata));

  const compact = minifyWasmInterface(withMetadata);
  const module = new WebAssembly.Module(compact);
  assert.equal(WebAssembly.Module.customSections(module, 'name').length, 0);
  const metadata = WebAssembly.Module.customSections(module, 'app-metadata');
  assert.equal(metadata.length, 1);
  assert.deepEqual([...new Uint8Array(metadata[0])], [1, 2, 3]);
});

test('shipping WASM interface rejects malformed input', () => {
  assert.throws(() => minifyWasmInterface(new Uint8Array([0, 97, 115, 109])), TypeError);
  assert.throws(() => minifyWasmInterface(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 7, 0x80])), TypeError);
});
