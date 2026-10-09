import test from 'node:test';
import assert from 'node:assert/strict';
import {compile} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

// Run `fn frame()` once on every backend and return the sound() calls it made.
function run(source, {approximateNative = false} = {}) {
  const results = [];
  for (const backend of ['wasm', 'native', 'f32']) {
    const sounds = [];
    const host = {
      input: () => 0,
      tri: () => 0,
      sin: Math.sin,
      cos: Math.cos,
      atan2: Math.atan2,
      pow: Math.pow,
      sound: (...args) => { sounds.push(args); return 0; },
    };
    let game;
    if (backend === 'wasm') {
      const bytes = compile(source);
      assert.ok(WebAssembly.validate(bytes));
      game = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: host}).exports;
    } else {
      game = Function(`return (${compileJavaScript(source, {precision: backend}).code});`)()(host);
    }
    game.init();
    game.frame();
    results.push(sounds);
  }
  if (approximateNative) {
    // Native JS keeps Math's f64 result; WASM stores each result as f32.
    results[1].forEach((sound, index) => sound.forEach((value, lane) => {
      assert.ok(Math.abs(value - results[0][index][lane]) < 1e-5, 'native JS is close to WASM');
    }));
  } else {
    assert.deepEqual(results[1], results[0], 'native JS matches WASM');
  }
  assert.deepEqual(results[2], results[0], 'f32 JS matches WASM');
  return results[0];
}

function failure(source) {
  const errors = [];
  for (const compileFn of [compile, compileJavaScript]) {
    try { compileFn(source); } catch (error) { errors.push(error.message); continue; }
    assert.fail('expected a compile error');
  }
  assert.equal(errors[0].replace('JavaScript ', ''), errors[1].replace('JavaScript ', ''));
  return errors[0];
}

test('bare return exits a function early and yields 0 as a value', () => {
  const sounds = run(`
    global hits = 0;
    fn bump(limit) {
      if (hits >= limit) {
        return;
      }
      hits = hits + 1;
    }
    fn init() {}
    fn frame() {
      bump(2);
      bump(2);
      bump(2);
      sound(1, hits, 0);
      sound(2, bump(0), 0);
    }
  `);
  assert.deepEqual(sounds, [[1, 2, 0], [2, 0, 0]]);
});

test('sibling blocks may declare the same local name', () => {
  const sounds = run(`
    fn init() {}
    fn frame() {
      let i = 0;
      while (i < 2) {
        let value = i * 10;
        sound(0, value, 0);
        i = i + 1;
      }
      if (i == 2) {
        let value = 7;
        sound(1, value, 0);
      } else {
        let value = 99;
        sound(1, value, 0);
      }
      let value = 5;
      sound(2, value, 0);
    }
  `);
  assert.deepEqual(sounds, [[0, 0, 0], [0, 10, 0], [1, 7, 0], [2, 5, 0]]);
});

test('a local only shadows a global or constant inside its own block', () => {
  const sounds = run(`
    const LIMIT = 3;
    global total = 40;
    fn init() {}
    fn frame() {
      sound(0, total, LIMIT);
      if (1) {
        let total = 1;
        let LIMIT = 8;
        sound(1, total, LIMIT);
        total = total + 1;
        sound(2, total, LIMIT);
      }
      sound(3, total, LIMIT);
    }
  `);
  assert.deepEqual(sounds, [[0, 40, 3], [1, 1, 8], [2, 2, 8], [3, 40, 3]]);
});

test('redeclaring a visible local or parameter is still an error', () => {
  assert.match(failure('fn init(){} fn frame() { let p = 1; if (p) { let p = 2; } }'), /duplicate local "p"/);
  assert.match(failure('fn init(){} fn frame() { let p = 1; let p = 2; }'), /duplicate local "p"/);
  assert.match(failure('fn f(a) { let a = 1; } fn init(){} fn frame() { f(0); }'), /duplicate local "a"/);
  assert.match(failure('fn f(a, a) { } fn init(){} fn frame() { f(0, 0); }'), /duplicate local "a"/);
});

test('floor, abs, min and max are exact numeric builtins', () => {
  const sounds = run(`
    fn init() {}
    fn frame() {
      sound(0, floor(2.9), floor(-2.1));
      sound(1, floor(-0.5), floor(7));
      sound(2, abs(-4.5), abs(3));
      sound(3, min(2, -1), max(2, -1));
      sound(4, floor(17 / 5), 17 % 5);
      sound(5, floor(-7 / 2), min(max(5, 0), 3));
    }
  `);
  assert.deepEqual(sounds, [
    [0, 2, -3], [1, -1, 7], [2, 4.5, 3], [3, -1, 2], [4, 3, 2], [5, -4, 3],
  ]);
});

test('ceil, trunc and sqrt are exact numeric builtins', () => {
  const sounds = run(`
    fn init() {}
    fn frame() {
      sound(0, ceil(2.1), ceil(-2.9));
      sound(1, trunc(2.9), trunc(-2.9));
      sound(2, sqrt(16), sqrt(2.25));
    }
  `);
  assert.deepEqual(sounds, [[0, 3, -2], [1, 2, -2], [2, 4, 1.5]]);
});

test('sin, cos, atan2 and pow call the host Math functions', () => {
  const sounds = run(`
    fn init() {}
    fn frame() {
      sound(0, sin(0.5), cos(0.5));
      sound(1, atan2(1, 2), pow(2, 10));
    }
  `, {approximateNative: true});
  const f32 = Math.fround;
  assert.deepEqual(sounds, [
    [0, f32(Math.sin(0.5)), f32(Math.cos(0.5))],
    [1, f32(Math.atan2(1, 2)), 1024],
  ]);
});

test('math builtins that need the host appear as imports, pure ones do not', () => {
  const imports = (body) => WebAssembly.Module.imports(new WebAssembly.Module(compile(`fn init(){} fn frame() { ${body} }`))).map((entry) => entry.name);
  assert.deepEqual(imports('sound(0, sqrt(4), ceil(1.5));'), ['sound']);
  assert.deepEqual(imports('sound(0, sin(1), pow(2, 3));'), ['sound', 'sin', 'pow']);
});

test('numeric builtins check arity and reserve their names', () => {
  assert.match(failure('fn init(){} fn frame() { sound(0, floor(1, 2), 0); }'), /floor.*expects 1 arguments, got 2/);
  assert.match(failure('fn init(){} fn frame() { sound(0, min(1), 0); }'), /min.*expects 2 arguments, got 1/);
  assert.match(failure('fn sqrt(x) { return x; } fn init(){} fn frame() {}'), /reserved for a builtin/);
  assert.match(failure('fn abs(x) { return x; } fn init(){} fn frame() {}'), /reserved for a builtin/);
  assert.match(failure('const max = 4; fn init(){} fn frame() {}'), /reserved for a builtin/);
});

test('numeric builtins add no imports', () => {
  const bytes = compile('fn init(){} fn frame() { sound(0, floor(1.5), 0); }');
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module).map((entry) => entry.name), ['sound']);
});
