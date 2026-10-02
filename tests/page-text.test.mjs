import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const buildTool = fileURLToPath(new URL('../tools/build.mjs', import.meta.url));
const body = 'fn init() {}\nfn frame() { tri(0, 0, 10, 0, 0, 10, 1, 1, 1); }\n';

// Build a tiny game and return the generated native-JS page.
async function pageFor(name, header, flags = []) {
  const dir = await mkdtemp(join(tmpdir(), 'slim-page-text-'));
  try {
    const source = join(dir, `${name}.slim`);
    await writeFile(source, header + body);
    const result = spawnSync(process.execPath, [buildTool, source, '--out-dir', join(dir, 'out'), '--keyboard-only', ...flags], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    return await readFile(join(dir, 'out', `${name}.js.html`), 'utf8');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

test('a game names its own footer and title with comment lines', async () => {
  const page = await pageFor('night-shift', '// title: Night Shift\n// footer: Arrows: push · R: redo\n');
  assert.match(page, /<title>Night Shift<\/title>/);
  assert.ok(page.includes('Arrows: push · R: redo'), 'footer text from the source comment');
  assert.ok(!page.includes('Space: jump'), 'host default footer is replaced');
});

test('command-line --footer and --title override the source comments', async () => {
  const page = await pageFor('night-shift', '// title: Night Shift\n// footer: from source\n', ['--title', 'Override', '--footer', 'from flag']);
  assert.match(page, /<title>Override<\/title>/);
  assert.ok(page.includes('from flag'));
  assert.ok(!page.includes('from source'));
});

test('without any text the title comes from the file name and the host footer stays', async () => {
  const page = await pageFor('night-shift', '');
  assert.match(page, /<title>Night Shift<\/title>/);
  assert.ok(page.includes('Space: jump'), 'default keyboard footer');
});

// ---- the `text` builtin and the page that draws it -------------------------

const textGame = '// text: Hello <b>\n// text: Second line\nfn init() {}\nfn frame() { text(1, 10, 20, 30, 1); text(0, input(10) * 100, 5, 12, 0); }\n';

async function buildPage(name, source, flags = []) {
  const dir = await mkdtemp(join(tmpdir(), 'slim-text-'));
  try {
    const file = join(dir, `${name}.slim`);
    await writeFile(file, source);
    const result = spawnSync(process.execPath, [buildTool, file, '--out-dir', join(dir, 'out'), '--keyboard-only', ...flags], {encoding: 'utf8', windowsHide: true});
    return {result, html: result.status === 0 ? await readFile(join(dir, 'out', `${name}.js.html`), 'utf8') : ''};
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

test('// text: lines become escaped templates, with an overlay canvas', async () => {
  const {result, html} = await buildPage('words', textGame);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(html, /<template id=t0>Hello &lt;b&gt;<\/template>/);
  assert.match(html, /<template id=t1>Second line<\/template>/);
  assert.match(html, /<canvas id=o /);
});

test('a game that draws text without any // text: lines fails to build', async () => {
  const {result} = await buildPage('words', 'fn init() {}\nfn frame() { text(0, 1, 2, 3, 0); }\n');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /no texts|\/\/ text:/);
});

test('games without text get no overlay canvas or templates', async () => {
  const {result, html} = await buildPage('plain', 'fn init() {}\nfn frame() { tri(0, 0, 10, 0, 0, 10, 1, 1, 1); }\n');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(!html.includes('<template') && !html.includes('id=o'));
});

test('the text host reads templates once, draws with tone and size, and clears each tick', async () => {
  const {result, html} = await buildPage('words', textGame);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const calls = [];
  let lookups = 0;
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : (...args) => { calls.push([key, ...args]); }),
    set: (target, key, value) => { target[key] = value; calls.push(['set', key, value]); return true; },
  });
  const overlay = {getContext: () => ctx, getBoundingClientRect: () => ({width: 400, height: 300})};
  const listeners = {};
  let frameCallback;
  const context = vm.createContext({
    document: {
      querySelector: () => ({addEventListener() {}, getBoundingClientRect: () => ({left: 0, top: 0, width: 800, height: 600})}),
      getElementById: (id) => {
        if (id === 'o') return overlay;
        lookups += 1;
        return {content: {textContent: id === 't1' ? 'Hello <b>' : 'Second line'}};
      },
    },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    requestAnimationFrame: (fn) => { frameCallback = fn; },
    performance: {now: () => 0},
    devicePixelRatio: 2,
    Promise, Math, Float32Array,
  });
  vm.runInContext(script, context);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(frameCallback, 'the game started');
  assert.equal(calls.find((c) => c[0] === 'setTransform')[1], 800 / 800, 'overlay is scaled to the 800x600 game space (400 css px x 2 dpr)');
  calls.length = 0;
  frameCallback(17);
  assert.deepEqual(calls.find((c) => c[0] === 'clearRect'), ['clearRect', 0, 0, 800, 600], 'cleared before the tick');
  const fill = calls.find((c) => c[0] === 'fillText' && c[1] === 'Hello <b>');
  assert.deepEqual(fill, ['fillText', 'Hello <b>', 10, 20], 'template text, unescaped by the browser');
  assert.ok(calls.some((c) => c[0] === 'set' && c[1] === 'font' && /30px/.test(c[2])), 'size from the argument');
  assert.ok(calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === '#f4c04a'), 'tone 1 is gold');
  const before = lookups;
  frameCallback(34);
  assert.equal(lookups, before, 'templates are cached after the first draw');
  // Escape and M set the menu flag for exactly one tick.
  listeners.keydown({key: 'Escape', preventDefault() {}, repeat: false, code: 'Escape'});
  calls.length = 0;
  frameCallback(51);
  assert.ok(calls.some((c) => c[0] === 'fillText' && c[1] === 'Hello <b>' || c[0] === 'fillText' && c[1] === 'Second line' && c[2] === 100), 'input(10) was 1 during the tick');
  calls.length = 0;
  frameCallback(68);
  assert.ok(calls.some((c) => c[0] === 'fillText' && c[1] === 'Second line' && c[2] === 0), 'and 0 on the next tick');
});
