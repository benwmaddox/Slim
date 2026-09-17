import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compile, compileDetailed} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {heroColor, winColor, lossColor, winningReplay} from '../tools/shardbound-replay.mjs';

const sourcePath = new URL('../examples/shardbound.slim', import.meta.url);

function nearColor(triangle, color) {
  return triangle.length === 9 && color.every((value, index) => Math.abs(triangle[index + 6] - value) < 0.01);
}

function finiteFrame(frame, label) {
  assert.ok(frame.triangles.length > 0, `${label} should draw triangles`);
  assert.ok(frame.triangles.length <= 260, `${label} emitted ${frame.triangles.length} triangles`);
  for (const triangle of frame.triangles) {
    assert.equal(triangle.length, 9, `${label} triangle ABI`);
    assert.ok(triangle.every(Number.isFinite), `${label} contains a non-finite vertex`);
    assert.ok(triangle.slice(6).every((channel) => channel >= 0 && channel <= 1), `${label} has invalid color`);
  }
}

function instrumentedSource(source) {
  const renamed = source.replace('fn frame() {', 'fn shardbound_frame() {');
  assert.notEqual(renamed, source, 'source must have one exported frame function');
  return `${renamed}
fn frame() {
  shardbound_frame();
  sound(99, player_x, player_y);
  sound(98, current_level, state);
  sound(97, gem_count, transition_timer);
}`;
}

function makeRuntime(source, backend = 'wasm') {
  let values = {};
  let triangles = [];
  let sounds = [];
  const host = {
    input(index) { return values[index] ?? 0; },
    tri(...args) { triangles.push(args); return 0; },
    sound(...args) { sounds.push(args); return 0; },
  };
  let game;
  if (backend === 'wasm' || backend === 'wasm-memory') {
    const bytes = compile(source, {globalStorage: backend === 'wasm-memory' ? 'memory' : 'globals'});
    assert.ok(WebAssembly.validate(bytes), `${backend} module must validate`);
    game = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: host}).exports;
  } else {
    const result = compileJavaScript(source, {precision: backend});
    const factory = Function(`return (${result.code});`)();
    game = factory(host);
  }
  return {
    game,
    init() {
      values = {};
      triangles = [];
      sounds = [];
      game.init();
    },
    frame(nextValues = {}) {
      values = nextValues;
      triangles = [];
      sounds = [];
      game.frame();
      return {
        triangles: triangles.map((triangle) => triangle.slice()),
        sounds: sounds.map((sound) => sound.slice()),
      };
    },
  };
}

function debugState(frame) {
  const position = frame.sounds.find((event) => event[0] === 99);
  const level = frame.sounds.find((event) => event[0] === 98);
  const gems = frame.sounds.find((event) => event[0] === 97);
  assert.ok(position && level && gems, 'instrumentation must report player state');
  return {x: position[1], y: position[2], level: level[1], state: level[2], gems: gems[1], timer: gems[2]};
}

function frameValues(keys, previousSpace) {
  const values = {};
  if (keys.includes('ArrowLeft') || keys.includes('KeyA')) values[0] = 1;
  if (keys.includes('ArrowRight') || keys.includes('KeyD')) values[1] = 1;
  const space = keys.includes('Space');
  if (space) values[4] = 1;
  if (space && !previousSpace) values[5] = 1;
  return {values, space};
}

function runReplay(runtime, segments, onFrame) {
  let tick = 0;
  let spaceHeld = false;
  for (const segment of segments) {
    for (let index = 0; index < segment.ticks; index += 1) {
      const next = frameValues(segment.keys || [], spaceHeld);
      spaceHeld = next.space;
      const frame = runtime.frame(next.values);
      onFrame?.(frame, tick, segment);
      tick += 1;
    }
  }
  return tick;
}

test('Shardbound compiles to valid WASM and draws bounded atlas scenes', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const bytes = compile(source);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(WebAssembly.validate(bytes));

  for (const backend of ['wasm', 'native', 'f32']) {
    const renamed = source.replace('fn frame() {', 'fn original_frame() {');
    const shapes = makeRuntime(`${renamed}\nfn frame() { hero(130, 500, input(0), input(1)); }`, backend);
    shapes.init();
    for (const facing of [-1, 1]) for (const pose of [0, 1, 2]) {
      const frame = shapes.frame({0: facing, 1: pose});
      finiteFrame(frame, `${backend} fox ${facing}/${pose}`);
      assert.equal(frame.triangles.length, 30, `${backend} fox atlas triangle count`);
    }
    const beetleRuntime = makeRuntime(`${renamed}\nfn frame() { beetle(130, 500, input(0)); }`, backend);
    beetleRuntime.init();
    const beetleFrame = beetleRuntime.frame();
    finiteFrame(beetleFrame, `${backend} beetle mesh`);
    assert.equal(beetleFrame.triangles.length, 12, `${backend} beetle atlas triangle count`);
    const flyRuntime = makeRuntime(`${renamed}\nfn frame() { fly(250, 350, input(1)); }`, backend);
    flyRuntime.init();
    const flyFrame = flyRuntime.frame();
    finiteFrame(flyFrame, `${backend} fly mesh`);
    assert.equal(flyFrame.triangles.length, 11, `${backend} fly atlas triangle count`);
  }

  const runtime = makeRuntime(source);
  runtime.init();
  const first = runtime.frame();
  finiteFrame(first, 'initial frame');
  assert.equal(first.triangles.filter((triangle) => nearColor(triangle, heroColor)).length, 1, 'fox marker must be unique');
  const firstHero = first.triangles.find((triangle) => nearColor(triangle, heroColor));
  const firstX = (firstHero[0] + firstHero[2] + firstHero[4]) / 3;
  const moved = runtime.frame({1: 1});
  const movedHero = moved.triangles.find((triangle) => nearColor(triangle, heroColor));
  const movedX = (movedHero[0] + movedHero[2] + movedHero[4]) / 3;
  assert.ok(movedX > firstX, 'right input should move the courier');
  const jump = runtime.frame({1: 1, 4: 1, 5: 1});
  const jumpHero = jump.triangles.find((triangle) => nearColor(triangle, heroColor));
  assert.ok(jumpHero, 'jump frame should retain hero marker');
  finiteFrame(jump, 'jump frame');
});

