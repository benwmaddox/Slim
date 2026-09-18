import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDetailed} from '../src/compiler.mjs';

function f32Bits(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function runtime(source, options = {}, input = () => 0) {
  const detailed = compileDetailed(source, options);
  assert.ok(WebAssembly.validate(detailed.wasm));
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(detailed.wasm),
    {e: {input}},
  );
  return {detailed, instance: instance.exports};
}

test('selects exact narrowest signed and unsigned lanes and preserves their bytes', () => {
  const cases = [
    {name: 'SIGNED8', values: [-128, -1, 0, 127], encoding: 'i8', elementBytes: 1,
      bytes: [0x80, 0xff, 0x00, 0x7f]},
    {name: 'UNSIGNED8', values: [0, 127, 128, 255], encoding: 'u8', elementBytes: 1,
      bytes: [0x00, 0x7f, 0x80, 0xff]},
    {name: 'SIGNED16', values: [-32768, -129, -1, 32767], encoding: 'i16', elementBytes: 2,
      bytes: [0x00, 0x80, 0x7f, 0xff, 0xff, 0xff, 0xff, 0x7f]},
    {name: 'UNSIGNED16', values: [0, 255, 256, 65535], encoding: 'u16', elementBytes: 2,
      bytes: [0x00, 0x00, 0xff, 0x00, 0x00, 0x01, 0xff, 0xff]},
  ];

  for (const {name, values, encoding, elementBytes, bytes} of cases) {
    const source = `
      const ${name} = [${values.join(', ')}];
      fn init() {}
      fn frame() { return ${name}[input(0)]; }
    `;
    const {detailed, instance} = runtime(source, {integerArrayStorage: 'compact'}, () => 0);
    const layout = detailed.arrayLayout[0];
    assert.equal(detailed.integerArrayStorage, 'compact');
    assert.equal(layout.encoding, encoding);
    assert.equal(layout.elementBytes, elementBytes);
    assert.equal(layout.physicalByteLength, values.length * elementBytes);
    assert.equal(layout.byteLength, values.length * elementBytes);
    assert.deepEqual(
      [...new Uint8Array(instance.memory.buffer, layout.offset, layout.byteLength)],
      bytes,
      `${name} physical bytes`,
    );
    for (let index = 0; index < values.length; index += 1) {
      const lane = runtime(source, {integerArrayStorage: 'compact'}, () => index).instance.frame();
      assert.equal(f32Bits(lane), f32Bits(values[index]), `${name} lane ${index}`);
    }
  }
});

test('keeps mutable and non-exact immutable arrays in f32 storage', () => {
  const source = `
    global mutable = [1, 2];
    const FRACTION = [0.5, -0, 0 / 0, 65536];
    fn init() { mutable[1] = 9; }
    fn frame() { return FRACTION[input(0)] + mutable[input(1)]; }
  `;
  const {detailed, instance} = runtime(
    source,
    {globalStorage: 'memory', integerArrayStorage: 'compact'},
    (index) => index === 0 ? 0 : 1,
  );
  const [mutable, fraction] = detailed.arrayLayout;
  assert.equal(mutable.mutable, true);
  assert.equal(mutable.byteLength, 8);
  assert.equal(mutable.encoding, undefined);
  assert.equal(mutable.offset, 0);
  assert.equal(fraction.encoding, undefined);
  assert.equal(fraction.elementBytes, undefined);
  assert.equal(fraction.physicalByteLength, undefined);
  assert.equal(fraction.offset, 8);
  instance.init();
  assert.equal(instance.frame(), Math.fround(0.5 + 9));
  const memory = new DataView(instance.memory.buffer);
  assert.equal(memory.getFloat32(mutable.offset + 4, true), 9);
  assert.equal(memory.getFloat32(fraction.offset, true), 0.5);
  assert.equal(memory.getFloat32(fraction.offset + 4, true), -0);
  assert.ok(Number.isNaN(memory.getFloat32(fraction.offset + 8, true)));
});

test('keeps each non-compact integer eligibility failure in exact f32 storage', () => {
  const cases = [
    {source: ['0.5'], values: [0.5]},
    {source: ['-0', '0', '1'], values: [-0, 0, 1]},
    {source: ['0 / 0'], values: [Number.NaN]},
    {source: ['1 / 0'], values: [Number.POSITIVE_INFINITY]},
    {source: ['-1 / 0'], values: [Number.NEGATIVE_INFINITY]},
    {source: ['65536'], values: [65536]},
    {source: ['-32769'], values: [-32769]},
    {source: ['-1', '32768'], values: [-1, 32768]},
  ];

  for (const {source: entries, values} of cases) {
    const source = `
      const DATA = [${entries.join(', ')}];
      fn init() {}
      fn frame() { return DATA[input(0)]; }
    `;
    let index = 0;
    const {detailed, instance} = runtime(source, {integerArrayStorage: 'compact'}, () => index);
    const layout = detailed.arrayLayout[0];
    assert.equal(layout.encoding, undefined);
    assert.equal(layout.elementBytes, undefined);
    assert.equal(layout.physicalByteLength, undefined);
    assert.equal(layout.byteLength, values.length * 4);
    assert.equal(layout.materialized, true);
    for (index = 0; index < values.length; index += 1) {
      const actual = instance.frame();
      if (Number.isNaN(values[index])) {
        assert.ok(Number.isNaN(actual), `${entries[index]} must remain NaN`);
      } else {
        assert.equal(f32Bits(actual), f32Bits(values[index]), `${entries[index]} f32 bits`);
      }
    }
  }
});

