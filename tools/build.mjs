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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budget = 13312;

function usage() {
  console.log('Usage: node tools/build.mjs [source.slim] [--out-dir DIR] [--check] [--compare-f32]');
}

function parseArgs(argv) {
  let source;
  let outDir;
  let check = false;
  let compareF32 = false;
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
    wasmBytes: candidate.wasmBytes,
    htmlBytes: candidate.htmlBytes,
    zipBytes: candidate.zipBytes,
    archive: candidate.reportArchive ?? null,
  };
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceText = await readFile(options.source, 'utf8');
  await mkdir(options.output, {recursive: true});

  const staging = await mkdtemp(join(tmpdir(), 'slim-build-'));
  try {
    await buildInStaging(options, sourceText, staging);
  } finally {
    const tempRoot = resolve(tmpdir());
    const target = resolve(staging);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove build staging path outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

async function buildInStaging(options, sourceText, staging) {
  const stem = safeStem(options.source);
  const title = titleFor(stem);
  const python = process.env.SLIM_PYTHON || 'python';
  const zipTool = resolve(root, 'tools/zip.py');
  const records = [];
  const wasmModules = [];

  const detailed = compileDetailed(sourceText);
  const plainBytes = detailed.wasm;
  if (!WebAssembly.validate(plainBytes)) throw new Error('Compiler emitted invalid WASM');
  const plainPath = join(staging, `${stem}.plain.wasm`);
  await writeFile(plainPath, plainBytes);
  wasmModules.push({name: 'plain', bytes: plainBytes});

  const optimizer = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  if (optimizer) {
    const optimizedPath = join(staging, `${stem}.Oz.wasm`);
    const result = spawnSync(optimizer, [plainPath, '-Oz', '--strip-debug', '--strip-producers', '-o', optimizedPath], {encoding: 'utf8', windowsHide: true});
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
      throw new Error(`${process.env.SLIM_WASM_OPT ? 'Configured ' : ''}wasm-opt failed: ${detail}`);
    } else {
      const bytes = await readFile(optimizedPath);
      if (!WebAssembly.validate(bytes)) throw new Error('wasm-opt emitted invalid WASM');
      wasmModules.push({name: 'Oz', bytes});
    }
  } else if (process.env.SLIM_WASM_OPT) {
    throw new Error(`Configured wasm-opt was not found: ${process.env.SLIM_WASM_OPT}`);
  }

  for (const module of wasmModules) {
    for (const layout of ['embedded', 'external']) {
      const unminified = makeHtml(module.bytes, {
        title,
        ...(layout === 'external' ? {wasmUrl: `${stem}.wasm`} : {}),
      });
      const variants = [
        {suffix: '', html: unminified, minified: false},
        {suffix: '-min', html: await minifyHtml(unminified), minified: true},
      ];
      for (const variant of variants) {
        const id = `${module.name}-${layout}${variant.suffix}`;
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
          wasmBytes: module.bytes.length,
          htmlBytes: Buffer.byteLength(variant.html),
          zipBytes,
          archive,
          bytes: module.bytes,
          html: variant.html,
        });
      }
    }
  }

  const profiles = [{name: 'js', precision: 'native'}];
  if (options.compareF32) profiles.push({name: 'f32', precision: 'f32'});
  for (const profile of profiles) {
    const result = compileJavaScript(sourceText, {precision: profile.precision});
    if (result.precision !== profile.precision) throw new Error(`JavaScript backend returned ${result.precision} for ${profile.precision}`);
    const codeArtifact = profile.name === 'js' ? `${stem}.js` : `${stem}.f32.js`;
    await writeFile(join(staging, codeArtifact), result.code);
    const unminified = makeJavaScriptHtml(result.code, {title, imports: result.imports});
    const variants = [
      {suffix: '', html: unminified, minified: false},
      {suffix: '-min', html: await minifyHtml(unminified), minified: true},
    ];
    for (const variant of variants) {
      const id = variant.minified ? `${profile.name}-min` : `${profile.name}-unminified`;
      const archive = `${stem}.${id}.zip`;
      const archivePath = join(staging, archive);
      const zipBytes = await writeArchive({python, zipTool, output: archivePath, stem, html: variant.html});
      records.push({
        id,
        backend: 'js',
        precision: result.precision,
        optimization: variant.minified ? 'terser' : 'none',
        layout: 'inline',
        minified: variant.minified,
        wasmBytes: null,
        htmlBytes: Buffer.byteLength(variant.html),
        zipBytes,
        archive,
        code: result.code,
        html: variant.html,
      });
    }
  }

  const select = (items) => items.slice().sort((a, b) => a.zipBytes - b.zipBytes || a.id.localeCompare(b.id))[0];
  const bestWasm = select(records.filter((candidate) => candidate.backend === 'wasm'));
  const bestJs = select(records.filter((candidate) => candidate.backend === 'js' && candidate.precision === 'native'));
  const bestF32 = options.compareF32 ? select(records.filter((candidate) => candidate.backend === 'js' && candidate.precision === 'f32')) : null;
  const bestOverall = select(records);
  if (!bestWasm || !bestJs || (options.compareF32 && !bestF32)) throw new Error('Build produced no complete backend candidates');

  const wasmPath = join(staging, `${stem}.wasm`);
  await writeFile(wasmPath, bestWasm.bytes);
  await writeFile(join(staging, `${stem}.html`), bestWasm.html);
  await copyFile(join(staging, bestWasm.archive), join(staging, `${stem}.zip`));
  await writeFile(join(staging, `${stem}.js.html`), bestJs.html);
  await copyFile(join(staging, bestJs.archive), join(staging, `${stem}.js.zip`));
  if (bestF32) {
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
    version: 3,
    source: basename(options.source),
    stem,
    title,
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
  for (const name of finalNames) await copyFile(join(staging, name), join(options.output, name));
  await removeObsoleteArtifacts(options.output, stem, options.compareF32);
  console.log(JSON.stringify(report, null, 2));
  if (bestWasm.zipBytes > budget) process.exitCode = 1;
  if (options.check && process.exitCode) throw new Error('Selected WASM package exceeds the size budget');
}

await main();
