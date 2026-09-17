import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compile, compileDetailed} from '../src/compiler.mjs';

function instantiate(source, globalStorage, input = () => 0) {
  const detailed = compileDetailed(source, {globalStorage});
  assert.ok(WebAssembly.validate(detailed.wasm));
  const module = new WebAssembly.Module(detailed.wasm);
  const imports = {e: {input, tri: () => 0, sound: () => 0}};
  const instance = new WebAssembly.Instance(module, imports);
  return {detailed, module, instance};
}

function f32Bytes(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return [...bytes];
}

test('memory storage initializes active data before init and keeps public exports', () => {
  const source = `
    global first = 1.5;
    global second = -2;
    fn init() { first = first + 1; }
    fn frame() { second = second + first; return second; }
  `;
  const globals = compileDetailed(source);
  const memory = instantiate(source, 'memory');

  assert.deepEqual([...compile(source)], [...globals.wasm], 'default compile bytes must stay on the globals ABI');
  assert.equal(memory.detailed.globalStorage, 'memory');
  assert.deepEqual(memory.detailed.globalLayout, [
    {name: 'first', offset: 0},
    {name: 'second', offset: 4},
  ]);
  assert.deepEqual(WebAssembly.Module.exports(memory.module), [
    {name: 'init', kind: 'function'},
    {name: 'frame', kind: 'function'},
    {name: 'memory', kind: 'memory'},
  ]);
  assert.deepEqual([...new Uint8Array(memory.instance.exports.memory.buffer, 0, 8)], [
    ...f32Bytes(1.5), ...f32Bytes(-2),
  ], 'active data must be present before init runs');

  memory.instance.exports.init();
  assert.equal(memory.instance.exports.frame(), 0.5);
  assert.equal(memory.instance.exports.frame(), 3);
  assert.deepEqual([...new Float32Array(memory.instance.exports.memory.buffer, 0, 2)], [2.5, 3]);

  const manual = instantiate(source, 'memory');
  manual.instance.exports.init();
  const slots = new DataView(manual.instance.exports.memory.buffer);
  slots.setFloat32(0, 10, true);
  slots.setFloat32(4, 1, true);
  assert.equal(manual.instance.exports.frame(), 11, 'frame must read the documented byte offsets');
  assert.equal(slots.getFloat32(4, true), 11);
});

test('memory and module globals preserve function calls, branches, loops, imports, and one-time RHS evaluation', () => {
  const source = `
    global value = 1;
    fn add(amount) { value = value + amount; return value; }
    fn init() { value = 3; }
    fn frame() {
      let i = 0;
      while (i < 2) {
        value = add(input(i));
        i = i + 1;
      }
      if (value > 10) { value = value - 2; }
      else { value = value + 1; }
      value = value + input(7);
      return value;
    }
  `;
  for (const globalStorage of ['globals', 'memory']) {
    const calls = [];
    const {instance} = instantiate(source, globalStorage, (index) => {
      calls.push(index);
      return index === 0 ? 4 : index === 1 ? 6 : 2;
    });
    instance.exports.init();
    assert.equal(instance.exports.frame(), 13);
    assert.deepEqual(calls, [0, 1, 7]);
    assert.equal(instance.exports.frame(), 23, `${globalStorage} state must persist across frames`);
    assert.deepEqual(calls, [0, 1, 7, 0, 1, 7]);
  }

  const onceCalls = [];
  const once = instantiate(
    'global value = 0; fn init() {} fn frame() { value = input(value); return value; }',
    'memory',
    (index) => { onceCalls.push(index); return 9; },
  );
  assert.equal(once.instance.exports.frame(), 9);
  assert.deepEqual(onceCalls, [0], 'assignment RHS must be evaluated once');
});

test('locals and parameters shadow globals consistently in both storage modes', () => {
  const source = `
    global value = 40;
    fn add(value) { return value + 1; }
    fn init() {}
    fn frame() { let value = 2; return add(value) + value; }
  `;
  for (const globalStorage of ['globals', 'memory']) {
    const {instance} = instantiate(source, globalStorage);
    instance.exports.init();
    assert.equal(instance.exports.frame(), 5, globalStorage);
  }
});

