import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const python = process.env.SLIM_PYTHON || 'python';
const zipTool = fileURLToPath(new URL('../tools/zip.py', import.meta.url));
const buildTool = fileURLToPath(new URL('../tools/build.mjs', import.meta.url));

function runPython(args) {
  return spawnSync(python, args, {encoding: 'utf8'});
}

function runBuild(source, output) {
  const result = spawnSync(process.execPath, [buildTool, source, '--out-dir', output], {
    encoding: 'utf8',
    env: {...process.env},
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inspectZip(path) {
  const script = [
    'import json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    '  print(json.dumps({"names": z.namelist(), "index": z.read("index.html").decode("utf-8")}))',
  ].join('\n');
  const result = runPython(['-c', script, path]);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

test('ZIP mappings are deterministic and preserve explicit archive aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-zip-'));
  try {
    await writeFile(join(directory, 'page.html'), '<!doctype html><title>Alias</title>');
    await writeFile(join(directory, 'payload.wasm'), 'inspection-only');
    const first = join(directory, 'a.zip');
    const second = join(directory, 'b.zip');
    for (const target of [first, second]) {
      const result = runPython([zipTool, directory, target, 'index.html=page.html', 'rainbow.wasm=payload.wasm']);
      assert.equal(result.status, 0, result.stderr || String(result.error));
    }
    assert.deepEqual(await readFile(first), await readFile(second));
    const archive = inspectZip(first);
    assert.deepEqual(archive.names, ['index.html', 'rainbow.wasm']);
    assert.equal(archive.index, '<!doctype html><title>Alias</title>');

    const invalid = runPython([zipTool, directory, join(directory, 'invalid.zip'), '../index.html=page.html']);
    assert.notEqual(invalid.status, 0, 'path traversal must be rejected');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('build emits source-named WASM, WAT, JS, and ZIP artifacts with fair size records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-build-'));
  try {
    const sourceName = 'small game.slim';
    const source = join(directory, sourceName);
    const output = join(directory, 'dist');
    const sourceText = `
global x = 120;
fn init() { x = 120; }
fn frame() { tri(x, 100, x + 20, 100, x, 120, 0.2, 0.7, 1); }
`;
    await writeFile(source, sourceText);
    await mkdir(output, {recursive: true});
    await writeFile(join(output, 'keep.txt'), 'preserve this file');
    runBuild(source, output);

    const stem = 'small-game';
    const expected = [
      `${stem}.wasm`, `${stem}.wat`, `${stem}.html`, `${stem}.size.json`,
      `${stem}.js`, `${stem}.js.html`, `${stem}.js.zip`,
      `${stem}.f32.js`, `${stem}.f32.html`, `${stem}.f32.zip`, `${stem}.zip`,
    ];
    for (const name of expected) assert.ok((await stat(join(output, name))).isFile(), `missing ${name}`);
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'preserve this file');
    assert.equal((await stat(join(output, 'small-game.wat'))).isFile(), true);

    const wasm = await readFile(join(output, `${stem}.wasm`));
    assert.ok(WebAssembly.validate(wasm), 'selected WASM must validate');
    const wat = await readFile(join(output, `${stem}.wat`), 'utf8');
    assert.match(wat, /^\(module\b/, 'WAT must be a module disassembly');

    const report = JSON.parse(await readFile(join(output, `${stem}.size.json`), 'utf8'));
    assert.equal(report.source, sourceName);
    assert.equal(report.stem, stem);
    assert.equal(report.selectedWasm.backend, 'wasm');
    assert.equal(report.selectedJs.precision, 'native');
    assert.equal(report.selectedF32.precision, 'f32');
    assert.ok(report.candidates.some((candidate) => candidate.id === 'plain-embedded'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'plain-external'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'js-unminified'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'js-min'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'f32-unminified'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'f32-min'));
    assert.ok(report.candidates.every((candidate) => candidate.zipBytes > 0));

    const wasmZip = inspectZip(join(output, `${stem}.zip`));
    const expectedWasmNames = report.selectedWasm.layout === 'external' ? ['index.html', `${stem}.wasm`] : ['index.html'];
    assert.deepEqual(wasmZip.names, expectedWasmNames);
    assert.equal(wasmZip.index, await readFile(join(output, `${stem}.html`), 'utf8'));
    assert.equal(wasmZip.names.includes(`${stem}.wat`), false, 'WAT must stay outside the playable ZIP');

    const jsZip = inspectZip(join(output, `${stem}.js.zip`));
    assert.deepEqual(jsZip.names, ['index.html']);
    assert.equal(jsZip.index, await readFile(join(output, `${stem}.js.html`), 'utf8'));
    const f32Zip = inspectZip(join(output, `${stem}.f32.zip`));
    assert.deepEqual(f32Zip.names, ['index.html']);
    assert.equal(f32Zip.index, await readFile(join(output, `${stem}.f32.html`), 'utf8'));

    for (const candidate of report.candidates) {
      const archivePath = join(output, candidate.archive);
      assert.equal((await stat(archivePath)).size, candidate.zipBytes, `${candidate.id} size record must match archive`);
      const archive = inspectZip(archivePath);
      assert.equal(archive.names.includes(`${stem}.wat`), false);
    }

    const stableNames = expected.concat(report.candidates.map((candidate) => candidate.archive));
    const before = new Map();
    for (const name of stableNames) before.set(name, digest(await readFile(join(output, name))));
    runBuild(source, output);
    for (const [name, hash] of before) assert.equal(digest(await readFile(join(output, name))), hash, `${name} must be deterministic`);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
