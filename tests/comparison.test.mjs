import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {compile} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {minifyJavaScript} from '../tools/minify.mjs';

function driver(factory) {
  let inputs = {};
  let events = [];
  const host = {
    input: index => inputs[index] || 0,
    tri: (...values) => { events.push(['tri', ...values]); return 0; },
    sound: (...values) => { events.push(['sound', ...values]); return 0; }
  };
  const game = factory(host);
  game.init();
  return values => {
    inputs = values;
    events = [];
    game.frame();
    return events;
  };
}

function replay() {
  return [
    {}, ...Array.from({length: 20}, () => ({1: 1})),
    {4: 1, 8: 1, 6: 180, 7: 160},
    {4: 1, 8: 1, 6: 400, 7: 290},
    {4: 1, 8: 1, 6: 620, 7: 420},
    {}, {9: 1},
    ...Array.from({length: 24}, () => ({4: 1, 8: 1, 6: 120, 7: 78})),
    {9: 1}, ...Array.from({length: 1000}, () => ({}))
  ];
}

test('same game survives minification and exact-f32 JS matches WASM throughout gameplay', async () => {
  const source = await readFile(new URL('../examples/rainbow.slim', import.meta.url), 'utf8');
  const module = new WebAssembly.Module(compile(source));
  const wasm = driver(host => new WebAssembly.Instance(module, {e: host}).exports);
  const profiles = [];
  for (const precision of ['native', 'f32']) {
    const {code} = compileJavaScript(source, {precision});
    const assignment = `globalThis.factory = ${code};`;
    profiles.push({precision, soundIds: [], raw: driver(vm.runInNewContext(assignment)),
      minified: driver(vm.runInNewContext(await minifyJavaScript(assignment)))});
  }
  let soundCount = 0;
  for (const [tick, inputs] of replay().entries()) {
    const expected = wasm(inputs);
    soundCount += expected.filter(event => event[0] === 'sound').length;
    for (const profile of profiles) {
      const raw = profile.raw(inputs);
      profile.soundIds.push(...raw.filter(event => event[0] === 'sound').map(event => event[1]));
      assert.deepEqual(profile.minified(inputs), raw, `${profile.precision} minification at tick ${tick}`);
      if (profile.precision === 'f32') {
        assert.deepEqual(raw, expected, `f32 parity at tick ${tick}`);
      } else if (tick < 26) {
        assert.equal(raw.length, expected.length, `native event count at tick ${tick}`);
        raw.forEach((event, index) => {
          assert.equal(event[0], expected[index][0]);
          event.slice(1).forEach((value, channel) => {
            assert.ok(Math.abs(value - expected[index][channel + 1]) < 0.02,
              `native coordinate/event drift at tick ${tick}`);
          });
        });
      }
    }
  }
  assert.ok(soundCount >= 5, 'replay must exercise collection, winning, and loss sounds');
  for (const profile of profiles) {
    assert.deepEqual(profile.soundIds.slice(0, 5), [0, 0, 0, 2, 1]);
  }
});
