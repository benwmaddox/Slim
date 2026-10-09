#!/usr/bin/env node
// Optional, size-focused native experiment. The normal JS and WASM build stays
// in tools/build.mjs; this command emits a tiny C header and links one host.
import {copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {basename, delimiter, dirname, extname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileCDetailed} from '../src/c.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profiles = [
  {name: 'Oz', optimization: '-Oz'},
  {name: 'Os', optimization: '-Os'},
  {name: 'O2', optimization: '-O2'},
];
const windowsSdkDefault = 'C:\\Program Files (x86)\\Windows Kits\\10';
const visualStudioDefault = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools';
const clangDefault = `${visualStudioDefault}\\VC\\Tools\\Llvm\\x64\\bin\\clang.exe`;
const androidSdkDefault = 'C:\\Android\\Sdk';
const defaultDebugKeystore = 'C:\\Users\\Ben\\OneDrive\\KeyStores\\stasis-local-debug.keystore';
const androidApi = 26;
const androidTargetApi = 36;

function usage() {
  console.log('Usage: node tools/build-native.mjs [source.slim] [--target windows|android|all] [--out-dir DIR] [--abi arm64-v8a[,x86_64]] [--unsigned] [--smoke]');
  console.log('Builds the smallest complete native artifact among -Oz, -Os, and -O2 candidates. Android defaults to arm64-v8a.');
}

function parseArgs(argv) {
  const options = {source: undefined, target: 'all', outDir: undefined, abis: ['arm64-v8a'], unsigned: false, smoke: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--unsigned') {
      options.unsigned = true;
      continue;
    }
    if (arg === '--smoke') {
      options.smoke = true;
      continue;
    }
    if (arg === '--target' || arg.startsWith('--target=')) {
      options.target = optionValue(argv, i, arg, '--target');
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg === '--out-dir' || arg.startsWith('--out-dir=')) {
      options.outDir = optionValue(argv, i, arg, '--out-dir');
      if (!arg.includes('=')) i += 1;
      continue;
    }
    if (arg === '--abi' || arg.startsWith('--abi=')) {
      const value = optionValue(argv, i, arg, '--abi');
      if (!arg.includes('=')) i += 1;
      options.abis = value.split(',').map((abi) => abi.trim()).filter(Boolean);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    if (options.source) throw new Error(`unexpected extra source argument ${arg}`);
    options.source = arg;
  }
  if (!['windows', 'android', 'all'].includes(options.target)) throw new Error('--target must be windows, android, or all');
  if (!options.abis.length || options.abis.some((abi) => !['arm64-v8a', 'x86_64'].includes(abi))) {
    throw new Error('--abi must be arm64-v8a, x86_64, or a comma-separated combination');
  }
  if (new Set(options.abis).size !== options.abis.length) throw new Error('--abi contains a duplicate ABI');
  const source = resolve(root, options.source || 'examples/rainbow.slim');
  const stem = safeStem(source);
  options.source = source;
  options.stem = stem;
  options.outDir = resolve(root, options.outDir || join('output', 'native', stem));
  return options;
}

