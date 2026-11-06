// Full survey rings are fetched by district. The small global index supplies
// far silhouettes and stable broad-phase bounds without fetching remote streets.
import { decodeBuildingRecords, decodeDistrictRecords } from './building-codec.js';
import { DISTRICT_SIZE, START_DISTRICT_RADIUS } from './district-layout.js';

import { loadGameAsset } from './asset-fetch.js';
export function readDistrictFile(name, decode, signal) {
  return loadGameAsset(new URL('./districts/' + name + '.bin.gz', import.meta.url), decode, signal);
}
const bytes = await readDistrictFile('overview', buffer => {
  if (buffer.length < 16 || buffer[0] === 0) throw Error('Incomplete building overview.');
  return buffer;
});
export function createDistrictCatalog() {
  let cursor = 0;
  function uint() {
    let n = 0, shift = 0, b;
    do {
      if (cursor >= bytes.length || shift >= 28) throw Error('Invalid building overview.');
      b = bytes[cursor++]; n |= (b & 127) << shift; shift += 7;
    } while (b & 128);
    return n;
  }
  function delta() { const v = uint(); return (v >>> 1) ^ -(v & 1); }
  const districts = new Map(), navigation=[];
  for (let count = uint(); count > 0; count--) {
    const ix = delta(), iz = delta(), key = ix + '_' + iz;
    const district = {key, x:ix*DISTRICT_SIZE, z:iz*DISTRICT_SIZE, records:[]};
    let x = district.x*2, z = district.z*2;
    for (let n=uint(); n>0; n--) {
      const packed = uint(), height=packed>>>2, parts = [];
      for (let p=uint(); p>0; p--) {
        x += delta(); z += delta();
        parts.push({minX:x*.5, minZ:z*.5, maxX:(x+uint())*.5, maxZ:(z+uint())*.5});
      }
      const minX=Math.min(...parts.map(p=>p.minX)), maxX=Math.max(...parts.map(p=>p.maxX));
      const minZ=Math.min(...parts.map(p=>p.minZ)), maxZ=Math.max(...parts.map(p=>p.maxZ));
      const record={height,parts,minX,maxX,minZ,maxZ,cx:(minX+maxX)*.5,cz:(minZ+maxZ)*.5,excluded:Boolean(packed&1)};
      district.records.push(record);
      if(packed&2)navigation.push(record);
    }
    districts.set(key, district);
  }
  const outlines=decodeBuildingRecords(bytes.subarray(cursor));
  if(outlines.length!==navigation.length)throw Error('Invalid navigation outline count.');
  navigation.forEach((b,i)=>{b.navPolygons=outlines[i].polygons;});
  return districts;
}

function distance(district,x,z) {
  const dx=Math.max(0,Math.abs(x-district.x)-DISTRICT_SIZE*.5);
  const dz=Math.max(0,Math.abs(z-district.z)-DISTRICT_SIZE*.5);
  return Math.hypot(dx,dz);
}
export function createDistrictStream(districts, install, remove) {
  const cache = new Map(), failedNearby = new Set();
  let busy=0, lastFocus=null;
  const frame=()=>new Promise(resolve=>setTimeout(resolve,0));
  function acquire(district) {
    let state=cache.get(district.key);
    if(state) return state.promise;
    state={installed:false,controller:new AbortController()};cache.set(district.key,state);busy++;
    state.promise=(async()=>{
      const data=await readDistrictFile(district.key,decodeDistrictRecords,state.controller.signal);
      if(data.length!==district.records.length)throw Error('Invalid building district '+district.key);
      await frame();
      if(state.controller.signal.aborted)throw state.controller.signal.reason;
      install(district,data);
      state.installed=true;
    })().catch(error=>{
      if(cache.get(district.key)===state)cache.delete(district.key);
      if(!state.controller.signal.aborted)failedNearby.add(district.key);
      throw error;
    }).finally(()=>{busy--;});
    return state.promise;
  }
  function required(x,z,radius) {
    return [...districts.values()].map(d=>({d,range:distance(d,x,z)}))
      .filter(v=>v.range<=radius).sort((a,b)=>a.range-b.range);
  }
  async function ensureAt(x,z) {
    const targets=required(x,z,START_DISTRICT_RADIUS);
    for(const {d} of targets){failedNearby.delete(d.key);d.pins=(d.pins||0)+1;}
    try {await Promise.all(targets.map(({d})=>acquire(d)));}
    finally {
      for(const {d} of targets){d.pins--;d.keepUntil=performance.now()+1200;}
    }
  }
  function update(x,z,player) {
    // Include the physical actor when using a distant scenic/cockpit camera.
    if(lastFocus && busy===0 && Math.hypot(x-lastFocus.x,z-lastFocus.z)<35
      && Math.hypot(player.x-lastFocus.px,player.z-lastFocus.pz)<35 && lastFocus.settled)return;
    const wanted=new Map();
    for(const point of [{x,z},player])for(const item of required(point.x,point.z,1100)){
      const prior=wanted.get(item.d.key);if(!prior||item.range<prior.range)wanted.set(item.d.key,item);
    }
    for (const key of failedNearby) if (!wanted.has(key)) failedNearby.delete(key);
    const ordered=[...wanted.values()].sort((a,b)=>a.range-b.range);
    for(const {d} of ordered) {
      if(cache.has(d.key))continue;
      if(busy>=1)break;
      if(failedNearby.has(d.key))continue;
      acquire(d).catch(error=>{if(error.name!=='AbortError')console.warn('[district]',error.message);});
      break;
    }
    let retiring=false;
    for(const [key,state] of cache) {
      const d=districts.get(key);
      if(!state.installed && !d.pins && !wanted.has(key)) {
        cache.delete(key);
        state.controller.abort();
        continue;
      }
      if(!state.installed || distance(d,x,z)<=2300 || distance(d,player.x,player.z)<=2300)continue;
      if(d.pins || performance.now()<(d.keepUntil||0)){retiring=true;continue;}
      remove(d);cache.delete(key);
    }
    lastFocus={x,z,px:player.x,pz:player.z,settled:!retiring && ordered.every(i=>cache.get(i.d.key)?.installed||failedNearby.has(i.d.key))};
  }
  return {ensureAt, update, get loaded(){return [...cache].filter(([,v])=>v.installed).map(([k])=>k);}};
}
