import { createFlashTrail } from './flash-effects.js';
import { applyStreetCarSkin } from './hijack.js';
// Remote peers are render-only. Their snapshots never feed the local controller,
// collision system, audio, save data, or persistent parked player vehicles.
import * as THREE from 'three/webgpu';
import { createSpiderAvatar } from './spider-avatar.js';
import { createSkycar } from './skycar.js';

const MODES = new Set(['person', 'car', 'cyclist', 'helicopter', 'skycar']);
const POSES = new Set(['idle','walk','run','jump','fall','swing','webshoot','wallcrawl','glide','takeoff','hardland']);
const MOUNT_POSE = {car:'drive',cyclist:'cycle',helicopter:'fly',skycar:'spinner'};
const SEAT = {car:[0.35,0.49,0.20],cyclist:[0,0.96,-0.28],helicopter:[0.40,0.68,1.18],skycar:[0.40,0.64,-0.03]};
const LABEL_HEIGHT = {person:2.08,car:2.66,cyclist:2.20,helicopter:3.75,skycar:2.48};
const MAX_REMOTE = 9;
const BUFFER_MS = 110;
const STALL_MS = 180;
const wrap = (n) => Math.atan2(Math.sin(n),Math.cos(n));
const clamp = THREE.MathUtils.clamp;
const numeric = (n,fallback=0) => typeof n==='number' && Number.isFinite(n) ? n : fallback;
function point(input) {
  if (!input) return null;
  const p = Array.isArray(input) ? input : [input.x,input.y,input.z];
  return p.length === 3 && p.every(n=>typeof n==='number' && Number.isFinite(n) && Math.abs(n)<100000) ? p.slice() : null;
}
function normalize(raw, time) {
  if (!raw || !MODES.has(raw.mode)) return null;
  const p = point(raw.pos ?? raw.position ?? raw);
  if (!p) return null;
  const speed = clamp(numeric(raw.speed),-150,150);
  return {time,mode:raw.mode,street:Number.isInteger(raw.street)?raw.street:-1,p,heading:wrap(numeric(raw.heading)),pitch:clamp(numeric(raw.pitch),-1.3,1.3),
    roll:clamp(numeric(raw.roll),-1.3,1.3),speed,
    pose:POSES.has(raw.pose)?raw.pose:Math.abs(speed)>3?'run':Math.abs(speed)>0.25?'walk':'idle',
    phase:Number.isFinite(raw.phase)?wrap(raw.phase):null, side:raw.side==='left'?'left':'right',
    power:raw.power==='flash'?'flash':'spider', suited:raw.suited===true, suitProgress:Number.isFinite(raw.suitProgress)?clamp(raw.suitProgress,0,1):null,
    web:point(raw.web ?? raw.anchor), name:typeof raw.name==='string'?Array.from(raw.name.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').trim()).slice(0,18).join(''):''};
}
function displayState(queue, time, output) {
  while (queue.length>2 && queue[1].time<=time) queue.shift();
  let a=queue[0],b=queue[1] || a;
  const span=b.time-a.time;
  const t=span>0?clamp((time-a.time)/span,0,1):0;
  const sample=t>=1?b:a;
  output.mode=sample.mode;output.street=sample.street;output.pose=sample.pose;output.power=sample.power;output.suited=sample.suited;output.suitProgress=sample.suitProgress;
  output.side=sample.side;output.web=sample.web;output.name=sample.name;
  output.x=THREE.MathUtils.lerp(a.p[0],b.p[0],t);output.y=THREE.MathUtils.lerp(a.p[1],b.p[1],t);output.z=THREE.MathUtils.lerp(a.p[2],b.p[2],t);
  output.heading=a.heading+wrap(b.heading-a.heading)*t;
  output.pitch=THREE.MathUtils.lerp(a.pitch,b.pitch,t);output.roll=THREE.MathUtils.lerp(a.roll,b.roll,t);
  output.speed=THREE.MathUtils.lerp(a.speed,b.speed,t);
  output.phase=a.phase!==null&&b.phase!==null?a.phase+wrap(b.phase-a.phase)*t:sample.phase;
  // Coast only briefly across a missing packet. A stationary peer never drifts.
  if (time>b.time && span>0 && Math.abs(b.speed)>.05) {
    const over=Math.min(time-b.time,STALL_MS), k=Math.min(over/span,1.5);
    output.x+=(b.p[0]-a.p[0])*k;output.y+=(b.p[1]-a.p[1])*k;output.z+=(b.p[2]-a.p[2])*k;
  }
}

function nameTag(name, color) {
  const canvas=document.createElement('canvas'); canvas.width=256;canvas.height=58;
  const ctx=canvas.getContext('2d');
  ctx.font='600 29px Inter, system-ui, sans-serif';ctx.textBaseline='middle';
  const width=Math.min(248,Math.ceil(ctx.measureText(name).width)+41), left=Math.floor((256-width)/2);
  ctx.fillStyle='rgba(15,22,30,.84)';ctx.beginPath();ctx.roundRect(left,5,width,48,14);ctx.fill();
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(left+16,29,5,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='#f7f6ef';ctx.fillText(name,left+29,29,width-37);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
  const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,depthTest:false,depthWrite:false,transparent:true}));
  sprite.name='Remote name';sprite.renderOrder=999;
  return sprite;
}