function optionValue(argv, index, original, name) {
  const value = original.includes('=') ? original.slice(original.indexOf('=') + 1) : argv[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${name} requires a value`);
  return value;
}

function safeStem(source) {
  const raw = basename(source, extname(source));
  return raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

function displayName(stem) {
  return stem.split(/[-_]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || 'Slim';
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    env: options.env || process.env,
    cwd: options.cwd || root,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result;
}

function executable(name, configured, extraDirs = []) {
  if (configured) {
    if (!existsSync(configured)) throw new Error(`Configured tool does not exist: ${configured}`);
    return configured;
  }
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = [...extraDirs, ...(process.env.PATH || '').split(delimiter).filter(Boolean)];
  for (const directory of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(directory, name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function directoryNames(path) {
  try {
    return (await readdir(path, {withFileTypes: true})).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function newestVersion(names) {
  return names.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'})).at(-1);
}

function mustExist(path, description) {
  if (!existsSync(path)) throw new Error(`${description} not found: ${path}`);
  return path;
}

function collectNames(value, names = new Set()) {
  if (typeof value === 'string') {
    if (value && !['env', 'slim', 'host'].includes(value.toLowerCase())) names.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectNames(entry, names);
  } else if (value && typeof value === 'object') {
    if (typeof value.name === 'string') collectNames(value.name, names);
    else if (typeof value.import === 'string') collectNames(value.import, names);
    else if (typeof value.field === 'string') collectNames(value.field, names);
    else for (const entry of Object.values(value)) collectNames(entry, names);
  }
  return [...names].sort();
}

const hostFeatures = [
  ['SLIM_HAS_TRI', /\b(?:tri|triangle|draw)\b/i],
  ['SLIM_HAS_SOUND', /\b(?:sound|tone|beep)\b/i],
  ['SLIM_HAS_INPUT', /\b(?:input|key|button|touch|pointer)\b/i],
  ['SLIM_HAS_TEXT', /\b(?:text|print)\b/i],
  ['SLIM_HAS_SIN', /\bsin\b/i],
  ['SLIM_HAS_COS', /\bcos\b/i],
  ['SLIM_HAS_ATAN2', /\batan2\b/i],
  ['SLIM_HAS_POW', /\bpow\b/i],
  ['SLIM_HAS_FLOOR', /\bfloor\b/i],
  ['SLIM_HAS_CEIL', /\bceil\b/i],
  ['SLIM_HAS_TRUNC', /\btrunc\b/i],
  ['SLIM_HAS_SQRT', /\bsqrt\b/i],
  ['SLIM_HAS_ABS', /\babs\b/i],
  ['SLIM_HAS_MIN', /\bmin\b/i],
  ['SLIM_HAS_MAX', /\bmax\b/i],
];

function macrosFor(importNames) {
  const available = new Set(importNames.map((name) => name.toLowerCase().replace(/^slim_/, '')));
  return Object.fromEntries(hostFeatures.map(([macro, pattern]) => {
    const enabled = [...available].some((name) => pattern.test(name));
    return [macro, enabled ? '1' : '0'];
  }));
}

function macroArgs(macros) {
  return Object.entries(macros).map(([name, value]) => `-D${name}=${value}`);
}

function fileSha256(path) {
  return readFile(path).then((bytes) => createHash('sha256').update(bytes).digest('hex'));
}

async function fileInfo(path) {
  return {bytes: (await stat(path)).size, sha256: await fileSha256(path)};
}

async function temporaryDirectory(prefix) {
  const buildTempRoot = join(root, 'output', '.native-build');
  await mkdir(buildTempRoot, {recursive: true});
  return mkdtemp(join(buildTempRoot, prefix));
}

async function removeTemporaryDirectory(path) {
  const tempRoot = resolve(root, 'output', '.native-build');
  const target = resolve(path);
  if (!target.startsWith(`${tempRoot}${sep}`)) throw new Error(`refusing to remove temporary build directory outside ${tempRoot}`);
  await rm(target, {recursive: true, force: true});
}

function childBuildEnvironment(staging) {
  return {...process.env, TEMP: staging, TMP: staging, TMPDIR: staging};
}

function portableArgs(args, staging) {
  return args.map((arg) => {
    if (typeof arg !== 'string') return arg;
    const absolute = resolve(arg);
    if (absolute === staging) return '<staging>';
    if (absolute.startsWith(`${staging}${sep}`)) return `<staging>${sep}${relative(staging, absolute)}`;
    return arg;
  });
}

async function writeSingleFileZip(python, inputPath, archivePath, entryName) {
  const script = [
    'import sys, zipfile',
    'source, target, entry = sys.argv[1:4]',
    'with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:',
    '    info = zipfile.ZipInfo(entry, (1980, 1, 1, 0, 0, 0))',
    '    info.compress_type = zipfile.ZIP_DEFLATED',
    '    info.create_system = 3',
    '    info.external_attr = 0o100644 << 16',
    '    with open(source, "rb") as game: archive.writestr(info, game.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)',
  ].join('\n');
  run(python, ['-c', script, inputPath, archivePath, entryName], 'ZIP packaging');
  return (await stat(archivePath)).size;
}

async function copyApkWithLibrary(python, baseApk, libraryPath, outputApk, abi) {
  const script = [
    'import sys, zipfile',
    'base, library, target, abi = sys.argv[1:5]',
    'with zipfile.ZipFile(base, "r") as source, zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:',
    '    for name in sorted(source.namelist()):',
    '        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))',
    '        info.create_system = 3',
    '        info.external_attr = 0o100644 << 16',
    '        data = source.read(name)',
    '        if name == "resources.arsc":',
    '            info.compress_type = zipfile.ZIP_STORED',
    '            output.writestr(info, data)',
    '        else:',
    '            info.compress_type = zipfile.ZIP_DEFLATED',
    '            output.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)',
    '    info = zipfile.ZipInfo("lib/" + abi + "/libslim.so", (1980, 1, 1, 0, 0, 0))',
    '    info.compress_type = zipfile.ZIP_DEFLATED',
    '    info.create_system = 3',
    '    info.external_attr = 0o100644 << 16',
    '    with open(library, "rb") as native: output.writestr(info, native.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)',
  ].join('\n');
  run(python, ['-c', script, baseApk, libraryPath, outputApk, abi], 'APK native library packaging');
}

function configuredWindowsToolchain() {
  const clangPath = executable('clang', process.env.SLIM_WINDOWS_CLANG || clangDefault);
  const sdkRoot = process.env.SLIM_WINDOWS_SDK_ROOT || windowsSdkDefault;
  const sdkVersion = process.env.SLIM_WINDOWS_SDK_VERSION || newestVersion(directoryNamesSync(join(sdkRoot, 'Include')));
  const vsRoot = process.env.SLIM_VS_ROOT || visualStudioDefault;
  const msvcVersion = process.env.SLIM_MSVC_VERSION || newestVersion(directoryNamesSync(join(vsRoot, 'VC', 'Tools', 'MSVC')));
  if (!sdkVersion) throw new Error(`Windows SDK Include directory not found under ${sdkRoot}`);
  if (!msvcVersion) throw new Error(`MSVC headers not found under ${vsRoot}`);
  const includeRoot = join(sdkRoot, 'Include', sdkVersion);
  const sdkLibRoot = join(sdkRoot, 'Lib', sdkVersion);
  const msvcRoot = join(vsRoot, 'VC', 'Tools', 'MSVC', msvcVersion);
  const includeDirs = [
    join(msvcRoot, 'include'),
    join(includeRoot, 'ucrt'),
    join(includeRoot, 'shared'),
    join(includeRoot, 'um'),
    join(includeRoot, 'winrt'),
  ];
  const libDirs = [join(msvcRoot, 'lib', 'x64'), join(sdkLibRoot, 'ucrt', 'x64'), join(sdkLibRoot, 'um', 'x64')];
  for (const path of [clangPath, ...includeDirs, ...libDirs]) mustExist(path, 'Windows toolchain path');
  const llvmBin = dirname(clangPath);
  return {
    clang: clangPath,
    includeDirs,
    libDirs,
    strip: existsSync(join(llvmBin, 'llvm-strip.exe')) ? join(llvmBin, 'llvm-strip.exe') : undefined,
    readobj: existsSync(join(llvmBin, 'llvm-readobj.exe')) ? join(llvmBin, 'llvm-readobj.exe') : undefined,
    sdkVersion,
    msvcVersion,
  };
}

function directoryNamesSync(path) {
  try {
    return readdirSync(path, {withFileTypes: true}).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function windowsBaseArgs(toolchain, gameSource, hostPath, gameDir, macros, profile) {
  const args = [
    '-std=c11', '-target', 'x86_64-pc-windows-msvc', '-fuse-ld=lld',
    profile.optimization, '-flto', '-ffp-contract=off', '-ffunction-sections', '-fdata-sections',
    '-fno-ident', '-fno-stack-protector', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-fno-builtin',
    '-Wno-unused-function', '-Wno-unused-parameter', '-Wno-unused-variable', '-Wno-missing-field-initializers',
    '-I', gameDir, '-I', join(root, 'native'), ...toolchain.includeDirs.flatMap((path) => ['-isystem', path]),
    ...macroArgs(macros), gameSource, hostPath,
    '-nostdlib', '-Xlinker', '/subsystem:windows', '-Xlinker', '/entry:slim_windows_entry',
    '-Xlinker', '/nodefaultlib', '-Xlinker', '/opt:ref', '-Xlinker', '/opt:icf', '-Xlinker', '/incremental:no',
    '-Xlinker', '/manifest:no', '-Xlinker', '/brepro', ...toolchain.libDirs.flatMap((path) => ['-L', path]),
    '-lkernel32', '-luser32', '-lgdi32', '-lwinmm', '-lucrt', '-lmsvcrt',
  ];
  return args;
}

async function windowsImports(toolchain, exePath) {
  if (!toolchain.readobj) return [];
  const output = run(toolchain.readobj, ['--coff-imports', exePath], 'Windows import inspection').stdout;
  return [...new Set([...output.matchAll(/\bName:\s*([^\s]+\.dll)\b/gi)].map((match) => match[1]))].sort();
}

async function buildWindows(options, gameCode, sourceImports, hostImports, macros, python, output) {
  const toolchain = configuredWindowsToolchain();
  const hostPath = mustExist(join(root, 'native', 'windows.c'), 'Windows native host');
  const staging = await temporaryDirectory('slim-win-build-');
  try {
    const gameSource = join(staging, 'game.c');
    await writeFile(gameSource, gameCode);
    const candidates = [];
    for (const profile of profiles) {
      const exePath = join(staging, `${options.stem}-${profile.name}.exe`);
      const args = windowsBaseArgs(toolchain, gameSource, hostPath, staging, macros, profile);
      if (options.smoke) args.splice(args.indexOf(hostPath), 0, '-DSLIM_SMOKE=1');
      const invocationArgs = [...args, '-o', exePath];
      const buildEnv = childBuildEnvironment(staging);
      run(toolchain.clang, invocationArgs, `Windows ${profile.name} link`, {env: buildEnv});
      if (toolchain.strip) run(toolchain.strip, ['--strip-all', exePath], `Windows ${profile.name} strip`, {env: buildEnv});
      const archivePath = join(staging, `${options.stem}-${profile.name}.zip`);
      const zipBytes = await writeSingleFileZip(python, exePath, archivePath, `${options.stem}.exe`);
      const exeInfo = await fileInfo(exePath);
      candidates.push({
        profile: profile.name,
        flags: portableArgs(invocationArgs, staging),
        stripFlags: toolchain.strip ? ['--strip-all', '<candidate.exe>'] : [],
        exePath,
        archivePath,
        exeBytes: exeInfo.bytes,
        exeSha256: exeInfo.sha256,
        zipBytes,
      });
    }
    candidates.sort((a, b) => a.zipBytes - b.zipBytes || a.exeBytes - b.exeBytes || a.profile.localeCompare(b.profile));
    const best = candidates[0];
    const exeOutput = join(output, `${options.stem}.exe`);
    const zipOutput = join(output, `${options.stem}.zip`);
    await copyFile(best.exePath, exeOutput);
    await copyFile(best.archivePath, zipOutput);
    const exeInfo = await fileInfo(exeOutput);
    const zipInfo = await fileInfo(zipOutput);
    return {
      target: 'windows',
      selectedProfile: best.profile,
      compiler: toolchain.clang,
      exactCompilerArgs: best.flags,
      optimization: best.flags.find((arg) => ['-Oz', '-Os', '-O2'].includes(arg)),
      fpContract: 'off',
      fastMath: false,
      executable: {path: exeOutput, ...exeInfo},
      portableZip: {path: zipOutput, ...zipInfo, contents: [`${options.stem}.exe`]},
      sourceImports,
      hostImports,
      systemDllImports: await windowsImports(toolchain, exeOutput),
      candidates: candidates.map(({profile, flags, stripFlags, exeBytes, exeSha256, zipBytes}) => ({profile, compilerArgs: flags, stripFlags, exeBytes, exeSha256, portableZipBytes: zipBytes})),
      toolchain: {sdk: toolchain.sdkVersion, msvc: toolchain.msvcVersion},
    };
  } finally {
    await removeTemporaryDirectory(staging);
  }
}

function configuredAndroidToolchain() {
  const sdkRoot = process.env.SLIM_ANDROID_SDK || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || androidSdkDefault;
  const buildTools = process.env.SLIM_ANDROID_BUILD_TOOLS || '36.0.0';
  const ndkRoot = process.env.SLIM_ANDROID_NDK || process.env.ANDROID_NDK_HOME || join(sdkRoot, 'ndk', '27.0.12077973');
  const prebuilt = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64');
  const buildToolsRoot = join(sdkRoot, 'build-tools', buildTools);
  const java = executable('java', process.env.SLIM_JAVA);
  const python = executable('python', process.env.SLIM_PYTHON) || executable('py', undefined);
  const clang = mustExist(join(prebuilt, 'bin', 'clang.exe'), 'Android NDK clang');
  const strip = join(prebuilt, 'bin', 'llvm-strip.exe');
  const readelf = join(prebuilt, 'bin', 'llvm-readelf.exe');
  const aapt2 = join(buildToolsRoot, 'aapt2.exe');
  const zipalign = join(buildToolsRoot, 'zipalign.exe');
  const apksigner = join(buildToolsRoot, 'lib', 'apksigner.jar');
  const androidJar = join(sdkRoot, 'platforms', `android-${androidTargetApi}`, 'android.jar');
  for (const path of [java, python, clang, strip, readelf, aapt2, zipalign, apksigner, androidJar]) mustExist(path, 'Android build tool');
  return {sdkRoot, ndkRoot, prebuilt, clang, strip, readelf, aapt2, zipalign, apksigner, androidJar, buildTools, java, python};
}

const androidTargets = {
  'arm64-v8a': 'aarch64-linux-android',
  x86_64: 'x86_64-linux-android',
};

function androidManifest(stem) {
  const packageStem = stem.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, 'game_') || 'game';
  const packageName = `com.slim.native.${packageStem}`;
  const label = displayName(stem).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const manifest = `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageName}">\n  <uses-sdk android:minSdkVersion="${androidApi}" android:targetSdkVersion="${androidTargetApi}" />\n  <application android:label="${label}" android:hasCode="false" android:allowBackup="false" android:extractNativeLibs="true" android:theme="@android:style/Theme.Material.Light.NoActionBar">\n    <activity android:name="android.app.NativeActivity" android:screenOrientation="landscape" android:configChanges="orientation|keyboardHidden|screenSize" android:exported="true">\n      <meta-data android:name="android.app.lib_name" android:value="slim" />\n      <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>\n    </activity>\n  </application>\n</manifest>\n`;
  return {packageName, manifest};
}

