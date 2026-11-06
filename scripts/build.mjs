import { build } from 'esbuild';
import { streetZ } from '../dist/js/city-config.js';
import {DISTRICT_SIZE, START_DISTRICT_RADIUS} from '../dist/js/district-layout.js';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const output = 'js/built';
const outDir = path.join(dist, output);
const engine = 'vendor/three/build/three.webgpu.js';
const shaders = 'vendor/three/build/three.tsl.js';
const addons = 'vendor/three/examples/jsm/';
const appModules = (await readdir(path.join(dist, 'js')))
  .filter(name => name.endsWith('.js') && name !== 'main.js').sort().map(name => 'js/' + name);
const helpers = [...appModules, engine, shaders];

// Discover the actual ESM exports, including Three's named re-exports. A small,
// lazily requested facade lets developer tools import the live scene's classes
// through their original source paths without downloading a second engine.
const inspection = await build({
  absWorkingDir: dist, entryPoints: helpers, outdir: 'inspect', format: 'esm',
  write: false, metafile: true, minify: true,
});
const sources = Object.values(inspection.metafile.outputs)
  .sort((a,b) => a.entryPoint.localeCompare(b.entryPoint, 'en'));
const facade = sources.map((source, i) => {
  const exports = source.exports.map((name, j) => name + ' as e' + i + '_' + j);
  return 'export {' + exports.join(',') + '} from "./' + source.entryPoint + '";';
}).join('\n');
const localModules = {
  name: 'local-game-modules',
  setup(api) {
    api.onResolve({filter: /^game:inspection$/}, () => ({path: 'game:inspection', namespace: 'local'}));
    api.onLoad({filter: /.*/, namespace: 'local'}, () => ({contents: facade, resolveDir: dist}));
    api.onResolve({filter: /^three(?:\/|$)/}, ({path: name}) => {
      const target = name === 'three' || name === 'three/webgpu' ? engine
        : name === 'three/tsl' ? shaders
        : name.startsWith('three/addons/') ? addons + name.slice('three/addons/'.length) : null;
      if (!target) throw Error('Unknown Three import ' + name);
      return {path: path.join(dist, target)};
    });
    api.onLoad({filter: /\.js$/}, async ({path: file}) => {
      const source = await readFile(file, 'utf8');
      if (!source.includes('import.meta.url')) return;
      // Preserve asset-relative URL resolution after bundling modules into js/built/.
      const original = path.relative(outDir, file).split(path.sep).join('/');
      const sourceURL = 'new URL(' + JSON.stringify(original) + ',import.meta.url).href';
      return {contents: source.replaceAll('import.meta.url', sourceURL), resolveDir: path.dirname(file)};
    });
  },
};

const result = await build({
  absWorkingDir: dist, entryPoints: {'game':'js/main.js','inspection':'game:inspection'},
  outdir: output, entryNames:'[name]-[hash]', chunkNames:'shared-[hash]',
  bundle:true, splitting:true, format:'esm', target:'es2022', platform:'browser',
  minify:true, keepNames:true, legalComments:'inline', write:false, metafile:true, plugins:[localModules],
});
const outputs = result.metafile.outputs;
const entry = (source) => {
  const match = Object.entries(outputs).find(([,info]) => info.entryPoint === source);
  if (!match) throw Error('Missing entry ' + source);
  return match[0];
};
const game = entry('js/main.js'), api = entry('local:game:inspection');
const facadeDirectory = output + '/api-' + path.basename(api, '.js').split('-').pop();
const imports = {'three/addons/': './' + addons};
const publish = [];
for (const [i, source] of sources.entries()) {
  const basename = path.basename(source.entryPoint);
  const file = facadeDirectory + '/' + basename;
  const names = source.exports.map((name,j) => 'e' + i + '_' + j + ' as ' + name);
  const from = path.posix.relative(facadeDirectory, api);
  publish.push([file, 'export {' + names.join(',') + '} from ' + JSON.stringify(from) + ';\n']);
  imports['./' + source.entryPoint] = './' + file;
  if (source.entryPoint === engine) imports.three = imports['three/webgpu'] = './' + file;
  if (source.entryPoint === shaders) imports['three/tsl'] = './' + file;
}
const startup = new Set();
function dependency(pathname) {
  if (startup.has(pathname)) return;
  startup.add(pathname);
  for (const item of outputs[pathname].imports) if (!item.external && item.kind === 'import-statement') dependency(item.path);
}
dependency(game);
const civilian = await readFile(path.join(dist, 'spider-assets/civilian.js'), 'utf8');
const initialCivilian = civilian.includes('civilian-start.glb.gz') ? 'civilian-start.glb.gz' : 'civilian.glb';
const assets = ['js/districts/overview.bin.gz', 'js/tree-geodata.bin.gz', 'spider-assets/' + initialCivilian,
  'spider-assets/peter.json.gz', 'skycar-assets/spinner-player.bin.gz','skycar-assets/spinner-traffic.bin.gz'];
