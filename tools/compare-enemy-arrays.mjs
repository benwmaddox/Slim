import assert from 'node:assert/strict';
import {accessSync, constants as fsConstants} from 'node:fs';
import {copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {delimiter, dirname, join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {makeHtml, makeJavaScriptHtml} from '../src/host.mjs';
import {minifyHtml} from './minify.mjs';
import {winningReplay} from './blockbound-replay.mjs';

// This is a deliberately bounded compiler experiment.  The production
// compiler has no array syntax; this tool patches a temporary copy so the
// experiment cannot accidentally become a production language feature.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'examples', 'blockbound.slim');
const arrayStudyRoot = join(root, 'output', 'array-study');
const outputRoot = join(arrayStudyRoot, 'runtime-comparison');
const stem = 'blockbound';
const arrayBase = 256;
const enemyCount = 10;
const enemyX = [550, 1140, 1540, 1780, 3400, 4385, 4765, 5400, 6000, 6420];
const enemyY = [500, 404, 372, 372, 500, 404, 436, 500, 392, 500];
const arrayValues = [...enemyX, ...enemyY, ...Array(enemyCount).fill(1)];
const arrayBytes = f32Bytes(arrayValues);

function f32Bytes(values) {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, Math.fround(value), true));
  return Array.from(new Uint8Array(buffer));
}

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`experimental patch anchor ${label} was not unique`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`experimental source anchor ${label} was not found`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

function makeSharedHelperSource(source) {
  const positions = [
    [550, 500], [1140, 404], [1540, 372], [1780, 372], [3400, 500],
    [4385, 404], [4765, 436], [5400, 500], [6000, 392], [6420, 500],
  ];
  const helper = `fn update_enemy(x, y, alive, before) {
  if (alive == 1 && absolute(player_x - x) < 31 && absolute(player_y - (y - 25)) < 29) {
    if (player_vy > 0 && before < y - 36) {
      alive = 0;
      player_vy = -8;
      sound(SOUND_STOMP, 5, 0.18);
    } else {
      state = STATE_LOST;
      sound(SOUND_LOSS, -5, 0.22);
    }
  }
  return alive;
}

fn update_enemies() {
  let before = player_y - player_vy;
${positions.map(([x, y], index) => `  enemy${index}_alive = update_enemy(${x}, ${y}, enemy${index}_alive, before);`).join('\n')}
}

`;
  return replaceBetween(source, 'fn update_enemies() {', 'fn update_player() {', helper, 'shared helper update block');
}

function makeLoopMemorySource(source) {
  let result = source;
  for (let index = 0; index < enemyCount; index += 1) {
    const declaration = `global enemy${index}_alive = 1;`;
    const count = result.split(declaration).length - 1;
    if (count !== 1) throw new Error(`expected one ${declaration} declaration, found ${count}`);
    result = result.replace(`${declaration}\n`, '');
  }

  const enemies = `fn enemies() {
  let i = 0;
  while (i < 10) {
    if (__array_load(256, i + 20) == 1) {
      enemy_shape(__array_load(256, i), __array_load(256, i + 10), walk_clock + i % 2);
    }
    i = i + 1;
  }
}

`;
  result = replaceBetween(result, 'fn enemies() {', 'fn hud() {', enemies, 'memory enemy draw loop');

  const reset = `fn reset_enemies() {
  let i = 0;
  while (i < 10) {
    __array_store(256, i + 20, 1);
    i = i + 1;
  }
}

`;
  result = replaceBetween(result, 'fn reset_enemies() {', 'fn init() {', reset, 'memory enemy reset loop');

  const update = `fn update_enemies() {
  let before = player_y - player_vy;
  let i = 0;
  while (i < 10) {
    let x = __array_load(256, i);
    let y = __array_load(256, i + 10);
    let alive = __array_load(256, i + 20);
    if (alive == 1 && absolute(player_x - x) < 31 && absolute(player_y - (y - 25)) < 29) {
      if (player_vy > 0 && before < y - 36) {
        __array_store(256, i + 20, 0);
        player_vy = -8;
        sound(SOUND_STOMP, 5, 0.18);
      } else {
        state = STATE_LOST;
        sound(SOUND_LOSS, -5, 0.22);
      }
    }
    i = i + 1;
  }
}

`;
  result = replaceBetween(result, 'fn update_enemies() {', 'fn update_player() {', update, 'memory enemy collision loop');
  return result;
}

