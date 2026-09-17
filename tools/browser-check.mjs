import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname, extname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  if (value) return value.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

const dist = resolve(option('dist') || process.env.SLIM_DIST || join(root, 'dist'));
const output = resolve(option('output') || process.env.SLIM_BROWSER_OUTPUT || join(root, 'output', 'browser-check'));
const requestedBrowsers = (option('browsers') || process.env.SLIM_BROWSERS || 'chromium,firefox')
  .split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
const allowMissing = hasFlag('allow-missing');
const timeoutMs = Number(option('timeout') || process.env.SLIM_BROWSER_TIMEOUT || 8000);

function fail(message) {
  throw new Error(message);
}

function asAbsolute(value) {
  if (!value) return value;
  return isAbsolute(value) ? value : resolve(root, value);
}

async function firstExisting(paths) {
  for (const candidate of paths) if (candidate && existsSync(candidate)) return candidate;
  return undefined;
}

async function playwrightCandidates() {
  const candidates = [];
  const configured = process.env.SLIM_PLAYWRIGHT_MODULE;
  if (configured) {
    const configuredPath = asAbsolute(configured);
    if (existsSync(configuredPath)) {
      const item = await stat(configuredPath);
      candidates.push(item.isDirectory() ? join(configuredPath, 'index.mjs') : configuredPath);
    } else {
      candidates.push(configuredPath);
    }
  }
  candidates.push(join(root, 'node_modules', 'playwright', 'index.mjs'));

  // The repository deliberately has no browser dependency.  In development,
  // a cached npx Playwright is still useful when its path was not configured.
  const cacheRoot = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm-cache', '_npx');
  if (cacheRoot && existsSync(cacheRoot)) {
    const entries = await readdir(cacheRoot, {withFileTypes: true});
    entries.sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(join(cacheRoot, entry.name, 'node_modules', 'playwright', 'index.mjs'));
    }
  }
  return candidates;
}

async function loadPlaywright() {
  const errors = [];
  for (const candidate of await playwrightCandidates()) {
    if (candidate && !existsSync(candidate)) continue;
    try {
      return await import(pathToFileURL(candidate).href);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  try {
    return await import('playwright');
  } catch (error) {
    errors.push(`playwright package: ${error.message}`);
  }
  const detail = errors.length ? `\n${errors.join('\n')}` : '';
  throw new Error(`Playwright is unavailable. Set SLIM_PLAYWRIGHT_MODULE to an installed module.${detail}`);
}

async function browserExecutable(name, type) {
  const configured = name === 'firefox' ? process.env.SLIM_FIREFOX_PATH : process.env.SLIM_CHROMIUM_PATH;
  if (configured && existsSync(configured)) return configured;
  const useSystem = process.env.SLIM_USE_SYSTEM_BROWSER === '1';
  if (!useSystem) {
    try {
      const bundled = type.executablePath?.();
      if (bundled && existsSync(bundled)) return bundled;
    } catch {}
    const cacheRoot = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
    if (cacheRoot && existsSync(cacheRoot)) {
      const entries = await readdir(cacheRoot, {withFileTypes: true});
      entries.sort((a, b) => b.name.localeCompare(a.name));
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidates = name === 'firefox'
          ? [join(cacheRoot, entry.name, 'firefox', 'firefox.exe')]
          : [join(cacheRoot, entry.name, 'chrome-win64', 'chrome.exe'), join(cacheRoot, entry.name, 'chrome-win', 'chrome.exe')];
        const cached = candidates.find((candidate) => existsSync(candidate));
        if (cached) return cached;
      }
    }
  }
  const common = name === 'firefox'
    ? [
        configured,
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
      ]
    : [
        configured,
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
      ];
  return common.find((candidate) => candidate && existsSync(candidate));
}

async function openServer(directory) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = resolve(directory, relative);
      if (!file.startsWith(`${directory}${process.platform === 'win32' ? '\\' : '/'}`)) {
        response.writeHead(403).end();
        return;
      }
      const bytes = await readFile(file);
      const type = extname(file) === '.html' ? 'text/html; charset=utf-8' : extname(file) === '.wasm' ? 'application/wasm' : 'application/octet-stream';
      response.writeHead(200, {'content-type': type, 'cache-control': 'no-store'}).end(bytes);
    } catch {
      if (request.url === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end('Not found');
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return {server, url: `http://127.0.0.1:${address.port}/index.html`};
}

const probeScript = `
(() => {
  const p = window.__slimProbe = {buffers: [], pixels: [], draws: 0, audioContexts: 0};
  function hook(type) {
    const proto = type && type.prototype;
    if (!proto) return;
    const bufferData = proto.bufferData;
    if (typeof bufferData === 'function' && !bufferData.__slimProbe) {
      const wrapped = function(target, data, usage) {
        if (data instanceof Float32Array && data.length) {
          p.buffers.push(Array.from(data));
          if (p.buffers.length > 180) p.buffers.shift();
        }
        return bufferData.call(this, target, data, usage);
      };
      wrapped.__slimProbe = true;
      proto.bufferData = wrapped;
    }
    const drawArrays = proto.drawArrays;
    if (typeof drawArrays === 'function' && !drawArrays.__slimProbe) {
      const wrapped = function(mode, first, count) {
        p.draws += 1;
        const result = drawArrays.call(this, mode, first, count);
        try {
          const pixel = new Uint8Array(4);
          this.readPixels(Math.floor(this.canvas.width / 2), Math.floor(this.canvas.height / 2), 1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel);
          p.pixels.push(Array.from(pixel));
          if (p.pixels.length > 180) p.pixels.shift();
        } catch {}
        return result;
      };
      wrapped.__slimProbe = true;
      proto.drawArrays = wrapped;
    }
  }
  hook(window.WebGLRenderingContext);
  hook(window.WebGL2RenderingContext);
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (typeof Audio === 'function') {
    const WrappedAudio = function(...values) {
      p.audioContexts += 1;
      return new Audio(...values);
    };
    WrappedAudio.prototype = Audio.prototype;
    try {
      window.AudioContext = WrappedAudio;
      if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudio;
    } catch {}
  }
})();
`;

async function frameStats(page) {
  return page.evaluate(() => {
    const p = window.__slimProbe;
    const data = p && p.buffers.length ? p.buffers[p.buffers.length - 1] : [];
    const triangles = Math.floor(data.length / 15);
    const cyan = [];
    for (let i = 0; i + 14 < data.length; i += 15) {
      if (Math.abs(data[i + 2] - 0.18) < 0.01 && Math.abs(data[i + 3] - 0.92) < 0.01 && Math.abs(data[i + 4] - 1) < 0.01) {
        cyan.push((data[i] + data[i + 5] + data[i + 10]) / 3);
      }
    }
    return {triangles, finite: data.every(Number.isFinite), cyanX: cyan.length ? cyan[0] : null, draws: p ? p.draws : 0};
  });
}

async function pointerAt(page, x, y) {
  const box = await page.locator('canvas').boundingBox();
  if (!box) fail('canvas has no layout box');
  await page.mouse.move(box.x + x * box.width / 800, box.y + y * box.height / 600);
}

async function pixelProbe(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas && canvas.getContext('webgl');
    const pixels = window.__slimProbe?.pixels || [];
    if (!gl) return {available: false, pixel: pixels.length ? pixels[pixels.length - 1] : [0, 0, 0, 0], error: 'no WebGL context'};
    return {available: true, pixel: pixels.length ? pixels[pixels.length - 1] : [0, 0, 0, 0], error: gl.getError()};
  });
}

