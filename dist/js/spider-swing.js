import * as THREE from 'three/webgpu';
import { polygonContains, polygonSegmentFraction } from './building-collision.js';

// Friendly Neighborhood Spider-Man's assisted, reeled pendulum, adapted to this
// city's surveyed polygon prisms. Coordinates are world meters, with +Z forward.
const clamp = THREE.MathUtils.clamp;
const shellCache = new WeakMap();
function footprint(c) {
  if (c.polygon) return c.polygon;
  if (shellCache.has(c)) return shellCache.get(c);
  const o = c.obb;
  const cx = o?.cx ?? (c.minX + c.maxX) / 2,
    cz = o?.cz ?? (c.minZ + c.maxZ) / 2;
  const hx = o?.hx ?? (c.maxX - c.minX) / 2,
    hz = o?.hz ?? (c.maxZ - c.minZ) / 2;
  const cs = o?.cs ?? 1,
    sn = o?.sn ?? 0;
  const polygon = {
    holes: [],
    outer: [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz]
    ].map(([x, z]) => ({ x: cx + x * cs + z * sn, z: cz - x * sn + z * cs }))
  };
  shellCache.set(c, polygon);
  return polygon;
}

// Return whether the open segment enters the solid prism. This includes holes
// and the actual elevation of the ray, so a strand may pass safely over a roof.
function obstruction(c, start, end) {
  const dx = end.x - start.x,
    dy = end.y - start.y,
    dz = end.z - start.z;
  let lower = 0.002,
    upper = 0.995;
  for (const [p, d, min, max] of [
    [start.x, dx, c.minX, c.maxX],
    [start.z, dz, c.minZ, c.maxZ],
    [start.y, dy, c.minY ?? 0, c.maxY]
  ]) {
    if (Math.abs(d) < 1e-8) {
      if (p < min || p > max) return false;
    } else {
      const t0 = (min - p) / d,
        t1 = (max - p) / d;
      lower = Math.max(lower, Math.min(t0, t1));
      upper = Math.min(upper, Math.max(t0, t1));
    }
    if (upper <= lower) return false;
  }
  return polygonSegmentFraction(footprint(c), start.x, start.z, dx, dz, lower, upper) > 1e-5;
}