function patchExperimentalCompiler(source) {
  source = source.replace(/\r\n/g, '\n');
  const intrinsicDecl = `const EXPERIMENTAL_INTRINSICS = Object.freeze({
  __array_load: Object.freeze({params: 2}),
  __array_store: Object.freeze({params: 3}),
});
const EXPERIMENTAL_ARRAY_DATA = ${JSON.stringify(arrayBytes)};

const F32 = 0x7d;`;
  let result = replaceOnce(source, 'const F32 = 0x7d;', intrinsicDecl, 'compiler intrinsic declaration');

  const reachabilityOld = `        const builtin = Object.hasOwn(BUILTINS, node.name) ? BUILTINS[node.name] : undefined;
        if (builtin) {
          builtinNames.add(node.name);
          if (node.args.length !== builtin.params) {
            compileError(\`builtin \${JSON.stringify(node.name)} expects \${builtin.params} arguments, got \${node.args.length}\`, node.token);
          }
          return;
        }
        const target = functions.get(node.name);`;
  const reachabilityNew = `        const builtin = Object.hasOwn(BUILTINS, node.name) ? BUILTINS[node.name] : undefined;
        if (builtin) {
          builtinNames.add(node.name);
          if (node.args.length !== builtin.params) {
            compileError(\`builtin \${JSON.stringify(node.name)} expects \${builtin.params} arguments, got \${node.args.length}\`, node.token);
          }
          return;
        }
        const intrinsic = EXPERIMENTAL_INTRINSICS[node.name];
        if (intrinsic) {
          if (node.args.length !== intrinsic.params) {
            compileError(\`intrinsic \${JSON.stringify(node.name)} expects \${intrinsic.params} arguments, got \${node.args.length}\`, node.token);
          }
          return;
        }
        const target = functions.get(node.name);`;
  result = replaceOnce(result, reachabilityOld, reachabilityNew, 'compiler intrinsic reachability');
  result = replaceOnce(result,
    'function emitModule(program, options = {}) {\n  const globalStorage = options.globalStorage ?? "globals";\n',
    'function emitModule(program, options = {}) {\n  const globalStorage = options.globalStorage ?? "globals";\n  const arrayMemory = options.arrayMemory === true;\n',
    'compiler array option');

  const callOld = `        case "call": {
          const functionIndex = context.functionIndices.get(node.name);`;
  const callNew = `        case "call": {
          const intrinsic = EXPERIMENTAL_INTRINSICS[node.name];
          if (intrinsic) {
            if (node.args.length !== intrinsic.params) {
              compileError(\`intrinsic \${JSON.stringify(node.name)} expects \${intrinsic.params} arguments, got \${node.args.length}\`, node.token);
            }
            const base = node.args[0];
            if (base.kind !== "num" || !Number.isInteger(base.value) || base.value < 0 || base.value > 0x7fffffff) {
              compileError("array memory base must be a nonnegative integer literal", base.token);
            }
            emit(node.args[1]);
            append(0xa8, 0x41, 0x02, 0x74);
            if (node.name === "__array_store") emit(node.args[2]);
            append(node.name === "__array_load" ? 0x2a : 0x38, 0x02, ...u32(base.value));
            if (node.name === "__array_store") append(0x43, ...f32Bytes(0));
            return;
          }
          const functionIndex = context.functionIndices.get(node.name);`;
  result = replaceOnce(result, callOld, callNew, 'compiler intrinsic emitter');

  const dataOld = `    ...(globalStorage === "memory" && globals.length ? section(11, [
      1,
      0x00, 0x41, 0x00, 0x0b,
      ...u32(globals.length * 4),
      ...globals.flatMap((global) => f32Bytes(global.value)),
    ]) : []),`;
  const dataNew = `    ...(arrayMemory ? section(11, [
      1,
      0x00, 0x41, ...s32(${arrayBase}), 0x0b,
      ...u32(EXPERIMENTAL_ARRAY_DATA.length),
      ...EXPERIMENTAL_ARRAY_DATA,
    ]) : []),
    ...(globalStorage === "memory" && globals.length ? section(11, [
      1,
      0x00, 0x41, 0x00, 0x0b,
      ...u32(globals.length * 4),
      ...globals.flatMap((global) => f32Bytes(global.value)),
    ]) : []),`;
  result = replaceOnce(result, dataOld, dataNew, 'compiler array data segment');
  result = replaceOnce(result,
    '  const optionNames = Object.keys(options);\n  const unsupported = optionNames.find((name) => name !== "globalStorage");\n',
    '  const optionNames = Object.keys(options);\n  const arrayMemory = options.arrayMemory === true;\n  const unsupported = optionNames.find((name) => name !== "globalStorage");\n',
    'compiler array option local');
  result = replaceOnce(result,
    '  const unsupported = optionNames.find((name) => name !== "globalStorage");\n',
    '  const unsupported = optionNames.find((name) => name !== "globalStorage" && name !== "arrayMemory");\n',
    'compiler array option validation');
  result = replaceOnce(result,
    '  return emitModule(program, {globalStorage});\n',
    '  return emitModule(program, {globalStorage, arrayMemory});\n',
    'compiler array option forwarding');
  return result;
}

