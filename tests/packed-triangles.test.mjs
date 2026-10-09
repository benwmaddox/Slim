import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDetailed} from '../src/compiler.mjs';

function f32Bits(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function f32Bytes(value) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return [...new Uint8Array(buffer)];
}

function runtime(source, options = {}, input = () => 0) {
  const detailed = compileDetailed(source, options);
  assert.ok(WebAssembly.validate(detailed.wasm));
  const module = new WebAssembly.Module(detailed.wasm);
  const instance = new WebAssembly.Instance(module, {e: {input}});
  return {detailed, instance: instance.exports};
}

test('packs immutable triangles into signed bytes and an exact f32 palette', () => {
  const source = `
    const ATLAS = [
      -128, -1, 0, 1, 2, 127, 0.1, -0, 0 / 0,
      127, 0, -127, -2, 3, 4, 0.1, -0, 0 / 0
    ];
    fn init() {}
    fn frame() { return ATLAS[input(0)]; }
  `;
  const plain = runtime(source);
  const packed = runtime(source, {packedTriangleArrays: ['ATLAS']});
  const layout = packed.detailed.arrayLayout[0];

  assert.equal(layout.encoding, 'triangles-i8-palette-f32');
  assert.equal(layout.triangleCount, 2);
  assert.equal(layout.paletteSize, 1);
  assert.equal(layout.offset, 0);
  assert.equal(layout.paletteOffset, 14);
  assert.equal(layout.byteLength, 2 * 7 + 12);
  assert.equal(layout.materialized, true);
  assert.equal(plain.detailed.arrayLayout[0].byteLength, 18 * 4);
  assert.equal(packed.detailed.allocatedBytes, layout.byteLength);
  assert.deepEqual(layout.values, plain.detailed.arrayLayout[0].values);

  const expectedData = [
    0x80, 0xff, 0x00, 0x01, 0x02, 0x7f, 0x00,
    0x7f, 0x00, 0x81, 0xfe, 0x03, 0x04, 0x00,
  ];
  const expectedPalette = layout.values.slice(6, 9).flatMap(f32Bytes);
  const bytes = new Uint8Array(packed.instance.memory.buffer, layout.offset, layout.byteLength);
  assert.deepEqual([...bytes], [...expectedData, ...expectedPalette]);

  let index = 0;
  const plainRun = runtime(source, {}, () => index);
  const packedRun = runtime(source, {packedTriangleArrays: ['ATLAS']}, () => index);
  for (index = 0; index < 18; index += 1) {
    assert.equal(
      f32Bits(packedRun.instance.frame()),
      f32Bits(plainRun.instance.frame()),
      `logical lane ${index} must preserve the f32 result`,
    );
  }
});

test('checks a packed index once before the decoder and preserves negative zero', () => {
  const source = `
    const ATLAS = [10, 20, 30, 40, 50, 60, 0.25, 0.5, 0.75];
    global cursor = 0;
    fn next() { cursor = cursor + 1; return 0; }
    fn init() {}
    fn frame() { return ATLAS[next()] + cursor; }
  `;
  const packed = runtime(source, {packedTriangleArrays: ['ATLAS']});
  assert.equal(packed.instance.frame(), 11);
  assert.equal(packed.instance.frame(), 12);
  assert.deepEqual(packed.detailed.functions, ['init', 'frame', 'next']);

  const checked = `
    const ATLAS = [10, 20, 30, 40, 50, 60, 0.25, 0.5, 0.75];
    fn init() {}
    fn frame() { return ATLAS[input(0)] + input(1); }
  `;
  for (const value of [-0, -1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const calls = [];
    const packedChecked = runtime(checked, {packedTriangleArrays: ['ATLAS']}, (index) => {
      calls.push(index);
      return index === 0 ? value : 99;
    });
    if (Object.is(value, -0)) {
      assert.equal(packedChecked.instance.frame(), 109);
    } else {
      assert.throws(() => packedChecked.instance.frame(), /unreachable|integer|out of bounds/i);
      assert.deepEqual(calls, [0], `RHS-side input must not run for invalid index ${String(value)}`);
    }
  }
});

test('lays out multiple packed arrays and ordinary arrays without padding drift', () => {
  const source = `
    global scalar = 4;
    const FIRST = [1, 2, 3, 4, 5, 6, 0.1, 0.2, 0.3, 7, 8, 9, 10, 11, 12, 0.1, 0.2, 0.3];
    const SECOND = [-1, 0, 1, 2, 3, 4, 0.4, 0.5, 0.6];
    global tail = [10, 20];
    fn init() {}
    fn frame() { return scalar + FIRST[input(0)] + SECOND[input(1)] + tail[1]; }
  `;
  const detailed = compileDetailed(source, {
    globalStorage: 'memory',
    packedTriangleArrays: ['FIRST', 'SECOND'],
  });
  assert.ok(WebAssembly.validate(detailed.wasm));
  assert.deepEqual(
    detailed.arrayLayout.map(({name, offset, byteLength, paletteOffset, encoding}) => ({
      name, offset, byteLength, paletteOffset, encoding,
    })),
    [
      {name: 'FIRST', offset: 4, byteLength: 26, paletteOffset: 18, encoding: 'triangles-i8-palette-f32'},
      {name: 'SECOND', offset: 30, byteLength: 19, paletteOffset: 37, encoding: 'triangles-i8-palette-f32'},
      {name: 'tail', offset: 49, byteLength: 8, paletteOffset: undefined, encoding: undefined},
    ],
  );
  assert.equal(detailed.allocatedBytes, 57);
  assert.equal(detailed.memoryPages, 1);
  const input = (index) => index === 0 ? 0 : 6;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(detailed.wasm), {e: {input}}).exports;
  assert.equal(instance.frame(), Math.fround(4 + 1 + 0.4 + 20));
  const memory = new DataView(instance.memory.buffer);
  assert.equal(memory.getFloat32(0, true), 4);
  assert.equal(memory.getFloat32(49 + 4, true), 20);
});

