import { gzipSync, gunzipSync } from 'node:zlib';
import {createHash} from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { decodeBuildingRecords } from '../dist/js/building-codec.js';
import {DISTRICT_SIZE} from '../dist/js/district-layout.js';
import {buildingStyle} from '../dist/js/building-style.js';

// Source: NYC OTI Building Footprints, https://data.cityofnewyork.us/resource/5zhs-2jue.json
// navigation-survey.json identifies the original landmark exclusions and exact
// building polygons required to preserve the original road/pedestrian tests.
const dataRoot = new URL('../dist/js/districts/', import.meta.url);
const input = new URL('../dist/js/building-geodata.bin.gz', import.meta.url);
const source=await readFile(input);
const nav=JSON.parse(await readFile(new URL('./navigation-survey.json',import.meta.url),'utf8'));
if(createHash('sha256').update(source).digest('hex')!==nav.sourceSha256)throw Error('Navigation survey belongs to different building source.');
const exact=new Set(nav.exactIds), hidden=new Set(nav.landmarkIds);
const records = decodeBuildingRecords(gunzipSync(source));
await mkdir(dataRoot,{recursive:true});
const size=DISTRICT_SIZE;
const groups=new Map(), buckets=[0,0,0,0,0];
for(const [i,b] of records.entries()){
  b.flags=(hidden.has(i)?1:0)+(exact.has(i)?2:0);
  // The original facade seed used the position in each city-wide material
  // bucket. Persist it so changing district arrival order cannot change windows.
  b.facadeSeed=hidden.has(i)?0:(buckets[buildingStyle(b).mat]++*29)%1000;
  const key=Math.floor((b.cx+size/2)/size)+'_'+Math.floor((b.cz+size/2)/size);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(b);
}
function uint(out,n) {
  while(n>=128){out.push((n&127)|128);n>>>=7;}
  out.push(n);
}
function delta(out,n){uint(out,(n<<1)^(n>>31));}
function tileBytes(rows){
  const meta=[],xs=[],zs=[];let x=0,z=0;uint(meta,rows.length);
  for(const b of rows){
    uint(meta,b.height);uint(meta,b.year?b.year/10-159:0);uint(meta,b.polygons.length);
    for(const p of b.polygons){
      const rings=[p.outer,...p.holes];uint(meta,rings.length);
      for(const r of rings){uint(meta,r.length);for(const v of r){
        const px=v.x*2,pz=v.z*2;delta(xs,px-x);delta(zs,pz-z);x=px;z=pz;
      }}
    }
  }
  const header=Buffer.alloc(12);header.write('NYB1');header.writeUInt32LE(meta.length,4);header.writeUInt32LE(xs.length,8);
  return Buffer.concat([header,Buffer.from(meta),Buffer.from(xs),Buffer.from(zs)]);
}
// The overview carries only bounds and heights, not detailed rings, courtyards
// or construction dates. Store a broad-phase box per polygon so the exact
// collider for each component can replace it in place when its district arrives.
// An AABB may close a slanted street or courtyard. Keep the actual polygons
// where the original road, subway, tree and air-routing builds rejected an
// AABB overlap, as well as the original authored-landmark exclusions.
const navRows=[];
const meta=[];uint(meta,groups.size);
let polygonCount=0;
for(const [key,rows] of [...groups].sort(([a],[b])=>a.localeCompare(b,'en'))){
  const [ix,iz]=key.split('_').map(Number);delta(meta,ix);delta(meta,iz);uint(meta,rows.length);
  let lastX=ix*size*2,lastZ=iz*size*2;
  for(const b of rows){
    uint(meta,b.height*4+b.flags);uint(meta,b.polygons.length);
    if(b.flags&2)navRows.push(b);
    for(const p of b.polygons){
      const xs=p.outer.map(v=>v.x*2),zs=p.outer.map(v=>v.z*2);
      const x=Math.min(...xs),z=Math.min(...zs);
      delta(meta,x-lastX);delta(meta,z-lastZ);lastX=x;lastZ=z;
      uint(meta,Math.max(...xs)-x);uint(meta,Math.max(...zs)-z);
      polygonCount++;
    }
  }
  const seeds=Buffer.alloc(8+rows.length*2);
  seeds.write('NYD1');seeds.writeUInt32LE(rows.length,4);
  rows.forEach((b,i)=>seeds.writeUInt16LE(b.facadeSeed,8+i*2));
  await writeFile(new URL(key+'.bin.gz',dataRoot),gzipSync(Buffer.concat([seeds,tileBytes(rows)]),{level:9}));
}
await writeFile(new URL('overview.bin.gz',dataRoot),gzipSync(Buffer.concat([Buffer.from(meta),tileBytes(navRows)]),{level:9}));
console.log(records.length+' surveyed buildings, '+polygonCount+' polygons, '+groups.size+' districts.');
