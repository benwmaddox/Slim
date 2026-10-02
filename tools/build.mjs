import {existsSync} from 'node:fs';
import {readFile, writeFile, mkdir, stat, rm, mkdtemp, copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {delimiter, dirname, extname, basename, join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {makeHtml, makeJavaScriptHtml} from '../src/host.mjs';
import {minifyHtml} from './minify.mjs';
import {stagedSearch} from './search.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budget = 13312;

function usage() {
  console.log('Usage: node tools/build.mjs [source.slim] [--out-dir DIR] [--check] [--compare-f32] [--keyboard-only] [--release] [--search staged|exhaustive] [--pack-triangles NAME] [--sound-packing none|numbers|bytes|auto] [--integer-arrays f32|compact|auto] [--title TEXT] [--footer TEXT]');
}

const SOUND_PACKING_MODES = ['none', 'numbers', 'bytes'];
const SOUND_PACKING_RANK = new Map(SOUND_PACKING_MODES.map((mode, index) => [mode, index]));
const INTEGER_ARRAY_STORAGE_MODES = ['f32', 'compact'];
const INTEGER_ARRAY_STORAGE_RANK = new Map(INTEGER_ARRAY_STORAGE_MODES.map((mode, index) => [mode, index]));

function parsePackedTriangleNames(value) {
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (!names.length || names.some((name) => name.startsWith('-'))) {
    throw new Error('--pack-triangles requires an array name');
  }
  return names;
}

function parseArgs(argv) {
  let source;
  let outDir;
  let check = false;
  let compareF32 = false;
  let keyboardOnly = false;
  let release = false;
  let search;
  let soundPacking;
  let integerArrayStorage;
  let title;
  let footer;
  const packedTriangleArrays = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    if (argument === '--check') {
      check = true;
      continue;
    }
    if (argument === '--compare-f32') {
      compareF32 = true;
      continue;
    }
    if (argument === '--keyboard-only') {
      keyboardOnly = true;
      continue;
    }
    if (argument === '--release') {
      release = true;
      continue;
    }
    if (argument === '--search' || argument.startsWith('--search=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--search requires staged or exhaustive');
      if (value !== 'staged' && value !== 'exhaustive') {
        throw new Error(`--search must be staged or exhaustive (got ${JSON.stringify(value)})`);
      }
      search = value;
      continue;
    }
    if (argument === '--pack-triangles' || argument.startsWith('--pack-triangles=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('-')) throw new Error('--pack-triangles requires an array name');
      packedTriangleArrays.push(...parsePackedTriangleNames(value));
      continue;
    }
    if (argument === '--sound-packing' || argument.startsWith('--sound-packing=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('-')) {
        throw new Error('--sound-packing requires none, numbers, bytes, or auto');
      }
      if (value !== 'auto' && !SOUND_PACKING_RANK.has(value)) {
        throw new Error(`--sound-packing must be one of none, numbers, bytes, or auto (got ${JSON.stringify(value)})`);
      }
      soundPacking = value;
      continue;
    }
    if (argument === '--integer-arrays' || argument.startsWith('--integer-arrays=')) {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('-')) {
        throw new Error('--integer-arrays requires f32, compact, or auto');
      }
      if (value !== 'auto' && !INTEGER_ARRAY_STORAGE_RANK.has(value)) {
        throw new Error(`--integer-arrays must be one of f32, compact, or auto (got ${JSON.stringify(value)})`);
      }
      integerArrayStorage = value;
      continue;
    }
    if (argument === '--title' || argument.startsWith('--title=')) {
      title = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!title) throw new Error('--title requires text');
      continue;
    }
    if (argument === '--footer' || argument.startsWith('--footer=')) {
      footer = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!footer) throw new Error('--footer requires text');
      continue;
    }
    if (argument === '--out-dir' || argument.startsWith('--out-dir=')) {
      outDir = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!outDir) throw new Error('--out-dir requires a directory');
      continue;
    }
    if (argument === '--source' || argument.startsWith('--source=')) {
      source = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!source) throw new Error('--source requires a .slim file');
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`unknown option ${argument}`);
    if (source) throw new Error(`unexpected extra source argument ${argument}`);
    source = argument;
  }
  return {
    source: resolve(root, source || 'examples/rainbow.slim'),
    output: resolve(root, outDir || 'dist'),
    check,
    compareF32,
    keyboardOnly,
    release,
    search: search ?? (release ? 'staged' : 'exhaustive'),
    soundPacking: soundPacking ?? (release ? 'auto' : 'none'),
    integerArrayStorage: integerArrayStorage ?? (release ? 'auto' : 'f32'),
    packedTriangleArrays: [...new Set(packedTriangleArrays)],
    title,
    footer,
  };
}

