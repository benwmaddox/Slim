import {existsSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {basename, delimiter, dirname, extname, join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';
import {makeHtml} from '../src/host.mjs';
import {minifyHtml} from './minify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log('Usage: node tools/compare-state.mjs [source.slim] [--out-dir DIR] [--keyboard-only]');
}

function parseArgs(argv) {
  let source;
  let outDir;
  let keyboardOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    if (argument === '--keyboard-only') {
      keyboardOnly = true;
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
  const resolvedSource = resolve(root, source || 'examples/rainbow.slim');
  const stem = safeStem(resolvedSource);
  return {
    source: resolvedSource,
    output: resolve(root, outDir || join('output', 'state-comparison', stem)),
    keyboardOnly,
    stem,
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

function configuredExecutable(name, configured, {required = false} = {}) {
  if (configured) {
    const candidate = configured.includes('\\') || configured.includes('/')
      ? configured
      : pathExecutable(configured);
    if (!candidate || !existsSync(candidate)) {
      throw new Error(`Configured ${name} was not found: ${configured}`);
    }
    return candidate;
  }
  const candidate = pathExecutable(name);
  if (!candidate && required) throw new Error(`${name} is required but was not found on PATH`);
  return candidate;
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
  const staging = await mkdtemp(join(tmpdir(), 'slim-state-package-'));
  try {
    await writeFile(join(staging, 'index.html'), html);
    const entries = ['index.html'];
    if (wasm) {
      await writeFile(join(staging, `${stem}.wasm`), wasm);
      entries.push(`${stem}.wasm`);
    }
    run(python, [zipTool, staging, output, ...entries], 'ZIP packaging');
    return (await stat(output)).size;
  } finally {
    const tempRoot = resolve(tmpdir());
    const target = resolve(staging);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove archive staging path outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

function candidateSummary(candidate) {
  return {
    id: candidate.id,
    storage: candidate.storage,
    optimization: candidate.optimization,
    layout: candidate.layout,
    minified: candidate.minified,
    rawWasmBytes: candidate.wasmBytes,
    htmlBytes: candidate.htmlBytes,
    zipBytes: candidate.zipBytes,
  };
}

function choose(candidates) {
  if (!candidates.length) return null;
  return candidates.slice().sort((left, right) => left.zipBytes - right.zipBytes || left.id.localeCompare(right.id))[0];
}

function optimizationSummary(candidates) {
  const embedded = choose(candidates.filter((candidate) => candidate.layout === 'embedded'));
  const external = choose(candidates.filter((candidate) => candidate.layout === 'external'));
  const selected = choose(candidates);
  return {
    rawWasmBytes: selected?.wasmBytes ?? null,
    embeddedZipBytes: embedded?.zipBytes ?? null,
    externalZipBytes: external?.zipBytes ?? null,
    embedded: embedded ? candidateSummary(embedded) : null,
    external: external ? candidateSummary(external) : null,
    selected: selected ? candidateSummary(selected) : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceText = await readFile(options.source, 'utf8');
  const python = process.env.SLIM_PYTHON || 'python';
  const zipTool = resolve(root, 'tools/zip.py');
  const optimizer = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  const disassembler = configuredExecutable('wasm-dis', process.env.SLIM_WASM_DIS);
  await mkdir(options.output, {recursive: true});
  for (const name of [
    'report.json',
    `${options.stem}.globals.wasm`, `${options.stem}.globals.wat`, `${options.stem}.globals.zip`,
    `${options.stem}.memory.wasm`, `${options.stem}.memory.wat`, `${options.stem}.memory.zip`,
  ]) {
    await rm(join(options.output, name), {force: true});
  }

  const staging = await mkdtemp(join(tmpdir(), 'slim-state-compare-'));
  const allCandidates = [];
  const profileResults = new Map();

  try {
    for (const profile of [
      {storage: 'globals', label: 'globals'},
      {storage: 'memory', label: 'memory'},
    ]) {
      const detailed = compileDetailed(sourceText, {globalStorage: profile.storage});
      const plain = detailed.wasm;
      if (!WebAssembly.validate(plain)) throw new Error(`${profile.storage} compiler output is invalid WASM`);
      const modules = [{optimization: 'plain', bytes: plain}];
      const plainPath = join(staging, `${profile.label}.plain.wasm`);
      await writeFile(plainPath, plain);

      if (optimizer) {
        const optimizedPath = join(staging, `${profile.label}.Oz.wasm`);
        const result = spawnSync(optimizer, [plainPath, '-Oz', '--strip-debug', '--strip-producers', '-o', optimizedPath], {
          encoding: 'utf8',
          windowsHide: true,
        });
        if (result.error || result.status !== 0) {
          const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
          throw new Error(`${process.env.SLIM_WASM_OPT ? 'Configured ' : ''}wasm-opt failed: ${detail}`);
        }
        const optimized = await readFile(optimizedPath);
        if (!WebAssembly.validate(optimized)) throw new Error('wasm-opt emitted invalid WASM');
        modules.push({optimization: 'Oz', bytes: optimized});
      }

      const profileCandidates = [];
      for (const module of modules) {
        for (const layout of ['embedded', 'external']) {
          const html = makeHtml(module.bytes, {
            title: titleFor(options.stem),
            keyboardOnly: options.keyboardOnly,
            ...(layout === 'external' ? {wasmUrl: `${options.stem}.wasm`} : {}),
          });
          const variants = [
            {html, minified: false},
            {html: await minifyHtml(html), minified: true},
          ];
          for (const variant of variants) {
            const suffix = variant.minified ? '-min' : '';
            const id = `${profile.label}-${module.optimization}-${layout}${suffix}`;
            const archivePath = join(staging, `${id}.zip`);
            const zipBytes = await writeArchive({
              python,
              zipTool,
              output: archivePath,
              stem: options.stem,
              html: variant.html,
              wasm: layout === 'external' ? module.bytes : undefined,
            });
            const candidate = {
              id,
              storage: profile.storage,
              optimization: module.optimization,
              layout,
              minified: variant.minified,
              wasmBytes: module.bytes.length,
              htmlBytes: Buffer.byteLength(variant.html),
              zipBytes,
              bytes: module.bytes,
              html: variant.html,
              archivePath,
            };
            profileCandidates.push(candidate);
            allCandidates.push(candidate);
          }
        }
      }

      const selected = choose(profileCandidates);
      const selectedByOptimization = new Map();
      for (const optimization of modules.map((module) => module.optimization)) {
        selectedByOptimization.set(optimization, choose(profileCandidates.filter((candidate) => candidate.optimization === optimization)));
      }
      profileResults.set(profile.storage, {
        detailed,
        candidates: profileCandidates,
        selected,
        selectedByOptimization,
      });
    }

    const artifacts = {};
    for (const storage of ['globals', 'memory']) {
      const result = profileResults.get(storage);
      const selected = result.selected;
      if (!selected) throw new Error(`no selected candidate for ${storage}`);
      const wasmName = `${options.stem}.${storage}.wasm`;
      const zipName = `${options.stem}.${storage}.zip`;
      await writeFile(join(staging, wasmName), selected.bytes);
      await copyFile(selected.archivePath, join(staging, zipName));
      await copyFile(join(staging, wasmName), join(options.output, wasmName));
      await copyFile(join(staging, zipName), join(options.output, zipName));
      artifacts[storage] = {wasm: wasmName, zip: zipName, wat: null};

      if (disassembler) {
        const watName = `${options.stem}.${storage}.wat`;
        const watPath = join(staging, watName);
        run(disassembler, [join(staging, wasmName), '-o', watPath], 'wasm-dis');
        const wat = await readFile(watPath, 'utf8');
        if (!wat.includes('(module')) throw new Error(`wasm-dis did not emit a module WAT artifact for ${storage}`);
        await copyFile(watPath, join(options.output, watName));
        artifacts[storage].wat = watName;
      }
    }

    const report = {
      version: 1,
      source: basename(options.source),
      stem: options.stem,
      keyboardOnly: options.keyboardOnly,
      optimizer: optimizer ? 'wasm-opt -Oz' : null,
      disassembler: disassembler ? 'wasm-dis' : null,
      artifacts,
      profiles: {},
      candidates: allCandidates.map(candidateSummary),
    };
    for (const storage of ['globals', 'memory']) {
      const result = profileResults.get(storage);
      const plain = result.selectedByOptimization.get('plain');
      const oz = result.selectedByOptimization.get('Oz');
      report.profiles[storage] = {
        globalStorage: storage,
        globalCount: result.detailed.globals.length,
        globalLayout: result.detailed.globalLayout ?? null,
        arrayLayout: result.detailed.arrayLayout?.map(({values, ...layout}) => layout) ?? null,
        plain: optimizationSummary(result.candidates.filter((candidate) => candidate.optimization === 'plain')),
        Oz: oz ? optimizationSummary(result.candidates.filter((candidate) => candidate.optimization === 'Oz')) : null,
        selected: candidateSummary(result.selected),
        selectedByOptimization: {
          plain: plain ? candidateSummary(plain) : null,
          Oz: oz ? candidateSummary(oz) : null,
        },
      };
    }
    await writeFile(join(options.output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    const tempRoot = resolve(tmpdir());
    const target = resolve(staging);
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove comparison staging path outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

await main();
