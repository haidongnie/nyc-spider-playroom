export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildingStyle(building) {
  const seed=Math.round(building.cx*31+building.cz*17);
  const rand=mulberry32(seed), tone=rand();
  const mat=building.year && building.year<1945 ? (tone<.8 ? 0 : 1)
    : building.year && building.year<1980 ? (tone<.55 ? 0 : 3)
    : tone<.6 ? 2 : 4;
  return {seed,rand,tone,mat};
}
