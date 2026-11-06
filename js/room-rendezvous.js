import * as THREE from 'three/webgpu';

const space = {person: 0.8, cyclist: 1.2, car: 2.6, skycar: 3.5, helicopter: 6.3};
const aircraft = mode => mode === 'skycar' || mode === 'helicopter';
const solidGroundMode = mode => mode === 'car' || mode === 'cyclist';

// A room rendezvous is a one-time move to a received peer pose. Ordinary remote
// snapshots never drag either player or their camera as their teammate moves.
export function createRoomRendezvous({controllerManager: manager, selectMode, onArrival}) {
  const eye = new THREE.Vector3();
  const destinationEye = new THREE.Vector3();
  const clipped = new THREE.Vector3();
  const personWeb = manager.entities.person.web;

  function openView(from, to) {
    clipped.copy(to);
    personWeb.clipCamera(from, clipped);
    return clipped.distanceToSquared(to) < 0.04;
  }

  function arrivalMode(target) {
    const active = manager.activeMode;
    if (target.y < 3) return active === 'skycar' ? 'person' : active;
    const onRoof = !aircraft(target.mode) && Math.abs(personWeb.floor(target.x, target.z, target.y) - target.y) < 1;
    if (onRoof) return solidGroundMode(active) ? 'person' : active;
    if (active === 'helicopter' && target.y <= 380) return active;
    return 'skycar';
  }

  function heightAt(mode, target, x, z) {
    if (mode === 'skycar') return Math.max(10, Math.min(650, target.y));
    if (mode === 'helicopter') return Math.max(0.25, Math.min(380, target.y));
    const floor = personWeb.floor(x, z, target.y + 0.35);
    if (target.y > 3 && (mode !== 'person' || Math.abs(floor - target.y) > 1.25)) return null;
    // Someone arriving on foot should never be dropped into empty air beside a rooftop.
    return floor;
  }

  function meet(target, companions, selfId) {
    if (!target || !Object.hasOwn(space, target.mode) ||
        ![target.x, target.y, target.z, target.heading].every(Number.isFinite)) return false;
    const mode = arrivalMode(target);
    const forward = Number.isFinite(target.viewYaw) ? target.viewYaw : target.heading;
    // Vary the side for simultaneous guests. Keep both people off the center
    // line so the local avatar does not cover the other person in chase view.
    let hash = 0;
    for (const ch of selfId) hash = Math.imul(hash, 31) + ch.charCodeAt(0);
    const side = hash & 1 ? 1 : -1;
    const minimum = Math.max(5.1, space[mode] + space[target.mode] + 2.3);
    const bearings = [0.34, -0.34, 0.65, -0.65, 0, 1.1, -1.1, 1.7, -1.7, Math.PI];
    eye.set(target.x, target.y + 1.35, target.z);
    for (const extra of [0, 3, 7]) {
      for (const offset of bearings) {
        const direction = forward + side * offset;
        const x = target.x + Math.sin(direction) * (minimum + extra);
        const z = target.z + Math.cos(direction) * (minimum + extra);
        const altitude = heightAt(mode, target, x, z);
        if (altitude === null || Math.abs(altitude - target.y) > 5) continue;
        if (companions.some(p => Math.abs(p.y - altitude) < 3 &&
            Math.hypot(p.x - x, p.z - z) < space[mode] + (space[p.mode] || 1) + 0.5)) continue;
        // Aim slightly to one side of the teammate to separate both silhouettes.
        const heading = Math.atan2(target.x - x, target.z - z) + side * 0.27;
        const clear = manager.findTeleportPosition(x, z, heading, altitude, {mode, exactOnly: true});
        if (!clear || Math.hypot(clear.x - x, clear.z - z) > 0.15) continue;
        destinationEye.set(x, altitude + 1.35, z);
        if (!openView(eye, destinationEye)) continue;
        if (mode !== manager.activeMode) selectMode(mode, {dismount: false});
        manager.teleportActiveTo(x, z, heading, altitude);
        onArrival();
        return true;
      }
    }
    return false;
  }
  return {meet};
}
