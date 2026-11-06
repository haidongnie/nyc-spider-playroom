import { polygonBoxOverlaps } from './building-collision.js';

const CELL = 96;
const SAMPLE = 5;
const REACH = 680;
const TAU = Math.PI * 2;
// Wave tables and derivatives from Cyber Web City src/city/warp.ts. Keep the
// Manhattan street lanes straight and use the source's gentle city bend only
// in open upper airspace, relative to the lane's actual NYC anchor.
const X_WARP = [[150,4300,1.3],[55,1900,.4],[18,700,2.2]];
const Z_WARP = [[140,4700,2.1],[60,2100,5],[16,650,.9]];
function wave(terms,v,derivative=false) {
  let result=0;
  for (const [amplitude,period,phase] of terms) {
    const k=TAU/period;
    result+=derivative ? amplitude*k*Math.cos(v*k+phase) : amplitude*Math.sin(v*k+phase);
  }
  return result;
}

function laneFrame(x,z,dx,dz,height) {
  const bend=height>=55 ? .25 : 0;
  const baseX=bend ? wave(X_WARP,z) : 0, baseZ=bend ? wave(Z_WARP,x) : 0;
  return {
    point(s,out) {
      const gx=x+dx*s, gz=z+dz*s;
      out.x=gx+(bend ? bend*(wave(X_WARP,gz)-baseX) : 0);
      out.y=height;
      out.z=gz+(bend ? bend*(wave(Z_WARP,gx)-baseZ) : 0);
      return out;
    },
    heading(s) {
      if (!bend) return Math.atan2(dx,dz);
      const gx=x+dx*s, gz=z+dz*s;
      return Math.atan2(dx+bend*wave(X_WARP,gz,true)*dz,dz+bend*wave(Z_WARP,gx,true)*dx);
    }
  };
}

// Reserve a level flight corridor against the real NYC building volumes.
// Padding covers the hull and the distance between consecutive test points.
function makeAirspace(colliders) {
  const cells = new Map();
  for (const c of colliders) {
    if (!(c.maxY > 6) || !Number.isFinite(c.minX+c.maxX+c.minZ+c.maxZ)) continue;
    for (let ix=Math.floor((c.minX-6)/CELL); ix<=Math.floor((c.maxX+6)/CELL); ix++) {
      for (let iz=Math.floor((c.minZ-6)/CELL); iz<=Math.floor((c.maxZ+6)/CELL); iz++) {
        const key=ix+','+iz;
        if (!cells.has(key)) cells.set(key,[]);
        cells.get(key).push(c);
      }
    }
  }
  return (x,z,y) => {
    const nearby=cells.get(Math.floor(x/CELL)+','+Math.floor(z/CELL));
    if (!nearby) return true;
    for (const c of nearby) {
      if (y-1.8>c.maxY || y+3.5<(c.minY ?? 0) ||
          x+6<c.minX || x-6>c.maxX || z+6<c.minZ || z-6>c.maxZ) continue;
      if (c.polygon && !polygonBoxOverlaps(c.polygon,x,z,6,6)) continue;
      if (c.obb) {
        const o=c.obb, dx=x-o.cx, dz=z-o.cz;
        const pad=6*(Math.abs(o.cs)+Math.abs(o.sn));
        if (Math.abs(dx*o.cs-dz*o.sn)>o.hx+pad || Math.abs(dx*o.sn+dz*o.cs)>o.hz+pad) continue;
      }
      return false;
    }
    return true;
  };
}

// Cyber Web City's straight, cyclic lanes use the local street heading.
// Narrow NYC streets get smaller lateral offsets than the original megacity.
export function createAirLanePlanner(network,colliders) {
  const open=makeAirspace(colliders);
  const edges=[];
  for (const {from:a,to:b} of network.edges) {
    const len=Math.hypot(b.x-a.x,b.z-a.z);
    if (len>4) edges.push({x:a.x,z:a.z,dx:(b.x-a.x)/len,dz:(b.z-a.z)/len,len});
  }

  return function plan(center, heading, height, offset, reverse) {
    const hx=Math.sin(heading), hz=Math.cos(heading);
    const sign=reverse?-1:1;
    const candidates=[];
    for (const e of edges) {
      const fx=center.x-e.x, fz=center.z-e.z;
      const along=Math.max(0, Math.min(e.len,fx*e.dx+fz*e.dz));
      const px=e.x+along*e.dx, pz=e.z+along*e.dz;
      const dist=(center.x-px)**2+(center.z-pz)**2;
      if (dist>120**2) continue;
      const dot=hx*e.dx+hz*e.dz;
      const align=dot<0?-1:1;
      candidates.push({x:px,z:pz,dx:e.dx*align,dz:e.dz*align,score:dist+(1-Math.abs(dot))**2*95**2});
    }
    candidates.sort((a,b)=>a.score-b.score);
    const lines=candidates.slice(0,8);
    // In irregular districts or over the water an open lane can also pass
    // between surveyed streets. Its entire fixed-altitude interval must fit.
    for (const shift of [0,-12,12,-30,30]) {
      lines.push({x:center.x+hz*shift,z:center.z-hx*shift,dx:hx,dz:hz,score:170+shift**2});
    }

    let best=null, bestScore=Infinity;
    const sample={x:0,y:0,z:0};
    for (const line of lines) {
      const dx=line.dx*sign, dz=line.dz*sign;
      const x=line.x+dz*offset, z=line.z-dx*offset;
      const frame=laneFrame(x,z,dx,dz,height);
      let begin=null;
      for (let s=-REACH; s<=REACH+SAMPLE; s+=SAMPLE) {
        frame.point(s,sample);
        if (s<=REACH && open(sample.x,sample.z,height)) {
          if (begin===null) begin=s;
          continue;
        }
        if (begin===null) continue;
        const end=s-SAMPLE, length=end-begin;
        if (length>=75) {
          const near=Math.max(begin,Math.min(end,0));
          const score=line.score+near**2+Math.max(0,340-length)*.8;
          if (score<bestScore) {
            bestScore=score;
            best={frame,begin,dx,dz,height,length,
              center:Math.max(0,Math.min(length, -begin))};
          }
        }
        begin=null;
      }
    }
    return best;
  };
}
