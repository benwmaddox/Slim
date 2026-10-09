import {gzipSync} from 'node:zlib';
import {readFile, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileDetailed} from '../src/compiler.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log('Usage: node tools/export-svg.mjs source.slim [--out FILE] [--seconds N] [--fps N] [--quantize N] [--title TEXT] [--inputs FILE] [--gzip]');
}

function safeStem(source) {
  const raw = basename(source, extname(source));
  const stem = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return stem || 'game';
}

function parsePositiveNumber(value, flag) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} requires a positive number`);
  return number;
}

function parseArgs(argv) {
  let source;
  let output;
  let seconds = 4;
  let fps = 8;
  let quantize = 2;
  let title;
  let inputs;
  let gzip = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      usage();
      process.exit(0);
    }
    if (argument === '--gzip') {
      gzip = true;
      continue;
    }
    const valueFor = (flag) => {
      const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : argv[++index];
      if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
      return value;
    };
    if (argument === '--out' || argument.startsWith('--out=')) {
      output = valueFor('--out');
      continue;
    }
    if (argument === '--seconds' || argument.startsWith('--seconds=')) {
      seconds = parsePositiveNumber(valueFor('--seconds'), '--seconds');
      continue;
    }
    if (argument === '--fps' || argument.startsWith('--fps=')) {
      fps = parsePositiveNumber(valueFor('--fps'), '--fps');
      if (!Number.isInteger(fps) || fps > 60) throw new Error('--fps must be an integer from 1 to 60');
      continue;
    }
    if (argument === '--quantize' || argument.startsWith('--quantize=')) {
      quantize = parsePositiveNumber(valueFor('--quantize'), '--quantize');
      continue;
    }
    if (argument === '--title' || argument.startsWith('--title=')) {
      title = valueFor('--title');
      continue;
    }
    if (argument === '--inputs' || argument.startsWith('--inputs=')) {
      inputs = valueFor('--inputs');
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`unknown option ${argument}`);
    if (source) throw new Error(`unexpected extra source argument ${argument}`);
    source = argument;
  }

  const sourcePath = resolve(root, source || 'examples/rainbow.slim');
  const stem = safeStem(sourcePath);
  return {
    source: sourcePath,
    output: resolve(root, output || `dist/${stem}.svg`),
    seconds,
    fps,
    quantize,
    title: title || stem,
    inputs: inputs ? resolve(root, inputs) : undefined,
    gzip,
  };
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new RangeError(`SVG export received a non-finite ${label}`);
  return value;
}

function quantized(value, step) {
  const result = Math.round(finite(value, 'coordinate') / step) * step;
  return Object.is(result, -0) ? 0 : result;
}

function numberText(value) {
  if (Object.is(value, -0)) return '0';
  return String(value);
}

function colorChannel(value) {
  const channel = Math.max(0, Math.min(255, Math.round(finite(value, 'color') * 255)));
  return channel.toString(16).padStart(2, '0');
}

function colorText(triangle) {
  return `#${colorChannel(triangle[6])}${colorChannel(triangle[7])}${colorChannel(triangle[8])}`;
}

function pointValues(triangle, step) {
  if (!triangle) return null;
  const points = [];
  for (let index = 0; index < 6; index += 2) {
    points.push(quantized(triangle[index], step), quantized(triangle[index + 1], step));
  }
  return points;
}

function stablePointFrames(pointFrames) {
  const result = pointFrames.slice();
  let next = null;
  for (let index = result.length - 1; index >= 0; index -= 1) {
    if (result[index]) {
      next = result[index];
    } else if (next) {
      result[index] = next;
    }
  }
  let previous = null;
  for (let index = 0; index < result.length; index += 1) {
    if (result[index]) {
      previous = result[index];
    } else if (previous) {
      result[index] = previous;
    }
  }
  return result;
}

