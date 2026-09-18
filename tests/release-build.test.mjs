import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve, sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const buildTool = join(root, 'tools', 'build.mjs');
const sourceName = 'release-fixture.slim';
const stem = 'release-fixture';
const sourceText = `
const ATLAS = [-10, 0, 10, 0, 0, -10, .25, .5, .75];
fn init() {}
fn frame() { sound(1, 1.125, .5); return ATLAS[input(0)]; }
`;
const fractionSourceText = `
const ATLAS = [-10.5, 0, 10, 0, 0, -10, .25, .5, .75];
fn init() {}
fn frame() { sound(1, 1.125, .5); return ATLAS[input(0)]; }
`;
const integerI8Values = [-128, -1, 0, 127, -64, 64, 10, -10, 5];
const integerU8Values = [0, 1, 255, 2, 3, 4, 5, 6, 7];
const integerI16Values = [-32768, -1, 0, 32767, -123, 123, 100, -100, 5];
const integerU16Values = [0, 1, 65535, 2, 3, 4, 5, 6, 7];
function repeatedIntegerValues(values, length = 64) {
  return Array.from({length}, (_, index) => values[index % values.length]).join(', ');
}
const integerI8StorageValues = Array.from({length: 64}, (_, index) => integerI8Values[index % integerI8Values.length]);
const integerU8StorageValues = Array.from({length: 64}, (_, index) => integerU8Values[index % integerU8Values.length]);
const integerI16StorageValues = Array.from({length: 64}, (_, index) => integerI16Values[index % integerI16Values.length]);
const integerU16StorageValues = Array.from({length: 64}, (_, index) => integerU16Values[index % integerU16Values.length]);
const integerSourceText = `
const ATLAS = [-10, 0, 10, 0, 0, -10, .25, .5, .75];
const I8 = [${repeatedIntegerValues(integerI8Values)}];
const U8 = [${repeatedIntegerValues(integerU8Values)}];
const I16 = [${repeatedIntegerValues(integerI16Values)}];
const U16 = [${repeatedIntegerValues(integerU16Values)}];
fn init() {}
fn frame() { sound(1, 1.125, .5); return ATLAS[input(0)] + I8[input(0)] + U8[input(0)] + I16[input(0)] + U16[input(0)]; }
`;
const soundPackings = ['none', 'numbers', 'bytes'];
const triangleModes = [[], ['ATLAS']];
const integerStorageModes = ['f32', 'compact'];
const normalNames = [
  `${stem}.wasm`,
  `${stem}.wat`,
  `${stem}.html`,
  `${stem}.size.json`,
  `${stem}.js`,
  `${stem}.js.html`,
  `${stem}.js.zip`,
  `${stem}.zip`,
];

function runTool(command, args, env = process.env) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: {...env},
    windowsHide: true,
  });
}

function runBuild(source, output, flags = []) {
  return runTool(process.execPath, [buildTool, source, '--out-dir', output, ...flags]);
}

function failureText(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`;
}

function commandWorks(command) {
  if (!command) return false;
  const result = runTool(command, ['--version']);
  return !result.error && result.status === 0;
}

function pathExecutable(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function toolFor(name, configured, siblingOf) {
  if (configured) return configured;
  if (siblingOf && (siblingOf.includes('\\') || siblingOf.includes('/'))) {
    const sibling = join(dirname(siblingOf), `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(sibling)) return sibling;
  }
  return pathExecutable(name) || (process.platform === 'win32' ? pathExecutable(`${name}.exe`) : undefined);
}

const configuredPython = process.env.SLIM_PYTHON;
const configuredWasmDis = process.env.SLIM_WASM_DIS;
const configuredWasmOpt = process.env.SLIM_WASM_OPT;
const pythonCommand = configuredPython || 'python';
const wasmOptCommand = toolFor('wasm-opt', configuredWasmOpt);
const wasmDisCommand = toolFor('wasm-dis', configuredWasmDis, wasmOptCommand);
const explicitInvalidTool = (configuredPython && !commandWorks(configuredPython)) ||
  (configuredWasmDis && !commandWorks(configuredWasmDis)) ||
  (configuredWasmOpt && !commandWorks(configuredWasmOpt));
const releaseToolsMissing = !explicitInvalidTool &&
  ((!commandWorks(pythonCommand) && !configuredPython) ||
   (!commandWorks(wasmDisCommand) && !configuredWasmDis));
const releaseSkipReason = releaseToolsMissing
  ? 'release integration requires working Python and wasm-dis (set SLIM_PYTHON/SLIM_WASM_DIS or install the devtools)'
  : undefined;
const optimizerAvailable = Boolean(wasmOptCommand) && commandWorks(wasmOptCommand);

async function removeTemporaryDirectory(directory) {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(directory);
  assert.ok(
    target !== temporaryRoot && target.startsWith(`${temporaryRoot}${sep}`),
    `refusing to remove temporary path outside ${temporaryRoot}: ${target}`,
  );
  await rm(target, {recursive: true, force: true});
}

async function withTemporaryDirectory(prefix, callback) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await removeTemporaryDirectory(directory);
  }
}

async function writeFixture(directory, text = sourceText) {
  const source = join(directory, sourceName);
  await writeFile(source, text);
  return source;
}

