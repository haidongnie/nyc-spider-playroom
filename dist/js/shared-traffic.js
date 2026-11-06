// Compact host-authored snapshots for the city's existing simulation/draw pools.
// Stable slots share vehicle styles, crowd rigs and seeded highway lanes across clients.
const MAX_BYTES=9000, MAGIC=0x4e59, VERSION=1, HEADER=19, DELAY=280, TIMEOUT=4000;
const TAU=2*Math.PI;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const lerp=(a,b,t)=>a+(b-a)*t;
const angle=(a,b,t)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*t;
const wrap=x=>x-Math.floor(x);
const aq=a=>Math.round(wrap(a/TAU)*256)&255;
const coord=(x,scale)=>clamp(Math.round(x*scale),-32767,32767);
const empty=()=>({clock:0,cars:[],peds:[],air:[],highway:[]});
class Writer {
  constructor(){this.bytes=new Uint8Array(MAX_BYTES);this.d=new DataView(this.bytes.buffer);this.i=0;}
  b(v){this.d.setUint8(this.i++,v);} s(v){this.d.setInt8(this.i++,v);}
  w(v){this.d.setUint16(this.i,v,true);this.i+=2;} n(v){this.d.setInt16(this.i,v,true);this.i+=2;}
  f(v){this.d.setFloat32(this.i,v,true);this.i+=4;}
  finish(){return btoa(String.fromCharCode(...this.bytes.subarray(0,this.i)));}
}
class Reader {
  constructor(bytes){this.d=new DataView(bytes.buffer);this.i=0;}
  b(){return this.d.getUint8(this.i++);}s(){return this.d.getInt8(this.i++);}
  w(){const v=this.d.getUint16(this.i,true);this.i+=2;return v;} n(){const v=this.d.getInt16(this.i,true);this.i+=2;return v;}
  f(){const v=this.d.getFloat32(this.i,true);this.i+=4;return v;}
}

