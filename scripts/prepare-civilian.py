"""Create the multiplayer streaming assets from the unmodified source GLB (macOS sips)."""
import gzip
import json
from pathlib import Path
import struct
import subprocess
import tempfile

assets = Path(__file__).resolve().parent.parent / 'dist' / 'spider-assets'
raw = (assets/'civilian.glb').read_bytes()
json_length = struct.unpack_from('<I', raw, 12)[0]
document = json.loads(raw[20:20 + json_length])
binary = raw[28 + json_length:]
index = document['images'][0]['bufferView']
view = document['bufferViews'][index]
start, length = view.get('byteOffset', 0), view['byteLength']
original = binary[start:start + length]
full = assets/'civilian-full.jpg'
full.write_bytes(original)
with tempfile.TemporaryDirectory() as temp:
    preview = Path(temp)/'preview.jpg'
    subprocess.run(['sips', '-Z', '1024', '-s', 'formatOptions', '84',
                    str(full), '--out', str(preview)], check=True, stdout=subprocess.DEVNULL)
    small = preview.read_bytes()
def padded(data, fill):
    return data + fill * (-len(data) % 4)
old_end = (start + length + 3) & ~3
binary = binary[:start] + padded(small, b'\0') + binary[old_end:]
delta = len(padded(small, b'\0')) - (old_end-start)
for other in document['bufferViews']:
    if other.get('byteOffset', 0) >= old_end:
        other['byteOffset'] += delta
view['byteLength'] = len(small)
document['buffers'][0]['byteLength'] = len(binary)
header = padded(json.dumps(document, separators=(',', ':')).encode(), b' ')
blob = b'glTF' + struct.pack('<II', 2, 28+len(header)+len(binary)) + struct.pack('<I4s', len(header), b'JSON') + header + struct.pack('<I4s',len(binary),b'BIN\0') + binary
out = assets/'civilian-start.glb.gz'
out.write_bytes(gzip.compress(blob, compresslevel=9, mtime=0))
print('Startup GLB:',out.stat().st_size,'bytes. The original high-resolution JPEG:',len(original),'bytes.')
