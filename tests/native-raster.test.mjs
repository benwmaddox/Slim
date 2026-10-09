import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileC} from '../src/c.mjs';
import {CELLS, decodeLevel, solve} from '../tools/boxpush-solver.mjs';

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
const nativeCompilerAvailable = existsSync(clang) && existsSync(devCmd) && existsSync(msvcInclude) && existsSync(clangResourceInclude);
const SENTINEL = 0xdeadbeef;

function boxpushReplay(source) {
  const values = (name) => {
    const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
    assert.ok(match, `Boxpush ${name} array exists`);
    return match[1].split(',').map((value) => Number(value.trim()));
  };
  const map = values('LEVEL_MAP');
  const boxes = values('LEVEL_BOX');
  const starts = values('LEVEL_START');
  const levels = Array.from({length: 6}, (_, index) => decodeLevel(
    map.slice(index * CELLS, (index + 1) * CELLS),
    boxes.slice(index * CELLS, (index + 1) * CELLS),
    starts[index],
    0,
    0,
  ));
  const solutions = levels.map((level, index) => {
    const solution = solve(level);
    assert.ok(solution, `Boxpush level ${index + 1} has a solver route`);
    return solution;
  });

  const schedule = [];
  const milestones = new Map();
  let spaceHeld = false;
  const queue = (inputs = {}, milestone) => {
    const row = Array(11).fill(0);
    for (const [index, value] of Object.entries(inputs)) row[Number(index)] = value;
    const nextSpaceHeld = row[4] !== 0;
    row[5] = nextSpaceHeld && !spaceHeld ? 1 : 0;
    spaceHeld = nextSpaceHeld;
    schedule.push(row);
    if (milestone) milestones.set(milestone, schedule.length - 1);
  };
  const tap = (index, releaseMilestone) => {
    queue({[index]: 1});
    queue({}, releaseMilestone);
  };
  const action = (milestone) => queue({4: 1}, milestone);
  const wait = (ticks, milestone) => {
    for (let tick = 0; tick < ticks; tick += 1) queue({}, tick === ticks - 1 ? milestone : undefined);
  };
  const input = {left: 0, right: 1, up: 2, down: 3};

  wait(60, 'initial-menu');
  tap(input.right);
  action('locked-level-attempt');
  queue();
  tap(input.left);
  action('level-1-play');
  queue();
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const {moves} = solutions[levelIndex];
    for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
      const lastMove = moveIndex === moves.length - 1;
      tap(input[moves[moveIndex]], lastMove ? `level-${levelIndex + 1}-clear` : undefined);
    }
    action(`level-${levelIndex + 1}-early-clear`);
    queue();
    wait(44, `level-${levelIndex + 1}-clear-ready`);
    action(levelIndex < levels.length - 1 ? `level-${levelIndex + 2}-play` : 'win');
  }
  queue({10: 1}, 'win-menu');
  queue();
  for (let index = 0; index < 5; index += 1) tap(input.right, index === 4 ? 'level-6-selected' : undefined);
  action('level-6-reopened');
  queue();
  queue({10: 1}, 'play-menu');
  queue();
  return {schedule, milestones};
}

