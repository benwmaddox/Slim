import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('ZIP is deterministic and contains only the browser artifact',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'slim-zip-'));
  try {
    const html='<!doctype html><title>Slim</title><script>console.log(1)</script>';
    await writeFile(join(directory,'index.html'),html);
    await writeFile(join(directory,'game.wasm'),'inspection-only');
    const tool=fileURLToPath(new URL('../tools/zip.py',import.meta.url));
    for(const name of ['a.zip','b.zip']) {
      const result=spawnSync(process.env.SLIM_PYTHON||'python',[tool,directory,join(directory,name)],{encoding:'utf8'});
      assert.equal(result.status,0,result.stderr||String(result.error));
    }
    assert.deepEqual(await readFile(join(directory,'a.zip')),await readFile(join(directory,'b.zip')));
    const inspect=spawnSync(process.env.SLIM_PYTHON||'python',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==["index.html"]; print(z.read("index.html").decode())',join(directory,'a.zip')],{encoding:'utf8'});
    assert.equal(inspect.status,0,inspect.stderr);
    assert.equal(inspect.stdout.trim(),html);
    const external=spawnSync(process.env.SLIM_PYTHON||'python',[tool,directory,join(directory,'external.zip'),'index.html','game.wasm'],{encoding:'utf8'});
    assert.equal(external.status,0,external.stderr);
    const externalInspect=spawnSync(process.env.SLIM_PYTHON||'python',['-c','import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.namelist()==["game.wasm","index.html"]; assert z.read("game.wasm")==b"inspection-only"',join(directory,'external.zip')],{encoding:'utf8'});
    assert.equal(externalInspect.status,0,externalInspect.stderr);
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
