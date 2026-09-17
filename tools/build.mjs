import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compile} from '../src/compiler.mjs';
import {makeHtml} from '../src/host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] || 'examples/rainbow.slim');
const output = resolve(root, 'dist');
await mkdir(output, {recursive:true});
const wasm = compile(await readFile(source, 'utf8'));
if (!WebAssembly.validate(wasm)) throw Error('Compiler emitted invalid WASM');
await writeFile(resolve(output, 'game.wasm'), wasm);
const modules = [{name:'plain',bytes:wasm}];
// Optional build tool only; an explicit configuration must succeed.
const optimizer = process.env.SLIM_WASM_OPT || 'wasm-opt';
const optimizedPath = resolve(output, 'optimized.wasm');
const optimization = spawnSync(optimizer, [resolve(output,'game.wasm'), '-Oz', '--strip-debug', '--strip-producers', '-o', optimizedPath], {encoding:'utf8'});
if (optimization.status === 0) {
  const bytes = await readFile(optimizedPath);
  if (!WebAssembly.validate(bytes)) throw Error('Optimizer emitted invalid WASM');
  modules.push({name:'Oz',bytes});
} else if (process.env.SLIM_WASM_OPT) {
  throw Error(`Configured optimizer failed: ${optimization.error || optimization.stderr}`);
} else if (optimization.error?.code !== 'ENOENT') {
  throw Error(`Optimizer failed: ${optimization.error || optimization.stderr}`);
}
const candidates = modules.flatMap(module=>['embedded','external'].map(layout=>({name:`${module.name}-${layout}`,optimization:module.name,layout,bytes:module.bytes})));
function page(candidate) {
  return makeHtml(candidate.bytes,{title:'Slim — Rainbow Run', ...(candidate.layout==='external'?{wasmUrl:'game.wasm'}:{})});
}
for (const candidate of candidates) {
  const html=page(candidate);
  candidate.htmlBytes=Buffer.byteLength(html);
  await writeFile(resolve(output,'index.html'), html);
  await writeFile(resolve(output,'game.wasm'),candidate.bytes);
  const entries=candidate.layout==='external'?['index.html','game.wasm']:['index.html'];
  const zipped = spawnSync(process.env.SLIM_PYTHON || 'python', [resolve(root,'tools/zip.py'), output, resolve(output,`${candidate.name}.zip`),...entries], {encoding:'utf8'});
  if (zipped.status !== 0) throw Error(`ZIP failed: ${zipped.error || zipped.stderr}`);
  candidate.zipBytes = (await stat(resolve(output,`${candidate.name}.zip`))).size;
}
candidates.sort((a,b)=>a.zipBytes-b.zipBytes);
const best=candidates[0];
await writeFile(resolve(output,'index.html'),page(best));
await writeFile(resolve(output,'game.wasm'),best.bytes);
await writeFile(resolve(output,'game.zip'),await readFile(resolve(output,`${best.name}.zip`)));
const report={budget:13312, selected:best.name, layout:best.layout, zipBytes:best.zipBytes, remaining:13312-best.zipBytes, candidates:candidates.map(c=>({name:c.name,wasmBytes:c.bytes.length,htmlBytes:c.htmlBytes,zipBytes:c.zipBytes}))};
await writeFile(resolve(output,'size.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
if (best.zipBytes>13312) process.exitCode=1;