function commonRasterHarness() {
  return `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common.h"

static const uint32_t guard_sentinel = 0xdeadbeefu;
static uint32_t raster_storage[3 + 13 * 23 + 5];
static uint32_t game_storage[3 + 600 * 807 + 4];
static uint32_t game_frame;
static const float game_inputs[__SCHEDULE_COUNT__][11] = {
__SCHEDULE_ROWS__
};
static const uint32_t checkpoints[] = {__CHECKPOINTS__};
static const uint32_t checkpoint_count = ${'__CHECKPOINT_COUNT__'}u;

float slim_input(float index) {
  if (!(index >= 0.0f && index < 11.0f && index == (float)(uint32_t)index)) return 0.0f;
  return game_inputs[game_frame][(uint32_t)index];
}

void slim_trap(void) { exit(86); }

static int fail(int code) { return code; }
static void fill_sentinel(uint32_t *pixels, size_t count) {
  size_t index;
  for (index = 0; index < count; ++index) pixels[index] = guard_sentinel;
}

static int check_raster_contract(void) {
  const int width = 19, height = 13, stride = 23;
  uint32_t *pixels = raster_storage + 3;
  const slim_u32 black = slim_encode_pixel(0u);
  const slim_u32 partial_color = slim_encode_pixel(0x00112233u);
  int x, y;
  fill_sentinel(raster_storage, sizeof(raster_storage) / sizeof(raster_storage[0]));
  slim_bind_framebuffer(pixels, width, height, stride);
  slim_begin_frame();
  for (y = 0; y < height; ++y) for (x = 0; x < width; ++x) {
#if SLIM_OPAQUE_FRAME
    if (pixels[y * stride + x] != guard_sentinel) return 1;
#else
    if (pixels[y * stride + x] != black) return 2;
#endif
  }
  for (y = 0; y < height; ++y) for (x = width; x < stride; ++x) {
    if (pixels[y * stride + x] != guard_sentinel) return 3;
  }
  for (x = 0; x < 3; ++x) if (raster_storage[x] != guard_sentinel) return 4;
  for (x = 3 + height * stride; x < (int)(sizeof(raster_storage) / sizeof(raster_storage[0])); ++x) {
    if (raster_storage[x] != guard_sentinel) return 5;
  }

  for (int frame = 0; frame < 2; ++frame) {
    fill_sentinel(raster_storage, sizeof(raster_storage) / sizeof(raster_storage[0]));
    slim_begin_frame();
    slim_rect_pixels(1, 2, 4, 7, partial_color);
    for (y = 0; y < height; ++y) for (x = 0; x < width; ++x) {
      const int inside = x >= 1 && x < 4 && y >= 2 && y < 7;
#if SLIM_OPAQUE_FRAME
      const uint32_t expected = inside ? partial_color : guard_sentinel;
#else
      const uint32_t expected = inside ? partial_color : black;
#endif
      if (pixels[y * stride + x] != expected) return 6;
    }
    if (raster_storage[0] != guard_sentinel || raster_storage[2] != guard_sentinel) return 7;
    for (y = 0; y < height; ++y) for (x = width; x < stride; ++x) {
      if (pixels[y * stride + x] != guard_sentinel) return 8;
    }
    for (x = 3 + height * stride; x < (int)(sizeof(raster_storage) / sizeof(raster_storage[0])); ++x) {
      if (raster_storage[x] != guard_sentinel) return 9;
    }
  }
  fill_sentinel(raster_storage, sizeof(raster_storage) / sizeof(raster_storage[0]));
  slim_clear();
  for (y = 0; y < height; ++y) for (x = 0; x < width; ++x) {
    if (pixels[y * stride + x] != black) return 10;
  }
  fill_sentinel(raster_storage, sizeof(raster_storage) / sizeof(raster_storage[0]));
  slim_tri(0.0f, 0.0f, 800.0f, 0.0f, 0.0f, 600.0f, 1.0f, 1.0f, 1.0f);
  if (pixels[3 * stride + 3] != slim_encode_pixel(0x00ffffffu)) return 11;
  for (y = 0; y < height; ++y) for (x = width; x < stride; ++x) {
    if (pixels[y * stride + x] != guard_sentinel) return 12;
  }
  for (x = 0; x < 3; ++x) if (raster_storage[x] != guard_sentinel) return 13;
  for (x = 3 + height * stride; x < (int)(sizeof(raster_storage) / sizeof(raster_storage[0])); ++x) {
    if (raster_storage[x] != guard_sentinel) return 14;
  }
  return 0;
}

static int game_guards_unchanged(void) {
  uint32_t y, x;
  uint32_t *pixels = game_storage + 3;
  for (x = 0; x < 3; ++x) if (game_storage[x] != guard_sentinel) return 0;
  for (y = 0; y < 600; ++y) {
    for (x = 800; x < 807; ++x) if (pixels[y * 807 + x] != guard_sentinel) return 0;
  }
  for (x = 3 + 600 * 807; x < (uint32_t)(sizeof(game_storage) / sizeof(game_storage[0])); ++x) {
    if (game_storage[x] != guard_sentinel) return 0;
  }
  return 1;
}

static int write_checkpoint(FILE *output, uint32_t frame) {
  uint32_t y;
  uint32_t *pixels = game_storage + 3;
  if (fwrite(&frame, sizeof(frame), 1, output) != 1) return 0;
  for (y = 0; y < 600; ++y) {
    if (fwrite(pixels + y * 807, sizeof(uint32_t), 800, output) != 800) return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  FILE *output;
  uint32_t frame, checkpoint_index = 0;
  int x, y;
  uint32_t *pixels = game_storage + 3;
  if (argc != 2) return fail(20);
  { int result = check_raster_contract(); if (result) return 30 + result; }
  output = fopen(argv[1], "wb");
  if (!output) return fail(50);
  slim_bind_framebuffer(pixels, 800, 600, 807);
  slim_init();
  for (frame = 0; frame < ${'__FRAME_COUNT__'}u; ++frame) {
    fill_sentinel(game_storage, sizeof(game_storage) / sizeof(game_storage[0]));
    game_frame = frame;
    slim_begin_frame();
    slim_frame();
    if (!game_guards_unchanged()) { fclose(output); return fail(51); }
    for (y = 0; y < 600; ++y) for (x = 0; x < 800; ++x) {
      if (pixels[y * 807 + x] == guard_sentinel) { fclose(output); return fail(52); }
    }
    if (checkpoint_index < checkpoint_count && frame == checkpoints[checkpoint_index]) {
      if (!write_checkpoint(output, frame)) { fclose(output); return fail(53); }
      ++checkpoint_index;
    }
  }
  fclose(output);
  return checkpoint_index == checkpoint_count ? 0 : 54;
}
`;
}