function translationValues(pointFrames) {
  const base = pointFrames[0];
  if (!base) return null;
  let moved = false;
  const values = [];
  for (const points of pointFrames) {
    if (!points) return null;
    const dx = points[0] - base[0];
    const dy = points[1] - base[1];
    if (dx !== 0 || dy !== 0) moved = true;
    for (let index = 0; index < points.length; index += 2) {
      if (points[index] - base[index] !== dx || points[index + 1] - base[index + 1] !== dy) return null;
    }
    values.push(`${numberText(dx)} ${numberText(dy)}`);
  }
  return moved ? values : null;
}

function triangleColors(frames, index) {
  return frames.map((frame) => frame[index] ? colorText(frame[index]) : null);
}

function sameValues(values) {
  return values.every((value) => value === values[0]);
}

function xmlText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

function animate(attribute, values, duration, calcMode) {
  const mode = calcMode ? ` calcMode="${calcMode}"` : '';
  return `<animate attributeName="${attribute}" dur="${numberText(duration)}s" repeatCount="indefinite" values="${values.join(';')}"${mode}/>`;
}

function animateTransform(type, values, duration) {
  return `<animateTransform attributeName="transform" type="${type}" dur="${numberText(duration)}s" repeatCount="indefinite" values="${values.join(';')}"/>`;
}

function pointsText(points) {
  return points
    ? `${numberText(points[0])},${numberText(points[1])} ${numberText(points[2])},${numberText(points[3])} ${numberText(points[4])},${numberText(points[5])}`
    : '0,0 0,0 0,0';
}

function affineFromTriangles(base, target) {
  const ux = base[2] - base[0];
  const uy = base[3] - base[1];
  const vx = base[4] - base[0];
  const vy = base[5] - base[1];
  const determinant = ux * vy - vx * uy;
  if (Math.abs(determinant) < 1e-6) return null;
  const tx = target[2] - target[0];
  const ty = target[3] - target[1];
  const sx = target[4] - target[0];
  const sy = target[5] - target[1];
  const a = (tx * vy - uy * sx) / determinant;
  const c = (ux * sx - tx * vx) / determinant;
  const b = (ty * vy - uy * sy) / determinant;
  const d = (ux * sy - ty * vx) / determinant;
  return [a, b, c, d, target[0] - a * base[0] - c * base[1], target[1] - b * base[0] - d * base[1]];
}

function applyAffine(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

function transformNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return numberText(Object.is(rounded, -0) ? 0 : rounded);
}

function groupTransformValues(frames, groups, indices, groupId) {
  if (indices.length < 2) return null;
  const baseGroups = groups[0] ?? [];
  const anchor = indices.find((index) => {
    const triangle = frames[0]?.[index];
    return baseGroups[index] === groupId && triangle && affineFromTriangles(triangle, triangle);
  });
  if (anchor === undefined) return null;
  const matrices = [];
  let moved = false;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const frameGroups = groups[frameIndex] ?? [];
    if (indices.some((index) => frameGroups[index] !== groupId || !frame?.[index])) return null;
    const matrix = affineFromTriangles(frames[0][anchor], frame[anchor]);
    if (!matrix) return null;
    for (const index of indices) {
      const base = frames[0][index];
      const target = frame[index];
      for (let point = 0; point < 6; point += 2) {
        const predicted = applyAffine(matrix, base[point], base[point + 1]);
        if (Math.abs(predicted[0] - target[point]) > 1e-3 || Math.abs(predicted[1] - target[point + 1]) > 1e-3) return null;
      }
    }
    if (Math.abs(matrix[0] - 1) > 1e-4 || Math.abs(matrix[1]) > 1e-4 || Math.abs(matrix[2]) > 1e-4 || Math.abs(matrix[3] - 1) > 1e-4 || Math.abs(matrix[4]) > 1e-4 || Math.abs(matrix[5]) > 1e-4) {
      moved = true;
    }
    matrices.push(matrix);
  }
  if (!moved) return null;
  const translationOnly = matrices.every((matrix) => (
    Math.abs(matrix[0] - 1) <= 1e-4
    && Math.abs(matrix[1]) <= 1e-4
    && Math.abs(matrix[2]) <= 1e-4
    && Math.abs(matrix[3] - 1) <= 1e-4
  ));
  if (translationOnly) {
    return {
      type: 'translate',
      values: matrices.map((matrix) => `${transformNumber(matrix[4])} ${transformNumber(matrix[5])}`),
    };
  }
  const similarity = matrices.every((matrix) => {
    const scale = Math.hypot(matrix[0], matrix[1]);
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    return Number.isFinite(scale)
      && scale > 1e-4
      && Math.abs(matrix[2] + matrix[1]) <= 1e-3
      && Math.abs(matrix[3] - matrix[0]) <= 1e-3
      && determinant > 0
      && Math.abs(determinant - scale * scale) <= 1e-3;
  });
  if (!similarity) return null;
  return {
    type: 'similarity',
    translate: matrices.map((matrix) => `${transformNumber(matrix[4])} ${transformNumber(matrix[5])}`),
    rotate: matrices.map((matrix) => transformNumber(Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI)),
    scale: matrices.map((matrix) => transformNumber(Math.hypot(matrix[0], matrix[1]))),
  };
}

