import * as THREE from 'three/webgpu';
import {BODY_SPECS, buildCarGeometry, buildSteerableWheelGeo, buildLightbarGeometry, createLightbarMaterial,
  createCarWheelMaterial, createLoftedCarMaterial} from './cars.js';
import {placeVehicleHeadlight} from './vehicle-lights.js';
import {polygonSegmentFraction} from './building-collision.js';

const LABEL={taxi:'Yellow cab',sedan:'Sedan',suv:'SUV',van:'Delivery van',minivan:'Minivan',pickup:'Pickup'};
const originals=new WeakMap(), geometry=new Map();
const label=v=>v.isPolice?'NYPD '+LABEL[v.bodyType]:LABEL[v.bodyType];
function factory(key,build){if(!geometry.has(key))geometry.set(key,build());return geometry.get(key);}
function remember(c,src=null){
  if(originals.has(c))return originals.get(c);
  const body=c.chassisPivot.children[0], ref=src?remember(src):null;
  const stock={body,geo:ref?.geo??body.geometry,mat:ref?.mat??body.material,
    trim:c.chassisPivot.children.slice(1,5),carState:ref?.carState??c.carState,label:ref?.label??c.label,
    wheels:c.wheels.map((w,i)=>{const base=ref?.wheels[i];return {geometry:base?.geometry??w.tire.geometry,
      material:base?.material??w.tire.material,pos:base?.pos.clone()??w.steerPivot.position.clone()};}),
    slot:null,custom:null,bar:null};
  originals.set(c,stock);return stock;
}

// Reuse the exact traffic geometry, paint, livery and wheel style. Only materials
// with per-driver brake/reverse uniforms are private; the six body meshes are shared.
export function applyStreetCarSkin(c,model,slot=-1,stockSource=null){
  const s=remember(c,stockSource);
  if(s.slot===slot)return;
  s.slot=slot;
  s.custom?.dispose();s.custom=null;
  if(s.bar){s.bar.removeFromParent();s.bar.dispose?.();s.bar=null;}
  const spec=BODY_SPECS[model?.bodyType] || BODY_SPECS.taxi, stock=!model;
  s.body.geometry=stock?s.geo:factory('body/'+spec.name,()=>buildCarGeometry(spec,false));
  if(stock)s.body.material=s.mat;
  else {
    const hex=new THREE.Color().fromArray(model.paint).getHex();
    s.custom=createLoftedCarMaterial(spec,hex,model.style,true);
    s.custom.name=spec.name+' / #'+hex.toString(16).padStart(6,'0')+' / livery '+model.style;
    s.body.material=s.custom;
  }
  c.carState=stock?s.carState:s.custom.userData.carState;
  c.label=stock?s.label:label(model);
  c.streetDimensions=stock?null:{halfWidth:model.halfWidth,halfL:model.halfL,mass:model.mass};
  for(const t of s.trim)t.visible=stock;
  if(model?.isPolice){
    const bar=new THREE.InstancedMesh(factory('bar/'+spec.name,()=>buildLightbarGeometry(spec)),createLightbarMaterial(),1);
    bar.name='StreetCarPoliceBar';bar.setMatrixAt(0,new THREE.Matrix4());bar.castShadow=true;s.bar=bar;c.chassisPivot.add(bar);
  }
  for(let i=0;i<c.wheels.length;i++){
    const w=c.wheels[i], saved=s.wheels[i], side=Math.sign(saved.pos.x);
    w.tire.geometry=stock?saved.geometry:factory('wheel/'+spec.name+'/'+side,()=>buildSteerableWheelGeo(spec,side));
    w.tire.material=stock?saved.material:createCarWheelMaterial({style:model.style,wheelRadius:spec.wheelRadius});
    if(stock)w.steerPivot.position.copy(saved.pos);else w.steerPivot.position.set(side*spec.wheelX,spec.wheelRadius,(w.isFront?1:-1)*spec.wheelZ);
  }
  c.headLights?.forEach((light,i)=>placeVehicleHeadlight(light,spec,i?1:-1));
}