function fillContractHarness() {
  return `
#include <stdint.h>
#include <stdlib.h>
#include "common.h"

const char *const slim_texts[] = {(const char *)0};
const uint32_t slim_text_count = 0u;
void slim_trap(void) { exit(86); }

static int check_fill_widths(void) {
  static const int widths[] = {
    ${Array.from({length: 34}, (_, width) => width).join(', ')},
    60, 63, 64, 65, 127, 128, 129, 255
  };
  static const int starts[] = {0, 1, 2, 3};
  static const slim_u32 colors[] = {0x00000000u, 0x00112233u, 0x00a1b2c3u, 0xffabcdefu};
  static slim_u32 storage[3 + 3 + 255 + 4];
  const slim_u32 sentinel = 0xdeadbeefu;
  unsigned int width_index, start_index, color_index;
#if SLIM_PIXEL_RGBA_8888
  if (slim_encode_pixel(0x00112233u) != 0xff332211u) return 2;
#else
  if (slim_encode_pixel(0x00112233u) != 0x00112233u) return 2;
#endif
  if (slim_decode_pixel(slim_encode_pixel(0x00112233u)) != 0x00112233u) return 3;
  for (color_index = 0; color_index < sizeof(colors) / sizeof(colors[0]); ++color_index) {
    const slim_u32 expected = slim_encode_pixel(colors[color_index]);
    for (start_index = 0; start_index < sizeof(starts) / sizeof(starts[0]); ++start_index) {
      for (width_index = 0; width_index < sizeof(widths) / sizeof(widths[0]); ++width_index) {
        const int start = 3 + starts[start_index];
        const int count = widths[width_index];
        const int end = start + count;
        unsigned int index;
        for (index = 0; index < sizeof(storage) / sizeof(storage[0]); ++index) storage[index] = sentinel;
        slim_fill_pixels(storage + start, count, expected);
        for (index = 0; index < sizeof(storage) / sizeof(storage[0]); ++index) {
          const slim_u32 value = (int)index >= start && (int)index < end ? expected : sentinel;
          if (storage[index] != value) return 4;
        }
      }
    }
  }
  slim_fill_pixels((slim_u32 *)0, 255, 0xffffffffu);
  return 0;
}

int main(void) { return check_fill_widths(); }
`;
}

