import { loadGameAsset } from './asset-fetch.js';
// Gregg Tavares' Cyber Web City spinner, adapted to the Manhattan scene.
// The two local meshes were tessellated from the original NURBS surfaces.
// Source and MIT notice: ../skycar-assets/ORIGIN.md and LICENSE-Cyber-Web-City.md.
import * as THREE from 'three/webgpu';
import {
  attribute, dot, float, mix, normalView, positionViewDirection, sin, uniform, uv, vec3
} from 'three/tsl';
import { streetZ } from './city-config.js';
import { createAirLanePlanner } from './air-lanes.js';

// The upstream packed vertex has position, normal, UV and a uint32 material ID.
// Decode once and share the immutable geometry between every car of the same LOD.
async function loadSpinner(name) {
  const url = new URL(`../skycar-assets/spinner-${name}.bin.gz`, import.meta.url);
  const buffer = await loadGameAsset(url, bytes => {
    if (bytes.length < 24 || new DataView(bytes.buffer).getUint32(0, true) !== 0x31435753) throw Error('Invalid Spinner mesh.');
    return bytes.buffer;
  });
  const header = new Uint32Array(buffer, 0, 6);
  if (header[0] !== 0x31435753) throw new Error(`Invalid Spinner ${name} mesh`);
  const [, count, materialCount, opaqueCount, glassCount, glowCount] = header;
  const packed = new Float32Array(buffer, 24, count * 9);
  const packedBits = new Uint32Array(buffer, 24, packed.length);
  const materials = new Float32Array(buffer, 24 + packed.byteLength, materialCount * 12);
  const indices = new Uint32Array(buffer, 24 + packed.byteLength + materials.byteLength, opaqueCount + glassCount + glowCount);
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2), baseColor = new Float32Array(count * 3);
  const surface = new Float32Array(count * 2), emission = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  const classes = new Uint8Array(count);
  for (let i = 0; i < count; ++i) {
    const v = i * 9, m = packedBits[v + 8] * 12;
    // Rotate 180° about Y: Cyber Web City noses point -Z, New York vehicles +Z.
    positions.set([-packed[v], packed[v+1], -packed[v+2]], i*3);
    normals.set([-packed[v+3], packed[v+4], -packed[v+5]], i*3);
    uvs.set(packed.subarray(v+6, v+8), i*2);
    baseColor.set(materials.subarray(m, m+3), i*3);
    surface.set([materials[m+7], materials[m+8]], i*2);
    emission.set(materials.subarray(m+4, m+7), i*3);
    opacity[i] = materials[m+9];
    const kind = materials[m+3];
    classes[i] = kind === 4 ? 6 + materials[m+9] : kind;
  }
  const attributes = {
    position: new THREE.BufferAttribute(positions, 3), normal: new THREE.BufferAttribute(normals, 3),
    uv: new THREE.BufferAttribute(uvs, 2), spinnerColor: new THREE.BufferAttribute(baseColor, 3),
    spinnerSurface: new THREE.BufferAttribute(surface, 2), spinnerEmission: new THREE.BufferAttribute(emission, 3),
    spinnerOpacity: new THREE.BufferAttribute(opacity, 1)
  };
  const batches = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    const kind = classes[indices[i]];
    if (!batches.has(kind)) batches.set(kind, []);
    batches.get(kind).push(indices[i], indices[i+1], indices[i+2]);
  }
  return [...batches].map(([kind, faces]) => {
    const geometry = new THREE.BufferGeometry();
    for (const [key, value] of Object.entries(attributes)) geometry.setAttribute(key, value);
    geometry.setIndex(faces);
    geometry.computeBoundingSphere();
    return {kind, geometry};
  });
}

const [playerParts, trafficParts] = await Promise.all([loadSpinner('player'), loadSpinner('traffic')]);
const skin = attribute('spinnerColor', 'vec3');
const surface = attribute('spinnerSurface', 'vec2');
const light = attribute('spinnerEmission', 'vec3');
const time = uniform(0);
const materialCache = new Map();
const liftLights = new WeakMap();
const trafficPaint = [
  [0.9,0.7,0.05], [0.6,0.6,0.65], [0.05,0.05,0.06],
  [0.4,0.05,0.05], [0.1,0.2,0.35], [0.2,0.22,0.25]
];