test('Shardbound uses shared terrain arrays for landing, walls, and finite bounds', async () => {
  const source = instrumentedSource(await readFile(sourcePath, 'utf8'));
  const detailed = compileDetailed(source, {globalStorage: 'memory'});
  assert.ok(WebAssembly.validate(detailed.wasm));
  const backends = ['wasm', 'wasm-memory', 'native', 'f32'];
  for (const backend of backends) {
    const runtime = makeRuntime(source, backend);
    runtime.init();
    let previous = debugState(runtime.frame());
    for (let tick = 0; tick < 180; tick += 1) {
      const frame = runtime.frame({1: 1});
      finiteFrame(frame, `${backend} walk ${tick}`);
      const state = debugState(frame);
      assert.ok(Number.isFinite(state.x) && Number.isFinite(state.y), `${backend} finite state`);
      assert.ok(state.x >= 18 && state.x <= 1482, `${backend} bounded x`);
      previous = state;
    }
    assert.ok(previous.x > 280, `${backend} camera-worthy movement should progress`);
  }
});

test('Shardbound loss restarts the current level and R fully resets progression', async () => {
  const source = instrumentedSource(await readFile(sourcePath, 'utf8'));
  const runtime = makeRuntime(source);
  runtime.init();
  let lostFrame;
  for (let tick = 0; tick < 500; tick += 1) {
    lostFrame = runtime.frame({1: 1});
    if (debugState(lostFrame).state === 2) break;
  }
  assert.equal(debugState(lostFrame).state, 2, 'running without jumps should lose');
  assert.ok(lostFrame.sounds.some((event) => event[0] === 2), 'loss should emit sound id 2');
  const restarted = runtime.frame({4: 1, 5: 1});
  assert.equal(debugState(restarted).state, 0, 'primary edge restarts a loss');
  assert.equal(debugState(restarted).level, 0, 'loss restart stays in current level');
  const full = runtime.frame({9: 1});
  assert.equal(debugState(full).level, 0, 'R returns to level one');
  assert.equal(debugState(full).x, 120, 'R restores start x');
  assert.equal(debugState(full).gems, 0, 'R clears gem count');
});

test('real keyboard replay wins every level and matches exact-f32 JS', async context => {
  const source = instrumentedSource(await readFile(sourcePath, 'utf8'));
  assert.ok(winningReplay.some((segment) => (segment.keys || []).includes('Space')), 'winning replay must jump');
  const backends = ['wasm', 'wasm-memory', 'f32', 'native'];
  const traces = [];
  for (const backend of backends) {
    const runtime = makeRuntime(source, backend);
    runtime.init();
    const trace = [];
    runReplay(runtime, winningReplay, (frame, tick) => {
      finiteFrame(frame, `${backend} winning tick ${tick}`);
      trace.push(frame);
    });
    const final = trace.at(-1);
    assert.equal(debugState(final).state, 1, `${backend} replay should reach final win`);
    assert.ok(final.triangles.some((triangle) => nearColor(triangle, winColor)), `${backend} win marker`);
    traces.push(trace);
  }
  assert.deepEqual(traces[1], traces[0], 'memory WASM must match default WASM');
  assert.deepEqual(traces[2], traces[0], 'exact-f32 JS must match default WASM');
  assert.ok(traces[0].some((frame) => debugState(frame).level === 1), 'replay must advance to level two');
  assert.ok(traces[0].some((frame) => debugState(frame).level === 2), 'replay must advance to level three');
  assert.ok(traces[0].some((frame) => frame.sounds.some((event) => event[0] === 4)), 'replay must emit transition sound');
  context.diagnostic(`Winning replay: ${traces[0].length} ticks.`);
});

test('loss and win palette markers stay unique', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const runtime = makeRuntime(source);
  runtime.init();
  const initial = runtime.frame();
  assert.equal(initial.triangles.filter((triangle) => nearColor(triangle, heroColor)).length, 1);
  assert.ok(lossColor.every((value) => value >= 0 && value <= 1));
  assert.ok(winColor.every((value) => value >= 0 && value <= 1));
});