async function readReport(output) {
  return JSON.parse(await readFile(join(output, `${stem}.size.json`), 'utf8'));
}

function assertBuildSucceeded(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${failureText(result)}`);
}

async function assertSentinelsUnchanged(directory, sentinels) {
  assert.equal(existsSync(directory), true, `output directory ${directory} was removed`);
  assert.deepEqual((await readdir(directory)).sort(), [...sentinels.keys()].sort(), 'failed build changed output entries');
  for (const [name, expected] of sentinels) {
    assert.equal(await readFile(join(directory, name), 'utf8'), expected, `${name} was changed`);
  }
}

function f32Bytes(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return [...bytes];
}

function integerPhysicalBytes(values, elementBytes) {
  if (elementBytes === 4) return values.flatMap(f32Bytes);
  return values.flatMap((value) => [value & 0xff, ...(elementBytes === 2 ? [(value >> 8) & 0xff] : [])]);
}

function fixtureValues() {
  return [-10, 0, 10, 0, 0, -10, .25, .5, .75].map((value) => Math.fround(value));
}

function integerFixtureValues() {
  const atlasValues = [-10, 0, 10, 0, 0, -10, .25, .5, .75];
  return atlasValues.map((value, index) => Math.fround(
    value + integerI8Values[index] + integerU8Values[index] + integerI16Values[index] + integerU16Values[index],
  ));
}

function layoutShape(layout) {
  const {values, ...shape} = layout;
  return shape;
}

function candidateMatching(candidates, fields) {
  return candidates.filter((candidate) => Object.entries(fields).every(([key, value]) => {
    if (Array.isArray(value)) return JSON.stringify(candidate[key]) === JSON.stringify(value);
    return candidate[key] === value;
  }));
}

function assertSoundTiePreference(selected, candidates, label) {
  const minimum = Math.min(...candidates.map((candidate) => candidate.zipBytes));
  const ties = candidates.filter((candidate) => candidate.zipBytes === minimum);
  if (ties.some((candidate) => candidate.soundPacking === 'none')) {
    assert.equal(selected.soundPacking, 'none', `${label} ZIP ties must prefer soundPacking none`);
  }
}

function expectedCandidate(candidates) {
  return candidates.slice().sort((left, right) => {
    return left.zipBytes - right.zipBytes ||
      soundPackings.indexOf(left.soundPacking) - soundPackings.indexOf(right.soundPacking) ||
      left.packedTriangleArrays.length - right.packedTriangleArrays.length ||
      integerStorageModes.indexOf(left.integerArrayStorage ?? 'f32') - integerStorageModes.indexOf(right.integerArrayStorage ?? 'f32') ||
      left.id.localeCompare(right.id);
  })[0];
}

function instantiateWasm(bytes, input, sounds) {
  const module = new WebAssembly.Module(bytes);
  const instance = new WebAssembly.Instance(module, {
    e: {
      input: (index) => input(index),
      sound: (...args) => {
        sounds.push(args);
        return 0;
      },
    },
  });
  assert.equal(typeof instance.exports.init, 'function');
  assert.equal(typeof instance.exports.frame, 'function');
  assert.ok(instance.exports.memory instanceof WebAssembly.Memory, 'selected WASM must export memory');
  return instance;
}

function runJavaScriptFactory(code, input, sounds) {
  const factory = Function(`return (${code});`)();
  assert.equal(typeof factory, 'function', 'readable JS artifact must be a factory');
  const runtime = factory({
    input: (index) => input(index),
    sound: (...args) => {
      sounds.push(args);
      return 0;
    },
  });
  assert.equal(typeof runtime.init, 'function');
  assert.equal(typeof runtime.frame, 'function');
  return runtime;
}

test('release build measures codec candidates and preserves selected backend behavior', {skip: releaseSkipReason}, async () => {
  await withTemporaryDirectory('slim-release-build-', async (directory) => {
    const source = await writeFixture(directory);
    const releaseOutput = join(directory, 'release');
    const releaseResult = runBuild(source, releaseOutput, [
      '--release',
      '--search', 'exhaustive',
      '--pack-triangles', 'ATLAS',
      '--sound-packing', 'auto',
      '--keyboard-only',
    ]);
    assertBuildSucceeded(releaseResult, 'release build');

    const report = await readReport(releaseOutput);
    assert.equal(report.version, 6);
    assert.equal(report.search, 'exhaustive');
    assert.equal(report.release, true);
    assert.equal(report.soundPacking, 'auto');
    assert.equal(report.integerArrayStorage, 'auto');
    assert.deepEqual(report.requestedPackedTriangleArrays, ['ATLAS']);
    assert.deepEqual(report.packedTriangleArrays, report.selectedWasm.packedTriangleArrays);
    assert.deepEqual(report.compiler.packedTriangleArrays, report.selectedWasm.packedTriangleArrays);
    assert.equal(report.skippedCandidates.length, triangleModes.length, 'auto must report redundant compact variants');
    assert.ok(report.skippedCandidates.every((candidate) => candidate.integerArrayStorage === 'compact'));
    assert.deepEqual((await readdir(releaseOutput)).sort(), [...normalNames].sort());

    const wasmCandidates = report.candidates.filter((candidate) => candidate.backend === 'wasm');
    const jsCandidates = report.candidates.filter((candidate) => candidate.backend === 'js');
    assert.ok(wasmCandidates.length > 0, 'release report must contain WASM candidates');
    assert.ok(jsCandidates.length > 0, 'release report must contain JavaScript candidates');
    assert.deepEqual(
      new Set(wasmCandidates.map((candidate) => JSON.stringify(candidate.packedTriangleArrays))),
      new Set(triangleModes.map((mode) => JSON.stringify(mode))),
      'release must measure unpacked and requested packed WASM variants',
    );
    assert.deepEqual(new Set(wasmCandidates.map((candidate) => candidate.integerArrayStorage)), new Set(['f32']),
      'redundant compact variants must not be emitted');
    assert.deepEqual(new Set(wasmCandidates.map((candidate) => candidate.soundPacking)), new Set(soundPackings));
    assert.deepEqual(new Set(jsCandidates.map((candidate) => JSON.stringify(candidate.packedTriangleArrays))), new Set(['[]']));
    assert.deepEqual(new Set(jsCandidates.map((candidate) => candidate.soundPacking)), new Set(soundPackings));
    assert.ok(jsCandidates.every((candidate) => candidate.integerArrayStorage === null));
    assert.ok(wasmCandidates.every((candidate) => ['embedded', 'external'].includes(candidate.layout)));
    assert.ok(wasmCandidates.every((candidate) => [false, true].includes(candidate.minified)));
    assert.ok(jsCandidates.every((candidate) => candidate.layout === 'inline'));
    assert.ok(jsCandidates.every((candidate) => [false, true].includes(candidate.minified)));
    assert.ok(wasmCandidates.every((candidate) => candidate.zipBytes > 0));
    assert.ok(jsCandidates.every((candidate) => candidate.zipBytes > 0));

    const optimizerNames = new Set(wasmCandidates.map((candidate) => candidate.optimization));
    assert.ok(optimizerNames.has('plain'));
    if (optimizerAvailable) {
      assert.ok(optimizerNames.size > 1, 'available wasm-opt should contribute optimizer candidates');
    }
    for (const triangleMode of triangleModes) {
      for (const optimization of optimizerNames) {
        for (const layout of ['embedded', 'external']) {
          for (const soundPacking of soundPackings) {
            for (const minified of [false, true]) {
              assert.equal(
                candidateMatching(wasmCandidates, {
                  packedTriangleArrays: triangleMode,
                  optimization,
                  layout,
                  soundPacking,
                  minified,
                }).length,
                1,
                `missing WASM candidate ${JSON.stringify({triangleMode, optimization, layout, soundPacking, minified})}`,
              );
            }
          }
        }
      }
    }
    for (const soundPacking of soundPackings) {
      for (const minified of [false, true]) {
        assert.equal(
          candidateMatching(jsCandidates, {soundPacking, minified}).length,
          1,
          `missing native JS candidate ${JSON.stringify({soundPacking, minified})}`,
        );
      }
    }

    const selectedWasmCandidate = report.candidates.find((candidate) => candidate.id === report.selectedWasm.id);
    const selectedJsCandidate = report.candidates.find((candidate) => candidate.id === report.selectedJs.id);
    assert.ok(selectedWasmCandidate, 'selectedWasm must identify a reported candidate');
    assert.ok(selectedJsCandidate, 'selectedJs must identify a reported candidate');
    assert.equal(selectedWasmCandidate.backend, 'wasm');
    assert.equal(selectedJsCandidate.backend, 'js');
    assert.equal(selectedWasmCandidate.integerArrayStorage, report.compiler.integerArrayStorage);
    assert.deepEqual(selectedWasmCandidate.packedTriangleArrays, report.selectedWasm.packedTriangleArrays);
    assert.equal(selectedWasmCandidate.soundPacking, report.selectedWasm.soundPacking);
    assert.deepEqual(selectedJsCandidate.packedTriangleArrays, report.selectedJs.packedTriangleArrays);
    assert.equal(selectedJsCandidate.soundPacking, report.selectedJs.soundPacking);
    assert.equal(report.selectedWasm.archive, `${stem}.zip`);
    assert.equal(report.selectedJs.archive, `${stem}.js.zip`);
    assert.equal(report.selectedWasm.zipBytes, Math.min(...wasmCandidates.map((candidate) => candidate.zipBytes)));
    assert.equal(report.selectedJs.zipBytes, Math.min(...jsCandidates.map((candidate) => candidate.zipBytes)));
    assert.equal(report.selectedWasm.id, expectedCandidate(wasmCandidates).id, 'WASM winner must use deterministic sound tie ordering');
    assert.equal(report.selectedJs.id, expectedCandidate(jsCandidates).id, 'JavaScript winner must use deterministic sound tie ordering');
    assertSoundTiePreference(report.selectedWasm, wasmCandidates, 'WASM');
    assertSoundTiePreference(report.selectedJs, jsCandidates, 'JavaScript');
    assert.equal((await stat(join(releaseOutput, `${stem}.zip`))).size, report.selectedWasm.zipBytes);
    assert.equal((await stat(join(releaseOutput, `${stem}.js.zip`))).size, report.selectedJs.zipBytes);

    const plain = compileDetailed(sourceText, {integerArrayStorage: 'f32', packedTriangleArrays: []});
    const packed = compileDetailed(sourceText, {integerArrayStorage: 'f32', packedTriangleArrays: ['ATLAS']});
    const plainLayout = plain.arrayLayout.find((layout) => layout.name === 'ATLAS');
    const packedLayout = packed.arrayLayout.find((layout) => layout.name === 'ATLAS');
    assert.equal(plainLayout.offset, 0);
    assert.equal(plainLayout.byteOffset, 0);
    assert.equal(plainLayout.byteLength, 36);
    assert.equal(packedLayout.offset, 0);
    assert.equal(packedLayout.byteOffset, 0);
    assert.equal(packedLayout.byteLength, 19);
    assert.equal(packedLayout.encoding, 'triangles-i8-palette-f32');
    assert.equal(packedLayout.paletteOffset, 7);

    const selectedPacked = report.selectedWasm.packedTriangleArrays.includes('ATLAS');
    const expectedDetails = selectedPacked ? packed : plain;
    const selectedLayout = report.compiler.arrayLayout.find((layout) => layout.name === 'ATLAS');
    assert.ok(selectedLayout, 'selected compiler metadata must describe ATLAS');
    assert.deepEqual(selectedLayout, layoutShape(expectedDetails.arrayLayout.find((layout) => layout.name === 'ATLAS')));
    assert.equal(report.compiler.allocatedBytes, expectedDetails.allocatedBytes);
    assert.equal(report.compiler.memoryPages, expectedDetails.memoryPages);
    assert.equal(selectedLayout.byteLength, selectedPacked ? 19 : 36);
    assert.equal(selectedLayout.encoding, selectedPacked ? 'triangles-i8-palette-f32' : undefined);

    const selectedWasmBytes = await readFile(join(releaseOutput, `${stem}.wasm`));
    assert.ok(WebAssembly.validate(selectedWasmBytes), 'selected WASM must validate');
    const soundsFromWasm = [];
    let wasmIndex = 0;
    const wasm = instantiateWasm(selectedWasmBytes, () => wasmIndex, soundsFromWasm);
    wasm.exports.init();
    const expected = fixtureValues();
    const wasmValues = [];
    for (wasmIndex = 0; wasmIndex < expected.length; wasmIndex += 1) {
      wasmValues.push(wasm.exports.frame());
    }
    assert.deepEqual(wasmValues, expected, 'selected WASM must read every atlas lane');
    assert.deepEqual(soundsFromWasm, expected.map(() => [1, Math.fround(1.125), Math.fround(.5)]));

    const memory = new Uint8Array(wasm.exports.memory.buffer);
    const physicalBytes = [...memory.slice(selectedLayout.byteOffset, selectedLayout.byteOffset + selectedLayout.byteLength)];
    const expectedPlainBytes = expected.flatMap(f32Bytes);
    const expectedPackedBytes = [246, 0, 10, 0, 0, 246, 0, ...f32Bytes(.25), ...f32Bytes(.5), ...f32Bytes(.75)];
    assert.deepEqual(physicalBytes, selectedPacked ? expectedPackedBytes : expectedPlainBytes);

    const readableJs = await readFile(join(releaseOutput, `${stem}.js`), 'utf8');
    const originalJs = compileJavaScript(sourceText, {precision: 'native'});
    assert.equal(readableJs, originalJs.code, 'readable native JS must remain the ordinary numeric factory');
    const soundsFromJs = [];
    let jsIndex = 0;
    const javascript = runJavaScriptFactory(readableJs, () => jsIndex, soundsFromJs);
    javascript.init();
    const jsValues = [];
    for (jsIndex = 0; jsIndex < expected.length; jsIndex += 1) jsValues.push(javascript.frame());
    assert.deepEqual(jsValues, expected, 'selected native JS must read every atlas lane');
    assert.deepEqual(jsValues, wasmValues, 'selected native JS and WASM frame values must match');
    assert.deepEqual(soundsFromJs, soundsFromWasm, 'selected native JS and WASM sound import arguments must match');

    const wat = await readFile(join(releaseOutput, `${stem}.wat`), 'utf8');
    assert.match(wat, /^\(module\b/);
    for (const page of [
      await readFile(join(releaseOutput, `${stem}.html`), 'utf8'),
      await readFile(join(releaseOutput, `${stem}.js.html`), 'utf8'),
    ]) {
      assert.match(page, /Arrows\/A-D: move · Space: jump · R: restart/);
      assert.doesNotMatch(page, /pointerdown|pointermove|pointerup|pointercancel|setPointerCapture|getBoundingClientRect/);
    }

    const ordinaryOutput = join(directory, 'ordinary');
    const ordinaryResult = runBuild(source, ordinaryOutput, ['--search', 'exhaustive', '--keyboard-only']);
    assertBuildSucceeded(ordinaryResult, 'ordinary build');
    const ordinaryReport = await readReport(ordinaryOutput);
    assert.equal(ordinaryReport.version, 6);
    assert.equal(ordinaryReport.search, 'exhaustive');
    assert.equal(ordinaryReport.release, false);
    assert.equal(ordinaryReport.soundPacking, 'none');
    assert.equal(ordinaryReport.integerArrayStorage, 'f32');
    assert.deepEqual(ordinaryReport.requestedPackedTriangleArrays, []);
    assert.deepEqual(ordinaryReport.packedTriangleArrays, []);
    assert.equal(ordinaryReport.selectedWasm.packedTriangleArrays.length, 0);
    assert.equal(ordinaryReport.selectedWasm.soundPacking, 'none');
    assert.equal(ordinaryReport.selectedJs.soundPacking, 'none');
    assert.ok(ordinaryReport.candidates.every((candidate) => candidate.soundPacking === 'none'));
    assert.equal(ordinaryReport.selectedWasm.integerArrayStorage, 'f32');
    assert.ok(ordinaryReport.candidates.filter((candidate) => candidate.backend === 'wasm').every((candidate) => candidate.integerArrayStorage === 'f32'));
    assert.ok(ordinaryReport.candidates.filter((candidate) => candidate.backend === 'js').every((candidate) => candidate.integerArrayStorage === null));
    assert.deepEqual((await readdir(ordinaryOutput)).sort(), [...normalNames].sort());

    const stagedOutput = join(directory, 'staged');
    const stagedResult = runBuild(source, stagedOutput, [
      '--release',
      '--pack-triangles', 'ATLAS',
      '--sound-packing', 'auto',
      '--keyboard-only',
    ]);
    assertBuildSucceeded(stagedResult, 'default staged release build');
    const stagedReport = await readReport(stagedOutput);
    assert.equal(stagedReport.version, 6);
    assert.equal(stagedReport.release, true);
    assert.equal(stagedReport.search, 'staged');
    assert.deepEqual((await readdir(stagedOutput)).sort(), [...normalNames].sort());

    const stagedCandidates = stagedReport.candidates;
    const stagedCandidateIds = stagedCandidates.map((candidate) => candidate.id);
    assert.equal(new Set(stagedCandidateIds).size, stagedCandidateIds.length, 'staged report must deduplicate visited candidate IDs');
    assert.ok(stagedCandidates.length * 3 < report.candidates.length * 2,
      `staged search should visit substantially fewer candidates (${stagedCandidates.length} vs ${report.candidates.length})`);
    for (const backend of ['wasm', 'js']) {
      const candidates = stagedCandidates.filter((candidate) => candidate.backend === backend);
      const selected = stagedReport[`selected${backend === 'wasm' ? 'Wasm' : 'Js'}`];
      assert.ok(candidates.length > 0, `staged report must contain ${backend} candidates`);
      assert.equal(selected.zipBytes, Math.min(...candidates.map((candidate) => candidate.zipBytes)),
        `${backend} winner must be the smallest visited ZIP`);
      assert.ok(candidates.some((candidate) => candidate.id === selected.id), `${backend} winner must be visited`);
    }

    const expectedAxes = ['optimization', 'layout', 'triangles', 'integer-arrays', 'sound'];
    assert.ok(Array.isArray(stagedReport.searchStages));
    assert.ok(stagedReport.searchStages.length >= expectedAxes.length + 1,
      'staged report must include the baseline and every configured axis');
    assert.equal(stagedReport.searchStages[0].pass, 0);
    assert.equal(stagedReport.searchStages[0].axis, 'baseline');
    assert.equal(stagedReport.searchStages[0].before, null);
    assert.equal(stagedReport.searchStages[0].selected, stagedReport.searchStages[0].tried[0]);
    assert.equal(stagedReport.searchStages[0].savedBytes, 0);
    const axisOrder = stagedReport.searchStages
      .filter((stage) => stage.axis !== 'baseline')
      .map((stage) => stage.axis);
    for (let index = 0; index < axisOrder.length; index += 1) {
      assert.equal(axisOrder[index], expectedAxes[index % expectedAxes.length],
        'staged axes must run in the documented order');
    }
    for (const stage of stagedReport.searchStages) {
      assert.ok(Number.isInteger(stage.pass) && stage.pass >= 0);
      assert.equal(typeof stage.axis, 'string');
      assert.equal(typeof stage.selected, 'string');
      assert.ok(Number.isInteger(stage.zipBytes) && stage.zipBytes > 0);
      assert.ok(Number.isInteger(stage.savedBytes) && stage.savedBytes >= 0);
      assert.ok(Array.isArray(stage.tried));
      assert.ok(stage.tried.every((id) => stagedCandidateIds.includes(id)),
        `${stage.axis} stage must report actual visited candidate IDs`);
      const selected = stagedCandidates.find((candidate) => candidate.id === stage.selected);
      assert.ok(selected, `${stage.axis} stage selected ID must identify a candidate`);
      assert.equal(stage.zipBytes, selected.zipBytes);
      if (stage.before === null) {
        assert.equal(stage.pass, 0);
      } else {
        const before = stagedCandidates.find((candidate) => candidate.id === stage.before);
        assert.ok(before, `${stage.axis} stage before ID must identify a candidate`);
        assert.equal(stage.savedBytes, before.zipBytes - stage.zipBytes);
      }
    }

    const stagedWasmBytes = await readFile(join(stagedOutput, `${stem}.wasm`));
    assert.ok(WebAssembly.validate(stagedWasmBytes), 'staged selected WASM must validate');
    const stagedSounds = [];
    let stagedIndex = 0;
    const stagedWasm = instantiateWasm(stagedWasmBytes, () => stagedIndex, stagedSounds);
    stagedWasm.exports.init();
    const stagedValues = [];
    const stagedExpected = fixtureValues();
    for (stagedIndex = 0; stagedIndex < stagedExpected.length; stagedIndex += 1) stagedValues.push(stagedWasm.exports.frame());
    assert.deepEqual(stagedValues, stagedExpected, 'staged selected WASM must preserve fixture behavior');
    assert.deepEqual(stagedSounds, stagedExpected.map(() => [1, Math.fround(1.125), Math.fround(.5)]));
    assert.equal((await stat(join(stagedOutput, `${stem}.zip`))).size, stagedReport.selectedWasm.zipBytes);
    assert.equal((await stat(join(stagedOutput, `${stem}.js.zip`))).size, stagedReport.selectedJs.zipBytes);

    const stagedJs = await readFile(join(stagedOutput, `${stem}.js`), 'utf8');
    const stagedJsSounds = [];
    let stagedJsIndex = 0;
    const stagedRuntime = runJavaScriptFactory(stagedJs, () => stagedJsIndex, stagedJsSounds);
    stagedRuntime.init();
    const stagedJsValues = [];
    for (stagedJsIndex = 0; stagedJsIndex < stagedExpected.length; stagedJsIndex += 1) stagedJsValues.push(stagedRuntime.frame());
    assert.deepEqual(stagedJsValues, stagedExpected, 'staged selected native JS must preserve fixture behavior');
    assert.deepEqual(stagedJsSounds, stagedSounds);
    for (const page of [
      await readFile(join(stagedOutput, `${stem}.html`), 'utf8'),
      await readFile(join(stagedOutput, `${stem}.js.html`), 'utf8'),
    ]) {
      assert.match(page, /Arrows\/A-D: move · Space: jump · R: restart/);
      assert.doesNotMatch(page, /pointerdown|pointermove|pointerup|pointercancel|setPointerCapture|getBoundingClientRect/);
    }
  });
});

test('release auto searches integer storage and preserves compact physical layout and source numerics', {skip: releaseSkipReason}, async () => {
  await withTemporaryDirectory('slim-release-integer-arrays-', async (directory) => {
    const source = await writeFixture(directory, integerSourceText);
    const output = join(directory, 'release');
    const result = runBuild(source, output, [
      '--release',
      '--search', 'exhaustive',
      '--pack-triangles', 'ATLAS',
      '--sound-packing', 'auto',
      '--integer-arrays', 'auto',
      '--keyboard-only',
    ]);
    assertBuildSucceeded(result, 'integer array release build');

    const report = await readReport(output);
    assert.equal(report.version, 6);
    assert.equal(report.search, 'exhaustive');
    assert.equal(report.integerArrayStorage, 'auto');
    assert.deepEqual(report.skippedCandidates, []);
    const wasmCandidates = report.candidates.filter((candidate) => candidate.backend === 'wasm');
    const jsCandidates = report.candidates.filter((candidate) => candidate.backend === 'js');
    assert.deepEqual(new Set(wasmCandidates.map((candidate) => JSON.stringify(candidate.packedTriangleArrays))), new Set(['[]', '["ATLAS"]']));
    assert.deepEqual(new Set(wasmCandidates.map((candidate) => candidate.integerArrayStorage)), new Set(integerStorageModes));
    assert.ok(jsCandidates.every((candidate) => candidate.integerArrayStorage === null));

    const optimizerNames = new Set(wasmCandidates.map((candidate) => candidate.optimization));
    assert.ok(optimizerNames.has('plain'));
    if (optimizerAvailable) assert.ok(optimizerNames.size > 1);
    for (const triangleMode of triangleModes) {
      for (const integerArrayStorage of integerStorageModes) {
        for (const optimization of optimizerNames) {
          for (const layout of ['embedded', 'external']) {
            for (const soundPacking of soundPackings) {
              for (const minified of [false, true]) {
                assert.equal(
                  candidateMatching(wasmCandidates, {
                    packedTriangleArrays: triangleMode,
                    integerArrayStorage,
                    optimization,
                    layout,
                    soundPacking,
                    minified,
                  }).length,
                  1,
                  `missing integer WASM candidate ${JSON.stringify({triangleMode, integerArrayStorage, optimization, layout, soundPacking, minified})}`,
                );
              }
            }
          }
        }
      }
    }

    assert.equal(report.selectedWasm.id, expectedCandidate(wasmCandidates).id, 'WASM winner must use deterministic storage tie ordering');
    assert.equal(report.selectedWasm.integerArrayStorage, report.compiler.integerArrayStorage);
    assert.equal(report.selectedWasm.zipBytes, Math.min(...wasmCandidates.map((candidate) => candidate.zipBytes)));
    const selectedPacked = report.selectedWasm.packedTriangleArrays.includes('ATLAS');
    const selectedDetails = compileDetailed(integerSourceText, {
      integerArrayStorage: report.selectedWasm.integerArrayStorage,
      packedTriangleArrays: selectedPacked ? ['ATLAS'] : [],
    });
    const layouts = new Map(report.compiler.arrayLayout.map((layout) => [layout.name, layout]));
    for (const expectedLayout of selectedDetails.arrayLayout) {
      assert.deepEqual(layouts.get(expectedLayout.name), layoutShape(expectedLayout), `${expectedLayout.name} metadata must describe the selected storage`);
    }
    const integerStorageWidths = report.selectedWasm.integerArrayStorage === 'compact'
      ? new Map([['I8', ['i8', 1, 64]], ['U8', ['u8', 1, 64]], ['I16', ['i16', 2, 128]], ['U16', ['u16', 2, 128]]])
      : new Map([['I8', [undefined, 4, 256]], ['U8', [undefined, 4, 256]], ['I16', [undefined, 4, 256]], ['U16', [undefined, 4, 256]]]);
    for (const [name, [encoding, elementBytes, byteLength]] of integerStorageWidths) {
      assert.equal(layouts.get(name).encoding, encoding);
      assert.equal(layouts.get(name).byteLength, byteLength);
      assert.equal(layouts.get(name).elementBytes ?? 4, elementBytes);
    }

    const selectedWasmBytes = await readFile(join(output, `${stem}.wasm`));
    const soundsFromWasm = [];
    let inputIndex = 0;
    const wasm = instantiateWasm(selectedWasmBytes, () => inputIndex, soundsFromWasm);
    wasm.exports.init();
    const expected = integerFixtureValues();
    const wasmValues = [];
    for (inputIndex = 0; inputIndex < expected.length; inputIndex += 1) wasmValues.push(wasm.exports.frame());
    assert.deepEqual(wasmValues, expected, 'selected WASM must preserve every source value');
    assert.deepEqual(soundsFromWasm, expected.map(() => [1, Math.fround(1.125), Math.fround(.5)]));

    const memory = new Uint8Array(wasm.exports.memory.buffer);
    const elementBytes = report.selectedWasm.integerArrayStorage === 'compact' ? 1 : 4;
    const wideElementBytes = report.selectedWasm.integerArrayStorage === 'compact' ? 2 : 4;
    const expectedPhysicalBytes = new Map([
      ['I8', integerPhysicalBytes(integerI8StorageValues, elementBytes)],
      ['U8', integerPhysicalBytes(integerU8StorageValues, elementBytes)],
      ['I16', integerPhysicalBytes(integerI16StorageValues, wideElementBytes)],
      ['U16', integerPhysicalBytes(integerU16StorageValues, wideElementBytes)],
    ]);
    for (const [name, expectedBytes] of expectedPhysicalBytes) {
      const layout = layouts.get(name);
      assert.deepEqual(
        [...memory.slice(layout.byteOffset, layout.byteOffset + layout.byteLength)],
        expectedBytes,
        `${name} physical bytes must use its reported storage width`,
      );
    }

    const readableJs = await readFile(join(output, `${stem}.js`), 'utf8');
    const originalJs = compileJavaScript(integerSourceText, {precision: 'native'});
    assert.equal(readableJs, originalJs.code, 'integer storage must not change the JS source numerics');
    const soundsFromJs = [];
    let jsIndex = 0;
    const javascript = runJavaScriptFactory(readableJs, () => jsIndex, soundsFromJs);
    javascript.init();
    const jsValues = [];
    for (jsIndex = 0; jsIndex < expected.length; jsIndex += 1) jsValues.push(javascript.frame());
    assert.deepEqual(jsValues, expected, 'native JS must preserve every source value');
    assert.deepEqual(jsValues, wasmValues);
    assert.deepEqual(soundsFromJs, soundsFromWasm);
  });
});

test('forced integer storage modes retain f32 compatibility and compact redundancy rules', {skip: releaseSkipReason}, async () => {
  await withTemporaryDirectory('slim-release-integer-modes-', async (directory) => {
    const source = await writeFixture(directory, sourceText);
    const autoOutput = join(directory, 'auto');
    const autoResult = runBuild(source, autoOutput, ['--release', '--sound-packing', 'auto', '--integer-arrays', 'auto', '--keyboard-only']);
    assertBuildSucceeded(autoResult, 'redundant compact release build');
    const autoReport = await readReport(autoOutput);
    assert.equal(autoReport.version, 6);
    assert.equal(autoReport.search, 'staged');
    const autoWasmCandidates = autoReport.candidates.filter((candidate) => candidate.backend === 'wasm');
    assert.ok(autoReport.skippedCandidates.some((candidate) => candidate.integerArrayStorage === 'compact'));
    assert.ok(autoWasmCandidates.every((candidate) => candidate.integerArrayStorage === 'f32'));

    const f32Output = join(directory, 'f32');
    const f32Result = runBuild(source, f32Output, ['--release', '--sound-packing', 'auto', '--integer-arrays', 'f32', '--keyboard-only']);
    assertBuildSucceeded(f32Result, 'forced f32 release build');
    const f32Report = await readReport(f32Output);
    assert.equal(f32Report.version, 6);
    assert.equal(f32Report.search, 'staged');
    assert.equal(f32Report.integerArrayStorage, 'f32');
    assert.ok(f32Report.candidates.filter((candidate) => candidate.backend === 'wasm').every((candidate) => candidate.integerArrayStorage === 'f32'));
    assert.deepEqual(await readFile(join(autoOutput, `${stem}.wasm`)), await readFile(join(f32Output, `${stem}.wasm`)), 'auto redundancy skip must retain f32 bytes');

    const compactOutput = join(directory, 'compact');
    const compactResult = runBuild(source, compactOutput, ['--release', '--sound-packing', 'auto', '--integer-arrays', 'compact', '--keyboard-only']);
    assertBuildSucceeded(compactResult, 'forced compact release build');
    const compactReport = await readReport(compactOutput);
    assert.equal(compactReport.version, 6);
    assert.equal(compactReport.search, 'staged');
    assert.equal(compactReport.integerArrayStorage, 'compact');
    assert.ok(compactReport.candidates.filter((candidate) => candidate.backend === 'wasm').every((candidate) => candidate.integerArrayStorage === 'compact'));
  });
});

test('release skips an unsupported packed atlas while retaining plain metadata', {skip: releaseSkipReason}, async () => {
  await withTemporaryDirectory('slim-release-fallback-', async (directory) => {
    const source = await writeFixture(directory, fractionSourceText);
    const output = join(directory, 'release');
    const result = runBuild(source, output, [
      '--release',
      '--pack-triangles', 'ATLAS',
      '--sound-packing', 'auto',
      '--keyboard-only',
    ]);
    assertBuildSucceeded(result, 'fraction fallback release build');

    const report = await readReport(output);
    assert.equal(report.version, 6);
    assert.equal(report.search, 'staged');
    assert.equal(report.release, true);
    assert.equal(report.soundPacking, 'auto');
    assert.deepEqual(report.requestedPackedTriangleArrays, ['ATLAS']);
    assert.deepEqual(report.packedTriangleArrays, []);
    assert.deepEqual(report.compiler.packedTriangleArrays, []);
    const atlas = report.compiler.arrayLayout.find((layout) => layout.name === 'ATLAS');
    assert.ok(atlas);
    assert.equal(atlas.byteLength, 36);
    assert.equal(atlas.encoding, undefined);
    assert.ok(Array.isArray(report.skippedCandidates));
    assert.ok(report.skippedCandidates.length > 0, 'unsupported packed combinations must be reported');
    const skippedText = JSON.stringify(report.skippedCandidates);
    assert.match(skippedText, /ATLAS/);
    assert.match(skippedText, /SLIM_PACKING_UNSUPPORTED|finite integer|unsupported/i);
    assert.ok(report.candidates.filter((candidate) => candidate.backend === 'wasm').every((candidate) => {
      return JSON.stringify(candidate.packedTriangleArrays) === '[]';
    }));
    assert.deepEqual((await readdir(output)).sort(), [...normalNames].sort());
  });
});

test('invalid release sound and triangle options preserve fresh and existing output', async () => {
  await withTemporaryDirectory('slim-release-invalid-', async (directory) => {
    const source = await writeFixture(directory);
    const cases = [
      ['search mode', ['--release', '--search', 'nonsense']],
      ['search mode missing', ['--release', '--search']],
      ['sound packing', ['--release', '--sound-packing', 'nonsense']],
      ['integer array storage', ['--release', '--integer-arrays', 'nonsense']],
      ['integer array storage missing', ['--release', '--integer-arrays']],
      ['unknown option', ['--release', '--integer-arrays', 'f32', '--bogus']],
      ['packed triangle target', ['--release', '--pack-triangles', 'MISSING']],
      ...soundPackings.map((mode) => [
        `packed triangle target with ${mode} sound packing`,
        ['--release', '--pack-triangles', 'MISSING', '--sound-packing', mode],
      ]),
    ];
    for (const [label, flags] of cases) {
      const freshOutput = join(directory, `fresh-${label.replaceAll(' ', '-')}`);
      const freshResult = runBuild(source, freshOutput, flags);
      assert.notEqual(freshResult.status, 0, `${label} unexpectedly succeeded`);
      assert.equal(existsSync(freshOutput), false, `${label} created a fresh output directory`);

      const existingOutput = join(directory, `existing-${label.replaceAll(' ', '-')}`);
      await mkdir(existingOutput, {recursive: true});
      await writeFile(join(existingOutput, 'sentinel.txt'), 'sentinel\n');
      const sentinels = new Map([['sentinel.txt', 'sentinel\n']]);
      const existingResult = runBuild(source, existingOutput, flags);
      assert.notEqual(existingResult.status, 0, `${label} unexpectedly succeeded with existing output`);
      await assertSentinelsUnchanged(existingOutput, sentinels);
      if (label === 'sound packing') assert.match(failureText(existingResult), /sound-packing|sound packing/i);
      if (label.startsWith('search mode')) assert.match(failureText(existingResult), /search/i);
      if (label.startsWith('integer array storage')) assert.match(failureText(existingResult), /integer-arrays|integer array storage/i);
      if (label === 'unknown option') assert.match(failureText(existingResult), /unknown option/i);
      if (label.startsWith('packed triangle target')) assert.match(failureText(existingResult), /packed triangle target|not a declared array/i);
    }
  });
});
