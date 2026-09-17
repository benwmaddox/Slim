import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {basename, delimiter, dirname, join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';
import {makeHtml} from '../src/host.mjs';
import {minifyHtml} from './minify.mjs';
import {winningReplay} from './blockbound-replay.mjs';
import {makeLoopMemorySource, patchExperimentalCompiler} from './compare-enemy-arrays.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputParent = join(root, 'output');
const outputRoot = join(outputParent, 'wasm-condition-study');
const python = process.env.SLIM_PYTHON || 'python';
const zipTool = join(root, 'tools', 'zip.py');

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`condition patch anchor ${label} was not unique`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function patchConditionCompiler(source) {
  source = source.replace(/\r\n/g, '\n');
  const old = `  const emitCondition = (expression, context) => [
    ...emitExpr(expression, context),
    0x43,
    ...f32Bytes(0),
    0x5c,
  ];`;
  const replacement = `  const emitCondition = (expression, context) => {
    const comparisonOpcodes = {
      "==": 0x5b,
      "!=": 0x5c,
      "<": 0x5d,
      ">": 0x5e,
      "<=": 0x5f,
      ">=": 0x60,
    };
    const emit = (node) => {
      if (node.kind === "binary") {
        if (node.op === "&&" || node.op === "||") {
          const code = [...emit(node.left), 0x04, 0x7f];
          if (node.op === "&&") {
            code.push(...emit(node.right), 0x05, 0x41, 0x00);
          } else {
            code.push(0x41, 0x01, 0x05, ...emit(node.right));
          }
          code.push(0x0b);
          return code;
        }
        const opcode = comparisonOpcodes[node.op];
        if (opcode !== undefined) {
          return [...emitExpr(node.left, context), ...emitExpr(node.right, context), opcode];
        }
      }
      if (node.kind === "unary" && node.op === "!") {
        return [...emit(node.expression), 0x45];
      }
      // Conditions use i32 truth directly.  f32.ne preserves the language's
      // v !== 0 rule for NaN and both signs of zero.
      return [...emitExpr(node, context), 0x43, ...f32Bytes(0), 0x5c];
    };
    return emit(expression);
  };`;
  return replaceOnce(source, old, replacement, 'emitCondition');
}

async function loadConditionCompiler() {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-condition-compiler-'));
  try {
    const source = await readFile(join(root, 'src', 'compiler.mjs'), 'utf8');
    await writeFile(join(temporary, 'compiler.mjs'), patchConditionCompiler(source));
    const module = await import(`${pathToFileURL(join(temporary, 'compiler.mjs')).href}?condition-study=${process.pid}-${Date.now()}`);
    return module;
  } finally {
    const target = resolve(temporary);
    const tempRoot = resolve(tmpdir());
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove temporary compiler outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

async function loadArrayCompilers() {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-array-condition-compiler-'));
  try {
    const original = await readFile(join(root, 'src', 'compiler.mjs'), 'utf8');
    const legacy = patchExperimentalCompiler(original);
    const combined = patchExperimentalCompiler(patchConditionCompiler(original));
    await writeFile(join(temporary, 'legacy.mjs'), legacy);
    await writeFile(join(temporary, 'combined.mjs'), combined);
    const suffix = `?array-condition-study=${process.pid}-${Date.now()}`;
    const legacyModule = await import(`${pathToFileURL(join(temporary, 'legacy.mjs')).href}${suffix}-legacy`);
    const combinedModule = await import(`${pathToFileURL(join(temporary, 'combined.mjs')).href}${suffix}-combined`);
    return {legacy: legacyModule, combined: combinedModule};
  } finally {
    const target = resolve(temporary);
    const tempRoot = resolve(tmpdir());
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove temporary array compiler outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
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

function configuredExecutable(name, configured, siblingOf) {
  if (configured) {
    const candidate = configured.includes('\\') || configured.includes('/') ? configured : pathExecutable(configured);
    if (!candidate || !existsSync(candidate)) throw new Error(`Configured ${name} was not found: ${configured}`);
    return candidate;
  }
  if (siblingOf && (siblingOf.includes('\\') || siblingOf.includes('/'))) {
    const sibling = join(dirname(siblingOf), `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(sibling)) return sibling;
  }
  return pathExecutable(name) || (process.platform === 'win32' ? pathExecutable(`${name}.exe`) : undefined);
}

function run(command, args, label) {
  const result = spawnSync(command, args, {encoding: 'utf8', windowsHide: true});
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

async function writeArchive({target, stem, html, wasm}) {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-condition-package-'));
  try {
    await writeFile(join(temporary, 'index.html'), html);
    const entries = ['index.html'];
    if (wasm) {
      await writeFile(join(temporary, `${stem}.wasm`), wasm);
      entries.push(`${stem}.wasm`);
    }
    run(python, [zipTool, temporary, target, ...entries], 'ZIP packaging');
    return (await stat(target)).size;
  } finally {
    const targetPath = resolve(temporary);
    const tempRoot = resolve(tmpdir());
    if (!targetPath.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove package staging outside ${tempRoot}`);
    await rm(targetPath, {recursive: true, force: true});
  }
}

function archiveNames(path) {
  const code = 'import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))';
  return JSON.parse(run(python, ['-c', code, path], 'ZIP inspection').stdout);
}

function titleFor(stem) {
  return stem.split(/[-_]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') || 'Slim';
}

function choose(items) {
  return items.slice().sort((left, right) => left.zipBytes - right.zipBytes || left.id.localeCompare(right.id))[0];
}

function summary(candidate) {
  return {
    id: candidate.id,
    profile: candidate.profile,
    optimization: candidate.optimization,
    rawWasmBytes: candidate.bytes.length,
    htmlBytes: candidate.htmlBytes,
    zipBytes: candidate.zipBytes,
    archiveEntries: candidate.archiveEntries,
  };
}

async function packageGame({name, source, baseline, candidate, optimizer, disassembler, stagingRoot}) {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-condition-game-'));
  const all = [];
  try {
    const modules = [];
    for (const profile of [
      {name: 'baseline', bytes: baseline},
      {name: 'condition', bytes: candidate},
    ]) {
      if (!WebAssembly.validate(profile.bytes)) throw new Error(`${name} ${profile.name} plain WASM is invalid`);
      const plainPath = join(temporary, `${profile.name}.plain.wasm`);
      const ozPath = join(temporary, `${profile.name}.Oz.wasm`);
      await writeFile(plainPath, profile.bytes);
      run(optimizer, [plainPath, '-Oz', '--strip-debug', '--strip-producers', '-o', ozPath], `${name} ${profile.name} wasm-opt`);
      const oz = await readFile(ozPath);
      if (!WebAssembly.validate(oz)) throw new Error(`${name} ${profile.name} Oz WASM is invalid`);
      modules.push({profile: profile.name, optimization: 'plain', bytes: profile.bytes});
      modules.push({profile: profile.name, optimization: 'Oz', bytes: oz});
    }

    for (const module of modules) {
      const html = makeHtml(module.bytes, {
        title: titleFor(name),
        keyboardOnly: name === 'blockbound',
        wasmUrl: `${name}.wasm`,
      });
      const minified = await minifyHtml(html);
      const archivePath = join(temporary, `${module.profile}-${module.optimization}.zip`);
      const zipBytes = await writeArchive({target: archivePath, stem: name, html: minified, wasm: module.bytes});
      const archiveEntries = archiveNames(archivePath);
      const expectedEntries = [`${name}.wasm`, 'index.html'].sort();
      assert.deepEqual(archiveEntries, expectedEntries, `${name} ${module.profile} ${module.optimization} archive entries`);
      all.push({
        id: `${module.profile}-${module.optimization}`,
        profile: module.profile,
        optimization: module.optimization,
        bytes: module.bytes,
        html: minified,
        htmlBytes: Buffer.byteLength(minified),
        zipBytes,
        archiveEntries,
        archivePath,
      });
    }

    const gameDir = join(stagingRoot, name);
    await mkdir(gameDir, {recursive: true});
    const artifacts = {};
    for (const profile of ['baseline', 'condition']) {
      const selected = choose(all.filter((item) => item.profile === profile));
      const watPath = join(temporary, `${profile}.wat`);
      const wasmPath = join(temporary, `${profile}.selected.wasm`);
      await writeFile(wasmPath, selected.bytes);
      run(disassembler, [wasmPath, '-o', watPath], `${name} ${profile} wasm-dis`);
      const wat = await readFile(watPath, 'utf8');
      if (!wat.startsWith('(module')) throw new Error(`${name} ${profile} WAT is not a module`);
      const prefix = `${name}.${profile}`;
      const files = {
        wasm: `${prefix}.wasm`,
        wat: `${prefix}.wat`,
        html: `${prefix}.html`,
        zip: `${prefix}.zip`,
      };
      await writeFile(join(gameDir, files.wasm), selected.bytes);
      await writeFile(join(gameDir, files.wat), wat);
      await writeFile(join(gameDir, files.html), selected.html);
      await copyFile(selected.archivePath, join(gameDir, files.zip));
      artifacts[profile] = files;
    }

    const plain = all.filter((item) => item.optimization === 'plain');
    const oz = all.filter((item) => item.optimization === 'Oz');
    return {
      source: basename(source),
      raw: {baseline: baseline.length, condition: candidate.length, delta: candidate.length - baseline.length},
      completeZip: {
        baseline: summary(choose(all.filter((item) => item.profile === 'baseline'))),
        condition: summary(choose(all.filter((item) => item.profile === 'condition'))),
        delta: choose(all.filter((item) => item.profile === 'condition')).zipBytes - choose(all.filter((item) => item.profile === 'baseline')).zipBytes,
      },
      byOptimization: {
        plain: {baseline: summary(plain.find((item) => item.profile === 'baseline')), condition: summary(plain.find((item) => item.profile === 'condition'))},
        Oz: {baseline: summary(oz.find((item) => item.profile === 'baseline')), condition: summary(oz.find((item) => item.profile === 'condition'))},
      },
      candidates: all.map(summary),
      selected: {
        baseline: summary(choose(all.filter((item) => item.profile === 'baseline'))),
        condition: summary(choose(all.filter((item) => item.profile === 'condition'))),
      },
      artifacts,
      baselineBytes: baseline,
      conditionBytes: candidate,
      ozBytes: {
        baseline: all.find((item) => item.profile === 'baseline' && item.optimization === 'Oz').bytes,
        condition: all.find((item) => item.profile === 'condition' && item.optimization === 'Oz').bytes,
      },
    };
  } finally {
    const target = resolve(temporary);
    const tempRoot = resolve(tmpdir());
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove game staging outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

function callbackRunner(bytes) {
  const module = new WebAssembly.Module(bytes);
  const descriptors = WebAssembly.Module.imports(module);
  let input = Object.create(null);
  let events = [];
  const imports = Object.create(null);
  for (const descriptor of descriptors) {
    assert.equal(descriptor.module, 'e', `unexpected module ${descriptor.module}`);
    const namespace = imports.e || (imports.e = {});
    if (descriptor.name === 'input') {
      namespace.input = (index) => Number(input[index | 0] ?? 0);
    } else if (descriptor.name === 'tri') {
      namespace.tri = (...args) => { events.push(['tri', ...args]); return 0; };
    } else if (descriptor.name === 'sound') {
      namespace.sound = (...args) => { events.push(['sound', ...args]); return 0; };
    } else {
      throw new Error(`unexpected import ${descriptor.name}`);
    }
  }
  const instance = new WebAssembly.Instance(module, imports);
  return {
    init() { instance.exports.init(); },
    frame(values) { input = values; events = []; instance.exports.frame(); return events.map((event) => event.slice()); },
  };
}

function compareSequence(label, baselineBytes, conditionBytes, inputs) {
  const baseline = callbackRunner(baselineBytes);
  const condition = callbackRunner(conditionBytes);
  baseline.init();
  condition.init();
  for (const [tick, input] of inputs.entries()) {
    const expected = baseline.frame(input);
    const actual = condition.frame(input);
    assert.deepEqual(actual, expected, `${label} callback mismatch at tick ${tick}`);
  }
  return {ticks: inputs.length};
}

function blockboundInputs() {
  const inputs = [{}];
  let held = false;
  for (const segment of winningReplay) {
    for (let tick = 0; tick < segment.ticks; tick += 1) {
      const space = segment.keys.includes('Space');
      inputs.push({
        0: segment.keys.includes('ArrowLeft') ? 1 : 0,
        1: segment.keys.includes('ArrowRight') ? 1 : 0,
        4: space ? 1 : 0,
        5: space && !held ? 1 : 0,
      });
      held = space;
    }
  }
  inputs.push({9: 1});
  for (let tick = 0; tick < 600; tick += 1) inputs.push({1: 1});
  inputs.push({9: 1});
  assert.equal(inputs.length, 1706, 'Blockbound replay input count');
  return inputs;
}

function rainbowInputs() {
  const inputs = [];
  for (let tick = 0; tick < 600; tick += 1) {
    inputs.push({
      0: tick % 37 === 0 ? 1 : 0,
      1: tick % 5 < 3 ? 1 : 0,
      2: tick % 11 === 0 ? 1 : 0,
      3: tick % 17 === 0 ? 1 : 0,
      4: tick % 19 < 4 ? 1 : 0,
      5: tick % 29 === 0 ? 1 : 0,
      6: 30 + (tick * 37) % 740,
      7: 78 + (tick * 53) % 492,
      8: tick % 7 < 3 ? 1 : 0,
      9: tick === 300 ? 1 : 0,
    });
  }
  return inputs;
}

function makeFixedArrayOffsetSource(source) {
  const replacements = [
    ['__array_load(256, i + 10)', '__array_load(296, i)', 'y loads'],
    ['__array_load(256, i + 20)', '__array_load(336, i)', 'alive loads'],
    ['__array_store(256, i + 20', '__array_store(336, i', 'alive stores'],
  ];
  let result = source;
  for (const [from, to, label] of replacements) {
    const count = result.split(from).length - 1;
    if (count === 0) throw new Error(`fixed array offset anchor ${label} was not found`);
    result = result.split(from).join(to);
  }
  return result;
}

const syntheticSource = `
fn side() {
  sound(9, 0, 1);
  return input(0);
}

fn init() {}

fn frame() {
  let bool_value = input(4) > 0 && input(5) > 0;
  if (bool_value) {
    sound(5, 0, 1);
  }
  if (input(1) > 0 && (side() != 0 || side() == 0)) {
    sound(1, 0, 1);
  }
  if (input(2) > 0 || side()) {
    sound(2, 0, 1);
  }
  if (!(input(3) > 0) && !side()) {
    sound(3, 0, 1);
  }
  if (-0) {
    sound(4, 0, 1);
  }
}
`;

function syntheticInputs() {
  const nan = Number.NaN;
  return [
    {0: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1},
    {0: nan, 1: 1, 2: 0, 3: 1, 4: 0, 5: 1},
    {0: 0, 1: 0, 2: 1, 3: 1, 4: 1, 5: 0},
    {0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0},
    {0: nan, 1: 0, 2: 0, 3: 0, 4: 1, 5: 1},
  ];
}

async function main() {
  const compiler = await loadConditionCompiler();
  const arrayCompilers = await loadArrayCompilers();
  const optimizer = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  const disassembler = configuredExecutable('wasm-dis', process.env.SLIM_WASM_DIS, optimizer);
  if (!optimizer) throw new Error('wasm-opt is required for the condition comparison');
  if (!disassembler) throw new Error('wasm-dis is required for the condition comparison');
  const sources = {};
  for (const name of ['rainbow', 'blockbound']) sources[name] = await readFile(join(root, 'examples', `${name}.slim`), 'utf8');

  await mkdir(outputParent, {recursive: true});
  const stagingRoot = await mkdtemp(join(outputParent, '.wasm-condition-study-staging-'));
  try {
    const games = {};
    for (const name of ['rainbow', 'blockbound']) {
      const source = sources[name];
      const baseline = compileDetailed(source).wasm;
      const condition = compiler.compileDetailed(source).wasm;
      const result = await packageGame({name, source: join(root, 'examples', `${name}.slim`), baseline, candidate: condition, optimizer, disassembler, stagingRoot});
      games[name] = result;
    }

    const syntheticBaseline = compileDetailed(syntheticSource).wasm;
    const syntheticCondition = compiler.compileDetailed(syntheticSource).wasm;
    assert.ok(WebAssembly.validate(syntheticCondition), 'synthetic condition WASM must validate');
    const synthetic = compareSequence('synthetic condition cases', syntheticBaseline, syntheticCondition, syntheticInputs());
    const blockboundInputsValue = blockboundInputs();
    const loopSource = makeLoopMemorySource(sources.blockbound);
    const arraysLegacy = arrayCompilers.legacy.compileDetailed(loopSource, {arrayMemory: true}).wasm;
    const arraysCombined = arrayCompilers.combined.compileDetailed(loopSource, {arrayMemory: true}).wasm;
    const arrays = await packageGame({
      name: 'blockbound',
      source: join(root, 'examples', 'blockbound.slim'),
      baseline: arraysLegacy,
      candidate: arraysCombined,
      optimizer,
      disassembler,
      stagingRoot: join(stagingRoot, 'arrays'),
    });
    const fixedArraySource = makeFixedArrayOffsetSource(loopSource);
    const fixedArrayCombined = arrayCompilers.combined.compileDetailed(fixedArraySource, {arrayMemory: true}).wasm;
    const arraysOffset = await packageGame({
      name: 'blockbound',
      source: join(root, 'examples', 'blockbound.slim'),
      baseline: arraysCombined,
      candidate: fixedArrayCombined,
      optimizer,
      disassembler,
      stagingRoot: join(stagingRoot, 'array-offset'),
    });
    const blockboundParity = {
      plain: compareSequence('Blockbound plain', games.blockbound.baselineBytes, games.blockbound.conditionBytes, blockboundInputsValue),
      Oz: compareSequence('Blockbound Oz',
        games.blockbound.ozBytes.baseline,
        games.blockbound.ozBytes.condition,
        blockboundInputsValue),
    };
    const arraysParity = {
      plainLegacy: compareSequence('Blockbound arrays legacy plain', games.blockbound.baselineBytes, arrays.baselineBytes, blockboundInputsValue),
      plainCombined: compareSequence('Blockbound arrays combined plain', games.blockbound.baselineBytes, arrays.conditionBytes, blockboundInputsValue),
      OzLegacy: compareSequence('Blockbound arrays legacy Oz', games.blockbound.ozBytes.baseline, arrays.ozBytes.baseline, blockboundInputsValue),
      OzCombined: compareSequence('Blockbound arrays combined Oz', games.blockbound.ozBytes.baseline, arrays.ozBytes.condition, blockboundInputsValue),
    };
    const arraysOffsetParity = {
      productionPlain: compareSequence('Blockbound fixed array offsets plain', games.blockbound.baselineBytes, arraysOffset.conditionBytes, blockboundInputsValue),
      productionOz: compareSequence('Blockbound fixed array offsets Oz', games.blockbound.ozBytes.baseline, arraysOffset.ozBytes.condition, blockboundInputsValue),
      combinedPlain: compareSequence('Blockbound fixed array offsets combined plain', arrays.conditionBytes, arraysOffset.conditionBytes, blockboundInputsValue),
      combinedOz: compareSequence('Blockbound fixed array offsets combined Oz', arrays.ozBytes.condition, arraysOffset.ozBytes.condition, blockboundInputsValue),
    };
    const rainbowInputsValue = rainbowInputs();
    const rainbowParity = {
      plain: compareSequence('Rainbow plain', games.rainbow.baselineBytes, games.rainbow.conditionBytes, rainbowInputsValue),
      Oz: compareSequence('Rainbow Oz',
        games.rainbow.ozBytes.baseline,
        games.rainbow.ozBytes.condition,
        rainbowInputsValue),
    };

    const report = {
      version: 1,
      experiment: 'WASM direct i32 condition lowering',
      optimizer: 'wasm-opt -Oz --strip-debug --strip-producers',
      packaging: 'keyboard-only Blockbound; title-derived stem; external minified WASM ZIP',
      lowering: {
        comparisons: 'f32 operands followed by direct i32 comparison opcode in condition contexts',
        logical: 'short-circuit result-i32 if blocks for && and ||',
        negation: 'recursive condition lowering followed by i32.eqz',
        fallback: 'f32 expression, f32.const 0, f32.ne (i32 result)',
        valueContexts: 'emitExpr remains unchanged, preserving f32 0/1 values and side-effect order',
        truth: 'f32.ne treats NaN as true and both +0/-0 as false',
      },
      synthetic: {sourceCases: synthetic.ticks, parity: synthetic},
      games: {
        rainbow: {...games.rainbow, baselineBytes: undefined, conditionBytes: undefined, ozBytes: undefined, parity: rainbowParity, replay: {ticks: rainbowInputsValue.length, kind: 'deterministic mixed pointer and keyboard'}},
        blockbound: {...games.blockbound, baselineBytes: undefined, conditionBytes: undefined, ozBytes: undefined, parity: blockboundParity, replay: {ticks: blockboundInputsValue.length, kind: 'initial, winningReplay1103, restart, right600(loss), restart'}},
        blockboundArrays: {
          ...arrays,
          baselineBytes: undefined,
          conditionBytes: undefined,
          ozBytes: undefined,
          productionBaseline: {
            plain: summary({id: 'production-plain', profile: 'baseline', optimization: 'plain', bytes: games.blockbound.baselineBytes, htmlBytes: games.blockbound.byOptimization.plain.baseline.htmlBytes, zipBytes: games.blockbound.byOptimization.plain.baseline.zipBytes, archiveEntries: games.blockbound.byOptimization.plain.baseline.archiveEntries}),
            Oz: summary({id: 'production-Oz', profile: 'baseline', optimization: 'Oz', bytes: games.blockbound.ozBytes.baseline, htmlBytes: games.blockbound.byOptimization.Oz.baseline.htmlBytes, zipBytes: games.blockbound.byOptimization.Oz.baseline.zipBytes, archiveEntries: games.blockbound.byOptimization.Oz.baseline.archiveEntries}),
          },
          memory: {
            baseByteOffset: 256,
            arrayBytes: 120,
            allocatedBytes: 65536,
            allocatedPages: 1,
            additionalPages: 0,
            withinAllocatedPage: true,
          },
          parity: arraysParity,
          replay: {ticks: blockboundInputsValue.length, kind: 'production baseline vs arrays legacy/combined plain and Oz'},
        },
        blockboundArraysOffset: {
          ...arraysOffset,
          baselineBytes: undefined,
          conditionBytes: undefined,
          ozBytes: undefined,
          arrayOffsetOptimization: {
            xBaseByteOffset: 256,
            yBaseByteOffset: 296,
            aliveBaseByteOffset: 336,
            arrayBytes: 120,
            rule: 'known integer loop counter replacement only; no general float index rewrite',
          },
          parity: arraysOffsetParity,
          replay: {ticks: blockboundInputsValue.length, kind: 'production baseline and combined direct-array profile vs fixed bases'},
        },
      },
    };
    const clean = (value) => {
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, clean(item)]));
      return value;
    };
    await writeFile(join(stagingRoot, 'report.json'), `${JSON.stringify(clean(report), null, 2)}\n`);

    const target = resolve(outputRoot);
    const parent = resolve(outputParent);
    if (!target.startsWith(`${parent}${sep}`)) throw new Error(`refusing to replace output outside ${parent}`);
    await rm(target, {recursive: true, force: true});
    await rename(stagingRoot, target);
    console.log(JSON.stringify(clean(report), null, 2));
  } finally {
    const target = resolve(stagingRoot);
    const parent = resolve(outputParent);
    if (existsSync(target)) {
      if (!target.startsWith(`${parent}${sep}`)) throw new Error(`refusing to remove staging outside ${parent}`);
      await rm(target, {recursive: true, force: true});
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