function patchExperimentalJavaScript(source) {
  const dataLiteral = JSON.stringify(arrayValues);
  source = source.replace(/\r\n/g, '\n');
  const declaration = `const BUILTIN_NAMES = new Set(["tri", "sound", "input"]);
const EXPERIMENTAL_INTRINSICS = new Set(["__array_load", "__array_store"]);
const EXPERIMENTAL_ARRAY_DATA = ${JSON.stringify(arrayValues)};`;
  let result = replaceOnce(source,
    'const BUILTIN_NAMES = new Set(["tri", "sound", "input"]);',
    declaration,
    'JavaScript intrinsic declaration');
  const callOld = `        case "call": {
          const args = node.args.map((argument) => emit(argument)).join(", ");`;
  const callNew = `        case "call": {
          if (EXPERIMENTAL_INTRINSICS.has(node.name)) {
            const expected = node.name === "__array_load" ? 2 : 3;
            if (node.args.length !== expected) {
              backendError(\`intrinsic \${JSON.stringify(node.name)} expects \${expected} arguments, got \${node.args.length}\`, node.token);
            }
            const base = node.args[0];
            if (base.kind !== "num" || !Number.isInteger(base.value) || base.value < 0) {
              backendError("array memory base must be a nonnegative integer literal", base.token);
            }
            const index = emit(node.args[1]);
            const slot = \`(\${(base.value - 256) / 4} + ((\${index}) | 0))\`;
            if (node.name === "__array_load") return round(\`m[\${slot}]\`);
            const value = emit(node.args[2]);
            return round(\`(m[\${slot}] = \${value}, 0)\`);
          }
          const args = node.args.map((argument) => emit(argument)).join(", ");`;
  result = replaceOnce(result, callOld, callNew, 'JavaScript intrinsic emitter');
  result = replaceOnce(result,
    '  if (useF32) lines.push("  const r = Math.fround;");\n',
    `  if (useF32) lines.push("  const r = Math.fround;");\n  lines.push("  const m = new Float32Array(${dataLiteral});");\n`,
    'JavaScript array storage');
  return result;
}