export function createSharedTraffic({controllerManager,trafficSystem,highwayTraffic,airTraffic}) {
  const vehicles=[...trafficSystem.cars,...trafficSystem.buses], crowd=trafficSystem.peds, hwy=highwayTraffic.cars;
  const flights=airTraffic.group.children.filter(o=>Number.isFinite(o.userData.cruiseSpeed));
  let role='local', following=false, authority='', since=0,last=0, chunk=0;
  let nativeAir=[], nextInterest=0;
  let frame=empty(), queue=[], lanes=[];
  function apply(value){
    if(following===value)return;
    if (value) {
      nativeAir=flights.map(c=>({visible:c.visible,speed:c.userData.cruiseSpeed,position:c.position.clone(),quaternion:c.quaternion.clone()}));
    } else {
      for(let i=0;i<flights.length;i++){
        const c=flights[i],prior=nativeAir[i];if(!prior)continue;
        c.visible=prior.visible;c.userData.cruiseSpeed=prior.speed;c.position.copy(prior.position);c.quaternion.copy(prior.quaternion);
      }
      nativeAir=[];
    }
    following=value;
    trafficSystem.setSharedState(value?frame:null);
    highwayTraffic.setSharedState(value?frame:null);
  }
  function reset(){
    queue=[];lanes=[];last=0;since=performance.now();
    frame.cars.length=frame.peds.length=frame.air.length=frame.highway.length=0;
  }
  function setRole(next){
    if(!['host','guest','local'].includes(next) || next===role)return;
    apply(false);trafficSystem.setSharedInterests?.([]);nextInterest=0;role=next;authority='';reset();
    if(role==='guest')apply(true);
  }
  function collectSnapshot(){
    if(role!=='host')return '';
    const vCount=vehicles.length, pCount=crowd.length, aCount=flights.length;
    const fixed=HEADER+13*vCount+7*pCount+9*aCount;
    if(fixed>MAX_BYTES || hwy.length>65535)return '';
    const hCount=Math.min(hwy.length,Math.floor((MAX_BYTES-fixed)/3));
    const start=hCount<hwy.length?chunk:0;
    const w=new Writer();
    w.w(MAGIC);w.b(VERSION);w.f(trafficSystem.sharedClock||0);w.w(vCount);w.w(pCount);w.b(aCount);
    w.w(hwy.length);w.w(start);w.w(hCount);w.b(0);
    for(const v of vehicles){
      const edge=v.edge;w.w(edge?edge.id+1:0);
      w.n(coord(v.x,4));w.n(coord(v.z,4));w.b(aq(v.yaw+v.yawOffset));w.s(clamp(Math.round(v.speed*3),-127,127));
      w.w(edge?clamp(Math.round(v.s/Math.max(.01,edge.len)*65535),0,65535):0);
      w.b((v.lane&15)|(v.acc<-.8?16:0)|(v.blink<0?32:v.blink>0?64:0));
      w.s(clamp(Math.round(v.steer*100),-127,127));w.s(clamp(Math.round(v.roll*127),-127,127));
    }
    const clock=trafficSystem.sharedClock||0;
    for(const p of crowd){
      const direction=p.rig.placed?p.rig.yaw:Math.atan2(p.ux*p.dir,p.uz*p.dir);
      const dive=clock-p.diveStart;
      w.n(coord(p.x,4));w.n(coord(p.z,4));w.b(aq(direction));w.b(clamp(Math.round(p.v*24),0,255));
      const inRoad=p.node&&p.t>2&&p.t<p.len-2;
      w.b((p.placed?128:0)|(inRoad?64:0)|(dive>=0&&dive<1.5?clamp(Math.round(dive*40),0,62):63));
    }
    for(const o of flights){
      w.n(coord(o.position.x,2));w.n(coord(o.position.y,4));w.n(coord(o.position.z,2));w.b(aq(o.rotation.y));
      w.b(clamp(Math.round(o.userData.cruiseSpeed*3),0,255));w.b(o.visible?1:0);
    }
    for(let i=0;i<hCount;i++){
      const c=hwy[(start+i)%hwy.length];
      w.w(Math.round(wrap(c.u/c.lane.len)*65535));
      w.b(clamp(Math.round(c.v*2),0,127)|(c.acc<-1.2?128:0));
    }
    if(hwy.length)chunk=(start+hCount)%hwy.length;
    return w.finish();
  }
  function decode(payload){
    if(typeof payload!=='string'||payload.length>12000 || payload.length<24)return null;
    let string;
    try{string=atob(payload);}catch{return null;}
    if(string.length<HEADER||string.length>MAX_BYTES)return null;
    const bytes=Uint8Array.from(string,ch=>ch.charCodeAt(0)),r=new Reader(bytes);
    if(r.w()!==MAGIC||r.b()!==VERSION)return null;
    const out=empty();out.clock=r.f();
    const nv=r.w(),np=r.w(),na=r.b(),n=r.w(),start=r.w(),count=r.w();r.b();
    if(!Number.isFinite(out.clock)||out.clock<0||nv!==vehicles.length||np!==crowd.length||na!==flights.length||
       n!==hwy.length||count>n||(n&&start>=n)||string.length!==HEADER+13*nv+7*np+9*na+3*count)return null;
    for(let i=0;i<nv;i++){
      const edge=r.w(),x=r.n()/4,z=r.n()/4,yaw=r.b()*TAU/256,speed=r.s()/3,s=r.w()/65535,flags=r.b(),steer=r.s()/100,roll=r.s()/127;
      if(edge>trafficSystem.network.edges.length)return null;
      out.cars.push(edge?{edge,x,z,yaw,speed,s,lane:flags&15,brake:Boolean(flags&16),blink:flags&32?-1:flags&64?1:0,steer,roll}:null);
    }
    for(let i=0;i<np;i++){
      const x=r.n()/4,z=r.n()/4,yaw=r.b()*TAU/256,speed=r.b()/24,flags=r.b(),dive=flags&63;
      out.peds.push(flags&128?{placed:true,x,z,yaw,speed,crossing:Boolean(flags&64),dive:dive===63?-1:dive/40}:null);
    }
    for(let i=0;i<na;i++){
      const x=r.n()/2,y=r.n()/4,z=r.n()/2,yaw=r.b()*TAU/256,speed=r.b()/3,on=r.b();
      out.air.push(on?{x,y,z,yaw,speed}:null);
    }
    for(let i=0;i<count;i++){
      const u=r.w()/65535,vs=r.b();
      out.highway.push({id:(start+i)%n,u,v:(vs&127)/2,brake:Boolean(vs&128)});
    }
    return out;
  }
  function ingest(payload,hostId=''){
    if(role!=='guest')return false;
    const packet=decode(payload);if(!packet)return false;
    const now=performance.now();
    if(hostId!==authority || (last&&now-last>TIMEOUT)){reset();authority=hostId;}
    packet.time=now;last=now;
    queue.push(packet);if(queue.length>6)queue.shift();
    for(const state of packet.highway){
      const history=lanes[state.id]||{a:null,b:null};history.a=history.b;history.b={...state,time:now};lanes[state.id]=history;
    }
    apply(true);
    return true;
  }

  function blend(rowsA,rowsB,output,t,category,extra) {
    output.length=rowsB.length;
    for(let i=0;i<output.length;i++){
      const b=rowsB[i],a=rowsA[i];
      if(!b){output[i]=null;continue;}
      const target=output[i]||(output[i]={});
      Object.assign(target,b);
      // A car/crowd slot can be reused after a teleport. Never draw a streak across Manhattan.
      if(!a || Math.hypot(b.x-a.x,b.z-a.z)> (category==='ped'?5:45))continue;
      target.x=lerp(a.x,b.x,t);target.z=lerp(a.z,b.z,t);target.yaw=angle(a.yaw,b.yaw,t);
      if(category==='air')target.y=lerp(a.y,b.y,t);
      // Packets may be dropped; coast no longer than 150ms, then hold the last host pose.
      if(extra>0){target.x+=Math.sin(b.yaw)*b.speed*extra;target.z+=Math.cos(b.yaw)*b.speed*extra;}
    }
  }
  function update(){
    const now=performance.now();
    if(role==='host' && now>=nextInterest) {
      nextInterest=now+750;
      const group=controllerManager?.scene?.getObjectByName('RemotePlayers');
      const interests=(group?.children || []).filter(p=>p.name.startsWith('Remote player / '))
        .map(p=>({id:p.name,x:p.position.x,z:p.position.z})).sort((a,b)=>a.id.localeCompare(b.id));
      trafficSystem.setSharedInterests?.(interests);
    }
    if(role!=='guest')return;
    if(now-(last||since)>TIMEOUT){apply(false);return;}
    if(!queue.length)return;
    const time=now-DELAY;
    while(queue.length>2 && queue[1].time<=time)queue.shift();
    const a=queue[0], b=queue[1]||a, span=b.time-a.time;
    const t=span>0?clamp((time-a.time)/span,0,1):1;
    const extra=clamp((time-b.time)/1000,0,.15);
    frame.clock=lerp(a.clock,b.clock,t)+extra;
    blend(a.cars,b.cars,frame.cars,t,'car',extra);
    blend(a.peds,b.peds,frame.peds,t,'ped',extra);
    blend(a.air,b.air,frame.air,t,'air',extra);
    for(let i=0;i<lanes.length;i++){
      const entry=lanes[i];if(!entry)continue;
      const h=entry.b,old=entry.a,duration=old?h.time-old.time:0;
      const f=duration?clamp((time-old.time)/duration,0,1):1;
      const delta=old?h.u-old.u-Math.round(h.u-old.u):0;
      const car=hwy[i], predicted=clamp((time-h.time)/1000,0,.6);
      const out=frame.highway[i]||(frame.highway[i]={});
      out.u=wrap((old?old.u+delta*f:h.u)+h.v*predicted/Math.max(1,car.lane.len));
      out.v=old?lerp(old.v,h.v,f):h.v;out.brake=h.brake;
    }
  }
  function updateAir(dt,entity,camera){
    if(!following){airTraffic.update(dt,entity,camera);return;}
    for(let i=0;i<flights.length;i++){
      const car=flights[i],r=frame.air[i];car.visible=Boolean(r);
      if(r){car.position.set(r.x,r.y,r.z);car.rotation.set(0,r.yaw,0,'YXZ');car.userData.cruiseSpeed=r.speed;}
    }
    airTraffic.group.updateMatrixWorld(true);
  }
  return {setRole,ingest,collectSnapshot,update,updateAir,getClock(elapsed){return following&&queue.length?frame.clock:elapsed;},
    get guest(){return role==='guest';},get following(){return following;}};
}