function hashId(id) {
  let hash=2166136261;
  for(let i=0;i<id.length;i++) hash=Math.imul(hash^id.charCodeAt(i),16777619);
  return hash>>>0;
}
const badgeColors=['#ffca54','#7cd9ef','#d99af5','#84dfaa','#ff9c78','#a6b6ff'];

// Retain only static geometry, shared materials and the original vehicle pivots.
// In particular, a source vehicle might currently contain the entire *local* avatar.
function cloneVehicleTree(source, avatarRoot, mapping) {
  if (source.userData.seasideOutline || source.name==='StreetCarPoliceBar' || source===avatarRoot || source.isLight || source.isCamera || source.isSkinnedMesh) return null;
  const copy=source.clone(false);mapping.set(source,copy);
  copy.castShadow=false;
  for(const child of source.children) {
    const clone=cloneVehicleTree(child,avatarRoot,mapping);
    if(clone) copy.add(clone);
  }
  return copy;
}
function makeVehicle(mode, entities, style) {
  const src=entities[mode], mapping=new Map();
  if(mode==='skycar'){
    const root=new THREE.Group(), pivot=new THREE.Group(), model=createSkycar({trafficStyle:style});
    // The remote Spinner uses the coarse real traffic geometry but retains a clear canopy
    // so the actual pilot can be seen up close.
    const glass=model.getObjectByName('Canopy'), playerGlass=src.model.getObjectByName('Canopy');
    if(glass && playerGlass) glass.material=playerGlass.material;
    model.traverse(o=>{o.castShadow=false;});pivot.add(model);root.add(pivot);
    return {root, pivot};
  }
  const root=cloneVehicleTree(src.mesh,entities.person.avatar.root,mapping);
  root.position.set(0,0,0);root.rotation.set(0,0,0);root.visible=true;
  const pivot=mapping.get(src.chassisPivot || src.leanPivot || src.tiltPivot) || root;
  pivot.position.y=0;pivot.rotation.set(0,0,0);
  if(mode==='car'){
    const wheels=src.wheels.map(w=>({tire:mapping.get(w.tire),steer:mapping.get(w.steerPivot),steerPivot:mapping.get(w.steerPivot),front:w.isFront,isFront:w.isFront}));
    const v={root,pivot,chassisPivot:pivot,wheels};
    applyStreetCarSkin(v,null,-1,src);return v;
  }
  if(mode==='cyclist')return {root,pivot,wheels:[mapping.get(src.frontWheel),mapping.get(src.rearWheel)],crank:mapping.get(src.crankPivot),pedals:src.pedals.map(p=>mapping.get(p))};
  return {root,pivot,main:mapping.get(src.mainRotorPivot),tail:mapping.get(src.tailRotorPivot)};
}