function androidDynamicDependencies(toolchain, soPath) {
  const output = run(toolchain.readelf, ['--dynamic', '--wide', soPath], 'Android dependency inspection').stdout;
  return [...new Set([...output.matchAll(/Shared library:\s*\[([^\]]+)\]/g)].map((match) => match[1]))].sort();
}

function verifyAndroidArchiveLayout(python, apkPath, abi) {
  const script = [
    'import json, struct, sys, zipfile',
    'apk_path, abi = sys.argv[1:3]',
    'with zipfile.ZipFile(apk_path) as archive, open(apk_path, "rb") as apk:',
    '    table = archive.getinfo("resources.arsc")',
    '    library = archive.getinfo("lib/" + abi + "/libslim.so")',
    '    apk.seek(table.header_offset)',
    '    header = struct.unpack("<IHHHHHIIIHH", apk.read(30))',
    '    table_offset = table.header_offset + 30 + header[9] + header[10]',
    '    if table.compress_type != zipfile.ZIP_STORED: raise SystemExit("resources.arsc must be ZIP_STORED")',
    '    if table_offset % 4: raise SystemExit("resources.arsc data is not 4-byte aligned")',
    '    if library.compress_type != zipfile.ZIP_DEFLATED: raise SystemExit("native library must be deflated in the APK")',
    '    print(json.dumps({"resourceTableCompression":"stored","resourceTableDataOffset":table_offset,"resourceTableAlignment":4,"nativeLibraryCompression":"deflated"}, separators=(",", ":")))',
  ].join('\n');
  const result = run(python, ['-c', script, apkPath, abi], 'APK resource/library layout validation');
  return JSON.parse(result.stdout.trim());
}

