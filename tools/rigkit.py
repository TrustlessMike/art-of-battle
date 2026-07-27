"""Shared primitive/mesh helpers for the art-of-battle Blender asset scripts.

Authoring convention (Blender space, Z-up):
    +Z  = up
    -Y  = the direction the character faces (front of the body)
    +X  = the character's LEFT
The glTF exporter converts to Y-up, which lands the character facing +Z with
+X on their left — exactly what ASSET_CONTRACT.md specifies.
"""

import math
import bpy
import bmesh
from mathutils import Matrix, Vector, Euler

TAU = math.tau


# ---------------------------------------------------------------- scene setup

def reset_scene():
    """Empty the file so the export contains only what we build."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.objects):
        for item in list(block):
            block.remove(item)


def material(name, color, metallic=0.0, roughness=0.6, emission=None):
    """Principled BSDF with only the factors glTF can carry."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission[0], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission[1]
    return mat


# ------------------------------------------------------------------ primitives
# Every primitive returns (verts, faces) in the local space of the part it will
# belong to. Winding is not policed — normals get recalculated at bake time.

def _xf(verts, matrix):
    if matrix is None:
        return verts
    return [tuple(matrix @ Vector(v)) for v in verts]


def frustum(z0, z1, size0, size1, center=(0.0, 0.0), matrix=None):
    """Tapered box from z0 to z1. size* = (x, y) full widths."""
    cx, cy = center
    (sx0, sy0), (sx1, sy1) = size0, size1
    hx0, hy0, hx1, hy1 = sx0 / 2, sy0 / 2, sx1 / 2, sy1 / 2
    v = [
        (cx - hx0, cy - hy0, z0), (cx + hx0, cy - hy0, z0),
        (cx + hx0, cy + hy0, z0), (cx - hx0, cy + hy0, z0),
        (cx - hx1, cy - hy1, z1), (cx + hx1, cy - hy1, z1),
        (cx + hx1, cy + hy1, z1), (cx - hx1, cy + hy1, z1),
    ]
    f = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return _xf(v, matrix), f


def box(center, size, matrix=None):
    cx, cy, cz = center
    sx, sy, sz = size
    return frustum(cz - sz / 2, cz + sz / 2, (sx, sy), (sx, sy),
                   center=(cx, cy), matrix=matrix)


def cylinder(z0, z1, r0, r1, segments=12, center=(0.0, 0.0),
             matrix=None, caps=True, arc=TAU, arc_start=0.0, squash=1.0):
    """Tapered cylinder along local Z. `squash` scales Y to make ovals."""
    cx, cy = center
    verts, faces = [], []
    closed = abs(arc - TAU) < 1e-6
    n = segments if closed else segments + 1
    for ring, (z, r) in enumerate(((z0, r0), (z1, r1))):
        for i in range(n):
            a = arc_start + arc * (i / segments)
            verts.append((cx + math.cos(a) * r,
                          cy + math.sin(a) * r * squash, z))
    for i in range(segments):
        j = (i + 1) % n if closed else i + 1
        faces.append((i, j, n + j, n + i))
    if caps:
        faces.append(tuple(range(n)))
        faces.append(tuple(range(n, 2 * n)))
    return _xf(verts, matrix), faces


def dome(center, radii, rings=5, segments=12, matrix=None, hemi=True):
    """Half (or full) ellipsoid, flat side down, apex toward +Z."""
    cx, cy, cz = center
    rx, ry, rz = radii
    verts, faces = [], []
    lat0 = 0.0 if hemi else -math.pi / 2
    for r in range(rings + 1):
        t = lat0 + (math.pi / 2 - lat0) * (r / rings)
        cz_r, sr = math.sin(t), math.cos(t)
        if r == rings:
            verts.append((cx, cy, cz + rz))
            break
        for i in range(segments):
            a = TAU * i / segments
            verts.append((cx + math.cos(a) * sr * rx,
                          cy + math.sin(a) * sr * ry,
                          cz + cz_r * rz))
    top = len(verts) - 1
    for r in range(rings - 1):
        for i in range(segments):
            j = (i + 1) % segments
            a0, b0 = r * segments, (r + 1) * segments
            faces.append((a0 + i, a0 + j, b0 + j, b0 + i))
    a0 = (rings - 1) * segments
    for i in range(segments):
        faces.append((a0 + i, a0 + (i + 1) % segments, top))
    if hemi:
        faces.append(tuple(range(segments)))
    return _xf(verts, matrix), faces


def plate(points, thickness, matrix=None):
    """Extrude a flat XZ-plane polygon along Y into a solid armour plate."""
    h = thickness / 2
    n = len(points)
    verts = [(x, -h, z) for x, z in points] + [(x, h, z) for x, z in points]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return _xf(verts, matrix), faces


