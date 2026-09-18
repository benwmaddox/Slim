import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
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

function runBuild(source, output, flags = []) {
  const result = spawnSync(process.execPath, [buildTool, source, '--out-dir', output, ...flags], {
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
    const stem = 'small-game';
    const sourceText = `
global x = 120;
fn init() { x = 120; }
fn frame() { tri(x, 100, x + 20, 100, x, 120, 0.2, 0.7, 1); }
`;
    await writeFile(source, sourceText);
    await mkdir(output, {recursive: true});
    await writeFile(join(output, 'keep.txt'), 'preserve this file');
    const obsolete = [
      `${stem}.plain.wasm`,
      `${stem}.Oz.wasm`,
      `${stem}.plain-embedded.zip`,
      `${stem}.plain-embedded-min.zip`,
      `${stem}.plain-external.zip`,
      `${stem}.plain-external-min.zip`,
      `${stem}.Oz-embedded.zip`,
      `${stem}.Oz-embedded-min.zip`,
      `${stem}.Oz-external.zip`,
      `${stem}.Oz-external-min.zip`,
      `${stem}.js-unminified.zip`,
      `${stem}.js-min.zip`,
      `${stem}.f32-unminified.zip`,
      `${stem}.f32-min.zip`,
    ];
    for (const name of obsolete) await writeFile(join(output, name), 'obsolete');
    const otherStem = 'other-game.plain.wasm';
    await writeFile(join(output, otherStem), 'preserve other source');
    runBuild(source, output);

    const expected = [
      `${stem}.wasm`, `${stem}.wat`, `${stem}.html`, `${stem}.size.json`,
      `${stem}.js`, `${stem}.js.html`, `${stem}.js.zip`,
      `${stem}.zip`,
    ];
    const compareExpected = expected.concat([`${stem}.f32.js`, `${stem}.f32.html`, `${stem}.f32.zip`]);
    const actualNames = (await readdir(output)).sort();
    assert.deepEqual(actualNames, [...expected, 'keep.txt', otherStem].sort());
    for (const name of expected) assert.ok((await stat(join(output, name))).isFile(), `missing ${name}`);
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'preserve this file');
    assert.equal(await readFile(join(output, otherStem), 'utf8'), 'preserve other source');
    assert.equal((await stat(join(output, 'small-game.wat'))).isFile(), true);

    const wasm = await readFile(join(output, `${stem}.wasm`));
    assert.ok(WebAssembly.validate(wasm), 'selected WASM must validate');
    const wat = await readFile(join(output, `${stem}.wat`), 'utf8');
    assert.match(wat, /^\(module\b/, 'WAT must be a module disassembly');

    const report = JSON.parse(await readFile(join(output, `${stem}.size.json`), 'utf8'));
    assert.equal(report.source, sourceName);
    assert.equal(report.stem, stem);
    assert.equal(report.version, 6);
    assert.equal(report.selectedWasm.backend, 'wasm');
    assert.equal(report.selectedJs.precision, 'native');
    assert.equal(report.selectedF32, null);
    assert.equal(report.selectedWasm.archive, `${stem}.zip`);
    assert.equal(report.selectedJs.archive, `${stem}.js.zip`);
    assert.ok([`${stem}.zip`, `${stem}.js.zip`].includes(report.selectedOverall.archive));
    assert.deepEqual(Object.keys(report.artifacts).sort(), ['html', 'js', 'jsHtml', 'jsZip', 'wat', 'wasm', 'zip'].sort());
    assert.ok(report.candidates.some((candidate) => candidate.id === 'plain-embedded'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'plain-external'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'js-unminified'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'js-min'));
    assert.equal(report.candidates.some((candidate) => candidate.id.startsWith('f32-')), false);
    assert.ok(report.candidates.every((candidate) => candidate.zipBytes > 0));
    const selectedArchives = new Map([
      [report.selectedWasm.id, report.selectedWasm.archive],
      [report.selectedJs.id, report.selectedJs.archive],
    ]);
    for (const candidate of report.candidates) {
      assert.equal(candidate.archive, selectedArchives.get(candidate.id) ?? null, `${candidate.id} archive retention`);
    }

    const wasmZip = inspectZip(join(output, `${stem}.zip`));
    const expectedWasmNames = report.selectedWasm.layout === 'external' ? ['index.html', `${stem}.wasm`] : ['index.html'];
    assert.deepEqual(wasmZip.names, expectedWasmNames);
    assert.equal(wasmZip.index, await readFile(join(output, `${stem}.html`), 'utf8'));
    assert.equal(wasmZip.names.includes(`${stem}.wat`), false, 'WAT must stay outside the playable ZIP');

    const jsZip = inspectZip(join(output, `${stem}.js.zip`));
    assert.deepEqual(jsZip.names, ['index.html']);
    assert.equal(jsZip.index, await readFile(join(output, `${stem}.js.html`), 'utf8'));
    for (const [id, archiveName] of selectedArchives) {
      const candidate = report.candidates.find((item) => item.id === id);
      const archivePath = join(output, archiveName);
      assert.equal((await stat(archivePath)).size, candidate.zipBytes, `${id} size record must match selected archive`);
      const archive = inspectZip(archivePath);
      assert.equal(archive.names.includes(`${stem}.wat`), false);
    }

    const stableNames = expected;
    const before = new Map();
    for (const name of stableNames) before.set(name, digest(await readFile(join(output, name))));
    runBuild(source, output, ['--compare-f32']);
    assert.deepEqual((await readdir(output)).sort(), [...compareExpected, 'keep.txt', otherStem].sort());
    const compared = JSON.parse(await readFile(join(output, `${stem}.size.json`), 'utf8'));
    assert.equal(compared.selectedF32.precision, 'f32');
    assert.equal(compared.selectedF32.archive, `${stem}.f32.zip`);
    assert.equal(compared.artifacts.f32Js, `${stem}.f32.js`);
    assert.equal(compared.artifacts.f32Html, `${stem}.f32.html`);
    assert.equal(compared.artifacts.f32Zip, `${stem}.f32.zip`);
    assert.ok(compared.candidates.some((candidate) => candidate.id === 'f32-unminified'));
    assert.ok(compared.candidates.some((candidate) => candidate.id === 'f32-min'));
    const comparedF32 = compared.candidates.find((candidate) => candidate.id === compared.selectedF32.id);
    assert.equal((await stat(join(output, compared.selectedF32.archive))).size, comparedF32.zipBytes);
    const f32Zip = inspectZip(join(output, `${stem}.f32.zip`));
    assert.deepEqual(f32Zip.names, ['index.html']);
    assert.equal(f32Zip.index, await readFile(join(output, `${stem}.f32.html`), 'utf8'));

    runBuild(source, output);
    assert.deepEqual((await readdir(output)).sort(), [...expected, 'keep.txt', otherStem].sort());
    assert.equal((await readdir(output)).some((name) => name.startsWith(`${stem}.f32.`)), false);
    for (const [name, hash] of before) assert.equal(digest(await readFile(join(output, name))), hash, `${name} must be deterministic`);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('keyboard-only build flag configures every host and preserves candidate counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-keyboard-build-'));
  try {
    const source = join(directory, 'keyboard game.slim');
    const defaultOutput = join(directory, 'default');
    const keyboardOutput = join(directory, 'keyboard');
    await writeFile(source, `
fn init() {}
fn frame() { tri(input(0), 100, input(0) + 20, 100, input(0), 120, 0.2, 0.7, 1); }
`);
    runBuild(source, defaultOutput);
    runBuild(source, keyboardOutput, ['--keyboard-only']);

    const stem = 'keyboard-game';
    const defaultReport = JSON.parse(await readFile(join(defaultOutput, `${stem}.size.json`), 'utf8'));
    const keyboardReport = JSON.parse(await readFile(join(keyboardOutput, `${stem}.size.json`), 'utf8'));
    assert.equal(defaultReport.keyboardOnly, false);
    assert.equal(keyboardReport.keyboardOnly, true);
    assert.deepEqual(Object.keys(keyboardReport.artifacts).sort(), Object.keys(defaultReport.artifacts).sort());
    assert.deepEqual(keyboardReport.candidates.map((candidate) => candidate.id), defaultReport.candidates.map((candidate) => candidate.id));
    assert.deepEqual((await readdir(keyboardOutput)).sort(), (await readdir(defaultOutput)).sort());

    const defaultHtml = await readFile(join(defaultOutput, `${stem}.html`), 'utf8');
    const defaultJsHtml = await readFile(join(defaultOutput, `${stem}.js.html`), 'utf8');
    const keyboardHtml = await readFile(join(keyboardOutput, `${stem}.html`), 'utf8');
    const keyboardJsHtml = await readFile(join(keyboardOutput, `${stem}.js.html`), 'utf8');
    for (const page of [defaultHtml, defaultJsHtml]) {
      assert.match(page, /pointerdown/);
      assert.match(page, /Arrows\/WASD · Space · Mouse\/Touch · R restarts/);
    }
    for (const page of [keyboardHtml, keyboardJsHtml]) {
      assert.doesNotMatch(page, /pointerdown|pointermove|pointerup|pointercancel|setPointerCapture|getBoundingClientRect/);
      assert.match(page, /Arrows\/A-D: move · Space: jump · R: restart/);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
