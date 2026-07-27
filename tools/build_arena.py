"""
build_arena.py -- procedural arena generator for art-of-battle.

Builds a moody Viking / medieval fortress courtyard at dusk and exports it to
public/models/arena.glb.

Run headless:
    blender --background --python tools/build_arena.py

Contract (see ASSET_CONTRACT.md):
  * origin at the centre of a circular fighting floor, radius 11 m
  * floor top surface exactly at y = 0 (Blender Z = 0)
  * nothing intrudes inside radius 9.5 m above y = 0
  * Principled BSDF, baseColor / metallic / roughness only, no textures
  * < ~40k triangles

Also emits Empty nodes named Light_Brazier_00 ... Light_Brazier_NN at the
centre-top of every brazier bowl so the runtime can attach point lights and
fire VFX.
"""

import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Euler, Matrix, Vector

# --------------------------------------------------------------------------
# tunables
# --------------------------------------------------------------------------

SEED = 20260724

PLAY_RADIUS = 9.5        # nothing may intrude inside this, above y=0
FLOOR_RADIUS = 11.0      # top surface of the flagstones, exactly z=0
WALL_INNER = 11.6        # ruined battlement ring starts here
WALL_THICKNESS = 1.05
WALL_RADIUS = WALL_INNER + WALL_THICKNESS * 0.5

PILLAR_RADIUS = 13.05
BANNER_RADIUS = 12.55
BRAZIER_RADIUS = 11.78  # braziers stand in the collapsed breaches of the wall
GROUND_RADIUS = 34.0

N_PILLARS = 7
N_BRAZIERS = 4

TAU = math.pi * 2.0

# --------------------------------------------------------------------------
# scene helpers
# --------------------------------------------------------------------------


def clean_scene():
    """Wipe every datablock so the export contains only what we author."""
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.curves,
        bpy.data.lights,
        bpy.data.cameras,
        bpy.data.images,
        bpy.data.armatures,
        bpy.data.actions,
    ):
        for block in list(coll):
            coll.remove(block, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)


