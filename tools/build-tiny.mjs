#!/usr/bin/env node
// Assemble a self-contained cross-platform size sample without changing the
// default Slim build. Native and browser compiler artifacts stay under output/.
import {copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {basename, delimiter, dirname, extname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileJavaScript} from '../src/javascript.mjs';
import {makeHtml, makeJavaScriptHtml} from '../src/host.mjs';
import {inlineScriptSource, minifyHtml} from './minify.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageFiles = [
  'game.exe', 'game-windows.zip', 'game-arm64-v8a.apk', 'game-x86_64.apk',
  'game-js.html', 'game-js.zip', 'game-wasm.html', 'game-wasm.zip',
  'README.md', 'compact-size-report.json',
];

function usage() {
  console.log('Usage: node tools/build-tiny.mjs [source.slim] [--renderer software|gpu] [--out-dir DIR] [--abi arm64-v8a[,x86_64]]');
  console.log('Builds standalone Windows, Android, JavaScript, and WASM packages. Renderer defaults to software; Android defaults to arm64-v8a.');
}

export function normalizeTinyRenderer(renderer = 'software') {
  if (!['software', 'gpu'].includes(renderer)) throw new Error('--renderer must be software or gpu');
  return renderer;
}

export function parseTinyArgs(argv, projectRoot = root) {
  const options = {source: 'examples/boxpush.slim', renderer: 'software', outDir: undefined, abis: ['arm64-v8a', 'x86_64']};
  let sourceSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--renderer' || arg.startsWith('--renderer=')) {
      options.renderer = optionValue(argv, i, arg, '--renderer');
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg === '--out-dir' || arg.startsWith('--out-dir=')) {
      options.outDir = optionValue(argv, i, arg, '--out-dir');
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg === '--abi' || arg.startsWith('--abi=')) {
      options.abis = optionValue(argv, i, arg, '--abi').split(',').map((value) => value.trim()).filter(Boolean);
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    if (sourceSeen) throw new Error(`unexpected extra source argument ${arg}`);
    options.source = arg;
    sourceSeen = true;
  }
  options.renderer = normalizeTinyRenderer(options.renderer);
  if (!options.abis.length || options.abis.some((abi) => !['arm64-v8a', 'x86_64'].includes(abi))) {
    throw new Error('--abi must be arm64-v8a, x86_64, or a comma-separated combination');
  }
  if (new Set(options.abis).size !== options.abis.length) throw new Error('--abi contains a duplicate ABI');
  options.source = resolve(projectRoot, options.source);
  options.stem = safeStem(options.source);
  const defaultOutDir = options.renderer === 'gpu'
    ? join('dist', 'tiny', options.stem, 'gpu')
    : join('dist', 'tiny', options.stem);
  options.outDir = resolve(projectRoot, options.outDir || defaultOutDir);
  options.stageDir = resolve(projectRoot, 'output', 'tiny-package', options.stem, ...(options.renderer === 'gpu' ? ['gpu'] : []));
  return options;
}

