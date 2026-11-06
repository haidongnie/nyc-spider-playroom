import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, color, max, modelWorldMatrix, modelWorldMatrixInverse, positionGeometry, vec4
} from 'three/tsl';

// Japanese Seaside Street's outline pass (pwe/bte/RC/EC in its published
// main.js) welds normals at matching positions, expands a mesh in world space
// in proportion to camera distance, and renders only its back faces.
const SHADE = 0x3a4152;
const WIDTH = 0.0019;
const MAX_STREET_BATCHES = 8;
const MAX_STREET_TRIANGLES = 66000;

function shellGeometry(source) {
  const position = source.getAttribute('position'), normal = source.getAttribute('normal');
  const count = position.count;
  const vectorSums = [], groups = new Map();
  const groupOf = new Int32Array(count).fill(-1);
  // Spinner LOD batches share one vertex buffer. Visit precisely the vertices
  // drawn by this body, so cabin glass and exhaust normals cannot cancel its ink.
  const indices = source.index;
  for (let i=0, n=indices ? indices.count : count; i<n; i++) {
    const j = indices ? indices.getX(i) : i;
    if (groupOf[j] !== -1) continue;
    const key = `${Math.round(position.getX(j)*1000)},${Math.round(position.getY(j)*1000)},${Math.round(position.getZ(j)*1000)}`;
    let g = groups.get(key);
    if (g === undefined) { g = vectorSums.length; groups.set(key,g); vectorSums.push(0,0,0); }
    groupOf[j] = g;
    vectorSums[g]   += normal.getX(j);
    vectorSums[g+1] += normal.getY(j);
    vectorSums[g+2] += normal.getZ(j);
  }
  for (let i=0; i<vectorSums.length; i+=3) {
    const scale = Math.hypot(vectorSums[i],vectorSums[i+1],vectorSums[i+2]);
    if (scale < 1e-6) continue;
    vectorSums[i] /= scale; vectorSums[i+1] /= scale; vectorSums[i+2] /= scale;
  }
  const smoothed = new Float32Array(count*3);
  for (let j=0; j<count; j++) {
    const g=groupOf[j];
    if (g<0) continue;
    smoothed[j*3]=vectorSums[g]; smoothed[j*3+1]=vectorSums[g+1]; smoothed[j*3+2]=vectorSums[g+2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position',position);
  geometry.setAttribute('normal',normal);
  geometry.setAttribute('seasideOutlineNormal',new THREE.BufferAttribute(smoothed,3));
  geometry.setIndex(indices);
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  geometry.boundingBox = source.boundingBox;
  geometry.boundingSphere = source.boundingSphere;
  return geometry;
}

function shellMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({side:THREE.BackSide});
  mat.name = 'Japanese Seaside Street / OutlineInk';
  mat.colorNode = color(SHADE);
  const world = modelWorldMatrix.mul(vec4(positionGeometry,1)).xyz;
  const direction = modelWorldMatrix.mul(vec4(attribute('seasideOutlineNormal','vec3'),0)).xyz;
  const n = direction.div(max(direction.length(), 0.000001));
  const thickness = cameraPosition.distance(world).mul(WIDTH);
  mat.positionNode = modelWorldMatrixInverse.mul(vec4(world.add(n.mul(thickness)),1)).xyz;
  return mat;
}

function eligible(mesh) {
  const m=mesh?.material, g=mesh?.geometry;
  return mesh?.isMesh && !mesh.isInstancedMesh && !mesh.isSkinnedMesh && !mesh.userData.shadowProxy &&
    m && !Array.isArray(m) && m.visible && !m.transparent && !m.alphaTest && !m.alphaMap &&
    !m.alphaTestNode && !m.maskNode && !m.positionNode && !m.displacementMap &&
    g?.getAttribute('position') && g.getAttribute('normal');
}

function landmarkBodies(scene) {
  const bodies=[];
  const root = scene.getObjectByName('ManhattanLandmarks');
  if (!root) return bodies;
  for (const landmark of root.children) {
    const shells=[];
    landmark.traverse(mesh=>{
      if (!eligible(mesh) || !mesh.castShadow) return;
      const geometry=mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const size=geometry.boundingBox.getSize(new THREE.Vector3());
      if (size.y<6 || Math.min(size.x,size.z)<2.5) return;
      shells.push({mesh,volume:size.x*size.y*size.z});
    });
    shells.sort((a,b)=>b.volume-a.volume);
    bodies.push(...shells.slice(0,4).map(({mesh})=>mesh));
  }
  return bodies.slice(0,48);
}

export function createSeasideOutlines({scene, camera, controllerManager, airTraffic}) {
  const material=shellMaterial(), geometries=new WeakMap(), shells=new WeakMap(), sourceGeometry=new WeakMap();
  const fixed = landmarkBodies(scene), player = new Map();
  const taxi=controllerManager?.entities.car, spinner=controllerManager?.entities.skycar;
  if(taxi) {
    const bodies=taxi.chassisPivot.children.filter(o=>o.castShadow && eligible(o));
    for(const wheel of taxi.wheels) if(eligible(wheel.tire)) bodies.push(wheel.tire);
    player.set(taxi.mesh,bodies);
  }
  if(spinner) player.set(spinner.mesh,spinner.model.children.filter(m=>['Hull','Paint'].includes(m.name) && eligible(m)));
  for(const car of airTraffic?.group.children || [])
    fixed.push(...car.children.filter(m=>['Hull','Paint'].includes(m.name) && eligible(m)));

  // Surveyed facade/roof batches are shared, ordinary meshes grouped in
  // kilometer cells. Outline only nearby batches, with an explicit triangle
  // budget, so a switch doesn't re-draw the whole island or its shadow proxies.
  const streets=[];
  scene.getObjectByName('ManhattanCityBlocks')?.traverse(mesh=>{
    if(mesh.name!=='SurveyedBuildingChunk' || !eligible(mesh)) return;
    const {geometry}=mesh;
    if(!geometry.boundingBox) geometry.computeBoundingBox();
    const center=geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    streets.push({mesh,x:center.x,z:center.z,triangles:geometry.index.count/3});
  });
  const active=new Set();
  let cellX=Infinity,cellZ=Infinity, nearby=[], enabled=false;
  const eye=new THREE.Vector3(), inverse=new THREE.Matrix4();

  function getShell(mesh) {
    let shell=shells.get(mesh);
    if(shell && sourceGeometry.get(mesh)===mesh.geometry) return shell;
    let geometry=geometries.get(mesh.geometry);
    if(!geometry) { geometry=shellGeometry(mesh.geometry); geometries.set(mesh.geometry,geometry); }
    sourceGeometry.set(mesh,mesh.geometry);
    if(shell){shell.geometry=geometry;return shell;} // A driven traffic car can replace the taxi body and wheels.
    shell=new THREE.Mesh(geometry,material);
    shell.name=`${mesh.name || 'Landmark'} · Seaside ink`;
    shell.userData.seasideOutline=true;
    shell.castShadow=false; shell.receiveShadow=false;
    shell.matrixAutoUpdate=false;
    shell.layers.mask=mesh.layers.mask;
    shells.set(mesh,shell);
    return shell;
  }
  function attach(mesh) {
    const shell=getShell(mesh);
    mesh.add(shell);
    // Static island roots have matrix auto-updates disabled after startup.
    // Initialize against the host's actual transform. Dynamic roots propagate
    // the same identity child matrix normally on subsequent frames.
    shell.updateMatrixWorld(true);
    active.add(mesh);
  }
  function detach(mesh) {
    shells.get(mesh)?.removeFromParent();
    active.delete(mesh);
  }
  function update() {
    if (!enabled) return;
    const {x,z}=camera.position;
    const cx=Math.floor(x/250),cz=Math.floor(z/250);
    if(cx!==cellX || cz!==cellZ) {
      cellX=cx;cellZ=cz;
      const candidates=streets.map(item=>({item,d:(item.x-x)**2+(item.z-z)**2}))
        .filter(({d})=>d<1300**2).sort((a,b)=>a.d-b.d);
      let budget=MAX_STREET_TRIANGLES;
      const next=[];
      for(const {item} of candidates) {
        if(item.triangles>budget) continue;
        budget-=item.triangles; next.push(item.mesh);
        if(next.length===MAX_STREET_BATCHES)break;
      }
      for(const mesh of nearby) if(!next.includes(mesh)) detach(mesh);
      for(const mesh of next) if(!active.has(mesh)) attach(mesh);
      nearby=next;
    }
    for(const [root,bodies] of player) {
      eye.copy(camera.position).applyMatrix4(inverse.copy(root.matrixWorld).invert());
      const inside = Math.abs(eye.x)<1.45 && Math.abs(eye.z)<2.88 && eye.y>-.5 && eye.y<2.1;
      for(const mesh of bodies) getShell(mesh).visible=!inside;
    }
  }
  function enable() {
    enabled=true;
    for(const mesh of fixed) attach(mesh);
    for(const bodies of player.values()) for(const mesh of bodies) attach(mesh);
    update();
  }
  function disable() {
    enabled=false;
    for(const mesh of [...active]) detach(mesh);
    nearby=[]; cellX=cellZ=Infinity;
  }
  return {enable,disable,update};
}
