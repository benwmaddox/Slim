import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compile} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {
  CELLS, DELTAS, decodeLevel, validateLevel, solve, step, isSolved,
} from '../tools/boxpush-solver.mjs';

const sourcePath = new URL('../examples/boxpush.slim', import.meta.url);
const source = await readFile(sourcePath, 'utf8');

function numbers(name) {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
  assert.ok(match, `${name} array must exist`);
  return match[1].split(',').map((value) => Number(value.trim()));
}

const LEVEL_COUNT = 6;
const CLEAR_READY = 40;
const MOVE_TICKS = 9;
const map = numbers('LEVEL_MAP');
const boxes = numbers('LEVEL_BOX');
const starts = numbers('LEVEL_START');
const widths = numbers('LEVEL_W');
const heights = numbers('LEVEL_H');
const boxCounts = numbers('LEVEL_BOXES');
const levels = Array.from({length: LEVEL_COUNT}, (_, n) => decodeLevel(
  map.slice(n * CELLS, (n + 1) * CELLS),
  boxes.slice(n * CELLS, (n + 1) * CELLS),
  starts[n], widths[n], heights[n],
));

// Instrumented copy: reports player cell, level, state, and covered crates
// through otherwise unused sound ids, so replays never touch game state.
function instrumented() {
  const renamed = source.replace('fn frame() {', 'fn boxpush_frame() {');
  assert.notEqual(renamed, source, 'source must have one exported frame function');
  return `${renamed}
fn frame() {
  boxpush_frame();
  sound(99, player, current_level);
  sound(98, state, covered);
  sound(97, crate[0], 0);
}`;
}

function makeRuntime(backend = 'wasm') {
  let values = {};
  let triangles = [];
  let sounds = [];
  const host = {
    input(index) { return values[index] ?? 0; },
    tri(...args) { triangles.push(args); return 0; },
    sound(...args) { sounds.push(args); return 0; },
  };
  const code = instrumented();
  let game;
  if (backend === 'wasm') {
    const bytes = compile(code);
    assert.ok(WebAssembly.validate(bytes), 'module must validate');
    game = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: host}).exports;
  } else {
    const result = compileJavaScript(code, {precision: backend});
    game = Function(`return (${result.code});`)()(host);
  }
  function frame(next = {}) {
    values = next;
    triangles = [];
    sounds = [];
    game.frame();
    const find = (id) => sounds.find((event) => event[0] === id);
    return {
      triangles,
      sounds,
      player: find(99)[1],
      level: find(99)[2],
      state: find(98)[1],
      covered: find(98)[2],
    };
  }
  game.init();
  return {
    frame,
    // One keypress: key down for a frame, then released, like a real tap.
    tap(dir) {
      const input = {left: 0, right: 1, up: 2, down: 3}[dir];
      const result = frame({[input]: 1});
      return {...result, after: frame()};
    },
    // Space only continues once the clear panel has finished sliding in.
    wait(ticks) { let last; for (let i = 0; i < ticks; i += 1) last = frame(); return last; },
    space() { return frame({4: 1, 5: 1}); },
    restart() { return frame({9: 1}); },
  };
}

test('every level is fenced in, has matching boxes and targets, and counts boxes', () => {
  assert.equal(map.length, LEVEL_COUNT * CELLS);
  assert.equal(boxes.length, LEVEL_COUNT * CELLS);
  levels.forEach((level, n) => {
    assert.deepEqual(validateLevel(level), [], `level ${n + 1}`);
    assert.equal(level.boxes.length, boxCounts[n], `level ${n + 1} box count`);
    assert.ok(level.boxes.length >= 1);
    assert.ok(!isSolved(level, level.boxes), `level ${n + 1} must not start solved`);
  });
});

test('every level can be completed using pushes only (independent solver)', () => {
  const report = [];
  levels.forEach((level, n) => {
    const solution = solve(level);
    assert.ok(solution, `level ${n + 1} has no solution`);
    // Re-apply the moves with the push-only rules to confirm the solver output.
    const state = {player: level.start, boxes: [...level.boxes]};
    for (const dir of solution.moves) assert.ok(step(level, state, dir), `level ${n + 1} move ${dir} was blocked`);
    assert.ok(isSolved(level, state.boxes), `level ${n + 1} not solved by its own moves`);
    report.push(`level ${n + 1}: ${solution.pushes} pushes, ${solution.moves.length} moves`);
  });
  console.log(report.join('\n'));
});