function strandMesh() {
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 7, 1);
  const material = new THREE.MeshBasicNodeMaterial({ color: 0xdcebf4 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Spider Web Strand';
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}
const UP = new THREE.Vector3(0, 1, 0);

export class SpiderSwing {
  constructor(manager, person) {
    this.manager = manager;
    this.person = person;
    this.velocity = new THREE.Vector3();
    this.pivot = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.radial = new THREE.Vector3();
    this.tangent = new THREE.Vector3();
    this.temp = new THREE.Vector3();
    this.hand = new THREE.Vector3();
    this.eye = new THREE.Vector3();
    this.line = strandMesh();
    manager.scene.add(this.line);
    this.reset();
  }
  reset() {
    this.anchor = null;
    this.anchorCollider = null;
    this.velocity.set(0, 0, 0);
    this.line.visible = false;
    this.state = 'ground';
    this.side = 'right';
    this.swingTime = 0;
    this.retry = 0;
    this.ropeLength = 0;
    this.webWasDown = false;
    this.jumpWasDown = false;
    this.closedSight = 0;
    this.groundY = this.person.position.y;
    this.groundSpeed = 0;
    this.viewHeading = this.person.heading;
    this.groundFacing = this.person.heading;
    this.backHeld = false;
    this.lastGroundInputWasBack = false;
    this.groundPOV = false;
  }
  floor(x, z, limit) {
    let y = this.manager.getGroundHeight(x, z, 'person');
    for (const c of this.manager.nearColliders(x, z, 0.55)) {
      if (
        c.maxY > y &&
        c.maxY <= limit + 0.22 &&
        x >= c.minX &&
        x <= c.maxX &&
        z >= c.minZ &&
        z <= c.maxZ &&
        polygonContains(footprint(c), x, z)
      )
        y = c.maxY;
    }
    return y;
  }
  findAnchor() {
    const p = this.person.position,
      fx = Math.sin(this.person.heading),
      fz = Math.cos(this.person.heading);
    const lead = clamp(13 + Math.hypot(this.velocity.x, this.velocity.z) * 0.3, 14, 26);
    const aimX = p.x + fx * lead,
      aimZ = p.z + fz * lead,
      aimY = p.y + clamp(lead + 6, 17, 30);
    this.eye.set(p.x, p.y + 1.45, p.z);
    const solids = this.manager.nearColliders(p.x, p.z, 65);
    const candidates = [];
    for (const c of solids) {
      if (c.maxY < p.y + 7 || c.maxY - (c.minY ?? 0) < 7 || Math.max(c.maxX - c.minX, c.maxZ - c.minZ) < 4)
        continue;
      const poly = footprint(c),
        y = clamp(aimY, Math.max(p.y + 6, (c.minY ?? 0) + 0.4), c.maxY - 0.35);
      for (const ring of [poly.outer, ...poly.holes])
        for (let j = 0, i = ring.length - 1; j < ring.length; i = j++) {
          const a = ring[i],
            b = ring[j],
            ex = b.x - a.x,
            ez = b.z - a.z,
            length2 = ex * ex + ez * ez;
          if (length2 < 0.02) continue;
          const t = clamp(((aimX - a.x) * ex + (aimZ - a.z) * ez) / length2, 0.01, 0.99);
          const x = a.x + t * ex,
            z = a.z + t * ez,
            dx = x - p.x,
            dz = z - p.z;
          const ahead = dx * fx + dz * fz,
            side = dx * fz - dz * fx,
            dy = y - this.eye.y,
            dist = Math.hypot(dx, dz, dy);
          if (ahead < 4 || Math.abs(side) < 2 || dist < 12 || dist > 62 || dy < Math.hypot(dx, dz) * 0.28)
            continue;
          const hand = side > 0 ? 'left' : 'right';
          const score =
            Math.hypot(x - aimX, y - aimY, z - aimZ) +
            Math.max(0, Math.abs(side) - 20) * 2 +
            (hand === this.side ? 3 : 0);
          candidates.push({ point: new THREE.Vector3(x, y, z), c, hand, score });
        }
    }
    candidates.sort((a, b) => a.score - b.score);
    for (const candidate of candidates.slice(0, 24)) {
      if (!solids.some((c) => obstruction(c, this.eye, candidate.point))) return candidate;
    }
    return null;
  }
  attach() {
    const hit = this.findAnchor();
    if (!hit) return false;
    const p = this.person.position;
    this.anchor = hit.point;
    this.anchorCollider = hit.c;
    this.side = hit.hand;
    this.swingTime = 0;
    this.closedSight = 0.12;
    this.pivot.copy(p);
    this.pivot.y += 1.0;
    this.ropeLength = this.pivot.distanceTo(this.anchor);
    this.targetLength = clamp(this.anchor.y - this.groundY - 4.4, 8, this.ropeLength);
    this.forward.set(Math.sin(this.person.heading), 0, Math.cos(this.person.heading));
    this.radial.subVectors(this.pivot, this.anchor).normalize();
    this.tangent.copy(this.forward).addScaledVector(this.radial, -this.forward.dot(this.radial)).normalize();
    const outward = this.velocity.dot(this.radial);
    if (outward > 0) this.velocity.addScaledVector(this.radial, -outward);
    this.velocity.addScaledVector(this.tangent, clamp(22 - this.velocity.dot(this.tangent), 0, 15));
    this.state = 'swing';
    return true;
  }
  release(boost = false) {
    if (!this.anchor) return;
    this.anchor = null;
    this.anchorCollider = null;
    this.line.visible = false;
    this.state = 'air';
    this.retry = 0.24;
    if (boost) this.velocity.y = Math.max(0, this.velocity.y) + 14;
  }
  update(dt, keys, view) {
    if (!(dt > 0)) return;
    const steps = Math.ceil(dt * 90),
      sub = dt / steps;
    for (let i = 0; i < steps; i++) this.advance(sub, keys, view);
    this.person.speed =
      this.state === 'ground' ? this.groundSpeed : Math.hypot(this.velocity.x, this.velocity.z);
    this.person.verticalVel = this.velocity.y;
  }
  walk(dt, forward, backward, steer, runSpeed, view) {
    const p = this.person;
    const pov = view?.activePresetId === 'pov';
    const back = !forward && backward > 0;
    if (pov !== this.groundPOV) {
      this.viewHeading = this.groundFacing = p.heading;
      this.backHeld = this.lastGroundInputWasBack = false;
      this.groundPOV = pov;
    }
    // Commit a freely orbited chase view as the new forward direction when
    // reversing. Its total camera angle stays fixed while the body turns.
    if (view?.activePresetId === 'chase' &&
      ((back && !this.backHeld) || (forward && this.lastGroundInputWasBack))) {
      this.viewHeading += view.orbitYawOffset;
      view.orbitYawOffset = 0;
    }
    this.viewHeading += steer * 2.6 * dt;
    this.groundFacing += steer * 2.6 * dt;
    if (back) {
      if (pov && !this.backHeld) {
        // Sample the view once: following the turning head every frame would
        // turn a held S into a continuous spin. Mouse look remains available.
        const aim = view.initialized
          ? Math.atan2(view.currentLookAt.x - view.currentPos.x, view.currentLookAt.z - view.currentPos.z)
          : p.heading + view.orbitYawOffset;
        p.heading = aim;
        view.orbitYawOffset = 0;
        this.viewHeading = this.groundFacing = aim + Math.PI;
      } else if (!pov) {
        const dx = view?.currentPos ? view.currentPos.x - p.position.x : 0;
        const dz = view?.currentPos ? view.currentPos.z - p.position.z : 0;
        this.groundFacing = dx * dx + dz * dz > 0.01 ? Math.atan2(dx, dz) : this.viewHeading + Math.PI;
      }
      this.lastGroundInputWasBack = true;
    } else if (forward) {
      this.groundFacing = this.viewHeading;
      this.lastGroundInputWasBack = false;
    }
    this.backHeld = back;
    const angle = this.groundFacing - p.heading;
    p.heading += clamp(Math.atan2(Math.sin(angle), Math.cos(angle)), -12 * dt, 12 * dt);
    // Accelerate out of the turn rather than initially running away from the camera.
    const target = (forward || backward * 0.65) * runSpeed * Math.max(0, Math.cos(this.groundFacing - p.heading));
    const acceleration = 18 * (runSpeed === 82 ? 10 : 1) * dt;
    this.groundSpeed += clamp(target - this.groundSpeed, -acceleration, acceleration);
    this.velocity.set(Math.sin(p.heading) * this.groundSpeed, 0, Math.cos(p.heading) * this.groundSpeed);
  }
  advance(dt, keys, view) {
    const p = this.person,
      pos = p.position,
      v = this.velocity;
    const flash = this.manager.spiderSuited && this.manager.selectedPower === 'flash';
    const suited = this.manager.spiderSuited !== false && !flash;
    const runSpeed = flash ? 82 : suited ? 10.5 : 8.2;
    const web = suited && Boolean(keys.web),
      jump = Boolean(keys.up),
      shoot = web && !this.webWasDown,
      leap = jump && !this.jumpWasDown;
    this.webWasDown = web;
    this.jumpWasDown = jump;
    const turn = Number(keys.left || 0) - Number(keys.right || 0),
      forward = Number(keys.forward || 0),
      brake = Number(keys.backward || 0);
    this.groundY = this.floor(pos.x, pos.z, pos.y);
    if (this.state === 'ground' && pos.y > this.groundY + 0.28) this.state = 'air';
    if (this.state === 'ground') {
      this.walk(dt, forward, brake, turn, runSpeed, view);
      pos.y = this.groundY;
    } else {
      p.heading += turn * 1.45 * dt;
      this.viewHeading = this.groundFacing = p.heading;
      this.backHeld = this.lastGroundInputWasBack = false;
    }
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    if (this.state === 'ground') {
      if (leap || shoot) {
        this.state = 'air';
        // Unsuited players use the original Manhattan pedestrian's jump.
        v.y = shoot ? 15.5 : suited ? 13.5 : 5.2;
        if (shoot) {
          v.x += fx * 6;
          v.z += fz * 6;
        }
      }
    }
    this.retry = Math.max(0, this.retry - dt);
    if (web && this.state === 'air' && !this.anchor && this.retry === 0) {
      if (!this.attach()) this.retry = 0.18;
    }
    if (this.anchor && (!web || (leap && !shoot))) this.release(leap);
    const previousY = pos.y;
    if (this.state === 'swing') {
      this.swingTime += dt;
      v.y -= 34 * dt;
      this.pivot.copy(pos);
      this.pivot.y += 1;
      this.radial.subVectors(this.pivot, this.anchor).normalize();
      this.tangent
        .copy(this.forward)
        .addScaledVector(this.radial, -this.forward.dot(this.radial))
        .normalize();
      if (brake) v.addScaledVector(this.tangent, -v.dot(this.tangent) * (1 - Math.exp(-1.6 * brake * dt)));
      else v.addScaledVector(this.tangent, ((v.dot(this.tangent) < 22 ? 7 : 0) + forward * 9) * dt);
      v.x += Math.cos(p.heading) * turn * 11 * dt;
      v.z -= Math.sin(p.heading) * turn * 11 * dt;
      this.ropeLength = Math.max(this.targetLength, this.ropeLength - 26 * dt);
    } else if (this.state === 'air') {
      v.y -= (suited ? 24 : 14.5) * dt;
      const drag = Math.exp(-(brake * 2.4 + 0.08) * dt);
      v.x = v.x * drag + (fx * forward + Math.cos(p.heading) * turn * 0.72) * 14 * dt;
      v.z = v.z * drag + (fz * forward - Math.sin(p.heading) * turn * 0.72) * 14 * dt;
    }
    v.clampLength(0, flash ? 85 : 55);
    pos.addScaledVector(v, dt);
    if (this.anchor) {
      this.pivot.copy(pos);
      this.pivot.y += 1;
      const distance = this.radial.subVectors(this.pivot, this.anchor).length();
      if (distance > this.ropeLength) {
        this.radial.multiplyScalar(1 / distance);
        pos.addScaledVector(this.radial, this.ropeLength - distance);
        const outward = v.dot(this.radial);
        if (outward > 0) v.addScaledVector(this.radial, -outward);
      }
    }
    // Land before the horizontal wall resolver, so a descent onto a real roof
    // rests on its top rather than pushing the body through the facade.
    const floor = this.floor(pos.x, pos.z, previousY);
    if (pos.y <= floor + 0.01 && v.y <= 0) {
      pos.y = floor;
      v.y = 0;
      if (this.anchor) this.release();
      if (this.state !== 'ground') this.groundSpeed = clamp(v.x * fx + v.z * fz, -runSpeed * 0.65, runSpeed);
      this.state = 'ground';
    }
    const x = pos.x,
      z = pos.z;
    this.manager.resolveHorizontalCollision(pos, 0.46);
    const dx = pos.x - x,
      dz = pos.z - z,
      size = Math.hypot(dx, dz);
    if (size > 1e-6) {
      const nx = dx / size,
        nz = dz / size,
        push = v.x * nx + v.z * nz;
      if (push < 0) {
        v.x -= push * nx;
        v.z -= push * nz;
      }
      if (this.anchor && size > 0.025) this.release();
    }
    if (this.anchor) {
      this.closedSight -= dt;
      this.eye.copy(pos);
      this.eye.y += 1.35;
      const rel = this.temp.subVectors(this.eye, this.anchor);
      const angle = Math.atan2(rel.x * this.forward.x + rel.z * this.forward.z, -rel.y);
      if (this.swingTime > 2.6 || (angle > 0.93 && v.y > 0) || rel.y > -2.5) this.release();
      else if (this.closedSight <= 0) {
        this.closedSight = 0.1;
        if (
          this.manager
            .nearColliders(pos.x, pos.z, this.ropeLength + 2)
            .some((c) => obstruction(c, this.eye, this.anchor))
        )
          this.release();
      }
    }
  }
  drawLine() {
    if (!this.anchor) {
      this.line.visible = false;
      return;
    }
    const p = this.person;
    if (p.avatar?.getHand) p.avatar.getHand(this.side, this.hand);
    else
      this.hand.set(
        p.position.x + 0.34 * Math.cos(p.heading),
        p.position.y + 1.6,
        p.position.z - 0.34 * Math.sin(p.heading)
      );
    const direction = this.temp.subVectors(this.anchor, this.hand),
      distance = direction.length();
    if (distance < 0.02) {
      this.line.visible = false;
      return;
    }
    const radius = clamp(0.019 + distance * 0.00065, 0.022, 0.061);
    this.line.position.lerpVectors(this.hand, this.anchor, 0.5);
    this.line.scale.set(radius, distance, radius);
    this.line.quaternion.setFromUnitVectors(UP, direction.multiplyScalar(1 / distance));
    this.line.visible = true;
    this.line.updateMatrixWorld(true);
  }
  clipCamera(eye, camera) {
    const length = eye.distanceTo(camera);
    if (length < 0.7) return;
    const nearby = this.manager.nearColliders(eye.x, eye.z, length + 0.5);
    if (!nearby.some((c) => obstruction(c, eye, camera))) return;
    let a = 0,
      b = 1;
    for (let i = 0; i < 7; i++) {
      const t = (a + b) / 2;
      this.temp.lerpVectors(eye, camera, t);
      if (nearby.some((c) => obstruction(c, eye, this.temp))) b = t;
      else a = t;
    }
    camera.lerpVectors(eye, camera, Math.max(0.02, a - 0.22 / length));
  }
}
