import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {accessSync, constants as fsConstants} from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {basename, delimiter, dirname, join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';
import {makeHtml} from '../src/host.mjs';
import {minifyHtml} from './minify.mjs';
import {winningReplay} from './blockbound-replay.mjs';

// This is a bounded, reproducible Binaryen experiment. It deliberately writes
// only under output/wasm-opt-study and never changes dist or the production
// build. Every optimizer candidate is checked in the same callback host as the
// fresh compiler output before it is eligible for the size report.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputParent = join(root, 'output');
const outputRoot = join(outputParent, 'wasm-opt-study');
const zipTool = join(root, 'tools', 'zip.py');
const budget = 13312;
const commonStripFlags = ['--strip-debug', '--strip-producers'];
const safePasses = [
  '--merge-similar-functions',
  '--code-folding',
  '--precompute',
  '--flatten',
  '--rereloop',
];
const forbiddenFlags = [
  '--fast-math',
  '--ignore-implicit-traps',
  '--traps-never-happen',
  '--denan',
  '--fpcast-emu',
  '--low-memory-unused',
  '--zero-filled-memory',
  '--enclose-world',
  '--closed-world',
  '--minify-imports',
  '--minify-imports-and-exports',
  '--minify-imports-and-exports-and-modules',
];

const sourceDefinitions = [
  {
    id: 'rainbow',
    stem: 'rainbow',
    title: 'Rainbow',
    sourcePath: join(root, 'examples', 'rainbow.slim'),
    keyboardOnly: false,
    trace: makeRainbowTrace,
  },
  {
    id: 'blockbound',
    stem: 'blockbound',
    title: 'Blockbound',
    sourcePath: join(root, 'examples', 'blockbound.slim'),
    keyboardOnly: true,
    trace: makeBlockboundTrace,
  },
];

function pathExecutable(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name.toLowerCase().endsWith(extension.toLowerCase())
        ? name
        : `${name}${extension}`);
      try {
        accessSync(candidate, fsConstants.F_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

function configuredExecutable(name, configured, siblingOf) {
  if (configured) return configured;
  if (siblingOf && (siblingOf.includes('\\') || siblingOf.includes('/'))) {
    const sibling = join(dirname(siblingOf), `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    try {
      accessSync(sibling, fsConstants.F_OK);
      return sibling;
    } catch {}
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

function safeRelativePath(path) {
  const target = resolve(path);
  const parent = resolve(outputParent);
  if (target !== parent && !target.startsWith(`${parent}${sep}`)) {
    throw new Error(`refusing to use path outside ${parent}: ${path}`);
  }
  return target;
}

function assertNoForbiddenFlags(flags, label) {
  for (const flag of flags) {
    for (const forbidden of forbiddenFlags) {
      if (flag === forbidden || flag.startsWith(`${forbidden}=`)) {
        throw new Error(`${label} includes forbidden semantic flag ${flag}`);
      }
    }
  }
}

function helpHas(help, option) {
  if (option.startsWith('-O')) return new RegExp(`(?:^|\\s)${option.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?:\\s|$)`, 'm').test(help);
  return help.includes(option);
}

function makeProfiles(help) {
  for (const required of ['-Os', '-Oz', '-O3', '-O4', '--strip-debug', '--strip-producers']) {
    if (!helpHas(help, required)) throw new Error(`wasm-opt does not advertise required flag ${required}`);
  }
  const profiles = [
    {id: 'plain', label: 'fresh compiler output', flags: [], kind: 'plain'},
    {id: 'Oz', label: 'current -Oz production baseline', flags: ['-Oz'], kind: 'optimizer'},
    {id: 'Os', label: '-Os', flags: ['-Os'], kind: 'optimizer'},
    {id: 'O3', label: '-O3', flags: ['-O3'], kind: 'optimizer'},
    {id: 'O4', label: '-O4', flags: ['-O4'], kind: 'optimizer'},
  ];

  if (helpHas(help, '--converge')) {
    profiles.push({id: 'Oz-converge', label: '-Oz with bounded convergence', flags: ['-Oz', '--converge'], kind: 'optimizer'});
  }
  if (helpHas(help, '--shrink-level')) {
    profiles.push({id: 'Oz-shrink0', label: '-Oz shrink level 0', flags: ['-Oz', '--shrink-level=0'], kind: 'optimizer'});
    profiles.push({id: 'Oz-shrink2', label: '-Oz shrink level 2', flags: ['-Oz', '--shrink-level=2'], kind: 'optimizer'});
  }
  if (safePasses.every((pass) => helpHas(help, pass))) {
    profiles.push({id: 'Oz-safe-passes', label: '-Oz plus explicit safe passes', flags: ['-Oz', ...safePasses], kind: 'optimizer'});
  }
  // Keep the grid bounded even if a future Binaryen version adds another
  // optional profile above. The first entries always retain the required
  // plain/-Oz/-Os/-O3/-O4 comparison.
  return profiles.slice(0, 10).map((profile) => ({
    ...profile,
    flags: profile.kind === 'plain' ? [] : [...profile.flags, ...commonStripFlags],
  }));
}

function moduleMetadata(bytes, label) {
  assert.ok(bytes instanceof Uint8Array, `${label}: expected Uint8Array`);
  assert.ok(bytes.byteLength > 8, `${label}: WASM is empty`);
  assert.ok(WebAssembly.validate(bytes), `${label}: invalid WASM`);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module).map(({module: moduleName, name, kind}) => ({module: moduleName, name, kind}));
  const exports = WebAssembly.Module.exports(module).map(({name, kind}) => ({name, kind}));
  const memoryExport = exports.find((item) => item.name === 'memory' && item.kind === 'memory');
  assert.ok(memoryExport, `${label}: expected exported memory`);
  return {module, imports, exports};
}

function instantiate(bytes, definition, label) {
  const metadata = moduleMetadata(bytes, label);
  const host = makeCallbackHost();
  const instance = new WebAssembly.Instance(metadata.module, {e: host.imports});
  assert.equal(typeof instance.exports.init, 'function', `${label}: missing init export`);
  assert.equal(typeof instance.exports.frame, 'function', `${label}: missing frame export`);
  assert.ok(instance.exports.memory instanceof WebAssembly.Memory, `${label}: missing memory export`);
  const memoryBytes = instance.exports.memory.buffer.byteLength;
  assert.equal(memoryBytes % 65536, 0, `${label}: memory is not page aligned`);
  const pages = memoryBytes / 65536;
  return {
    definition,
    bytes,
    metadata,
    host,
    game: instance.exports,
    pages,
    memoryBytes,
  };
}

function makeCallbackHost() {
  let input = Object.create(null);
  let events = [];
  const host = {
    input: (index) => Number(input[index | 0] ?? 0),
    tri: (...values) => {
      events.push(['tri', ...values]);
      return 0;
    },
    sound: (...values) => {
      events.push(['sound', ...values]);
      return 0;
    },
  };
  return {
    imports: host,
    setInput(values) {
      input = values || Object.create(null);
      events = [];
    },
    events() {
      return events.map((event) => event.slice());
    },
  };
}

function inputsEqualTrace(trace, label, baseline, candidate) {
  assert.deepEqual(candidate.metadata.imports, baseline.metadata.imports, `${label}: import contract changed`);
  assert.deepEqual(candidate.metadata.exports, baseline.metadata.exports, `${label}: export contract changed`);
  assert.equal(candidate.pages, baseline.pages, `${label}: memory page count changed`);
  baseline.game.init();
  candidate.game.init();
  for (let tick = 0; tick < trace.inputs.length; tick += 1) {
    const input = trace.inputs[tick];
    baseline.host.setInput(input);
    candidate.host.setInput(input);
    baseline.game.frame();
    const before = baseline.host.events();
    candidate.game.frame();
    const after = candidate.host.events();
    assert.deepEqual(after, before, `${label}: callback mismatch at tick ${tick}`);
  }
  return {
    passed: true,
    ticks: trace.inputs.length,
    pointerTicks: trace.pointerTicks,
    keyboardTicks: trace.keyboardTicks,
    description: trace.description,
  };
}

function makeBlockboundTrace() {
  const inputs = [{}];
  let previousSpace = false;
  for (const segment of winningReplay) {
    for (let tick = 0; tick < segment.ticks; tick += 1) {
      const space = segment.keys.includes('Space');
      inputs.push({
        0: segment.keys.includes('ArrowLeft') ? 1 : 0,
        1: segment.keys.includes('ArrowRight') ? 1 : 0,
        4: space ? 1 : 0,
        5: space && !previousSpace ? 1 : 0,
      });
      previousSpace = space;
    }
  }
  inputs.push({9: 1});
  for (let tick = 0; tick < 600; tick += 1) inputs.push({1: 1});
  inputs.push({9: 1});
  return {
    inputs,
    keyboardTicks: inputs.length,
    pointerTicks: 0,
    description: 'initial, winningReplay, restart, right-held loss, restart',
  };
}

function pushTicks(target, count, values) {
  for (let index = 0; index < count; index += 1) target.push({...values});
}

function makeRainbowTrace() {
  const inputs = [{}];
  pushTicks(inputs, 20, {1: 1});
  pushTicks(inputs, 12, {0: 1});
  // Collect all three shards through the real pointer input contract.
  inputs.push({4: 1, 8: 1, 6: 180, 7: 160});
  inputs.push({4: 1, 8: 1, 6: 400, 7: 290});
  inputs.push({4: 1, 8: 1, 6: 620, 7: 420});
  inputs.push({});
  inputs.push({9: 1});
  // Exercise a deterministic pointer collision and restart.
  pushTicks(inputs, 24, {4: 1, 8: 1, 6: 120, 7: 78});
  inputs.push({9: 1});

  // A mixed keyboard/pointer fixture keeps running after both terminal paths.
  // Values are integers so the host boundary itself cannot introduce a
  // candidate-dependent rounding choice.
  for (let tick = 0; tick < 600; tick += 1) {
    const values = {};
    const phase = tick % 24;
    if (phase < 8) values[1] = 1;
    else if (phase < 16) values[0] = 1;
    if (tick % 37 === 0) values[2] = 1;
    if (tick % 41 < 6) values[3] = 1;
    if (tick % 19 < 7) values[4] = 1;
    if (tick % 53 === 0) values[5] = 1;
    if (tick % 11 < 5) {
      values[8] = 1;
      values[4] = 1;
      values[6] = 80 + ((tick * 37) % 640);
      values[7] = 90 + ((tick * 29) % 430);
    }
    inputs.push(values);
  }
  return {
    inputs,
    keyboardTicks: inputs.length,
    pointerTicks: inputs.filter((values) => values[8] > 0).length,
    description: 'keyboard movement, pointer shard collection, loss/restart, mixed 600-tick fixture',
  };
}

function traceFor(definition) {
  const trace = definition.trace();
  assert.ok(trace.inputs.length >= 600, `${definition.id}: trace must contain at least 600 ticks`);
  return trace;
}

function archiveInfo(path, python) {
  const script = [
    'import json,sys,zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as z:',
    '  print(json.dumps({"entries": z.namelist(), "compressed": {i.filename: i.compress_size for i in z.infolist()}}))',
  ].join('\n');
  const result = run(python, ['-c', script, path], 'ZIP inspection');
  return JSON.parse(result.stdout);
}

async function writeArchive({python, target, html, stem, wasm}) {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-wasm-opt-package-'));
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

async function packageCandidate({definition, profile, bytes, gameRoot, python}) {
  const wasmName = `${definition.stem}.${profile.id}.wasm`;
  const wasmPath = join(gameRoot, wasmName);
  await writeFile(wasmPath, bytes);
  const compressedBytes = deflateRawSync(bytes, {level: 9}).byteLength;
  const htmls = {};
  const packages = {};
  for (const layout of ['embedded', 'external']) {
    const html = makeHtml(bytes, {
      title: definition.title,
      keyboardOnly: definition.keyboardOnly,
      ...(layout === 'external' ? {wasmUrl: `${definition.stem}.wasm`} : {}),
    });
    const minified = await minifyHtml(html);
    htmls[layout] = minified;
    const archiveName = `${definition.stem}.${profile.id}.${layout}.zip`;
    const archivePath = join(gameRoot, archiveName);
    const zipBytes = await writeArchive({
      python,
      target: archivePath,
      html: minified,
      stem: definition.stem,
      wasm: layout === 'external' ? bytes : undefined,
    });
    const archive = archiveInfo(archivePath, python);
    const expectedEntries = layout === 'external'
      ? ['index.html', `${definition.stem}.wasm`]
      : ['index.html'];
    assert.deepEqual(archive.entries, expectedEntries.slice().sort(), `${definition.id}/${profile.id}/${layout}: archive entries changed`);
    packages[layout] = {
      archive: archiveName,
      htmlBytes: Buffer.byteLength(minified),
      zipBytes,
      archiveEntries: archive.entries,
      compressedEntries: archive.compressed,
      zipWasmDeflateBytes: layout === 'external' ? archive.compressed[`${definition.stem}.wasm`] : null,
    };
  }
  const metadata = moduleMetadata(bytes, `${definition.id}/${profile.id}`);
  return {
    id: profile.id,
    label: profile.label,
    kind: profile.kind,
    flags: profile.flags.slice(),
    wasm: wasmName,
    rawWasmBytes: bytes.byteLength,
    wasmBytes: bytes.byteLength,
    deflateWasmBytes: compressedBytes,
    packages,
    minZipBytes: Math.min(packages.embedded.zipBytes, packages.external.zipBytes),
    metadata,
    htmls,
    bytes,
    wasmPath,
  };
}

function candidateSummary(candidate, gameRoot) {
  const selectedLayout = candidate.packages.embedded.zipBytes <= candidate.packages.external.zipBytes
    ? 'embedded'
    : 'external';
  const selectedPackage = candidate.packages[selectedLayout];
  return {
    id: candidate.id,
    label: candidate.label,
    kind: candidate.kind,
    flags: candidate.flags,
    wasm: candidate.wasm,
    rawWasmBytes: candidate.rawWasmBytes,
    wasmBytes: candidate.wasmBytes,
    deflateWasmBytes: candidate.deflateWasmBytes,
    zipWasmDeflateBytes: selectedPackage.zipWasmDeflateBytes,
    imports: candidate.metadata.imports,
    exports: candidate.metadata.exports,
    memoryPages: candidate.pages,
    memoryBytes: candidate.memoryBytes,
    selectedLayout,
    selectedZipBytes: selectedPackage.zipBytes,
    packages: Object.fromEntries(Object.entries(candidate.packages).map(([layout, value]) => [layout, {
      archive: value.archive,
      htmlBytes: value.htmlBytes,
      zipBytes: value.zipBytes,
      archiveEntries: value.archiveEntries,
      compressedEntries: value.compressedEntries,
      zipWasmDeflateBytes: value.zipWasmDeflateBytes,
    }])),
    outputDirectory: gameRoot,
  };
}

async function loadOptionalLoopProfile() {
  const reportPath = join(root, 'output', 'array-study', 'runtime-comparison', 'report.json');
  const modulePath = join(root, 'output', 'array-study', 'runtime-comparison', 'loop-memory', 'blockbound.wasm');
  try {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const bytes = new Uint8Array(await readFile(modulePath));
    const loop = report?.profiles?.['loop-memory'];
    if (!loop || !loop.selectedWasm) throw new Error('array-study report has no loop-memory selected WASM');
    if (loop.selectedWasm.wasmBytes !== bytes.byteLength) {
      throw new Error(`array-study selected loop byte count ${loop.selectedWasm.wasmBytes} != ${bytes.byteLength}`);
    }
    moduleMetadata(bytes, 'optional loop-memory seed');
    return {
      bytes,
      reportPath: 'output/array-study/runtime-comparison/report.json',
      modulePath: 'output/array-study/runtime-comparison/loop-memory/blockbound.wasm',
      source: report.source,
      selected: loop.selectedWasm,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function runDefinition({definition, sourceText, profiles, tools, staging, optionalSeed = null}) {
  const gameId = optionalSeed ? `${definition.id}-loop-memory` : definition.id;
  const gameRoot = join(staging, gameId);
  await mkdir(gameRoot, {recursive: true});
  let plainBytes;
  let input;
  if (optionalSeed) {
    plainBytes = optionalSeed.bytes;
    input = {
      kind: 'selected-oz-seed',
      report: optionalSeed.reportPath,
      module: optionalSeed.modulePath,
      source: optionalSeed.source,
      selected: optionalSeed.selected,
    };
  } else {
    const detailed = compileDetailed(sourceText);
    plainBytes = detailed.wasm;
    input = {
      kind: 'fresh-production-compiler',
      source: `examples/${basename(definition.sourcePath)}`,
      compilerImports: detailed.imports,
      compilerFunctions: detailed.functions,
      compilerGlobals: detailed.globals,
    };
  }
  const baselineMeta = moduleMetadata(plainBytes, `${gameId}/plain`);
  const baseline = instantiate(plainBytes, definition, `${gameId}/plain`);
  const trace = traceFor(definition);
  if (optionalSeed) {
    const fresh = compileDetailed(sourceText).wasm;
    const production = instantiate(fresh, definition, `${gameId}/fresh-production`);
    input.seedParity = inputsEqualTrace(trace, `${gameId}/seed-vs-fresh-production`, production, baseline);
  }
  const candidates = [];
  for (const profile of profiles) {
    const effectiveProfile = optionalSeed && profile.id === 'plain'
      ? {...profile, id: 'seed', label: 'existing selected Oz seed', kind: 'seed'}
      : profile;
    let bytes;
    if (profile.kind === 'plain') {
      bytes = plainBytes;
    } else {
      const inputPath = join(gameRoot, `${definition.stem}.${effectiveProfile.id}.input.wasm`);
      const outputPath = join(gameRoot, `${definition.stem}.${effectiveProfile.id}.wasm`);
      await writeFile(inputPath, plainBytes);
      assertNoForbiddenFlags(effectiveProfile.flags, `${gameId}/${effectiveProfile.id}`);
      run(tools.wasmOpt, [inputPath, ...effectiveProfile.flags, '-o', outputPath], `${gameId}/${effectiveProfile.id} wasm-opt`);
      bytes = new Uint8Array(await readFile(outputPath));
      await rm(inputPath, {force: true});
    }
    const candidate = await packageCandidate({definition, profile: effectiveProfile, bytes, gameRoot, python: tools.python});
    const runtime = instantiate(bytes, definition, `${gameId}/${effectiveProfile.id}`);
    candidate.pages = runtime.pages;
    candidate.memoryBytes = runtime.memoryBytes;
    assert.deepEqual(candidate.metadata.imports, baselineMeta.imports, `${gameId}/${effectiveProfile.id}: imports differ from plain`);
    assert.deepEqual(candidate.metadata.exports, baselineMeta.exports, `${gameId}/${effectiveProfile.id}: exports differ from plain`);
    assert.equal(candidate.pages, baseline.pages, `${gameId}/${effectiveProfile.id}: pages differ from plain`);
    if (profile.kind === 'plain') {
      candidate.parity = {
        passed: true,
        ticks: trace.inputs.length,
        pointerTicks: trace.pointerTicks,
        keyboardTicks: trace.keyboardTicks,
        description: trace.description,
        baseline: 'self',
      };
    } else {
      candidate.parity = inputsEqualTrace(trace, `${gameId}/${profile.id}`, baseline, runtime);
      candidate.parity.baseline = 'plain';
    }
    candidates.push(candidate);
  }

  const packageChoices = candidates.flatMap((candidate, index) => ['embedded', 'external'].map((layout) => ({
    candidate,
    index,
    layout,
    ...candidate.packages[layout],
  })));
  packageChoices.sort((left, right) => left.zipBytes - right.zipBytes || left.index - right.index || left.layout.localeCompare(right.layout));
  const selected = packageChoices[0];
  assert.ok(selected, `${gameId}: no package candidates`);
  const selectedWasmPath = join(gameRoot, `${definition.stem}.wasm`);
  const selectedHtmlPath = join(gameRoot, `${definition.stem}.html`);
  const selectedZipPath = join(gameRoot, `${definition.stem}.zip`);
  await copyFile(selected.candidate.wasmPath, selectedWasmPath);
  await writeFile(selectedHtmlPath, selected.candidate.htmls[selected.layout]);
  await copyFile(join(gameRoot, selected.archive), selectedZipPath);
  const selectedWatPath = join(gameRoot, `${definition.stem}.wat`);
  run(tools.wasmDis, [selectedWasmPath, '-o', selectedWatPath], `${gameId} wasm-dis`);
  const selectedWat = await readFile(selectedWatPath, 'utf8');
  assert.ok(selectedWat.includes('(module'), `${gameId}: selected WAT is not a module`);

  return {
    id: gameId,
    game: definition.id,
    stem: definition.stem,
    title: definition.title,
    keyboardOnly: definition.keyboardOnly,
    input,
    trace: {
      ticks: trace.inputs.length,
      pointerTicks: trace.pointerTicks,
      keyboardTicks: trace.keyboardTicks,
      description: trace.description,
    },
    selected: {
      candidate: selected.candidate.id,
      layout: selected.layout,
      zipBytes: selected.zipBytes,
      remainingFromBudget: budget - selected.zipBytes,
      wasm: `${definition.stem}.wasm`,
      wat: `${definition.stem}.wat`,
      html: `${definition.stem}.html`,
      zip: `${definition.stem}.zip`,
    },
    baseline: {
      imports: baselineMeta.imports,
      exports: baselineMeta.exports,
      memoryPages: baseline.pages,
      memoryBytes: baseline.memoryBytes,
      rawWasmBytes: plainBytes.byteLength,
      deflateWasmBytes: deflateRawSync(plainBytes, {level: 9}).byteLength,
    },
    candidates: candidates.map((candidate) => ({
      ...candidateSummary(candidate, gameId),
      parity: candidate.parity,
    })),
  };
}

async function main() {
  await mkdir(outputParent, {recursive: true});
  const wasmOpt = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  if (!wasmOpt) throw new Error('wasm-opt is required; set SLIM_WASM_OPT or put wasm-opt on PATH');
  const wasmDis = configuredExecutable('wasm-dis', process.env.SLIM_WASM_DIS, wasmOpt);
  if (!wasmDis) throw new Error('wasm-dis is required; set SLIM_WASM_DIS or put wasm-dis beside wasm-opt/on PATH');
  const python = process.env.SLIM_PYTHON || 'python';
  const version = run(wasmOpt, ['--version'], 'wasm-opt version').stdout.trim();
  const help = run(wasmOpt, ['--help'], 'wasm-opt help').stdout;
  const profiles = makeProfiles(help);
  if (profiles.length < 5) throw new Error(`optimizer grid unexpectedly contains only ${profiles.length} profiles`);
  const optionalLoop = await loadOptionalLoopProfile();
  const staging = await mkdtemp(join(outputParent, '.wasm-opt-study-staging-'));
  let committed = false;
  try {
    const games = [];
    for (const definition of sourceDefinitions) {
      const sourceText = (await readFile(definition.sourcePath, 'utf8')).replace(/\r\n/g, '\n');
      games.push(await runDefinition({definition, sourceText, profiles, tools: {wasmOpt, wasmDis, python}, staging}));
      if (definition.id === 'blockbound' && optionalLoop) {
        games.push(await runDefinition({
          definition,
          sourceText,
          profiles,
          tools: {wasmOpt, wasmDis, python},
          staging,
          optionalSeed: optionalLoop,
        }));
      }
    }
    const report = {
      version: 1,
      reproducibleCommand: 'node tools/compare-wasm-opt.mjs',
      node: process.version,
      platform: process.platform,
      binaryen: {
        wasmOpt,
        wasmDis,
        version,
        commonStripFlags,
        supportedRequestedFlags: {
          converge: helpHas(help, '--converge'),
          shrinkLevel: helpHas(help, '--shrink-level'),
          safePasses: safePasses.filter((pass) => helpHas(help, pass)),
        },
      },
      safety: {
        semanticChanges: false,
        forbiddenFlags,
        note: 'No fast-math, trap-relaxing, memory-assumption, or import/export-minifying flags are used.',
      },
      budget,
      packaging: {
        host: 'src/host.mjs makeHtml, minifyHtml, tools/zip.py',
        minified: true,
        layouts: ['embedded', 'external'],
        externalArchiveEntries: ['index.html', 'source-named.wasm'],
        compression: 'ZIP_DEFLATED level 9; deflateWasmBytes is Node raw-DEFLATE size and zipWasmDeflateBytes is the exact ZIP entry size',
        keyboardOnly: {blockbound: true, rainbow: false},
      },
      traces: {
        blockbound: 'winningReplay plus restart/right-held loss/restart, 1706 ticks',
        rainbow: 'deterministic pointer/keyboard mixed fixture, at least 600 ticks',
        comparison: 'actual WebAssembly imports e.input/e.tri/e.sound; exact per-tick deepEqual callback arrays',
      },
      optionalMemoryLoop: optionalLoop ? {
        included: true,
        source: optionalLoop.modulePath,
        sourceReport: optionalLoop.reportPath,
        note: 'The existing array-study selected loop module is an Oz seed because compare-enemy-arrays does not expose its fresh plain module. It remains optional and is checked against fresh production Blockbound callbacks.',
      } : {
        included: false,
        note: 'No array-study loop-memory selected module/report was present; production Rainbow and Blockbound remain mandatory.',
      },
      games,
    };
    await writeFile(join(staging, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    const target = safeRelativePath(outputRoot);
    if (resolve(staging) === target || resolve(staging).startsWith(`${target}${sep}`)) {
      throw new Error('staging path unexpectedly overlaps final output path');
    }
    await rm(target, {recursive: true, force: true});
    await rename(staging, target);
    committed = true;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (!committed) {
      const target = resolve(staging);
      const parent = resolve(outputParent);
      if (!target.startsWith(`${parent}${sep}`)) throw new Error(`refusing to remove staging outside ${parent}`);
      await rm(target, {recursive: true, force: true});
    }
  }
}

await main();
