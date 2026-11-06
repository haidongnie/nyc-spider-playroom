// Peter Parker's original suit, skeleton and animation tracks from the user's
// Friendly Neighborhood Spider-Man project. See ../spider-assets/NOTICE.txt.
import * as THREE from 'three/webgpu';
import { captureRevealRig, createSuitReveal } from './suit-reveal.js';
import { civilianRig } from '../spider-assets/civilian.js';
import { clone as cloneSkeleton } from '../spider-assets/SkeletonUtils.js';

const response = await fetch(new URL('../spider-assets/peter.json.gz', import.meta.url));
if (!response.ok) throw new Error('Could not load the Spider-Man character.');
const bytes = new Uint8Array(await response.arrayBuffer());
const text = bytes[0] === 31 && bytes[1] === 139
  ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  : new TextDecoder().decode(bytes);
const data = JSON.parse(text);
const template = new THREE.ObjectLoader().parse(data.model);
const texture = await new THREE.TextureLoader().loadAsync('data:' + data.texture.mime + ';base64,' + data.texture.data);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 4;
const ramp = new THREE.DataTexture(new Uint8Array([70, 70, 70, 255, 150, 150, 150, 255, 225, 225, 225, 255, 255, 255, 255, 255]), 4, 1);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.needsUpdate = true;
const clips = new Map(Object.entries(data.clips).map(([key, clip]) => [key, THREE.AnimationClip.parse(clip)]));
const outlines = [];
const ink = new THREE.MeshBasicMaterial({ color: 0x0c0612, side: THREE.BackSide });
template.traverse((mesh) => {
  if (!mesh.isSkinnedMesh) return;
  const old = mesh.material;
  mesh.material = new THREE.MeshToonMaterial({ color: old.color, gradientMap: ramp,
    map: data.texture.meshes[mesh.name] ? texture : null });
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // Expand the source's backface ink shell in bind space. It then follows the
  // same bones as the body, including the fingers, mask and seated poses.
  const geometry = mesh.geometry.clone();
  const position = geometry.attributes.position, normal = geometry.attributes.normal;
  for (let i = 0; i < position.count; i++) {
    position.setXYZ(i, position.getX(i) + normal.getX(i) * 0.011,
      position.getY(i) + normal.getY(i) * 0.011, position.getZ(i) + normal.getZ(i) * 0.011);
  }
  const shell = new THREE.SkinnedMesh(geometry, ink);
  shell.name = mesh.name + ' ink';
  shell.position.copy(mesh.position); shell.quaternion.copy(mesh.quaternion); shell.scale.copy(mesh.scale);
  shell.bind(mesh.skeleton, mesh.bindMatrix);
  shell.frustumCulled = false;
  outlines.push([mesh.parent, shell]);
});
// ObjectLoader restores bones in local space; update their world transforms before
// measuring a skinned rest pose, even when the city disables automatic world updates.
template.updateMatrixWorld(true);
template.traverse((mesh) => {
  if (mesh.isSkinnedMesh) { mesh.skeleton.update(); mesh.boundingBox = null; }
});
const restBounds = new THREE.Box3().setFromObject(template);
const spiderRig = {template, clips, restBounds, height: 1.86, civilian: false};
for (const [parent, shell] of outlines) parent.add(shell);

const seatedModes = new Set(['drive', 'cycle', 'fly', 'spinner']);
const once = new Set(['jump', 'takeoff', 'hardland', 'webshootR', 'webshootL']);
const up = new THREE.Vector3(0, 1, 0);

