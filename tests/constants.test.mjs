import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDetailed, parseProgram} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

function wasmRuntime(source, globalStorage = 'globals') {
  const detailed = compileDetailed(source, {globalStorage});
  assert.ok(WebAssembly.validate(detailed.wasm));
  const module = new WebAssembly.Module(detailed.wasm);
  const instance = new WebAssembly.Instance(module, {e: {input: () => 0}});
  return {detailed, module, instance};
}

function javascriptRuntime(source, precision = 'native') {
  const result = compileJavaScript(source, {precision});
  const factory = Function(`return (${result.code});`)();
  return {result, runtime: factory()};
}

test('resolves chained and forward constants in the shared frontend with no runtime declarations', () => {
  const source = `
    const ANSWER = LATER + 1;
    const LATER = 2;
    global value = ANSWER;
    fn init() {}
    fn frame() { return value + ANSWER; }
  `;
  const literal = `
    global value = 3;
    fn init() {}
    fn frame() { return value + 3; }
  `;

  const program = parseProgram(source);
  assert.equal(Object.hasOwn(program, 'constants'), false);
  assert.equal(program.globals[0].expression.kind, 'num');
  assert.equal(program.functions.get('frame').body[0].expression.right.kind, 'num');

  for (const globalStorage of ['globals', 'memory']) {
    const withConstants = wasmRuntime(source, globalStorage);
    const literalOnly = wasmRuntime(literal, globalStorage);
    assert.deepEqual([...withConstants.detailed.wasm], [...literalOnly.detailed.wasm], globalStorage);
    assert.deepEqual(withConstants.detailed.globals, ['value']);
    assert.equal(withConstants.instance.exports.frame(), 6);
    assert.deepEqual(WebAssembly.Module.exports(withConstants.module), [
      {name: 'init', kind: 'function'},
      {name: 'frame', kind: 'function'},
      {name: 'memory', kind: 'memory'},
    ]);
  }

  for (const precision of ['native', 'f32']) {
    const withConstants = compileJavaScript(source, {precision});
    const literalOnly = compileJavaScript(literal, {precision});
    assert.equal(withConstants.code, literalOnly.code, precision);
    assert.equal(withConstants.code.includes('ANSWER'), false);
    assert.equal(javascriptRuntime(source, precision).runtime.frame(), 6);
  }
});

test('evaluates constant expressions with f32 rounding and preserves special values', () => {
  const source = `
    const ROUNDED = 16777216 + 1 - 16777216;
    const NEGATIVE_ZERO = -0;
    const NAN_VALUE = +(0 / 0);
    const POSITIVE_INFINITY = 1 / 0;
    const NEGATIVE_INFINITY = -POSITIVE_INFINITY;
    global rounded = ROUNDED;
    global negativeZero = NEGATIVE_ZERO;
    global nanValue = NAN_VALUE;
    global positiveInfinity = POSITIVE_INFINITY;
    global negativeInfinity = NEGATIVE_INFINITY;
    fn init() {}
    fn frame() { return NEGATIVE_ZERO; }
  `;
  const {detailed, instance} = wasmRuntime(source, 'memory');
  const values = new Float32Array(instance.exports.memory.buffer, 0, 5);
  assert.deepEqual(detailed.globals, [
    'rounded', 'negativeZero', 'nanValue', 'positiveInfinity', 'negativeInfinity',
  ]);
  assert.equal(values[0], 0);
  assert.ok(Object.is(values[1], -0));
  assert.equal(1 / values[1], -Infinity);
  assert.ok(Number.isNaN(values[2]));
  assert.equal(values[3], Infinity);
  assert.equal(values[4], -Infinity);
  assert.ok(Object.is(instance.exports.frame(), -0));

  for (const precision of ['native', 'f32']) {
    const {result, runtime} = javascriptRuntime(source, precision);
    assert.match(result.code, /NaN/);
    assert.match(result.code, /Infinity/);
    assert.ok(Object.is(runtime.frame(), -0));
  }
});

test('function locals and parameters shadow constants from their declaration onward', () => {
  const source = `
    const VALUE = 9;
    fn identity(VALUE) { return VALUE; }
    fn assignShadow() { let VALUE = 2; VALUE = 3; return VALUE; }
    fn init() {}
    fn frame() {
      let before = VALUE;
      let VALUE = 2;
      return before + identity(VALUE) + assignShadow();
    }
  `;
  // Locals are block scoped: `before` still sees the constant (9) because the
  // `let VALUE` comes after it.
  assert.equal(wasmRuntime(source).instance.exports.frame(), 14);
  assert.equal(javascriptRuntime(source, 'native').runtime.frame(), 14);
  assert.equal(javascriptRuntime(source, 'f32').runtime.frame(), 14);
});

test('rejects invalid constant declarations and immutable assignments deterministically', () => {
  const prefix = 'fn init() {} fn frame() { return 0; }';
  assert.throws(
    () => compileDetailed(`const BAD = input(0); ${prefix}`),
    /Slim compile error at 1:\d+: constant initializers must be constant numeric expressions/,
  );
  assert.throws(
    () => compileDetailed(`const BAD = missing; ${prefix}`),
    /Slim compile error at 1:\d+: constant initializers must be constant numeric expressions/,
  );
  assert.throws(
    () => compileDetailed(`global MUTABLE = 1; const BAD = MUTABLE; ${prefix}`),
    /Slim compile error at 1:\d+: constant initializers must be constant numeric expressions/,
  );
  assert.throws(
    () => compileDetailed(`const FIRST = SECOND; const SECOND = FIRST; ${prefix}`),
    /Slim compile error at 1:\d+: cyclic constant reference involving "FIRST"/,
  );
  assert.throws(
    () => compileDetailed(`const VALUE = 1; const VALUE = 2; ${prefix}`),
    /Slim compile error at 1:\d+: duplicate constant "VALUE"/,
  );
  assert.throws(
    () => compileDetailed(`const VALUE = 1; global VALUE = 2; ${prefix}`),
    /Slim compile error at 1:\d+: constant name "VALUE" collides with a global/,
  );
  assert.throws(
    () => compileDetailed(`const VALUE = 1; fn VALUE() {} ${prefix}`),
    /Slim compile error at 1:\d+: constant name "VALUE" collides with a function/,
  );
  assert.throws(
    () => compileDetailed(`const input = 1; ${prefix}`),
    /Slim compile error at 1:\d+: constant name "input" is reserved for a builtin/,
  );
  assert.throws(
    () => compileDetailed(`const VALUE = 1; fn unreachable() { VALUE = 2; } ${prefix}`),
    /Slim compile error at 1:\d+: cannot assign to constant "VALUE"/,
  );
});
