import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
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
