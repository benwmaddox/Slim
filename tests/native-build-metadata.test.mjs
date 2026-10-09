import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {compileC} from '../src/c.mjs';
import {compileJavaScript} from '../src/javascript.mjs';
import {deriveAndroidIdentity, deriveNativeBuildMetadata, isNativeBuildMain, parseNativeArgs} from '../tools/build-native.mjs';
import {isTinyBuildMain, normalizeTinyRenderer, parseTinyArgs} from '../tools/build-tiny.mjs';

test('native opaque-frame annotation maps to an opt-in macro and handles CRLF', () => {
  const marked = deriveNativeBuildMetadata(
    '// title: Example\r\n  // native-opaque-frame: true  \r\nfn init() {}\r\nfn frame() {}\r\n',
    ['slim_tri'],
  );
  assert.equal(marked.nativeOpaqueFrame, true);
  assert.equal(marked.macros.SLIM_OPAQUE_FRAME, '1');
  assert.equal(marked.macros.SLIM_HAS_TRI, '1');
  assert.equal(marked.renderer, 'software');
  assert.equal(marked.macros.SLIM_GPU_RENDERER, '0');

  const unmarked = deriveNativeBuildMetadata('fn init() {}\nfn frame() {}\n', []);
  assert.equal(unmarked.nativeOpaqueFrame, false);
  assert.equal(unmarked.macros.SLIM_OPAQUE_FRAME, '0');
  assert.equal(unmarked.macros.SLIM_GPU_RENDERER, '0');

  const gpu = deriveNativeBuildMetadata('// title: Example\nfn init() {}\n', [], 'gpu');
  assert.equal(gpu.renderer, 'gpu');
  assert.equal(gpu.macros.SLIM_GPU_RENDERER, '1');
  assert.throws(() => deriveNativeBuildMetadata('', [], 'vulkan'), /--renderer must be software or gpu/);

  for (const nearMiss of [
    '// native-opaque-frame: true // only a suffix comment',
    '// native-opaque-frame:true',
    '/* native-opaque-frame: true */',
    '/*\n// native-opaque-frame: true\n*/\nfn init() {}',
    'fn init() {}\n// native-opaque-frame: true\nfn frame() {}',
  ]) {
    assert.equal(deriveNativeBuildMetadata(nearMiss, []).nativeOpaqueFrame, false, nearMiss);
  }
});

test('native CLI entry-point matching respects Windows filename casing', () => {
  const actualPath = resolve('tools/build-native.mjs');
  assert.equal(isNativeBuildMain(actualPath, actualPath, 'win32'), true);
  assert.equal(isNativeBuildMain(actualPath.toUpperCase(), actualPath, 'win32'), true);
  assert.equal(isNativeBuildMain(actualPath.toUpperCase(), actualPath, 'linux'), false);
  assert.equal(isNativeBuildMain(undefined, actualPath, 'win32'), false);
});

test('native renderer CLI defaults to software and keeps GPU outputs separate', () => {
  const projectRoot = resolve('native-renderer-cli-test');
  const software = parseNativeArgs([], projectRoot);
  const gpu = parseNativeArgs(['--renderer=gpu'], projectRoot);
  const explicitGpu = parseNativeArgs(['--renderer', 'gpu', '--out-dir', 'output/custom-gpu'], projectRoot);

  assert.equal(software.renderer, 'software');
  assert.equal(software.outDir, resolve(projectRoot, 'output/native/rainbow'));
  assert.equal(gpu.renderer, 'gpu');
  assert.equal(gpu.outDir, resolve(projectRoot, 'output/native/rainbow/gpu'));
  assert.equal(explicitGpu.outDir, resolve(projectRoot, 'output/custom-gpu'));
  assert.throws(() => parseNativeArgs(['--renderer', 'vulkan'], projectRoot), /--renderer must be software or gpu/);
  assert.equal(isNativeBuildMain(undefined, 'tools/build-native.mjs', 'win32'), false);
});

test('tiny renderer CLI preserves software paths and isolates GPU staging and Android identity', () => {
  const projectRoot = resolve('tiny-renderer-cli-test');
  const software = parseTinyArgs([], projectRoot);
  const gpu = parseTinyArgs(['--renderer', 'gpu', '--out-dir', 'dist/tiny/boxpush/gpu'], projectRoot);

  assert.equal(software.renderer, 'software');
  assert.equal(software.outDir, resolve(projectRoot, 'dist/tiny/boxpush'));
  assert.equal(software.stageDir, resolve(projectRoot, 'output/tiny-package/boxpush'));
  assert.equal(gpu.renderer, 'gpu');
  assert.equal(gpu.outDir, resolve(projectRoot, 'dist/tiny/boxpush/gpu'));
  assert.equal(gpu.stageDir, resolve(projectRoot, 'output/tiny-package/boxpush/gpu'));
  assert.equal(normalizeTinyRenderer(), 'software');
  assert.throws(() => parseTinyArgs(['--renderer=opengl'], projectRoot), /--renderer must be software or gpu/);
  const tinyPath = resolve('tools/build-tiny.mjs');
  assert.equal(isTinyBuildMain(tinyPath, tinyPath, 'win32'), true);
  assert.equal(isTinyBuildMain(tinyPath.toUpperCase(), tinyPath, 'win32'), true);
  assert.equal(isTinyBuildMain(tinyPath.toUpperCase(), tinyPath, 'linux'), false);
  assert.equal(isTinyBuildMain(undefined, 'tools/build-tiny.mjs', 'win32'), false);

  assert.deepEqual(deriveAndroidIdentity('boxpush', 'software'), {
    packageName: 'com.slim.native.boxpush',
    appLabel: 'Boxpush',
    escapedLabel: 'Boxpush',
  });
  assert.deepEqual(deriveAndroidIdentity('boxpush', 'gpu'), {
    packageName: 'com.slim.native.boxpush.gpu',
    appLabel: 'Boxpush (GPU)',
    escapedLabel: 'Boxpush (GPU)',
  });
});

test('native-only annotation leaves JavaScript and generated C code unchanged', () => {
  const source = 'fn init() {}\nfn frame() { return 0; }\n';
  const annotated = `// native-opaque-frame: true\n${source}`;
  assert.equal(compileJavaScript(annotated).code, compileJavaScript(source).code);
  assert.equal(compileC(annotated), compileC(source));
});
