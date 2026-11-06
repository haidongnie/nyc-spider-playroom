import * as THREE from 'three/webgpu';
import { Fn, uniform, float, vec2, vec3, vec4, mix, smoothstep, normalize, positionWorld, cameraPosition, texture3D, time } from 'three/tsl';

// Japanese Seaside Street v10 builds its cloud volume from two seeded, repeating
// noise grids. The same volume can shade both the Manhattan sky and its reflections.
function periodicNoise(size, seed) {
  const values = new Float32Array(size ** 3);
  for (let i = 0; i < values.length; i++) {
    seed = (seed + 1831565813) | 0;
    let bits = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    bits = (bits + Math.imul(bits ^ (bits >>> 7), 61 | bits)) ^ bits;
    values[i] = ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  }
  const at = (x, y, z) => values[((z % size) * size + y % size) * size + x % size];
  const smooth = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    x *= size; y *= size; z *= size;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const tx = smooth(x - ix), ty = smooth(y - iy), tz = smooth(z - iz);
    const layer = k => lerp(lerp(at(ix, iy, k), at(ix + 1, iy, k), tx),
      lerp(at(ix, iy + 1, k), at(ix + 1, iy + 1, k), tx), ty);
    return lerp(layer(iz), layer(iz + 1), tz);
  };
}

function makeCloudTexture() {
  const size = 64, bytes = new Uint8Array(size ** 3);
  const coarse = periodicNoise(2, 83), fine = periodicNoise(4, 53);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = x / size, b = y / size, c = z / size;
    bytes[(z * size + y) * size + x] = Math.round(255 * (0.6 * coarse(a,b,c) + 0.4 * fine(a,b,c)));
  }
  const texture = new THREE.Data3DTexture(bytes, size, size, size);
  texture.format = THREE.RedFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

const palettes = {
  golden: [0x3f84da, 0x72a8e8, 0xc4dbef, 0xffffff],
  midday: [0x3f84da, 0x72a8e8, 0xc4dbef, 0xffffff],
  twilight: [0x344c83, 0x7d86af, 0xe4b7a9, 0xe2cbcc],
  midnight: [0x101c39, 0x202d4d, 0x344666, 0x536383]
};

export function createSeasideSky() {
  const texture = makeCloudTexture();
  const colors = palettes.golden.map(c => uniform(new THREE.Color(c)));
  const sun = uniform(new THREE.Vector3());
  const sunStrength = uniform(1);
  const noise = (x, y, z) => texture3D(texture, vec3(x, y, z)).r;
  const skyNode = Fn(() => {
    const ray = normalize(positionWorld.sub(cameraPosition)).toVar();
    const h = ray.y.max(0).toVar();
    const horizon = h.oneMinus();
    const gradient = mix(mix(colors[0], colors[1], horizon.pow(1.8)), colors[2], horizon.pow(7));
    const facing = ray.dot(sun).max(0);
    const sunGlow = facing.pow(10).mul(.25).add(facing.pow(90).mul(.5)).mul(smoothstep(-.05,.1,ray.y))
      .add(smoothstep(.99993,.99997,facing).mul(18)).mul(sunStrength);
    const clear = gradient.add(vec3(1,.95,.86).mul(sunGlow));
    const distance = float(7500).sub(cameraPosition.y).div(h.max(.01)).toVar();
    const wind = vec2(60,190);
    const plane = cameraPosition.xz.add(ray.xz.mul(distance)).sub(wind.mul(time)).toVar();
    const axis = wind.normalize();
    const along = plane.dot(axis).toVar(), across = plane.dot(vec2(axis.y.negate(), axis.x)).toVar();
    const warp = noise(along.div(20000),.61,across.div(16000)).sub(.55).mul(1500);
    const detail = noise(along.div(7000),.47,across.div(3800)).sub(.55);
    const x = along.add(detail.mul(2600)).toVar(), z = across.add(warp).add(detail.mul(700)).toVar();
    const phase = across.div(7000).add(along.div(52000));
    const stretch = distance.div(40000).add(1);
    const broad = noise(x.div(9000),phase.add(.13),z.div(stretch.mul(1100))).sub(.36).div(.36);
    const medium = noise(x.div(4300),time.mul(.001).add(.83).sub(phase.mul(.77)),z.div(stretch.mul(570))).sub(.36).div(.36);
    const wisps = noise(x.div(1900),time.mul(.0025).add(.37).add(phase.mul(1.3)),z.div(stretch.mul(330))).sub(.55).mul(distance.div(-25000).exp());
    const shape = broad.mul(.6).add(medium.mul(.4)).add(wisps.mul(.35));
    const cluster = smoothstep(.35,.65,noise(along.div(32000),phase.mul(.2).add(.29),across.div(5500)).sub(.36).div(.36));
    const threshold = float(.36).add(cluster.oneMinus().mul(.4)).add(.078)
      .add(noise(x.div(11000),phase.mul(.5).add(.71),z.div(2300)).sub(.55).mul(.35)).add(.12);
    const width = stretch.mul(.11).clamp(.11,.4);
    const cloud = smoothstep(threshold.sub(width),threshold.add(width),shape).toVar();
    const farHaze = float(1).sub(distance.div(-70000).exp());
    const cloudColor = mix(colors[3].mul(vec3(.82,.88,.97)), colors[3], smoothstep(.15,.85,cloud));
    const opacity = cloud.mul(.85).mul(smoothstep(.01,.16,ray.y)).mul(float(1).sub(farHaze.mul(.6)));
    return vec4(mix(clear,mix(cloudColor,colors[2],farHaze.mul(.8)),opacity),1);
  })();
  return {
    skyNode,
    setTime(id, direction) {
      const palette = palettes[id] || palettes.golden;
      colors.forEach((color, i) => color.value.setHex(palette[i]));
      sun.value.copy(direction).normalize();
      sunStrength.value = id === 'midnight' ? .04 : id === 'twilight' ? .58 : 1;
    }
  };
}
