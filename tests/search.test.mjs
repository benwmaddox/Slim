import test from 'node:test';
import assert from 'node:assert/strict';
import {stagedSearch} from '../tools/search.mjs';

function compareByZip(left, right) {
  return left.zipBytes - right.zipBytes || left.id.localeCompare(right.id);
}

function candidateFor(settings, zipBytes, extra = {}) {
  const id = Object.entries(settings).map(([name, value]) => `${name}=${value}`).join(',');
  return {id, zipBytes, ...settings, ...extra};
}

test('stagedSearch holds other settings while recording actual coordinate trials', async () => {
  const initial = {optimization: 'plain', layout: 'embedded', triangles: 'unpacked'};
  const costs = new Map([
    ['optimization=plain,layout=embedded,triangles=unpacked', 100],
    ['optimization=Oz,layout=embedded,triangles=unpacked', 90],
    ['optimization=Os,layout=embedded,triangles=unpacked', 95],
    ['optimization=Oz,layout=external,triangles=unpacked', 80],
  ]);
  const evaluations = [];
  const choiceInputs = [];
  const evaluate = async (settings) => {
    const copy = {...settings};
    evaluations.push(copy);
    const id = Object.entries(copy).map(([name, value]) => `${name}=${value}`).join(',');
    return candidateFor(copy, costs.get(id) ?? 999);
  };

  const result = await stagedSearch({
    initial,
    axes: [
      {
        name: 'optimization',
        choices: (current) => {
          choiceInputs.push({...current});
          return ['Oz', 'Os'];
        },
      },
      {
        name: 'layout',
        choices: (current) => {
          choiceInputs.push({...current});
          return ['external'];
        },
      },
    ],
    evaluate,
    compare: compareByZip,
    maxPasses: 1,
  });

  assert.equal(result.best.id, 'optimization=Oz,layout=external,triangles=unpacked');
  assert.deepEqual(evaluations, [
    initial,
    {optimization: 'Oz', layout: 'embedded', triangles: 'unpacked'},
    {optimization: 'Os', layout: 'embedded', triangles: 'unpacked'},
    {optimization: 'Oz', layout: 'external', triangles: 'unpacked'},
  ]);
  assert.equal(choiceInputs[0].optimization, 'plain');
  assert.equal(choiceInputs[1].optimization, 'Oz', 'later axes receive the current winner');
  assert.equal(choiceInputs[1].layout, 'embedded');

  assert.deepEqual(result.stages, [
    {
      pass: 0,
      axis: 'baseline',
      before: null,
      after: candidateFor(initial, 100),
      trials: [candidateFor(initial, 100)],
    },
    {
      pass: 1,
      axis: 'optimization',
      before: candidateFor(initial, 100),
      after: candidateFor({optimization: 'Oz', layout: 'embedded', triangles: 'unpacked'}, 90),
      trials: [
        candidateFor({optimization: 'Oz', layout: 'embedded', triangles: 'unpacked'}, 90),
        candidateFor({optimization: 'Os', layout: 'embedded', triangles: 'unpacked'}, 95),
      ],
    },
    {
      pass: 1,
      axis: 'layout',
      before: candidateFor({optimization: 'Oz', layout: 'embedded', triangles: 'unpacked'}, 90),
      after: candidateFor({optimization: 'Oz', layout: 'external', triangles: 'unpacked'}, 80),
      trials: [candidateFor({optimization: 'Oz', layout: 'external', triangles: 'unpacked'}, 80)],
    },
  ]);
});

test('stagedSearch revisits earlier axes on a second pass when an interaction appears', async () => {
  const costs = new Map([
    ['a0-b0', 10],
    ['a1-b0', 10],
    ['a0-b1', 9],
    ['a1-b1', 1],
  ]);
  const evaluate = (settings) => {
    const id = `${settings.a}-${settings.b}`;
    return {id, zipBytes: costs.get(id)};
  };

  const result = await stagedSearch({
    initial: {a: 'a0', b: 'b0'},
    axes: [
      {name: 'a', choices: () => ['a1']},
      {name: 'b', choices: () => ['b1']},
    ],
    evaluate,
    compare: compareByZip,
    maxPasses: 2,
  });

  assert.equal(result.best.id, 'a1-b1');
  assert.deepEqual(result.stages.map(({pass, axis}) => `${pass}:${axis}`), [
    '0:baseline',
    '1:a', '1:b',
    '2:a', '2:b',
  ]);
  assert.deepEqual(result.stages.map(({axis, before, after}) => [axis, before?.id ?? null, after.id]), [
    ['baseline', null, 'a0-b0'],
    ['a', 'a0-b0', 'a0-b0'],
    ['b', 'a0-b0', 'a0-b1'],
    ['a', 'a0-b1', 'a1-b1'],
    ['b', 'a1-b1', 'a1-b1'],
  ]);
  assert.equal(result.stages[3].trials[0].zipBytes, 1, 'the second pass must evaluate the interaction at its actual cost');
});

