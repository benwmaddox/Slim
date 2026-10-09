import test from "node:test";
import assert from "node:assert/strict";
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {compileDetailed} from "../src/compiler.mjs";
import {compileC, compileCDetailed} from "../src/c.mjs";
import {winningReplay as shardboundWinningReplay} from "../tools/shardbound-replay.mjs";
import {winningReplay as blockboundWinningReplay} from "../tools/blockbound-replay.mjs";
import {CELLS as BOXPUSH_CELLS, decodeLevel as decodeBoxpushLevel, solve as solveBoxpushLevel} from "../tools/boxpush-solver.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const vsBase = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools";
const clang = process.env.SLIM_CLANG
  ?? join(vsBase, "VC", "Tools", "Llvm", "x64", "bin", "clang.exe");
const devCmd = join(vsBase, "Common7", "Tools", "VsDevCmd.bat");
const nativeCompilerAvailable = existsSync(clang) && existsSync(devCmd);

const EVENT = Object.freeze({
  tri: 1,
  sound: 2,
  input: 3,
  text: 4,
  sin: 5,
  cos: 6,
  atan2: 7,
  pow: 8,
  trap: 9,
  initResult: 10,
  frameResult: 11,
});
const EVENT_NAMES = Object.fromEntries(Object.entries(EVENT).map(([name, kind]) => [kind, name]));
const RECORD_BYTES = 52;

function f32bits(value) {
  if (Number.isNaN(value)) return "nan";
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true).toString(16).padStart(8, "0");
}

function makeHost(record, inputMode = 0, inputSchedule = []) {
  let frame = 0;
  return {
    setFrame(nextFrame) { frame = nextFrame; },
    tri(...args) { record("tri", args); return 0; },
    sound(...args) { record("sound", args); return 0; },
    input(index) {
      const scheduled = inputSchedule[frame];
      const value = scheduled
        ? scheduled[Math.trunc(index)] ?? 0
        : inputMode === 1
        ? index === 0 ? Number.NaN : index === 1 ? 1 : index === 2 ? 9 : 0
        : inputMode === 2 ? -0 : 0;
      record("input", [index, value]);
      return value;
    },
    text(...args) { record("text", args); return 0; },
    sin(value) { const result = Math.sin(value); record("sin", [value, result]); return result; },
    cos(value) { const result = Math.cos(value); record("cos", [value, result]); return result; },
    atan2(y, x) { const result = Math.atan2(y, x); record("atan2", [y, x, result]); return result; },
    pow(base, exponent) { const result = Math.pow(base, exponent); record("pow", [base, exponent, result]); return result; },
    floor(value) { return Math.floor(value); },
    ceil(value) { return Math.ceil(value); },
    trunc(value) { return Math.trunc(value); },
    sqrt(value) { return Math.sqrt(value); },
    abs(value) { return Math.abs(value); },
    min(left, right) { return Math.min(left, right); },
    max(left, right) { return Math.max(left, right); },
    trap() { record("trap", []); throw new RangeError("SLIM array index out of bounds"); },
  };
}

function wasmImports(module, host) {
  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const namespace = imports[descriptor.module] ??= {};
    namespace[descriptor.name] = host[descriptor.name];
    assert.equal(typeof namespace[descriptor.name], "function", `missing WASM host import ${descriptor.module}.${descriptor.name}`);
  }
  return imports;
}

