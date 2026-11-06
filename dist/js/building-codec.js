// NYB1 stores half-metre survey coordinates in separate zigzag-delta streams.
export function decodeBuildingRecords(data) {
  const invalidData = () => new Error('Invalid building data.');
  if (data.length < 12) throw invalidData();
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const xStart = 12 + header.getUint32(4, true), zStart = xStart + header.getUint32(8, true);
  if (header.getUint32(0, true) !== 0x3142594e || zStart > data.length) throw invalidData();

  // NYB1 stores separate metadata, X and Z streams; signed coordinate deltas use zigzag varints.
  function stream(start, end) {
    let cursor = start;
    return {
      uint() {
        let value = 0, shift = 0, byte;
        do {
          if (cursor >= end || shift >= 28) throw invalidData();
          byte = data[cursor++];
          value |= (byte & 127) << shift;
          shift += 7;
        } while (byte & 128);
        return value;
      },
      done: () => cursor === end
    };
  }
  const metadata = stream(12, xStart), xs = stream(xStart, zStart), zs = stream(zStart, data.length);
  const uint = () => metadata.uint();
  const delta = stream => { const value = stream.uint(); return (value >>> 1) ^ -(value & 1); };
  const count = uint();
  if (count > (xStart - 12) / 5) throw invalidData();
  let x = 0, z = 0;

  const records = Array.from({ length: count }, () => {
    const height = uint(), decade = uint(), polygons = [];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let n = uint(); n > 0; n--) {
      const rings = [];
      for (let n = uint(); n > 0; n--) {
        const ring = [];
        for (let n = uint(); n > 0; n--) {
          x += delta(xs); z += delta(zs);
          const point = { x: x * 0.5, z: z * 0.5 };
          minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
          minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
          ring.push(point);
        }
        rings.push(ring);
      }
      polygons.push({ outer: rings[0], holes: rings.slice(1) });
    }
    return { height, year: decade ? (decade + 159) * 10 : 0, polygons,
      minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
  });
  if (!metadata.done() || !xs.done() || !zs.done()) throw invalidData();
  return records;
}

export function decodeDistrictRecords(bytes) {
  if(bytes.length<8)throw Error('Invalid building district header.');
  const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(header.getUint32(0,true)!==0x3144594e)throw Error('Unknown building district format.');
  const count=header.getUint32(4,true), offset=8+count*2;
  if(offset>bytes.length)throw Error('Incomplete building district.');
  const records=decodeBuildingRecords(bytes.subarray(offset));
  if(records.length!==count)throw Error('Invalid facade seed count.');
  for(let i=0;i<count;i++)records[i].seed=header.getUint16(8+i*2,true);
  return records;
}