async function loadExperimentalModules() {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-array-compiler-'));
  try {
    const compilerSource = patchExperimentalCompiler(await readFile(join(root, 'src', 'compiler.mjs'), 'utf8'));
    const javascriptSource = patchExperimentalJavaScript(await readFile(join(root, 'src', 'javascript.mjs'), 'utf8'));
    await writeFile(join(temporary, 'compiler.mjs'), compilerSource);
    await writeFile(join(temporary, 'javascript.mjs'), javascriptSource);
    const suffix = `?array-study=${process.pid}-${Date.now()}`;
    const compiler = await import(`${pathToFileURL(join(temporary, 'compiler.mjs')).href}${suffix}`);
    const javascript = await import(`${pathToFileURL(join(temporary, 'javascript.mjs')).href}${suffix}`);
    return {compiler, javascript};
  } finally {
    const target = resolve(temporary);
    const tempRoot = resolve(tmpdir());
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove temporary compiler outside ${tempRoot}`);
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
      try {
        if (statSync(candidate)) return candidate;
      } catch {}
    }
  }
  return undefined;
}

function statSync(path) {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function configuredExecutable(name, configured, siblingOf) {
  if (configured) return configured;
  if (siblingOf && (siblingOf.includes('\\') || siblingOf.includes('/'))) {
    const sibling = join(dirname(siblingOf), `${name}${process.platform === 'win32' ? '.exe' : ''}`);
    if (statSync(sibling)) return sibling;
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

async function writeArchive({python, zipTool, target, html, wasm}) {
  const temporary = await mkdtemp(join(tmpdir(), 'slim-array-package-'));
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

function archiveNames(path, python) {
  const script = 'import json,sys,zipfile;print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))';
  const result = run(python, ['-c', script, path], 'ZIP inspection');
  return JSON.parse(result.stdout);
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
    archiveEntries: candidate.archiveEntries,
  };
}

async function packageProfile(profile, source, compileWasm, compileJs, tools) {
  const staging = await mkdtemp(join(tmpdir(), 'slim-array-profile-'));
  const records = [];
  const wasmModules = [];
  try {
    const detailed = compileWasm(source);
    const plainPath = join(staging, `${stem}.plain.wasm`);
    await writeFile(plainPath, detailed.wasm);
    if (!WebAssembly.validate(detailed.wasm)) throw new Error(`${profile} plain WASM is invalid`);
    wasmModules.push({name: 'plain', bytes: detailed.wasm});

    const optimizer = tools.wasmOpt;
    const optimizedPath = join(staging, `${stem}.Oz.wasm`);
    run(optimizer, [plainPath, '-Oz', '--strip-debug', '--strip-producers', '-o', optimizedPath], `${profile} wasm-opt`);
    const optimized = await readFile(optimizedPath);
    if (!WebAssembly.validate(optimized)) throw new Error(`${profile} Oz WASM is invalid`);
    wasmModules.push({name: 'Oz', bytes: optimized});

    for (const module of wasmModules) {
      for (const layout of ['embedded', 'external']) {
        const html = makeHtml(module.bytes, {
          title: 'Blockbound',
          keyboardOnly: true,
          ...(layout === 'external' ? {wasmUrl: `${stem}.wasm`} : {}),
        });
        for (const minified of [false, true]) {
          const page = minified ? await minifyHtml(html) : html;
          const id = `${module.name}-${layout}${minified ? '-min' : ''}`;
          const archivePath = join(staging, `${id}.zip`);
          const zipBytes = await writeArchive({
            python: tools.python,
            zipTool: tools.zipTool,
            target: archivePath,
            html: page,
            wasm: layout === 'external' ? module.bytes : undefined,
          });
          records.push({
            id,
            backend: 'wasm',
            precision: 'f32',
            optimization: module.name,
            layout,
            minified,
            wasmBytes: module.bytes.length,
            htmlBytes: Buffer.byteLength(page),
            zipBytes,
            archiveEntries: archiveNames(archivePath, tools.python),
            bytes: module.bytes,
            html: page,
          });
        }
      }
    }

    const javascript = {};
    for (const precision of ['native', 'f32']) {
      const result = compileJs(source, {precision});
      if (result.precision !== precision) throw new Error(`${profile} JavaScript precision mismatch`);
      javascript[precision] = result;
      const html = makeJavaScriptHtml(result.code, {
        title: 'Blockbound',
        imports: result.imports,
        keyboardOnly: true,
      });
      for (const minified of [false, true]) {
        const page = minified ? await minifyHtml(html) : html;
        const name = precision === 'native' ? 'js' : 'f32';
        const id = `${name}-${minified ? 'min' : 'unminified'}`;
        const archivePath = join(staging, `${id}.zip`);
        const zipBytes = await writeArchive({
          python: tools.python,
          zipTool: tools.zipTool,
          target: archivePath,
          html: page,
        });
        records.push({
          id,
          backend: 'js',
          precision,
          optimization: minified ? 'terser' : 'none',
          layout: 'inline',
          minified,
          wasmBytes: null,
          htmlBytes: Buffer.byteLength(page),
          zipBytes,
          archiveEntries: archiveNames(archivePath, tools.python),
          code: result.code,
          html: page,
        });
      }
    }

    const select = (items) => items.slice().sort((a, b) => a.zipBytes - b.zipBytes || a.id.localeCompare(b.id))[0];
    const selectedWasm = select(records.filter((item) => item.backend === 'wasm'));
    const selectedJs = select(records.filter((item) => item.backend === 'js' && item.precision === 'native'));
    const selectedF32 = select(records.filter((item) => item.backend === 'js' && item.precision === 'f32'));
    const profileDir = join(tools.stagingRoot, profile);
    await mkdir(profileDir, {recursive: true});

    const watPath = join(staging, `${stem}.wat`);
    const selectedWasmPath = join(staging, `${stem}.selected.wasm`);
    await writeFile(selectedWasmPath, selectedWasm.bytes);
    run(tools.wasmDis, [selectedWasmPath, '-o', watPath], `${profile} wasm-dis`);
    const wat = await readFile(watPath, 'utf8');
    if (!wat.startsWith('(module')) throw new Error(`${profile} WAT is not a module`);

    await writeFile(join(profileDir, `${stem}.wasm`), selectedWasm.bytes);
    await writeFile(join(profileDir, `${stem}.wat`), wat);
    await writeFile(join(profileDir, `${stem}.html`), selectedWasm.html);
    await writeFile(join(profileDir, `${stem}.js`), selectedJs.code);
    await writeFile(join(profileDir, `${stem}.js.html`), selectedJs.html);
    await writeFile(join(profileDir, `${stem}.f32.js`), selectedF32.code);
    await writeFile(join(profileDir, `${stem}.f32.html`), selectedF32.html);

    const selectedArchive = async (candidate, name) => {
      const archivePath = join(staging, `${candidate.id}.zip`);
      const destination = join(profileDir, name);
      await copyFile(archivePath, destination);
      return destination;
    };
    await selectedArchive(selectedWasm, `${stem}.zip`);
    await selectedArchive(selectedJs, `${stem}.js.zip`);
    await selectedArchive(selectedF32, `${stem}.f32.zip`);

    return {
      source,
      detailed,
      javascript,
      plainWasm: wasmModules[0].bytes,
      ozWasm: wasmModules[1].bytes,
      wat,
      selectedWasm,
      selectedJs,
      selectedF32,
      candidates: records.map((candidate) => candidateSummary(candidate)),
      runtimeLoops: {
        wasm: (wat.match(/\(loop\b/g) || []).length,
        javascript: [...source.matchAll(/\bwhile\s*\(/g)].length,
      },
    };
  } finally {
    const target = resolve(staging);
    const tempRoot = resolve(tmpdir());
    if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove profile staging outside ${tempRoot}`);
    await rm(target, {recursive: true, force: true});
  }
}