// Each actor has its own animated bones and mixer, with geometry, clips and skin texture shared.
// The root's origin is at the feet on foot/in flight, or at the saddle/seat when riding.
function createRig({template, clips, restBounds, height, civilian}) {
  const root = new THREE.Group();
  root.name = civilian ? 'Civilian' : 'Spider-Man';
  const actorScale = height / (restBounds.max.y - restBounds.min.y);
  const placement = new THREE.Group();
  const actor = cloneSkeleton(template);
  actor.scale.multiplyScalar(actorScale);
  actor.position.y -= restBounds.min.y * actorScale;
  placement.add(actor); root.add(placement);
  const mixer = new THREE.AnimationMixer(actor);
  const bones = {};
  actor.traverse((item) => { if (item.isBone) bones[item.name.replace(/^mixamorig/, '')] ??= item; });
  const joints = captureRevealRig(root, bones);
  const actions = new Map();
  const posedBones = Object.entries(bones).filter(([name]) => /^(Spine1?|Neck|(Left|Right)(Arm|ForeArm|UpLeg|Leg|Foot))$/.test(name))
    .map(([, bone]) => ({ bone, source: new THREE.Quaternion() }));
  let restoreSeat = false;
  let currentKey = null, currentAction = null, lastPose = null;
  const world = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const dir = new THREE.Vector3(), pole = new THREE.Vector3(), elbow = new THREE.Vector3(), reach = new THREE.Vector3();
  const from = new THREE.Vector3(), to = new THREE.Vector3(), target = new THREE.Vector3();
  const q = new THREE.Quaternion(), p = new THREE.Quaternion(), d = new THREE.Quaternion();

  function positionInRoot(bone, out) {
    return root.worldToLocal(bone.getWorldPosition(out));
  }

  function pointBone(bone, child, toward) {
    bone.getWorldPosition(world);
    from.subVectors(child.getWorldPosition(from), world).normalize();
    to.copy(toward);
    root.localToWorld(to).sub(world).normalize();
    if (!from.lengthSq() || !to.lengthSq()) return;
    d.setFromUnitVectors(from, to);
    bone.getWorldQuaternion(q);
    bone.parent.getWorldQuaternion(p);
    bone.quaternion.copy(p.invert().multiply(d).multiply(q));
    bone.updateWorldMatrix(false, true);
  }

  // Aim an anatomical two-bone chain at a control. The elbow/knee bends
  // toward its pole while both original bone lengths stay unchanged.
  function poseLimb(upper, middle, end, destination, poleX, poleY, poleZ) {
    positionInRoot(upper, a); positionInRoot(middle, b); positionInRoot(end, c);
    const first = a.distanceTo(b), second = b.distanceTo(c);
    dir.subVectors(destination, a);
    const length = THREE.MathUtils.clamp(dir.length(), Math.abs(first - second) + 0.0001, first + second - 0.0001);
    dir.normalize();
    pole.set(poleX, poleY, poleZ).addScaledVector(dir, -pole.dot(dir));
    if (pole.lengthSq() < 0.0001) pole.copy(up).addScaledVector(dir, -dir.y);
    pole.normalize();
    const along = (first * first - second * second + length * length) / (2 * length);
    elbow.copy(a).addScaledVector(dir, along).addScaledVector(pole, Math.sqrt(Math.max(0, first * first - along * along)));
    reach.copy(a).addScaledVector(dir, length);
    pointBone(upper, middle, elbow);
    pointBone(middle, end, reach);
  }

  function poseSeat(pose, phase) {
    const cycling = pose === 'cycle';
    const spinner = pose === 'spinner';
    // Start each pose from the source idle clip so the head, back and fingers
    // retain the original character instead of straightening into bind pose.
    // Lean in the bicycle's forward axis. The imported Mixamo spine has
    // joint pre-rotations, so its local X is not the bike's pitch axis.
    placement.rotation.x = cycling ? 0.88 : 0.10;
    placement.position.set(0, 0, 0);
    root.updateWorldMatrix(true, true);
    positionInRoot(bones.Hips, world);
    placement.position.set(-world.x, 0.09 - world.y, -world.z);
    root.updateWorldMatrix(true, true);
    // Keep the mask looking down the road rather than toward the front wheel.
    const neck = bones.Neck;
    const rightAxis = from.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(p));
    d.setFromAxisAngle(rightAxis, -placement.rotation.x * 0.83);
    neck.getWorldQuaternion(q);
    neck.parent.getWorldQuaternion(p);
    neck.quaternion.copy(p.invert().multiply(d).multiply(q));
    neck.updateWorldMatrix(false, true);
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1; // The source model's anatomical left points toward +X.
      const prefix = side === 0 ? 'Left' : 'Right';
      const crank = phase + (side ? Math.PI : 0);
      target.set(sign * (cycling ? 0.20 : 0.205), cycling ? 0.05 : spinner ? 0.22 : 0.38, cycling ? 0.67 : spinner ? 0.60 : 0.44);
      poseLimb(bones[prefix + 'Arm'], bones[prefix + 'ForeArm'], bones[prefix + 'Hand'], target, sign, -0.75, -0.2);
      if (cycling) target.set(sign * 0.10, -0.54 - Math.cos(crank) * 0.17, 0.135 - Math.sin(crank) * 0.17);
      else if (spinner) target.set(sign * 0.15, 0.025, 0.67);
      else if (pose === 'drive') target.set(sign * 0.15, -0.12, 0.60);
      else target.set(sign * 0.15, -0.40, 0.55);
      poseLimb(bones[prefix + 'UpLeg'], bones[prefix + 'Leg'], bones[prefix + 'Foot'], target, sign * 0.12, 0.4, 1);
      // Keep toes pointing forward along the pedals rather than following the shin.
      positionInRoot(bones[prefix + 'Foot'], target);
      target.z += 1;
      pointBone(bones[prefix + 'Foot'], bones[prefix + 'ToeBase'], target);
    }
  }

  function update(dt, { pose = 'idle', speed = 0, side = 'right', phase = 0 } = {}) {
    const seated = seatedModes.has(pose);
    let key;
    if (civilian) {
      const moving = !seated && (pose === 'walk' || pose === 'run' || Math.abs(speed) > 0.5);
      key = moving ? 'run' : 'idle';
    } else {
      key = seated ? 'idle' : pose === 'webshoot' ? (side === 'left' ? 'webshootL' : 'webshootR')
        : pose === 'swing' ? (side === 'left' ? 'swingReachL' : 'swingReachR') : clips.has(pose) ? pose : 'idle';
    }
    if (key !== currentKey || seated !== seatedModes.has(lastPose)) {
      let action = actions.get(key);
      if (!action) { action = mixer.clipAction(clips.get(key)); actions.set(key, action); }
      if (action !== currentAction) {
        action.reset().setLoop(once.has(key) ? THREE.LoopOnce : THREE.LoopRepeat, once.has(key) ? 1 : Infinity);
        action.clampWhenFinished = once.has(key);
        action.play();
        if (currentAction && !seated && !seatedModes.has(lastPose)) action.crossFadeFrom(currentAction, 0.12, false);
        else if (currentAction) currentAction.stop();
      }
      currentKey = key; currentAction = action;
    }
    currentAction.paused = civilian && seated;
    if (currentAction.paused) currentAction.time = 0.15;
    currentAction.timeScale = civilian && key === 'run' ? THREE.MathUtils.clamp(Math.abs(speed) / 4.55, 0.28, 2.3)
      : key === 'walk' ? THREE.MathUtils.clamp(Math.abs(speed) / 1.7, 0.7, 1.7)
      : key === 'run' ? THREE.MathUtils.clamp(Math.abs(speed) / 5, 0.75, 1.5) : 1;
    if (restoreSeat) for (const {bone, source} of posedBones) bone.quaternion.copy(source);
    mixer.update(Math.max(0, dt));
    placement.position.set(0, 0, 0);
    placement.rotation.x = 0;
    restoreSeat = seated;
    if (seated) {
      for (const {bone, source} of posedBones) source.copy(bone.quaternion);
      poseSeat(pose, phase);
    }
    root.updateWorldMatrix(true, true);
    lastPose = pose;
  }

  function getHand(side, target) {
    const hand = side === 'left' ? bones.LeftHand : bones.RightHand;
    return hand.getWorldPosition(target);
  }
  update(0);
  return {root, update, getHand, joints};
}