function renderGroupTransform(plan, children, duration) {
  if (plan.type === 'translate') {
    return `<g>${animateTransform('translate', plan.values, duration)}${children}</g>`;
  }
  return `<g>${animateTransform('translate', plan.translate, duration)}<g>${animateTransform('rotate', plan.rotate, duration)}<g>${animateTransform('scale', plan.scale, duration)}${children}</g></g></g>`;
}

function normalizeInputSchedule(schedule) {
  if (schedule === undefined || schedule === null) return [];
  if (!Array.isArray(schedule)) throw new TypeError('inputSchedule must be an array of frame values');
  return schedule.map((frame, frameIndex) => {
    const values = [];
    if (Array.isArray(frame)) {
      for (let index = 0; index < frame.length; index += 1) {
        const value = Number(frame[index]);
        if (!Number.isFinite(value)) throw new TypeError(`inputSchedule frame ${frameIndex} index ${index} must be finite`);
        values[index] = value;
      }
      return values;
    }
    if (!frame || typeof frame !== 'object') {
      throw new TypeError(`inputSchedule frame ${frameIndex} must be an array or object`);
    }
    for (const [rawIndex, rawValue] of Object.entries(frame)) {
      const index = Number(rawIndex);
      const value = Number(rawValue);
      if (!Number.isInteger(index) || index < 0) throw new TypeError(`inputSchedule frame ${frameIndex} has invalid index ${JSON.stringify(rawIndex)}`);
      if (!Number.isFinite(value)) throw new TypeError(`inputSchedule frame ${frameIndex} index ${index} must be finite`);
      values[index] = value;
    }
    return values;
  });
}

/**
 * Capture a deterministic WASM frame stream from Slim source.
 *
 * The host supplies zero input by default. An optional inputSchedule array
 * overrides the values for each sampled frame. SVG capture also tags each tri
 * call site and records svg_group markers; both are absent from game builds.
 */
export function captureFrames(source, options = {}) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('source must be a non-empty Slim program');
  const fps = options.fps ?? 8;
  const seconds = options.seconds ?? 4;
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new RangeError('fps must be an integer from 1 to 60');
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError('seconds must be positive');
  const frameCount = Math.max(1, Math.round(seconds * fps));
  const inputSchedule = normalizeInputSchedule(options.inputSchedule);
  let triangles = [];
  let names = [];
  let groups = [];
  let currentGroup = 0;
  const recordTriangle = (name, values) => {
    triangles.push(values.map(Number));
    names.push(Number(name));
    groups.push(currentGroup);
    return 0;
  };
  let currentInputs = inputSchedule[0] ?? [];
  const host = {
    tri: (...values) => recordTriangle(0, values),
    svg_tri: (name, ...values) => recordTriangle(name, values),
    sound: () => 0,
    input: (index) => currentInputs[index] ?? 0,
    svg_group: (id) => {
      currentGroup = Number(id);
      return 0;
    },
  };
  const detailed = compileDetailed(source, {svgMetadata: true});
  const module = new WebAssembly.Module(detailed.wasm);
  const instance = new WebAssembly.Instance(module, {e: host});
  if (typeof instance.exports.init !== 'function' || typeof instance.exports.frame !== 'function') {
    throw new Error('SVG export requires init and frame exports');
  }
  instance.exports.init();
  const frames = [];
  const nameFrames = [];
  const groupFrames = [];
  for (let index = 0; index < frameCount; index += 1) {
    currentInputs = inputSchedule[index] ?? [];
    currentGroup = 0;
    triangles = [];
    names = [];
    groups = [];
    instance.exports.frame();
    frames.push(triangles);
    nameFrames.push(names);
    groupFrames.push(groups);
  }
  if (!frames.length || !frames[0].length) throw new Error('SVG export captured no triangles');
  const triangleCount = Math.max(...frames.map((frame) => frame.length));
  return {frames, names: nameFrames, groups: groupFrames, triangleCount, fps, seconds, detailed, inputSchedule};
}