function animateVehicle(v, mode, state, dt, peer, turn) {
  if(!v) return;
  peer.wheel+=state.speed*dt/.35;
  peer.phase=state.phase??(peer.phase+state.speed*dt/(.35*3.2));
  v.pivot.rotation.x=state.pitch;v.pivot.rotation.z=state.roll;
  if(mode==='car'){
    const steer=Math.abs(state.speed)>1?clamp(Math.atan(turn*2.76/state.speed),-.6,.6):0;
    for(const w of v.wheels){w.tire.rotation.x=peer.wheel;if(w.front) w.steer.rotation.y=steer;}
  }else if(mode==='cyclist'){
    for(const w of v.wheels)w.rotation.x=peer.wheel;
    v.crank.rotation.x=peer.phase;
    for(const p of v.pedals)p.rotation.x=-peer.phase;
  }else if(mode==='helicopter'){
    v.main.rotation.y+=dt*24;v.tail.rotation.x+=dt*32;
  }
}
function releaseAvatar(avatar) {
  const materials=new Set(), skeletons=new Set();
  avatar.root.traverse(o=>{
    if(o.isMesh) for(const material of [].concat(o.material)) materials.add(material);
    if(o.isSkinnedMesh)skeletons.add(o.skeleton);
  });
  // The mask materials and cloned skeletons are instance-owned. Geometry, suit/civilian
  // textures, and all vehicle meshes' original materials remain shared with the local game.
  for(const material of materials)material.dispose();
  for(const skeleton of skeletons)skeleton.dispose();
  avatar.root.removeFromParent();
}

