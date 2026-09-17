import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compile} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {winningReplay, winColor} from '../tools/blockbound-replay.mjs';

const sourcePath = new URL('../examples/blockbound.slim', import.meta.url);
const HERO_COLOR = [0.95, 0.32, 0.1];

function nearColor(triangle, color) {
  return triangle.length === 9 && color.every((value, index) => Math.abs(triangle[index + 6] - value) < 0.01);
}

function finiteFrame(frame, label) {
  assert.ok(frame.triangles.length > 0, `${label} should draw triangles`);
  assert.ok(frame.triangles.length <= 256, `${label} emitted ${frame.triangles.length} triangles`);
  for (const triangle of frame.triangles) {
    assert.equal(triangle.length, 9, `${label} triangle ABI`);
    assert.ok(triangle.every(Number.isFinite), `${label} contains a non-finite vertex`);
    assert.ok(triangle.slice(6).every((channel) => channel >= 0 && channel <= 1), `${label} has an invalid color`);
  }
}

function instrumentedSource(source) {
  const renamed = source.replace('fn frame() {', 'fn blockbound_frame() {');
  assert.notEqual(renamed, source, 'the source must have one exported frame function');
  return `${renamed}
fn frame() {
  blockbound_frame();
  sound(99, player_x, player_y);
  sound(98, player_vy, state);
  sound(97, camera_x, player_ground);
}
`;
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
    assert.ok(WebAssembly.validate(bytes));
    game = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: host}).exports;
  } else {
    const result = compileJavaScript(source, {precision: backend});
    const factory = Function(`return (${result.code});`)();
    game = factory(host);
  }
  const runtime = {
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
      return {triangles: triangles.map((triangle) => triangle.slice()), sounds: sounds.map((sound) => sound.slice())};
    },
  };
  return runtime;
}

function debugState(frame) {
  const position = frame.sounds.find((event) => event[0] === 99);
  const motion = frame.sounds.find((event) => event[0] === 98);
  const camera = frame.sounds.find((event) => event[0] === 97);
  assert.ok(position && motion && camera, 'instrumentation must report player, state, and camera');
  return {
    x: position[1],
    y: position[2],
    vy: motion[1],
    state: motion[2],
    camera: camera[1],
    ground: camera[2],
  };
}

function runSegments(runtime, segments, onFrame) {
  let tick = 0;
  let spaceHeld = false;
  for (const segment of segments) {
    for (let index = 0; index < segment.ticks; index += 1) {
      const keys = segment.keys || [];
      const values = {};
      if (keys.includes('ArrowLeft')) values[0] = 1;
      if (keys.includes('ArrowRight')) values[1] = 1;
      const space = keys.includes('Space');
      if (space) values[4] = 1;
      if (space && !spaceHeld) values[5] = 1;
      spaceHeld = space;
      const frame = runtime.frame(values);
      onFrame?.(frame, tick, segment);
      tick += 1;
    }
  }
  return tick;
}

test('Blockbound compiles, draws bounded finite frames, and uses readable faceted shapes', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const bytes = compile(source);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength > 8);
  assert.ok(WebAssembly.validate(bytes));

  for (const backend of ['wasm', 'native']) {
    const renamed = source.replace('fn frame() {', 'fn original_frame() {');
    const shapes = makeRuntime(`${renamed}\nfn frame() { hero(130, 500, input(0), input(1)); }`, backend);
    shapes.init();
    for (const facing of [-1, 1]) for (const pose of [0, 1, 2]) {
      const frame = shapes.frame({0: facing, 1: pose});
      finiteFrame(frame, `${backend} hero facing ${facing} pose ${pose}`);
      assert.ok(frame.triangles.length >= 25 && frame.triangles.length <= 50,
        `hero emitted ${frame.triangles.length} triangles`);
    }
    const beetle = makeRuntime(`${renamed}\nfn frame() { enemy_shape(130, 500, input(0)); }`, backend);
    beetle.init();
    for (const pose of [0, 1]) {
      const frame = beetle.frame({0: pose});
      finiteFrame(frame, `${backend} beetle pose ${pose}`);
      assert.ok(frame.triangles.length >= 12 && frame.triangles.length <= 50,
        `beetle emitted ${frame.triangles.length} triangles`);
    }
  }

  const runtime = makeRuntime(source);
  runtime.init();
  const first = runtime.frame();
  finiteFrame(first, 'initial frame');
  assert.equal(first.triangles.filter((triangle) => nearColor(triangle, HERO_COLOR)).length, 1, 'hero marker should be unique');

  const firstHero = first.triangles.find((triangle) => nearColor(triangle, HERO_COLOR));
  const firstX = (firstHero[0] + firstHero[2] + firstHero[4]) / 3;
  const moved = runtime.frame({1: 1});
  finiteFrame(moved, 'movement frame');
  const movedHero = moved.triangles.find((triangle) => nearColor(triangle, HERO_COLOR));
  const movedX = (movedHero[0] + movedHero[2] + movedHero[4]) / 3;
  assert.ok(movedX > firstX, 'ArrowRight should move the fox');

  const jump = runtime.frame({1: 1, 4: 1, 5: 1});
  finiteFrame(jump, 'jump frame');
  const jumpHero = jump.triangles.find((triangle) => nearColor(triangle, HERO_COLOR));
  const jumpY = (jumpHero[1] + jumpHero[3] + jumpHero[5]) / 3;
  assert.ok(jumpY < (firstHero[1] + firstHero[3] + firstHero[5]) / 3, 'Space edge should lift the fox');

  for (let tick = 0; tick < 180; tick += 1) finiteFrame(runtime.frame(), `settle frame ${tick}`);
});