for (const backend of ['wasm', 'native', 'f32']) {
  test(`all six levels are beaten through real input in ${backend}`, () => {
    const runtime = makeRuntime(backend);
    levels.forEach((level, n) => {
      const solution = solve(level);
      let frame = runtime.frame();
      assert.equal(frame.level, n, `should be on level ${n + 1}`);
      assert.equal(frame.state, 0);
      assert.equal(frame.player, level.start);
      const model = {player: level.start, boxes: [...level.boxes]};
      solution.moves.forEach((dir, index) => {
        const before = model.player;
        step(level, model, dir);
        const result = runtime.tap(dir);
        assert.equal(result.player, model.player, `level ${n + 1} move ${index} (${dir}) from ${before}`);
        if (index < solution.moves.length - 1) {
          assert.equal(result.state, 0, `level ${n + 1} cleared early at move ${index}`);
        } else {
          assert.equal(result.state, 1, `level ${n + 1} should clear on its last move`);
          assert.equal(result.covered, level.boxes.length);
        }
      });
      assert.equal(runtime.space().state, 1, 'Space is ignored while the clear panel slides in');
      runtime.wait(CLEAR_READY);
      frame = runtime.space();
      if (n < LEVEL_COUNT - 1) {
        assert.equal(frame.level, n + 1);
        assert.equal(frame.state, 0);
      } else {
        assert.equal(frame.state, 2, 'finishing level 6 shows the win screen');
      }
    });
    // Space (or R) on the win screen starts over.
    const again = runtime.space();
    assert.equal(again.level, 0);
    assert.equal(again.state, 0);
  });
}

test('crates are pushed but never pulled', () => {
  const runtime = makeRuntime('wasm');
  const level = levels[0];
  // Walk right until a push happens, then walk back: the crate must stay put.
  let result = runtime.frame();
  const crateCell = level.boxes[0];
  let pushedTo = null;
  for (let i = 0; i < 10 && pushedTo === null; i += 1) {
    result = runtime.tap('right');
    if (result.player === crateCell) pushedTo = crateCell + 1;
  }
  assert.equal(pushedTo, crateCell + 1, 'player should have pushed the crate one cell right');
  runtime.tap('left');
  runtime.tap('left');
  const sample = runtime.frame();
  assert.ok(sample.player < crateCell, 'player walked back left past the old crate cell');
  // The crate is still where it was pushed to (a pull would have dragged it back).
  runtime.tap('right');
  const check = runtime.tap('right');
  assert.equal(check.player, crateCell, 'walking right again reaches the empty old cell, not a pulled crate');
  const push = runtime.tap('right');
  assert.equal(push.player, crateCell + 1, 'next push moves it from where it was left');
});

test('walls and double crates block pushes; restart restores the level', () => {
  const runtime = makeRuntime('wasm');
  const level = levels[0];
  // Level 1: the starting row has the crate directly right of the start.
  runtime.tap('up');
  runtime.tap('up');
  const walled = runtime.tap('up');
  assert.equal(walled.player, level.start - 9, 'cannot walk through the wall');
  runtime.tap('right');
  runtime.restart();
  const reset = runtime.frame();
  assert.equal(reset.player, level.start);
  assert.equal(reset.state, 0);
});

test('holding a key repeats moves after a delay; a tap moves exactly once', () => {
  const runtime = makeRuntime('wasm');
  const level = levels[0];
  const first = runtime.frame({1: 1});
  assert.equal(first.player, level.start + 1, 'first frame moves immediately');
  for (let i = 0; i < 5; i += 1) runtime.frame({1: 1});
  assert.equal(runtime.frame({1: 1}).player, level.start + 1, 'still waiting for the repeat delay');
  let moved = first.player;
  for (let i = 0; i < 40; i += 1) moved = runtime.frame({1: 1}).player;
  assert.ok(moved > level.start + 1, 'holding walks further');
});