function cHostSource(inputMode, frames, inputSchedule, checkpointOnly = false) {
  const scheduleRows = inputSchedule.length
    ? inputSchedule.map((row) => `{${Array.from({length: 11}, (_, index) => `${Number(row[index] ?? 0)}.0f`).join(", ")}}`).join(",\n  ")
    : "{0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f}";
  const inputScheduleCount = inputSchedule.length;
  return `
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <io.h>

typedef struct { uint32_t kind; uint32_t count; uint32_t values[11]; } SlimTestRecord;
static uint32_t slim_test_frame = 0;
static const uint32_t slim_test_input_count = ${inputScheduleCount}u;
static const float slim_test_inputs[${Math.max(1, inputScheduleCount)}][11] = {${scheduleRows}};
static void slim_test_record(uint32_t kind, uint32_t count, const float *values) {
  if (${checkpointOnly ? 1 : 0} && !(kind == 10u || kind == 11u || (kind == 2u && count > 0u && values[0] >= 90.0f))) return;
  SlimTestRecord record = {kind, count, {0}};
  for (uint32_t i = 0; i < count; ++i) {
    union { float f; uint32_t u; } value = {values[i]};
    record.values[i] = value.u;
  }
  fwrite(&record, sizeof(record), 1, stdout);
}

float slim_tri(float x0, float y0, float x1, float y1, float x2, float y2, float r, float g, float b) {
  const float values[] = {x0, y0, x1, y1, x2, y2, r, g, b};
  slim_test_record(1, 9, values);
  return 0.0f;
}
float slim_sound(float kind, float pitch, float duration) {
  const float values[] = {kind, pitch, duration};
  slim_test_record(2, 3, values);
  return 0.0f;
}
float slim_input(float index) {
  float value = 0.0f;
  if (${inputMode} == 1) value = index == 0.0f ? __builtin_nanf("") : index == 1.0f ? 1.0f : index == 2.0f ? 9.0f : 0.0f;
  if (${inputMode} == 2) value = -0.0f;
  if (slim_test_input_count > 0u && index >= 0.0f && index < 11.0f && index == (float)(uint32_t)index) value = slim_test_inputs[slim_test_frame][(uint32_t)index];
  const float values[] = {index, value};
  slim_test_record(3, 2, values);
  return value;
}
float slim_text(float id, float x, float y, float size, float tone) {
  const float values[] = {id, x, y, size, tone};
  slim_test_record(4, 5, values);
  return 0.0f;
}
float slim_sin(float x) {
  const float value = (float)sin((double)x);
  const float values[] = {x, value};
  slim_test_record(5, 2, values);
  return value;
}
float slim_cos(float x) {
  const float value = (float)cos((double)x);
  const float values[] = {x, value};
  slim_test_record(6, 2, values);
  return value;
}
float slim_atan2(float y, float x) {
  const float value = (float)atan2((double)y, (double)x);
  const float values[] = {y, x, value};
  slim_test_record(7, 3, values);
  return value;
}
float slim_pow(float x, float y) {
  const float value = (float)pow((double)x, (double)y);
  const float values[] = {x, y, value};
  slim_test_record(8, 3, values);
  return value;
}
float slim_floor(float x) { return floorf(x); }
float slim_ceil(float x) { return ceilf(x); }
float slim_trunc(float x) { return truncf(x); }
float slim_sqrt(float x) { return sqrtf(x); }
float slim_abs(float x) { return fabsf(x); }
float slim_min(float x, float y) {
  if (isnan(x) || isnan(y)) return __builtin_nanf("");
  if (x == 0.0f && y == 0.0f) return signbit(x) || signbit(y) ? -0.0f : 0.0f;
  return x < y ? x : y;
}
float slim_max(float x, float y) {
  if (isnan(x) || isnan(y)) return __builtin_nanf("");
  if (x == 0.0f && y == 0.0f) return signbit(x) && signbit(y) ? -0.0f : 0.0f;
  return x > y ? x : y;
}
void slim_trap(void) {
  slim_test_record(9, 0, (const float *)0);
  exit(86);
}

int main(void) {
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, (char *)0, _IONBF, 0);
  const float init_result = slim_init();
  slim_test_record(10, 1, &init_result);
  for (uint32_t frame = 0; frame < ${frames}u; ++frame) {
    slim_test_frame = frame;
    const float result = slim_frame();
    slim_test_record(11, 1, &result);
  }
  return 0;
}
`;
}

async function compileAndRunNative(code, directory, name, {inputMode = 0, frames = 3, inputSchedule = [], checkpointOnly = false} = {}) {
  const sourcePath = join(directory, `${name}.c`);
  const exePath = join(directory, `${name}.exe`);
  const commandPath = join(directory, `${name}.cmd`);
  if (inputSchedule.length && frames === 3) frames = inputSchedule.length;
  await writeFile(sourcePath, `${code}\n${cHostSource(inputMode, frames, inputSchedule, checkpointOnly)}`, "utf8");
  const quoted = (value) => `"${value}"`;
  await writeFile(commandPath, [
    "@echo off",
    `call ${quoted(devCmd)} -no_logo -arch=x64 -host_arch=x64 >nul`,
    "if errorlevel 1 exit /b 1",
    `"${clang}" -target x86_64-pc-windows-msvc -std=c11 -O2 -fno-fast-math -ffp-contract=off ${quoted(sourcePath)} -o ${quoted(exePath)}`,
    "if errorlevel 1 exit /b %errorlevel%",
    quoted(exePath),
  ].join("\r\n"), "utf8");
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", commandPath], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    env: {...process.env, TEMP: directory, TMP: directory},
  });
  assert.equal(result.error, undefined, `failed to start native compiler or executable: ${result.error?.message}`);
  assert.ok([0, 86].includes(result.status), `native compile/replay failed for ${name}:\n${result.stderr?.toString("utf8")}`);
  return {status: result.status, bytes: result.stdout};
}

