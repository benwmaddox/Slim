import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDetailed, parseProgram} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

function wasmRuntime(source, globalStorage = 'globals', input = () => 0) {
  const detailed = compileDetailed(source, {globalStorage});
  assert.ok(WebAssembly.validate(detailed.wasm));
  const module = new WebAssembly.Module(detailed.wasm);
  const instance = new WebAssembly.Instance(module, {e: {input}});
  return {detailed, instance: instance.exports};
}

function javascriptRuntime(source, precision = 'native', input = () => 0) {
  const result = compileJavaScript(source, {precision});
  const factory = Function(`return (${result.code});`)();
  return {result, runtime: factory({input})};
}

const source = `
  const COUNT = 3;
  const COLORS = [0.1, 0.2, 0.3];
  global values = [4; COUNT];
  global result = 0;
  fn init() { values[1] = 9; }
  fn frame() {
    let index = input(0);
    result = COLORS[1] + values[index];
    return result;
  }
`;

test('parses fixed arrays into shared metadata and initializes mutable data before init', () => {
  const program = parseProgram(source);
  assert.deepEqual(program.arrays.map((array) => ({
    name: array.name,
    mutable: array.mutable,
    length: array.length,
    values: array.values,
  })), [
    {name: 'COLORS', mutable: false, length: 3, values: [0.1, 0.2, 0.3].map(Math.fround)},
    {name: 'values', mutable: true, length: 3, values: [4, 4, 4]},
  ]);

  for (const storage of ['globals', 'memory']) {
    const {detailed, instance} = wasmRuntime(source, storage, () => 1);
    assert.deepEqual(detailed.arrayLayout.map(({name, length, byteLength, mutable, materialized, offset}) => ({
      name, length, byteLength, mutable, materialized, offset,
    })), [
      {name: 'COLORS', length: 3, byteLength: 12, mutable: false, materialized: false, offset: null},
      {name: 'values', length: 3, byteLength: 12, mutable: true, materialized: true, offset: storage === 'globals' ? 0 : 4},
    ]);
    instance.init();
    assert.equal(instance.frame(), Math.fround(Math.fround(0.2) + 9));
    const values = new Float32Array(instance.memory.buffer, storage === 'globals' ? 0 : 4, 3);
    assert.deepEqual([...values], [4, 9, 4]);
  }
});

test('inlines static const reads and materializes const arrays only for dynamic reads', () => {
  const staticSource = `
    const DATA = [8, 9];
    fn init() {}
    fn frame() { return DATA[1]; }
  `;
  const staticDetailed = compileDetailed(staticSource);
  assert.equal(staticDetailed.arrayLayout[0].materialized, false);
  assert.equal(staticDetailed.arrayLayout[0].offset, null);
  assert.equal(staticDetailed.wasm.includes(0x2a), false);
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(staticDetailed.wasm)).exports.frame(), 9);

  const dynamicSource = `
    const DATA = [8, 9];
    fn init() {}
    fn frame() { return DATA[input(0)]; }
  `;
  const dynamicDetailed = compileDetailed(dynamicSource);
  assert.equal(dynamicDetailed.arrayLayout[0].materialized, true);
  assert.equal(dynamicDetailed.arrayLayout[0].offset, 0);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(dynamicDetailed.wasm), {e: {input: () => 1}});
  assert.equal(instance.exports.frame(), 9);
});

test('checks dynamic indexes once and evaluates assignment values afterward on all backends', () => {
  const orderSource = `
    global cursor = 0;
    global values = [10, 20];
    fn next_index() { cursor = cursor + 1; return 1; }
    fn next_value() { cursor = cursor + 10; return 7; }
    fn init() {}
    fn frame() {
      values[next_index()] = next_value();
      return cursor + values[1];
    }
  `;
  const wasm = wasmRuntime(orderSource, 'globals');
  assert.equal(wasm.instance.frame(), 18);
  const js = javascriptRuntime(orderSource, 'native');
  assert.equal(js.runtime.frame(), 18);
  const f32 = javascriptRuntime(orderSource, 'f32');
  assert.equal(f32.runtime.frame(), 18);
});

test('does not evaluate a dynamic array assignment value after an invalid index', () => {
  const source = `
    global values = [10, 20];
    fn init() {}
    fn frame() { values[input(0)] = input(1); }
  `;
  for (const storage of ['globals', 'memory']) {
    const calls = [];
    const runtime = wasmRuntime(source, storage, (index) => {
      calls.push(index);
      return index === 0 ? 2 : 7;
    });
    assert.throws(() => runtime.instance.frame(), /unreachable/);
    assert.deepEqual(calls, [0], `${storage} RHS must be skipped`);
  }
  for (const precision of ['native', 'f32']) {
    const calls = [];
    const runtime = javascriptRuntime(source, precision, (index) => {
      calls.push(index);
      return index === 0 ? 2 : 7;
    });
    assert.throws(() => runtime.runtime.frame(), RangeError);
    assert.deepEqual(calls, [0], `${precision} RHS must be skipped`);
  }
});