// Snapshots are world-space {mode,x,y,z,heading,pitch,roll,speed,pose,phase,side,
// suited,suitProgress,web:[x,y,z]|null,name}. Input angles are radians.
export function createRemotePlayers({scene,controllerManager,showNames=true,streetCars=[]}) {
  const group=new THREE.Group();group.name='RemotePlayers';scene.add(group);
  const peers=new Map(), entities=controllerManager.entities;
  const wireGeo=new THREE.CylinderGeometry(1,1,1,5);
  const wireMat=new THREE.MeshBasicMaterial({color:0xf4f3ef,depthTest:true});
  const markerGeo=new THREE.CapsuleGeometry(.22,1.15,2,5);
  const markerMats=[new THREE.MeshBasicMaterial({color:0x753f36}),new THREE.MeshBasicMaterial({color:0xd54944})];
  const up=new THREE.Vector3(0,1,0), from=new THREE.Vector3(), to=new THREE.Vector3(), axis=new THREE.Vector3(), view=new THREE.Vector3(), eye=new THREE.Vector3();
  let labels=showNames,disposed=false;
  function makePeer(id){
    const root=new THREE.Group();root.name='Remote player / '+id;
    const wire=new THREE.Mesh(wireGeo,wireMat);wire.name='Remote web';wire.visible=false;wire.frustumCulled=false;
    const marker=new THREE.Mesh(markerGeo,markerMats[0]);marker.name='Distant pedestrian';marker.position.y=.80;marker.visible=false;
    root.add(marker);group.add(root,wire);
    return {id,root,wire,marker,queue:[],state:{},avatar:null,vehicles:new Map(),mode:null,style:hashId(id)%6,
      name:null,tag:null,wheel:0,phase:0,yaw:null,suit:null,animTime:0,hadAvatarVisible:false};
  }
  function receive(id,raw){
    if(disposed || typeof id!=='string' || !id || id.length>200)return false;
    const time=performance.now(), s=normalize(raw,time);
    if(!s)return false;
    let peer=peers.get(id);
    if(!peer){
      if(peers.size>=MAX_REMOTE)return false;
      peer=makePeer(id);peers.set(id,peer);
    }
    const q=peer.queue,last=q[q.length-1];
    if(last){
      const dist=Math.hypot(s.p[0]-last.p[0],s.p[1]-last.p[1],s.p[2]-last.p[2]);
      // A mode switch or teleport is a discontinuity; avoid flying a remote figure
      // through blocks to reach the new entity, or extrapolating old motion after return.
      const gap=Math.max(.01,(time-last.time)/1000);
      if(last.mode!==s.mode || gap>1 || dist>Math.max(35,Math.max(Math.abs(s.speed),Math.abs(last.speed))*gap*2+8)){
        q.length=0;peer.yaw=null;peer.wheel=0;
      }else if(time-last.time<1)q.pop();
    }
    q.push(s);if(q.length>18)q.shift();return true;
  }

  function tag(peer,state){
    const name=state.name || ('Player '+(hashId(peer.id)%1000).toString().padStart(3,'0'));
    if(!labels || peer.name===name)return;
    if(peer.tag){peer.tag.material.map.dispose();peer.tag.material.dispose();peer.tag.removeFromParent();}
    peer.name=name;peer.tag=nameTag(name,badgeColors[peer.style]);peer.root.add(peer.tag);
  }
  function syncMode(peer,state){
    if(peer.mode===state.mode)return;
    if(peer.mode && peer.vehicles.has(peer.mode))peer.vehicles.get(peer.mode).root.visible=false;
    let v=peer.vehicles.get(state.mode);
    if(state.mode!=='person' && !v){
      v=makeVehicle(state.mode,entities,peer.style);peer.vehicles.set(state.mode,v);peer.root.add(v.root);
    }
    if(v)v.root.visible=true;
    peer.mode=state.mode;peer.yaw=null;peer.wheel=0;
    if(peer.avatar)mount(peer);
  }
  function mount(peer){
    const v=peer.vehicles.get(peer.mode), root=peer.avatar.root;
    (v?.pivot || peer.root).add(root);
    if(v)root.position.fromArray(SEAT[peer.mode]);else root.position.set(0,0,0);
    root.rotation.set(0,0,0);peer.animTime=.2;
  }
  function syncSuit(peer,state,initial){
    if(peer.avatar.power!==state.power)peer.avatar.setPower(state.power);
    if(!initial && peer.suit===state.suited)return;
    const a=peer.avatar;
    if(initial){
      const progress=state.suitProgress??(state.suited?1:0);
      if(progress>0 && progress<1){
        a.setSuited(!state.suited,{immediate:true});a.setSuited(state.suited);
        a.update((state.suited?progress:1-progress)*1.15,{pose:peer.mode==='person'?state.pose:MOUNT_POSE[peer.mode],side:state.side,speed:state.speed,phase:peer.phase});
      }else a.setSuited(state.suited,{immediate:true});
    }else a.setSuited(state.suited);
    peer.suit=state.suited;
  }
  function update(dt,camera){
    if(disposed)return;
    dt=clamp(numeric(dt),0,.15);const now=performance.now()-BUFFER_MS;
    if(camera){camera.updateWorldMatrix(true,false);camera.getWorldPosition(eye);}
    for(const peer of peers.values()){
      displayState(peer.queue,now,peer.state);const s=peer.state;
      peer.root.position.set(s.x,s.y,s.z);peer.root.rotation.y=s.heading;
      const dist=camera?peer.root.position.distanceTo(eye):0;
      let onscreen=true;
      if(camera){
        view.copy(peer.root.position).applyMatrix4(camera.matrixWorldInverse);
        const z=-view.z,m=camera.projectionMatrix.elements;
        onscreen=z>=-12 && Math.abs(view.x)<=Math.max(0,z)/Math.max(.01,Math.abs(m[0]))+12 &&
          Math.abs(view.y)<=Math.max(0,z)/Math.max(.01,Math.abs(m[5]))+12;
      }
      // The remote group remains in world space even while its meshes are culled.
      const visible=onscreen && dist<(s.mode==='person'?680:1500);
      peer.root.visible=visible;peer.wire.visible=false;
      if(!visible){peer.trail?.update(dt,peer.root.position,s.heading,false);peer.hadAvatarVisible=false;continue;}
      syncMode(peer,s);
      const turn=peer.yaw===null||!dt?0:wrap(s.heading-peer.yaw)/dt;peer.yaw=s.heading;
      const v=peer.vehicles.get(peer.mode);
      if(v && peer.mode==='car')applyStreetCarSkin(v,streetCars[s.street],s.street);
      animateVehicle(v,peer.mode,s,dt,peer,turn);
      const detailed=dist<(s.mode==='person'?215:125);
      peer.marker.visible=s.mode==='person'&&!detailed;
      peer.marker.material=markerMats[Number(s.suited)];
      if(detailed){
        if(!peer.avatar){peer.avatar=createSpiderAvatar();mount(peer);}
        peer.avatar.root.visible=true;
        syncSuit(peer,s,!peer.hadAvatarVisible);
        peer.animTime+=dt;
        const interval=dist<55?0:dist<115?1/22:1/12;
        if(peer.animTime>=interval){
          peer.avatar.update(Math.min(peer.animTime,.24),{pose:peer.mode==='person'?s.pose:MOUNT_POSE[peer.mode],speed:s.speed,phase:peer.phase,side:s.side});
          peer.animTime=0;
        }
      }else if(peer.avatar)peer.avatar.root.visible=false;
      const running = detailed && s.mode==='person' && s.power==='flash' && s.suited && Math.abs(s.speed)>3;
      if (running && !peer.trail) peer.trail = createFlashTrail(scene);
      peer.trail?.update(dt, peer.root.position, s.heading, running, peer.avatar?.root);
      peer.hadAvatarVisible=detailed;
      if(labels && dist<310)tag(peer,s);
      if(peer.tag){
        peer.tag.visible=labels && dist<310;
        peer.tag.position.y=LABEL_HEIGHT[s.mode];
        const h=clamp(dist*.013,.37,2.65);peer.tag.scale.set(h*256/58,h,1);
      }
      if(s.mode==='person'&&s.web){
        if(detailed)peer.avatar.getHand(s.side,from);
        else from.set(s.x,s.y+1.4,s.z);
        to.fromArray(s.web);axis.subVectors(to,from);const length=axis.length();
        if(length>.04 && length<600){
          peer.wire.position.lerpVectors(from,to,.5);
          peer.wire.quaternion.setFromUnitVectors(up,axis.multiplyScalar(1/length));
          const r=clamp(dist*.00065,.025,.17);
          peer.wire.scale.set(r,length,r);peer.wire.visible=true;
        }
      }
    }
    group.updateMatrixWorld(true);
  }
  function remove(id){
    const p=peers.get(id);if(!p)return;
    if(p.tag){p.tag.material.map.dispose();p.tag.material.dispose();}
    p.trail?.dispose();
    if(p.avatar)releaseAvatar(p.avatar);
    const vehicle=p.vehicles.get('car');if(vehicle)applyStreetCarSkin(vehicle,null,-1);
    p.root.removeFromParent();p.wire.removeFromParent();peers.delete(id);
  }
  function clear(){for(const id of [...peers.keys()])remove(id);}
  function dispose(){if(disposed)return;clear();wireGeo.dispose();wireMat.dispose();markerGeo.dispose();for(const m of markerMats)m.dispose();group.removeFromParent();disposed=true;}
  return {group,receive,remove,clear,update,dispose,setNamesVisible(value){labels=Boolean(value);},get count(){return peers.size;},
    getPlayer(id){return peers.get(id)?.root || null;}};
}