def make_material(name, base_color, metallic=0.0, roughness=0.9):
    """Principled BSDF with baseColor / metallic / roughness only."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:  # pragma: no cover - node name should always exist
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
    r, g, b = base_color
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.35
    elif "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.35
    mat.diffuse_color = (r, g, b, 1.0)
    return mat


def xform(loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)):
    return Matrix.LocRotScale(Vector(loc), Euler(rot, "XYZ"), Vector(scale))


# --------------------------------------------------------------------------
# geometry builder -- one bmesh per material, keeps the object count tiny
# --------------------------------------------------------------------------


class Builder:
    """Accumulates primitives into a single bmesh, emitted as one object."""

    def __init__(self, name, material):
        self.name = name
        self.material = material
        self.bm = bmesh.new()

    # -- primitives ---------------------------------------------------------

    def box(self, loc, size, rot=(0.0, 0.0, 0.0)):
        bmesh.ops.create_cube(self.bm, size=1.0, matrix=xform(loc, rot, size))

    def cone(self, loc, r_bottom, r_top, depth, segments=12, rot=(0.0, 0.0, 0.0)):
        kwargs = dict(
            cap_ends=True,
            cap_tris=False,
            segments=segments,
            depth=depth,
            matrix=xform(loc, rot),
        )
        try:
            bmesh.ops.create_cone(self.bm, radius1=r_bottom, radius2=r_top, **kwargs)
        except TypeError:  # pragma: no cover - very old bmesh api
            bmesh.ops.create_cone(
                self.bm, diameter1=r_bottom * 2.0, diameter2=r_top * 2.0, **kwargs
            )

    def cylinder(self, loc, radius, depth, segments=12, rot=(0.0, 0.0, 0.0)):
        self.cone(loc, radius, radius, depth, segments, rot)

    def chunk(self, loc, size, rot=(0.0, 0.0, 0.0), subdivisions=1):
        """Irregular rock lump."""
        try:
            res = bmesh.ops.create_icosphere(
                self.bm, subdivisions=subdivisions, radius=0.5, matrix=xform(loc, rot, size)
            )
        except TypeError:  # pragma: no cover - pre-3.0 bmesh api
            res = bmesh.ops.create_icosphere(
                self.bm, subdivisions=subdivisions, diameter=1.0, matrix=xform(loc, rot, size)
            )
        # rough the silhouette up a little so it does not read as a ball
        centre = Vector(loc)
        for vert in res["verts"]:
            offset = (vert.co - centre)
            if offset.length > 1e-6:
                vert.co = centre + offset * random.uniform(0.72, 1.16)

    def grid(self, corners_fn, nx, ny):
        """Quad grid from a (u, v) -> Vector callback; used for cloth banners."""
        verts = [[self.bm.verts.new(corners_fn(i / nx, j / ny)) for j in range(ny + 1)]
                 for i in range(nx + 1)]
        for i in range(nx):
            for j in range(ny):
                self.bm.faces.new(
                    (verts[i][j], verts[i + 1][j], verts[i + 1][j + 1], verts[i][j + 1])
                )

    # -- output -------------------------------------------------------------

    def emit(self):
        if not self.bm.faces:
            self.bm.free()
            return None
        mesh = bpy.data.meshes.new(self.name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        mesh.materials.append(self.material)
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


# --------------------------------------------------------------------------
# arena pieces
# --------------------------------------------------------------------------


def build_ground(dirt):
    """Dark packed-earth apron so the arena is not floating in the void."""
    b = Builder("Arena_Ground", dirt)
    b.cylinder((0.0, 0.0, -0.55), GROUND_RADIUS, 1.0, segments=40)
    # a couple of low earthen mounds beyond the wall
    for i in range(5):
        a = random.uniform(0.0, TAU)
        r = random.uniform(17.0, 26.0)
        b.chunk(
            (math.cos(a) * r, math.sin(a) * r, -0.25),
            (random.uniform(5.0, 9.0), random.uniform(5.0, 9.0), random.uniform(1.4, 2.6)),
            rot=(0.0, 0.0, random.uniform(0.0, TAU)),
            subdivisions=1,
        )
    return b.emit()


def build_floor(flagstone, mortar):
    """Concentric rings of flagstone tiles; tallest tops sit exactly at z=0."""
    base = Builder("Arena_FloorBase", mortar)
    # sunken bed the tiles sit in -- top just below z=0 so joints read dark
    base.cylinder((0.0, 0.0, -0.42), FLOOR_RADIUS + 0.06, 0.8, segments=48)
    # a chunky kerb around the rim
    kerb_n = 56
    for i in range(kerb_n):
        a = TAU * i / kerb_n
        w = TAU * (FLOOR_RADIUS + 0.22) / kerb_n * 0.96
        h = 0.30
        # top of the kerb sits at or just below z=0 -- never proud of the floor
        sink = 0.0 if i % 3 == 0 else random.uniform(0.01, 0.045)
        base.box(
            (math.cos(a) * (FLOOR_RADIUS + 0.2), math.sin(a) * (FLOOR_RADIUS + 0.2),
             -sink - h * 0.5),
            (0.42, w, h),
            rot=(0.0, 0.0, a + random.uniform(-0.02, 0.02)),
        )
    base.emit()

    tiles = Builder("Arena_Flagstones", flagstone)
    # centre medallion
    tiles.cylinder((0.0, 0.0, -0.13), 0.62, 0.26, segments=16)

    r_inner = 0.6
    while r_inner < FLOOR_RADIUS - 0.02:
        depth = random.uniform(0.80, 0.96)
        remaining = FLOOR_RADIUS - r_inner
        if remaining - depth < 0.42:
            depth = remaining
        r_mid = r_inner + depth * 0.5
        tile_w = random.uniform(0.82, 0.98)
        count = max(6, int(round(TAU * r_mid / tile_w)))
        step = TAU / count
        a0 = random.uniform(0.0, TAU)
        for i in range(count):
            a = a0 + i * step + random.uniform(-0.006, 0.006)
            # random per-tile sink; ~1/3 of tiles sit exactly at z=0
            sink = 0.0 if random.random() < 0.34 else random.uniform(0.012, 0.038)
            tilt_x = tilt_y = 0.0
            if sink > 0.010:
                tilt_x = random.uniform(-0.006, 0.006)
                tilt_y = random.uniform(-0.006, 0.006)
            thick = 0.26
            # tight joints -- the dark bed below should read as mortar lines,
            # not as gaps between scattered slabs
            sx = depth * random.uniform(0.955, 0.995)
            sy = r_mid * step * random.uniform(0.945, 0.99)
            tiles.box(
                (math.cos(a) * r_mid, math.sin(a) * r_mid, -sink - thick * 0.5),
                (sx, sy, thick),
                rot=(tilt_x, tilt_y, a + random.uniform(-0.018, 0.018)),
            )
        r_inner += depth
    return tiles.emit()


def plan_wall_gaps():
    """Where the battlement has collapsed. Shared with the brazier placement."""
    gaps = []
    for centre_deg in (24.0, 118.0, 205.0, 292.0):
        half = random.uniform(11.0, 17.0)
        c = math.radians(centre_deg + random.uniform(-8.0, 8.0))
        gaps.append((c, math.radians(half)))
    return gaps


def build_wall(wallstone, gaps):
    """Ruined battlement ring outside radius 11.5 with collapsed gaps."""
    b = Builder("Arena_Wall", wallstone)

    slots = 76

    def in_gap(a):
        for c, half in gaps:
            d = abs((a - c + math.pi) % TAU - math.pi)
            if d < half:
                return True
        return False

    def gap_edge(a):
        """0..1 -- how close to a collapse, used to slump the wall height."""
        best = 1.0
        for c, half in gaps:
            d = abs((a - c + math.pi) % TAU - math.pi)
            best = min(best, max(0.0, (d - half) / 0.30))
        return min(1.0, best)

    # slowly varying height profile so it reads as masonry, not noise
    harm = [(random.uniform(0.0, TAU), random.uniform(0.12, 0.34)) for _ in range(3)]

    course_h = 0.42
    for slot in range(slots):
        a_base = TAU * slot / slots
        if in_gap(a_base):
            continue
        profile = 1.0
        for k, (phase, amp) in enumerate(harm, start=2):
            profile += math.sin(a_base * k + phase) * amp
        height = (1.35 * profile) * (0.35 + 0.65 * gap_edge(a_base))
        height = max(0.42, min(2.35, height + random.uniform(-0.16, 0.16)))
        courses = max(1, int(height / course_h))

        for c in range(courses):
            # running bond: alternate courses shift half a slot
            a = a_base + (TAU / slots) * (0.5 if c % 2 else 0.0)
            a += random.uniform(-0.008, 0.008)
            r = WALL_RADIUS + random.uniform(-0.05, 0.05)
            w = TAU * r / slots * random.uniform(0.86, 0.97)
            d = WALL_THICKNESS * random.uniform(0.88, 1.0)
            z = c * course_h + course_h * 0.5
            b.box(
                (math.cos(a) * r, math.sin(a) * r, z),
                (d, w, course_h * random.uniform(0.92, 1.0)),
                rot=(0.0, random.uniform(-0.02, 0.02), a),
            )
        # coping stone on the intact stretches
        if courses >= 3 and random.random() < 0.55:
            a = a_base + random.uniform(-0.01, 0.01)
            r = WALL_RADIUS
            b.box(
                (math.cos(a) * r, math.sin(a) * r, courses * course_h + 0.08),
                (WALL_THICKNESS * 1.08, TAU * r / slots * 0.94, 0.16),
                rot=(0.0, random.uniform(-0.03, 0.03), a),
            )

    # spill of fallen blocks in the gaps -- kept clear of the breach centre so
    # they do not collide with the braziers standing there
    for c, half in gaps:
        for _ in range(5):
            a = c + random.choice((-1.0, 1.0)) * random.uniform(half * 0.45, half)
            r = random.uniform(WALL_INNER + 0.35, WALL_RADIUS + 1.3)
            b.box(
                (math.cos(a) * r, math.sin(a) * r, random.uniform(0.06, 0.24)),
                (random.uniform(0.35, 0.7), random.uniform(0.35, 0.75), random.uniform(0.2, 0.38)),
                rot=(random.uniform(-0.2, 0.2), random.uniform(-0.2, 0.2), random.uniform(0.0, TAU)),
            )
    return b.emit()


def build_pillars(pillarstone):
    """6-8 weathered pillars, a few of them snapped off short."""
    b = Builder("Arena_Pillars", pillarstone)
    for i in range(N_PILLARS):
        a = TAU * i / N_PILLARS + random.uniform(-0.05, 0.05)
        r = PILLAR_RADIUS + random.uniform(-0.25, 0.25)
        x, y = math.cos(a) * r, math.sin(a) * r
        broken = i % 3 == 1
        height = random.uniform(1.5, 2.4) if broken else random.uniform(3.7, 5.0)
        rad = random.uniform(0.56, 0.70)

        # rough single-tier plinth (blocky, not classical)
        b.box((x, y, 0.19), (rad * 2.5, rad * 2.5, 0.38), rot=(0.0, 0.0, a + 0.1))
        # shaft: coarse 8-sided prism, barely tapered, so it reads as hewn stone
        shaft_bottom = 0.36
        shaft_h = height - shaft_bottom
        b.cone(
            (x, y, shaft_bottom + shaft_h * 0.5),
            rad, rad * random.uniform(0.90, 0.96), shaft_h, segments=8,
            rot=(0.0, 0.0, a + random.uniform(-0.3, 0.3)),
        )
        # a weathered band partway up
        band_z = shaft_bottom + shaft_h * random.uniform(0.35, 0.6)
        b.box((x, y, band_z), (rad * 2.15, rad * 2.15, 0.17), rot=(0.0, 0.0, a + 0.25))
        if broken:
            # jagged snapped crown
            for _ in range(3):
                b.box(
                    (x + random.uniform(-0.22, 0.22), y + random.uniform(-0.22, 0.22),
                     height + random.uniform(0.0, 0.14)),
                    (random.uniform(0.22, 0.42), random.uniform(0.22, 0.42),
                     random.uniform(0.14, 0.3)),
                    rot=(random.uniform(-0.25, 0.25), random.uniform(-0.25, 0.25),
                         random.uniform(0.0, TAU)),
                )
        else:
            # single chunky capstone
            b.box((x, y, height + 0.14), (rad * 2.35, rad * 2.35, 0.28),
                  rot=(0.0, 0.0, a + random.uniform(-0.2, 0.2)))
    return b.emit()


def build_banners(wood, cloth_red, cloth_blue):
    """Wooden poles with hanging cloth between some of the pillars."""
    poles = Builder("Arena_BannerPoles", wood)
    red = Builder("Arena_BannerCloth_Red", cloth_red)
    blue = Builder("Arena_BannerCloth_Blue", cloth_blue)

    # sit banners in the gaps between pillars
    for k in range(4):
        a = TAU * (k + 0.5) / 4.0 + random.uniform(-0.06, 0.06)
        r = BANNER_RADIUS
        x, y = math.cos(a) * r, math.sin(a) * r
        pole_h = random.uniform(4.3, 5.1)

        # base blocks + pole + crossbar
        poles.box((x, y, 0.14), (0.62, 0.62, 0.28), rot=(0.0, 0.0, a))
        poles.cone((x, y, pole_h * 0.5 + 0.2), 0.10, 0.075, pole_h, segments=8, rot=(0.0, 0.0, a))
        bar_len = 1.5
        poles.box((x, y, pole_h + 0.06), (0.09, bar_len, 0.09), rot=(0.0, 0.0, a))
        # finial
        poles.cone((x, y, pole_h + 0.30), 0.10, 0.0, 0.34, segments=8, rot=(0.0, 0.0, a))

        # hanging cloth: gentle vertical wave, tapered point at the bottom
        target = red if k % 2 == 0 else blue
        width = bar_len * 0.92
        drop = random.uniform(2.5, 3.1)
        top_z = pole_h + 0.02
        tangent = Vector((-math.sin(a), math.cos(a), 0.0))
        normal = Vector((math.cos(a), math.sin(a), 0.0))
        origin = Vector((x, y, 0.0))
        phase = random.uniform(0.0, TAU)

        def cloth_point(u, v, _o=origin, _t=tangent, _n=normal,
                        _w=width, _d=drop, _z=top_z, _p=phase):
            # taper the last fifth into a swallowtail
            taper = 1.0 if v < 0.8 else 1.0 - (v - 0.8) * 2.4
            across = (u - 0.5) * _w * max(taper, 0.12)
            billow = math.sin(u * math.pi * 2.0 + _p) * 0.075 * (0.25 + v)
            sag = math.sin(u * math.pi) * 0.06
            return _o + _t * across + _n * billow + Vector((0.0, 0.0, _z - v * _d - sag))

        target.grid(cloth_point, 6, 9)

    poles.emit()
    red.emit()
    blue.emit()


def build_braziers(pillarstone, ash, gaps):
    """Stone bowl on a short pillar, standing in each collapsed breach.

    The game finds the Light_Brazier_NN empties and attaches a point light and
    fire VFX at each one; only the geometry lives here.
    """
    stone = Builder("Arena_Braziers", pillarstone)
    # charcoal bed + charred logs: matte and dark, so the game's fire light does
    # not turn the bowl into a shiny gold dish
    embers = Builder("Arena_BrazierEmbers", ash)
    empties = []

    for i in range(min(N_BRAZIERS, len(gaps))):
        a = gaps[i][0]
        r = BRAZIER_RADIUS
        x, y = math.cos(a) * r, math.sin(a) * r

        base_h = 0.30
        col_h = random.uniform(0.85, 1.02)
        bowl_h = 0.42

        # squat, heavy stone stand
        stone.box((x, y, base_h * 0.5), (1.14, 1.14, base_h), rot=(0.0, 0.0, a + 0.2))
        stone.box((x, y, base_h + 0.09), (0.92, 0.92, 0.18), rot=(0.0, 0.0, a - 0.15))
        stone.cone((x, y, base_h + col_h * 0.5), 0.44, 0.38, col_h, segments=8, rot=(0.0, 0.0, a))

        bowl_z = base_h + col_h
        # bowl: flared outer wall, with a sunken charcoal bed inside
        stone.cone((x, y, bowl_z + bowl_h * 0.5), 0.42, 0.72, bowl_h, segments=14, rot=(0.0, 0.0, a))
        embers.cone((x, y, bowl_z + bowl_h * 0.78), 0.50, 0.62, 0.10, segments=14, rot=(0.0, 0.0, a))
        # a few charred logs stacked in the bowl
        for k in range(3):
            la = random.uniform(0.0, TAU)
            embers.box(
                (x + math.cos(la) * 0.12, y + math.sin(la) * 0.12,
                 bowl_z + bowl_h * 0.82 + 0.06 + k * 0.05),
                (0.60, 0.10, 0.10),
                rot=(0.0, random.uniform(-0.16, 0.16), la),
            )

        empty_z = bowl_z + bowl_h + 0.20
        empty = bpy.data.objects.new("Light_Brazier_%02d" % i, None)
        empty.empty_display_type = "PLAIN_AXES"
        empty.empty_display_size = 0.4
        empty.location = (x, y, empty_z)
        bpy.context.scene.collection.objects.link(empty)
        empties.append(empty.name)

    stone.emit()
    embers.emit()
    return empties


def build_props(wood, iron, rubblestone):
    """Rubble, crates, a broken cart wheel and weapon racks -- all outside r=11."""
    rubble = Builder("Arena_Rubble", rubblestone)
    timber = Builder("Arena_Props_Wood", wood)
    metal = Builder("Arena_Props_Iron", iron)

    # scattered rock chunks
    for _ in range(14):
        a = random.uniform(0.0, TAU)
        r = random.uniform(11.55, 16.5)
        s = random.uniform(0.3, 0.75)
        rubble.chunk(
            (math.cos(a) * r, math.sin(a) * r, s * 0.32),
            (s * random.uniform(0.9, 1.6), s * random.uniform(0.9, 1.6), s * random.uniform(0.5, 0.9)),
            rot=(random.uniform(0.0, 0.6), random.uniform(0.0, 0.6), random.uniform(0.0, TAU)),
        )
    # a few flat slabs leaning on the wall
    for _ in range(6):
        a = random.uniform(0.0, TAU)
        r = random.uniform(12.6, 14.5)
        rubble.box(
            (math.cos(a) * r, math.sin(a) * r, random.uniform(0.1, 0.5)),
            (random.uniform(0.7, 1.4), random.uniform(0.5, 1.0), random.uniform(0.16, 0.3)),
            rot=(random.uniform(-0.5, 0.5), random.uniform(-0.4, 0.4), random.uniform(0.0, TAU)),
        )

    # crates, stacked
    crate_a = math.radians(72.0)
    for cx, cy, cz, cs in (
        (0.0, 0.0, 0.0, 0.78),
        (0.85, 0.15, 0.0, 0.68),
        (0.12, -0.1, 0.78, 0.62),
    ):
        base = Vector((math.cos(crate_a) * 13.4, math.sin(crate_a) * 13.4, 0.0))
        off = Vector((cx, cy, 0.0))
        timber.box(
            (base.x + off.x, base.y + off.y, cz + cs * 0.5),
            (cs, cs, cs),
            rot=(0.0, 0.0, crate_a + random.uniform(-0.3, 0.3)),
        )

    # broken cart wheel, leaning against the wall
    wa = math.radians(215.0)
    wr = 13.1
    wx, wy = math.cos(wa) * wr, math.sin(wa) * wr
    wheel_r = 0.78
    lean = 0.35
    wheel_rot = (math.pi * 0.5 - lean, 0.0, wa)
    wheel_mat = xform((wx, wy, wheel_r * math.cos(lean) + 0.05), wheel_rot)

    def wheel_local(p):
        return wheel_mat @ Vector(p)

    rim_seg = 16
    for i in range(rim_seg):
        ang = TAU * i / rim_seg
        p = wheel_local((math.cos(ang) * wheel_r, math.sin(ang) * wheel_r, 0.0))
        # broken: drop two rim segments
        if i in (5, 6):
            continue
        timber.box(
            (p.x, p.y, p.z),
            (TAU * wheel_r / rim_seg * 1.05, 0.14, 0.16),
            rot=(wheel_rot[0], wheel_rot[1], wheel_rot[2] + ang + math.pi * 0.5),
        )
    for i in range(6):
        ang = TAU * i / 6.0
        p = wheel_local((math.cos(ang) * wheel_r * 0.5, math.sin(ang) * wheel_r * 0.5, 0.0))
        timber.box(
            (p.x, p.y, p.z),
            (wheel_r * 0.95, 0.08, 0.08),
            rot=(wheel_rot[0], wheel_rot[1], wheel_rot[2] + ang),
        )
    hub = wheel_local((0.0, 0.0, 0.0))
    timber.cylinder((hub.x, hub.y, hub.z), 0.2, 0.26, segments=10, rot=wheel_rot)

    # weapon racks
    for ra_deg in (145.0, 300.0):
        ra = math.radians(ra_deg)
        rr = 13.6
        rx, ry = math.cos(ra) * rr, math.sin(ra) * rr
        tangent = Vector((-math.sin(ra), math.cos(ra), 0.0))
        rack_h = 1.5
        for side in (-1.0, 1.0):
            p = Vector((rx, ry, 0.0)) + tangent * (0.85 * side)
            timber.box((p.x, p.y, rack_h * 0.5), (0.14, 0.14, rack_h), rot=(0.0, 0.0, ra))
        for z in (0.55, 1.35):
            timber.box((rx, ry, z), (0.10, 1.85, 0.10), rot=(0.0, 0.0, ra))
        # a handful of polearms leaning in the rack
        for k in range(5):
            off = (k - 2) * 0.36 + random.uniform(-0.05, 0.05)
            p = Vector((rx, ry, 0.0)) + tangent * off
            tiltn = random.uniform(-0.10, 0.10)
            shaft_len = random.uniform(1.9, 2.3)
            timber.box(
                (p.x, p.y, shaft_len * 0.5),
                (0.06, 0.06, shaft_len),
                rot=(tiltn, random.uniform(-0.06, 0.06), ra),
            )
            metal.box(
                (p.x, p.y, shaft_len + 0.16),
                (0.05, 0.13, 0.34),
                rot=(tiltn, 0.0, ra),
            )
        # a couple of shields propped at the foot of the rack
        for k in (-1, 1):
            p = Vector((rx, ry, 0.0)) + tangent * (1.25 * k)
            metal.cylinder(
                (p.x + math.cos(ra) * 0.15, p.y + math.sin(ra) * 0.15, 0.46),
                0.42, 0.10, segments=10,
                rot=(math.pi * 0.5 - 0.22, 0.0, ra),
            )

    rubble.emit()
    timber.emit()
    metal.emit()


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------


def output_path():
    """Resolve ../public/models/arena.glb relative to THIS FILE, not the cwd."""
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:  # pragma: no cover - running pasted into the console
        here = os.path.dirname(os.path.abspath(bpy.data.filepath or os.getcwd()))
    out_dir = os.path.normpath(os.path.join(here, "..", "public", "models"))
    os.makedirs(out_dir, exist_ok=True)
    return os.path.join(out_dir, "arena.glb")


def export_glb(path):
    """Export, dropping any kwarg this Blender build rejects rather than fighting it."""
    kwargs = {
        "filepath": path,
        "export_format": "GLB",
        "use_selection": False,
        "export_apply": True,
        "export_yup": True,
        "export_materials": "EXPORT",
        "export_cameras": False,
        "export_lights": False,
        "export_animations": False,
        "export_skins": False,
        "export_morph": False,
        "export_normals": True,
        "export_texcoords": False,
        "export_extras": False,
    }
    while True:
        try:
            bpy.ops.export_scene.gltf(**kwargs)
            return
        except TypeError as exc:
            msg = str(exc)
            dropped = None
            for key in list(kwargs):
                if key in ("filepath", "export_format"):
                    continue
                if key in msg:
                    dropped = key
                    break
            if dropped is None:
                # unknown complaint -- fall back to the bare minimum
                if len(kwargs) > 2:
                    kwargs = {"filepath": path, "export_format": "GLB"}
                    continue
                raise
            print("[build_arena] dropping unsupported export kwarg: %s" % dropped)
            kwargs.pop(dropped)


def triangle_count():
    total = 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        eval_obj = obj.evaluated_get(depsgraph)
        mesh = eval_obj.to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        eval_obj.to_mesh_clear()
    return total


# --------------------------------------------------------------------------


def main():
    random.seed(SEED)
    clean_scene()

    # Base Color is LINEAR. These sit around sRGB 0.30-0.45 -- dark enough to
    # read as a moody dusk courtyard, with each stone element a slightly
    # different grey so the arena is not one flat tone.
    flagstone = make_material("M_Flagstone", (0.145, 0.150, 0.158), 0.0, 0.88)
    mortar = make_material("M_Mortar", (0.040, 0.041, 0.045), 0.0, 0.96)
    wallstone = make_material("M_WallStone", (0.105, 0.104, 0.098), 0.0, 0.92)
    pillarstone = make_material("M_PillarStone", (0.128, 0.124, 0.114), 0.0, 0.90)
    rubblestone = make_material("M_RubbleStone", (0.092, 0.096, 0.104), 0.0, 0.95)
    charcoal = make_material("M_Charcoal", (0.022, 0.020, 0.018), 0.0, 1.0)
    dirt = make_material("M_Dirt", (0.032, 0.030, 0.026), 0.0, 1.0)
    wood = make_material("M_Wood", (0.098, 0.058, 0.026), 0.0, 0.82)
    cloth_red = make_material("M_Cloth_Red", (0.175, 0.016, 0.018), 0.0, 0.78)
    cloth_blue = make_material("M_Cloth_Blue", (0.018, 0.030, 0.125), 0.0, 0.78)
    iron = make_material("M_Iron", (0.042, 0.043, 0.047), 0.85, 0.55)
    # everything is closed solid geometry except the banner cloth, which is a
    # single-sided plane and must render from both faces
    for solid in (flagstone, mortar, wallstone, pillarstone, rubblestone,
                  charcoal, dirt, wood, iron):
        solid.use_backface_culling = True
    for cloth in (cloth_red, cloth_blue):
        cloth.use_backface_culling = False

    gaps = plan_wall_gaps()

    build_ground(dirt)
    build_floor(flagstone, mortar)
    build_wall(wallstone, gaps)
    build_pillars(pillarstone)
    build_banners(wood, cloth_red, cloth_blue)
    brazier_empties = build_braziers(pillarstone, charcoal, gaps)
    build_props(wood, iron, rubblestone)

    bpy.context.view_layer.update()

    tris = triangle_count()
    meshes = [o.name for o in bpy.context.scene.objects if o.type == "MESH"]
    print("[build_arena] mesh objects: %d -> %s" % (len(meshes), ", ".join(sorted(meshes))))
    print("[build_arena] brazier empties: %s" % ", ".join(brazier_empties))
    print("[build_arena] triangles: %d" % tris)
    if tris > 40000:
        print("[build_arena] WARNING: triangle budget exceeded (%d > 40000)" % tris)

    path = output_path()
    export_glb(path)
    size = os.path.getsize(path)
    print("[build_arena] wrote %s (%.1f KB)" % (path, size / 1024.0))


if __name__ == "__main__":
    main()
    # --background keeps the process alive on some builds; be explicit.
    if bpy.app.background:
        sys.stdout.flush()