function resizeBarsHarness() {
  return `
#include <stdio.h>
#define SLIM_HAS_TEXT 0
#define SLIM_HAS_SOUND 0
#include "windows.c"

float slim_init(void) { return 0.0f; }
float slim_frame(void) { return 0.0f; }

static int resize_client(HWND window, int width, int height) {
  RECT outer = {0, 0, width, height};
  DWORD style = (DWORD)GetWindowLongPtrW(window, GWL_STYLE);
  if (!AdjustWindowRect(&outer, style, FALSE)) return 0;
  return SetWindowPos(window, 0, 0, 0, outer.right - outer.left, outer.bottom - outer.top,
                      SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
}

static int all_pixels_are(uint32_t value) {
  size_t count = (size_t)slim_surface_width * (size_t)slim_surface_height;
  size_t index;
  for (index = 0; index < count; ++index) if (slim_surface_pixels[index] != value) return 0;
  return 1;
}

static int check_bars(int width, int height) {
  int left, top, view_width, view_height, x, y;
  slim_fit_viewport(width, height, &left, &top, &view_width, &view_height);
  GdiFlush();
  for (y = 0; y < height; ++y) for (x = 0; x < width; ++x) {
    uint32_t pixel = slim_surface_pixels[(size_t)y * (size_t)width + (size_t)x];
    int in_view = x >= left && x < left + view_width && y >= top && y < top + view_height;
    if (pixel != (in_view ? 0x00123456u : 0u)) return 0;
  }
  return 1;
}

int main(void) {
  HINSTANCE instance = GetModuleHandleW(0);
  WNDCLASSW cls;
  HWND window;
  RECT client;
  int width, height;
  ZeroMemory(&cls, sizeof(cls));
  cls.lpfnWndProc = DefWindowProcW;
  cls.hInstance = instance;
  cls.lpszClassName = L"SlimNativeResizeRasterCheck";
  if (!RegisterClassW(&cls) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return 1;
  window = CreateWindowExW(0, cls.lpszClassName, L"", WS_OVERLAPPEDWINDOW,
                           0, 0, 816, 639, 0, 0, instance, 0);
  if (!window || !resize_client(window, 800, 600) || !slim_resize_framebuffer(window)) return 2;
  GetClientRect(window, &client);
  width = client.right - client.left;
  height = client.bottom - client.top;
  if (width != 800 || height != 600 || !all_pixels_are(0u)) return 3;
  { size_t i; for (i = 0; i < (size_t)width * (size_t)height; ++i) slim_surface_pixels[i] = 0x00123456u; }
  if (!resize_client(window, 1000, 600) || !slim_resize_framebuffer(window)) return 4;
  GetClientRect(window, &client);
  width = client.right - client.left;
  height = client.bottom - client.top;
  if (width != 1000 || height != 600 || !check_bars(width, height)) return 5;
  { size_t i; for (i = 0; i < (size_t)width * (size_t)height; ++i) slim_surface_pixels[i] = 0x00123456u; }
  if (!resize_client(window, 600, 700) || !slim_resize_framebuffer(window)) return 6;
  GetClientRect(window, &client);
  width = client.right - client.left;
  height = client.bottom - client.top;
  if (width != 600 || height != 700) return 8;
  if (!check_bars(width, height)) return 7;
  if (slim_surface_dc) {
    SelectObject(slim_surface_dc, slim_surface_previous);
    DeleteObject(slim_surface_bitmap);
    DeleteDC(slim_surface_dc);
  }
  DestroyWindow(window);
  return 0;
}
`;
}

