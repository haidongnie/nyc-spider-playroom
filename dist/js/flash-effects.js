// Flash's paint is projected in the imported suit's bind pose. The light bolt,
// boot tops and belt move with the skinned costume instead of sliding over it.
import * as THREE from 'three/webgpu';
import { float, mix, normalGeometry, positionGeometry, smoothstep, texture, vec2 } from 'three/tsl';

let skinPaint;
const skinNodes = new Map();

function paintedSuit(front) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.translate(512, 1024);
  ctx.scale(512, -512);
  const red = ctx.createLinearGradient(0, 0, 0, 2);
  red.addColorStop(0, '#b72329');
  red.addColorStop(0.36, '#9e1c28');
  red.addColorStop(0.72, front ? '#da3032' : '#bf252d');
  red.addColorStop(1, '#dd3533');
  ctx.fillStyle = red;
  ctx.fillRect(-1, 0, 2, 2);

  function shape(points, fill, outline, width = 0.008) {
    ctx.beginPath();
    ctx.moveTo(...points[0]);
    for (const p of points.slice(1)) ctx.lineTo(...p);
    if (fill) {
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }
  const gold = '#ffbc36',
    cream = '#fff0ae',
    shade = '#7c1928';
  for (const side of [-1, 1]) {
    const points = (arr) => arr.map(([x, y]) => [side * x, y]);
    // Racing seams slope from the shoulders toward the waist.
    shape(
      points([
        [0.225, 1.67],
        [0.144, 1.61],
        [0.123, 1.54],
        [0.19, 1.5],
        [0.123, 1.42],
        [0.102, 1.29],
        [0.068, 1.18],
        [0.116, 1.2],
        [0.164, 1.36],
        [0.2, 1.48],
        [0.244, 1.54]
      ]),
      shade
    );
    shape(
      points([
        [0.23, 1.64],
        [0.128, 1.54],
        [0.16, 1.54],
        [0.104, 1.44]
      ]),
      null,
      '#e87b32',
      0.012
    );
    shape(
      points([
        [0.114, 1.03],
        [0.174, 0.93],
        [0.13, 0.79],
        [0.17, 0.64],
        [0.12, 0.73],
        [0.095, 0.86]
      ]),
      '#8e1b29'
    );
    // Angular tops of the red boots; two gold edges meet over each shin.
    shape(
      points([
        [0, 0.42],
        [0.065, 0.4],
        [0.168, 0.34],
        [0.238, 0.415],
        [0.31, 0.427],
        [0.31, 0.365],
        [0.237, 0.36],
        [0.168, 0.285],
        [0.057, 0.35],
        [0, 0.367]
      ]),
      gold
    );
    shape(
      points([
        [0, 0.42],
        [0.065, 0.4],
        [0.168, 0.34],
        [0.238, 0.415],
        [0.31, 0.427]
      ]),
      null,
      cream,
      0.008
    );
    // Gauntlets wrap around the forearms in the source model's T pose.
    shape(
      points([
        [0.48, 1.67],
        [0.51, 1.59],
        [0.47, 1.59],
        [0.55, 1.41],
        [0.57, 1.39],
        [0.524, 1.55],
        [0.57, 1.55],
        [0.531, 1.65]
      ]),
      gold
    );
    shape(
      points([
        [0.607, 1.64],
        [0.644, 1.51],
        [0.614, 1.51],
        [0.67, 1.41]
      ]),
      null,
      '#ffcd56',
      0.013
    );
  }
  shape(
    [
      [-0.3, 1.18],
      [-0.11, 1.19],
      [-0.052, 1.17],
      [0, 1.21],
      [0.052, 1.17],
      [0.11, 1.19],
      [0.3, 1.18],
      [0.3, 1.13],
      [0.109, 1.155],
      [0.052, 1.125],
      [0, 1.16],
      [-0.052, 1.125],
      [-0.109, 1.155],
      [-0.3, 1.13]
    ],
    gold
  );
  if (front) {
    // Exposed lower face framed by the cowl, and a separate light eye lens.
    shape(
      [
        [-0.08, 1.75],
        [-0.045, 1.758],
        [0, 1.744],
        [0.045, 1.758],
        [0.08, 1.75],
        [0.067, 1.688],
        [0.035, 1.662],
        [0, 1.655],
        [-0.035, 1.662],
        [-0.067, 1.688]
      ],
      '#bc7959',
      '#8a302f',
      0.004
    );
    shape(
      [
        [-0.032, 1.694],
        [0, 1.691],
        [0.03, 1.695]
      ],
      null,
      '#784738',
      0.004
    );
    ctx.beginPath();
    ctx.arc(0, 1.473, 0.107, 0, Math.PI * 2);
    ctx.fillStyle = '#ffc347';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 1.473, 0.094, 0, Math.PI * 2);
    ctx.fillStyle = '#fff5d8';
    ctx.fill();
  }
  // The back carries a smaller lightning flash, visible in the chase camera.
  const z = front ? 1.473 : 1.49,
    size = front ? 1 : 0.87;
  shape(
    [
      [0.069, 0.124],
      [-0.037, 0.024],
      [-0.006, 0.023],
      [-0.067, -0.123],
      [0.044, -0.002],
      [0.009, -0.002]
    ].map(([x, y]) => [size * x, z + size * y]),
    front ? '#f9b323' : '#f2a72a',
    front ? '#a75b16' : '#933424',
    0.005
  );
  if (!front)
    shape(
      [
        [-0.109, 1.57],
        [-0.055, 1.594],
        [0, 1.568],
        [0.055, 1.594],
        [0.109, 1.57]
      ],
      null,
      '#ffb536',
      0.01
    );
  const paint = new THREE.CanvasTexture(canvas);
  paint.colorSpace = THREE.SRGBColorSpace;
  paint.anisotropy = 4;
  return paint;
}