async function runBrowser(name, playwright, url, screenshot) {
  const type = playwright[name];
  if (!type) return {name, status: 'unavailable', reason: `${name} is not exported by the selected Playwright module`};
  const executablePath = await browserExecutable(name, type);
  const launchOptions = {headless: true};
  if (executablePath) launchOptions.executablePath = executablePath;
  if (name === 'chromium') launchOptions.args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

  let browser;
  try {
    browser = await type.launch(launchOptions);
  } catch (error) {
    return {name, status: 'unavailable', reason: `could not launch ${name}: ${error.message}`, executablePath};
  }
  const errors = [];
  const failedRequests = [];
  let page;
  try {
    page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: 1});
  } catch (error) {
    await browser.close().catch(() => {});
    return {name, status: 'unavailable', reason: `could not create a ${name} page: ${error.message}`, executablePath};
  }
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
  page.on('requestfailed', (request) => failedRequests.push(`${request.url()}: ${request.failure()?.errorText || 'failed'}`));

  try {
    await page.addInitScript({content: probeScript});
    await page.goto(url, {waitUntil: 'load', timeout: timeoutMs});
    await page.waitForFunction(() => window.__slimProbe?.buffers?.length > 0, undefined, {timeout: timeoutMs});
    const initial = await frameStats(page);
    assertBrowser(initial.triangles > 0, `${name} produced no triangle vertices`);
    assertBrowser(initial.finite, `${name} produced non-finite triangle vertices`);
    assertBrowser(initial.draws > 0, `${name} made no WebGL draw call`);
    const pixel = await pixelProbe(page);
    assertBrowser(pixel.available, `${name} did not provide WebGL`);
    assertBrowser(pixel.error === 0, `${name} WebGL readPixels error ${pixel.error}`);
    assertBrowser(pixel.pixel.some((channel) => channel !== 0), `${name} rendered an all-zero center pixel`);

    const beforeMove = initial.cyanX;
    assertBrowser(beforeMove !== null, `${name} initial frame has no player triangle`);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(120);
    await page.keyboard.up('ArrowRight');
    const afterMove = await frameStats(page);
    assertBrowser(afterMove.cyanX > beforeMove + 1, `${name} keyboard input did not move the player`);

    await pointerAt(page, 180, 160);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await pointerAt(page, 400, 290);
    await page.waitForTimeout(120);
    await pointerAt(page, 620, 420);
    await page.waitForTimeout(120);
    await page.mouse.up();
    const winning = await frameStats(page);
    assertBrowser(winning.cyanX === null, `${name} pointer controls did not reach the winning scene`);

    await pointerAt(page, 400, 300);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    const pointerRestart = await frameStats(page);
    assertBrowser(pointerRestart.cyanX !== null, `${name} pointer press did not restart the game`);

    // Complete the game a second time so the independent keyboard restart edge
    // is observed from the terminal state too.
    await pointerAt(page, 180, 160);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await pointerAt(page, 400, 290);
    await page.waitForTimeout(100);
    await pointerAt(page, 620, 420);
    await page.waitForTimeout(100);
    await page.mouse.up();
    const secondWin = await frameStats(page);
    assertBrowser(secondWin.cyanX === null, `${name} second pointer sequence did not win`);
    await page.keyboard.press('r');
    await page.waitForTimeout(100);
    const keyboardRestart = await frameStats(page);
    assertBrowser(keyboardRestart.cyanX !== null, `${name} R did not restart the game`);

    await page.screenshot({path: screenshot, fullPage: true});
    const audioContexts = await page.evaluate(() => window.__slimProbe?.audioContexts || 0);
    const browserVersion = browser.version();
    if (errors.length) fail(errors.join('; '));
    if (failedRequests.length) fail(`failed requests: ${failedRequests.join('; ')}`);
    return {
      name,
      status: 'passed',
      version: browserVersion,
      executablePath: executablePath || type.executablePath?.(),
      url,
      screenshot,
      audioGesture: audioContexts > 0 ? 'AudioContext constructed' : 'AudioContext unavailable in browser',
      audioContexts,
      initialTriangles: initial.triangles,
      finalTriangles: keyboardRestart.triangles,
      maxObservedTriangles: Math.max(initial.triangles, afterMove.triangles, winning.triangles, pointerRestart.triangles, secondWin.triangles, keyboardRestart.triangles)
    };
  } catch (error) {
    return {name, status: 'failed', reason: error.message, screenshot, errors, failedRequests};
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function assertBrowser(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const indexPath = join(dist, 'index.html');
  if (!existsSync(indexPath)) fail(`missing generated HTML: ${indexPath}; run npm run build first`);
  await mkdir(output, {recursive: true});
  const html = await readFile(indexPath, 'utf8');
  const zipPath = join(dist, 'game.zip');
  const sizePath = join(dist, 'size.json');
  const size = existsSync(sizePath) ? JSON.parse(await readFile(sizePath, 'utf8')) : undefined;
  const externalWasm = /\bfetch\s*\(\s*["']game\.wasm["']/.test(html);
  let server;
  let url = pathToFileURL(indexPath).href;
  if (externalWasm) {
    const opened = await openServer(dist);
    server = opened.server;
    url = opened.url;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    artifact: {
      dist,
      index: indexPath,
      zip: existsSync(zipPath) ? zipPath : null,
      zipBytes: existsSync(zipPath) ? (await stat(zipPath)).size : null,
      size,
      wasmLayout: externalWasm ? 'external' : 'embedded',
      urlMode: externalWasm ? 'local-http-for-fetch' : 'file'
    },
    requestedBrowsers,
    browsers: {},
    coverageComplete: false
  };

  try {
    let playwright;
    try {
      playwright = await loadPlaywright();
      summary.playwright = {status: 'loaded', module: process.env.SLIM_PLAYWRIGHT_MODULE || 'resolved installed/cached module'};
    } catch (error) {
      summary.playwright = {status: 'unavailable', reason: error.message};
      console.error(error.message);
      await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    for (const name of requestedBrowsers) {
      if (!['chromium', 'firefox'].includes(name)) {
        summary.browsers[name] = {name, status: 'unavailable', reason: `unsupported browser name: ${name}`};
        continue;
      }
      const screenshot = join(output, `${name}.png`);
      summary.browsers[name] = await runBrowser(name, playwright, url, screenshot);
      const result = summary.browsers[name];
      console.log(`${name}: ${result.status}${result.version ? ` (${result.version})` : ''}${result.reason ? ` — ${result.reason}` : ''}`);
    }
  } finally {
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  }

  const results = Object.values(summary.browsers);
  summary.coverageComplete = results.length > 0 && results.every((result) => result.status === 'passed');
  await writeFile(join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  const failed = results.some((result) => result.status === 'failed');
  const unavailable = results.some((result) => result.status === 'unavailable');
  if (failed || (unavailable && !allowMissing) || !summary.coverageComplete && !allowMissing) process.exitCode = 1;
}

await main();
