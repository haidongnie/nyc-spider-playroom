// Aircraft lamp sprites from Cyber Web City's traffic.wgsl; see ../skycar-assets/LICENSE-Cyber-Web-City.md.
import * as THREE from 'three/webgpu';
import { attribute, float, length, mrt, smoothstep, uv, vec2, vec4 } from 'three/tsl';

const LAMP_RADIUS = 0.35;
const MIN_RADIUS_PX = 1.2;
const SHUTTER = 1 / 30;
const MAX_RANGE = 4000;

// One billboard draw for the entire fleet. Instances carry a world-space centre, a camera-facing
// streak size/angle, and linear HDR colour. No scene lights or extra shadow passes are needed.
export function createAirTrafficLights(scene, group) {
  const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  geometry.instanceCount = 0;
  const capacity = Math.max(1, group.children.length) * 4;
  const makeBuffer = (name) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
    return attr;
  };
  const points = makeBuffer('airLampCenter');
  const shapes = makeBuffer('airLampShape');
  const colors = makeBuffer('airLampColor');

  const material = new THREE.SpriteNodeMaterial({
    transparent: true, fog: false, blending: THREE.AdditiveBlending, depthTest: true, depthWrite: false
  });
  material.positionNode = attribute('airLampCenter', 'vec4').xyz;
  const shape = attribute('airLampShape', 'vec4');
  material.scaleNode = shape.xy;
  material.rotationNode = shape.z;
  const local = uv().mul(2).sub(1);
  const falloff = float(1).sub(smoothstep(0, 1, length(vec2(local.x.mul(0.5), local.y))));
  material.colorNode = attribute('airLampColor', 'vec4').rgb.mul(falloff.mul(falloff));
  material.opacityNode = float(1);
  material.mrtNode = mrt({ normal: vec4(0), metalRough: vec4(0) });

  const batch = new THREE.Mesh(geometry, material);
  batch.name = 'AirTrafficLampStreaks';
  batch.frustumCulled = false;
  batch.visible = false;
  batch.renderOrder = 2;
  batch.matrixAutoUpdate = false;
  scene.add(batch);
  batch.updateMatrixWorld(true); // Scene matrix auto-update is disabled; the batch stays at world identity.

  const previousEye = new THREE.Vector3();
  const cameraVelocity = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const relative = new THREE.Vector3();
  const base = new THREE.Vector3();
  const tail = new THREE.Vector3();
  const startClip = new THREE.Vector3();
  const endClip = new THREE.Vector3();
  let havePreviousEye = false;

  function update(dt, camera) {
    if (!camera?.isPerspectiveCamera || !group.visible) {
      batch.visible = false;
      havePreviousEye = false;
      return;
    }
    camera.updateMatrixWorld();
    eye.setFromMatrixPosition(camera.matrixWorld);
    cameraVelocity.set(0, 0, 0);
    if (havePreviousEye && dt > 0) {
      cameraVelocity.subVectors(eye, previousEye).multiplyScalar(1 / dt);
      // A teleport/camera cut is not a physical velocity and should not stretch across the screen.
      if (cameraVelocity.lengthSq() > 200 * 200) cameraVelocity.set(0, 0, 0);
    }
    previousEye.copy(eye);
    havePreviousEye = true;
    const height = window.innerHeight;
    const width = height * camera.aspect;
    const focalPixels = height * camera.projectionMatrix.elements[5] * 0.5;
    let count = 0;
    for (const craft of group.children) {
      if (!craft.visible || !Number.isFinite(craft.userData.cruiseSpeed)) continue;
      const distanceSq = craft.position.distanceToSquared(eye);
      if (distanceSq >= MAX_RANGE * MAX_RANGE) continue;
      const fx = Math.sin(craft.rotation.y), fz = Math.cos(craft.rotation.y);
      relative.set(fx * craft.userData.cruiseSpeed, 0, fz * craft.userData.cruiseSpeed).sub(cameraVelocity);
      for (let i = 0; i < 4 && count < capacity; i++) {
        const head = i < 2;
        const side = i % 2 ? 0.7 : -0.7;
        const longitudinal = head ? 2.6 : -2.6;
        base.set(craft.position.x + fz * side + fx * longitudinal, craft.position.y + 0.5,
          craft.position.z - fx * side + fz * longitudinal);
        tail.copy(base).addScaledVector(relative, -SHUTTER);
        startClip.copy(base).applyMatrix4(camera.matrixWorldInverse);
        endClip.copy(tail).applyMatrix4(camera.matrixWorldInverse);
        const depth = -startClip.z;
        if (depth < 0.5 || endClip.z > -0.5) continue;
        startClip.applyMatrix4(camera.projectionMatrix);
        endClip.applyMatrix4(camera.projectionMatrix);
        if (Math.abs(startClip.x) > 1.1 || Math.abs(startClip.y) > 1.1) continue;
        const dx = (endClip.x - startClip.x) * 0.5 * width;
        const dy = (endClip.y - startClip.y) * 0.5 * height;
        const streak = Math.hypot(dx, dy);
        const pixelsPerMeter = focalPixels / depth;
        const radiusPx = Math.max(MIN_RADIUS_PX, LAMP_RADIUS * pixelsPerMeter);
        const emitterDistance = Math.max(0.01, eye.distanceTo(base));
        const facing = ((eye.x - base.x) * fx + (eye.z - base.z) * fz) / emitterDistance * (head ? 1 : -1);
        const beam = 0.12 + 0.88 * Math.max(0, facing) ** 3;
        const spread = (LAMP_RADIUS * pixelsPerMeter / radiusPx) ** 2;
        const exposure = Math.min(1, spread * 4 * THREE.MathUtils.clamp(6 / Math.max(1, streak), 0.2, 1));
        const gain = beam * exposure * 1.5 * Math.exp(-depth * 0.00035);

        points.setXYZW(count, (base.x + tail.x) * 0.5, (base.y + tail.y) * 0.5, (base.z + tail.z) * 0.5, 1);
        shapes.setXYZW(count, (streak + 2 * radiusPx) / pixelsPerMeter, 2 * radiusPx / pixelsPerMeter, Math.atan2(dy, dx), 0);
        colors.setXYZW(count, (head ? 10 : 9) * gain, (head ? 9 : 0.35) * gain, (head ? 7.5 : 0.15) * gain, 1);
        count++;
      }
    }
    batch.visible = count > 0;
    geometry.instanceCount = count;
    if (!count) return;
    for (const buffer of [points, shapes, colors]) {
      buffer.clearUpdateRanges();
      buffer.addUpdateRange(0, count * 4);
      buffer.needsUpdate = true;
    }
  }
  return { update };
}