test('gives packed triangles precedence and handles unaligned compact and f32 arrays', () => {
  const source = `
    global scalar = 4;
    const TRI = [10, 20, 30, 40, 50, 60, 0.25, 0.5, 0.75];
    const WORDS = [0, 65535];
    global mutable = [1, 2];
    fn init() { mutable[1] = 9; }
    fn frame() {
      return scalar + TRI[input(0)] + WORDS[input(1)] + mutable[input(2)];
    }
  `;
  const input = (index) => [0, 1, 1][index];
  const {detailed, instance} = runtime(source, {
    globalStorage: 'memory',
    integerArrayStorage: 'compact',
    packedTriangleArrays: ['TRI'],
  }, input);
  const [tri, words, mutable] = detailed.arrayLayout;
  assert.equal(tri.encoding, 'triangles-i8-palette-f32');
  assert.equal(tri.byteLength, 19);
  assert.equal(tri.offset, 4);
  assert.equal(words.encoding, 'u16');
  assert.equal(words.elementBytes, 2);
  assert.equal(words.offset, 23);
  assert.equal(words.byteLength, 4);
  assert.equal(mutable.encoding, undefined);
  assert.equal(mutable.offset, 27);
  assert.equal(mutable.byteLength, 8);
  assert.equal(detailed.allocatedBytes, 35);
  assert.equal(detailed.memoryPages, 1);
  instance.init();
  assert.equal(instance.frame(), Math.fround(4 + 10 + 65535 + 9));
  const bytes = new Uint8Array(instance.memory.buffer);
  assert.deepEqual([...bytes.slice(words.offset, words.offset + words.byteLength)], [0, 0, 0xff, 0xff]);
  assert.equal(new DataView(instance.memory.buffer).getFloat32(mutable.offset + 4, true), 9);
});

test('retains index checks and evaluation order for compact dynamic reads', () => {
  const ordered = `
    global cursor = 0;
    const DATA = [10, 20];
    fn next_index() { cursor = cursor + 1; return 1; }
    fn init() {}
    fn frame() { return DATA[next_index()] + cursor; }
  `;
  const {instance} = runtime(ordered, {integerArrayStorage: 'compact'});
  assert.equal(instance.frame(), 21);
  assert.equal(instance.frame(), 22);

  const checked = `
    const DATA = [10, 20];
    fn init() {}
    fn frame() { return DATA[input(0)] + input(1); }
  `;
  const calls = [];
  const invalid = runtime(checked, {integerArrayStorage: 'compact'}, (index) => {
    calls.push(index);
    return index === 0 ? 2 : 99;
  });
  assert.throws(() => invalid.instance.frame(), /unreachable|integer|out of bounds/i);
  assert.deepEqual(calls, [0]);
});

test('uses physical compact capacity for pages while preserving the logical element cap', () => {
  const source = `
    global scalar = 4;
    const DATA = [3; 65536];
    fn init() {}
    fn frame() { return scalar + DATA[input(0)]; }
  `;
  const compact = runtime(source, {
    globalStorage: 'memory',
    integerArrayStorage: 'compact',
  }, () => 65535);
  assert.equal(compact.detailed.totalArrayElements, 65536);
  assert.equal(compact.detailed.arrayLayout[0].encoding, 'u8');
  assert.equal(compact.detailed.arrayLayout[0].offset, 4);
  assert.equal(compact.detailed.arrayLayout[0].physicalByteLength, 65536);
  assert.equal(compact.detailed.allocatedBytes, 65540);
  assert.equal(compact.detailed.memoryPages, 2);
  assert.equal(compact.instance.frame(), 7);

  const defaultStorage = compileDetailed(source, {globalStorage: 'memory'});
  assert.equal(defaultStorage.memoryPages, 5);
  assert.equal(defaultStorage.arrayLayout[0].byteLength, 65536 * 4);

  const invalidIndex = runtime(source, {
    globalStorage: 'memory',
    integerArrayStorage: 'compact',
  }, () => 65536);
  assert.throws(() => invalidIndex.instance.frame(), /unreachable|integer|out of bounds/i);
});

test('prunes static const storage and keeps the default f32 binary identical', () => {
  const staticSource = `
    const DATA = [1, 2, 3];
    fn init() {}
    fn frame() { return DATA[1]; }
  `;
  const staticDetailed = compileDetailed(staticSource, {integerArrayStorage: 'compact'});
  const staticLayout = staticDetailed.arrayLayout[0];
  assert.equal(staticLayout.encoding, 'u8');
  assert.equal(staticLayout.materialized, false);
  assert.equal(staticLayout.offset, null);
  assert.equal(staticLayout.physicalByteLength, 3);
  assert.equal(staticDetailed.allocatedBytes, 0);
  assert.equal(new WebAssembly.Instance(new WebAssembly.Module(staticDetailed.wasm)).exports.frame(), 2);

  const source = `
    global values = [1, 2, 3];
    fn init() {}
    fn frame() { return values[input(0)]; }
  `;
  const implicit = compileDetailed(source);
  const explicit = compileDetailed(source, {integerArrayStorage: 'f32'});
  assert.equal(implicit.integerArrayStorage, 'f32');
  assert.equal(explicit.integerArrayStorage, 'f32');
  assert.deepEqual([...implicit.wasm], [...explicit.wasm]);
  assert.deepEqual(implicit.arrayLayout, explicit.arrayLayout);
});

test('rejects invalid integer array storage options', () => {
  const source = 'fn init() {} fn frame() { return 0; }';
  for (const value of ['u8', 'native', null, true, 1]) {
    assert.throws(
      () => compileDetailed(source, {integerArrayStorage: value}),
      /integerArrayStorage must be "f32" or "compact"/,
    );
  }
  assert.throws(
    () => compileDetailed(source, {integerArrayStorage: 'compact', unsupported: true}),
    /unsupported option "unsupported"/,
  );
});