test('accepts negative zero index and rejects nonfinite, fractional, and out of range indexes', () => {
  const checkedSource = `
    global values = [31, 47];
    fn init() {}
    fn frame() { return values[input(0)]; }
  `;
  for (const value of [-0, 0, 1]) {
    assert.equal(wasmRuntime(checkedSource, 'globals', () => value).instance.frame(), value === 1 ? 47 : 31);
    assert.equal(javascriptRuntime(checkedSource, 'native', () => value).runtime.frame(), value === 1 ? 47 : 31);
    assert.equal(javascriptRuntime(checkedSource, 'f32', () => value).runtime.frame(), value === 1 ? 47 : 31);
  }
  for (const value of [-1, 2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => wasmRuntime(checkedSource, 'globals', () => value).instance.frame(), /unreachable|integer|out of bounds/i);
    assert.throws(() => javascriptRuntime(checkedSource, 'native', () => value).runtime.frame(), RangeError);
    assert.throws(() => javascriptRuntime(checkedSource, 'f32', () => value).runtime.frame(), RangeError);
  }
});

test('rejects static bad indexes, writes to const arrays, bare values, shadowed scalars, and unsupported shapes', () => {
  const prefix = 'fn init() {} fn frame() { return 0; }';
  for (const index of ['-1', '2', '1.5', '0 / 0', '1 / 0']) {
    assert.throws(
      () => compileDetailed(`const DATA = [1, 2]; ${prefix.replace('return 0', `return DATA[${index}]`)}`),
      /array .*index is out of bounds/i,
    );
  }
  assert.throws(
    () => compileDetailed(`const DATA = [1]; fn init() {} fn frame() { DATA[0] = 2; }`),
    /cannot assign to constant array/i,
  );
  assert.throws(
    () => compileDetailed(`const DATA = [1]; fn init() {} fn frame() { return DATA; }`),
    /requires an index/i,
  );
  assert.throws(
    () => compileDetailed(`const DATA = [1]; fn read(DATA) { return DATA[0]; } fn init() {} fn frame() { return read(2); }`),
    /cannot index shadowed scalar/i,
  );
  assert.throws(
    () => compileDetailed(`global DATA = [1]; global DATA = [2]; ${prefix}`),
    /duplicate global/i,
  );
  assert.throws(
    () => compileDetailed(`const DATA = [1]; const DATA = [2]; ${prefix}`),
    /duplicate array/i,
  );
  assert.throws(
    () => compileDetailed(`global DATA = [[1]]; ${prefix}`),
    /expected expression/i,
  );
  assert.throws(
    () => compileDetailed(`global DATA = [1; 1.5]; ${prefix}`),
    /repeat length must be a finite nonnegative integer/i,
  );
});

test('keeps arrays and scalar memory slots nonoverlapping across page boundaries', () => {
  const source = `
    global scalar = 4;
    global values = [3; 16384];
    fn init() {}
    fn frame() { return scalar + values[16383]; }
  `;
  const detailed = compileDetailed(source, {globalStorage: 'memory'});
  assert.equal(detailed.arrayLayout[0].offset, 4);
  assert.equal(detailed.memoryPages, 2);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(detailed.wasm));
  assert.equal(instance.exports.frame(), 7);
  const memory = new Float32Array(instance.exports.memory.buffer);
  assert.equal(memory[0], 4);
  assert.equal(memory[1], 3);
  assert.equal(memory[16384], 3);
});

test('enforces the total fixed array element limit at the exact boundary', () => {
  const exact = `
    global values = [6; 65536];
    fn init() {}
    fn frame() { return values[65535]; }
  `;
  const globals = compileDetailed(exact);
  assert.equal(globals.totalArrayElements, 65536);
  assert.equal(globals.maxArrayElements, 65536);
  assert.equal(globals.memoryPages, 4);
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(globals.wasm)).exports.frame(), 6);
  const memory = compileDetailed(exact.replace('global values', 'global scalar = 1; global values'), {globalStorage: 'memory'});
  assert.equal(memory.arrayLayout[0].offset, 4);
  assert.equal(memory.memoryPages, 5);
  assert.throws(
    () => compileDetailed('global first = [0; 65536]; global second = [0; 1]; fn init() {} fn frame() {}'),
    /fixed array element limit is 65536/,
  );
});

test('allows zero length arrays but every access remains a runtime failure', () => {
  const source = 'global values = [0; 0]; fn init() {} fn frame() { return values[input(0)]; }';
  const detailed = compileDetailed(source);
  assert.equal(detailed.arrayLayout[0].length, 0);
  assert.equal(detailed.arrayLayout[0].byteLength, 0);
  assert.throws(
    () => new WebAssembly.Instance(new WebAssembly.Module(detailed.wasm), {e: {input: () => 0}}).exports.frame(),
    /unreachable/,
  );
  assert.throws(
    () => javascriptRuntime(source).runtime.frame(),
    RangeError,
  );
});