function decodeNativeTrace(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x0d && bytes[1] === 0x0a) bytes = bytes.subarray(2);
  assert.equal(bytes.length % RECORD_BYTES, 0, `native trace has complete fixed-size records (${bytes.length} bytes, exit prefix ${bytes.subarray(0, 64).toString("hex")}, suffix ${bytes.subarray(-64).toString("hex")})`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  for (let offset = 0; offset < bytes.length; offset += RECORD_BYTES) {
    const kind = view.getUint32(offset, true);
    const count = view.getUint32(offset + 4, true);
    const name = EVENT_NAMES[kind];
    assert.ok(name, `unknown native event kind ${kind}`);
    const values = [];
    for (let index = 0; index < count; index += 1) {
      values.push(view.getFloat32(offset + 8 + index * 4, true));
    }
    entries.push([name, values]);
  }
  return entries;
}

function wasmTrace(source, {inputMode = 0, frames = 3, inputSchedule = []} = {}) {
  const entries = [];
  const host = makeHost((name, values) => entries.push([name, values]), inputMode, inputSchedule);
  const bytes = compileDetailed(source).wasm;
  const module = new WebAssembly.Module(bytes);
  const exports = new WebAssembly.Instance(module, wasmImports(module, host)).exports;
  entries.push(["initResult", [exports.init()]]);
  for (let frame = 0; frame < frames; frame += 1) {
    host.setFrame(frame);
    entries.push(["frameResult", [exports.frame()]]);
  }
  return entries;
}

function compareNativeWasmTrace(source, bytes, {inputMode = 0, frames = 3, inputSchedule = [], checkpointOnly = false} = {}, onNativeEvent = () => {}) {
  if (bytes.length >= 2 && bytes[0] === 0x0d && bytes[1] === 0x0a) bytes = bytes.subarray(2);
  assert.equal(bytes.length % RECORD_BYTES, 0, `native trace record alignment: ${bytes.length} bytes`);
  const native = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let nativeOffset = 0;
  let eventIndex = 0;
  let mismatch = null;
  const actualDigest = createTraceDigest();
  const expectedDigest = createTraceDigest();
  const nextNative = () => {
    if (nativeOffset >= bytes.length) return null;
    const kind = native.getUint32(nativeOffset, true);
    const count = native.getUint32(nativeOffset + 4, true);
    const name = EVENT_NAMES[kind];
    assert.ok(name, `unknown native event kind ${kind}`);
    assert.ok(count <= 11, `native event ${name} has invalid argument count ${count}`);
    const values = [];
    for (let index = 0; index < count; index += 1) {
      values.push(native.getFloat32(nativeOffset + 8 + index * 4, true));
    }
    nativeOffset += RECORD_BYTES;
    return [name, values];
  };
  const compare = (name, values) => {
    if (checkpointOnly && name !== "initResult" && name !== "frameResult" && !(name === "sound" && values.length > 0 && values[0] >= 90)) return;
    const actual = nextNative();
    expectedDigest.add(name, values);
    if (!actual) {
      mismatch ??= {index: eventIndex, actual: null, expected: [name, ...values.map(f32bits)]};
    } else {
      actualDigest.add(...actual);
      onNativeEvent(...actual);
      const [actualName, actualValues] = actual;
      if (!mismatch && (actualName !== name || actualValues.length !== values.length)) {
        mismatch = {
          index: eventIndex,
          actual: [actualName, ...actualValues.map(f32bits)],
          expected: [name, ...values.map(f32bits)],
        };
      } else if (!mismatch) {
        for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
          if (f32bits(actualValues[valueIndex]) !== f32bits(values[valueIndex])) {
            mismatch = {
              index: eventIndex,
              value: valueIndex,
              actual: [actualName, ...actualValues.map(f32bits)],
              expected: [name, ...values.map(f32bits)],
            };
            break;
          }
        }
      }
    }
    eventIndex += 1;
  };

  const host = makeHost(compare, inputMode, inputSchedule);
  const module = new WebAssembly.Module(compileDetailed(source).wasm);
  const exports = new WebAssembly.Instance(module, wasmImports(module, host)).exports;
  compare("initResult", [exports.init()]);
  for (let frame = 0; frame < frames; frame += 1) {
    host.setFrame(frame);
    compare("frameResult", [exports.frame()]);
  }
  let extra;
  while ((extra = nextNative())) {
    actualDigest.add(...extra);
    onNativeEvent(...extra);
    mismatch ??= {index: eventIndex, actual: [extra[0], ...extra[1].map(f32bits)], expected: null};
    eventIndex += 1;
  }
  return {
    mismatch,
    actualDigest: actualDigest.result(),
    expectedDigest: expectedDigest.result(),
  };
}