function callbackHost() {
  let input = {};
  let events = [];
  const e = {
    input: (index) => input[index] || 0,
    tri: (...args) => {
      events.push(['tri', ...args]);
      return 0;
    },
    sound: (...args) => {
      events.push(['sound', ...args]);
      return 0;
    },
  };
  return {
    e,
    setInput(values) { input = values; events = []; },
    events() { return events; },
  };
}

function makeGame(profile, backend, source, compiled, experimental = false) {
  const host = callbackHost();
  if (backend === 'wasm') {
    const bytes = compiled;
    const module = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(module);
    if (imports.some((item) => item.name.startsWith('__array_'))) {
      throw new Error(`${profile} WASM leaked an array intrinsic import`);
    }
    const instance = new WebAssembly.Instance(module, {e: host.e});
    return {game: instance.exports, host, memory: instance.exports.memory, profile, backend, source, experimental};
  }
  const result = compiled;
  const factory = Function(`return (${result.code});`)();
  return {game: factory(host.e), host, memory: null, profile, backend, source, experimental};
}

function replayInputs() {
  const values = [{...{}, ticks: 1}];
  let held = false;
  for (const segment of winningReplay) {
    for (let tick = 0; tick < segment.ticks; tick += 1) {
      const space = segment.keys.includes('Space');
      values.push({
        0: segment.keys.includes('ArrowLeft') ? 1 : 0,
        1: segment.keys.includes('ArrowRight') ? 1 : 0,
        4: space ? 1 : 0,
        5: space && !held ? 1 : 0,
      });
      held = space;
    }
  }
  values.push({9: 1});
  for (let tick = 0; tick < 600; tick += 1) values.push({1: 1});
  values.push({9: 1});
  return values.map((value) => {
    const copy = {...value};
    delete copy.ticks;
    return copy;
  });
}