// A game names its own page title and control hint with comment lines such as
// `// title: Crate Shift` and `// footer: Arrows: move`. Each `// text: ...`
// line becomes `<template id=t0>`, `t1`, ... for the `text` builtin. The command line
// options override title and footer, and the host supplies defaults when neither is given.
function pageText(sourceText, stem, options = {}) {
  const meta = {};
  const texts = [];
  for (const match of sourceText.matchAll(/^[ \t]*\/\/[ \t]*(title|footer|text):[ \t]*(.*?)[ \t]*\r?$/gm)) {
    if (match[1] === 'text') texts.push(match[2]);
    else if (match[2] && !(match[1] in meta)) meta[match[1]] = match[2];
  }
  return {
    title: options.title ?? meta.title ?? titleFor(stem),
    footer: options.footer ?? meta.footer,
    texts,
  };
}

function safeStem(source) {
  const raw = basename(source, extname(source));
  const stem = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return stem || 'game';
}

function titleFor(stem) {
  const words = stem.split(/[-_]+/).filter(Boolean);
  return words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') : 'Slim';
}

function pathExecutable(name) {
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of pathExts) {
      const candidate = join(directory, name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function configuredExecutable(name, configured, siblingOf) {
  if (configured) return configured;
  if (siblingOf && (siblingOf.includes('\\') || siblingOf.includes('/'))) {
    const directory = dirname(siblingOf);
    const sibling = join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
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

async function writeArchive({python, zipTool, output, stem, html, wasm}) {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-package-'));
  try {
    await writeFile(join(temporary, 'index.html'), html);
    const entries = ['index.html'];
    if (wasm) {
      await writeFile(join(temporary, `${stem}.wasm`), wasm);
      entries.push(`${stem}.wasm`);
    }
    run(python, [zipTool, temporary, output, ...entries], 'ZIP packaging');
    return (await stat(output)).size;
  } finally {
    const tempRoot = resolve(tmpdir());
    const target = resolve(temporary);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove archive staging path outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

function candidateSummary(candidate) {
  return {
    id: candidate.id,
    backend: candidate.backend,
    precision: candidate.precision,
    optimization: candidate.optimization,
    layout: candidate.layout,
    minified: candidate.minified,
    triangleVariant: candidate.triangleVariant ?? null,
    packedTriangleArrays: [...(candidate.packedTriangleArrays ?? [])],
    soundPacking: candidate.soundPacking ?? 'none',
    integerArrayStorage: candidate.integerArrayStorage ?? null,
    wasmBytes: candidate.wasmBytes,
    htmlBytes: candidate.htmlBytes,
    zipBytes: candidate.zipBytes,
    archive: candidate.reportArchive ?? null,
  };
}

function compilerSummary(detailed, packedTriangleArrays) {
  return {
    packedTriangleArrays: [...packedTriangleArrays],
    integerArrayStorage: detailed.integerArrayStorage ?? 'f32',
    globalStorage: detailed.globalStorage,
    globals: detailed.globals,
    memoryPages: detailed.memoryPages,
    allocatedBytes: detailed.allocatedBytes,
    ...(detailed.globalLayout ? {globalLayout: detailed.globalLayout} : {}),
    arrayLayout: (detailed.arrayLayout ?? []).map(({values, ...layout}) => layout),
  };
}

function soundModesFor(imports, requested) {
  if (!imports.includes('sound')) return ['none'];
  return requested === 'auto' ? SOUND_PACKING_MODES.slice() : [requested];
}

function integerArrayStorageModes(requested) {
  return requested === 'auto' ? INTEGER_ARRAY_STORAGE_MODES.slice() : [requested];
}

function integerArrayStorageFor(detailed, fallback) {
  return detailed.integerArrayStorage ?? fallback;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function candidateCompare(a, b) {
  return a.zipBytes - b.zipBytes
    || (SOUND_PACKING_RANK.get(a.soundPacking ?? 'none') ?? 0)
      - (SOUND_PACKING_RANK.get(b.soundPacking ?? 'none') ?? 0)
    || (a.packedTriangleArrays?.length ?? 0) - (b.packedTriangleArrays?.length ?? 0)
    || (INTEGER_ARRAY_STORAGE_RANK.get(a.integerArrayStorage ?? 'f32') ?? 0)
      - (INTEGER_ARRAY_STORAGE_RANK.get(b.integerArrayStorage ?? 'f32') ?? 0)
    || a.id.localeCompare(b.id);
}

function obsoleteArtifacts(stem, compareF32) {
  const wasmCandidates = [
    'plain-embedded',
    'plain-embedded-min',
    'plain-external',
    'plain-external-min',
    'Oz-embedded',
    'Oz-embedded-min',
    'Oz-external',
    'Oz-external-min',
  ];
  const javascriptCandidates = ['js-unminified', 'js-min', 'f32-unminified', 'f32-min'];
  const artifacts = [
    `${stem}.plain.wasm`,
    `${stem}.Oz.wasm`,
    ...wasmCandidates.map((id) => `${stem}.${id}.zip`),
    ...javascriptCandidates.map((id) => `${stem}.${id}.zip`),
  ];
  if (!compareF32) artifacts.push(`${stem}.f32.js`, `${stem}.f32.html`, `${stem}.f32.zip`);
  return artifacts;
}

async function removeObsoleteArtifacts(output, stem, compareF32) {
  for (const name of obsoleteArtifacts(stem, compareF32)) await rm(join(output, name), {force: true});
}

function finalArchiveFor(candidate, stem, bestWasm, bestJs, bestF32) {
  if (candidate === bestWasm) return `${stem}.zip`;
  if (candidate === bestJs) return `${stem}.js.zip`;
  if (candidate === bestF32) return `${stem}.f32.zip`;
  return null;
}

async function finishBuild({options, sourceText, staging, stem, title, python, zipTool, optimizer, records, skippedCandidates, searchStages}) {
  const select = (items) => items.slice().sort(candidateCompare)[0];
  const {footer, texts} = pageText(sourceText, stem, options);
  const profiles = [{name: 'js', precision: 'native'}];
  if (options.compareF32) profiles.push({name: 'f32', precision: 'f32'});
  for (const profile of profiles) {
    const result = compileJavaScript(sourceText, {precision: profile.precision});
    if (result.precision !== profile.precision) throw new Error(`JavaScript backend returned ${result.precision} for ${profile.precision}`);
    const soundModes = soundModesFor(result.imports, options.soundPacking);
    for (const soundPacking of soundModes) {
      const unminified = makeJavaScriptHtml(result.code, {
        title,
        imports: result.imports,
        keyboardOnly: options.keyboardOnly,
        soundPacking,
        footer,
        texts,
      });
      const htmlVariants = [
        {suffix: '', html: unminified, minified: false},
        {suffix: '-min', html: await minifyHtml(unminified), minified: true},
      ];
      for (const htmlVariant of htmlVariants) {
        const id = options.release || options.soundPacking !== 'none'
          ? `${profile.name}-${soundPacking}${htmlVariant.suffix}`
          : htmlVariant.minified ? `${profile.name}-min` : `${profile.name}-unminified`;
        const archive = `${stem}.${id}.zip`;
        const archivePath = join(staging, archive);
        const zipBytes = await writeArchive({python, zipTool, output: archivePath, stem, html: htmlVariant.html});
        records.push({
          id,
          backend: 'js',
          precision: result.precision,
          optimization: htmlVariant.minified ? 'terser' : 'none',
          layout: 'inline',
          minified: htmlVariant.minified,
          triangleVariant: null,
          packedTriangleArrays: [],
          soundPacking,
          integerArrayStorage: null,
          wasmBytes: null,
          htmlBytes: Buffer.byteLength(htmlVariant.html),
          zipBytes,
          archive,
          code: result.code,
          html: htmlVariant.html,
        });
      }
    }
  }

  const bestWasm = select(records.filter((candidate) => candidate.backend === 'wasm'));
  const bestJs = select(records.filter((candidate) => candidate.backend === 'js' && candidate.precision === 'native'));
  const bestF32 = options.compareF32 ? select(records.filter((candidate) => candidate.backend === 'js' && candidate.precision === 'f32')) : null;
  const bestOverall = select(records);
  if (!bestWasm || !bestJs || (options.compareF32 && !bestF32)) throw new Error('Build produced no complete backend candidates');

  const wasmPath = join(staging, `${stem}.wasm`);
  await writeFile(wasmPath, bestWasm.bytes);
  await writeFile(join(staging, `${stem}.html`), bestWasm.html);
  await copyFile(join(staging, bestWasm.archive), join(staging, `${stem}.zip`));
  await writeFile(join(staging, `${stem}.js`), bestJs.code);
  await writeFile(join(staging, `${stem}.js.html`), bestJs.html);
  await copyFile(join(staging, bestJs.archive), join(staging, `${stem}.js.zip`));
  if (bestF32) {
    await writeFile(join(staging, `${stem}.f32.js`), bestF32.code);
    await writeFile(join(staging, `${stem}.f32.html`), bestF32.html);
    await copyFile(join(staging, bestF32.archive), join(staging, `${stem}.f32.zip`));
  }

  const wasmDis = configuredExecutable('wasm-dis', process.env.SLIM_WASM_DIS, optimizer);
  if (!wasmDis) throw new Error('wasm-dis is required to write the selected WAT artifact; set SLIM_WASM_DIS or add wasm-dis to PATH');
  const watPath = join(staging, `${stem}.wat`);
  run(wasmDis, [wasmPath, '-o', watPath], 'wasm-dis');
  const wat = await readFile(watPath, 'utf8');
  if (!wat.includes('(module')) throw new Error('wasm-dis did not emit a module WAT artifact');

  const artifacts = {
    wasm: `${stem}.wasm`,
    wat: `${stem}.wat`,
    html: `${stem}.html`,
    js: `${stem}.js`,
    jsHtml: `${stem}.js.html`,
    jsZip: `${stem}.js.zip`,
    zip: `${stem}.zip`,
  };
  if (bestF32) Object.assign(artifacts, {
    f32Js: `${stem}.f32.js`,
    f32Html: `${stem}.f32.html`,
    f32Zip: `${stem}.f32.zip`,
  });
  const report = {
    version: 6,
    release: options.release,
    search: options.search,
    source: basename(options.source),
    stem,
    title,
    keyboardOnly: options.keyboardOnly,
    soundPacking: options.soundPacking,
    integerArrayStorage: options.integerArrayStorage,
    requestedPackedTriangleArrays: options.packedTriangleArrays.slice(),
    packedTriangleArrays: bestWasm.packedTriangleArrays.slice(),
    compiler: compilerSummary(bestWasm.detailed, bestWasm.packedTriangleArrays),
    budget,
    selected: bestWasm.id,
    selectedWasm: candidateSummary({...bestWasm, reportArchive: `${stem}.zip`}),
    selectedJs: candidateSummary({...bestJs, reportArchive: `${stem}.js.zip`}),
    selectedF32: bestF32 ? candidateSummary({...bestF32, reportArchive: `${stem}.f32.zip`}) : null,
    selectedOverall: candidateSummary({...bestOverall, reportArchive: finalArchiveFor(bestOverall, stem, bestWasm, bestJs, bestF32)}),
    layout: bestWasm.layout,
    zipBytes: bestWasm.zipBytes,
    remaining: budget - bestWasm.zipBytes,
    artifacts,
    skippedCandidates,
    searchStages: searchStages.map(({pass, axis, before, after, trials}) => ({
      pass,
      axis,
      before: before?.id ?? null,
      selected: after.id,
      zipBytes: after.zipBytes,
      savedBytes: before ? before.zipBytes - after.zipBytes : 0,
      tried: trials.map((candidate) => candidate.id),
    })),
    candidates: records.map((candidate) => candidateSummary({
      ...candidate,
      reportArchive: finalArchiveFor(candidate, stem, bestWasm, bestJs, bestF32),
    })),
  };
  await writeFile(join(staging, `${stem}.size.json`), `${JSON.stringify(report, null, 2)}\n`);

  const finalNames = [
    `${stem}.wasm`,
    `${stem}.wat`,
    `${stem}.html`,
    `${stem}.size.json`,
    `${stem}.js`,
    `${stem}.js.html`,
    `${stem}.js.zip`,
    `${stem}.zip`,
  ];
  if (bestF32) finalNames.splice(7, 0, `${stem}.f32.js`, `${stem}.f32.html`, `${stem}.f32.zip`);
  await mkdir(options.output, {recursive: true});
  for (const name of finalNames) await copyFile(join(staging, name), join(options.output, name));
  await removeObsoleteArtifacts(options.output, stem, options.compareF32);
  console.log(JSON.stringify(report, null, 2));
  if (bestWasm.zipBytes > budget) process.exitCode = 1;
  if (options.check && process.exitCode) throw new Error('Selected WASM package exceeds the size budget');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceText = await readFile(options.source, 'utf8');

  const staging = await mkdtemp(join(tmpdir(), 'slim-build-'));
  try {
    await (options.search === 'staged'
      ? buildInStagingStaged(options, sourceText, staging)
      : buildInStaging(options, sourceText, staging));
  } finally {
    const tempRoot = resolve(tmpdir());
    const target = resolve(staging);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove build staging path outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

async function buildInStagingStaged(options, sourceText, staging) {
  const stem = safeStem(options.source);
  const {title, footer, texts} = pageText(sourceText, stem, options);
  const python = process.env.SLIM_PYTHON || 'python';
  const zipTool = resolve(root, 'tools/zip.py');
  const records = [];
  const requestedPackedTriangleArrays = options.packedTriangleArrays.slice();
  const skippedCandidates = [];
  const integerStorageModes = integerArrayStorageModes(options.integerArrayStorage);

  const compileTriangleVariant = (name, packedTriangleArrays) => {
    const compilerOptions = (integerArrayStorage) => ({
      integerArrayStorage,
      ...(packedTriangleArrays.length ? {packedTriangleArrays} : {}),
    });
    const storageVariants = [];
    let f32Detailed;
    for (const integerArrayStorage of integerStorageModes) {
      let detailed;
      try {
        detailed = compileDetailed(sourceText, compilerOptions(integerArrayStorage));
        if (!WebAssembly.validate(detailed.wasm)) throw new Error('Compiler emitted invalid WASM');
      } catch (error) {
        if (packedTriangleArrays.length && error?.code === 'SLIM_PACKING_UNSUPPORTED' && options.release) {
          skippedCandidates.push({
            kind: 'triangles',
            packedTriangleArrays: packedTriangleArrays.slice(),
            reason: error.message,
          });
          return null;
        }
        throw error;
      }

      const actualStorage = integerArrayStorageFor(detailed, integerArrayStorage);
      if (integerArrayStorage === 'f32') f32Detailed = detailed;
      if (options.integerArrayStorage === 'auto' && integerArrayStorage === 'compact' && f32Detailed && bytesEqual(f32Detailed.wasm, detailed.wasm)) {
        skippedCandidates.push({
          kind: 'integer-arrays',
          triangleVariant: name,
          packedTriangleArrays: packedTriangleArrays.slice(),
          integerArrayStorage,
          reason: 'compact compiler result is byte-identical to the f32 result',
        });
        continue;
      }
      storageVariants.push({integerArrayStorage: actualStorage, detailed});
    }
    return {name, packedTriangleArrays: packedTriangleArrays.slice(), storageVariants};
  };

  // Compile all cheap source variants before searching so invalid packed
  // targets and unsupported structured packing fail before any output copy.
  const triangleVariants = [];
  if (options.release) {
    const unpacked = compileTriangleVariant('unpacked', []);
    if (unpacked) triangleVariants.push(unpacked);
    if (requestedPackedTriangleArrays.length) {
      const packed = compileTriangleVariant('packed', requestedPackedTriangleArrays);
      if (packed) triangleVariants.push(packed);
    }
  } else {
    const name = requestedPackedTriangleArrays.length ? 'packed' : 'unpacked';
    const variant = compileTriangleVariant(name, requestedPackedTriangleArrays);
    if (variant) triangleVariants.push(variant);
  }

  const optimizer = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  if (!optimizer && process.env.SLIM_WASM_OPT) {
    throw new Error(`Configured wasm-opt was not found: ${process.env.SLIM_WASM_OPT}`);
  }
  const allOptimizerProfiles = [
    {name: 'plain', flags: null},
    {name: 'Oz', flags: ['-Oz']},
    {name: 'Os', flags: ['-Os']},
    {name: 'O4', flags: ['-O4']},
    {name: 'Oz-converge', flags: ['-Oz', '--converge']},
  ];
  const optimizerProfiles = optimizer ? allOptimizerProfiles : allOptimizerProfiles.slice(0, 1);

  const variants = [];
  for (const triangleVariant of triangleVariants) {
    for (const storageVariant of triangleVariant.storageVariants) {
      const integerArrayStorage = storageVariant.integerArrayStorage;
      const variantStem = options.release
        ? `release-${triangleVariant.name}-${integerArrayStorage}`
        : integerArrayStorage === 'f32'
          ? triangleVariant.name
          : `${triangleVariant.name}-${integerArrayStorage}`;
      const plainPath = join(staging, `${stem}.${variantStem}.plain.wasm`);
      await writeFile(plainPath, storageVariant.detailed.wasm);
      variants.push({
        triangleVariant: triangleVariant.name,
        packedTriangleArrays: triangleVariant.packedTriangleArrays.slice(),
        integerArrayStorage,
        detailed: storageVariant.detailed,
        plainPath,
        variantStem,
      });
    }
  }
  const variantFor = (triangleVariant, integerArrayStorage) => variants.find((variant) => (
    variant.triangleVariant === triangleVariant && variant.integerArrayStorage === integerArrayStorage
  ));
  const triangleNames = [...new Set(variants.map((variant) => variant.triangleVariant))];
  const storageNamesFor = (triangleVariant) => [...new Set(variants
    .filter((variant) => variant.triangleVariant === triangleVariant)
    .map((variant) => variant.integerArrayStorage))];
  const optimizerByName = new Map(optimizerProfiles.map((profile) => [profile.name, profile]));
  const optimizerCache = new Map();

  async function getWasmModule(variant, optimization) {
    const profile = optimizerByName.get(optimization);
    if (!profile) throw new Error(`Unknown WASM optimization profile ${JSON.stringify(optimization)}`);
    const key = `${variant.triangleVariant}\u0000${variant.integerArrayStorage}\u0000${profile.name}`;
    const cached = optimizerCache.get(key);
    if (cached) return cached;
    if (profile.name === 'plain') {
      const module = {
        name: profile.name,
        bytes: variant.detailed.wasm,
        detailed: variant.detailed,
        triangleVariant: variant.triangleVariant,
        packedTriangleArrays: variant.packedTriangleArrays,
        integerArrayStorage: variant.integerArrayStorage,
      };
      optimizerCache.set(key, module);
      return module;
    }
    if (!optimizer) throw new Error(`WASM optimization profile ${profile.name} is unavailable`);
    const optimizedPath = join(staging, `${stem}.${variant.variantStem}.${profile.name}.wasm`);
    const result = spawnSync(optimizer, [variant.plainPath, ...profile.flags, '--strip-debug', '--strip-producers', '-o', optimizedPath], {encoding: 'utf8', windowsHide: true});
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
      throw new Error(`${process.env.SLIM_WASM_OPT ? 'Configured ' : ''}wasm-opt ${profile.name} failed: ${detail}`);
    }
    const bytes = await readFile(optimizedPath);
    if (!WebAssembly.validate(bytes)) throw new Error('wasm-opt emitted invalid WASM');
    const module = {
      name: profile.name,
      bytes,
      detailed: variant.detailed,
      triangleVariant: variant.triangleVariant,
      packedTriangleArrays: variant.packedTriangleArrays,
      integerArrayStorage: variant.integerArrayStorage,
    };
    optimizerCache.set(key, module);
    return module;
  }

  const select = (items) => items.slice().sort(candidateCompare)[0];
  const stateCache = new Map();

  function wasmCandidateId(settings, module, minified) {
    const suffix = minified ? '-min' : '';
    const triangleVariant = settings.triangles ?? settings.triangleVariant;
    const integerArrayStorage = settings['integer-arrays'] ?? settings.integerArrayStorage;
    const soundPacking = settings.sound ?? settings.soundPacking;
    if (options.release) {
      return `${triangleVariant}-${integerArrayStorage}-${module.name}-${settings.layout}-${soundPacking}${suffix}`;
    }
    return (integerArrayStorage === 'f32' ? '' : `${integerArrayStorage}-`) +
      (options.soundPacking === 'none'
        ? `${module.name}-${settings.layout}${suffix}`
        : `${module.name}-${settings.layout}-${soundPacking}${suffix}`);
  }

  async function evaluateWasm(settings) {
    const triangleVariant = settings.triangles ?? settings.triangleVariant;
    let integerArrayStorage = settings['integer-arrays'] ?? settings.integerArrayStorage;
    const soundPacking = settings.sound ?? settings.soundPacking;
    let variant = variantFor(triangleVariant, integerArrayStorage);
    // Auto integer storage may have omitted a compact candidate because its
    // bytes were identical to f32 for this geometry.  Treat that request as
    // the already-normalized f32 variant when a later geometry transition
    // reaches the omitted state.
    if (!variant && options.integerArrayStorage === 'auto' && integerArrayStorage === 'compact') {
      integerArrayStorage = 'f32';
      variant = variantFor(triangleVariant, integerArrayStorage);
    }
    if (!variant) {
      throw new Error(`No compiled WASM variant for ${JSON.stringify({
        triangleVariant,
        integerArrayStorage,
      })}`);
    }
    const profile = optimizerByName.get(settings.optimization);
    if (!profile) throw new Error(`Unknown WASM optimization profile ${JSON.stringify(settings.optimization)}`);
    const soundModes = soundModesFor(variant.detailed.imports, options.soundPacking);
    if (!soundModes.includes(soundPacking)) {
      throw new Error(`Sound packing ${JSON.stringify(soundPacking)} is unavailable for this WASM module`);
    }
    const stateKey = [
      variant.triangleVariant,
      variant.integerArrayStorage,
      profile.name,
      settings.layout,
      soundPacking,
    ].join('\u0000');
    const cached = stateCache.get(stateKey);
    if (cached) return cached;

    const module = await getWasmModule(variant, profile.name);
    const unminified = makeHtml(module.bytes, {
      title,
      keyboardOnly: options.keyboardOnly,
      soundPacking,
      footer,
      texts,
      ...(settings.layout === 'external' ? {wasmUrl: `${stem}.wasm`} : {}),
    });
    const htmlVariants = [
      {suffix: '', html: unminified, minified: false},
      {suffix: '-min', html: await minifyHtml(unminified), minified: true},
    ];
    const stateRecords = [];
    for (const htmlVariant of htmlVariants) {
      const id = wasmCandidateId({
        ...settings,
        triangles: variant.triangleVariant,
        'integer-arrays': variant.integerArrayStorage,
        sound: soundPacking,
      }, module, htmlVariant.minified);
      const archive = `${stem}.${id}.zip`;
      const archivePath = join(staging, archive);
      const zipBytes = await writeArchive({
        python,
        zipTool,
        output: archivePath,
        stem,
        html: htmlVariant.html,
        wasm: settings.layout === 'external' ? module.bytes : undefined,
      });
      const candidate = {
        id,
        backend: 'wasm',
        precision: 'f32',
        optimization: module.name,
        layout: settings.layout,
        minified: htmlVariant.minified,
        triangleVariant: variant.triangleVariant,
        packedTriangleArrays: variant.packedTriangleArrays.slice(),
        soundPacking,
        integerArrayStorage: variant.integerArrayStorage,
        triangles: variant.triangleVariant,
        'integer-arrays': variant.integerArrayStorage,
        sound: soundPacking,
        wasmBytes: module.bytes.length,
        htmlBytes: Buffer.byteLength(htmlVariant.html),
        zipBytes,
        archive,
        bytes: module.bytes,
        html: htmlVariant.html,
        detailed: module.detailed,
      };
      records.push(candidate);
      stateRecords.push(candidate);
    }
    const best = select(stateRecords);
    stateCache.set(stateKey, best);
    return best;
  }

  const initialTriangleName = options.release
    ? 'unpacked'
    : requestedPackedTriangleArrays.length ? 'packed' : 'unpacked';
  const initialTriangle = triangleNames.includes(initialTriangleName) ? initialTriangleName : triangleNames[0];
  const initialStorage = storageNamesFor(initialTriangle)[0];
  const initialVariant = variantFor(initialTriangle, initialStorage);
  if (!initialVariant) throw new Error('Build produced no complete WASM variants');
  const searchStages = [];
  const staged = await stagedSearch({
    initial: {
      optimization: optimizerProfiles[0].name,
      layout: 'external',
      triangles: initialTriangle,
      'integer-arrays': initialStorage,
      sound: soundModesFor(initialVariant.detailed.imports, options.soundPacking)[0],
    },
    axes: [
      {
        name: 'optimization',
        choices: (current) => optimizerProfiles
          .map((profile) => profile.name)
          .filter((name) => name !== current.optimization),
      },
      {
        name: 'layout',
        choices: (current) => ['external', 'embedded'].filter((layout) => layout !== current.layout),
      },
      {
        name: 'triangles',
        choices: (current) => triangleNames.filter((name) => name !== current.triangles),
      },
      {
        name: 'integer-arrays',
        choices: (current) => storageNamesFor(current.triangles)
          .filter((storage) => storage !== current['integer-arrays']),
      },
      {
        name: 'sound',
        choices: (current) => {
          let variant = variantFor(current.triangles, current['integer-arrays']);
          if (!variant && options.integerArrayStorage === 'auto' && current['integer-arrays'] === 'compact') {
            variant = variantFor(current.triangles, 'f32');
          }
          return soundModesFor(variant.detailed.imports, options.soundPacking)
            .filter((soundPacking) => soundPacking !== current.sound);
        },
      },
    ],
    evaluate: evaluateWasm,
    compare: candidateCompare,
    maxPasses: 2,
  });
  searchStages.push(...staged.stages);
  if (staged.best !== select(records)) {
    throw new Error('Staged winner differs from the best visited WASM candidate');
  }

  await finishBuild({
    options,
    sourceText,
    staging,
    stem,
    title,
    python,
    zipTool,
    optimizer,
    records,
    skippedCandidates,
    searchStages,
  });
}

async function buildInStaging(options, sourceText, staging) {
  const stem = safeStem(options.source);
  const {title, footer, texts} = pageText(sourceText, stem, options);
  const python = process.env.SLIM_PYTHON || 'python';
  const zipTool = resolve(root, 'tools/zip.py');
  const records = [];
  const requestedPackedTriangleArrays = options.packedTriangleArrays.slice();
  const skippedCandidates = [];

  const integerStorageModes = integerArrayStorageModes(options.integerArrayStorage);
  const compileTriangleVariant = (name, packedTriangleArrays) => {
    const compilerOptions = (integerArrayStorage) => ({
      integerArrayStorage,
      ...(packedTriangleArrays.length ? {packedTriangleArrays} : {}),
    });
    const storageVariants = [];
    let f32Detailed;
    for (const integerArrayStorage of integerStorageModes) {
      let detailed;
      try {
        detailed = compileDetailed(sourceText, compilerOptions(integerArrayStorage));
        if (!WebAssembly.validate(detailed.wasm)) throw new Error('Compiler emitted invalid WASM');
      } catch (error) {
        if (packedTriangleArrays.length && error?.code === 'SLIM_PACKING_UNSUPPORTED' && options.release) {
          skippedCandidates.push({
            kind: 'triangles',
            packedTriangleArrays: packedTriangleArrays.slice(),
            reason: error.message,
          });
          return null;
        }
        throw error;
      }

      const actualStorage = integerArrayStorageFor(detailed, integerArrayStorage);
      if (integerArrayStorage === 'f32') f32Detailed = detailed;
      if (options.integerArrayStorage === 'auto' && integerArrayStorage === 'compact' && f32Detailed && bytesEqual(f32Detailed.wasm, detailed.wasm)) {
        skippedCandidates.push({
          kind: 'integer-arrays',
          triangleVariant: name,
          packedTriangleArrays: packedTriangleArrays.slice(),
          integerArrayStorage,
          reason: 'compact compiler result is byte-identical to the f32 result',
        });
        continue;
      }
      storageVariants.push({integerArrayStorage: actualStorage, detailed});
    }
    return {name, packedTriangleArrays: packedTriangleArrays.slice(), storageVariants};
  };

  // Release builds retain an unpacked fallback and compare it with the
  // requested triangle packing.  Ordinary builds preserve their historical
  // forced-packing behavior when --pack-triangles is supplied.
  const triangleVariants = [];
  if (options.release) {
    const unpacked = compileTriangleVariant('unpacked', []);
    if (unpacked) triangleVariants.push(unpacked);
    if (requestedPackedTriangleArrays.length) {
      const packed = compileTriangleVariant('packed', requestedPackedTriangleArrays);
      if (packed) triangleVariants.push(packed);
    }
  } else {
    const name = requestedPackedTriangleArrays.length ? 'packed' : 'unpacked';
    const variant = compileTriangleVariant(name, requestedPackedTriangleArrays);
    if (variant) triangleVariants.push(variant);
  }

  const optimizer = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  if (!optimizer && process.env.SLIM_WASM_OPT) {
    throw new Error(`Configured wasm-opt was not found: ${process.env.SLIM_WASM_OPT}`);
  }

  const optimizerProfiles = [
    {name: 'plain', flags: null},
    {name: 'Oz', flags: ['-Oz']},
    {name: 'Os', flags: ['-Os']},
    {name: 'O4', flags: ['-O4']},
    {name: 'Oz-converge', flags: ['-Oz', '--converge']},
  ];
  for (const triangleVariant of triangleVariants) {
    for (const storageVariant of triangleVariant.storageVariants) {
      const integerArrayStorage = storageVariant.integerArrayStorage;
      const variantStem = options.release
        ? `release-${triangleVariant.name}-${integerArrayStorage}`
        : integerArrayStorage === 'f32'
          ? triangleVariant.name
          : `${triangleVariant.name}-${integerArrayStorage}`;
      const plainPath = join(staging, `${stem}.${variantStem}.plain.wasm`);
      await writeFile(plainPath, storageVariant.detailed.wasm);
      const wasmModules = [{
        name: 'plain',
        bytes: storageVariant.detailed.wasm,
        detailed: storageVariant.detailed,
        triangleVariant: triangleVariant.name,
        packedTriangleArrays: triangleVariant.packedTriangleArrays,
        integerArrayStorage,
      }];
      if (optimizer) {
        for (const {name, flags} of optimizerProfiles.slice(1)) {
          const optimizedPath = join(staging, `${stem}.${variantStem}.${name}.wasm`);
          const result = spawnSync(optimizer, [plainPath, ...flags, '--strip-debug', '--strip-producers', '-o', optimizedPath], {encoding: 'utf8', windowsHide: true});
          if (result.error || result.status !== 0) {
            const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
            throw new Error(`${process.env.SLIM_WASM_OPT ? 'Configured ' : ''}wasm-opt ${name} failed: ${detail}`);
          }
          const bytes = await readFile(optimizedPath);
          if (!WebAssembly.validate(bytes)) throw new Error('wasm-opt emitted invalid WASM');
          wasmModules.push({
            name,
            bytes,
            detailed: storageVariant.detailed,
            triangleVariant: triangleVariant.name,
            packedTriangleArrays: triangleVariant.packedTriangleArrays,
            integerArrayStorage,
          });
        }
      }

      for (const module of wasmModules) {
        const soundModes = soundModesFor(module.detailed.imports, options.soundPacking);
        for (const layout of ['embedded', 'external']) {
          for (const soundPacking of soundModes) {
            const unminified = makeHtml(module.bytes, {
              title,
              keyboardOnly: options.keyboardOnly,
              soundPacking,
              footer,
              texts,
              ...(layout === 'external' ? {wasmUrl: `${stem}.wasm`} : {}),
            });
            const variants = [
              {suffix: '', html: unminified, minified: false},
              {suffix: '-min', html: await minifyHtml(unminified), minified: true},
            ];
            for (const variant of variants) {
              const id = options.release
                ? `${triangleVariant.name}-${integerArrayStorage}-${module.name}-${layout}-${soundPacking}${variant.suffix}`
                : (integerArrayStorage === 'f32' ? '' : `${integerArrayStorage}-`) +
                  (options.soundPacking === 'none'
                    ? `${module.name}-${layout}${variant.suffix}`
                    : `${module.name}-${layout}-${soundPacking}${variant.suffix}`);
              const archive = `${stem}.${id}.zip`;
              const archivePath = join(staging, archive);
              const zipBytes = await writeArchive({
                python,
                zipTool,
                output: archivePath,
                stem,
                html: variant.html,
                wasm: layout === 'external' ? module.bytes : undefined,
              });
              records.push({
                id,
                backend: 'wasm',
                precision: 'f32',
                optimization: module.name,
                layout,
                minified: variant.minified,
                triangleVariant: triangleVariant.name,
                packedTriangleArrays: module.packedTriangleArrays.slice(),
                soundPacking,
                integerArrayStorage: module.integerArrayStorage,
                wasmBytes: module.bytes.length,
                htmlBytes: Buffer.byteLength(variant.html),
                zipBytes,
                archive,
                bytes: module.bytes,
                html: variant.html,
                detailed: module.detailed,
              });
            }
          }
        }
      }
    }
  }

  await finishBuild({
    options,
    sourceText,
    staging,
    stem,
    title,
    python,
    zipTool,
    optimizer,
    records,
    skippedCandidates,
    searchStages: [],
  });
}

await main();