test('uses physical packed bytes for page capacity and keeps the logical cap', () => {
  const source = `
    const ATLAS = [0; 59994];
    global tail = [1; 5542];
    fn init() {}
    fn frame() { return ATLAS[input(0)] + tail[input(1)]; }
  `;
  const detailed = compileDetailed(source, {
    globalStorage: 'memory',
    packedTriangleArrays: ['ATLAS'],
  });
  assert.equal(detailed.totalArrayElements, 65536);
  assert.equal(detailed.arrayLayout[0].triangleCount, 6666);
  assert.equal(detailed.arrayLayout[0].paletteSize, 1);
  assert.equal(detailed.arrayLayout[0].byteLength, 6666 * 7 + 12);
  assert.equal(detailed.arrayLayout[1].offset, detailed.arrayLayout[0].byteLength);
  assert.equal(detailed.allocatedBytes, 6666 * 7 + 12 + 5542 * 4);
  assert.equal(detailed.memoryPages, 2);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(detailed.wasm), {
    e: {input: (index) => index === 0 ? 0 : 5541},
  }).exports;
  assert.equal(instance.frame(), 1);
});

test('rejects invalid packed targets and triangle formats', () => {
  const prefix = 'fn init() {} fn frame() { return 0; }';
  const capture = (action) => {
    try {
      action();
    } catch (error) {
      return error;
    }
    assert.fail('expected action to throw');
  };
  const unknown = capture(() => compileDetailed(prefix, {packedTriangleArrays: ['MISSING']}));
  assert.match(unknown.message, /packed triangle target .*not a declared array/);
  assert.equal(unknown.code, undefined);

  const assertUnsupported = (source, pattern) => {
    const error = capture(() => compileDetailed(source, {packedTriangleArrays: ['BAD']}));
    assert.match(error.message, pattern);
    assert.equal(error.code, 'SLIM_PACKING_UNSUPPORTED');
  };
  assertUnsupported('global BAD = [0,1,2,3,4,5,6,7,8]; fn init() {} fn frame() { return BAD[0]; }', /must be an immutable const array/);
  assertUnsupported('const BAD = [0,1,2]; fn init() {} fn frame() { return BAD[0]; }', /length must be a multiple of 9/);
  for (const value of ['1.5', '128', '-129', '-0']) {
    const source = `const BAD = [${value}, 0, 0, 0, 0, 0, 0, 0, 0]; ${prefix}`;
    assertUnsupported(source, /coordinate .*must be|coordinate .*negative zero/);
  }

  const manyColors = Array.from({length: 257}, (_, index) => `0,0,0,0,0,0,${index},0,0`).join(',');
  const paletteError = capture(() => compileDetailed(`const MANY = [${manyColors}]; ${prefix}`, {packedTriangleArrays: ['MANY']}));
  assert.match(paletteError.message, /palette exceeds 256 colors/);
  assert.equal(paletteError.code, 'SLIM_PACKING_UNSUPPORTED');
  assert.throws(
    () => compileDetailed(prefix, {packedTriangleArrays: null}),
    /packedTriangleArrays must be an array/,
  );
  assert.throws(
    () => compileDetailed(prefix, {packedTriangleArrays: ['MISSING', 'MISSING']}),
    /duplicate packed triangle array/,
  );
  assert.throws(
    () => compileDetailed(prefix, {packedTriangleArrays: [1]}),
    /entries must be strings/,
  );
});