test('memory storage preserves f32 rounding, NaN, and negative zero bit patterns', () => {
  const source = `
    global rounded = 16777216 + 1 - 16777216;
    global nan = 0 / 0;
    global negativeZero = -0;
    fn init() {}
    fn frame() { return negativeZero; }
  `;
  for (const globalStorage of ['globals', 'memory']) {
    const {instance} = instantiate(source, globalStorage);
    instance.exports.init();
    assert.ok(Object.is(instance.exports.frame(), -0));
    if (globalStorage === 'memory') {
      const values = new Float32Array(instance.exports.memory.buffer, 0, 3);
      assert.equal(values[0], 0);
      assert.ok(Number.isNaN(values[1]));
      assert.ok(Object.is(values[2], -0));
    }
  }

  const {instance, detailed} = instantiate(source, 'memory');
  const raw = new Uint8Array(instance.exports.memory.buffer, 0, 12);
  assert.deepEqual([...raw.slice(0, 4)], f32Bytes(0));
  assert.equal(raw[4], 0);
  assert.equal(raw[5], 0);
  assert.ok((raw[6] & 0x40) !== 0, 'NaN mantissa must be non-zero');
  assert.equal(raw[7] & 0x7f, 0x7f, 'NaN exponent must be encoded little-endian');
  assert.deepEqual([...raw.slice(8)], f32Bytes(-0));
  assert.deepEqual(detailed.globalLayout.at(-1), {name: 'negativeZero', offset: 8});
});

test('memory addresses remain valid at the signed LEB boundary and memory grows for large layouts', () => {
  const boundaryGlobals = Array.from({length: 17}, (_, index) => `global g${index} = ${index};`).join('\n');
  const boundary = instantiate(`${boundaryGlobals}\nfn init() {} fn frame() { g16 = g16 + 1; return g16; }`, 'memory');
  boundary.instance.exports.init();
  assert.equal(boundary.instance.exports.frame(), 17);
  assert.equal(new Float32Array(boundary.instance.exports.memory.buffer)[16], 17);
  assert.equal(boundary.detailed.globalLayout[16].offset, 64);

  const largeGlobals = Array.from({length: 16385}, (_, index) => `global g${index} = ${index};`).join('\n');
  const large = instantiate(`${largeGlobals}\nfn init() {} fn frame() { return g16384; }`, 'memory');
  assert.equal(large.instance.exports.memory.buffer.byteLength, 131072);
  assert.equal(large.instance.exports.frame(), 16384);
  assert.equal(large.detailed.globalLayout.at(-1).offset, 65536);
});

test('the original Rainbow source has identical draw and sound replays in both storage modes', async () => {
  const source = await readFile(new URL('../examples/rainbow.slim', import.meta.url), 'utf8');
  const replays = [
    {}, ...Array.from({length: 20}, () => ({1: 1})),
    {4: 1, 8: 1, 6: 180, 7: 160},
    {4: 1, 8: 1, 6: 400, 7: 290},
    {4: 1, 8: 1, 6: 620, 7: 420},
    {}, {9: 1},
    ...Array.from({length: 24}, () => ({4: 1, 8: 1, 6: 120, 7: 78})),
  ];

  const drivers = ['globals', 'memory'].map((globalStorage) => {
    let inputs = {};
    const events = [];
    const detailed = compileDetailed(source, {globalStorage});
    const instance = new WebAssembly.Instance(new WebAssembly.Module(detailed.wasm), {e: {
      input: (index) => inputs[index] || 0,
      tri: (...values) => { events.push(['tri', ...values]); return 0; },
      sound: (...values) => { events.push(['sound', ...values]); return 0; },
    }});
    instance.exports.init();
    return (nextInputs) => {
      inputs = nextInputs;
      events.length = 0;
      instance.exports.frame();
      return events.slice();
    };
  });

  for (const inputs of replays) {
    assert.deepEqual(drivers[1](inputs), drivers[0](inputs));
  }
});

test('global storage options reject unsupported values deterministically', () => {
  const source = 'fn init() {} fn frame() {}';
  assert.throws(() => compileDetailed(source, {globalStorage: 'heap'}), /globalStorage must be "globals" or "memory"/);
  assert.throws(() => compileDetailed(source, {unknown: true}), /unsupported option "unknown"/);
  assert.throws(() => compileDetailed(source, null), /options must be an object/);
});