function flashSurface(eyes) {
  if (skinNodes.has(eyes)) return skinNodes.get(eyes);
  if (!skinPaint) skinPaint = [paintedSuit(false), paintedSuit(true)];
  const uv = vec2(positionGeometry.x.mul(0.5).add(0.5), positionGeometry.z.mul(-0.5));
  let node;
  if (eyes) {
    // Smaller ivory eye slits inside the original dimensional eye pieces.
    const h = positionGeometry.z.negate(),
      x = positionGeometry.x.abs();
    const line = h.sub(x.mul(0.17)).sub(1.786).abs();
    const lens = float(1)
      .sub(smoothstep(0.009, 0.03, line))
      .mul(smoothstep(0.01, 0.029, x));
    node = mix(THREE_COLOR.red, THREE_COLOR.ivory, lens);
  } else {
    const facing = smoothstep(-0.18, 0.28, normalGeometry.y);
    node = mix(texture(skinPaint[0], uv).rgb, texture(skinPaint[1], uv).rgb, facing);
  }
  skinNodes.set(eyes, node);
  return node;
}
// TSL promotes the colors to constant color nodes.
const THREE_COLOR = { red: new THREE.Color(0x971f2a), ivory: new THREE.Color(0xffe7b6) };

let wingGeometry, earDisc;
function templeDisc() {
  if (!earDisc) {
    earDisc = new THREE.CylinderGeometry(0.032, 0.03, 0.03, 14);
    earDisc.rotateZ(Math.PI / 2);
  }
  return earDisc;
}
function templeWing() {
  if (wingGeometry) return wingGeometry;
  // A small swept lightning blade on either temple. Shape coordinates are
  // forward and vertical; extrude in the thickness direction.
  const shape = new THREE.Shape();
  shape.moveTo(0.02, -0.018);
  shape.lineTo(-0.04, 0.044);
  shape.lineTo(-0.025, 0.04);
  shape.lineTo(-0.135, 0.124);
  shape.lineTo(-0.06, 0.023);
  shape.lineTo(-0.08, 0.031);
  shape.lineTo(-0.022, -0.024);
  shape.closePath();
  wingGeometry = new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: false });
  wingGeometry.rotateY(-Math.PI / 2);
  return wingGeometry;
}