def ring(segments, radius, squash=1.0, center=(0.0, 0.0), phase=0.0):
    """Closed plan-view polygon. `radius` may be a float or f(angle)."""
    cx, cy = center
    pts = []
    for i in range(segments):
        a = phase + TAU * i / segments
        r = radius(a) if callable(radius) else radius
        pts.append((cx + math.cos(a) * r, cy + math.sin(a) * r * squash))
    return pts


def loft(sections, matrix=None, caps=True, closed=True):
    """Loft equal-length (x, y) cross-sections stacked along Z.

    sections: [(z, [(x, y), ...]), ...] — every point list the same length.
    `closed=False` leaves the section open (a strip, not a tube).
    """
    n = len(sections[0][1])
    verts, faces = [], []
    for z, pts in sections:
        for x, y in pts:
            verts.append((x, y, z))
    for s in range(len(sections) - 1):
        a0, b0 = s * n, (s + 1) * n
        for i in range(n if closed else n - 1):
            j = (i + 1) % n
            faces.append((a0 + i, a0 + j, b0 + j, b0 + i))
    if caps and closed:
        faces.append(tuple(range(n)))
        faces.append(tuple(range(len(verts) - n, len(verts))))
    return _xf(verts, matrix), faces


def shell_band(z0, z1, r0, r1, thickness=0.02, segments=10, arc=math.pi,
               arc_start=0.0, squash=1.0, center=(0.0, 0.0), matrix=None):
    """An armour lame: a partial cone with real wall thickness and end caps."""
    cx, cy = center
    h = thickness / 2
    closed = arc >= TAU - 1e-6
    n = segments if closed else segments + 1
    verts = []
    for z, r, off in ((z0, r0, h), (z1, r1, h), (z1, r1, -h), (z0, r0, -h)):
        for i in range(n):
            a = arc_start + arc * (i / segments)
            rr = r + off
            verts.append((cx + math.cos(a) * rr,
                          cy + math.sin(a) * rr * squash, z))
    faces = []

    def wall(ra, rb):
        for i in range(segments):
            j = (i + 1) % n if closed else i + 1
            faces.append((ra + i, ra + j, rb + j, rb + i))

    wall(0, n)              # outer face
    wall(n, 2 * n)          # top rim
    wall(2 * n, 3 * n)      # inner face
    wall(3 * n, 0)          # bottom rim
    if not closed:
        e = n - 1
        faces.append((0, n, 2 * n, 3 * n))
        faces.append((e, n + e, 2 * n + e, 3 * n + e))
    return _xf(verts, matrix), faces


def sheet(fn, nu, nv, thickness=0.012, matrix=None):
    """Solid shell from a parametric surface fn(u, v) -> (x, y, z), u/v in 0..1.

    Thickness is applied along the surface normal — use it for cloth.
    """
    grid = [[Vector(fn(i / nu, k / nv)) for k in range(nv + 1)]
            for i in range(nu + 1)]

    def normal(i, k):
        du = grid[min(i + 1, nu)][k] - grid[max(i - 1, 0)][k]
        dv = grid[i][min(k + 1, nv)] - grid[i][max(k - 1, 0)]
        nr = du.cross(dv)
        return nr.normalized() if nr.length > 1e-9 else Vector((0.0, 1.0, 0.0))

    h = thickness / 2
    front, back = [], []
    for i in range(nu + 1):
        for k in range(nv + 1):
            nr = normal(i, k)
            front.append(tuple(grid[i][k] + nr * h))
            back.append(tuple(grid[i][k] - nr * h))
    m, o = nv + 1, len(front)
    verts = front + back
    faces = []
    for i in range(nu):
        for k in range(nv):
            a, b = i * m + k, (i + 1) * m + k
            faces.append((a, a + 1, b + 1, b))
            faces.append((o + a, o + b, o + b + 1, o + a + 1))
    for i in range(nu):
        for k in (0, nv):
            a, b = i * m + k, (i + 1) * m + k
            faces.append((a, b, o + b, o + a))
    for k in range(nv):
        for i in (0, nu):
            a, b = i * m + k, i * m + k + 1
            faces.append((a, b, o + b, o + a))
    return _xf(verts, matrix), faces


