import * as THREE from 'three/webgpu';
import { bryantParkLawn } from './landmarks.js';

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   category: 'follow', fov: 68 },
  { id: 'centralPark', name: 'Central Park Oasis',       category: 'scenic', fov: 52 },
  { id: 'fifthAve',    name: '5th Ave & Empire State',   category: 'scenic', fov: 48 },
  { id: 'timesSquare', name: 'Times Square Crossroads',  category: 'scenic', fov: 58 },
  { id: 'chryslerGCT', name: '42nd St · Chrysler & GCT', category: 'scenic', fov: 50 },
  { id: 'observatory', name: 'Empire State 86th Deck',   category: 'scenic', fov: 52 },
  { id: 'bryantPark',  name: 'Bryant Park & NYPL',       category: 'scenic', fov: 52 },
  { id: 'waterfront',  name: 'East River & Skyline',     category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Auto-Director Aerial',     category: 'scenic', fov: 50 }
];

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the boroughs & harbor run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.pointerLocked = false;
    this.mouseLookMode = '';
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._spiderEye = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    canvas.setAttribute?.('aria-label', 'Game viewport');
    let lockRequested = false;
    let mousePress = null;
    let soft = null;
    const insideSoftBounds = (x, y, bounds) => x > bounds.left + 2 && x < bounds.right - 2
      && y > bounds.top + 2 && y < bounds.bottom - 2 && x > 2 && y > 2
      && x < window.innerWidth - 2 && y < window.innerHeight - 2;

    this._updateMouseMode = () => {
      const mode = !this.acceptsMouseLook() ? 'fixed' : this.pointerLocked ? 'locked'
        : soft ? 'soft' : this.isDragging && mousePress?.moved ? 'drag' : 'click';
      if (mode === this.mouseLookMode) return;
      this.mouseLookMode = mode;
      canvas.style.cursor = mode === 'soft' ? 'none' : '';
      canvas.title = {click:'Click for mouse look, or drag to orbit · Esc to release',
        locked:'Esc to release the mouse', soft:'Esc to release · Move to the edge to show the cursor',
        drag:'Release the mouse button to end the drag', fixed:''}[mode];
      window.dispatchEvent?.(new CustomEvent('mouse-look-change', {detail: mode}));
    };
    this._updateMouseMode();

    this.releaseMouse = () => {
      lockRequested = false;
      mousePress = null;
      if (soft) this.controllerManager.resetInput?.();
      soft = null;
      this._clearPointers();
      this._updateMouseMode();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    };
    const denied = () => {
      if (!lockRequested || document.pointerLockElement === canvas) return;
      lockRequested = false;
      this._updateMouseMode();
    };
    document.addEventListener('pointerlockerror', denied);
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      if (locked && !lockRequested) { this.releaseMouse(); return; }
      if (locked) soft = null;
      if (!locked && this.pointerLocked) this.controllerManager.resetInput?.();
      lockRequested = locked;
      this.pointerLocked = locked;
      this._clearPointers();
      this._updateMouseMode();
    });
    document.addEventListener('mousemove', (event) => {
      if (!this.pointerLocked || !this.acceptsMouseLook()) return;
      const dx = Math.max(-180, Math.min(180, event.movementX || 0));
      const dy = Math.max(-180, Math.min(180, event.movementY || 0));
      this.turnMouse(dx * 0.0032, dy * 0.0028);
      this.userOrbitTimer = 4;
    });
    window.addEventListener('keydown', (event) => {
      if ((event.key === 'Escape' || event.key === 'Tab') && (lockRequested || this.pointerLocked || soft)) this.releaseMouse();
    }, true);
    document.addEventListener('focusin', (event) => {
      if (event.target !== canvas && (lockRequested || this.pointerLocked || soft)) this.releaseMouse();
    });
    document.addEventListener('beforetoggle', (event) => {
      if (event.newState === 'open' && (lockRequested || this.pointerLocked || soft)) this.releaseMouse();
    }, true);

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2 || this.pointerLocked) return;
      mousePress = null;
      if (e.pointerType === 'mouse') {
        canvas.focus?.({preventScroll: true});
        if (!this.acceptsMouseLook() || soft) return;
        mousePress = {x:e.clientX, y:e.clientY, moved:false};
      } else if (soft) {
        this.releaseMouse();
      }
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
      // A held drag stays usable while the browser negotiates native lock.
      if (e.pointerType === 'mouse' && this.acceptsMouseLook() && canvas.requestPointerLock && !lockRequested) {
        lockRequested = true;
        try { canvas.requestPointerLock()?.catch(denied); } catch { denied(); }
      }
    });

    // Sandboxed frames often forbid native lock. A click enables bounded look,
    // while a deliberate drag remains a one-gesture orbit. The OS cursor stays
    // free to cross onto a HUD control or out of the frame.
    canvas.addEventListener('click', (e) => {
      const press = mousePress;
      mousePress = null;
      if (!press || press.moved || !e.detail || !this.acceptsMouseLook() || this.pointerLocked
        || document.pointerLockElement === canvas || document.elementFromPoint(e.clientX, e.clientY) !== canvas) return;
      const bounds = canvas.getBoundingClientRect();
      if (!insideSoftBounds(e.clientX, e.clientY, bounds)) return;
      soft = {x:e.clientX, y:e.clientY, bounds};
      this._updateMouseMode();
    });
    canvas.addEventListener('pointerleave', (e) => {
      if (soft && e.pointerType === 'mouse') this.releaseMouse();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (soft && e.pointerType === 'mouse') {
        if (!insideSoftBounds(e.clientX, e.clientY, soft.bounds)) { this.releaseMouse(); return; }
        this.turnMouse((e.clientX - soft.x) * 0.0032, (e.clientY - soft.y) * 0.0028);
        soft.x = e.clientX;
        soft.y = e.clientY;
        this.userOrbitTimer = 4;
        return;
      }
      const pointer = pointers.get(e.pointerId);
      if (!pointer || this.pointerLocked) return;
      e.preventDefault();
      if (e.pointerType === 'mouse' && mousePress && !mousePress.moved
        && Math.hypot(e.clientX - mousePress.x, e.clientY - mousePress.y) > 4) {
        mousePress.moved = true;
        this._updateMouseMode();
      }
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.turnMouse(dx * 0.0065, dy * 0.005);
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      this._updateMouseMode();
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', this.releaseMouse);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseMouse();
    });
    window.addEventListener('resize', () => { if (soft) this.releaseMouse(); });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  turnMouse(yaw, pitch) {
    const cockpit = this.activePresetId === 'pov';
    this.orbitYawOffset -= yaw;
    this.orbitPitchOffset = Math.max(cockpit ? -1.28 : -0.32,
      Math.min(cockpit ? 1.46 : 0.68, this.orbitPitchOffset + pitch));
  }

  acceptsMouseLook() {
    return this.activePresetId === 'chase' || this.activePresetId === 'pov';
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    if (!this.acceptsMouseLook()) this.releaseMouse();
    if (preset.id !== 'pov') this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset));
    this._updateMouseMode();
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;
    const spinner = entity.type === 'skycar';
    const inSpinnerCockpit = spinner && this.activePresetId === 'pov';
    if (inSpinnerCockpit !== Boolean(this._inSpinnerCockpit)) {
      this._inSpinnerCockpit = inSpinnerCockpit;
      this.camera.near = inSpinnerCockpit ? 0.06 : 0.35;
      this.camera.up.set(0, 1, 0);
      this.camera.updateProjectionMatrix();
    }

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    // On foot the viewed direction steers W. Preserve it while running and
    // coasting, so automatic chase recentering cannot bend that path.
    const input = this.controllerManager.keys;
    const steerByView = entity.web?.state === 'ground' && (input?.forward || !input?.backward);
    if (!steerByView && !this.pointerLocked && this.mouseLookMode !== 'soft' && !this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    // On foot, S turns the actor toward the lens without dragging the
    // third-person camera around behind the actor again.
    const groundViewYaw = entity.web?.state === 'ground' ? entity.web.viewHeading : entity.heading;
    let travelYaw = groundViewYaw;
    const swinging = entity.web && entity.web.state !== 'ground';
    if (swinging && this.smoothedSpeed > 5) {
      const v = entity.web.velocity;
      const drift = Math.atan2(v.x,v.z) - travelYaw;
      travelYaw += THREE.MathUtils.clamp(Math.atan2(Math.sin(drift),Math.cos(drift)),-.65,.65) * .65;
    }
    const totalYaw = (this.activePresetId === 'pov' ? entity.heading : travelYaw) + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = (entity.chaseDistance + (swinging ? Math.min(3.0,this.smoothedSpeed*.09) : 0)) * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' || spinner ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        if (entity.web) {
          const ahead = swinging ? 2.1 + Math.min(2.1,this.smoothedSpeed*.07) : 1.3;
          desiredLook.set(entity.position.x + Math.sin(travelYaw)*ahead,
            entity.position.y + 1.10 + (swinging ? THREE.MathUtils.clamp(entity.verticalVel*.055,-.5,1.1) : 0),
            entity.position.z + Math.cos(travelYaw)*ahead);
        }
        break;
      }

      case 'action': {
        const sideOffset = spinner ? 3.45 : entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (spinner ? 4.7 : entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(groundViewYaw) * backDist + Math.cos(groundViewYaw) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(groundViewYaw) * backDist - Math.sin(groundViewYaw) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(groundViewYaw) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(groundViewYaw) * 3.2
        );
        break;
      }

      case 'pov': {
        if (spinner) {
          // The driver sits off-centre under the glass. Transform the eye, view direction and local up
          // through the same pitch, bank and heading as the cabin so the dashboard stays anchored.
          const tilt = entity.tiltPivot.quaternion, yaw = entity.mesh.quaternion;
          desiredPos.set(0.4, 1.3, 0.05).applyQuaternion(tilt);
          desiredPos.y += entity.tiltPivot.position.y;
          desiredPos.applyQuaternion(yaw).add(entity.position);
          const lookPitch = 0.09 - this.orbitPitchOffset;
          desiredLook.set(Math.sin(this.orbitYawOffset) * Math.cos(lookPitch), Math.sin(lookPitch),
            Math.cos(this.orbitYawOffset) * Math.cos(lookPitch)).applyQuaternion(tilt).applyQuaternion(yaw).add(desiredPos);
          this.camera.up.set(0, 1, 0).applyQuaternion(tilt).applyQuaternion(yaw);
          break;
        }
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        const lookPitch = 0.09 - this.orbitPitchOffset;
        desiredLook.set(Math.sin(totalYaw) * Math.cos(lookPitch), Math.sin(lookPitch),
          Math.cos(totalYaw) * Math.cos(lookPitch)).multiplyScalar(40).add(desiredPos);
        break;
      }

      case 'centralPark': {
        // Above the southern canopy, looking across The Pond toward the park and skyline.
        const sway = Math.sin(elapsed * 0.22) * 3.5;
        desiredPos.set(-70.0 + sway, 26.0, -1425.0);
        desiredLook.set(-250.0, 6.5, -1690.0);
        break;
      }

      case 'fifthAve': {
        // 5th Avenue & 42nd St looking South down the 5th Ave canyon toward the Empire State Building
        const sway = Math.sin(elapsed * 0.25) * 1.8;
        desiredPos.set(0.0 + sway, 6.5, -20.0);
        desiredLook.set(-60.0, 150.0, 686.0);
        break;
      }

      case 'timesSquare': {
        // Times Square & Broadway looking across Duffy Square red steps and One Times Square billboards
        const sway = Math.sin(elapsed * 0.3) * 3.0;
        desiredPos.set(-603.0 + sway, 5.5, -290.0);
        desiredLook.set(-566.0, 40.0, -40.0);
        break;
      }

      case 'chryslerGCT': {
        // Park Ave & 42nd St intersection looking straight at Grand Central, MetLife, and Chrysler Building Crown
        const sway = Math.cos(elapsed * 0.22) * 2.5;
        desiredPos.set(300.0 + sway, 9.5, 95.0);
        desiredLook.set(470.0, 120.0, -50.0);
        break;
      }

      case 'observatory': {
        // Empire State Building 86th Floor Deck looking North-East across Midtown skyline
        const pan = Math.sin(elapsed * 0.18) * 80.0;
        desiredPos.set(-58.0, 322.0, 660.0);
        desiredLook.set(420.0 + pan, 150.0, -200.0);
        break;
      }

      case 'bryantPark': {
        // Inside Bryant Park Great Lawn looking East toward NYPL portico, One Vanderbilt & Chrysler Building
        const sway = Math.sin(elapsed * 0.25) * 1.5;
        const lawn = bryantParkLawn || { minX: -260, maxX: -150, minZ: 40, maxZ: 120, top: 1.3 };
        const lz = (lawn.minZ + lawn.maxZ) * 0.5;
        desiredPos.set(lawn.minX + 18.0, lawn.top + 1.7, lz + sway);
        desiredLook.set(lawn.maxX + 260.0, 70.0, lz - 60.0);
        break;
      }

      case 'waterfront': {
        // Over the shimmering East River looking across the FDR Drive, Queensboro Bridge & Midtown Skyline
        const drift = Math.sin(elapsed * 0.15) * 40.0;
        desiredPos.set(1640.0, 60.0, 60.0 + drift);
        desiredLook.set(150.0, 150.0, -150.0);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(
          Math.cos(angle) * radius + 60.0,
          alt,
          Math.sin(angle) * radius + 250.0
        );
        desiredLook.set(60.0, 160.0, 250.0);
        break;
      }
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    if (entity.web && (this.activePresetId === 'chase' || this.activePresetId === 'action')) {
      this._spiderEye.copy(entity.position); this._spiderEye.y += 1.38;
      entity.web.clipCamera(this._spiderEye,this.currentPos);
    }
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

export { CAMERA_PRESETS, CameraSystem };