function replayInputSchedule(segments) {
  const schedule = [];
  let spaceHeld = false;
  for (const segment of segments) {
    const keys = segment.keys ?? [];
    for (let tick = 0; tick < segment.ticks; tick += 1) {
      const values = {};
      if (keys.includes("ArrowLeft") || keys.includes("KeyA")) values[0] = 1;
      if (keys.includes("ArrowRight") || keys.includes("KeyD")) values[1] = 1;
      const space = keys.includes("Space");
      if (space) values[4] = 1;
      if (space && !spaceHeld) values[5] = 1;
      schedule.push(values);
      spaceHeld = space;
    }
  }
  return schedule;
}

function appendInputFrame(schedule, values) {
  schedule.push({...values});
  return schedule;
}

function instrumentBoxpushFrame(source) {
  const renamed = source.replace("fn frame() {", "fn boxpush_native_replay() {");
  assert.notEqual(renamed, source, "Boxpush source has a frame entry point");
  return `${renamed}\nfn frame() {\n  boxpush_native_replay();\n  sound(99, player, current_level);\n  sound(98, state, covered);\n  sound(97, hist_len, stars);\n  let crate_hash = 0;\n  let i = 0;\n  while (i < CELLS) {\n    crate_hash = crate_hash + crate[i] * (i + 1);\n    i = i + 1;\n  }\n  sound(96, crate_hash, best_moves[current_level]);\n  sound(95, cursor, unlocked);\n}`;
}

function makeBoxpushReplay(source) {
  const values = (name) => {
    const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
    assert.ok(match, `Boxpush ${name} array exists`);
    return match[1].split(",").map((value) => Number(value.trim()));
  };
  const map = values("LEVEL_MAP");
  const boxes = values("LEVEL_BOX");
  const starts = values("LEVEL_START");
  const levels = Array.from({length: 6}, (_, index) => decodeBoxpushLevel(
    map.slice(index * BOXPUSH_CELLS, (index + 1) * BOXPUSH_CELLS),
    boxes.slice(index * BOXPUSH_CELLS, (index + 1) * BOXPUSH_CELLS),
    starts[index],
    0,
    0,
  ));
  const solutions = levels.map((level, index) => {
    const solution = solveBoxpushLevel(level);
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
  const tap = (index, {press, release} = {}) => {
    queue({[index]: 1}, press);
    queue({}, release);
  };
  const action = (milestone) => queue({4: 1}, milestone);
  const wait = (ticks) => { for (let tick = 0; tick < ticks; tick += 1) queue(); };
  const directionInput = {left: 0, right: 1, up: 2, down: 3};

  // Match the menu taps, rejected locked-level selection, and the game's
  // one-frame key down / one-frame release movement helper.
  wait(60);
  tap(directionInput.right);
  action("locked-level-attempt");
  queue();
  tap(directionInput.left);
  action("level-1-open");

  const firstMove = directionInput[solutions[0].moves[0]];
  tap(firstMove, {release: "first-move"});
  action("after-undo");
  queue();
  tap(firstMove);
  queue({9: 1}, "after-reset");
  queue();

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const {moves} = solutions[levelIndex];
    for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
      const lastMove = moveIndex === moves.length - 1;
      tap(directionInput[moves[moveIndex]], {
        press: lastMove ? `level-${levelIndex + 1}-clear` : undefined,
      });
    }
    action(`level-${levelIndex + 1}-early-action`);
    queue();
    wait(44);
    action(`level-${levelIndex + 1}-advance`);
  }

  // Leave the win screen with M, navigate to the newly unlocked final card,
  // open it, and return to the menu from play with M.
  queue({10: 1}, "win-menu");
  queue();
  for (let index = 0; index < 5; index += 1) {
    tap(directionInput.right, {release: index === 4 ? "level-6-selected" : undefined});
  }
  action("level-6-reopened");
  queue();
  queue({10: 1}, "play-menu");
  queue();

  return {schedule, milestones, levels, solutions};
}