function compareCallbacks(label, baseline, candidate, inputs) {
  baseline.game.init();
  candidate.game.init();
  if (candidate.memory && candidate.experimental) {
    assert.equal(candidate.memory.buffer.byteLength, 65536, `${label}: expected one allocated memory page`);
    const view = new DataView(candidate.memory.buffer);
    enemyX.forEach((value, index) => assert.equal(view.getFloat32(arrayBase + index * 4, true), value, `${label}: x data`));
    enemyY.forEach((value, index) => assert.equal(view.getFloat32(arrayBase + (10 + index) * 4, true), value, `${label}: y data`));
    for (let index = 0; index < enemyCount; index += 1) assert.equal(view.getFloat32(arrayBase + (20 + index) * 4, true), 1, `${label}: alive reset`);
  }

  let ticks = 0;
  let sawWin = false;
  let sawLoss = false;
  for (const input of inputs) {
    baseline.host.setInput(input);
    candidate.host.setInput(input);
    baseline.game.frame();
    const before = baseline.host.events().map((event) => [...event]);
    candidate.game.frame();
    const after = candidate.host.events().map((event) => [...event]);
    assert.deepEqual(after, before, `${label}: callback mismatch at tick ${ticks}`);
    sawWin ||= after.some((event) => event[0] === 'tri' &&
      Math.abs(event.at(-3) - 0.20) < 0.000001 &&
      Math.abs(event.at(-2) - 0.95) < 0.000001 &&
      Math.abs(event.at(-1) - 0.55) < 0.000001);
    sawLoss ||= after.some((event) => event[0] === 'sound' && event[1] === 2);
    ticks += 1;
  }
  assert.equal(ticks, 1706, `${label}: replay tick count`);
  assert.ok(sawWin, `${label}: winning replay never drew win state`);
  assert.ok(sawLoss, `${label}: loss replay never emitted loss sound`);
  return {ticks, sawWin, sawLoss};
}

function countIntrinsicWat(wat, opcode) {
  return [...wat.matchAll(new RegExp(`\\b${opcode}\\b`, 'g'))].length;
}

