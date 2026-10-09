import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const vsBase = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools';
const clang = process.env.SLIM_CLANG ?? join(vsBase, 'VC', 'Tools', 'Llvm', 'x64', 'bin', 'clang.exe');
const devCmd = join(vsBase, 'Common7', 'Tools', 'VsDevCmd.bat');
const msvcRoot = join(vsBase, 'VC', 'Tools', 'MSVC');
const msvcVersions = existsSync(msvcRoot)
  ? readdirSync(msvcRoot).filter((version) => existsSync(join(msvcRoot, version, 'include')))
  : [];
msvcVersions.sort((left, right) => new Intl.Collator(undefined, {numeric: true}).compare(left, right));
const msvcInclude = msvcVersions.length ? join(msvcRoot, msvcVersions[msvcVersions.length - 1], 'include') : '';
const resourceResult = existsSync(clang) ? spawnSync(clang, ['-print-resource-dir'], {encoding: 'utf8'}) : null;
const clangResourceInclude = resourceResult?.status === 0
  ? join(resourceResult.stdout.trim(), 'include')
  : '';
const nativeCompilerAvailable = existsSync(clang) && existsSync(devCmd) &&
  existsSync(msvcInclude) && existsSync(clangResourceInclude);

async function compileAndRun(source, directory, name) {
  const sourcePath = join(directory, `${name}.c`);
  const exePath = join(directory, `${name}.exe`);
  const commandPath = join(directory, `${name}.cmd`);
  const quoted = (value) => `"${value}"`;
  await writeFile(sourcePath, source, 'utf8');
  await writeFile(commandPath, [
    '@echo off',
    `call ${quoted(devCmd)} -no_logo -arch=x64 -host_arch=x64 >nul`,
    'if errorlevel 1 exit /b 1',
    `"${clang}" -target x86_64-pc-windows-msvc -fuse-ld=lld -std=c11 -O2 -ffp-contract=off -fno-fast-math -fno-builtin -isystem ${quoted(clangResourceInclude)} -isystem ${quoted(msvcInclude)} -I ${quoted(join(repo, 'native'))} ${quoted(sourcePath)} -o ${quoted(exePath)} -lkernel32 -luser32 -lgdi32 -lwinmm -lucrt -lmsvcrt`,
    'if errorlevel 1 exit /b %errorlevel%',
    quoted(exePath),
  ].join('\r\n'), 'utf8');
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', commandPath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {...process.env, TEMP: directory, TMP: directory},
  });
  assert.equal(result.error, undefined, `failed to start native compiler or executable: ${result.error?.message}`);
  assert.equal(result.status, 0, `native GPU contract check ${name} failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
}

function gpuQueueHarness(rgba) {
  return `
#define SLIM_GPU_RENDERER 1
#define SLIM_OPAQUE_FRAME 1
#define SLIM_PIXEL_RGBA_8888 ${rgba}
#include <math.h>
#include <stdint.h>
#include "common.h"

const char *const slim_texts[] = {(const char *)0};
const uint32_t slim_text_count = 0u;
static int target_ok = 1;
static int fail_next_flush;
static int target_width = 1600;
static int target_height = 1200;
static uint32_t target_calls;
static uint32_t flush_calls;
static uint32_t captured_count;
static uint32_t flush_sizes[4];
static SlimGpuVertex captured[8193];

static int slim_gpu_begin_target(void) {
  ++target_calls;
  slim_bind_framebuffer((slim_u32 *)0, target_width, target_height, target_width);
  return target_ok;
}

static int slim_gpu_flush_vertices(const SlimGpuVertex *vertices, uint32_t count) {
  uint32_t index;
  if (flush_calls >= 4u) return 0;
  flush_sizes[flush_calls++] = count;
  if (fail_next_flush) {
    fail_next_flush = 0;
    return 0;
  }
  if (captured_count + count > sizeof(captured) / sizeof(captured[0])) return 0;
  for (index = 0; index < count; ++index) captured[captured_count++] = vertices[index];
  return 1;
}

static int close_float(float actual, float expected) {
  float delta = actual - expected;
  if (delta < 0.0f) delta = -delta;
  return delta < 0.00001f;
}

static void reset_capture(void) {
  flush_calls = 0;
  captured_count = 0;
  flush_sizes[0] = flush_sizes[1] = flush_sizes[2] = flush_sizes[3] = 0;
}

static int check_ndc_and_colors(void) {
  uint32_t index;
  reset_capture();
  slim_begin_frame();
  slim_tri(0.0f, 0.0f, 400.0f, 0.0f, 400.0f, 300.0f, 1.0f, 0.0f, 0.0f);
  slim_rect(10.0f, 20.0f, 30.0f, 40.0f, 0x00112233u);
  slim_rect_pixels_alpha(100, 200, 110, 210, 0x00112233u, 0.5f);
  if (!slim_finish_frame() || flush_calls != 1u || flush_sizes[0] != 15u || captured_count != 15u) return 1;
  if (captured[0].rgba != 0xff0000ffu || captured[1].rgba != 0xff0000ffu || captured[2].rgba != 0xff0000ffu) return 2;
  if (!close_float(captured[0].x, -1.0f) || !close_float(captured[0].y, 1.0f) ||
      !close_float(captured[1].x, 0.0f) || !close_float(captured[1].y, 1.0f) ||
      !close_float(captured[2].x, 0.0f) || !close_float(captured[2].y, 0.0f)) return 3;
  for (index = 3; index < 9; ++index) if (captured[index].rgba != 0xff332211u) return 4;
  if (!close_float(captured[3].x, -0.975f) || !close_float(captured[3].y, 0.9333333f) ||
      !close_float(captured[4].x, -0.9f) || !close_float(captured[5].y, 0.8f) ||
      !close_float(captured[8].x, -0.975f) || !close_float(captured[8].y, 0.8f)) return 5;
  for (index = 9; index < 15; ++index) if (captured[index].rgba != 0x80332211u) return 6;
  if (!close_float(captured[9].x, -0.875f) || !close_float(captured[9].y, 0.6666667f) ||
      !close_float(captured[11].x, -0.8625f) || !close_float(captured[11].y, 0.65f)) return 7;

  index = captured_count;
  slim_tri(NAN, 0.0f, 1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 1.0f, 1.0f);
  slim_tri(0.0f, 0.0f, 1.0f, 1.0f, 2.0f, 2.0f, 1.0f, 1.0f, 1.0f);
  slim_tri(-1000.0f, -1000.0f, -900.0f, -1000.0f, -900.0f, -900.0f, 1.0f, 1.0f, 1.0f);
  if (captured_count != index || slim_gpu_vertex_count != 0u) return 8;
  return 0;
}

static void choose_color(uint32_t index, float *r, float *g, float *b) {
  *r = (float)(index & 255u) / 255.0f;
  *g = (float)((index * 3u + 1u) & 255u) / 255.0f;
  *b = (float)((index * 7u + 2u) & 255u) / 255.0f;
}

static int check_chunk_order(void) {
  uint32_t index;
  reset_capture();
  slim_begin_frame();
  for (index = 0; index < 2731u; ++index) {
    uint32_t x = index % 20u;
    float r, g, b;
    choose_color(index, &r, &g, &b);
    slim_tri((float)x, 0.0f, (float)x + 10.0f, 0.0f,
             (float)x + 10.0f, 10.0f, r, g, b);
  }
  if (flush_calls != 1u || flush_sizes[0] != SLIM_GPU_VERTEX_CAPACITY ||
      captured_count != SLIM_GPU_VERTEX_CAPACITY || slim_gpu_vertex_count != 3u) return 1;
  if (!slim_finish_frame() || flush_calls != 2u || flush_sizes[1] != 3u || captured_count != 8193u) return 2;
  for (index = 0; index < 2731u; ++index) {
    uint32_t x = index % 20u;
    uint32_t red = index & 255u;
    uint32_t green = (index * 3u + 1u) & 255u;
    uint32_t blue = (index * 7u + 2u) & 255u;
    uint32_t expected_rgba = 0xff000000u | (blue << 16) | (green << 8) | red;
    uint32_t vertex = index * 3u;
    float expected_x = 2.0f * (2.0f * (float)x) / 1600.0f - 1.0f;
    if (captured[vertex].rgba != expected_rgba || captured[vertex + 1u].rgba != expected_rgba ||
        captured[vertex + 2u].rgba != expected_rgba) return 3;
    if (!close_float(captured[vertex].x, expected_x) || !close_float(captured[vertex].y, 1.0f) ||
        !close_float(captured[vertex + 1u].x, 2.0f * (2.0f * ((float)x + 10.0f)) / 1600.0f - 1.0f) ||
        !close_float(captured[vertex + 2u].y, 1.0f - 2.0f * 20.0f / 1200.0f)) return 4;
  }
  return 0;
}

static int check_catchup_reset_and_target_failure(void) {
  uint32_t before_calls = target_calls;
  reset_capture();
  slim_begin_frame();
  slim_tri(0.0f, 0.0f, 100.0f, 0.0f, 100.0f, 100.0f, 1.0f, 0.0f, 0.0f);
  if (slim_gpu_vertex_count != 3u || captured_count != 0u) return 1;
  slim_begin_frame();
  if (target_calls != before_calls + 2u || slim_gpu_vertex_count != 0u) return 2;
  slim_tri(0.0f, 0.0f, 100.0f, 0.0f, 100.0f, 100.0f, 0.0f, 1.0f, 0.0f);
  if (!slim_finish_frame() || captured_count != 3u || captured[0].rgba != 0xff00ff00u) return 3;

  reset_capture();
  target_ok = 0;
  slim_begin_frame();
  slim_tri(0.0f, 0.0f, 100.0f, 0.0f, 100.0f, 100.0f, 1.0f, 0.0f, 0.0f);
  if (slim_finish_frame() || flush_calls != 0u || slim_gpu_vertex_count != 0u) return 4;
  target_ok = 1;
  slim_begin_frame();
  slim_tri(0.0f, 0.0f, 100.0f, 0.0f, 100.0f, 100.0f, 0.0f, 0.0f, 1.0f);
  if (!slim_finish_frame() || captured_count != 3u || captured[0].rgba != 0xffff0000u) return 5;
  return 0;
}

static int check_flush_failure_reset(void) {
  uint32_t index;
  float r, g, b;
  reset_capture();
  slim_begin_frame();
  fail_next_flush = 1;
  for (index = 0; index < 2730u; ++index) {
    choose_color(index, &r, &g, &b);
    slim_tri(0.0f, 0.0f, 10.0f, 0.0f, 10.0f, 10.0f, r, g, b);
  }
  if (flush_calls != 1u || flush_sizes[0] != SLIM_GPU_VERTEX_CAPACITY ||
      captured_count != 0u || slim_gpu_vertex_count != 0u || slim_finish_frame()) return 1;
  reset_capture();
  slim_begin_frame();
  slim_tri(0.0f, 0.0f, 100.0f, 0.0f, 100.0f, 100.0f, 1.0f, 1.0f, 1.0f);
  if (!slim_finish_frame() || captured_count != 3u || captured[0].rgba != 0xffffffffu) return 2;
  return 0;
}

int main(void) {
  int result;
  if (sizeof(SlimGpuVertex) != 12u || offsetof(SlimGpuVertex, rgba) != 8u) return 1;
  if (slim_gpu_pack_rgba(0x00112233u, 0x80u) != 0x80332211u) return 2;
  result = check_ndc_and_colors(); if (result) return 10 + result;
  result = check_chunk_order(); if (result) return 30 + result;
  result = check_catchup_reset_and_target_failure(); if (result) return 50 + result;
  result = check_flush_failure_reset(); if (result) return 70 + result;
  return 0;
}
`;
}

function cpuAlphaHarness(rgba) {
  return `
#define SLIM_GPU_RENDERER 0
#define SLIM_PIXEL_RGBA_8888 ${rgba}
#include <stdint.h>
#include "common.h"

const char *const slim_texts[] = {(const char *)0};
const uint32_t slim_text_count = 0u;
static uint32_t storage[2 + 4 * 7 + 3];
static uint32_t *pixels = storage + 2;
static const uint32_t sentinel = 0xdeadbeefu;

int main(void) {
  int x, y;
  for (x = 0; x < (int)(sizeof(storage) / sizeof(storage[0])); ++x) storage[x] = sentinel;
  slim_bind_framebuffer(pixels, 5, 4, 7);
  for (y = 0; y < 4; ++y) for (x = 0; x < 5; ++x) pixels[y * 7 + x] = slim_encode_pixel(0x000000ffu);
  slim_rect_pixels_alpha(1, 1, 4, 3, 0x00ff0000u, 0.5f);
  if (slim_encode_pixel(0x00112233u) != ${rgba ? '0xff332211u' : '0x00112233u'}) return 1;
  if (slim_decode_pixel(slim_encode_pixel(0x00112233u)) != 0x00112233u) return 2;
  for (y = 0; y < 4; ++y) {
    for (x = 0; x < 5; ++x) {
      uint32_t expected = x >= 1 && x < 4 && y >= 1 && y < 3
        ? slim_encode_pixel(0x007f007fu)
        : slim_encode_pixel(0x000000ffu);
      if (pixels[y * 7 + x] != expected) return 3;
    }
    for (x = 5; x < 7; ++x) if (pixels[y * 7 + x] != sentinel) return 4;
  }
  if (storage[0] != sentinel || storage[1] != sentinel ||
      storage[sizeof(storage) / sizeof(storage[0]) - 1] != sentinel) return 5;
  return 0;
}
`;
}

test('GPU common renderer preserves vertex ABI, NDC, RGBA order, queue chunks, and failure resets', {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, '.slim-native-gpu-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const [name, rgba] of [['bgr', 0], ['android-rgba', 1]]) {
    await compileAndRun(gpuQueueHarness(rgba), directory, `gpu-${name}`);
  }
});

test('common alpha rectangles blend canonical RGB without touching stride guards', {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, '.slim-native-gpu-alpha-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const [name, rgba] of [['bgr', 0], ['android-rgba', 1]]) {
    await compileAndRun(cpuAlphaHarness(rgba), directory, `alpha-${name}`);
  }
});
