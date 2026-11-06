// The user's Tripo GLB, with its own skin, texture and both original clips.
// The starting GLB has the original mesh and animation buffers. Only the run's horizontal root motion is removed when
// creating a runtime clip; the NYC controller already moves the actor.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from './GLTFLoader.js';

import { loadGameAsset } from '../js/asset-fetch.js';
const model = await loadGameAsset(new URL('./civilian-start.glb.gz', import.meta.url), bytes => {
  if (bytes.length < 12) throw Error('Incomplete civilian GLB.');
  const header = new DataView(bytes.buffer);
  if (header.getUint32(0,true) !== 0x46546c67 || header.getUint32(8,true) !== bytes.length) throw Error('Invalid civilian GLB.');
  return bytes.buffer;
});
const gltf = await new GLTFLoader().parseAsync(model, '');
const template = gltf.scene;
template.updateMatrixWorld(true);
template.traverse((mesh) => {
  if (!mesh.isSkinnedMesh) return;
  mesh.skeleton.update();
  mesh.boundingBox = null;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
});
const restBounds = new THREE.Box3().setFromObject(template);
const clips = new Map();
for (const source of gltf.animations) {
  const clip = source.clone();
  if (clip.name === 'look_around.001') clips.set('idle', clip);
  if (clip.name === 'run.001') {
    const hips = template.getObjectByName('mixamorigHips');
    for (const track of clip.tracks) {
      if (track.name !== 'mixamorigHips.position') continue;
      const firstX = track.values[0], firstZ = track.values[2];
      const travel = track.values[track.values.length - 1] - firstZ;
      const start = track.times[0], span = track.times[track.times.length - 1] - start;
      for (let key = 0; key < track.times.length; key++) {
        const i = key * 3;
        track.values[i] = hips.position.x + track.values[i] - firstX;
        const phase = (track.times[key] - start) / span;
        track.values[i + 2] = hips.position.z + track.values[i + 2] - firstZ - travel * phase;
      }
    }
    clips.set('run', clip);
  }
}
if (!clips.has('idle') || !clips.has('run')) throw new Error('Civilian motion clips are missing.');
export const civilianRig = {template, clips, restBounds, height: 1.82, civilian: true};

// The first street view uses a 1024px preview. Swap in the supplied 4096px
// texture only after the city is playable. All local and remote rigs share it.
window.addEventListener('nyc-playable', () => {
  if (navigator.connection?.saveData) return;
  const upgrade = async () => {
    const map = template.getObjectByProperty('isSkinnedMesh', true)?.material.map;
    if (!map) return;
    const url = new URL('./civilian-full.jpg', import.meta.url).href;
    const previous = map.image;
    try {
      let fullImage;
      if (typeof ImageBitmap !== 'undefined' && previous instanceof ImageBitmap) {
        const result = await fetch(url, {priority:'low'});
        if (!result.ok) return;
        fullImage = await createImageBitmap(await result.blob(), {
          premultiplyAlpha:'none', colorSpaceConversion:'none'
        });
      } else {
        fullImage = new Image();
        fullImage.decoding = 'async';
        fullImage.fetchPriority = 'low';
        fullImage.src = url;
        await fullImage.decode();
      }
      // WebGPU textures have immutable dimensions. Reallocate the 1024px GPU
      // image while keeping the Texture object used by every local/remote rig.
      map.dispose();
      map.image = fullImage;
      map.needsUpdate = true;
      previous?.close?.();
    } catch { /* Keep the ready preview on an interrupted connection. */ }
  };
  if (window.requestIdleCallback) window.requestIdleCallback(upgrade, {timeout:6000});
  else setTimeout(upgrade, 1800);
}, {once:true});
