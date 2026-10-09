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
const boxpushSource = fileURLToPath(new URL('../examples/boxpush.slim', import.meta.url));

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
    'import base64, json, sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    '  print(json.dumps({"names": z.namelist(), "index": z.read("index.html").decode("utf-8"), "payloads": {n: base64.b64encode(z.read(n)).decode("ascii") for n in z.namelist() if n != "index.html"}}))',
  ].join('\n');
  const result = runPython(['-c', script, path]);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function archivePayload(archive, name) {
  return Buffer.from(archive.payloads[name], 'base64');
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
    const values = Array.from({length: 1800}, (_, index) =>
      (((index * 1664525 + 1013904223) >>> 0) / 4294967296).toFixed(8)).join(',');
    const sourceText = `
const DATA = [${values}];
fn init() {}
fn frame() { return DATA[input(0)]; }
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
      `${stem}.f32.min.js`,
      `${stem}.js.zip`, `${stem}.f32.zip`,
    ];
    for (const name of obsolete) await writeFile(join(output, name), 'obsolete');
    const otherStem = 'other-game.plain.wasm';
    await writeFile(join(output, otherStem), 'preserve other source');
    runBuild(source, output);

    const expected = [
      `${stem}.wasm`, `${stem}.wat`, `${stem}.html`, `${stem}.size.json`,
      `${stem}.js`, `${stem}.min.js`, `${stem}.js.html`,
      `${stem}.zip`,
    ];
    const compareExpected = expected.concat([`${stem}.f32.js`, `${stem}.f32.min.js`, `${stem}.f32.html`]);
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
    assert.equal(report.version, 9);
    assert.deepEqual(report.wasmInterface.exports, {init: 'a', frame: 'b'});
    assert.deepEqual(report.wasmInterface.removedExports, ['memory']);
    assert.equal(report.selectedWasm.backend, 'wasm');
    assert.equal(report.selectedJs.precision, 'native');
    assert.equal(report.selectedF32, null);
    assert.equal(report.selectedOverall.backend, 'wasm', 'minimal fixture should exercise the WASM package winner');
    assert.ok(report.selectedWasm.archive === `${stem}.zip` || report.selectedWasm.archive === null);
    assert.ok(report.selectedJs.archive === `${stem}.zip` || report.selectedJs.archive === null);
    assert.equal(report.selectedOverall.archive, `${stem}.zip`);
    assert.deepEqual(Object.keys(report.artifacts).sort(), ['html', 'js', 'jsHtml', 'minJs', 'wat', 'wasm', 'zip'].sort());
    assert.equal(report.artifacts.minJs, `${stem}.min.js`);
    assert.ok(report.candidates.some((candidate) => candidate.backend === 'wasm'));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'plain-external'));
    assert.ok(report.candidates.filter((candidate) => candidate.backend === 'wasm')
      .every((candidate) => candidate.interfaceMinified === true && candidate.unminifiedWasmBytes > candidate.wasmBytes));
    assert.ok(report.candidates.some((candidate) => candidate.id === 'js-min'));
    assert.ok(report.candidates.filter((candidate) => candidate.backend === 'wasm').every((candidate) => candidate.layout === 'external'));
    assert.ok(report.candidates.filter((candidate) => candidate.backend === 'js').every((candidate) => candidate.minified && candidate.layout === 'external'));
    assert.equal(report.candidates.some((candidate) => candidate.id.startsWith('f32-')), false);
    assert.ok(report.candidates.every((candidate) => candidate.zipBytes > 0));
    for (const candidate of report.candidates) {
      assert.equal(candidate.archive, candidate.id === report.selectedOverall.id ? `${stem}.zip` : null, `${candidate.id} archive retention`);
    }

    const zip = inspectZip(join(output, `${stem}.zip`));
    assert.equal(zip.names.includes(`${stem}.wat`), false, 'WAT must stay outside the playable ZIP');
    if (report.selectedOverall.backend === 'wasm') {
      assert.deepEqual(zip.names, ['index.html', `${stem}.wasm`]);
      assert.equal(zip.index, await readFile(join(output, `${stem}.html`), 'utf8'));
      assert.deepEqual(archivePayload(zip, `${stem}.wasm`), wasm);
    } else {
      assert.deepEqual(zip.names, ['index.html', `${stem}.js`]);
      assert.match(zip.index, new RegExp(`<script src="${stem}\\.js"></script>`));
      assert.deepEqual(archivePayload(zip, `${stem}.js`), await readFile(join(output, `${stem}.min.js`)));
    }

    const readableFactory = await readFile(join(output, `${stem}.js`), 'utf8');
    const minifiedFactory = await readFile(join(output, `${stem}.min.js`), 'utf8');
    assert.ok(Buffer.byteLength(readableFactory) > 0);
    assert.ok(Buffer.byteLength(minifiedFactory) < report.selectedJs.unminifiedJsBytes, 'minified host script should be smaller than the unminified browser host');
    assert.equal(report.selectedJs.jsBytes, Buffer.byteLength(minifiedFactory));
    const jsHtml = await readFile(join(output, `${stem}.js.html`), 'utf8');
    assert.match(jsHtml, new RegExp(`<script src="${stem}\\.min\\.js"></script>`));
    const jsCandidate = report.candidates.find((item) => item.id === report.selectedJs.id);
    assert.ok(jsCandidate.zipBytes > 0);
    assert.equal((await stat(join(output, `${stem}.zip`))).size, report.selectedOverall.zipBytes);

    const stableNames = expected;
    const before = new Map();
    for (const name of stableNames) before.set(name, digest(await readFile(join(output, name))));
    runBuild(source, output, ['--compare-f32']);
    assert.deepEqual((await readdir(output)).sort(), [...compareExpected, 'keep.txt', otherStem].sort());
    const compared = JSON.parse(await readFile(join(output, `${stem}.size.json`), 'utf8'));
    assert.equal(compared.selectedF32.precision, 'f32');
    assert.equal(compared.selectedF32.archive, null);
    assert.equal(compared.artifacts.f32Js, `${stem}.f32.js`);
    assert.equal(compared.artifacts.f32MinJs, `${stem}.f32.min.js`);
    assert.equal(compared.artifacts.f32Html, `${stem}.f32.html`);
    assert.ok(compared.candidates.some((candidate) => candidate.id === 'f32-min'));
    const comparedF32 = compared.candidates.find((candidate) => candidate.id === compared.selectedF32.id);
    assert.ok(comparedF32.zipBytes > 0, 'f32 comparison candidate must still have an exact trial ZIP size');
    const f32ReadableFactory = await readFile(join(output, `${stem}.f32.js`), 'utf8');
    const f32MinifiedFactory = await readFile(join(output, `${stem}.f32.min.js`), 'utf8');
    assert.ok(Buffer.byteLength(f32MinifiedFactory) > 0);
    assert.match(await readFile(join(output, `${stem}.f32.html`), 'utf8'), new RegExp(`<script src="${stem}\\.f32\\.min\\.js"></script>`));

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
    const defaultJs = await readFile(join(defaultOutput, `${stem}.min.js`), 'utf8');
    const keyboardJs = await readFile(join(keyboardOutput, `${stem}.min.js`), 'utf8');
    for (const page of [defaultHtml, defaultJsHtml]) {
      assert.match(page, /Arrows\/WASD · Space · Mouse\/Touch · R restarts/);
    }
    for (const page of [keyboardHtml, keyboardJsHtml]) {
      assert.match(page, /Arrows\/A-D: move · Space: jump · R: restart/);
    }
    assert.match(defaultJs, /pointerdown/);
    assert.doesNotMatch(keyboardJs, /pointerdown|pointermove|pointerup|pointercancel|setPointerCapture|getBoundingClientRect/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('a smaller JavaScript candidate wins and its ZIP aliases the external minified script', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'slim-js-package-winner-'));
  try {
    const output = join(directory, 'dist');
    runBuild(boxpushSource, output, ['--release', '--keyboard-only']);

    const report = JSON.parse(await readFile(join(output, 'boxpush.size.json'), 'utf8'));
    assert.equal(report.selectedOverall.backend, 'js', 'Boxpush should exercise the smaller JavaScript package winner');
    assert.equal(report.selectedOverall.id, report.selectedJs.id);
    assert.ok(report.selectedJs.zipBytes < report.selectedWasm.zipBytes);
    assert.equal(report.selectedJs.archive, 'boxpush.zip');
    assert.equal(report.selectedWasm.archive, null);

    const minifiedScript = await readFile(join(output, 'boxpush.min.js'));
    const page = await readFile(join(output, 'boxpush.js.html'), 'utf8');
    assert.match(page, /<script src="boxpush\.min\.js"><\/script>/);
    const archive = inspectZip(join(output, 'boxpush.zip'));
    assert.deepEqual(archive.names.slice().sort(), ['boxpush.js', 'index.html']);
    assert.match(archive.index, /<script src="boxpush\.js"><\/script>/);
    assert.deepEqual(archivePayload(archive, 'boxpush.js'), minifiedScript);
    assert.equal((await stat(join(output, 'boxpush.zip'))).size, report.selectedOverall.zipBytes);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