function optionValue(argv, index, original, name) {
  const value = original.includes('=') ? original.slice(original.indexOf('=') + 1) : argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function safeStem(source) {
  return basename(source, extname(source)).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

function run(command, args, label, {cwd = root, env = process.env, maxBuffer = 32 * 1024 * 1024} = {}) {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer});
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function pythonExecutable() {
  const configured = process.env.SLIM_PYTHON;
  if (configured) return configured;
  const pathExts = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const name of ['python', 'py']) {
      for (const suffix of pathExts) {
        const candidate = join(directory, suffix ? `${name}${suffix}` : name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('Python is needed to create deterministic ZIP containers; set SLIM_PYTHON to its executable path.');
}

function metadata(sourceText, stem) {
  const meta = {};
  const texts = [];
  for (const match of sourceText.matchAll(/^[ \t]*\/\/[ \t]*(title|footer|text):[ \t]*(.*?)[ \t]*\r?$/gm)) {
    if (match[1] === 'text') texts.push(match[2]);
    else if (match[2] && !(match[1] in meta)) meta[match[1]] = match[2];
  }
  const title = meta.title || stem.split(/[-_]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || 'Slim';
  return {title, footer: meta.footer, texts};
}

function appendToSingleScript(html, extraCode) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error(`Expected one inline script, found ${scripts.length}`);
  const script = scripts[0];
  return html.slice(0, script.index) + `<script>${script[1]}\n;${extraCode}\n</script>` + html.slice(script.index + script[0].length);
}

const touchControls = String.raw`
(()=>{
  const style=document.createElement('style');
  style.textContent='#slim-touch-controls{position:fixed;z-index:10;inset:auto 0 max(10px,env(safe-area-inset-bottom)) 0;display:none;justify-content:space-between;align-items:end;padding:0 max(10px,env(safe-area-inset-right)) 0 max(10px,env(safe-area-inset-left));box-sizing:border-box;pointer-events:none;font:600 12px system-ui;user-select:none;-webkit-user-select:none}#slim-touch-controls .pad{display:grid;grid-template:repeat(2,48px)/repeat(3,48px);gap:3px}#slim-touch-controls .actions{display:flex;flex-direction:column;align-items:end;gap:7px}#slim-touch-controls button{width:48px;height:48px;border:1px solid #ffffff77;border-radius:12px;background:#171717bb;color:#fff;opacity:.72;touch-action:none;pointer-events:auto}#slim-touch-controls button:active{opacity:1;background:#444e}#slim-touch-controls [data-key=Space]{width:132px;height:54px}#slim-touch-controls [data-key=r],#slim-touch-controls [data-key=m]{width:54px;height:34px}@media (pointer:coarse),(max-width:700px){#slim-touch-controls{display:flex}}';
  document.head.append(style);
  const controls=document.createElement('nav');controls.id='slim-touch-controls';controls.setAttribute('aria-label','Touch controls');
  controls.innerHTML='<div class="pad"><span></span><button type="button" data-key="ArrowUp" aria-label="Up">▲</button><span></span><button type="button" data-key="ArrowLeft" aria-label="Left">◀</button><button type="button" data-key="ArrowDown" aria-label="Down">▼</button><button type="button" data-key="ArrowRight" aria-label="Right">▶</button></div><div class="actions"><button type="button" data-key="Space">PLAY / UNDO / NEXT</button><div><button type="button" data-key="r" aria-label="Restart">R</button> <button type="button" data-key="m" aria-label="Menu">M</button></div></div>';
  document.body.append(controls);
  const active=new Map(),byKey=new Map(),releaseEpoch=new Map();
  const eventFor=(key,type)=>{const space=key==='Space';window.dispatchEvent(new KeyboardEvent(type,{key:space?' ':key,code:space?'Space':key,bubbles:true,cancelable:true}))};
  const down=(button,id)=>{const key=button.dataset.key;if(active.has(id))return;active.set(id,key);let pointers=byKey.get(key);if(!pointers){pointers=new Set();byKey.set(key,pointers);releaseEpoch.set(key,(releaseEpoch.get(key)||0)+1);eventFor(key,'keydown')}pointers.add(id)};
  const up=id=>{const key=active.get(id);if(!key)return;active.delete(id);const pointers=byKey.get(key);if(pointers){pointers.delete(id);if(!pointers.size){byKey.delete(key);const epoch=(releaseEpoch.get(key)||0)+1;releaseEpoch.set(key,epoch);requestAnimationFrame(()=>{if(!byKey.has(key)&&releaseEpoch.get(key)===epoch)eventFor(key,'keyup')})}}};
  controls.querySelectorAll('button[data-key]').forEach(button=>{
    button.addEventListener('contextmenu',e=>e.preventDefault());
    button.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();try{button.setPointerCapture(e.pointerId)}catch{}down(button,e.pointerId)});
    for(const type of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();up(e.pointerId)});
  });
  window.addEventListener('blur',()=>{for(const id of [...active.keys()])up(id)});
})();`;

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fileRecord(path) {
  return {bytes: (await stat(path)).size, sha256: await sha256(path)};
}

async function zipFile(python, filePath, zipPath, entryName) {
  const script = [
    'import sys, zipfile',
    'source, target, entry = sys.argv[1:4]',
    'with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:',
    '    info=zipfile.ZipInfo(entry,(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=0o100644<<16',
    '    with open(source,"rb") as f:z.writestr(info,f.read(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)',
  ].join('\n');
  run(python, ['-c', script, filePath, zipPath, entryName], 'ZIP packaging');
}

async function buildWebPages(options, python, nativeReport) {
  const sourceText = await readFile(options.source, 'utf8');
  const {title, footer, texts} = metadata(sourceText, options.stem);
  const browserDir = join(options.stageDir, 'browser');
  const releaseArgs = [
    join(root, 'tools', 'build.mjs'), options.source,
    '--keyboard-only', '--release', '--out-dir', browserDir,
  ];
  run(process.execPath, releaseArgs, 'Browser release candidate search');
  const releaseReport = JSON.parse(await readFile(join(browserDir, `${options.stem}.size.json`), 'utf8'));
  const wasm = await readFile(join(browserDir, `${options.stem}.wasm`));
  const jsBuild = compileJavaScript(sourceText);
  const jsSound = releaseReport.selectedJs?.soundPacking || 'none';
  const wasmSound = releaseReport.selectedWasm?.soundPacking || 'none';
  const jsSource = makeJavaScriptHtml(jsBuild.code, {
    title, imports: jsBuild.imports, keyboardOnly: true, soundPacking: jsSound, footer, texts,
  });
  const wasmSource = makeHtml(wasm, {title, keyboardOnly: true, soundPacking: wasmSound, footer, texts});
  const jsHtml = await minifyHtml(appendToSingleScript(jsSource, touchControls));
  const wasmHtml = await minifyHtml(appendToSingleScript(wasmSource, touchControls));
  if (inlineScriptSource(jsHtml).includes('<script')) throw new Error('Unexpected nested script in JavaScript page');
  const stagePackage = join(options.stageDir, 'package');
  await writeFile(join(stagePackage, 'game-js.html'), jsHtml);
  await writeFile(join(stagePackage, 'game-wasm.html'), wasmHtml);
  const jsArchive = join(stagePackage, 'game-js.zip');
  const wasmArchive = join(stagePackage, 'game-wasm.zip');
  await zipFile(python, join(stagePackage, 'game-js.html'), jsArchive, 'game-js.html');
  await zipFile(python, join(stagePackage, 'game-wasm.html'), wasmArchive, 'game-wasm.html');
  return {
    title,
    releaseReport,
    wasm,
    javascript: {
      backend: 'javascript',
      imports: jsBuild.imports,
      soundPacking: jsSound,
      html: await fileRecord(join(stagePackage, 'game-js.html')),
      zip: await fileRecord(jsArchive),
      containsAssetsInline: true,
    },
    wasmPage: {
      backend: 'wasm',
      selectedCandidate: releaseReport.selectedWasm?.id,
      optimization: releaseReport.selectedWasm?.optimization,
      wasmBytes: wasm.length,
      soundPacking: wasmSound,
      html: await fileRecord(join(stagePackage, 'game-wasm.html')),
      zip: await fileRecord(wasmArchive),
      containsWasmInline: true,
      imports: nativeReport.imports,
    },
  };
}

async function buildNative(options) {
  const nativeDir = join(options.stageDir, 'native');
  const args = [
    join(root, 'tools', 'build-native.mjs'), options.source,
    '--target', 'all', '--renderer', options.renderer, '--abi', options.abis.join(','), '--out-dir', nativeDir,
  ];
  run(process.execPath, args, 'Windows and Android native builds');
  return {nativeDir, report: JSON.parse(await readFile(join(nativeDir, 'native-report.json'), 'utf8'))};
}

async function writeWindowsArchive(python, exePath, destination) {
  await zipFile(python, exePath, destination, 'game.exe');
}

function readme(title, files, nativeReport, browser) {
  const rows = files.map(({name, record}) => `| ${name} | ${record.bytes.toLocaleString('en-US')} |`).join('\n');
  const abiLines = nativeReport.targets.android.abis.map((build) =>
    `- **Android ${build.abi}:** ${build.apk.signed ? 'signed APK' : 'unsigned APK'}; package \`${build.packageName}\`, launcher label “${build.appLabel}”; APK ${build.apk.bytes.toLocaleString('en-US')} B, extracted native library ${build.nativeLibrary.bytes.toLocaleString('en-US')} B; APK plus extracted library estimate ${build.installedPayloadBytes.toLocaleString('en-US')} B.`).join('\n');
  const windowsDependencyList = [...new Set([
    ...nativeReport.targets.windows.systemDllImports,
    ...(nativeReport.targets.windows.rendererSystemDependencies || []),
  ])].sort((a, b) => a.localeCompare(b, undefined, {sensitivity: 'base'}));
  const windowsDependencies = windowsDependencyList.length
    ? windowsDependencyList.join(', ')
    : 'none reported';
  const androidDependencies = [...new Set(nativeReport.targets.android.abis.flatMap((build) => build.nativeLibrary.dynamicDependencies))].sort();
  const shaderCompilation = nativeReport.targets.windows.shaderCompilation;
  const shaderLines = shaderCompilation
    ? `- Embedded vertex shader: ${shaderCompilation.shaders.vertex.profile}, ${shaderCompilation.shaders.vertex.blob.bytes.toLocaleString('en-US')} B, SHA-256 \`${shaderCompilation.shaders.vertex.blob.sha256}\`.\n` +
      `- Embedded pixel shader: ${shaderCompilation.shaders.pixel.profile}, ${shaderCompilation.shaders.pixel.blob.bytes.toLocaleString('en-US')} B, SHA-256 \`${shaderCompilation.shaders.pixel.blob.sha256}\`.\n` +
      `- Shader source SHA-256: \`${shaderCompilation.source.sha256}\`; FXC SDK ${shaderCompilation.compilerSdk}.`
    : '';
  return `# ${title} tiny build\n\n` +
    `A size experiment built from the same Slim source using the **${nativeReport.renderer}** native renderer. The software renderer remains the size-oriented default; the GPU path is a feasibility comparison, not a claim of smaller files or faster runtime. Game code and data are embedded in each file; the browser pages run offline from a local file, and the native installers do not download assets. The normal Slim JavaScript workflow is unchanged.\n\n` +
    `## Controls\n\n` +
    `- **Windows:** Arrow keys or WASD move and push crates; Space undoes; R restarts; Esc or M opens the menu.\n` +
    `- **Android:** use the on-screen direction pad; the large A button plays, undoes, or advances; R restarts; M opens the menu.\n` +
    `- **Browser:** keyboard controls are the same; on phones or narrow touch screens, use the direction pad, PLAY / UNDO / NEXT, R, and M buttons.\n\n` +
    `## Files and sizes\n\n| File | Bytes |\n|---|---:|\n${rows}\n\n` +
    `Windows package is a 64-bit standalone executable that uses system DLLs. Android NativeActivity targets API ${nativeReport.targets.android.abis[0]?.targetSdk ?? 36}, minimum API ${nativeReport.targets.android.abis[0]?.minSdk ?? 26}, and contains no Java bytecode or external assets. ${browser.wasmPage.wasmBytes.toLocaleString('en-US')} bytes is the selected raw WASM module; the HTML file embeds it.\n\n` +
    `${abiLines}\n\n` +
    `## Native renderer details\n\n` +
    `Renderer: **${nativeReport.renderer}**. Windows system dependencies: ${windowsDependencies}. Android system dependencies: ${androidDependencies.length ? androidDependencies.join(', ') : 'none reported'}.\n\n` +
    `${shaderLines ? `${shaderLines}\n\n` : ''}` +
    `The Android “APK plus extracted library” figure is an installed-payload estimate. It excludes Android-generated metadata and filesystem allocation. APKs are signed with the local debug identity when available; these are local experiment builds, not production release packages.\n\n` +
    `These sizes compare the selected local compiler candidates and hosts. They are measurements, not a proof of the absolute minimum possible size. See compact-size-report.json for hashes, selected optimization candidates, dependencies, and detailed byte counts.\n`;
}

function nativeCandidateMeasurements(candidates) {
  return (candidates || []).map((candidate) => ({
    profile: candidate.profile,
    ...(candidate.exeBytes !== undefined ? {executableBytes: candidate.exeBytes, executableSha256: candidate.exeSha256} : {}),
    ...(candidate.apkBytes !== undefined ? {apkBytes: candidate.apkBytes, apkSha256: candidate.apkSha256} : {}),
    ...(candidate.nativeLibraryBytes !== undefined ? {nativeLibraryBytes: candidate.nativeLibraryBytes, nativeLibrarySha256: candidate.nativeLibrarySha256} : {}),
    ...(candidate.portableZipBytes !== undefined ? {portableZipBytes: candidate.portableZipBytes} : {}),
    ...(candidate.loadSegmentAlignments ? {loadSegmentAlignments: candidate.loadSegmentAlignments} : {}),
  }));
}

function summarizeNativeReport(nativeReport, windowsZip, androidBuilds) {
  const windows = nativeReport.targets.windows;
  return {
    renderer: nativeReport.renderer,
    allAssetsEmbedded: nativeReport.allAssetsEmbedded,
    imports: nativeReport.imports,
    hostImports: nativeReport.hostImports,
    hostMacros: nativeReport.hostMacros,
    windows: {
      renderer: windows.renderer,
      selectedProfile: windows.selectedProfile,
      optimization: windows.optimization,
      executable: {bytes: windows.executable.bytes, sha256: windows.executable.sha256},
      portableZip: windowsZip,
      systemDllImports: windows.systemDllImports,
      rendererSystemDependencies: windows.rendererSystemDependencies || [],
      ...(windows.shaderCompilation ? {shaderCompilation: windows.shaderCompilation} : {}),
      candidates: nativeCandidateMeasurements(windows.candidates),
    },
    android: androidBuilds.map((build) => ({
      renderer: build.renderer,
      abi: build.abi,
      packageName: build.packageName,
      appLabel: build.appLabel,
      minSdk: build.minSdk,
      targetSdk: build.targetSdk,
      selectedProfile: build.selectedProfile,
      optimization: build.optimization,
      apk: {
        bytes: build.apk.bytes,
        sha256: build.apk.sha256,
        signed: build.apk.signed,
        signing: build.apk.signing,
        resourceTableCompression: build.apk.resourceTableCompression,
        resourceTableAlignment: build.apk.resourceTableAlignment,
      },
      nativeLibrary: {
        bytes: build.nativeLibrary.bytes,
        sha256: build.nativeLibrary.sha256,
        compressedInApk: build.nativeLibrary.compressedInApk,
        extractedOnInstall: build.nativeLibrary.extractedOnInstall,
        dynamicDependencies: build.nativeLibrary.dynamicDependencies,
        loadSegmentAlignments: build.nativeLibrary.loadSegmentAlignments,
      },
      installedPayloadBytes: build.installedPayloadBytes,
      installedPayloadNote: build.installedPayloadNote,
      candidates: nativeCandidateMeasurements(build.candidates),
    })),
  };
}

function browserCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    backend: candidate.backend,
    precision: candidate.precision,
    optimization: candidate.optimization,
    layout: candidate.layout,
    soundPacking: candidate.soundPacking,
    wasmBytes: candidate.wasmBytes,
    jsBytes: candidate.jsBytes,
    htmlBytes: candidate.htmlBytes,
    zipBytes: candidate.zipBytes,
  };
}

async function publishPackage(options, packageStage) {
  await mkdir(dirname(options.outDir), {recursive: true});
  await mkdir(options.outDir, {recursive: true});
  const existing = await readdir(options.outDir, {withFileTypes: true});
  const unexpected = existing.filter((entry) => !entry.isFile() || !packageFiles.includes(entry.name));
  if (unexpected.length) throw new Error(`Output directory contains unexpected entries; refusing to replace them: ${unexpected.map((entry) => entry.name).join(', ')}`);
  for (const entry of existing) await rm(join(options.outDir, entry.name), {force: true});
  for (const name of packageFiles) await copyFile(join(packageStage, name), join(options.outDir, name));
}

async function main() {
  const options = parseTinyArgs(process.argv.slice(2));
  if (!existsSync(options.source)) throw new Error(`Source file does not exist: ${options.source}`);
  await mkdir(options.stageDir, {recursive: true});
  const packageStage = join(options.stageDir, 'package');
  await mkdir(packageStage, {recursive: true});
  const python = pythonExecutable();
  const {nativeDir, report: nativeReport} = await buildNative(options);
  const nativeWindows = nativeReport.targets.windows;
  const androidBuilds = nativeReport.targets.android?.abis || [];
  if (!nativeWindows || androidBuilds.length !== options.abis.length) throw new Error('Native build did not produce every requested target/ABI');
  await copyFile(nativeWindows.executable.path, join(packageStage, 'game.exe'));
  await writeWindowsArchive(python, join(packageStage, 'game.exe'), join(packageStage, 'game-windows.zip'));
  for (const build of androidBuilds) {
    await copyFile(build.apk.path, join(packageStage, `game-${build.abi}.apk`));
  }
  const browser = await buildWebPages(options, python, nativeReport);
  const records = [];
  for (const name of packageFiles.filter((file) => file !== 'README.md' && file !== 'compact-size-report.json')) {
    records.push({name, record: await fileRecord(join(packageStage, name))});
  }
  const readmeText = readme(browser.title, records, nativeReport, browser);
  await writeFile(join(packageStage, 'README.md'), readmeText);
  const packageRecords = {};
  for (const name of packageFiles.filter((file) => file !== 'compact-size-report.json')) {
    packageRecords[name] = await fileRecord(join(packageStage, name));
  }
  const report = {
    version: 1,
    source: relative(root, options.source).replaceAll('\\', '/'),
    renderer: options.renderer,
    title: browser.title,
    allAssetsEmbedded: true,
    generatedBy: 'tools/build-tiny.mjs',
    native: summarizeNativeReport(nativeReport, await fileRecord(join(packageStage, 'game-windows.zip')), androidBuilds),
    browser: {
      javascript: browser.javascript,
      wasm: browser.wasmPage,
      releaseSelection: {
        wasm: browserCandidate(browser.releaseReport.selectedWasm),
        javascript: browserCandidate(browser.releaseReport.selectedJs),
        selectedOverall: browserCandidate(browser.releaseReport.selectedOverall),
      },
    },
    packageFiles: packageRecords,
    packageBytesExcludingReport: Object.values(packageRecords).reduce((sum, entry) => sum + entry.bytes, 0),
  };
  await writeFile(join(packageStage, 'compact-size-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await publishPackage(options, packageStage);
  console.log(`Tiny ${options.renderer} package ready: ${options.outDir}`);
  for (const [name, item] of Object.entries(packageRecords)) console.log(`  ${name}: ${item.bytes.toLocaleString('en-US')} B`);
  console.log(`  compact-size-report.json: ${(await stat(join(options.outDir, 'compact-size-report.json'))).size.toLocaleString('en-US')} B`);
  console.log(`Native inspection report: ${join(nativeDir, 'native-report.json')}`);
  console.log(`Browser optimization report: ${join(options.stageDir, 'browser', `${options.stem}.size.json`)}`);
}

export function isTinyBuildMain(argvPath, modulePath, platform = process.platform) {
  if (!argvPath) return false;
  const argvResolved = resolve(argvPath);
  const moduleResolved = resolve(modulePath);
  return platform === 'win32'
    ? argvResolved.toLowerCase() === moduleResolved.toLowerCase()
    : argvResolved === moduleResolved;
}

if (isTinyBuildMain(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(`Tiny package build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