function alignNamedFrames(capture) {
  const {frames, names, groups} = capture;
  if (!Array.isArray(names) || names.length !== frames.length || names.some((frame) => !Array.isArray(frame))) {
    return {frames, groups, triangleCount: capture.triangleCount, named: false};
  }
  const order = [];
  const seen = new Set();
  const frameKeys = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const counts = new Map();
    const keys = [];
    for (let index = 0; index < frames[frameIndex].length; index += 1) {
      const name = Number(names[frameIndex][index] ?? 0);
      const group = Number(groups?.[frameIndex]?.[index] ?? 0);
      const identity = group !== 0 ? `group:${group}` : `call:${name}`;
      const occurrence = counts.get(identity) ?? 0;
      counts.set(identity, occurrence + 1);
      const key = `${identity}:${occurrence}`;
      keys.push(key);
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    frameKeys.push(keys);
  }
  const alignedFrames = [];
  const alignedGroups = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const values = new Map();
    const frameGroups = groups?.[frameIndex] ?? [];
    for (let index = 0; index < frameKeys[frameIndex].length; index += 1) {
      values.set(frameKeys[frameIndex][index], {
        triangle: frames[frameIndex][index],
        group: frameGroups[index] ?? 0,
      });
    }
    alignedFrames.push(order.map((key) => values.get(key)?.triangle ?? null));
    alignedGroups.push(order.map((key) => values.get(key)?.group ?? 0));
  }
  return {frames: alignedFrames, groups: alignedGroups, triangleCount: order.length, named: true};
}

/**
 * Turn captured triangles into a standalone SMIL SVG.
 *
 * Static slots remain ordinary polygons. Moving slots get either one compact
 * translation animation or one points animation. Export-only call-site
 * identities keep conditional draw calls aligned when off-screen objects
 * enter or leave the painter stream.
 */