function decodeBoxpushCheckpoints(entries) {
  const empty = () => ({
    player: Number.NaN,
    level: Number.NaN,
    state: Number.NaN,
    covered: Number.NaN,
    moves: Number.NaN,
    stars: Number.NaN,
    crateHash: Number.NaN,
    best: Number.NaN,
    cursor: Number.NaN,
    unlocked: Number.NaN,
    result: Number.NaN,
  });
  const rows = [];
  let row = empty();
  for (const [name, args] of entries) {
    if (name === "sound") {
      switch (args[0]) {
        case 99: row.player = args[1]; row.level = args[2]; break;
        case 98: row.state = args[1]; row.covered = args[2]; break;
        case 97: row.moves = args[1]; row.stars = args[2]; break;
        case 96: row.crateHash = args[1]; row.best = args[2]; break;
        case 95: row.cursor = args[1]; row.unlocked = args[2]; break;
        default: break;
      }
    } else if (name === "frameResult") {
      row.result = args[0];
      assert.ok(Object.values(row).every(Number.isFinite), `all Boxpush checkpoint fields were emitted for frame ${rows.length}`);
      rows.push(row);
      row = empty();
    }
  }
  return rows;
}

function boxpushCheckpointHash(level) {
  return level.boxes.reduce((sum, cell) => sum + cell + 1, 0);
}

function instrumentFrame(source, originalName, diagnostics) {
  const renamed = source.replace("fn frame() {", `fn ${originalName}() {`);
  assert.notEqual(renamed, source, "game source has a frame entry point");
  return `${renamed}\nfn frame() {\n  ${originalName}();\n${diagnostics.map((line) => `  sound(${line});`).join("\n")}\n}`;
}

function traceDigest(entries) {
  const digest = createTraceDigest();
  for (const entry of entries) digest.add(...entry);
  return digest.result();
}

function createTraceDigest() {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const sample = [];
  const append = (byte) => { hash = ((hash ^ BigInt(byte)) * prime) & mask; };
  let count = 0;
  const add = (name, values) => {
    for (const byte of new TextEncoder().encode(name)) append(byte);
    append(0xff);
    append(values.length & 0xff);
    for (const value of values) {
      const pattern = Number.isNaN(value) ? 0x7fc00000 : Number.parseInt(f32bits(value), 16);
      append(pattern & 0xff);
      append((pattern >>> 8) & 0xff);
      append((pattern >>> 16) & 0xff);
      append((pattern >>> 24) & 0xff);
    }
    count += 1;
    if (sample.length < 6) sample.push([name, ...values.map(f32bits)]);
  };
  return {
    add,
    result: () => ({hash: hash.toString(16), count, sample}),
  };
}

function firstMismatch(actual, expected) {
  const length = Math.min(actual.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const [actualName, actualValues] = actual[index];
    const [expectedName, expectedValues] = expected[index];
    if (actualName !== expectedName || actualValues.length !== expectedValues.length) {
      return {index, actual: actual[index], expected: expected[index]};
    }
    for (let value = 0; value < actualValues.length; value += 1) {
      if (f32bits(actualValues[value]) !== f32bits(expectedValues[value])) {
        return {
          index,
          value,
          actual: [actualName, ...actualValues.map(f32bits)],
          expected: [expectedName, ...expectedValues.map(f32bits)],
        };
      }
    }
  }
  return actual.length === expected.length ? null : {index: length, actual: actual[length], expected: expected[length]};
}

test("C backend exposes the optional header and host ABI while preserving reachable metadata", () => {
  const source = `
    // text: Crate shift
    // text: Push \"carefully\"
    fn dead() { sound(1, 2, 3); }
    fn helper(x) { return x + 1; }
    fn init() {}
    fn frame() { tri(1, 2, 3, 4, 5, 6, 0.1, 0.2, 0.3); return helper(input(0)); }
  `;
  const result = compileCDetailed(source);
  assert.equal(compileC(source), result.code);
  assert.deepEqual(result.functions, ["init", "frame", "helper"]);
  assert.deepEqual(result.imports, ["tri", "input"]);
  assert.deepEqual(result.hostImports, ["slim_tri", "slim_input"]);
  assert.deepEqual(result.texts, ["Crate shift", 'Push "carefully"']);
  assert.match(result.code, /float slim_init\(void\)/);
  assert.match(result.code, /float slim_frame\(void\)/);
  assert.match(result.code, /const uint32_t slim_text_count = 2u/);
  assert.doesNotMatch(result.code, /slim_sound/);
});