export function flashCostume(spider, reveal) {
  const body = [];
  spider.root.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || mesh.name.endsWith(' ink')) return;
    // Keep the actor's own reveal and shadow masks on these same materials.
    const mat = mesh.material;
    body.push({ mat, original: mat.colorNode, map: mat.map, eyes: mesh.name.endsWith('_1') });
  });
  const head = spider.joints.get('Head').bone;
  const wings = new THREE.Group();
  wings.name = 'Flash cowl lightning';
  const shape = templeWing();
  const gold = new THREE.MeshStandardMaterial({ color: 0xffc137, roughness: 0.38, metalness: 0.45 });
  for (const sign of [-1, 1]) {
    const mesh = new THREE.Mesh(shape, gold);
    mesh.position.set(sign * 0.078, 0.079, 0.007);
    mesh.rotation.z = -sign * 0.44;
    mesh.castShadow = false;
    wings.add(mesh);
    const disc = new THREE.Mesh(templeDisc(), gold);
    disc.position.set(sign * 0.077, 0.078, 0.009);
    wings.add(disc);
  }
  spider.root.add(wings);
  spider.root.worldToLocal(head.getWorldPosition(wings.position));
  spider.root.updateWorldMatrix(true, true);
  head.attach(wings);
  reveal.addSuitPart(wings);
  gold.dispose(); // the reveal owns the two per-actor replacement materials
  wings.visible = false;
  return (enabled) => {
    wings.visible = enabled;
    for (const part of body) {
      part.mat.map = enabled ? null : part.map;
      part.mat.colorNode = enabled ? flashSurface(part.eyes) : part.original;
      part.mat.needsUpdate = true;
    }
  };
}

const ghostGeometry = new WeakMap();
function afterimageGeometry(source) {
  if (ghostGeometry.has(source)) return ghostGeometry.get(source);
  // Weld the original figure into a small silhouette mesh once. Preserve joint
  // indices/weights so a ghost keeps the actual running pose at that instant.
  const p = source.attributes.position,
    index = source.attributes.skinIndex,
    weights = source.attributes.skinWeight;
  const positions = [],
    joints = [],
    values = [],
    indices = [],
    unique = new Map(),
    remap = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const key = [Math.round(x * 32), Math.round(y * 32), Math.round(z * 32), index.getX(i)].join('/');
    let n = unique.get(key);
    if (n === undefined) {
      n = positions.length / 3;
      unique.set(key, n);
      positions.push(x, y, z);
      joints.push(index.getX(i), index.getY(i), index.getZ(i), index.getW(i));
      values.push(weights.getX(i), weights.getY(i), weights.getZ(i), weights.getW(i));
    }
    remap[i] = n;
  }
  const count = source.index?.count ?? p.count;
  for (let i = 0; i < count; i += 3) {
    const a = remap[source.index?.getX(i) ?? i],
      b = remap[source.index?.getX(i + 1) ?? i + 1],
      c = remap[source.index?.getX(i + 2) ?? i + 2];
    if (a !== b && b !== c && c !== a) indices.push(a, b, c);
  }
  const result = new THREE.BufferGeometry();
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  result.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
  result.setAttribute('skinWeight', new THREE.Float32BufferAttribute(values, 4));
  result.setIndex(indices);
  result.computeBoundingSphere();
  ghostGeometry.set(source, result);
  return result;
}

function frozenPose(source) {
  const bones = source.skeleton.bones.map(() => new THREE.Bone());
  const skeleton = new THREE.Skeleton(bones, source.skeleton.boneInverses);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff982b,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    toneMapped: false
  });
  const mesh = new THREE.SkinnedMesh(afterimageGeometry(source.geometry), mat);
  mesh.name = 'Flash running afterimage';
  mesh.bind(skeleton, source.bindMatrix);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 1;
  return { mesh, bones, origin: new THREE.Vector3(), age: 1 };
}

const HISTORY = 24,
  GHOSTS = 4,
  LIFE = 0.31,
  SEGMENTS = 920;
const HOT = [2.8, 2.3, 0.93],
  EDGE = [1.7, 0.21, 0.018];
function noise(i, t) {
  const n = Math.sin(i * 127.13 + t * 43.79) * 43758.54;
  return n - Math.floor(n) - 0.5;
}