// Distance from the actor to the car's two front door handles, never its roof,
// bumper or a convenient point on a different story. "+Z" is the car's nose.
export function doorDistance(px,pz,x,z,yaw,width=1){
  const dx=px-x,dz=pz-z, sn=Math.sin(yaw),cs=Math.cos(yaw);
  return Math.hypot(Math.abs(dx*cs-dz*sn)-width, dx*sn+dz*cs-.40);
}
function clearPath(m,px,pz,x,z){
  const dx=x-px,dz=z-pz;
  for(const c of m.nearColliders((px+x)/2,(pz+z)/2,Math.hypot(dx,dz)/2+.2)){
    if((c.minY??0)>1.8 || c.maxY<.4 || c.minX>Math.max(x,px)||c.maxX<Math.min(x,px)||c.minZ>Math.max(z,pz)||c.maxZ<Math.min(z,pz))continue;
    if(c.polygon){if(polygonSegmentFraction(c.polygon,px,pz,dx,dz,0,1)>1e-5)return false;}
    else {
      let lo=0,hi=1;
      const o=c.obb, ax=o?(px-o.cx)*o.cs-(pz-o.cz)*o.sn:px, az=o?(px-o.cx)*o.sn+(pz-o.cz)*o.cs:pz;
      for(const [p,d,min,max] of [[ax,o?dx*o.cs-dz*o.sn:dx,o?-o.hx:c.minX,o?o.hx:c.maxX],[az,o?dx*o.sn+dz*o.cs:dz,o?-o.hz:c.minZ,o?o.hz:c.maxZ]]){
        if(Math.abs(d)<1e-8){if(p<min||p>max)hi=-1;continue;}
        const a=(min-p)/d,b=(max-p)/d;lo=Math.max(lo,Math.min(a,b));hi=Math.min(hi,Math.max(a,b));
      }
      if(hi>lo)return false;
    }
  }
  return true;
}
const pose=c=>({x:c.position.x,z:c.position.z,heading:c.heading,speed:c.speed});
function setCarPose(c,p){
  c.position.set(p.x,0,p.z);c.heading=p.heading;c.speed=p.speed || 0;
  c.vx=c.vz=c.angularVel=c.steerAngle=c.pitchVel=c.rollVel=c.heaveY=c.heaveVel=0;
  c.prevX=p.x;c.prevZ=p.z;c.lastCollisionSpark=null;
  c.chassisPivot.rotation.set(0,0,0);c.chassisPivot.position.y=0;
  for(const w of c.wheels)w.steerPivot.rotation.y=0;
  c.mesh.position.copy(c.position);c.mesh.rotation.y=c.heading;c.mesh.updateMatrixWorld(true);
}
const MAX_ENTRY_SPEED=8, REACH=3;
export function createHijack({controllerManager:m,trafficSystem:traffic,selectMode,isBlocked=()=>false,afterChange=()=>{}}){
  const cars=traffic.cars, c=m.entities.car;
  const chinese=/^zh(?:-|$)/i.test(navigator.language||'');
  const ui=(en,zh)=>chinese?zh:en;
  const button=document.createElement('button');
  button.id='street-car-action';button.type='button';button.hidden=true;
  button.style.cssText='position:fixed;left:50%;bottom:max(20%,76px);transform:translateX(-50%);z-index:12;max-width:78vw;border:1px solid #ffd25b99;border-radius:20px;background:#15202bea;color:#fff;padding:9px 15px;font:600 13px system-ui;cursor:pointer;box-shadow:0 2px 10px #0005';
  button.setAttribute('aria-live','polite');document.body.append(button);
  let personal=null, held=-1, pending=null, serial=0, nextHud=0, toast='',until=0;
  let role='local',me='',host='',room='',leases=new Map(),revision=0;
  function message(t){toast=t;until=performance.now()+1700;nextHud=0;update();}
  function valid(slot){return Number.isInteger(slot)&&slot>=0&&slot<cars.length;}
  function feasible(slot, actor, reach=REACH){
    const v=cars[slot];return v?.edge&&!v.hijacked&&Math.abs(v.speed)<=MAX_ENTRY_SPEED&&actor.y<1.55&&actor.y>-.75&&
      doorDistance(actor.x,actor.z,v.x,v.z,v.yaw+v.yawOffset,v.halfWidth)<=reach&&clearPath(m,actor.x,actor.z,v.x,v.z);
  }
  function nearest(){
    if(m.activeMode!=='person')return null;
    const p=m.entities.person.position;
    if(p.y>=1.55||p.y<-.75)return null;
    let slot=-2,d=REACH;
    for(let i=0;i<cars.length;i++){
      const v=cars[i];if(!v.edge||v.hijacked||Math.abs(v.speed)>MAX_ENTRY_SPEED||Math.abs(v.x-p.x)>5||Math.abs(v.z-p.z)>5)continue;
      const r=doorDistance(p.x,p.z,v.x,v.z,v.yaw+v.yawOffset,v.halfWidth);
      if(r<=d&&clearPath(m,p.x,p.z,v.x,v.z)){slot=i;d=r;}
    }
    // The player's original parked cab is also a real vehicle in solo mode.
    if(role==='local'&&c.mesh.visible&&doorDistance(p.x,p.z,c.position.x,c.position.z,c.heading)<d&&clearPath(m,p.x,p.z,c.position.x,c.position.z))slot=-1;
    return slot===-2?null:slot;
  }
  function reserve(id,req,actor,allowLag=false){
    if(!Array.isArray(req)||req.length!==2||!Number.isSafeInteger(req[0])||req[0]<1||!valid(req[1])||actor.mode!=='person')return;
    if(leases.has(id)||[...leases.values()].some(l=>l.slot===req[1]))return;
    // A guest sees a delayed host snapshot; the extra distance is bounded by
    // the real car's movement during interpolation/relay, never a remote pickup.
    if(!feasible(req[1],actor,REACH+(allowLag?Math.min(3,Math.abs(cars[req[1]].speed)*.65):0)))return;
    const v=cars[req[1]];
    const grant={serial:req[0],slot:req[1],x:v.x,z:v.z,heading:v.yaw+v.yawOffset,speed:v.speed};
    traffic.holdStreetCar(grant.slot,true);leases.set(id,grant);revision++;return grant;
  }
  function drive(grant){
    if(!grant||!pending||grant.serial!==pending.serial||grant.slot!==pending.slot||m.activeMode!=='person')return;
    personal=pose(c);held=grant.slot;pending=null;
    applyStreetCarSkin(c,cars[held],held);m.resetInput();
    // The car is already on a live, clear road lane. The map's broad camera
    // clearance search would unnecessarily displace it away from the player.
    setCarPose(c,grant);selectMode('car');afterChange();
    message(ui('Driving · ','正在驾驶 · ')+c.label);
  }
  function forget(id,drop,owner=role!=='guest'){
    const l=leases.get(id);if(!l)return;
    traffic.holdStreetCar(l.slot,false,owner?(drop||l.last||l):null);leases.delete(id);revision++;
  }
  function switched(mode){
    if(mode!=='person'&&pending){pending=null;revision++;}
    if(held<0||mode==='car')return;
    const drop=pose(c);
    if(role!=='guest')forget(me||'solo',drop);
    held=-1;applyStreetCarSkin(c,null);setCarPose(c,personal);personal=null;revision++;nextHud=0;
  }
  function safeExit(){
    const {x,z}=c.position,sn=Math.sin(c.heading),cs=Math.cos(c.heading);
    const doors=[];
    for(const side of [1,-1]){
      const reach=(cars[held]?.halfWidth??1)+1.15;
      const px=x+cs*side*reach+.35*sn,pz=z-sn*side*reach+.35*cs;
      // Include the pedestrian's radius and the near future of moving lanes.
      if(!clearPath(m,x,z,px+.4*cs*side,pz-.4*sn*side))continue;
      let clear=true;
      for(const v of [...cars,...traffic.buses]){
        if(!v.edge||Math.abs(v.x-px)>18||Math.abs(v.z-pz)>18)continue;
        const yaw=v.yaw+v.yawOffset, f=Math.sin(yaw),g=Math.cos(yaw),dx=px-v.x,dz=pz-v.z;
        const along=dx*f+dz*g,margin=v.half+.55;
        if(Math.abs(dx*g-dz*f)<v.halfWidth+.55&&along>-margin&&along<margin+Math.max(0,v.speed)*.65){clear=false;break;}
      }
      if(clear)doors.push({x:px,z:pz});
    }
    return doors.find(p=>m.isPointOnSidewalk(p.x,p.z))||doors[0];
  }
  function act(){
    if(isBlocked())return false;
    if(m.activeMode==='car'){
      if(Math.abs(c.speed)>3){message(ui('Brake before stepping out','请先减速停车，再下车'));return false;}
      const exit=safeExit();if(!exit){message(ui('Both doors are blocked','两侧车门都被挡住了'));return false;}
      const heading=c.heading;c.speed=0;
      selectMode('person',{dismount:false});m.resetInput();
      const person=m.entities.person;
      person.position.set(exit.x,m.getGroundHeight(exit.x,exit.z,'person'),exit.z);
      person.heading=heading;person.speed=person.verticalVel=0;person._charHidden=false;
      person.mesh.position.copy(person.position);person.mesh.rotation.y=heading;person.web.reset();
      person.rig.reset(exit.x,exit.z,heading,(manager,x,z)=>manager.getGroundHeight(x,z,'person'),m);
      afterChange();message(ui('On foot','已下车'));return true;
    }
    if(m.activeMode!=='person')return false;
    if(pending)return false;
    const slot=nearest();
    if(slot===null){message(ui('Approach the door of a stopped or slow street car','请靠近停着或缓行的街车车门'));return false;}
    if(slot===-1){m.resetInput();selectMode('car');afterChange();message(ui('Driving · ','正在驾驶 · ')+c.label);return true;}
    pending={slot,serial:++serial,at:performance.now()};revision++;
    if(role==='guest')message(ui('Taking the car…','正在接管车辆…'));
    else {
      const p=m.entities.person.position;
      drive(reserve(me||'solo',[serial,slot],{mode:'person',x:p.x,y:p.y,z:p.z}));
    }
    return true;
  }
  function update(){
    const now=performance.now();
    if(pending&&now-pending.at>3000){pending=null;revision++;message(ui('That car is no longer available','这辆车已无法接管'));return;}
    if(now<nextHud)return;nextHud=now+140;
    let text='',actionable=false;
    if(!isBlocked() && !document.body.classList.contains('hud-minimized')){
      if(until>now)text=toast;
      else if(pending)text=ui('Taking the car…','正在接管车辆…');
      else if(m.activeMode==='car'&&Math.abs(c.speed)<=3){text=ui('E · Step out','E · 下车');actionable=true;}
      else {const i=nearest();if(i!==null){text=i<0?ui('E · Take your taxi','E · 上自己的出租车'):ui('E · Take ','E · 劫车：')+label(cars[i]);actionable=true;}}
    }
    if(button.textContent!==text)button.textContent=text;
    button.hidden=!text;button.disabled=!actionable;
  }
  button.addEventListener('click',act);

  function setNetwork(status){
    const online=status.state==='online', next=online?(status.isHost?'host':'guest'):'local';
    const newRoom=online?status.code:'', newId=online?status.playerId:'';
    if(newRoom!==room || me!==newId){
      for(const id of [...leases.keys()])forget(id,null,false);
      // A vehicle acquired offline cannot claim a slot in the new host's simulation.
      if(held>=0){selectMode('person');}
      pending=null;
    }
    role=next;me=newId;room=newRoom;host=online?status.hostId:'';
  }
  function packet(){
    const request=pending?[pending.serial,pending.slot]:held>=0?[serial,held]:null;
    const data={take:request,street:held};
    if(role==='host')data.cars=[...leases.entries()].map(([id,l])=>[id,l.serial,l.slot,l.x,l.z,l.heading,l.speed]);
    return data;
  }
  function receive(id,p){
    if(role==='host'){
      const l=leases.get(id);
      if(l){
        if(!Array.isArray(p.take)||p.take[0]!==l.serial||p.take[1]!==l.slot)forget(id);
        else if(p.mode==='car'&&p.street===l.slot&&[p.x,p.z,p.heading].every(Number.isFinite))l.last={x:p.x,z:p.z,heading:p.heading};
      } else reserve(id,p.take,p,true);
    }else if(role==='guest'&&id===host&&Array.isArray(p.cars)&&p.cars.length<=10){
      const next=new Map(),slots=new Set();
      for(const a of p.cars){
        if(!Array.isArray(a)||a.length!==7||typeof a[0]!=='string'||a[0].length>96||next.has(a[0])||!Number.isSafeInteger(a[1])||!valid(a[2])||slots.has(a[2])||!a.slice(3).every(Number.isFinite))continue;
        next.set(a[0],{serial:a[1],slot:a[2],x:a[3],z:a[4],heading:a[5],speed:a[6]});slots.add(a[2]);
      }
      for(const [oid,l] of leases)if(next.get(oid)?.slot!==l.slot)forget(oid,null,false);
      for(const [oid,l] of next){traffic.holdStreetCar(l.slot,true);leases.set(oid,l);}
      if(held>=0&&next.get(me)?.slot!==held){selectMode('person');afterChange();message(ui('The car returned to city traffic','车辆已回到车流中'));}
      else drive(next.get(me));
    }
  }
  function save(){return held>=0&&personal?{slot:held,cab:[personal.x,personal.z,personal.heading]}:null;}
  function restore(saved){
    if(m.activeMode!=='car'||!saved||!valid(saved.slot)||!Array.isArray(saved.cab)||saved.cab.length!==3||!saved.cab.every(Number.isFinite))return;
    const [x,z,heading]=saved.cab;
    if(Math.abs(x)>12000||Math.abs(z)>12000)return;
    held=saved.slot;personal={x,z,heading,speed:0};
    applyStreetCarSkin(c,cars[held],held);traffic.holdStreetCar(held,true);
    leases.set('solo',{serial:++serial,slot:held,...pose(c)});
  }
  return {act,update,switched,setNetwork,packet,receive,save,restore,remove:id=>forget(id),
    approvedSlot:(id,slot)=>leases.get(id)?.slot===slot&&valid(slot)?slot:-1,
    get revision(){return revision;}};
}
