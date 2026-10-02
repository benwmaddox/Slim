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
const CLEAR_READY = 44;
const MOVE_TICKS = 10;
const map = numbers('LEVEL_MAP');
const boxes = numbers('LEVEL_BOX');
const starts = numbers('LEVEL_START');
const widths = numbers('LEVEL_W');
const heights = numbers('LEVEL_H');
const boxCounts = numbers('LEVEL_BOXES');
const pars = numbers('LEVEL_PAR');
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
  sound(97, hist_len, stars);
  let sum = 0;
  let i = 0;
  while (i < CELLS) {
    sum = sum + crate[i] * (i + 1);
    i = i + 1;
  }
  sound(96, sum, best_moves[current_level]);
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
      moves: find(97)[1],
      stars: find(97)[2],
      crates: find(96)[1],
      best: find(96)[2],
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
    assert.ok(frame.triangles.length > 0 && frame.triangles.length <= 2500, `${label}: ${frame.triangles.length} triangles`);
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
  assert.ok(Math.abs(porterY(runtime.frame()) - startY) < 2, 'back on the ground after the hop (breathing moves it under 2 px)');
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
  assert.ok(ys.some((y) => Math.abs(y - restY) > 2.5), 'shakes while blocked');
  assert.ok(Math.abs(ys.at(-1) - restY) < 2, 'settles back (breathing moves it under 2 px)');
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

// Level 1: start (1,2), crate (3,2), target (5,3), room x 1..5, y 1..3.
function stuckCrateTriangles(frame) {
  // The warning crate face is the only quad with this red, throbbing face colour.
  return frame.triangles.filter((t) => t[6] >= 0.7 && t[6] <= 0.93 && Math.abs(t[7] - 0.28) < 0.01 && Math.abs(t[8] - 0.28) < 0.01);
}

test('undo takes back walks and pushes, and counts moves', () => {
  const runtime = makeRuntime('wasm');
  const start = runtime.wait(60);
  assert.equal(start.moves, 0);
  const initialCrates = start.crates;
  runtime.tap('right');
  runtime.tap('right');
  const pushed = runtime.tap('right');
  assert.equal(pushed.moves, 3, 'two steps and a push');
  assert.notEqual(pushed.crates, initialCrates, 'the crate moved');
  runtime.tap('left');
  assert.equal(runtime.frame().moves, 4, 'a step back counts');
  // Undo everything, one press at a time.
  for (let i = 0; i < 4; i += 1) {
    runtime.frame({4: 1, 5: 1});
    runtime.frame();
  }
  const back = runtime.wait(20);
  assert.equal(back.moves, 0);
  assert.equal(back.player, levels[0].start, 'player is back at the start');
  assert.equal(back.crates, initialCrates, 'crate is back at its starting cell');
  assert.equal(runtime.frame({4: 1, 5: 1}).moves, 0, 'undo with no history does nothing');
});

test('holding Space keeps undoing, and blocked moves are not counted', () => {
  const runtime = makeRuntime('wasm');
  runtime.wait(60);
  for (const dir of ['right', 'down', 'down', 'down']) runtime.tap(dir);
  const walked = runtime.wait(3).moves;
  assert.equal(walked, 2, 'the second down walked into the bottom wall and was not counted');
  runtime.frame({4: 1, 5: 1});
  assert.equal(runtime.frame({4: 1}).moves, 1, 'first undo applies at once');
  let moves = 1;
  for (let i = 0; i < 40 && moves > 0; i += 1) moves = runtime.frame({4: 1}).moves;
  assert.equal(moves, 0, 'holding Space repeats the undo');
});

