import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve, sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const buildTool = join(root, 'tools', 'build.mjs');
const compareStateTool = join(root, 'tools', 'compare-state.mjs');
const source = join(root, 'examples', 'shardbound.slim');
const stem = basename(source, '.slim');

function testEnvironment() {
  const environment = {...process.env};
  delete environment.SLIM_WASM_OPT;
  delete environment.SLIM_WASM_DIS;
  return environment;
}

function runTool(tool, output, packedArgument) {
  return spawnSync(process.execPath, [
    tool,
    source,
    '--out-dir',
    output,
    ...packedArgument,
  ], {
    encoding: 'utf8',
    env: testEnvironment(),
    windowsHide: true,
  });
}

function failureText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function assertFailure(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded:\n${failureText(result)}`);
  assert.match(failureText(result), pattern, `${label} reported an unexpected failure`);
}

async function removeTemporaryDirectory(directory) {
  const target = resolve(directory);
  const temporaryRoot = resolve(tmpdir());
  assert.ok(
    target !== temporaryRoot && target.startsWith(`${temporaryRoot}${sep}`),
    `refusing to remove temporary path outside ${temporaryRoot}: ${target}`,
  );
  await rm(target, {recursive: true, force: true});
}

async function writeSentinels(directory, names, label) {
  await mkdir(directory, {recursive: true});
  const contents = new Map();
  for (const name of names) {
    const value = `${label}:${name}:preserve\n`;
    const path = join(directory, name);
    await writeFile(path, value);
    contents.set(name, value);
  }
  return contents;
}

async function assertSentinelsUnchanged(directory, contents) {
  assert.equal(existsSync(directory), true, `output directory ${directory} was removed`);
  assert.deepEqual((await readdir(directory)).sort(), [...contents.keys()].sort(), 'invalid build changed output entries');
  for (const [name, expected] of contents) {
    assert.equal(await readFile(join(directory, name), 'utf8'), expected, `${name} was changed`);
  }
}

async function withTemporaryDirectory(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await removeTemporaryDirectory(directory);
  }
}

const buildSentinels = [
  'report.json',
  `${stem}.wasm`,
  `${stem}.wat`,
  `${stem}.zip`,
];

const stateSentinels = [
  'report.json',
  `${stem}.globals.wasm`,
  `${stem}.globals.wat`,
  `${stem}.globals.zip`,
  `${stem}.memory.wasm`,
  `${stem}.memory.wat`,
  `${stem}.memory.zip`,
];

test('build rejects an unknown packed array without creating or changing output', async () => {
  await withTemporaryDirectory('slim-packed-build-options-', async (directory) => {
    const freshOutput = join(directory, 'fresh');
    const fresh = runTool(buildTool, freshOutput, ['--pack-triangles', 'MISSING']);
    assertFailure(fresh, /packed triangle target .*not a declared array/i, 'build fresh output');
    assert.equal(existsSync(freshOutput), false, 'invalid build created a fresh output directory');

    const existingOutput = join(directory, 'existing');
    const sentinels = await writeSentinels(existingOutput, buildSentinels, 'build');
    const existing = runTool(buildTool, existingOutput, ['--pack-triangles', 'MISSING']);
    assertFailure(existing, /packed triangle target .*not a declared array/i, 'build existing output');
    await assertSentinelsUnchanged(existingOutput, sentinels);
  });
});

test('compare-state rejects an unknown packed array without creating or changing output', async () => {
  await withTemporaryDirectory('slim-packed-state-options-', async (directory) => {
    const freshOutput = join(directory, 'fresh');
    const fresh = runTool(compareStateTool, freshOutput, ['--pack-triangles', 'MISSING']);
    assertFailure(fresh, /packed triangle target .*not a declared array/i, 'compare-state fresh output');
    assert.equal(existsSync(freshOutput), false, 'invalid compare-state created a fresh output directory');

    const existingOutput = join(directory, 'existing');
    const sentinels = await writeSentinels(existingOutput, stateSentinels, 'compare-state');
    const existing = runTool(compareStateTool, existingOutput, ['--pack-triangles', 'MISSING']);
    assertFailure(existing, /packed triangle target .*not a declared array/i, 'compare-state existing output');
    await assertSentinelsUnchanged(existingOutput, sentinels);
  });
});

test('build malformed packed flags fail before output mutation', async () => {
  await withTemporaryDirectory('slim-packed-build-args-', async (directory) => {
    const invalidArguments = [
      ['--pack-triangles'],
      ['--pack-triangles='],
      ['--pack-triangles=-bad'],
    ];
    for (const [index, packedArgument] of invalidArguments.entries()) {
      const output = join(directory, `output-${index}`);
      const result = runTool(buildTool, output, packedArgument);
      assertFailure(result, /--pack-triangles requires an array name/i, `build malformed flag ${packedArgument.join(' ')}`);
      assert.equal(existsSync(output), false, `malformed build flag created ${output}`);
    }
  });
});

test('compare-state malformed packed flags fail before output mutation', async () => {
  await withTemporaryDirectory('slim-packed-state-args-', async (directory) => {
    const invalidArguments = [
      ['--pack-triangles'],
      ['--pack-triangles='],
      ['--pack-triangles=-bad'],
    ];
    for (const [index, packedArgument] of invalidArguments.entries()) {
      const output = join(directory, `output-${index}`);
      const result = runTool(compareStateTool, output, packedArgument);
      assertFailure(result, /--pack-triangles requires an array name/i, `compare-state malformed flag ${packedArgument.join(' ')}`);
      assert.equal(existsSync(output), false, `malformed compare-state flag created ${output}`);
    }
  });
});