async function compileAndRun(source, directory, name, {includes = ['native'], args = []} = {}) {
  const sourcePath = join(directory, `${name}.c`);
  const exePath = join(directory, `${name}.exe`);
  const commandPath = join(directory, `${name}.cmd`);
  await writeFile(sourcePath, source, 'utf8');
  const quoted = (value) => `"${value}"`;
  const includeFlags = [
    `-isystem ${quoted(clangResourceInclude)}`,
    `-isystem ${quoted(msvcInclude)}`,
    ...includes.map((path) => `-I ${quoted(join(repo, path))}`),
  ].join(' ');
  await writeFile(commandPath, [
    '@echo off',
    `call ${quoted(devCmd)} -no_logo -arch=x64 -host_arch=x64 >nul`,
    'if errorlevel 1 exit /b 1',
    `"${clang}" -target x86_64-pc-windows-msvc -fuse-ld=lld -std=c11 -O2 -ffp-contract=off -fno-fast-math -fno-builtin ${includeFlags} ${quoted(sourcePath)} -o ${quoted(exePath)} -lkernel32 -luser32 -lgdi32 -lwinmm -lucrt -lmsvcrt`,
    'if errorlevel 1 exit /b %errorlevel%',
    `${quoted(exePath)} ${args.map(quoted).join(' ')}`,
  ].join('\r\n'), 'utf8');
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', commandPath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: {...process.env, TEMP: directory, TMP: directory},
  });
  assert.equal(result.error, undefined, `failed to start native compiler or executable: ${result.error?.message}`);
  assert.equal(result.status, 0, `native raster check ${name} failed (exit ${result.status}):\n${result.stderr}\n${result.stdout}`);
}

test('opaque Boxpush frames fully cover the padded framebuffer and match clear-on rendering', {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, '.slim-native-raster-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = await readFile(join(repo, 'examples', 'boxpush.slim'), 'utf8');
  const replay = boxpushReplay(source);
  const checkpoints = [...replay.milestones.values()].sort((a, b) => a - b);
  assert.equal(new Set(checkpoints).size, checkpoints.length, 'each visual milestone is a distinct frame');
  const rows = replay.schedule.map((row) => `{${row.map((value) => `${value}.0f`).join(', ')}}`).join(',\n');
  const checkpointList = checkpoints.join(', ');
  const compileMode = async (opaque, rgba, outputName) => {
    const harness = commonRasterHarness()
      .replaceAll('__SCHEDULE_COUNT__', String(replay.schedule.length))
      .replaceAll('__SCHEDULE_ROWS__', rows)
      .replaceAll('__CHECKPOINTS__', checkpointList)
      .replaceAll('__CHECKPOINT_COUNT__', String(checkpoints.length))
      .replaceAll('__FRAME_COUNT__', String(replay.schedule.length));
    const code = `#define SLIM_OPAQUE_FRAME ${opaque}\n#define SLIM_PIXEL_RGBA_8888 ${rgba}\n${harness}\n${compileC(source)}\n`;
    const outputPath = join(directory, outputName);
    await compileAndRun(code, directory, `raster-${opaque}-${rgba}`, {args: [outputPath]});
    return readFile(outputPath);
  };
  const snapshotBytes = 4 + 800 * 600 * 4;
  for (const [pixelFormat, rgba] of [['BGR', 0], ['Android RGBA', 1]]) {
    const cleared = await compileMode(0, rgba, `cleared-${rgba}.bin`);
    const opaque = await compileMode(1, rgba, `opaque-${rgba}.bin`);
    assert.equal(cleared.length, checkpoints.length * snapshotBytes, `${pixelFormat} replay writes every named scene checkpoint`);
    assert.deepEqual(opaque, cleared, `${pixelFormat} opaque pixels match clear-on across menu, play, clear, win, and restart scenes`);
  }
  for (const name of ['initial-menu', 'level-1-play', 'level-1-clear', 'level-1-clear-ready', 'level-6-clear', 'win', 'win-menu', 'level-6-reopened', 'play-menu']) {
    assert.notEqual(replay.milestones.get(name), undefined, `raster replay includes ${name}`);
  }
});

test('SIMD and scalar fills preserve exact widths, alignments, sentinels, and encoded channels', {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, '.slim-native-fill-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const rgba of [0, 1]) {
    for (const scalar of [0, 1]) {
      const source = `#define SLIM_PIXEL_RGBA_8888 ${rgba}\n#define SLIM_DISABLE_SIMD_FILL ${scalar}\n${fillContractHarness()}`;
      await compileAndRun(source, directory, `fill-rgba-${rgba}-scalar-${scalar}`);
    }
  }
});

test('Windows aspect-changing resize clears all four letterbox bar regions', {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, '.slim-native-resize-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  await compileAndRun(resizeBarsHarness(), directory, 'resize-bars', {includes: ['native']});
});