// Three monochrome instruments occupy the original UV-mapped dashboard surfaces.
// The upstream shader assigns screen 0 to navigation, 1 to gauges, 2 to radio.
const instruments = [];
function instrumentTexture(id) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 80;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  instruments[id] = {ctx: canvas.getContext('2d'), texture};
  drawInstrument(id, 0);
  return texture;
}
function drawInstrument(id, elapsed) {
  const {ctx, texture} = instruments[id];
  ctx.fillStyle = '#0b0c0b'; ctx.fillRect(0, 0, 128, 80);
  ctx.lineWidth = 1;
  if (id === 0) {
    ctx.strokeStyle = '#704d18'; ctx.beginPath();
    for (let i = 0; i <= 128; i += 16) { ctx.moveTo(i,0); ctx.lineTo(i,80); }
    for (let i = (elapsed * 5) % 11; i <= 80; i += 11) { ctx.moveTo(0,i); ctx.lineTo(128,i); }
    ctx.stroke(); ctx.beginPath(); ctx.strokeStyle = '#ffae48'; ctx.lineWidth = 2;
    for (let y = 0; y <= 80; y += 2) { const x = 64 + Math.sin(y/16 + elapsed*.3)*16; if (y) ctx.lineTo(x,y); else ctx.moveTo(x,y); }
    ctx.stroke(); ctx.fillStyle='#fff6cd'; ctx.fillRect(61,57,5,5);
  } else if (id === 1) {
    ctx.strokeStyle = '#174226'; ctx.lineWidth=3; ctx.beginPath(); ctx.ellipse(64,40,40,27,0,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='#79bf68'; ctx.beginPath(); ctx.ellipse(64,40,40,27,0,-Math.PI,Math.sin(elapsed*.3)*Math.PI); ctx.stroke();
    ctx.fillStyle='#eeaf3a';
    for(let i=0;i<8;++i) { const h=7+5*Math.sin(elapsed+i); ctx.fillRect(42+i*6,45-h,3,h); }
  } else {
    ctx.fillStyle='#f3ad4b';
    for(let row=0;row<9;++row) for(let col=0;col<23;++col) {
      const k=Math.floor(elapsed*1.5)+row;
      if(Math.sin(17*k+13*col)>.0 && col<12+8*Math.sin(k)) ctx.fillRect(col*5+4,row*9+3,3,4);
    }
  }
  ctx.fillStyle='rgba(0,0,0,.18)'; for(let y=1;y<80;y+=3) ctx.fillRect(0,y,128,1);
  texture.needsUpdate=true;
}
let lastInstrumentFrame = -1;

function spinnerMaterial(kind, style) {
  const player = style === null;
  const key = kind + '/' + (kind === 1 ? style : player ? 'player' : 'traffic');
  if (materialCache.has(key)) return materialCache.get(key);
  let mat;
  if (kind === 5) {
    // Warm light volumes fade both down the duct and across their outer edge.
    mat = new THREE.MeshBasicNodeMaterial({transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide});
    const facing = dot(normalView, positionViewDirection).abs().pow(1.5);
    const tip = uv().y.oneMinus().clamp(0,1).pow(1.6);
    const pulse = sin(time.mul(23.7).add(uv().x.mul(5))).mul(.09).add(sin(time.mul(37)).mul(.10)).add(.79);
    const bands = sin(uv().y.mul(34).sub(time.mul(14))).mul(.12).add(.9);
    mat.colorNode = light.mul(facing).mul(tip).mul(pulse).mul(bands).mul(player ? .35 : .85);
  } else if (kind >= 6) {
    mat = player ? new THREE.MeshBasicMaterial({map:instrumentTexture(kind-6)}) : new THREE.MeshBasicMaterial({color:new THREE.Color(.2,.5,.8)});
  } else if (kind === 2) {
    mat = new THREE.MeshPhysicalNodeMaterial({color:player ? 0xc9dff0 : 0x233142, metalness:.25, roughness:.05,
      clearcoat:1, clearcoatRoughness:.035, transparent:player, depthWrite:!player});
    if (player) {
      // The model already includes both windings. Draw each glass surface once
      // per side and keep the original clear canopy / tinted instrument distinction.
      mat.colorNode = skin;
      mat.opacityNode = mix(attribute('spinnerOpacity','float'), float(.82), dot(normalView,positionViewDirection).abs().oneMinus().clamp(0,1).pow(5));
    }
  } else {
    mat = kind === 1 ? new THREE.MeshPhysicalNodeMaterial({clearcoat:1, clearcoatRoughness:.10}) : new THREE.MeshStandardNodeMaterial();
    mat.colorNode = kind === 1 && !player ? vec3(...trafficPaint[style]) : skin;
    mat.roughnessNode = surface.x;
    mat.metalnessNode = surface.y;
    if (kind === 3) mat.emissiveNode = light;
  }
  mat.name=`Spinner/${kind}/${player?'player':'traffic'}`;
  materialCache.set(key,mat);
  return mat;
}

export function createSkycar({trafficStyle = null} = {}) {
  const model = new THREE.Group();
  model.name = 'Cyber Web City Spinner';
  const traffic = trafficStyle !== null;
  for (const {kind, geometry} of traffic ? trafficParts : playerParts) {
    const mesh = new THREE.Mesh(geometry, spinnerMaterial(kind, trafficStyle));
    mesh.name = ['Hull','Paint','Canopy','Lights','','Jet plumes','Nav CRT','Gauge CRT','Comms CRT'][kind];
    mesh.castShadow = kind < 2;
    mesh.receiveShadow = kind < 4;
    model.add(mesh);
  }
  if (!traffic) {
    const lift = new THREE.PointLight(new THREE.Color(1,.4,.0875), 6, 7, 2);
    lift.name = 'Sodium lift glow'; lift.position.set(0,-.4,0);
    model.add(lift);
    liftLights.set(model, lift);
  }
  return model;
}

export function updateSkycar(model, elapsed, throttle = 0) {
  time.value = elapsed;
  const flicker = .78 + .10*Math.sin(elapsed*37) + .08*Math.sin(elapsed*23.7+1.3) + .04*Math.sin(elapsed*71.1);
  const lift = liftLights.get(model);
  if (lift) lift.intensity = (6+3*Math.min(1,Math.abs(throttle))) * flicker;
  const frame = Math.floor(elapsed*8);
  if (frame !== lastInstrumentFrame) {
    lastInstrumentFrame = frame;
    instruments.forEach((_, id) => drawInstrument(id, elapsed));
  }
}

// Cyber Web City src/city/traffic.ts + src/shaders/traffic.wgsl: each
// vehicle has a lane origin, direction, speed, phase and fixed altitude.
// The source's grid warp follows its fictional streets. Here the planner
// uses Manhattan street directions and clips lanes against real buildings.
const FLIGHT_LEVELS = [60, 150, 235, 310, 400];
const wrap = THREE.MathUtils.euclideanModulo;
const upperLevel = y => FLIGHT_LEVELS.reduce((a,b)=>Math.abs(b-y)<Math.abs(a-y)?b:a);

export function createAirTraffic(scene,{roadNetwork,colliders}) {
  const group=new THREE.Group();
  group.name='SpinnerAirTraffic';
  scene.add(group);
  const plan=createAirLanePlanner(roadNetwork,colliders);
  // Headways follow the source's 70–260 m range. Low local lanes fit between
  // Manhattan street facades; the five original flight levels run above them.
  const patterns=[
    {cross:false,reverse:false,h:12,off:3,speed:24,phases:[46,155,-90,335],paints:[0,1,3,4]},
    {cross:false,reverse:true,h:18,off:3,speed:27,phases:[80,206,-62,-208],paints:[1,3,0,4]},
    {cross:true,reverse:false,h:25,off:2.4,speed:23,phases:[0,116,-160],paints:[1,0,4]},
    {cross:true,reverse:true,h:31,off:2.4,speed:28,phases:[43,-134,215],paints:[3,4,1]},
    {cross:false,reverse:false,h:60,off:12,speed:33,phases:[85,-116],paints:[0,4]},
    {cross:true,reverse:true,h:150,off:19,speed:37,phases:[0,140],paints:[1,3]},
    {cross:false,reverse:true,h:235,off:12,speed:39,phases:[120],paints:[2]},
    {cross:true,reverse:false,h:310,off:19,speed:43,phases:[128],paints:[0]},
    {cross:false,reverse:false,h:400,off:12,speed:48,phases:[160],paints:[4]},
    // Two additional streams at the nearest original altitude tier make
    // close passes visible both from a cockpit and from the street.
    {cross:true,reverse:false,h:'near',off:8,speed:26,phases:[-25,78,-122],paints:[3,0,1]},
    {cross:false,reverse:true,h:'near',off:9,speed:31,phases:[75,175,-95],paints:[0,1,4]}
  ];
  let serial=0;
  const flights=patterns.flatMap((pattern, laneIndex)=>pattern.phases.map((phase,i)=>{
    const car=createSkycar({trafficStyle:pattern.paints[i]});
    car.visible=false;
    car.name='Spinner Flight '+String(++serial).padStart(2,'0');
    const speed=pattern.speed*(.97+.015*(i%5));
    car.userData.cruiseSpeed=speed;
    car.rotation.order='YXZ';
    group.add(car);
    return {car, laneIndex, phase, speed, lane:null, dispatchTime:0, s0:0};
  }));
  const anchor=new THREE.Vector3(Infinity,0,Infinity);
  const previous=new THREE.Vector3(Infinity,0,Infinity);
  const probe=new THREE.Vector3(), projected=new THREE.Vector3();
  let routes=[], targetLevel=0, elapsed=0;

  function point(lane,s,target) {
    return lane.frame.point(lane.begin+s,target);
  }
  function inView(p,camera) {
    if (!camera) return false;
    projected.copy(p).project(camera);
    return projected.z>=0 && projected.z<=1 && Math.abs(projected.x)<1.15 && Math.abs(projected.y)<1.15;
  }
  function dispatch(focus,heading) {
    anchor.copy(focus);
    targetLevel=upperLevel(focus.y);
    const forwardX=Math.sin(heading), forwardZ=Math.cos(heading);
    routes=patterns.map((p,i)=>{
      // A crossing passes the block ahead of the driver, like an airborne
      // intersection. The two upper companion lanes straddle the flight tier.
      const lead=p.cross ? (p.h==='near'?46:66) : 0;
      const center={x:focus.x+forwardX*lead,z:focus.z+forwardZ*lead};
      const level=p.h==='near' ? targetLevel+(p.cross?5:-5) : p.h;
      const levelOffset=level>=55 ? (i%3-1)*2 : 0;
      return plan(center,heading+(p.cross?Math.PI/2:0),level+levelOffset,p.off,p.reverse);
    });
  }
  function assign(f, camera, arrived) {
    const lane=routes[f.laneIndex];
    if (f.lane===lane) return;
    if (f.lane && !arrived && inView(f.car.position,camera)) return;
    if (!lane) { f.lane=null; f.car.visible=false; return; }
    // Keep already-visible traffic moving on its current line while changing
    // districts. Recycle only off-screen unless the player explicitly teleports.
    const dir=patterns[f.laneIndex].reverse?-1:1;
    const start=lane.center + f.phase*dir;
    for (let i=0;i<8;i++) {
      const s=wrap(start+i*lane.length/8,lane.length);
      if (!arrived && inView(point(lane,s,probe),camera)) continue;
      f.lane=lane; f.s0=s; f.dispatchTime=elapsed;
      f.car.visible=true;
      f.car.rotation.set(0,lane.frame.heading(lane.begin+s),0);
      return;
    }
  }
  function update(dt,entity,camera) {
    elapsed+=dt;
    time.value=elapsed;
    const focus=entity.position;
    const arrived=previous.distanceToSquared(focus)>350**2;
    if (arrived || Math.hypot(focus.x-anchor.x,focus.z-anchor.z)>220 ||
      (upperLevel(focus.y)!==targetLevel && Math.abs(focus.y-targetLevel)>48)) dispatch(focus,entity.heading);
    for (const f of flights) {
      assign(f,camera,arrived);
      if (!f.lane) continue;
      // Source vehicle_state(): advance along the lane, apply its world bend,
      // float gently about the assigned altitude, and face the path tangent.
      const s=wrap(f.s0+f.speed*(elapsed-f.dispatchTime),f.lane.length);
      point(f.lane,s,f.car.position);
      f.car.position.y+=.6*Math.sin(elapsed*1.1+f.s0);
      f.car.rotation.y=f.lane.frame.heading(f.lane.begin+s);
    }
    previous.copy(focus);
  }
  update(0,{position:new THREE.Vector3(3.6,0,streetZ(37)+12),heading:0},null);
  group.updateMatrixWorld(true);
  return {group,update};
}