test('Blockbound applies gravity, camera follow, hazard loss, and R reset', async () => {
  const source = instrumentedSource(await readFile(sourcePath, 'utf8'));
  const runtime = makeRuntime(source);
  runtime.init();

  let cameraMoved = false;
  let jumpState;
  for (let tick = 0; tick < 90; tick += 1) {
    const frame = runtime.frame({1: 1});
    finiteFrame(frame, `run frame ${tick}`);
    const state = debugState(frame);
    cameraMoved ||= state.camera > 0;
    if (tick === 12) {
      const jumpFrame = runtime.frame({1: 1, 4: 1, 5: 1});
      jumpState = debugState(jumpFrame);
      assert.ok(jumpState.y < 500, 'jump edge should move feet above ground');
    }
  }
  assert.ok(cameraMoved, 'camera should follow after the 280 unit lead');
  assert.ok(jumpState.vy < 0, 'fresh jump should have upward velocity');

  runtime.init();
  let lost = false;
  let lossFrame;
  for (let tick = 0; tick < 600; tick += 1) {
    lossFrame = runtime.frame({1: 1});
    const state = debugState(lossFrame);
    if (state.state === 2) {
      lost = true;
      break;
    }
  }
  assert.ok(lost, 'running without jumping should eventually fall into a gap or hit a hazard');
  assert.ok(lossFrame.sounds.some((event) => event[0] === 2), 'loss should emit the hazard sound');
  const restarted = runtime.frame({9: 1});
  const resetState = debugState(restarted);
  assert.equal(resetState.state, 0, 'R should leave the terminal state');
  assert.equal(resetState.x, 120, 'R should restore the start position');
  assert.equal(resetState.y, 500, 'R should restore the ground feet position');
  assert.equal(resetState.camera, 0, 'R should restore the start camera');
});

test('Blockbound terrain blocks walls and ceilings, preserves the floor, and permits stomping', async () => {
  const source = await readFile(sourcePath, 'utf8');
  function placed(backend, assignments) {
    const renamed = source.replace('fn init() {', 'fn original_init() {');
    const game = makeRuntime(instrumentedSource(`${renamed}\nfn init() { original_init(); ${assignments} }`), backend);
    game.init();
    return game;
  }
  for (const backend of ['wasm', 'wasm-memory', 'native', 'f32']) {
    const floor = placed(backend, 'player_x = 450;');
    for (let tick = 0; tick < 30; tick++) assert.equal(debugState(floor.frame()).y, 500, `${backend}: floor beneath floating blocks`);
    const wall = placed(backend, 'player_x = 680; player_vx = 6;');
    for (let tick = 0; tick < 10; tick++) assert.ok(debugState(wall.frame({1: 1})).x <= 682, `${backend}: pillar wall`);
    const ceiling = placed(backend, 'player_x = 480; player_y = 480; player_vy = -13; player_ground = 0;');
    const bump = debugState(ceiling.frame());
    assert.equal(bump.vy, 0, `${backend}: ceiling cancels upward velocity`);
    assert.equal(bump.y, 473, `${backend}: head remains below platform`);
    const stomp = placed(backend, 'player_x = 550; player_y = 450; player_vy = 8; player_ground = 0;');
    const hit = stomp.frame();
    assert.ok(hit.sounds.some(event => event[0] === 1), `${backend}: stomp sound`);
    assert.ok(debugState(hit).vy < 0, `${backend}: stomp bounce`);
    assert.equal(debugState(hit).state, 0);
    const gap = placed(backend, 'player_x = 2260; player_y = 675; player_vy = 15; player_ground = 0;');
    assert.equal(debugState(gap.frame()).state, 2, `${backend}: falling through a pit loses`);
  }
});

test('Blockbound memory slots and exact-f32 JavaScript match WASM frame events', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const games = ['wasm', 'wasm-memory', 'f32'].map(backend => makeRuntime(source, backend));
  games.forEach(game => game.init());
  for (let tick = 0; tick < 650; tick++) {
    const values = tick === 300 ? {9: 1} : {1: 1};
    if (tick >= 29 && tick < 37) values[4] = 1;
    if (tick === 29) values[5] = 1;
    const frames = games.map(game => game.frame(values));
    assert.deepEqual(frames[1], frames[0], `memory storage diverged at tick ${tick}`);
    assert.deepEqual(frames[2], frames[0], `f32 JavaScript diverged at tick ${tick}`);
  }
});

test('a real keyboard replay completes Blockbound across storage and JavaScript backends', async context => {
  const source = instrumentedSource(await readFile(sourcePath, 'utf8'));
  const backends = ['wasm', 'wasm-memory', 'f32', 'native'];
  const games = backends.map(backend => makeRuntime(source, backend));
  const traces = [];
  let maximumTriangles = 0;
  for (const [index, game] of games.entries()) {
    game.init();
    const trace = [];
    runSegments(game, winningReplay, (frame, tick) => {
      finiteFrame(frame, `${backends[index]} winning tick ${tick}`);
      maximumTriangles = Math.max(maximumTriangles, frame.triangles.length);
      trace.push(frame);
    });
    const final = trace.at(-1);
    assert.equal(debugState(final).state, 1, `${backends[index]} must reach the beacon`);
    assert.ok(final.triangles.some(triangle => nearColor(triangle, winColor)));
    assert.equal(debugState(game.frame({9: 1})).state, 0, `${backends[index]} must restart after winning`);
    traces.push(trace);
  }
  assert.deepEqual(traces[1], traces[0], 'memory slots must preserve the entire winning replay');
  assert.deepEqual(traces[2], traces[0], 'exact-f32 JavaScript must preserve the entire winning replay');
  context.diagnostic(`Winning replay: ${traces[0].length} ticks; peak ${maximumTriangles} scene triangles.`);
});