test("C backend preserves f32, side effects, short-circuit, lexical scopes, arrays, and host events", {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, ".slim-c-backend-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source = `
    // text: Cross backend
    global order = 0;
    global values = [10, 20];
    fn mark(code, value) { order = order * 10 + code; return value; }
    fn combine(a, b) { return a * 10 + b; }
    fn init() { order = 0; }
    fn frame() {
      let callValue = combine(mark(1, 2), mark(2, 3));
      let skippedAnd = 0 && input(9);
      let skippedOr = 1 || input(10);
      let rounded = (16777216 + 1) - 16777216;
      if (1) { let branch = 2; callValue = callValue + branch; }
      else { let branch = 3; callValue = callValue + branch; }
      { let order = 100; callValue = callValue + order; }
      values[input(1)] = input(2);
      let nanValue = input(0);
      if (nanValue) { callValue = callValue + 1; }
      let minZero = min(0, -0);
      let maxZero = max(0, -0);
      let remainder = -5 % 3;
      let mathValue = sin(0) + cos(0) + atan2(0, 1) + pow(2, 1);
      tri(callValue, values[1], order, rounded, minZero, maxZero, remainder, mathValue, sqrt(abs(-4)));
      sound(1, callValue, 0.25);
      text(0, 10, 20, 12, 1);
      return callValue + values[1] + order + skippedAnd + skippedOr + rounded + remainder;
    }
  `;
  const generated = compileCDetailed(source);
  assert.ok(generated.hostImports.includes("slim_trap"));
  const native = await compileAndRunNative(generated.code, directory, "focused", {inputMode: 1, frames: 1});
  const actual = decodeNativeTrace(native.bytes);
  const expected = wasmTrace(source, {inputMode: 1, frames: 1});
  const mismatch = firstMismatch(actual, expected);
  assert.equal(mismatch, null, `first native/WASM trace mismatch: ${JSON.stringify(mismatch)}`);
  const inputIds = actual.filter(([name]) => name === "input").map(([, args]) => f32bits(args[0]));
  assert.deepEqual(inputIds, ["3f800000", "40000000", "00000000"], "short-circuited input calls do not run");
  const triangle = actual.find(([name]) => name === "tri");
  assert.equal(f32bits(triangle[1][4]), "80000000", "min(0, -0) preserves negative zero");
  assert.equal(f32bits(triangle[1][5]), "00000000", "max(0, -0) preserves positive zero");
});

test("C generated from every example matches the WASM event trace", {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, ".slim-c-examples-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const examples = readdirSync(join(repo, "examples")).filter((name) => name.endsWith(".slim")).sort();
  for (const [index, name] of examples.entries()) {
    const source = readFileSync(join(repo, "examples", name), "utf8");
    const generated = compileCDetailed(source);
    const native = await compileAndRunNative(generated.code, directory, `example-${index}`);
    assert.equal(native.status, 0, `${name} native replay exited with ${native.status}`);
    const actual = decodeNativeTrace(native.bytes);
    const expected = wasmTrace(source);
    const actualDigest = traceDigest(actual);
    const expectedDigest = traceDigest(expected);
    const mismatch = firstMismatch(actual, expected);
    assert.equal(mismatch, null, `${name} native/WASM trace hash ${actualDigest.hash}/${expectedDigest.hash}; first mismatch: ${JSON.stringify(mismatch)}`);
  }
});

test("native backend wins Shardbound and Blockbound and restarts Rainbow wins and losses", {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, ".slim-c-replays-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

  const replayAndCompare = async (name, source, inputSchedule) => {
    const generated = compileCDetailed(source);
    const native = await compileAndRunNative(generated.code, directory, name, {
      frames: inputSchedule.length,
      inputSchedule,
    });
    assert.equal(native.status, 0, `${name} native replay must finish normally`);
    const result = compareNativeWasmTrace(source, native.bytes, {
      frames: inputSchedule.length,
      inputSchedule,
    });
    assert.equal(
      result.mismatch,
      null,
      `${name} event digest ${result.actualDigest.hash}/${result.expectedDigest.hash}; first mismatch ${JSON.stringify(result.mismatch)}`,
    );
    return result;
  };

  const shardSource = readFileSync(join(repo, "examples", "shardbound.slim"), "utf8");
  const shardSchedule = replayInputSchedule(shardboundWinningReplay);
  assert.equal(shardSchedule.length, 1012, "the source replay expands to its verified tick count");
  appendInputFrame(shardSchedule, {9: 1});
  const shardInstrumented = instrumentFrame(shardSource, "shardbound_native_replay", [
    "99, player_x, player_y",
    "98, current_level, state",
    "97, gem_count, transition_timer",
  ]);
  const shard = await replayAndCompare("shardbound-win", shardInstrumented, shardSchedule);
  const shardStates = [];
  // The compact digest is enough for parity; replay status is independently
  // checked by a short instrumented WASM run below using the same schedule.
  void shard;
  const shardWasmModule = new WebAssembly.Module(compileDetailed(shardInstrumented).wasm);
  const shardHost = makeHost((name, values) => {
    if (name === "sound" && values[0] === 98) shardStates.push({level: values[1], state: values[2]});
  }, 0, shardSchedule);
  const shardExports = new WebAssembly.Instance(shardWasmModule, wasmImports(shardWasmModule, shardHost)).exports;
  shardExports.init();
  for (let frame = 0; frame < shardSchedule.length; frame += 1) {
    shardHost.setFrame(frame);
    shardExports.frame();
  }
  assert.ok(shardStates.some(({state}) => state === 1), "Shardbound winning route reaches the win state");
  assert.ok(shardStates.some(({level}) => level === 1), "Shardbound route reaches level two");
  assert.ok(shardStates.some(({level}) => level === 2), "Shardbound route reaches level three");
  assert.equal(shardStates.at(-1).state, 0, "restart after the win returns to play");

  const blockSource = readFileSync(join(repo, "examples", "blockbound.slim"), "utf8");
  const blockSchedule = replayInputSchedule(blockboundWinningReplay);
  appendInputFrame(blockSchedule, {9: 1});
  const blockInstrumented = instrumentFrame(blockSource, "blockbound_native_replay", [
    "99, player_x, player_y",
    "98, player_vy, state",
    "97, camera_x, player_ground",
  ]);
  await replayAndCompare("blockbound-win", blockInstrumented, blockSchedule);
  const blockStates = [];
  const blockModule = new WebAssembly.Module(compileDetailed(blockInstrumented).wasm);
  const blockHost = makeHost((name, values) => {
    if (name === "sound" && values[0] === 98) blockStates.push(values[2]);
  }, 0, blockSchedule);
  const blockExports = new WebAssembly.Instance(blockModule, wasmImports(blockModule, blockHost)).exports;
  blockExports.init();
  for (let frame = 0; frame < blockSchedule.length; frame += 1) {
    blockHost.setFrame(frame);
    blockExports.frame();
  }
  assert.equal(blockStates.at(-2), 1, "Blockbound winning route reaches the beacon");
  assert.equal(blockStates.at(-1), 0, "restart after the win returns to play");

  const rainbowSource = readFileSync(join(repo, "examples", "rainbow.slim"), "utf8");
  const rainbowInstrumented = instrumentFrame(rainbowSource, "rainbow_native_replay", ["98, state, player_x"]);
  const rainbowWin = [
    {4: 1, 8: 1, 6: 180, 7: 160},
    {4: 1, 8: 1, 6: 400, 7: 290},
    {4: 1, 8: 1, 6: 620, 7: 420},
    {},
    {9: 1},
  ];
  await replayAndCompare("rainbow-win-restart", rainbowInstrumented, rainbowWin);
  const rainbowLoss = [
    ...Array.from({length: 24}, () => ({4: 1, 8: 1, 6: 120, 7: 78})),
    {9: 1},
  ];
  await replayAndCompare("rainbow-loss-restart", rainbowInstrumented, rainbowLoss);
});

test("native C backend replays all six Boxpush levels with input, undo, reset, and win", {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, ".slim-c-boxpush-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

  const source = readFileSync(join(repo, "examples", "boxpush.slim"), "utf8");
  const replay = makeBoxpushReplay(source);
  const instrumented = instrumentBoxpushFrame(source);
  const native = await compileAndRunNative(compileC(instrumented), directory, "boxpush-all-levels", {
    frames: replay.schedule.length,
    inputSchedule: replay.schedule,
    checkpointOnly: true,
  });
  assert.equal(native.status, 0, "native Boxpush route completes without a bounds trap");

  const entries = decodeNativeTrace(native.bytes);
  const comparison = compareNativeWasmTrace(instrumented, native.bytes, {
    frames: replay.schedule.length,
    inputSchedule: replay.schedule,
    checkpointOnly: true,
  });
  assert.equal(
    comparison.mismatch,
    null,
    `Boxpush checkpoint trace ${comparison.actualDigest.hash}/${comparison.expectedDigest.hash}; first mismatch ${JSON.stringify(comparison.mismatch)}`,
  );

  const rows = decodeBoxpushCheckpoints(entries);
  assert.equal(rows.length, replay.schedule.length, "native checkpoints cover every simulated frame");
  const at = (name) => {
    const frame = replay.milestones.get(name);
    assert.notEqual(frame, undefined, `replay records milestone ${name}`);
    return rows[frame];
  };

  const locked = at("locked-level-attempt");
  assert.equal(locked.state, 3, "a locked card stays in the level menu");
  assert.equal(locked.cursor, 1);
  assert.equal(locked.unlocked, 1);
  const opened = at("level-1-open");
  assert.equal(opened.state, 0);
  assert.equal(opened.level, 0);

  const firstMove = at("first-move");
  assert.equal(firstMove.moves, 1, "a real directional tap records one move");
  assert.notEqual(firstMove.player, replay.levels[0].start);
  const undone = at("after-undo");
  assert.equal(undone.state, 0);
  assert.equal(undone.moves, 0, "Space undoes the move");
  assert.equal(undone.player, replay.levels[0].start);
  assert.equal(undone.crateHash, boxpushCheckpointHash(replay.levels[0]), "undo restores the crate layout");
  const reset = at("after-reset");
  assert.equal(reset.state, 0);
  assert.equal(reset.moves, 0, "R resets the move history");
  assert.equal(reset.player, replay.levels[0].start);
  assert.equal(reset.crateHash, boxpushCheckpointHash(replay.levels[0]));

  for (let levelIndex = 0; levelIndex < replay.levels.length; levelIndex += 1) {
    const number = levelIndex + 1;
    const clear = at(`level-${number}-clear`);
    assert.equal(clear.state, 1, `level ${number} reaches the clear screen`);
    assert.equal(clear.level, levelIndex);
    assert.equal(clear.covered, replay.levels[levelIndex].boxes.length, `level ${number} covers every crate`);
    assert.equal(clear.moves, replay.solutions[levelIndex].moves.length, `level ${number} follows the solver route`);
    assert.equal(clear.best, clear.moves, `level ${number} stores its best move count`);
    assert.equal(clear.unlocked, Math.min(number + 1, replay.levels.length), `level ${number} unlocks the next card`);

    const early = at(`level-${number}-early-action`);
    assert.equal(early.state, 1, `Space cannot skip level ${number}'s clear transition`);
    const next = at(`level-${number}-advance`);
    if (levelIndex < replay.levels.length - 1) {
      assert.equal(next.state, 0);
      assert.equal(next.level, levelIndex + 1);
    } else {
      assert.equal(next.state, 2, "clearing level 6 wins the game");
      assert.equal(next.level, levelIndex);
    }
  }

  const wonMenu = at("win-menu");
  assert.equal(wonMenu.state, 3, "M returns from the win screen to level select");
  assert.equal(wonMenu.cursor, 0);
  assert.equal(wonMenu.unlocked, 6);
  const selected = at("level-6-selected");
  assert.equal(selected.cursor, 5, "arrow taps select the final unlocked level");
  const reopened = at("level-6-reopened");
  assert.equal(reopened.state, 0);
  assert.equal(reopened.level, 5);
  assert.equal(reopened.player, replay.levels[5].start);
  const playMenu = at("play-menu");
  assert.equal(playMenu.state, 3, "M returns from play to the level menu");
  assert.equal(playMenu.cursor, 5);
});