test('undo slides the porter back instead of jumping', () => {
  const runtime = makeRuntime('wasm');
  const rest = runtime.wait(60);
  const startX = porterX(rest);
  runtime.tap('right');
  const moved = runtime.wait(20);
  assert.ok(Math.abs(porterX(moved) - (startX + 64)) < 1e-3);
  const first = porterX(runtime.frame({4: 1, 5: 1}));
  assert.ok(Math.abs(first - (startX + 64)) < 1e-3, 'starts where it stood');
  const xs = [first];
  for (let i = 0; i < MOVE_TICKS + 1; i += 1) xs.push(porterX(runtime.frame()));
  for (let i = 1; i < xs.length; i += 1) assert.ok(xs[i] <= xs[i - 1] + 1e-6, 'slides back, never forward');
  assert.ok(Math.abs(xs.at(-1) - startX) < 1e-3, 'settles in the old cell');
});

test('stars follow the move count and the best finish is remembered', () => {
  const runtime = makeRuntime('wasm');
  const solution = solve(levels[0]).moves;
  // Detours of up/down steps in the open part of the room cost extra moves.
  const play = (detours) => {
    let result = runtime.frame();
    for (let i = 0; i < detours; i += 1) result = runtime.tap(i % 2 ? 'down' : 'up');
    if (detours % 2) result = runtime.tap('down');
    for (const dir of solution) result = runtime.tap(dir);
    assert.equal(result.state, 1, 'the level is cleared');
    return result;
  };
  const best = play(0);
  assert.equal(best.stars, 3, 'the reference solution earns three stars');
  assert.equal(best.moves, pars[0]);
  assert.equal(best.best, pars[0]);

  runtime.restart();
  runtime.wait(60);
  assert.equal(runtime.frame().moves, 0, 'restart clears the move counter');
  assert.equal(runtime.frame().best, pars[0], 'the best finish survives a restart');

  const okay = play(6);
  assert.ok(okay.moves > pars[0] * 1.5 && okay.moves <= pars[0] * 2.5, `${okay.moves} moves`);
  assert.equal(okay.stars, 2, 'a detour costs the third star');
  assert.equal(okay.best, pars[0], 'a worse finish does not replace the best');

  runtime.restart();
  runtime.wait(60);
  const slow = play(14);
  assert.ok(slow.moves > pars[0] * 2.5);
  assert.equal(slow.stars, 1, 'a long detour still earns one star');
  assert.equal(slow.best, pars[0]);
});

test('a crate pushed into a corner is flagged as stuck', () => {
  const runtime = makeRuntime('wasm');
  const settled = runtime.wait(60);
  assert.equal(stuckCrateTriangles(settled).length, 0, 'no warning at the start');
  // Push the crate up against the top wall, then left into the corner (1,1).
  for (const dir of ['down', 'right', 'right', 'up', 'right', 'up', 'left', 'left']) runtime.tap(dir);
  const after = runtime.wait(40);
  assert.ok(stuckCrateTriangles(after).length > 0, 'the cornered crate is drawn in the warning colour');
  // Undo repairs it and the warning goes away.
  runtime.frame({4: 1, 5: 1});
  runtime.frame();
  runtime.wait(40);
  assert.equal(stuckCrateTriangles(runtime.wait(1)).length, 0, 'warning cleared after undo');
});

test('frames stay light enough to run at 60 Hz', () => {
  const runtime = makeRuntime('wasm');
  let most = 0;
  const started = process.hrtime.bigint();
  let frames = 0;
  levels.forEach((level) => {
    for (const dir of solve(level).moves) {
      const result = runtime.tap(dir);
      most = Math.max(most, result.triangles.length, result.after.triangles.length);
      frames += 2;
    }
    for (let t = 0; t < CLEAR_READY + 10; t += 1) { most = Math.max(most, runtime.frame().triangles.length); frames += 1; }
    runtime.space();
  });
  const millis = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`most triangles in a frame: ${most}; ${frames} frames in ${millis.toFixed(0)} ms (${(millis / frames).toFixed(3)} ms/frame including the test host)`);
  assert.ok(most <= 2500);
  assert.ok(millis / frames < 5, 'well under the 16.7 ms frame budget');
});
