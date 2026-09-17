import test from 'node:test';
import assert from 'node:assert/strict';
import {compile, compileDetailed} from '../src/compiler.mjs';

function instantiate(source, imports = {}) {
  const bytes = compile(source);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(WebAssembly.validate(bytes));
  const module = new WebAssembly.Module(bytes);
  return {
    bytes,
    module,
    instance: new WebAssembly.Instance(module, imports),
  };
}

test('emits real WASM with mutable f32 globals, functions, memory, and entry exports', () => {
  const source = `
    global value = 2;
    fn twice(x) { return x * 2; }
    fn init() { value = 3; }
    fn frame() { value = twice(value) + 1; return value; }
  `;
  const {instance} = instantiate(source);

  assert.deepEqual(
    WebAssembly.Module.exports(new WebAssembly.Module(compile(source))),
    [
      {name: 'init', kind: 'function'},
      {name: 'frame', kind: 'function'},
      {name: 'memory', kind: 'memory'},
    ],
  );
  assert.equal(instance.exports.init(), 0);
  assert.equal(instance.exports.frame(), 7);
  assert.equal(instance.exports.frame(), 15);
  assert.equal(instance.exports.memory.buffer.byteLength, 65536);
});

test('supports if/else, while, comparisons, logical operators, and modulo', () => {
  const source = `
    fn init() {}
    fn frame() {
      let i = 0;
      let total = 0;
      while (i < 5) {
        total = total + i;
        i = i + 1;
      }
      if (total == 10 && !(i < 5)) {
        return total % 3;
      } else {
        return 99;
      }
    }
  `;
  const {instance} = instantiate(source);
  assert.equal(instance.exports.frame(), 1);
});

test('keeps builtin imports reachable and prunes dead functions/imports', () => {
  const source = `
    fn dead() {
      tri(0, 0, 1, 0, 0, 1, 1, 0, 0);
      sound(1, 1, 1);
    }
    fn init() {}
    fn frame() { return input(4); }
  `;
  const detailed = compileDetailed(source);
  assert.deepEqual(detailed.imports, ['input']);
  assert.deepEqual(detailed.functions, ['init', 'frame']);
  const module = new WebAssembly.Module(detailed.wasm);
  assert.deepEqual(WebAssembly.Module.imports(module), [
    {module: 'e', name: 'input', kind: 'function'},
  ]);
  const {instance} = instantiate(source, {e: {input: (index) => index + 0.5}});
  assert.equal(instance.exports.frame(), 4.5);
});

test('short-circuits logical expressions before calling imports', () => {
  const calls = [];
  const {instance} = instantiate(
    'fn init() {} fn frame() { return (0 && input(2)) + (1 || input(3)); }',
    {e: {input: (index) => { calls.push(index); return 5; }}},
  );
  assert.equal(instance.exports.frame(), 1);
  assert.deepEqual(calls, []);
});

test('imports tri, sound, and input with the compact f32 signatures', () => {
  const calls = [];
  const {module, instance} = instantiate(
    `
      fn init() {}
      fn frame() {
        tri(1, 2, 3, 4, 5, 6, 0.1, 0.2, 0.3);
        sound(2, 1.5, 0.25);
        return input(8);
      }
    `,
    {e: {
      tri: (...args) => { calls.push(['tri', args]); return 0; },
      sound: (...args) => { calls.push(['sound', args]); return 0; },
      input: (index) => { calls.push(['input', index]); return 8; },
    }},
  );
  assert.deepEqual(WebAssembly.Module.imports(module), [
    {module: 'e', name: 'tri', kind: 'function'},
    {module: 'e', name: 'sound', kind: 'function'},
    {module: 'e', name: 'input', kind: 'function'},
  ]);
  assert.equal(instance.exports.frame(), 8);
  assert.deepEqual(calls, [
    ['tri', [1, 2, 3, 4, 5, 6, Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]],
    ['sound', [2, 1.5, 0.25]],
    ['input', 8],
  ]);
});

test('reports deterministic source diagnostics for malformed programs', () => {
  assert.throws(
    () => compile('fn init() {}'),
    /Slim compile error at 1:1: missing required exported function "frame"/,
  );
  assert.throws(
    () => compile('fn init() {}\nfn frame() { return input(0, 1); }'),
    /Slim compile error at 2:21: builtin "input" expects 1 arguments, got 2/,
  );
  assert.throws(
    () => compile('fn init() {}\nfn frame() { return missing; }'),
    /Slim compile error at 2:21: unknown value "missing"/,
  );
  assert.throws(
    () => compile('fn init() {}\nfn frame(pressed) {}'),
    /Slim compile error at 2:1: exported function "frame" must have zero parameters/,
  );
  assert.throws(
    () => compile('fn init() {}\nfn frame() { return toString(); }'),
    /Slim compile error at 2:21: unknown function "toString"/,
  );
});

test('evaluates constant globals with the same f32 rounding as runtime arithmetic', () => {
  const {instance} = instantiate(`
    global rounded = 16777216 + 1 - 16777216;
    fn init() {}
    fn frame() { return rounded; }
  `);
  assert.equal(instance.exports.frame(), 0);
});

test('lowers f32 remainder with truncation toward zero', () => {
  const positive = instantiate(`
    fn remainder(a, b) { return a % b; }
    fn init() {}
    fn frame() { return remainder(5, 3); }
  `).instance;
  const negative = instantiate(`
    fn remainder(a, b) { return a % b; }
    fn init() {}
    fn frame() { return remainder(-5, 3); }
  `).instance;
  assert.equal(positive.exports.frame(), 2);
  assert.equal(negative.exports.frame(), -2);
});