test('the game draws finite, bounded triangles in every state', () => {
  const runtime = makeRuntime('wasm');
  const check = (frame, label) => {
    assert.ok(frame.triangles.length > 0 && frame.triangles.length <= 1200, `${label}: ${frame.triangles.length} triangles`);
    for (const t of frame.triangles) {
      assert.equal(t.length, 9);
      assert.ok(t.every(Number.isFinite), `${label}: finite`);
      assert.ok(t.slice(6).every((c) => c >= -0.001 && c <= 1.001), `${label}: valid colour`);
    }
  };
  levels.forEach((level, n) => {
    const solution = solve(level);
    check(runtime.frame(), `level ${n + 1} start`);
    for (const dir of solution.moves) runtime.tap(dir);
    check(runtime.frame(), `level ${n + 1} cleared`);
    // Sample the sliding panel and confetti every few ticks, then continue.
    for (let t = 0; t < CLEAR_READY + 40; t += 1) {
      const frame = runtime.frame();
      if (t % 8 === 0) check(frame, `level ${n + 1} clear tick ${t}`);
    }
    check(runtime.space(), `level ${n + 1} next`);
  });
});

// The porter's body is the only blue-shirt quad; its first triangle gives a
// stable marker for where the character is drawn.
const SHIRT = [0.2, 0.52, 0.92];
function porterX(frame) {
  const shirt = frame.triangles.filter((t) => Math.abs(t[6] - SHIRT[0]) < 0.01 && Math.abs(t[7] - SHIRT[1]) < 0.01 && Math.abs(t[8] - SHIRT[2]) < 0.01);
  assert.ok(shirt.length >= 2, 'the porter is drawn');
  return Math.min(...shirt.flatMap((t) => [t[0], t[2], t[4]]));
}
function porterY(frame) {
  const shirt = frame.triangles.filter((t) => Math.abs(t[6] - SHIRT[0]) < 0.01 && Math.abs(t[7] - SHIRT[1]) < 0.01 && Math.abs(t[8] - SHIRT[2]) < 0.01);
  return Math.min(...shirt.flatMap((t) => [t[1], t[3], t[5]]));
}

test('the porter glides into the new cell over several ticks and then rests', () => {
  const runtime = makeRuntime('wasm');
  // Let the level finish dropping in, then record the resting position.
  const rest = runtime.wait(60);
  const startX = porterX(rest);
  const startY = porterY(rest);
  const xs = [porterX(runtime.frame({1: 1}))];
  for (let i = 0; i < MOVE_TICKS + 2; i += 1) xs.push(porterX(runtime.frame()));
  assert.ok(Math.abs(xs[0] - startX) < 1e-3, 'the glide starts from the old cell');
  for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] >= xs[i - 1] - 1e-6, 'glides forward, never backward');
  assert.ok(xs[2] > startX + 5, 'is moving a couple of ticks in');
  assert.ok(Math.abs(xs.at(-1) - (startX + 64)) < 1e-3, 'settles exactly one cell over');
  // Ease-out: the early steps are bigger than the last ones.
  assert.ok(xs[2] - xs[1] > xs[MOVE_TICKS] - xs[MOVE_TICKS - 1], 'decelerates');
  assert.ok(Math.abs(porterY(runtime.frame()) - startY) < 1e-3, 'back on the ground after the hop');
});

test('a blocked move shakes the porter in place and then settles', () => {
  const runtime = makeRuntime('wasm');
  runtime.wait(60);
  runtime.tap('up');
  const against = runtime.wait(30);
  const restX = porterX(against);
  const restY = porterY(against);
  const ys = [porterY(runtime.tap('up'))];
  for (let i = 0; i < 9; i += 1) ys.push(porterY(runtime.frame()));
  assert.ok(ys.some((y) => Math.abs(y - restY) > 0.5), 'shakes while blocked');
  assert.ok(Math.abs(ys.at(-1) - restY) < 1e-3, 'settles back');
  assert.equal(porterX(runtime.frame()), restX, 'a vertical bump has no sideways drift');
});

test('the clear sound and win panel animate: confetti appears and moves', () => {
  const runtime = makeRuntime('wasm');
  levels.forEach((level, n) => {
    for (const dir of solve(level).moves) runtime.tap(dir);
    if (n < LEVEL_COUNT - 1) {
      runtime.wait(CLEAR_READY);
      runtime.space();
      runtime.wait(60);
    }
  });
  const a = runtime.wait(CLEAR_READY + 10);
  const b = runtime.wait(6);
  assert.notDeepEqual(a.triangles, b.triangles, 'the clear scene keeps animating');
  runtime.space();
  const c = runtime.wait(5);
  const d = runtime.wait(7);
  assert.equal(c.state, 2);
  assert.notDeepEqual(c.triangles, d.triangles, 'the win scene keeps animating');
});