async function main() {
  const source = (await readFile(sourcePath, 'utf8')).replace(/\r\n/g, '\n');
  const sharedSource = makeSharedHelperSource(source);
  const loopSource = makeLoopMemorySource(source);
  const experimental = await loadExperimentalModules();
  const wasmOpt = configuredExecutable('wasm-opt', process.env.SLIM_WASM_OPT);
  const wasmDis = configuredExecutable('wasm-dis', process.env.SLIM_WASM_DIS, wasmOpt);
  if (!wasmOpt) throw new Error('wasm-opt is required for the array comparison');
  if (!wasmDis) throw new Error('wasm-dis is required for the array comparison');
  const python = process.env.SLIM_PYTHON || 'python';
  const tools = {
    python,
    zipTool: join(root, 'tools', 'zip.py'),
    wasmOpt,
    wasmDis,
    stagingRoot: await (await mkdir(arrayStudyRoot, {recursive: true}), mkdtemp(join(arrayStudyRoot, '.runtime-comparison-staging-'))),
  };
  const inputs = replayInputs();

  try {
    const profiles = {};
    profiles.baseline = await packageProfile(
      'baseline', source,
      (text) => compileDetailed(text),
      (text, options) => compileJavaScript(text, options),
      tools,
    );
    profiles['shared-helper'] = await packageProfile(
      'shared-helper', sharedSource,
      (text) => compileDetailed(text),
      (text, options) => compileJavaScript(text, options),
      tools,
    );
    profiles['loop-memory'] = await packageProfile(
      'loop-memory', loopSource,
      (text) => experimental.compiler.compileDetailed(text, {arrayMemory: true}),
      (text, options) => experimental.javascript.compileJavaScript(text, options),
      tools,
    );

    const games = {};
    for (const [name, profile] of Object.entries(profiles)) {
      games[name] = {
        wasm: makeGame(name, 'wasm', profile.source, profile.plainWasm, name === 'loop-memory'),
        optimized: makeGame(name, 'wasm', profile.source, profile.ozWasm, name === 'loop-memory'),
        native: makeGame(name, 'native', profile.source, profile.javascript.native, name === 'loop-memory'),
        f32: makeGame(name, 'f32', profile.source, profile.javascript.f32, name === 'loop-memory'),
      };
    }
    const parity = {};
    for (const backend of ['wasm', 'optimized', 'native', 'f32']) {
      parity[`${backend}-shared-helper`] = compareCallbacks(`${backend} shared-helper`, games.baseline[backend], games['shared-helper'][backend], inputs);
      parity[`${backend}-loop-memory`] = compareCallbacks(`${backend} loop-memory`, games.baseline[backend], games['loop-memory'][backend], inputs);
    }

    const loopProfile = profiles['loop-memory'];
    const module = new WebAssembly.Module(loopProfile.plainWasm);
    const imports = WebAssembly.Module.imports(module);
    const exports = WebAssembly.Module.exports(module).map((item) => item.name);
    const wat = loopProfile.wat;
    const report = {
      version: 1,
      source: 'blockbound.slim',
      stem,
      keyboardOnly: true,
      replay: {
        winningTicks: winningReplay.reduce((sum, segment) => sum + segment.ticks, 0),
        totalTicks: inputs.length,
        sequence: 'initial, winningReplay1103, restart, right600(loss), restart',
      },
      memory: {
        baseByteOffset: arrayBase,
        coordinateSlots: 20,
        aliveSlots: 10,
        arrayBytes: arrayBytes.length,
        allocatedPages: games['loop-memory'].wasm.memory.buffer.byteLength / 65536,
        allocatedBytes: games['loop-memory'].wasm.memory.buffer.byteLength,
        additionalPages: 0,
        globals: loopProfile.detailed.globals.length,
        globalNames: loopProfile.detailed.globals.slice(),
        wasmImports: imports,
        wasmExports: exports,
      },
      runtimeLoopCode: {
        authoredWhileLoops: loopProfile.runtimeLoops.javascript,
        emittedWasmLoops: loopProfile.runtimeLoops.wasm,
        directArrayLoadsInSource: (loopSource.match(/__array_load\(/g) || []).length,
        directArrayStoresInSource: (loopSource.match(/__array_store\(/g) || []).length,
        selectedWatF32Loads: countIntrinsicWat(wat, 'f32\.load'),
        selectedWatF32Stores: countIntrinsicWat(wat, 'f32\.store'),
        selectedWat: `loop-memory/${stem}.wat`,
      },
      profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, {
        selectedWasm: candidateSummary(profile.selectedWasm),
        selectedJs: candidateSummary(profile.selectedJs),
        selectedF32: candidateSummary(profile.selectedF32),
        candidates: profile.candidates,
        runtimeLoops: profile.runtimeLoops,
      }])),
      parity,
    };
    await writeFile(join(tools.stagingRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

    const target = resolve(outputRoot);
    const parent = resolve(arrayStudyRoot);
    if (!target.startsWith(`${parent}${sep}`)) throw new Error(`refusing to replace output outside ${parent}`);
    await rm(target, {recursive: true, force: true});
    await rename(tools.stagingRoot, target);
    tools.stagingRoot = null;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (tools.stagingRoot) {
      const target = resolve(tools.stagingRoot);
      const parent = resolve(arrayStudyRoot);
      if (!target.startsWith(`${parent}${sep}`)) throw new Error(`refusing to remove staging outside ${parent}`);
      await rm(target, {recursive: true, force: true});
    }
  }
}

await main();