export function framesToSvg(capture, options = {}) {
  const aligned = alignNamedFrames(capture);
  const {frames, triangleCount, fps, seconds} = {...capture, ...aligned};
  const step = options.quantize ?? 2;
  const title = options.title ?? 'Slim game replay';
  if (!Number.isFinite(step) || step <= 0) throw new RangeError('quantize must be positive');
  const sampleFrames = [...frames, frames[0]];
  const palette = [];
  const paletteIndex = new Map();
  const classFor = (color) => {
    if (!paletteIndex.has(color)) {
      paletteIndex.set(color, palette.length);
      palette.push(color);
    }
    return `c${paletteIndex.get(color)}`;
  };
  let staticTriangles = 0;
  let animatedTriangles = 0;
  let animatedProperties = 0;
  let translatedTriangles = 0;
  let groupTransforms = 0;
  const elements = [];
  const rawGroups = aligned.groups ?? frames.map(() => []);
  const sampleGroups = [...rawGroups, rawGroups[0] ?? []];
  const dataCache = new Map();
  const triangleData = (index) => {
    if (!dataCache.has(index)) {
      const pointFrames = stablePointFrames(sampleFrames.map((frame) => pointValues(frame[index], step)));
      const geometry = pointFrames.map(pointsText);
      const colors = triangleColors(sampleFrames, index).map((value, colorIndex, values) => value ?? values.find(Boolean) ?? '#000000');
      const present = sampleFrames.map((frame) => frame[index] ? '1' : '0');
      dataCache.set(index, {
        pointFrames,
        geometry,
        colors,
        present,
        geometryStatic: sameValues(geometry),
        translation: null,
        colorStatic: sameValues(colors),
        presenceStatic: sameValues(present),
      });
    }
    return dataCache.get(index);
  };
  const renderTriangle = (index, data, grouped = false) => {
    const {geometry, colors, present, geometryStatic, colorStatic, presenceStatic} = data;
    const className = classFor(colors[0]);
    if (!grouped && geometryStatic && colorStatic && presenceStatic) {
      staticTriangles += 1;
      return `<polygon class="${className}" points="${geometry[0]}"/>`;
    }
    const attributes = [`class="${className}"`, `points="${geometry[0]}"`];
    const animations = [];
    if (!grouped && !geometryStatic) {
      if (presenceStatic) data.translation ??= translationValues(data.pointFrames);
      if (data.translation) {
        animations.push(animateTransform('translate', data.translation, seconds));
        translatedTriangles += 1;
      } else {
        animations.push(animate('points', geometry, seconds));
      }
      animatedProperties += 1;
    }
    if (!colorStatic) {
      animations.push(animate('fill', colors, seconds));
      animatedProperties += 1;
    }
    if (!presenceStatic) {
      attributes.push(`opacity="${present[0]}"`);
      // Keep visibility discrete so an entering slot appears at its sampled
      // geometry instead of fading through an intermediate position.
      animations.push(animate('opacity', present, seconds, 'discrete'));
      animatedProperties += 1;
    }
    if (!grouped) animatedTriangles += 1;
    return `<polygon ${attributes.join(' ')}>${animations.join('')}</polygon>`;
  };

  let index = 0;
  while (index < triangleCount) {
    const groupId = sampleGroups[0]?.[index] ?? 0;
    let end = index + 1;
    if (groupId !== 0) {
      while (end < triangleCount && (sampleGroups[0]?.[end] ?? 0) === groupId) end += 1;
    }
    const indices = Array.from({length: end - index}, (_, offset) => index + offset);
    const groupPlan = groupId !== 0 && indices.length > 1
      ? groupTransformValues(sampleFrames, sampleGroups, indices, groupId)
      : null;
    if (groupPlan) {
      const children = indices.map((childIndex) => renderTriangle(childIndex, triangleData(childIndex), true)).join('');
      elements.push(renderGroupTransform(groupPlan, children, seconds));
      animatedTriangles += indices.length;
      animatedProperties += 1;
      groupTransforms += 1;
      index = end;
      continue;
    }

    const data = triangleData(index);
    elements.push(renderTriangle(index, data));
    index += 1;
  }

  const style = palette.map((color, index) => `.c${index}{fill:${color}}`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges"><title>${xmlText(title)}</title><style>${style}</style>${elements.join('')}</svg>`;
  return {
    svg,
    stats: {
      frames: frames.length,
      fps,
      seconds,
      quantize: step,
      triangles: triangleCount,
      staticTriangles,
      animatedTriangles,
      animatedProperties,
      translatedTriangles,
      groupTransforms,
      namedFrames: aligned.named,
      palette: palette.length,
      bytes: Buffer.byteLength(svg),
      gzipBytes: gzipSync(svg).length,
    },
  };
}

export async function exportSvg(source, options = {}) {
  const capture = captureFrames(source, options);
  return framesToSvg(capture, options);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = await readFile(options.source, 'utf8');
  const inputSchedule = options.inputs
    ? JSON.parse(await readFile(options.inputs, 'utf8'))
    : undefined;
  const result = await exportSvg(source, {...options, inputSchedule});
  await writeFile(options.output, result.svg);
  const written = [options.output];
  if (options.gzip) {
    const gzipPath = `${options.output}.gz`;
    await writeFile(gzipPath, gzipSync(result.svg));
    written.push(gzipPath);
  }
  console.log(JSON.stringify({source: options.source, outputs: written, ...result.stats}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
