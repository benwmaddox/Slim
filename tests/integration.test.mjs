import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compile} from '../src/compiler.mjs';

const root = resolve(import.meta.dirname, '..');
const samplePath = resolve(root, 'examples/rainbow.slim');

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function makeRuntime(bytes) {
  const module = new WebAssembly.Module(bytes);
  const descriptors = WebAssembly.Module.imports(module);
  const imports = Object.create(null);
  const inputValues = Object.create(null);
  const triangles = [];
  const sounds = [];

  const setInputs = (values = {}) => {
    for (const key of Object.keys(inputValues)) delete inputValues[key];
    for (const [key, value] of Object.entries(values)) inputValues[key] = value;
  };
  const clearFrame = () => {
    triangles.length = 0;
    sounds.length = 0;
  };

  for (const descriptor of descriptors) {
    assert.equal(descriptor.kind, 'function', `unexpected ${descriptor.kind} import ${descriptor.module}.${descriptor.name}`);
    const namespace = imports[descriptor.module] || (imports[descriptor.module] = {});
    if (descriptor.name === 'tri') {
      namespace[descriptor.name] = (...args) => {
        triangles.push(args);
        return 0;
      };
    } else if (descriptor.name === 'sound') {
      namespace[descriptor.name] = (...args) => {
        sounds.push(args);
        return 0;
      };
    } else if (descriptor.name === 'input') {
      namespace[descriptor.name] = (index) => Number(inputValues[index | 0] || 0);
    } else {
      assert.fail(`unexpected host import ${descriptor.module}.${descriptor.name}`);
    }
  }

  const instance = new WebAssembly.Instance(module, imports);
  assert.equal(typeof instance.exports.init, 'function', 'compiled game must export init');
  assert.equal(typeof instance.exports.frame, 'function', 'compiled game must export frame');
  assert.ok(descriptors.some((item) => item.name === 'tri'), 'sample must import tri');
  assert.ok(descriptors.some((item) => item.name === 'sound'), 'sample must import sound');
  assert.ok(descriptors.some((item) => item.name === 'input'), 'sample must import input');

  const frame = (values = {}) => {
    setInputs(values);
    clearFrame();
    instance.exports.frame();
    return {
      triangles: triangles.map((triangle) => triangle.slice()),
      sounds: sounds.map((event) => event.slice())
    };
  };

  return {instance, frame, setInputs, clearFrame, triangles, sounds};
}

function colorNear(triangle, r, g, b) {
  return triangle.length === 9 &&
    Math.abs(triangle[6] - r) < 0.01 &&
    Math.abs(triangle[7] - g) < 0.01 &&
    Math.abs(triangle[8] - b) < 0.01;
}

function triangleCentroidX(triangle) {
  return (triangle[0] + triangle[2] + triangle[4]) / 3;
}

function assertFrameIsFinite(triangles, label) {
  assert.ok(triangles.length > 0, `${label} should draw at least one triangle`);
  assert.ok(triangles.length <= 256, `${label} emitted ${triangles.length} triangles (bound 256)`);
  for (const triangle of triangles) {
    assert.equal(triangle.length, 9, `${label} triangle ABI is 3 points plus one color`);
    assert.ok(triangle.every(finite), `${label} contains a non-finite draw value`);
    assert.ok(triangle.slice(6).every((channel) => channel >= 0 && channel <= 1), `${label} has an invalid color channel`);
  }
}

test('compiler emits a runnable real WASM game with bounded triangle frames', async () => {
  const source = await readFile(samplePath, 'utf8');
  const bytes = compile(source);
  assert.ok(bytes instanceof Uint8Array, 'compile() must return Uint8Array');
  assert.ok(bytes.byteLength > 8, 'compiled module must contain a WASM payload');
  assert.ok(WebAssembly.validate(bytes), 'compiler emitted invalid WASM');

  const runtime = makeRuntime(bytes);
  runtime.instance.exports.init();
  const first = runtime.frame();
  assertFrameIsFinite(first.triangles, 'initial frame');

  const playerTriangles = first.triangles.filter((triangle) => colorNear(triangle, 0.18, 0.92, 1));
  assert.ok(playerTriangles.length > 0, 'initial scene should contain the player triangle');
  const beforeMove = triangleCentroidX(playerTriangles[0]);
  const moved = runtime.frame({1: 1});
  const movedPlayer = moved.triangles.find((triangle) => colorNear(triangle, 0.18, 0.92, 1));
  assert.ok(movedPlayer, 'right-input frame should still contain the player');
  assert.ok(triangleCentroidX(movedPlayer) > beforeMove + 1, 'right input should move the player right');

  let maximumTriangles = Math.max(first.triangles.length, moved.triangles.length);
  for (let i = 0; i < 1000; i += 1) {
    const frame = runtime.frame();
    assertFrameIsFinite(frame.triangles, `frame ${i}`);
    maximumTriangles = Math.max(maximumTriangles, frame.triangles.length);
  }
  assert.ok(maximumTriangles <= 256, `draw count exceeded the per-frame bound: ${maximumTriangles}`);
});

test('sample collects all shards, emits sound events, and restarts after winning', async () => {
  const source = await readFile(samplePath, 'utf8');
  const runtime = makeRuntime(compile(source));
  runtime.instance.exports.init();

  runtime.frame({4: 1, 8: 1, 6: 180, 7: 160});
  runtime.frame({4: 1, 8: 1, 6: 400, 7: 290});
  runtime.frame({4: 1, 8: 1, 6: 620, 7: 420});
  assert.deepEqual(runtime.sounds.map((event) => event[0]), [0, 2], 'final shard collection and winning should emit both sounds on the winning tick');

  const winningFrame = runtime.frame();
  assertFrameIsFinite(winningFrame.triangles, 'winning frame');
  assert.equal(winningFrame.triangles.some((triangle) => colorNear(triangle, 0.18, 0.92, 1)), false, 'winning scene should replace the player scene');

  const restarted = runtime.frame({9: 1});
  assertFrameIsFinite(restarted.triangles, 'restarted frame');
  assert.ok(restarted.triangles.some((triangle) => colorNear(triangle, 0.18, 0.92, 1)), 'restart should restore the player scene');
});

test('sample emits a hazard sound and can restart after losing', async () => {
  const source = await readFile(samplePath, 'utf8');
  const runtime = makeRuntime(compile(source));
  runtime.instance.exports.init();

  let lossFrame;
  for (let i = 0; i < 24; i += 1) {
    const frame = runtime.frame({4: 1, 8: 1, 6: 120, 7: 78});
    if (runtime.sounds.some((event) => event[0] === 1)) {
      lossFrame = frame;
      break;
    }
  }
  assert.ok(lossFrame, 'holding on the first hazard should eventually lose');
  assert.deepEqual(runtime.sounds.map((event) => event[0]), [1], 'losing should emit the hazard sound');
  assert.equal(lossFrame.triangles.some((triangle) => colorNear(triangle, 0.18, 0.92, 1)), false, 'loss scene should replace the player scene');

  const restarted = runtime.frame({9: 1});
  assertFrameIsFinite(restarted.triangles, 'loss restart frame');
  assert.ok(restarted.triangles.some((triangle) => colorNear(triangle, 0.18, 0.92, 1)), 'restart should restore the player after losing');
});