// One ribbon batch and up to four low-detail pose snapshots per runner. No
// shadow casters, point lights, or full-resolution cloned character rigs.
export function createFlashTrail(scene) {
  const group = new THREE.Group();
  group.name = 'Flash speed trail';
  group.visible = false;
  scene.add(group);
  const samples = Array.from({ length: HISTORY }, () => ({ p: new THREE.Vector3(), time: 0, yaw: 0 }));
  let count = 0,
    head = -1,
    now = 0,
    lastStamp = -1,
    lastGhost = -1,
    ghostIndex = 0,
    source = null,
    sourceRoot = null,
    ghosts = [];
  const previous = new THREE.Vector3(),
    delta = new THREE.Vector3(),
    a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    mid = new THREE.Vector3(),
    kink = new THREE.Vector3();
  let seeded = false,
    ribbons = null,
    positionAttr = null,
    colorAttr = null,
    vertex = 0;
  function ensureRibbons() {
    if (ribbons) return;
    const geometry = new THREE.BufferGeometry();
    positionAttr = new THREE.BufferAttribute(new Float32Array(SEGMENTS * 6 * 3), 3).setUsage(
      THREE.DynamicDrawUsage
    );
    colorAttr = new THREE.BufferAttribute(new Float32Array(SEGMENTS * 6 * 4), 4).setUsage(
      THREE.DynamicDrawUsage
    );
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('color', colorAttr);
    geometry.setDrawRange(0, 0);
    ribbons = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        forceSinglePass: true
      })
    );
    ribbons.name = 'Flash lightning';
    ribbons.frustumCulled = false;
    ribbons.renderOrder = 2;
    group.add(ribbons);
  }
  function append(position, yaw) {
    head = (head + 1) % HISTORY;
    const item = samples[head];
    item.p.copy(position);
    item.yaw = yaw;
    item.time = now;
    count = Math.min(HISTORY, count + 1);
    lastStamp = now;
  }
  function put(x, y, z, col, opacity) {
    positionAttr.setXYZ(vertex, x, y, z);
    colorAttr.setXYZW(vertex, col[0], col[1], col[2], opacity);
    vertex++;
  }
  function strip(start, end, w, sideX, sideY, sideZ, col, opacity) {
    if (vertex + 6 > positionAttr.count) return;
    const x = w * sideX,
      y = w * sideY,
      z = w * sideZ;
    put(start.x + x, start.y + y, start.z + z, col, opacity);
    put(start.x - x, start.y - y, start.z - z, col, opacity);
    put(end.x + x, end.y + y, end.z + z, col, opacity);
    put(end.x + x, end.y + y, end.z + z, col, opacity);
    put(start.x - x, start.y - y, start.z - z, col, opacity);
    put(end.x - x, end.y - y, end.z - z, col, opacity);
  }
  function beam(start, end, width, yaw, opacity) {
    const sx = Math.cos(yaw),
      sz = -Math.sin(yaw);
    strip(start, end, width, sx, 0, sz, EDGE, opacity * 0.73);
    strip(start, end, width, 0, 1, 0, EDGE, opacity * 0.73);
    strip(start, end, width * 0.33, sx, 0, sz, HOT, opacity);
    strip(start, end, width * 0.33, 0, 1, 0, HOT, opacity);
  }
  function recordGhost(position, avatarRoot) {
    if (!avatarRoot) return;
    if (sourceRoot !== avatarRoot) {
      sourceRoot = avatarRoot;
      source = avatarRoot.getObjectByName('Mesh_0103rip002');
      if (!source?.isSkinnedMesh) source = null;
    }
    if (!source || !sourceRoot.getObjectByName('Spider-Man')?.visible) return;
    sourceRoot.updateWorldMatrix(true, true);
    let ghost = ghosts[ghostIndex];
    if (!ghost) {
      ghost = ghosts[ghostIndex] = frozenPose(source);
      group.add(ghost.mesh);
    }
    ghostIndex = (ghostIndex + 1) % GHOSTS;
    ghost.mesh.matrix.copy(source.matrixWorld);
    for (let i = 0; i < ghost.bones.length; i++)
      ghost.bones[i].matrixWorld.copy(source.skeleton.bones[i].matrixWorld);
    ghost.mesh.updateMatrixWorld(true);
    ghost.mesh.skeleton.update();
    ghost.mesh.visible = true;
    ghost.age = 0;
    ghost.origin.copy(position);
    lastGhost = now;
  }
  function reset() {
    count = 0;
    head = -1;
    for (const g of ghosts) {
      g.age = 1;
      g.mesh.visible = false;
    }
    ribbons?.geometry.setDrawRange(0, 0);
    group.visible = false;
  }
  function update(dt, position, heading, active, avatarRoot = null) {
    if (!position || !(dt >= 0)) return;
    now += dt;
    if (!seeded) {
      previous.copy(position);
      seeded = true;
    }
    const traveled = delta.subVectors(position, previous).length();
    previous.copy(position);
    if (traveled > Math.max(15, dt * 180)) {
      reset();
      return;
    }
    const moving = active && traveled > 0.003 && dt > 0 && traveled / dt > 1.4;
    if (moving) {
      ensureRibbons();
      if (!count || now - lastStamp >= 0.018) append(position, heading);
      if (now - lastGhost >= 0.066) recordGhost(position, avatarRoot);
    }
    while (count && now - samples[(head - count + 1 + HISTORY) % HISTORY].time > LIFE) count--;
    let anyGhost = false;
    for (const g of ghosts) {
      g.age += dt;
      const separation = THREE.MathUtils.smoothstep(g.origin.distanceTo(position), 0.44, 1.0);
      g.mesh.visible = g.age < LIFE && separation > 0.01;
      if (!g.mesh.visible) continue;
      const fade = 1 - g.age / LIFE;
      g.mesh.material.opacity = 0.56 * fade * fade * separation;
      g.mesh.material.color.setRGB(1, 0.13 + 0.34 * fade, 0.026);
      anyGhost = true;
    }
    group.visible = count >= 2 || anyGhost;
    if (!group.visible || !ribbons) return;
    vertex = 0;
    const pulse = Math.floor(now * 23);
    for (let stream = 0; stream < 4; stream++) {
      let have = false;
      for (let i = 0; i < count; i++) {
        const item = samples[(head - i + HISTORY) % HISTORY],
          openness = Math.max(0, 1 - (now - item.time) / LIFE);
        const jitter = noise(i * 3 + stream * 37, pulse);
        const side = (stream % 2 ? 1 : -1) * (0.19 + (stream > 1 ? 0.07 : 0.015)) + jitter * 0.24;
        b.copy(item.p);
        b.x += Math.cos(item.yaw) * side;
        b.z -= Math.sin(item.yaw) * side;
        b.y +=
          (stream < 2 ? 1.11 : 0.43) + Math.sin(stream * 2 + i * 0.94 + pulse * 0.34) * 0.12 + jitter * 0.19;
        if (have) {
          const width = (stream < 2 ? 0.063 : 0.044) * (0.4 + 0.6 * openness);
          // A bolt changes direction sharply between real trail samples, even
          // when the runner covers several metres in one displayed frame.
          kink.lerpVectors(a, b, 0.43);
          const shake = noise(stream * 59 + i * 13, pulse + 0.7);
          kink.x += Math.cos(item.yaw) * shake * 0.37;
          kink.z -= Math.sin(item.yaw) * shake * 0.37;
          kink.y += shake * (stream < 2 ? 0.7 : 0.42);
          beam(a, kink, width, item.yaw, openness);
          beam(kink, b, width * 0.86, item.yaw, openness);
          if (stream < 2 && (i + stream + pulse) % 4 === 0) {
            mid.copy(b);
            mid.y += 0.21 + jitter * 0.22;
            mid.x += Math.cos(item.yaw) * jitter * 0.45;
            mid.z -= Math.sin(item.yaw) * jitter * 0.45;
            beam(b, mid, 0.024, item.yaw, openness * 0.83);
          }
        }
        a.copy(b);
        have = true;
      }
    }
    if (moving && count > 1) {
      // Short discharges wrap from the leading shoulder around each arm and
      // shin. These remain readable in the rear chase camera.
      for (const side of [-1, 1]) {
        for (let j = 0; j < 6; j++) {
          const t = j / 5,
            lateral = side * (0.18 + Math.sin(t * Math.PI) * 0.16 + noise(j + side * 7, pulse) * 0.16);
          const along = 0.1 - t * 0.48;
          b.set(
            position.x + Math.cos(heading) * lateral + Math.sin(heading) * along,
            position.y + 1.56 - t * 1.3 + noise(j + side * 21, pulse) * 0.16,
            position.z - Math.sin(heading) * lateral + Math.cos(heading) * along
          );
          if (j) beam(a, b, 0.041, heading, 0.96);
          a.copy(b);
        }
      }
    }
    ribbons.geometry.setDrawRange(0, vertex);
    positionAttr.clearUpdateRanges();
    colorAttr.clearUpdateRanges();
    if (vertex) {
      positionAttr.addUpdateRange(0, vertex * 3);
      colorAttr.addUpdateRange(0, vertex * 4);
      positionAttr.needsUpdate = colorAttr.needsUpdate = true;
    }
    group.updateMatrixWorld(true);
  }
  function dispose() {
    group.removeFromParent();
    ribbons?.geometry.dispose();
    ribbons?.material.dispose();
    for (const ghost of ghosts) {
      ghost.mesh.skeleton.dispose();
      ghost.mesh.material.dispose();
    }
    ghosts = [];
  }
  return { update, dispose };
}