// Both original rigs participate only while the changing suit crosses them.
// Outside that interval just one character is posed and drawn.
export function createSpiderAvatar() {
  const root = new THREE.Group();
  root.name = 'Player character';
  const civilian = createRig(civilianRig);
  const spider = createRig(spiderRig);
  root.add(civilian.root, spider.root);
  const reveal = createSuitReveal(root, civilian, spider);
  const duration = 1.15;
  let p = 0, target = 0;
  let previousPose = {};
  function poseCharacters(dt) {
    reveal.restore();
    civilian.root.visible = p < 1;
    spider.root.visible = p > 0;
    if (civilian.root.visible) civilian.update(dt, previousPose);
    if (spider.root.visible) spider.update(dt, previousPose);
    reveal.update(p, previousPose.pose);
  }
  function setSuited(suited = false, {immediate = false} = {}) {
    target = suited ? 1 : 0;
    if (immediate) {
      p = target;
      poseCharacters(0);
    }
  }
  function update(dt, options = {}) {
    previousPose = options;
    const step = Math.max(0, dt) / duration;
    p = target > p ? Math.min(target, p + step) : Math.max(target, p - step);
    poseCharacters(dt);
  }
  function getHand(side, point) { return reveal.hand(side, point); }
  setSuited(false, {immediate:true});
  return {root, update, getHand, setSuited, get suitProgress() { return p; }};
}
