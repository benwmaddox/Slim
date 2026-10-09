import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDetailed} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

const source = `
  fn init() {}
  fn frame() {
    svg_group(7);
    tri(1, 2, 3, 2, 1, 4, 1, 0, 0);
    svg_group(0);
  }
`;

test('svg metadata calls are absent from the default WASM contract', () => {
  const plain = compileDetailed(source);
  const withoutMetadata = compileDetailed(source.replace(/svg_group\([^)]*\);/g, ''));
  assert.deepEqual(plain.imports, ['tri']);
  assert.deepEqual([...plain.wasm], [...withoutMetadata.wasm]);

  const metadata = compileDetailed(source, {svgMetadata: true});
  assert.deepEqual(metadata.imports, ['svg_group', 'svg_tri']);
  const events = [];
  const instance = new WebAssembly.Instance(new WebAssembly.Module(metadata.wasm), {
    e: {
      svg_group: (id) => { events.push(['svg_group', id]); return 0; },
      svg_tri: (name, ...values) => { events.push(['svg_tri', name, values]); return 0; },
    },
  });
  instance.exports.frame();
  assert.deepEqual(events.map((event) => event[0] === 'svg_tri'
    ? [event[0], event[1], event[2].length]
    : event), [
    ['svg_group', 7],
    ['svg_tri', 1, 9],
    ['svg_group', 0],
  ]);
});

test('svg metadata calls are absent from the default JavaScript factory', () => {
  const plain = compileJavaScript(source);
  assert.deepEqual(plain.imports, ['tri']);
  assert.equal(plain.code.includes('svg_group'), false);

  const metadata = compileJavaScript(source, {svgMetadata: true});
  assert.deepEqual(metadata.imports, ['svg_group', 'svg_tri']);
  const events = [];
  const factory = Function(`return (${metadata.code});`)();
  factory({
    svg_group: (id) => { events.push(['svg_group', id]); return 0; },
    svg_tri: (name, ...values) => { events.push(['svg_tri', name, values.length]); return 0; },
  }).frame();
  assert.deepEqual(events, [
    ['svg_group', 7],
    ['svg_tri', 1, 9],
    ['svg_group', 0],
  ]);
});