function androidLoadAlignment(toolchain, soPath) {
  const output = run(toolchain.readelf, ['--program-headers', '--wide', soPath], 'Android ELF alignment inspection').stdout;
  const alignments = output.split(/\r?\n/)
    .filter((line) => /^\s*LOAD\s/.test(line))
    .map((line) => line.trim().split(/\s+/).at(-1))
    .map((value) => Number.parseInt(value, 16));
  if (!alignments.length || alignments.some((alignment) => !Number.isFinite(alignment))) {
    throw new Error(`Could not read PT_LOAD alignment from ${soPath}`);
  }
  if (alignments.some((alignment) => alignment < 16384)) {
    throw new Error(`Android shared library is not 16 KiB page compatible: PT_LOAD alignments ${alignments.map((value) => `0x${value.toString(16)}`).join(', ')}`);
  }
  return alignments;
}

function androidCompilerArgs(toolchain, abi, hostPath, gameDir, macros, profile, outputSo) {
  const target = androidTargets[abi];
  return [
    '-target', `${target}${androidApi}`,
    `--sysroot=${join(toolchain.prebuilt, 'sysroot')}`,
    '-std=c11', '-fPIC', '-shared', '-fuse-ld=lld', profile.optimization, '-flto',
    '-ffp-contract=off', '-ffunction-sections', '-fdata-sections', '-fvisibility=hidden',
    '-fno-ident', '-fno-stack-protector', '-fno-unwind-tables', '-fno-asynchronous-unwind-tables', '-fno-builtin',
    '-Wno-unused-function', '-Wno-unused-parameter', '-Wno-unused-variable', '-Wno-missing-field-initializers',
    '-I', gameDir, '-I', join(root, 'native'), ...macroArgs(macros), hostPath,
    '-Wl,--gc-sections', '-Wl,--strip-all', '-Wl,--build-id=none', '-Wl,-z,max-page-size=16384', '-Wl,-z,common-page-size=16384',
    '-Wl,-soname,libslim.so', '-Wl,--as-needed', '-landroid', '-laaudio', '-lm', '-o', outputSo,
  ];
}

