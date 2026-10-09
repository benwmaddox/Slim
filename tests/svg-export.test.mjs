import test from 'node:test';
import assert from 'node:assert/strict';
import {exportSvg} from '../tools/export-svg.mjs';

test('SVG export keeps static triangles and animates moving triangles', async () => {
  const source = `
    global x = 0;
    fn init() { x = 0; }
    fn frame() {
      x = x + 1;
      tri(x, 0, x + 10, 0, x, 10 + x, 1, 0, 0);
      tri(40, 40, 50, 40, 40, 50, 0, 1, 0);
    }
  `;
  const result = await exportSvg(source, {seconds: 1, fps: 4, quantize: 1, title: '<Replay>'});
  assert.match(result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(result.svg, /<title>&lt;Replay&gt;<\/title>/);
  assert.match(result.svg, /<animate attributeName="points"/);
  assert.equal(result.stats.frames, 4);
  assert.equal(result.stats.triangles, 2);
  assert.equal(result.stats.staticTriangles, 1);
  assert.equal(result.stats.animatedTriangles, 1);
  assert.equal(result.stats.translatedTriangles, 0);
  assert.ok(result.stats.gzipBytes < result.stats.bytes);
});

test('SVG export factors pure translation into animateTransform', async () => {
  const source = `
    global x = 0;
    fn init() { x = 0; }
    fn frame() {
      x = x + 1;
      tri(x, 0, x + 10, 0, x, 10, 1, 0, 0);
    }
  `;
  const result = await exportSvg(source, {seconds: 1, fps: 4, quantize: 1});
  assert.match(result.svg, /<animateTransform attributeName="transform" type="translate"/);
  assert.doesNotMatch(result.svg, /<animate attributeName="points"/);
  assert.equal(result.stats.translatedTriangles, 1);
});

test('SVG export turns semantic groups into one shared transform', async () => {
  const source = `
    global x = 0;
    fn init() { x = 0; }
    fn frame() {
      x = x + 1;
      svg_group(7);
      tri(x, 0, x + 10, 0, x, 10, 1, 0, 0);
      tri(x + 10, 0, x + 20, 0, x + 10, 10, 0, 1, 0);
      svg_group(0);
    }
  `;
  const result = await exportSvg(source, {seconds: 1, fps: 4, quantize: 1});
  assert.match(result.svg, /<g><animateTransform attributeName="transform" type="translate"/);
  assert.equal(result.stats.groupTransforms, 1);
  assert.equal(result.stats.animatedTriangles, 2);
});

test('SVG export uses nested transforms for rotating and scaling groups', async () => {
  const source = `
    global step = 0;
    fn init() { step = 0; }
    fn frame() {
      step = step + 1;
      svg_group(8);
      if (step < 2) {
        tri(0, 0, 10, 0, 0, 10, 1, 0, 0);
        tri(10, 0, 20, 0, 10, 10, 0, 1, 0);
      } else {
        tri(0, 0, 0, 10, -10, 0, 1, 0, 0);
        tri(0, 10, 0, 20, -10, 10, 0, 1, 0);
      }
      svg_group(0);
    }
  `;
  const result = await exportSvg(source, {seconds: 1, fps: 4, quantize: 1});
  assert.match(result.svg, /type="rotate"/);
  assert.match(result.svg, /type="scale"/);
  assert.equal(result.stats.groupTransforms, 1);
  assert.equal(result.stats.animatedTriangles, 2);
});

test('SVG export applies a per-frame input schedule', async () => {
  const source = `
    fn init() {}
    fn frame() {
      let x = input(0) * 10;
      tri(x, 0, x + 10, 0, x, 10, 1, 0, 0);
    }
  `;
  const result = await exportSvg(source, {
    seconds: 1,
    fps: 4,
    quantize: 1,
    inputSchedule: [[], {0: 1}, [], {0: 2}],
  });
  assert.match(result.svg, /values="0 0;10 0;0 0;20 0;0 0"/);
});

test('SVG export handles changing triangle counts with opacity animation', async () => {
  const source = `
    global x = 0;
    fn init() { x = 0; }
    fn frame() {
      x = x + 1;
      tri(0, 0, 10, 0, 0, 10, 0, 0, 1);
      if (x > 1) { tri(20, 20, 30, 20, 20, 30, 1, 1, 0); }
    }
  `;
  const result = await exportSvg(source, {seconds: 1, fps: 4, quantize: 1});
  assert.equal(result.stats.triangles, 2);
  assert.match(result.svg, /<animate attributeName="opacity"/);
  assert.match(result.svg, /attributeName="opacity"[^>]*calcMode="discrete"/);
  assert.doesNotMatch(result.svg, /points="0,0 0,0 0,0"/);
});

test('SVG export aligns conditional draw calls by call-site identity', async () => {
  const source = `
    global step = 0;
    fn init() { step = 0; }
    fn frame() {
      step = step + 1;
      if (step < 2) {
        tri(20, 20, 30, 20, 20, 30, 1, 0, 0);
        tri(60, 20, 70, 20, 60, 30, 0, 1, 0);
      } else {
        tri(60, 20, 70, 20, 60, 30, 0, 1, 0);
        tri(20, 20, 30, 20, 20, 30, 1, 0, 0);
      }
    }
  `;
  const result = await exportSvg(source, {seconds: 1, fps: 4, quantize: 1});
  assert.equal(result.stats.triangles, 4);
  assert.doesNotMatch(result.svg, /values="20,20 30,20 20,30;60,20 70,20 60,30/);
  assert.doesNotMatch(result.svg, /values="60,20 70,20 60,30;20,20 30,20 20,30/);
});