test('stagedSearch remains a bounded coordinate search when the global combination is only jointly better', async () => {
  const evaluated = [];
  const costs = new Map([
    ['x0-y0', 10],
    ['x1-y0', 11],
    ['x0-y1', 11],
    ['x1-y1', 1],
  ]);
  const evaluate = (settings) => {
    const id = `${settings.x}-${settings.y}`;
    evaluated.push(id);
    return {id, zipBytes: costs.get(id)};
  };

  const result = await stagedSearch({
    initial: {x: 'x0', y: 'y0'},
    axes: [
      {name: 'x', choices: () => ['x1']},
      {name: 'y', choices: () => ['y1']},
    ],
    evaluate,
    compare: compareByZip,
    maxPasses: 2,
  });

  assert.equal(result.best.id, 'x0-y0', 'a local miss may remain when only the Cartesian combination wins');
  assert.deepEqual(evaluated, ['x0-y0', 'x1-y0', 'x0-y1'], 'the helper must not silently enumerate the Cartesian product');
  assert.deepEqual(result.stages.map(({pass, axis}) => `${pass}:${axis}`), ['0:baseline', '1:x', '1:y']);
});

test('stagedSearch honors comparator tie preference and records disabled and forced axes', async () => {
  const evaluated = [];
  const initial = {mode: 'fixed', sound: 'none'};
  const evaluate = (settings) => {
    const copy = {...settings};
    evaluated.push(copy);
    const complexity = settings.mode === 'simple' ? 0 : settings.mode === 'other' ? 1 : 2;
    return {id: `${settings.mode}-${settings.sound}`, zipBytes: 20, complexity, ...settings};
  };
  const compare = (left, right) => left.zipBytes - right.zipBytes || left.complexity - right.complexity || left.id.localeCompare(right.id);

  const result = await stagedSearch({
    initial,
    axes: [
      {name: 'mode', choices: () => ['simple', 'other']},
      {name: 'disabled', choices: () => []},
      {name: 'sound', choices: (current) => {
        assert.equal(current.sound, 'none');
        return ['none'];
      }},
    ],
    evaluate,
    compare,
    maxPasses: 1,
  });

  assert.equal(result.best.id, 'simple-none', 'equal ZIPs must use the comparator tie preference');
  assert.deepEqual(evaluated, [
    {mode: 'fixed', sound: 'none'},
    {mode: 'simple', sound: 'none'},
    {mode: 'other', sound: 'none'},
    {mode: 'simple', sound: 'none'},
  ], 'forced settings stay fixed and a disabled axis creates no trial');
  assert.deepEqual(result.stages.map(({axis, trials}) => [axis, trials.map((candidate) => candidate.id)]), [
    ['baseline', ['fixed-none']],
    ['mode', ['simple-none', 'other-none']],
    ['disabled', []],
    ['sound', ['simple-none']],
  ]);
});

test('stagedSearch carries evaluator-normalized axis values into later trials', async () => {
  const calls = [];
  const evaluate = (settings) => {
    calls.push({...settings});
    const actualIntegerStorage = settings.integerArrayStorage === 'compact' ? 'f32' : settings.integerArrayStorage;
    const requested = settings.integerArrayStorage;
    const id = `${requested}-${settings.soundPacking}`;
    const zipBytes = settings.soundPacking === 'bytes' ? 80 : requested === 'compact' ? 90 : 100;
    return {
      id,
      zipBytes,
      integerArrayStorage: actualIntegerStorage,
      soundPacking: settings.soundPacking,
      requestedIntegerArrayStorage: requested,
    };
  };

  const result = await stagedSearch({
    initial: {integerArrayStorage: 'f32', soundPacking: 'none'},
    axes: [
      {name: 'integerArrayStorage', choices: () => ['compact']},
      {name: 'soundPacking', choices: () => ['bytes']},
    ],
    evaluate,
    compare: compareByZip,
    maxPasses: 1,
  });

  assert.equal(result.best.id, 'f32-bytes');
  assert.equal(result.stages[1].after.integerArrayStorage, 'f32', 'the accepted candidate reports its actual storage');
  assert.deepEqual(calls, [
    {integerArrayStorage: 'f32', soundPacking: 'none'},
    {integerArrayStorage: 'compact', soundPacking: 'none'},
    {integerArrayStorage: 'f32', soundPacking: 'bytes'},
  ], 'later axes must hold the evaluator-normalized value');
});