await Promise.all(assets.map(name => access(path.join(dist, name))));
const start = '<!-- GAME BOOT START -->', end = '<!-- GAME BOOT END -->';
// Start only the chunks covering the saved character (or default Midtown spawn).
// This runs during HTML parsing, while WebGPU and the city are initializing.
const districtKeys=(await readdir(path.join(dist,'js/districts'))).filter(name=>/^-?\d+_-?\d+\.bin\.gz$/.test(name))
  .sort().map(name=>name.slice(0,-7));
function primeDistricts(keys, defaultZ, size, radius) {
  let x=-11.6,z=defaultZ;
  try {
    const saved=JSON.parse(localStorage.getItem('nyc-player-state'));
    const actor=saved?.entities?.[saved.activeMode];
    if((saved?.version===1 || saved?.version===2) && actor && [actor.x,actor.z].every(Number.isFinite)) {
      x=actor.x;z=actor.z;
    }
  } catch {}
  for(const key of keys) {
    const [ix,iz]=key.split('_').map(Number);
    if(Math.hypot(Math.max(0,Math.abs(x-ix*size)-size/2),Math.max(0,Math.abs(z-iz*size)-size/2))>radius)continue;
    const link=document.createElement('link');
    link.rel='preload';link.as='fetch';link.crossOrigin='anonymous';
    link.href='./js/districts/'+key+'.bin.gz';
    document.head.append(link);
  }
}
const header = [
  start,
  '<script type="importmap">' + JSON.stringify({imports}) + '</script>',
  ...Array.from(startup, name => '<link rel="modulepreload" href="./' + name + '" />'),
  ...assets.map(name => '<link rel="preload" as="fetch" crossorigin href="./' + name + '" />'),
  '<script>(' + primeDistricts.toString() + ')(' + JSON.stringify(districtKeys) + ',' + [streetZ(37)+12,DISTRICT_SIZE,START_DISTRICT_RADIUS].join(',') + ')</script>',
  '<script id="city-entry" type="module" src="./' + game + '"></script>',
  end,
].join('\n  ');
// Publish content-addressed files before switching the HTML entry. A failed
// build leaves the previous entry and all its dependencies available for retry.
const currentFiles = new Set([path.basename(facadeDirectory), ...result.outputFiles.map(file => path.basename(file.path))]);
await mkdir(outDir, {recursive:true});
const existing = await readdir(outDir);
await mkdir(path.join(dist, facadeDirectory), {recursive:true});
async function replaceFile(name, contents) {
  const temporary = name + '.' + process.pid + '.tmp';
  await writeFile(temporary, contents);
  await rename(temporary, name);
}
for (const file of result.outputFiles) await replaceFile(file.path, file.contents);
for (const [name, data] of publish) await replaceFile(path.join(dist, name), data);

const indexFile = path.join(dist, 'index.html');
const html = await readFile(indexFile, 'utf8');
const first = html.indexOf(start), last = html.indexOf(end);
if (first < 0 || last <= first) throw Error('Missing deployment header in index.html');
await replaceFile(indexFile, html.slice(0, first) + header + html.slice(last + end.length));
for (const name of existing) {
  if (!currentFiles.has(name) && /^(?:(?:game|shared|inspection)-[A-Z0-9]+\.js|api-[A-Z0-9]+)$/.test(name)) {
    await rm(path.join(outDir, name), {recursive:true, force:true});
  }
}
console.log('Built ' + startup.size + ' startup modules (' + [...startup].reduce((n,p)=>n+outputs[p].bytes,0).toLocaleString('en') +
  ' bytes); developer import facades and the Playroom frame are fetched on demand.');
