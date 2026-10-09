import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

const bitsBuffer = new ArrayBuffer(4);
const bitsView = new DataView(bitsBuffer);

function f32FromBits(bits) {
  bitsView.setUint32(0, bits >>> 0, true);
  return bitsView.getFloat32(0, true);
}

function bitsFromNumber(value) {
  bitsView.setFloat32(0, value, true);
  return bitsView.getUint32(0, true);
}

function sourceLiteralForBits(bits) {
  const value = f32FromBits(bits);
  if (Object.is(value, -0)) return '-0';
  return Number(value).toString();
}

function makeFiniteBitPatterns(count) {
  const patterns = [];
  const seen = new Set();
  let state = 0x12345678;
  while (patterns.length < count) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const bits = (state & 0x7f7fffff) | (state & 0x80000000);
    if (seen.has(bits)) continue;
    seen.add(bits);
    patterns.push(bits);
  }
  return patterns;
}

const fixedEntries = [
  {source: '0.95', bits: bitsFromNumber(0.95)},
  {source: '0.1', bits: bitsFromNumber(0.1)},
  {source: '-0', bits: 0x80000000},
  {source: '0 / 0', bits: 0x7fc00000},
  {source: '1 / 0', bits: 0x7f800000},
  {source: '-1 / 0', bits: 0xff800000},
  {bits: 0x00000001},
  {bits: 0x007fffff},
  {bits: 0x00800000},
  {bits: 0x7f7fffff},
];

const entries = [
  ...fixedEntries.map((entry) => ({
    ...entry,
    source: entry.source ?? sourceLiteralForBits(entry.bits),
  })),
  ...makeFiniteBitPatterns(128).map((bits) => ({bits, source: sourceLiteralForBits(bits)})),
];

const source = `
  const DATA = [${entries.map((entry) => entry.source).join(', ')}];
  fn init() {}
  fn frame() { return DATA[input(0)]; }
`;

function makeWasmRuntime() {
  let index = 0;
  const bytes = compile(source);
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {e: {input: () => index}});
  return {
    read(nextIndex) {
      index = nextIndex;
      return instance.exports.frame();
    },
  };
}

function makeJavaScriptRuntime(precision) {
  let index = 0;
  const result = compileJavaScript(source, {precision});
  const factory = Function(`return (${result.code});`)();
  const runtime = factory({input: () => index});
  return {
    result,
    read(nextIndex) {
      index = nextIndex;
      return runtime.frame();
    },
  };
}

test('dynamic constant array initializers round trip through native JS, f32 JS, and WASM', () => {
  const expected = entries.map((entry) => f32FromBits(entry.bits));
  const wasm = makeWasmRuntime();
  const native = makeJavaScriptRuntime('native');
  const f32 = makeJavaScriptRuntime('f32');

  assert.match(native.result.code, /new Float32Array\(\[0\.95, 0\.1, -0,/);
  assert.match(f32.result.code, /new Float32Array\(\[0\.95, 0\.1, -0,/);

  for (let index = 0; index < expected.length; index += 1) {
    const wasmValue = wasm.read(index);
    const nativeValue = native.read(index);
    const f32Value = f32.read(index);
    assert.ok(Object.is(wasmValue, expected[index]), `WASM value ${index}`);
    assert.ok(Object.is(nativeValue, expected[index]), `native JS value ${index}`);
    assert.ok(Object.is(f32Value, expected[index]), `f32 JS value ${index}`);
  }
});

test('shares a typed-array initializer helper without changing signed zero or mutable array ownership', () => {
  const zeroArray = compileJavaScript(`
    global values = [0; 2];
    fn init() {}
    fn frame() { return values[input(0)]; }
  `);
  assert.match(zeroArray.code, /new Float32Array\(2\)/);
  assert.doesNotMatch(zeroArray.code, /\.fill\(0\)/);

  const source = `
    const SIGN = [-0, 0.5];
    const EXTRA = [1, 2];
    global values = [0; 2];
    fn init() {}
    fn frame() {
      let index = input(0);
      if (index == 0) {
        return 1 / SIGN[index];
      }
      if (input(1)) {
        values[index] = input(2);
      }
      return EXTRA[index] + values[index];
    }
  `;

  for (const precision of ['native', 'f32']) {
    const result = compileJavaScript(source, {precision});
    assert.match(result.code, /const makeArray = \(values\) => new Float32Array\(values\);/);

    let input = [0, 0, 0];
    const factory = Function(`return (${result.code});`)();
    const first = factory({input: (index) => input[index]});
    const second = factory({input: (index) => input[index]});

    assert.equal(first.frame(), -Infinity, `${precision} preserves negative zero`);
    input = [1, 1, 5];
    assert.equal(first.frame(), 7, `${precision} initializes a fresh mutable array`);
    input = [1, 0, 0];
    assert.equal(first.frame(), 7, `${precision} keeps mutations in one runtime`);
    assert.equal(second.frame(), 2, `${precision} gives each runtime independent arrays`);
  }
});