test("dynamic array checks trap before assignment values and accept negative zero", {skip: !nativeCompilerAvailable}, async (t) => {
  const directory = await mkdtemp(join(repo, ".slim-c-bounds-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const valid = `global values = [31, 47]; fn init() {} fn frame() { return values[input(0)]; }`;
  const validNative = await compileAndRunNative(compileC(valid), directory, "valid-index", {inputMode: 2, frames: 1});
  const validEntries = decodeNativeTrace(validNative.bytes);
  assert.equal(f32bits(validEntries.at(-1)[1][0]), f32bits(31));
  assert.deepEqual(validEntries.filter(([name]) => name === "input").map(([name, args]) => [name, f32bits(args[0])]), [["input", "00000000"]]);

  const invalid = `global values = [10, 20]; fn init() {} fn frame() { values[input(0)] = input(1); }`;
  const invalidNative = await compileAndRunNative(compileC(invalid), directory, "invalid-index", {inputMode: 1, frames: 1});
  assert.equal(invalidNative.status, 86, "invalid native access exits through slim_trap");
  const invalidEntries = decodeNativeTrace(invalidNative.bytes);
  assert.deepEqual(invalidEntries.map(([name]) => name), ["initResult", "input", "trap"], "the invalid assignment skips its RHS");

  const invalidWasm = compileDetailed(invalid).wasm;
  const events = [];
  const host = makeHost((name, values) => events.push([name, values]), 1);
  const module = new WebAssembly.Module(invalidWasm);
  const exports = new WebAssembly.Instance(module, wasmImports(module, host)).exports;
  exports.init();
  assert.throws(() => exports.frame(), WebAssembly.RuntimeError);
  assert.deepEqual(events.map(([name]) => name), ["input"], "WASM also skips the assignment RHS");
});