async function signApk(toolchain, inputApk, outputApk, signing) {
  if (!signing) {
    await copyFile(inputApk, outputApk);
    return false;
  }
  const env = {...process.env, SLIM_NATIVE_STORE_PASS: signing.storePassword, SLIM_NATIVE_KEY_PASS: signing.keyPassword};
  run(toolchain.java, [
    '-jar', toolchain.apksigner, 'sign', '--v4-signing-enabled', 'false',
    '--ks', signing.keystore, '--ks-key-alias', signing.alias,
    '--ks-pass', 'env:SLIM_NATIVE_STORE_PASS', '--key-pass', 'env:SLIM_NATIVE_KEY_PASS',
    '--out', outputApk, inputApk,
  ], 'APK signing', {env});
  run(toolchain.java, ['-jar', toolchain.apksigner, 'verify', '--min-sdk-version', String(androidApi), outputApk], 'APK signature verification');
  return true;
}

function androidSigningConfig(unsigned) {
  if (unsigned) return {signing: undefined, reason: 'explicit --unsigned'};
  const customKey = process.env.SLIM_ANDROID_KEYSTORE;
  const keystore = customKey || defaultDebugKeystore;
  if (!existsSync(keystore)) return {signing: undefined, reason: 'no Android signing key configured'};
  const useDefaultCredentials = !customKey && resolve(keystore).toLowerCase() === resolve(defaultDebugKeystore).toLowerCase();
  const alias = process.env.SLIM_ANDROID_KEY_ALIAS || (useDefaultCredentials ? 'androiddebugkey' : undefined);
  const storePassword = process.env.SLIM_ANDROID_STORE_PASSWORD;
  const keyPassword = process.env.SLIM_ANDROID_KEY_PASSWORD;
  const missingCredentials = [];
  if (!alias) missingCredentials.push('SLIM_ANDROID_KEY_ALIAS for a custom keystore');
  if (!storePassword) missingCredentials.push('SLIM_ANDROID_STORE_PASSWORD');
  if (!keyPassword) missingCredentials.push('SLIM_ANDROID_KEY_PASSWORD');
  if (missingCredentials.length) {
    throw new Error(`Android signing requires ${missingCredentials.join(' and ')}; set them in the build environment or use --unsigned to skip signing.`);
  }
  return {signing: {keystore, alias, storePassword, keyPassword}, reason: 'local debug key'};
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString('en-US')} B`;
}

function printSummary(report, reportPath) {
  const windows = report.targets.windows;
  if (windows) {
    const dependencies = windows.systemDllImports.length ? windows.systemDllImports.join(', ') : 'none';
    console.log(`Windows ${windows.selectedProfile}: EXE ${formatBytes(windows.executable.bytes)}, portable ZIP ${formatBytes(windows.portableZip.bytes)}; system DLLs: ${dependencies}`);
  }
  const android = report.targets.android;
  if (android) {
    for (const build of android.abis) {
      console.log(`Android ${build.abi} ${build.selectedProfile}: APK ${formatBytes(build.apk.bytes)} (${build.apk.signed ? 'signed' : 'unsigned'}), native library ${formatBytes(build.nativeLibrary.bytes)}, APK + extracted library ${formatBytes(build.installedPayloadBytes)}`);
      console.log(`  Native libraries: ${build.nativeLibrary.dynamicDependencies.join(', ') || 'none'}; PT_LOAD alignment: ${build.nativeLibrary.loadSegmentAlignments.map((value) => `${value} B`).join(', ')}`);
    }
  }
  console.log(`Detailed size and compiler report: ${reportPath}`);
}

async function buildAndroidAbi(options, gameCode, sourceImports, hostImports, macros, toolchain, signing, abi, output) {
  const hostPath = mustExist(join(root, 'native', 'android.c'), 'Android native host');
  const staging = await temporaryDirectory(`slim-android-${abi}-`);
  try {
    const gameDir = join(staging, 'game');
    await mkdir(gameDir, {recursive: true});
    const gameSource = join(staging, 'game.c');
    await writeFile(gameSource, gameCode);
    const {packageName, manifest} = androidManifest(options.stem);
    const manifestPath = join(staging, 'AndroidManifest.xml');
    const baseApk = join(staging, 'base.apk');
    await writeFile(manifestPath, manifest);
    run(toolchain.aapt2, [
      'link', '--manifest', manifestPath, '-I', toolchain.androidJar,
      '--min-sdk-version', String(androidApi), '--target-sdk-version', String(androidTargetApi),
      '--version-code', '1', '--version-name', '1.0', '--no-static-lib-packages', '-o', baseApk,
    ], 'Android manifest link', {env: childBuildEnvironment(staging)});

    const candidates = [];
    for (const profile of profiles) {
      const soPath = join(staging, `${profile.name}.so`);
      const args = androidCompilerArgs(toolchain, abi, hostPath, gameDir, macros, profile, soPath);
      args.splice(args.indexOf(hostPath), 0, gameSource);
      const buildEnv = childBuildEnvironment(staging);
      run(toolchain.clang, args, `Android ${abi} ${profile.name} link`, {env: buildEnv});
      if (existsSync(toolchain.strip)) run(toolchain.strip, ['--strip-unneeded', soPath], `Android ${abi} ${profile.name} strip`, {env: buildEnv});
      const loadAlignments = androidLoadAlignment(toolchain, soPath);
      const candidateApk = join(staging, `${profile.name}.apk`);
      await copyApkWithLibrary(toolchain.python, baseApk, soPath, candidateApk, abi);
      const alignedApk = join(staging, `${profile.name}.aligned.apk`);
      run(toolchain.zipalign, ['-f', '4', candidateApk, alignedApk], 'APK zipalign');
      const finalCandidate = join(staging, `${profile.name}.final.apk`);
      const signed = await signApk(toolchain, alignedApk, finalCandidate, signing);
      run(toolchain.zipalign, ['-c', '4', finalCandidate], 'APK zip alignment validation');
      const archiveLayout = verifyAndroidArchiveLayout(toolchain.python, finalCandidate, abi);
      const apkInfo = await fileInfo(finalCandidate);
      const soInfo = await fileInfo(soPath);
      candidates.push({
        profile: profile.name,
        flags: portableArgs(args, staging),
        stripFlags: existsSync(toolchain.strip) ? ['--strip-unneeded', '<candidate.so>'] : [],
        loadAlignments,
        soPath,
        apkPath: finalCandidate,
        signed,
        archiveLayout,
        apkBytes: apkInfo.bytes,
        apkSha256: apkInfo.sha256,
        soBytes: soInfo.bytes,
        soSha256: soInfo.sha256,
      });
    }
    candidates.sort((a, b) => a.apkBytes - b.apkBytes || a.soBytes - b.soBytes || a.profile.localeCompare(b.profile));
    const best = candidates[0];
    const apkOutput = join(output, `${options.stem}-${abi}.apk`);
    const soOutput = join(output, `libslim-${abi}.so`);
    await copyFile(best.apkPath, apkOutput);
    await copyFile(best.soPath, soOutput);
    const apkInfo = await fileInfo(apkOutput);
    const soInfo = await fileInfo(soOutput);
    const deps = androidDynamicDependencies(toolchain, soOutput);
    return {
      target: 'android',
      abi,
      packageName,
      minSdk: androidApi,
      targetSdk: androidTargetApi,
      nativeLibrary: {path: soOutput, ...soInfo, compressedInApk: true, extractedOnInstall: true, dynamicDependencies: deps, loadSegmentAlignments: best.loadAlignments},
      apk: {path: apkOutput, ...apkInfo, signed: best.signed, signing: best.signed ? 'local debug key' : 'unsigned', ...best.archiveLayout},
      selectedProfile: best.profile,
      compiler: toolchain.clang,
      exactCompilerArgs: best.flags,
      optimization: best.flags.find((arg) => ['-Oz', '-Os', '-O2'].includes(arg)),
      fpContract: 'off',
      fastMath: false,
      sourceImports,
      hostImports,
      candidates: candidates.map(({profile, flags, stripFlags, loadAlignments, apkBytes, apkSha256, soBytes, soSha256}) => ({profile, compilerArgs: flags, stripFlags, loadSegmentAlignments: loadAlignments, apkBytes, apkSha256, nativeLibraryBytes: soBytes, nativeLibrarySha256: soSha256})),
      installedPayloadBytes: apkInfo.bytes + soInfo.bytes,
      installedPayloadNote: 'APK size plus the extracted native library; Android-generated metadata and filesystem allocation are not included.',
      toolchain: {ndk: toolchain.ndkRoot, buildTools: toolchain.buildTools},
    };
  } finally {
    await removeTemporaryDirectory(staging);
  }
}

async function buildAndroid(options, gameCode, sourceImports, hostImports, macros, output) {
  const toolchain = configuredAndroidToolchain();
  const signingConfig = androidSigningConfig(options.unsigned);
  const builds = [];
  for (const abi of options.abis) {
    builds.push(await buildAndroidAbi(options, gameCode, sourceImports, hostImports, macros, toolchain, signingConfig.signing, abi, output));
  }
  return {target: 'android', signing: signingConfig.signing ? 'local debug key' : signingConfig.reason, abis: builds};
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const sourceText = await readFile(options.source, 'utf8');
    const detailed = compileCDetailed(sourceText);
    if (!detailed || typeof detailed.code !== 'string') throw new Error('compileCDetailed must return generated C source in its code property');
    const sourceImports = collectNames(detailed.imports);
    const hostImports = collectNames(detailed.hostImports || detailed.imports);
    const macros = macrosFor(hostImports);
    const python = executable('python', process.env.SLIM_PYTHON) || executable('py', undefined);
    if (!python) throw new Error('Python is required to create compact ZIP/APK containers; set SLIM_PYTHON to its executable path.');
    await mkdir(options.outDir, {recursive: true});
    const generatedSource = join(options.outDir, 'game.c');
    await writeFile(generatedSource, detailed.code);

    const targets = {};
    if (options.target === 'windows' || options.target === 'all') {
      targets.windows = await buildWindows(options, detailed.code, sourceImports, hostImports, macros, python, options.outDir);
    }
    if (options.target === 'android' || options.target === 'all') {
      targets.android = await buildAndroid(options, detailed.code, sourceImports, hostImports, macros, options.outDir);
    }
    const report = {
      source: options.source,
      generatedSource,
      imports: sourceImports,
      hostImports,
      functions: collectNames(detailed.functions),
      hostMacros: macros,
      optimizationCandidates: profiles.map(({name, optimization}) => ({name, optimization, lto: true, fpContract: false, fastMath: false})),
      allAssetsEmbedded: true,
      targets,
    };
    const reportPath = join(options.outDir, 'native-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(report, reportPath);
  } catch (error) {
    console.error(`Native build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
