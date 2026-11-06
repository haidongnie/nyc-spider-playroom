// A complementary cut through both animated characters. Heights are measured
// in their shared root, so the moving cut follows a rider, aircraft, or swing.
import * as THREE from 'three/webgpu';
import { abs, color, dot, float, materialEmissive, positionLocal, smoothstep, uniform } from 'three/tsl';

const MATCH_JOINTS = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder',
  'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand',
  'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'
];
const seated = new Set(['drive', 'spinner', 'fly', 'cycle']);

// Capture the native bind orientation of corresponding bones before either mixer starts.
export function captureRevealRig(root, bones) {
  root.updateWorldMatrix(true, true);
  const joints = new Map();
  for (const name of MATCH_JOINTS) {
    const bone = bones[name];
    if (bone) joints.set(name, {bone, bind: bone.getWorldQuaternion(new THREE.Quaternion())});
  }
  return joints;
}

export function createSuitReveal(root, civilian, spider) {
  const progress = uniform(0);
  const boundary = uniform(0);
  const meshPlanes = [];
  function attachMask(rig, isSuit) {
    rig.root.traverse(mesh => {
      if (!mesh.isMesh) return;
      // Work directly from the deformed vertex, before any world translation.
      // This avoids subtracting two large world-space coordinates in the shader
      // when the actor is high above Manhattan or on a pitched aircraft.
      const plane = uniform(new THREE.Vector4(0, 1, 0, 0));
      meshPlanes.push({mesh, plane});
      const distance = dot(positionLocal, plane.xyz).add(plane.w).sub(boundary);
      const keep = isSuit ? progress.greaterThanEqual(1).or(progress.greaterThan(0).and(distance.lessThanEqual(0)))
        : progress.lessThanEqual(0).or(progress.lessThan(1).and(distance.greaterThan(0)));
      const active = progress.greaterThan(0).and(progress.lessThan(1));
      const seam = float(1).sub(smoothstep(0.005, 0.033, abs(distance))).mul(active.select(1, 0));
      const variants = [].concat(mesh.material).map(source => {
        // Native NodeMaterials include the reveal graph in their program key;
        // ordinary Material clones with extra properties may reuse another actor's uniforms.
        const variant = source.isMeshToonMaterial ? new THREE.MeshToonNodeMaterial()
          : source.isMeshBasicMaterial ? new THREE.MeshBasicNodeMaterial() : new THREE.MeshStandardNodeMaterial();
        for (const name of ['name','map','side','gradientMap','metalness','roughness','metalnessMap','roughnessMap',
          'emissiveIntensity','emissiveMap','normalMap','vertexColors','opacity','transparent','alphaTest',
          'depthTest','depthWrite','flatShading','fog','toneMapped']) {
          if (name in source && name in variant) variant[name] = source[name];
        }
        if (source.color) variant.color.copy(source.color);
        if (source.emissive) {
          variant.emissive.copy(source.emissive);
          variant.emissiveNode = materialEmissive.add(color(0xffc87a).mul(seam).mul(1.35));
        }
        variant.maskNode = variant.maskShadowNode = keep;
        return variant;
      });
      mesh.material = Array.isArray(mesh.material) ? variants : variants[0];
    });
  }
  attachMask(civilian, false);
  attachMask(spider, true);

  const pairs = [];
  for (const [name, c] of civilian.joints) {
    const s = spider.joints.get(name);
    if (!s) continue;
    const cToS = c.bind.clone().invert().multiply(s.bind);
    pairs.push({c: c.bone, s: s.bone, cToS, sToC: cToS.clone().invert(),
      nativeC: new THREE.Quaternion(), nativeS: new THREE.Quaternion(),
      worldC: new THREE.Quaternion(), worldS: new THREE.Quaternion()});
  }
  const rotation = new THREE.Quaternion(), desired = new THREE.Quaternion(), mapped = new THREE.Quaternion();
  const inv = new THREE.Matrix4(), relative = new THREE.Matrix4(), sample = new THREE.Vector3(), delta = new THREE.Vector3();
  let adjusted = false;
  function restore() {
    if (!adjusted) return;
    civilian.root.position.set(0, 0, 0);
    spider.root.position.set(0, 0, 0);
    for (const pair of pairs) {
      pair.c.quaternion.copy(pair.nativeC);
      pair.s.quaternion.copy(pair.nativeS);
    }
    adjusted = false;
  }
  function rotateBone(bone, orientation) {
    bone.quaternion.copy(bone.parent.getWorldQuaternion(rotation).invert().multiply(orientation));
    bone.updateWorldMatrix(false, false);
  }
  function matchPose(p) {
    // Blend both *native* poses in one anatomical frame. A running thigh or bent
    // forearm then joins up at the cut even when the rigs use different joint axes.
    for (const pair of pairs) {
      pair.nativeC.copy(pair.c.quaternion);
      pair.nativeS.copy(pair.s.quaternion);
      pair.c.getWorldQuaternion(pair.worldC);
      pair.s.getWorldQuaternion(pair.worldS);
    }
    for (const pair of pairs) {
      mapped.copy(pair.worldS).multiply(pair.sToC);
      desired.copy(pair.worldC).slerp(mapped, p);
      rotateBone(pair.c, desired);
      mapped.copy(pair.worldC).multiply(pair.cToS);
      desired.copy(mapped).slerp(pair.worldS, p);
      rotateBone(pair.s, desired);
    }
    const hips = pairs[0];
    root.worldToLocal(hips.s.getWorldPosition(delta));
    root.worldToLocal(hips.c.getWorldPosition(sample));
    delta.sub(sample);
    civilian.root.position.copy(delta).multiplyScalar(p);
    spider.root.position.copy(delta).multiplyScalar(p - 1);
    root.updateWorldMatrix(true, true);
    adjusted = true;
  }

  function update(p, pose) {
    progress.value = p;
    if (!(p > 0 && p < 1)) return;
    // Seat poses already have a shared saddle, pedals and control targets. Blending
    // their joint orientations again would pull the shorter rig's hands off its grips.
    if (!seated.has(pose)) matchPose(p);
    root.updateWorldMatrix(true, true);
    inv.copy(root.matrixWorld).invert();
    for (const {mesh, plane} of meshPlanes) {
      const e = relative.multiplyMatrices(inv, mesh.matrixWorld).elements;
      plane.value.set(e[1], e[5], e[9], e[13]);
    }
    let low = Infinity, high = -Infinity;
    for (const pair of pairs) {
      for (const bone of [pair.c, pair.s]) {
        sample.setFromMatrixPosition(bone.matrixWorld).applyMatrix4(inv);
        low = Math.min(low, sample.y);
        high = Math.max(high, sample.y);
      }
    }
    const eased = p * p * (3 - 2 * p);
    boundary.value = THREE.MathUtils.lerp(low - 0.16, high + 0.27, eased);
  }
  const civHand = new THREE.Vector3(), suitHand = new THREE.Vector3();
  function hand(side, target) {
    if (progress.value <= 0) return civilian.getHand(side, target);
    if (progress.value >= 1) return spider.getHand(side, target);
    // Anchor the web to the wrist visible at that height, easing through the
    // seam to avoid a pop when the hands differ slightly in bone length.
    civilian.getHand(side, civHand);
    spider.getHand(side, suitHand);
    const h = sample.copy(civHand).lerp(suitHand, 0.5).applyMatrix4(inv).y;
    const shown = 1 - THREE.MathUtils.smoothstep(h, boundary.value - 0.04, boundary.value + 0.04);
    return target.copy(civHand).lerp(suitHand, shown);
  }
  return {restore, update, hand};
}