def tube(path, radii, segments=8, matrix=None, caps=True):
    """Sweep a circular section along a polyline using parallel transport."""
    pts = [Vector(p) for p in path]
    n = len(pts)
    if callable(radii):
        radii = [radii(i / (n - 1)) for i in range(n)]
    tangents = []
    for i in range(n):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == n - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        tangents.append(t.normalized())
    up = Vector((0.0, 0.0, 1.0))
    if abs(tangents[0].dot(up)) > 0.9:
        up = Vector((0.0, 1.0, 0.0))
    nrm = (up - tangents[0] * up.dot(tangents[0])).normalized()
    verts, faces = [], []
    for i in range(n):
        if i:
            nrm = nrm - tangents[i] * nrm.dot(tangents[i])
            nrm = nrm.normalized() if nrm.length > 1e-6 else Vector((0, 0, 1.0))
        bi = tangents[i].cross(nrm)
        for k in range(segments):
            a = TAU * k / segments
            off = (nrm * math.cos(a) + bi * math.sin(a)) * radii[i]
            verts.append(tuple(pts[i] + off))
    for i in range(n - 1):
        a0, b0 = i * segments, (i + 1) * segments
        for k in range(segments):
            j = (k + 1) % segments
            faces.append((a0 + k, a0 + j, b0 + j, b0 + k))
    if caps:
        faces.append(tuple(range(segments)))
        faces.append(tuple(range((n - 1) * segments, n * segments)))
    return _xf(verts, matrix), faces


def mirror_x():
    """Flip across the body midline — normals get recalculated at bake."""
    return Matrix.Diagonal((-1.0, 1.0, 1.0, 1.0))


def rot(rx=0.0, ry=0.0, rz=0.0, translate=(0, 0, 0)):
    """Convenience matrix: euler XYZ in degrees, then translation."""
    e = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), 'XYZ')
    return Matrix.Translation(Vector(translate)) @ e.to_matrix().to_4x4()


# ------------------------------------------------------------------ part baking

class Part:
    """Accumulates primitives, then bakes them into one multi-material mesh."""

    def __init__(self, name):
        self.name = name
        self.verts = []
        self.faces = []
        self.face_mats = []
        self.face_bevel = []
        self.mats = []
        self._mat_ix = {}

    def add(self, prim, mat, bevel=True):
        """`bevel=False` keeps dense/organic surfaces (cloth, fur) out of the
        hard-surface bevel pass, which would otherwise quilt them."""
        verts, faces = prim
        if mat.name not in self._mat_ix:
            self._mat_ix[mat.name] = len(self.mats)
            self.mats.append(mat)
        mi = self._mat_ix[mat.name]
        off = len(self.verts)
        self.verts.extend(verts)
        for f in faces:
            self.faces.append(tuple(i + off for i in f))
            self.face_mats.append(mi)
            self.face_bevel.append(bevel)
        return self

    def bake(self, parent=None, bevel=0.006, smooth_angle=38.0):
        if not self.faces:
            return None
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.verts, [], self.faces)
        me.update()
        for m in self.mats:
            me.materials.append(m)
        for poly, mi in zip(me.polygons, self.face_mats):
            poly.material_index = mi

        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if bevel:
            bm.faces.ensure_lookup_table()
            keep = {f.index for f, ok in zip(bm.faces, self.face_bevel) if ok}
            edges = [e for e in bm.edges
                     if e.link_faces and all(f.index in keep
                                             for f in e.link_faces)]
            verts = {v for e in edges for v in e.verts}
            bmesh.ops.bevel(
                bm, geom=list(verts) + edges,
                offset=bevel, segments=1, profile=0.5, affect='EDGES',
                clamp_overlap=True, loop_slide=True,
            )
        bm.to_mesh(me)
        bm.free()
        me.update()

        ob = bpy.data.objects.new(self.name, me)
        bpy.context.collection.objects.link(ob)
        if parent is not None:
            ob.parent = parent
        _shade_smooth(ob, smooth_angle)
        return ob


def _shade_smooth(ob, angle_deg):
    """Blender 4.1+ dropped mesh.auto_smooth_angle; fall back gracefully."""
    for poly in ob.data.polygons:
        poly.use_smooth = True
    try:
        mod = ob.modifiers.new("Smooth by Angle", 'SMOOTH_BY_ANGLE')
        mod.angle = math.radians(angle_deg)
    except (TypeError, RuntimeError):
        try:
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.shade_auto_smooth(angle=math.radians(angle_deg))
        except Exception:
            for poly in ob.data.polygons:
                poly.use_smooth = False


def joint(name, offset, parent=None):
    """An Empty that becomes a named glTF node the game animates."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.05
    e.empty_display_type = 'PLAIN_AXES'
    bpy.context.collection.objects.link(e)
    e.location = offset
    if parent is not None:
        e.parent = parent
    return e


# ---------------------------------------------------------------------- export

def export_glb(filepath, apply_modifiers=True):
    import os
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    kwargs = dict(
        filepath=filepath,
        export_format='GLB',
        use_selection=False,
        export_yup=True,
        export_apply=apply_modifiers,
        export_cameras=False,
        export_lights=False,
        export_materials='EXPORT',
    )
    while True:
        try:
            bpy.ops.export_scene.gltf(**kwargs)
            return
        except TypeError as exc:
            # Drop kwargs this Blender build does not know, one at a time.
            bad = [k for k in kwargs if k != 'filepath' and k in str(exc)]
            if not bad:
                raise
            for k in bad:
                kwargs.pop(k)
