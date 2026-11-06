// The user's Tripo GLB, with its own skin, texture and both original clips.
// The GLB stays intact. Only the run's horizontal root motion is removed when
// creating a runtime clip; the NYC controller already moves the actor.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from './GLTFLoader.js';

const response = await fetch(new URL('./civilian.glb', import.meta.url));
if (!response.ok) throw new Error('Could not load the civilian character.');
const gltf = await new GLTFLoader().parseAsync(await response.arrayBuffer(), '');
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
