"""Print the node tree + triangle count of a GLB. `python3 tools/inspect_glb.py <file>`"""
import json
import struct
import sys


def load(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, ver, total = struct.unpack("<III", data[:12])
    assert magic == 0x46546C67, "not a GLB"
    off, js = 12, None
    while off < total:
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        if ctype == 0x4E4F534A:
            js = json.loads(data[off + 8: off + 8 + clen])
            break
        off += 8 + clen
    return js, len(data)


def tris(g):
    n = 0
    for mesh in g.get("meshes", []):
        for prim in mesh["primitives"]:
            if "indices" in prim:
                n += g["accessors"][prim["indices"]]["count"] // 3
            else:
                a = prim["attributes"]["POSITION"]
                n += g["accessors"][a]["count"] // 3
    return n


def walk(g, i, depth, out):
    node = g["nodes"][i]
    tag = "  mesh" if "mesh" in node else ""
    out.append(f"{'  ' * depth}{node.get('name', '?')}{tag}")
    for c in node.get("children", []):
        walk(g, c, depth + 1, out)


for path in sys.argv[1:]:
    g, size = load(path)
    out = []
    for root in g["scenes"][g.get("scene", 0)]["nodes"]:
        walk(g, root, 0, out)
    print(f"=== {path}  ({size/1024:.0f} KB, {tris(g)} tris, "
          f"{len(g.get('materials', []))} materials)")
    print("\n".join(out))
    print()
