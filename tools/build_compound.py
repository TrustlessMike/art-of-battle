"""
build_compound.py -- procedural fortified compound for art-of-battle.

Every wall, span, panel, opening and the objective are driven by
`tools/compound_layout.json`, which is dumped from `src/layout.js` -- the same
numbers gameplay uses for collision, line of sight and destruction. The art
therefore cannot drift away from the collision/destruction model.

Run headless:
    blender --background --python tools/build_compound.py

Output: public/models/compound.glb

Node contract (the game looks these up by name):
  * Panel_<wallId>_<spanIndex>_<panelIndex>  -- one OBJECT per destructible
    panel, hidden individually when the panel breaks. Never joined.
  * DoorFrame_<openingId> / WindowFrame_<openingId> -- the framing around a gap.
  * Anchor_<openingId>   -- Empty at the centre of the gap, floor level. The
    game spawns barricades there.
  * Objective_Banner     -- the war banner the attacker must destroy.
  * Light_Brazier_<nn>   -- Empty at the centre-top of a brazier bowl; the game
    attaches a point light and fire VFX (same as the arena).

Coordinates: the JSON is GAME space (X east, Z north, Y up, floor y=0). Blender
is Z-up and the glTF exporter converts to Y-up, so everything is authored via
g2b(): blender = (game_x, -game_z, height). Nothing hand-converts.
"""

import json
import math
import os
import random
import struct
import sys

import bpy
import bmesh

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rigkit import (  # noqa: E402  (path juggling has to come first)
    box, cylinder, dome, material, rot, sheet,
)

SEED = 20260724

# ---------------------------------------------------------------- tunables

THICKNESS = {"stone": 0.32, "timber": 0.16, "palisade": 0.16}
STONE_COURSES = 6
APRON = 18.0            # exterior apron reaches roughly this far out
WINDOW_SILL = 0.95      # gameplay: window gaps are 0.95 .. 2.20
WINDOW_HEAD = 2.20
TAU = math.tau

RNG = random.Random(SEED)


# ------------------------------------------------------------------ layout

def here():
    try:
        return os.path.dirname(os.path.abspath(__file__))
    except NameError:  # pragma: no cover - pasted into the console
        return os.path.dirname(os.path.abspath(bpy.data.filepath or os.getcwd()))


def load_layout():
    with open(os.path.join(here(), "compound_layout.json"), "r") as fh:
        return json.load(fh)


LAYOUT = load_layout()
WALL_H = LAYOUT["wallHeight"]
ROOMS = LAYOUT["rooms"]


def room_at(gx, gz):
    """Mirror of layout.js roomAt()."""
    for r in ROOMS:
        if r["x1"] <= gx <= r["x2"] and r["z1"] <= gz <= r["z2"]:
            return r["id"]
    return None


# --------------------------------------------------------- coordinate frames

def g2b(x, z, h=0.0):
    """GAME (x east, z north, h up) -> BLENDER (x, -z, z-up). The one mapping."""
    return (x, -z, h)


class Frame:
    """A local right-handed frame in Blender space: u along, v across, h up."""

    def __init__(self, bx, by, yaw):
        self.bx, self.by, self.yaw = bx, by, yaw
        self.ax, self.ay = math.cos(yaw), math.sin(yaw)
        self.nx, self.ny = -self.ay, self.ax

    def at(self, u=0.0, v=0.0, h=0.0):
        return (self.bx + self.ax * u + self.nx * v,
                self.by + self.ay * u + self.ny * v, h)

    def _m(self, u, v, h, yaw_deg=0.0, tilt_u=0.0, tilt_v=0.0):
        return rot(tilt_v, tilt_u, math.degrees(self.yaw) + yaw_deg,
                   translate=self.at(u, v, h))

    def box(self, u, v, h, su, sv, sh, yaw_deg=0.0, tilt_u=0.0, tilt_v=0.0):
        return box((0, 0, 0), (su, sv, sh),
                   matrix=self._m(u, v, h, yaw_deg, tilt_u, tilt_v))

    def cyl(self, u, v, h, r0, r1, length, seg=10,
            yaw_deg=0.0, tilt_u=0.0, tilt_v=0.0):
        """Cylinder standing on (u, v, h) and rising `length`."""
        return cylinder(0.0, length, r0, r1, segments=seg,
                        matrix=self._m(u, v, h, yaw_deg, tilt_u, tilt_v))

    def dome(self, u, v, h, rx, ry, rz, rings=3, seg=8, yaw_deg=0.0):
        return dome((0, 0, 0), (rx, ry, rz), rings=rings, segments=seg,
                    matrix=self._m(u, v, h, yaw_deg))


class Seg(Frame):
    """The frame of a wall segment given in GAME coordinates."""

    def __init__(self, gx1, gz1, gx2, gz2):
        x1, y1, _ = g2b(gx1, gz1)
        x2, y2, _ = g2b(gx2, gz2)
        dx, dy = x2 - x1, y2 - y1
        self.length = math.hypot(dx, dy)
        super().__init__((x1 + x2) / 2, (y1 + y2) / 2, math.atan2(dy, dx))


class Spot(Frame):
    """A prop's frame. `facing` is a GAME heading in degrees: 0 = +x, 90 = +z."""

    def __init__(self, gx, gz, facing=0.0):
        bx, by, _ = g2b(gx, gz)
        super().__init__(bx, by, math.radians(-facing))


# ---------------------------------------------------------------- mesh group

class Group:
    """Accumulates primitives into one multi-material object."""

    def __init__(self, name):
        self.name = name
        self.verts, self.faces, self.fmat = [], [], []
        self.mats, self._ix = [], {}

    def add(self, prim, mat):
        verts, faces = prim
        if mat.name not in self._ix:
            self._ix[mat.name] = len(self.mats)
            self.mats.append(mat)
        mi = self._ix[mat.name]
        off = len(self.verts)
        self.verts.extend(verts)
        for f in faces:
            self.faces.append(tuple(i + off for i in f))
            self.fmat.append(mi)
        return self

    def emit(self):
        if not self.faces:
            return None
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.verts, [], self.faces)
        me.update()
        for m in self.mats:
            me.materials.append(m)
        for poly, mi in zip(me.polygons, self.fmat):
            poly.material_index = mi
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        me.update()
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob


def empty(name, blender_pos, size=0.25):
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "PLAIN_AXES"
    e.empty_display_size = size
    e.location = blender_pos
    bpy.context.scene.collection.objects.link(e)
    return e


def clean_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.curves,
                 bpy.data.lights, bpy.data.cameras, bpy.data.images,
                 bpy.data.armatures, bpy.data.actions):
        for block in list(coll):
            coll.remove(block, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)


# ---------------------------------------------------------------- materials
# Base Color is LINEAR and the game lights this at dusk, so these sit dark --
# matched to the arena's palette. Stone is cool, timber warm.

M = {}


def build_materials():
    def mk(name, color, metallic=0.0, roughness=0.9, emission=None, cull=True):
        mat = material(name, color, metallic, roughness, emission)
        mat.use_backface_culling = cull
        M[name] = mat
        return mat

    mk("M_Stone", (0.118, 0.124, 0.137), 0.0, 0.92)
    mk("M_StoneWarm", (0.132, 0.132, 0.130), 0.0, 0.90)
    mk("M_StoneCool", (0.098, 0.107, 0.126), 0.0, 0.93)
    mk("M_StoneTrim", (0.150, 0.155, 0.166), 0.0, 0.86)
    mk("M_Mortar", (0.035, 0.037, 0.043), 0.0, 0.97)
    mk("M_FloorBed", (0.062, 0.063, 0.068), 0.0, 0.97)
    mk("M_Flagstone", (0.128, 0.131, 0.138), 0.0, 0.90)
    mk("M_FlagstoneAlt", (0.108, 0.112, 0.120), 0.0, 0.92)
    mk("M_FlagstoneWarm", (0.146, 0.138, 0.126), 0.0, 0.88)
    mk("M_Cobble", (0.086, 0.088, 0.092), 0.0, 0.95)
    mk("M_Dirt", (0.036, 0.032, 0.026), 0.0, 1.0)
    mk("M_Path", (0.052, 0.045, 0.034), 0.0, 1.0)
    mk("M_Timber", (0.104, 0.060, 0.028), 0.0, 0.84)
    mk("M_TimberDark", (0.052, 0.030, 0.014), 0.0, 0.90)
    mk("M_TimberPale", (0.138, 0.086, 0.042), 0.0, 0.82)
    mk("M_Iron", (0.040, 0.041, 0.045), 0.85, 0.55)
    mk("M_IronDark", (0.024, 0.024, 0.027), 0.75, 0.68)
    mk("M_Gold", (0.196, 0.132, 0.036), 0.90, 0.36)
    mk("M_Charcoal", (0.020, 0.018, 0.016), 0.0, 1.0)
    mk("M_Straw", (0.148, 0.112, 0.044), 0.0, 0.94)
    mk("M_Sack", (0.078, 0.066, 0.042), 0.0, 0.95)
    mk("M_Crimson", (0.184, 0.016, 0.020), 0.0, 0.78, cull=False)
    mk("M_Azure", (0.017, 0.031, 0.128), 0.0, 0.78, cull=False)
    mk("M_Wax", (0.190, 0.176, 0.140), 0.0, 0.70)
    mk("M_Flame", (0.95, 0.42, 0.10), 0.0, 0.6,
       emission=((1.0, 0.56, 0.18), 5.0))
    mk("M_Ember", (0.11, 0.030, 0.008), 0.0, 0.95,
       emission=((0.85, 0.24, 0.05), 1.3))


# --------------------------------------------------------------------- floor

def build_ground():
    """Packed earth apron so approaches and spawns are not floating in space."""
    g = Group("Compound_Ground")
    g.add(box((0.0, 0.0, -0.30), (2 * APRON + 8.0, 2 * APRON + 4.0, 0.50)),
          M["M_Dirt"])

    # worn approach paths at the two gates and along the west face
    for gx, gz, sx, sz in ((-6.0, -14.2, 3.6, 9.0),      # main gate approach
                           (16.4, -4.0, 8.0, 3.4),       # postern approach
                           (-16.2, 2.0, 6.0, 3.0)):      # west flank track
        bx, by, _ = g2b(gx, gz)
        g.add(box((bx, by, -0.035), (sx, sz, 0.06)), M["M_Path"])

    # low mounds beyond the walls to break the flat horizon
    for _ in range(9):
        a = RNG.uniform(0.0, TAU)
        r = RNG.uniform(15.5, 21.0)
        gx, gz = math.cos(a) * r * 1.15, math.sin(a) * r
        if abs(gx) < 14.5 and abs(gz) < 11.5:
            continue
        bx, by, _ = g2b(gx, gz)
        g.add(dome((bx, by, -0.30),
                   (RNG.uniform(2.4, 4.6), RNG.uniform(2.2, 4.0),
                    RNG.uniform(0.5, 1.1)), rings=2, segments=8),
              M["M_Dirt"])
    return g.emit()


FLOOR_BY_ROOM = {
    "chapel": "M_FlagstoneWarm",
    "hall": "M_Flagstone",
    "armoury": "M_FlagstoneAlt",
    "stores": "M_FlagstoneAlt",
    "barracks": "M_Flagstone",
    None: "M_Flagstone",
}


def build_floor():
    """Flagstones over the footprint, cobbles in a band outside the walls."""
    bed = Group("Compound_FloorBed")
    bed.add(box((0.0, 0.0, -0.17), (26.9, 20.9, 0.32)), M["M_FloorBed"])
    bed.emit()

    tiles = Group("Compound_Flagstones")
    tile = 0.95
    nx = int(round(26.6 / tile))
    nz = int(round(20.6 / tile))
    step_x, step_z = 26.6 / nx, 20.6 / nz
    for j in range(nz):
        row_shift = (step_x * 0.5) if j % 2 else 0.0
        for i in range(-1, nx + 1):
            gx = -13.3 + (i + 0.5) * step_x + row_shift
            gz = -10.3 + (j + 0.5) * step_z
            if gx < -13.45 or gx > 13.45:
                continue
            if RNG.random() < 0.014:
                continue                      # a missing slab, bed shows through
            mat = M[FLOOR_BY_ROOM[room_at(gx, gz)]]
            if RNG.random() < 0.10:
                mat = M["M_FlagstoneAlt"] if mat is not M["M_FlagstoneAlt"] \
                    else M["M_Flagstone"]
            sink = 0.0 if RNG.random() < 0.55 else RNG.uniform(0.008, 0.026)
            bx, by, _ = g2b(gx, gz)
            # tight joints: the dark bed reads as mortar lines, not as gaps
            tiles.add(box((0, 0, 0),
                          (step_x * RNG.uniform(0.955, 0.995),
                           step_z * RNG.uniform(0.955, 0.995), 0.22),
                          matrix=rot(RNG.uniform(-0.3, 0.3),
                                     RNG.uniform(-0.3, 0.3),
                                     RNG.uniform(-0.9, 0.9),
                                     translate=(bx, by, -sink - 0.11))), mat)

    # a darker processional runner from the chapel door up to the objective
    for k in range(9):
        t = k / 8.0
        gx = 5.0 + (9.0 - 5.0) * t
        gz = 2.4 + (7.0 - 2.4) * t
        bx, by, _ = g2b(gx, gz)
        tiles.add(box((bx, by, -0.075), (1.25, 1.25, 0.16),
                      matrix=None), M["M_StoneTrim"])
    tiles.emit()

    cob = Group("Compound_Apron")
    c = 1.15
    for j in range(-13, 14):
        for i in range(-16, 17):
            gx = (i + 0.5) * c
            gz = (j + 0.5) * c
            if abs(gx) < 13.4 and abs(gz) < 10.4:
                continue
            if abs(gx) > 17.8 or abs(gz) > 14.8:
                continue
            # a solid paved band hugging the wall, fraying only at its edge
            edge = max(abs(gx) - 13.4, abs(gz) - 10.4)
            if edge > 1.9 and RNG.random() < min(0.9, (edge - 1.9) * 0.62):
                continue
            bx, by, _ = g2b(gx, gz)
            cob.add(box((0, 0, 0),
                        (c * RNG.uniform(0.93, 0.99),
                         c * RNG.uniform(0.93, 0.99), 0.20),
                        matrix=rot(0, 0, RNG.uniform(-2.0, 2.0),
                                   translate=(bx, by,
                                              -RNG.uniform(0.01, 0.05) - 0.10))),
                    M["M_Cobble"] if RNG.random() < 0.78
                    else M["M_FlagstoneAlt"])
    cob.emit()


# --------------------------------------------------------------------- walls

def stone_panel(g, seg, h_from=0.0, h_to=None, courses=STONE_COURSES,
                thickness=None, coping=True, mat=None, mat_alt=None):
    """Mortared masonry: a dark core with blocks laid in a running bond."""
    t = thickness if thickness is not None else THICKNESS["stone"]
    h_to = WALL_H if h_to is None else h_to
    height = h_to - h_from
    if height <= 0.01 or seg.length <= 0.02:
        return
    mat = mat or M["M_Stone"]
    mat_alt = mat_alt or M["M_StoneCool"]
    L = seg.length

    g.add(seg.box(0.0, 0.0, h_from + height / 2, L, t * 0.62, height),
          M["M_Mortar"])

    ch = height / courses
    for c in range(courses):
        z0 = h_from + c * ch
        top = coping and (c == courses - 1) and abs(h_to - WALL_H) < 1e-4
        if top:
            g.add(seg.box(0.0, 0.0, z0 + ch * 0.5, L, t * 1.08, ch * 0.98),
                  M["M_StoneTrim"])
            continue
        n = 2
        bond = 0.5 if c % 2 else 0.0
        for k in range(n + 1):
            u0 = -L / 2 + (k - bond) * (L / n)
            u1 = u0 + L / n
            u0, u1 = max(u0, -L / 2), min(u1, L / 2)
            w = u1 - u0
            if w < 0.09:
                continue
            g.add(seg.box((u0 + u1) / 2, RNG.uniform(-0.010, 0.010),
                          z0 + ch * 0.5,
                          w - 0.028, t * RNG.uniform(0.98, 1.05),
                          ch * RNG.uniform(0.91, 0.96)),
                  mat if RNG.random() < 0.72 else mat_alt)


def timber_panel(g, seg, h_from=0.0, h_to=None, thickness=None, brace=False):
    """A plank partition on a visible frame."""
    t = thickness if thickness is not None else THICKNESS["timber"]
    h_to = WALL_H if h_to is None else h_to
    height = h_to - h_from
    if height <= 0.01 or seg.length <= 0.02:
        return
    L = seg.length
    mid = h_from + height / 2

    g.add(seg.box(0.0, 0.0, mid, L, t * 0.42, height), M["M_TimberDark"])

    n = max(2, int(round(L / 0.27)))
    n = min(n, 5)
    pw = L / n
    for k in range(n):
        u = -L / 2 + (k + 0.5) * pw
        g.add(seg.box(u, 0.0, mid, pw - 0.028, t * RNG.uniform(0.94, 1.0),
                      height - 0.30),
              M["M_Timber"] if RNG.random() < 0.7 else M["M_TimberPale"])

    # top and bottom rails, proud of the planking so the frame reads
    for hz, hh in ((h_from + 0.10, 0.20), (h_to - 0.11, 0.22)):
        g.add(seg.box(0.0, 0.0, hz, L, t * 1.22, hh), M["M_TimberDark"])
    if brace:
        span = math.hypot(L, height - 0.34)
        ang = math.degrees(math.atan2(height - 0.34, L))
        g.add(seg.box(0.0, -t * 0.62, mid, span * 0.98, 0.10, 0.13,
                      tilt_u=-ang), M["M_TimberDark"])


def build_panels():
    """One OBJECT per destructible panel -- never joined, named for the game."""
    names = []
    for wall in LAYOUT["expanded"]:
        surf = wall["surface"]
        t = THICKNESS[surf]
        for si, span in enumerate(wall["spans"]):
            for pi, panel in enumerate(span["panels"]):
                name = "Panel_%s_%d_%d" % (wall["id"], si, pi)
                seg = Seg(panel["start"]["x"], panel["start"]["z"],
                          panel["end"]["x"], panel["end"]["z"])
                g = Group(name)
                if surf == "stone":
                    stone_panel(g, seg, thickness=t)
                else:
                    timber_panel(g, seg, thickness=t, brace=(pi % 4 == 1))
                ob = g.emit()
                if ob is None:
                    print("[build_compound] EMPTY PANEL %s" % name)
                    continue
                names.append(ob.name)
    return names


# ------------------------------------------------------------------ openings

def wall_inward(wall):
    """+1 if the segment normal points toward the compound centre, else -1."""
    seg = Seg(wall["x1"], wall["z1"], wall["x2"], wall["z2"])
    return 1.0 if (seg.nx * -seg.bx + seg.ny * -seg.by) > 0 else -1.0


def build_openings():
    """Frame every gap, and drop the barricade anchor the game spawns into."""
    frames, anchors = [], []
    for wall in LAYOUT["expanded"]:
        surf = wall["surface"]
        t = THICKNESS[surf]
        stone = surf == "stone"
        inward = wall_inward(wall)
        for o in wall["openings"]:
            seg = Seg(o["start"]["x"], o["start"]["z"],
                      o["end"]["x"], o["end"]["z"])
            w = seg.length
            gate = o["id"].startswith("gate")
            if o["kind"] == "door":
                ob = door_frame(o["id"], seg, w, t, stone, gate, inward)
            else:
                ob = window_frame(o["id"], seg, w, t, stone)
            if ob is not None:
                frames.append(ob.name)
            cx = (o["start"]["x"] + o["end"]["x"]) / 2
            cz = (o["start"]["z"] + o["end"]["z"]) / 2
            e = empty("Anchor_" + o["id"], g2b(cx, cz, 0.0), 0.4)
            anchors.append(e.name)
    return frames, anchors


def door_frame(oid, seg, w, t, stone, gate, inward):
    """Jambs + lintel around a full-height gap. Nothing intrudes into the gap."""
    g = Group("DoorFrame_" + oid)
    jw = 0.26
    jt = t * (1.22 if stone else 1.5)
    jamb = M["M_StoneTrim"] if stone else M["M_TimberDark"]
    off = w / 2 + jw / 2

    for s in (-1.0, 1.0):
        if stone:
            # quoined jamb: alternating block sizes up the full height
            n = 8
            for c in range(n):
                z0 = c * (WALL_H / n)
                wide = (c % 2 == 0)
                g.add(seg.box(s * off, 0.0, z0 + WALL_H / (2 * n),
                              jw * (1.0 if wide else 0.82),
                              jt * (1.0 if wide else 0.94),
                              WALL_H / n - 0.03), jamb)
        else:
            g.add(seg.box(s * off, 0.0, WALL_H / 2, jw, jt, WALL_H), jamb)
            g.add(seg.box(s * off, 0.0, 2.28, jw * 1.02, jt * 1.25, 0.12), jamb)

    # lintel across the head; kept in the top 0.18 m so it never fouls the
    # runtime barricade, which fills the gap to y = 3.3
    g.add(seg.box(0.0, 0.0, WALL_H - 0.09, w + 2 * jw + 0.26, jt * 1.06, 0.18),
          jamb)
    if stone:
        g.add(seg.box(0.0, 0.0, WALL_H - 0.24, 0.34, jt * 1.12, 0.20),
              M["M_StoneTrim"])       # keystone tucked under the lintel

    # threshold slab, flush with the floor
    g.add(seg.box(0.0, 0.0, -0.05, w + 0.36, t * 1.7, 0.10), M["M_StoneTrim"])

    if gate:
        # heavy leaves swung open flat against the inner face -- they sit
        # alongside the opening, never across it
        for s in (-1.0, 1.0):
            u = s * (w / 2 + jw + 0.44)
            v = inward * (t / 2 + 0.055)
            g.add(seg.box(u, v, 1.32, 0.86, 0.10, 2.55), M["M_Timber"])
            for hz in (0.45, 1.32, 2.19):
                g.add(seg.box(u, v + inward * 0.055, hz, 0.86, 0.035, 0.11),
                      M["M_Iron"])
            g.add(seg.box(u - s * 0.32, v + inward * 0.06, 1.32,
                          0.09, 0.05, 2.3), M["M_Iron"])
    return g.emit()


def window_frame(oid, seg, w, t, stone):
    """Sill + lintel, with masonry filling below the sill and above the head."""
    g = Group("WindowFrame_" + oid)
    trim = M["M_StoneTrim"] if stone else M["M_TimberDark"]

    stone_panel(g, seg, 0.0, WINDOW_SILL - 0.13, courses=2, thickness=t,
                coping=False)
    stone_panel(g, seg, WINDOW_HEAD + 0.22, WALL_H, courses=2, thickness=t,
                coping=True)

    g.add(seg.box(0.0, 0.0, WINDOW_SILL - 0.065, w + 0.46, t * 1.45, 0.13),
          trim)
    g.add(seg.box(0.0, 0.0, WINDOW_HEAD + 0.11, w + 0.46, t * 1.35, 0.22),
          trim)
    for s in (-1.0, 1.0):
        g.add(seg.box(s * (w / 2 + 0.09), 0.0,
                      (WINDOW_SILL + WINDOW_HEAD) / 2, 0.18, t * 1.15,
                      WINDOW_HEAD - WINDOW_SILL), trim)
    return g.emit()


# ---------------------------------------------------------------------- trim

def build_trim():
    """Corner towers and buttresses -- silhouette for the exterior curtain."""
    g = Group("Compound_Trim")
    t = THICKNESS["stone"]

    for gx, gz in ((-13, -10), (13, -10), (-13, 10), (13, 10)):
        s = Spot(gx, gz)
        for c in range(9):
            z0 = c * (4.15 / 9)
            wide = 1.0 if c % 2 == 0 else 0.92
            g.add(s.box(0, 0, z0 + 4.15 / 18, 1.02 * wide, 1.02 * wide,
                        4.15 / 9 - 0.03, yaw_deg=RNG.uniform(-1.5, 1.5)),
                  M["M_Stone"] if c % 3 else M["M_StoneCool"])
        g.add(s.box(0, 0, 4.24, 1.22, 1.22, 0.18), M["M_StoneTrim"])
        # crenellations on the tower cap
        for dx, dy in ((-0.4, -0.4), (0.4, -0.4), (-0.4, 0.4), (0.4, 0.4)):
            g.add(s.box(dx, dy, 4.55, 0.42, 0.42, 0.44), M["M_StoneTrim"])

    # buttresses on the outside face of the curtain, clear of every opening
    buttresses = [
        ("ext_s", (-10.5, -2.0, 9.5)),
        ("ext_n", (-11.0, -1.5, 10.5)),
        ("ext_w", (-7.5, 0.0, 7.5)),
        ("ext_e", (-7.5, 1.0, 8.5)),
    ]
    walls = {w["id"]: w for w in LAYOUT["expanded"]}
    for wid, offsets in buttresses:
        wall = walls[wid]
        seg = Seg(wall["x1"], wall["z1"], wall["x2"], wall["z2"])
        outward = -wall_inward(wall)
        for u in offsets:
            for c in range(6):
                z0 = c * (2.95 / 6)
                taper = 1.0 - c * 0.055
                g.add(seg.box(u, outward * (t / 2 + 0.28 * taper),
                              z0 + 2.95 / 12, 0.86,
                              0.56 * taper + t, 2.95 / 6 - 0.03),
                      M["M_Stone"])
            g.add(seg.box(u, outward * (t / 2 + 0.18), 3.05, 0.94,
                          0.46 + t, 0.22), M["M_StoneTrim"])
    return g.emit()


# ----------------------------------------------------------------- objective

def build_objective():
    """Stone plinth + tall hanging war banner. The heart of the compound."""
    o = LAYOUT["objective"]
    gx, gz = o["x"], o["z"]
    s = Spot(gx, gz, facing=-90.0)   # the banner faces south, toward the door
    g = Group("Objective_Banner")

    # marker kerb at the objective radius -- flat, never blocks a foot
    g.add(s.cyl(0, 0, -0.03, o["radius"] + 0.16, o["radius"] + 0.16, 0.07,
                seg=16), M["M_StoneTrim"])
    # stepped octagonal plinth
    for z0, z1, r0, r1, mat in ((0.0, 0.22, 1.02, 0.98, "M_Stone"),
                                (0.22, 0.44, 0.88, 0.84, "M_Stone"),
                                (0.44, 0.62, 0.74, 0.70, "M_StoneTrim")):
        g.add(s.cyl(0, 0, z0, r0, r1, z1 - z0, seg=8, yaw_deg=22.5), M[mat])
    # a carved band at the top of the plinth
    g.add(s.cyl(0, 0, 0.62, 0.60, 0.56, 0.16, seg=8, yaw_deg=22.5),
          M["M_Gold"])

    pole_base, pole_top = 0.72, 4.35
    g.add(s.cyl(0, 0, pole_base, 0.085, 0.062, pole_top - pole_base, seg=8),
          M["M_Timber"])
    for hz in (1.3, 2.5):
        g.add(s.cyl(0, 0, hz, 0.10, 0.10, 0.09, seg=8), M["M_Gold"])
    # crossbar the cloth hangs from
    g.add(s.box(0, 0, 3.92, 0.075, 1.62, 0.075), M["M_TimberDark"])
    for side in (-0.78, 0.78):
        g.add(s.box(0, side, 3.92, 0.11, 0.11, 0.11), M["M_Gold"])
        g.add(s.box(0, side * 0.96, 3.82, 0.055, 0.055, 0.20), M["M_Gold"])
    # spear finial
    g.add(s.cyl(0, 0, pole_top, 0.075, 0.0, 0.42, seg=8), M["M_Gold"])

    # hanging cloth: crimson field with a gold pale down the middle
    top_z, drop, width = 3.86, 2.42, 1.42
    ox, oy, _ = g2b(gx, gz)

    def cloth(scale, depth):
        def fn(u, v):
            taper = 1.0 if v < 0.84 else 1.0 - (v - 0.84) * 3.2
            across = (u - 0.5) * width * scale * max(taper, 0.10)
            billow = math.sin(u * math.pi * 2.0 + 0.7) * 0.055 * (0.3 + v)
            sag = math.sin(u * math.pi) * 0.05
            return (ox + across, oy + billow + depth, top_z - v * drop - sag)
        return fn

    # the cloth hangs clear in FRONT of the pole (+y here is game south, the
    # side the chapel door looks in from) so the pole never cuts through it
    g.add(sheet(cloth(1.0, 0.115), 8, 11, thickness=0.018), M["M_Crimson"])
    g.add(sheet(cloth(0.30, 0.142), 4, 11, thickness=0.014), M["M_Gold"])
    # a matching field on the far side so the banner reads from the north too
    g.add(sheet(cloth(1.0, -0.115), 8, 11, thickness=0.018), M["M_Crimson"])

    # four iron candle stands guarding the plinth
    for a in (35.0, 145.0, 215.0, 325.0):
        cs = Spot(gx + math.cos(math.radians(a)) * 1.5,
                  gz + math.sin(math.radians(a)) * 1.5)
        g.add(cs.cyl(0, 0, 0.0, 0.19, 0.13, 0.09, seg=8), M["M_IronDark"])
        g.add(cs.cyl(0, 0, 0.09, 0.045, 0.038, 1.02, seg=6), M["M_IronDark"])
        g.add(cs.cyl(0, 0, 1.11, 0.14, 0.10, 0.07, seg=8), M["M_IronDark"])
        g.add(cs.cyl(0, 0, 1.18, 0.045, 0.040, 0.20, seg=6), M["M_Wax"])
        g.add(cs.cyl(0, 0, 1.38, 0.030, 0.0, 0.11, seg=5), M["M_Flame"])
    return g.emit()


def build_chapel_trim():
    """A reredos arch behind the banner so the objective has a backdrop."""
    g = Group("Compound_ChapelTrim")
    for gx in (7.55, 10.45):
        s = Spot(gx, 9.35)
        for c in range(7):
            z0 = c * (3.35 / 7)
            g.add(s.box(0, 0, z0 + 3.35 / 14, 0.46 if c % 2 else 0.52,
                        0.42, 3.35 / 7 - 0.03), M["M_StoneCool"])
        g.add(s.box(0, 0, 3.45, 0.62, 0.52, 0.20), M["M_StoneTrim"])
    # architrave + a stepped tympanum: reads as one solid pediment
    span = Spot(9.0, 9.35)
    g.add(span.box(0, 0, 3.68, 3.62, 0.46, 0.26), M["M_StoneTrim"])
    for k in range(4):
        w = 3.30 - k * 0.72
        g.add(span.box(0, 0, 3.90 + k * 0.20, w, 0.38, 0.20),
              M["M_StoneCool"] if k % 2 else M["M_Stone"])
    g.add(span.cyl(0, 0, 4.58, 0.17, 0.0, 0.36, seg=6), M["M_Gold"])
    # hanging wall banners either side
    for gx, mat in ((5.6, "M_Azure"), (12.4, "M_Crimson")):
        bx, by, _ = g2b(gx, 9.68)
        g.add(box((bx, by, 3.18), (0.9, 0.09, 0.09)), M["M_TimberDark"])

        def fn(u, v, _x=bx, _y=by):
            return (_x + (u - 0.5) * 0.82,
                    _y + 0.06 + math.sin(v * 3.0) * 0.02,
                    3.12 - v * 2.05)
        g.add(sheet(fn, 4, 6, thickness=0.014), M[mat])
    return g.emit()


# ------------------------------------------------------------------ dressing

BRAZIERS = []


def brazier(g, gx, gz, scale=1.0):
    """Stone stand + bowl. Emits the Light_Brazier empty the game lights."""
    s = Spot(gx, gz, RNG.uniform(0, 90))
    base_h, col_h, bowl_h = 0.24 * scale, 0.82 * scale, 0.34 * scale
    g.add(s.box(0, 0, base_h / 2, 0.86 * scale, 0.86 * scale, base_h),
          M["M_StoneCool"])
    g.add(s.cyl(0, 0, base_h, 0.30 * scale, 0.25 * scale, col_h, seg=8),
          M["M_StoneCool"])
    bz = base_h + col_h
    g.add(s.cyl(0, 0, bz, 0.30 * scale, 0.52 * scale, bowl_h, seg=10),
          M["M_StoneCool"])
    g.add(s.cyl(0, 0, bz + bowl_h * 0.72, 0.36 * scale, 0.44 * scale,
                0.08, seg=10), M["M_Charcoal"])
    for k in range(4):
        a = 22.0 + k * 47.0 + RNG.uniform(-14.0, 14.0)
        d = RNG.uniform(0.0, 0.10) * scale
        g.add(s.box(math.cos(math.radians(a)) * d,
                    math.sin(math.radians(a)) * d,
                    bz + bowl_h * 0.80 + k * 0.045,
                    0.34 * scale, 0.065, 0.065, yaw_deg=a),
              M["M_Ember"] if k % 2 else M["M_Charcoal"])
    name = "Light_Brazier_%02d" % len(BRAZIERS)
    empty(name, g2b(gx, gz, bz + bowl_h + 0.18 * scale), 0.35)
    BRAZIERS.append(name)


def crate(g, gx, gz, size=0.72, h=0.0, facing=None):
    s = Spot(gx, gz, RNG.uniform(0, 360) if facing is None else facing)
    g.add(s.box(0, 0, h + size / 2, size, size * RNG.uniform(0.9, 1.05), size),
          M["M_Timber"])
    for z in (h + size * 0.22, h + size * 0.78):
        g.add(s.box(0, 0, z, size * 1.03, size * 1.06, 0.07), M["M_TimberDark"])


def barrel(g, gx, gz, r=0.28, h=0.82, tipped=False):
    s = Spot(gx, gz, RNG.uniform(0, 360))
    if tipped:
        g.add(s.cyl(0, 0, r, r, r, h, seg=10, tilt_u=90.0), M["M_Timber"])
        return
    g.add(s.cyl(0, 0, 0.0, r * 0.92, r * 0.92, h, seg=10), M["M_Timber"])
    for z in (h * 0.18, h * 0.80):
        g.add(s.cyl(0, 0, z, r, r, 0.06, seg=10), M["M_IronDark"])


def sack(g, gx, gz, h=0.0):
    s = Spot(gx, gz, RNG.uniform(0, 360))
    g.add(s.dome(0, 0, h, RNG.uniform(0.26, 0.34), RNG.uniform(0.22, 0.30),
                 RNG.uniform(0.30, 0.42), rings=3, seg=8), M["M_Sack"])


def straw(g, gx, gz, r=0.9):
    s = Spot(gx, gz)
    for _ in range(5):
        a = RNG.uniform(0, TAU)
        d = RNG.uniform(0.0, r * 0.6)
        g.add(s.box(math.cos(a) * d, math.sin(a) * d,
                    RNG.uniform(0.14, 0.26),
                    RNG.uniform(0.45, 0.85), RNG.uniform(0.35, 0.7),
                    RNG.uniform(0.16, 0.32),
                    yaw_deg=RNG.uniform(0, 180),
                    tilt_u=RNG.uniform(-7, 7),
                    tilt_v=RNG.uniform(-7, 7)), M["M_Straw"])


def weapon_rack(g, gx, gz, facing=0.0, n=5):
    s = Spot(gx, gz, facing)
    for side in (-0.82, 0.82):
        g.add(s.box(0, side, 0.78, 0.13, 0.13, 1.56), M["M_TimberDark"])
    for z in (0.58, 1.36):
        g.add(s.box(0, 0, z, 0.10, 1.78, 0.10), M["M_TimberDark"])
    for k in range(n):
        v = (k - (n - 1) / 2.0) * 0.34 + RNG.uniform(-0.03, 0.03)
        length = RNG.uniform(1.85, 2.25)
        tilt = RNG.uniform(-5.0, 5.0)
        g.add(s.box(0, v, length / 2, 0.055, 0.055, length, tilt_v=tilt),
              M["M_Timber"])
        g.add(s.box(0, v, length + 0.16, 0.045, 0.11, 0.32, tilt_v=tilt),
              M["M_Iron"])


def shield_stack(g, gx, gz, facing=0.0, n=3):
    s = Spot(gx, gz, facing)
    for k in range(n):
        u, v = 0.10 + k * 0.07, (k - 1) * 0.12
        g.add(s.cyl(u, v, 0.44, 0.40, 0.38, 0.07, seg=10, tilt_u=78.0),
              M["M_Timber"] if k % 2 else M["M_TimberPale"])
        g.add(s.cyl(u - 0.02, v, 0.44, 0.42, 0.42, 0.03, seg=10, tilt_u=78.0),
              M["M_Iron"])                       # rim
        g.add(s.cyl(u - 0.06, v, 0.44, 0.10, 0.07, 0.07, seg=8, tilt_u=78.0),
              M["M_Iron"])                       # boss


def bunk(g, gx, gz, facing=0.0):
    s = Spot(gx, gz, facing)
    for du, dv in ((-0.92, -0.42), (0.92, -0.42), (-0.92, 0.42), (0.92, 0.42)):
        g.add(s.box(du, dv, 0.86, 0.11, 0.11, 1.72), M["M_TimberDark"])
    for z in (0.40, 1.16):
        g.add(s.box(0, 0, z, 1.92, 0.90, 0.09), M["M_Timber"])
        g.add(s.box(0, 0, z + 0.13, 1.70, 0.76, 0.17), M["M_Straw"])
        g.add(s.box(-0.72, 0, z + 0.22, 0.42, 0.52, 0.16), M["M_Sack"])


def bench(g, gx, gz, facing=0.0, length=2.2):
    """`facing` is the way a sitter looks; the seat runs across that."""
    s = Spot(gx, gz, facing)
    g.add(s.box(0, 0, 0.44, 0.42, length, 0.09), M["M_Timber"])
    for v in (-length / 2 + 0.24, length / 2 - 0.24):
        g.add(s.box(0, v, 0.22, 0.38, 0.10, 0.44), M["M_TimberDark"])
    g.add(s.box(-0.21, 0, 0.76, 0.07, length, 0.32), M["M_Timber"])


def candle_stand(g, gx, gz, h=1.15):
    s = Spot(gx, gz, RNG.uniform(0, 90))
    g.add(s.cyl(0, 0, 0.0, 0.20, 0.13, 0.08, seg=8), M["M_IronDark"])
    g.add(s.cyl(0, 0, 0.08, 0.040, 0.034, h - 0.08, seg=6), M["M_IronDark"])
    g.add(s.cyl(0, 0, h, 0.13, 0.09, 0.06, seg=8), M["M_IronDark"])
    for k, (du, dv) in enumerate(((0.0, 0.0), (0.09, 0.05), (-0.08, 0.06))):
        top = h + 0.06 + RNG.uniform(0.0, 0.06)
        g.add(s.cyl(du, dv, h + 0.06, 0.035, 0.030, top - h + 0.10, seg=5),
              M["M_Wax"])
        g.add(s.cyl(du, dv, top + 0.10, 0.024, 0.0, 0.09, seg=5), M["M_Flame"])


def well(g, gx, gz):
    s = Spot(gx, gz, 12.0)
    r = 0.72
    g.add(s.cyl(0, 0, 0.0, r, r * 0.98, 0.74, seg=10), M["M_StoneCool"])
    g.add(s.cyl(0, 0, 0.74, r * 1.06, r * 1.02, 0.11, seg=10), M["M_StoneTrim"])
    g.add(s.cyl(0, 0, 0.55, r * 0.74, r * 0.74, 0.12, seg=10), M["M_Charcoal"])
    for side in (-1.0, 1.0):
        g.add(s.box(0, side * (r - 0.06), 1.42, 0.13, 0.13, 1.44),
              M["M_TimberDark"])
    g.add(s.box(0, 0, 2.06, 0.10, 1.40, 0.10), M["M_Timber"])
    g.add(s.cyl(0, 0, 1.98, 0.09, 0.09, 0.9, seg=8, tilt_u=90.0),
          M["M_Timber"])
    # little gable canopy, low enough for the camera to see over
    for side, tilt in ((-0.35, 26.0), (0.35, -26.0)):
        g.add(s.box(0, side, 2.30, 1.15, 0.86, 0.09, tilt_u=0.0, tilt_v=tilt),
              M["M_TimberPale"])
    g.add(s.box(0, 0, 0.98, 0.26, 0.26, 0.30), M["M_Iron"])  # hanging bucket


def anvil(g, gx, gz, facing=0.0):
    s = Spot(gx, gz, facing)
    g.add(s.cyl(0, 0, 0.0, 0.34, 0.30, 0.52, seg=8), M["M_TimberDark"])
    g.add(s.box(0, 0, 0.60, 0.34, 0.72, 0.16), M["M_Iron"])
    g.add(s.box(0, 0, 0.74, 0.22, 0.46, 0.14), M["M_Iron"])
    g.add(s.box(0, 0.46, 0.66, 0.16, 0.30, 0.12), M["M_Iron"])


def altar(g, gx, gz, facing=0.0):
    s = Spot(gx, gz, facing)
    g.add(s.box(0, 0, 0.42, 0.78, 1.7, 0.84), M["M_StoneCool"])
    g.add(s.box(0, 0, 0.90, 0.94, 1.9, 0.12), M["M_StoneTrim"])
    g.add(s.box(0, 0, 1.00, 0.60, 1.5, 0.08), M["M_Crimson"])
    g.add(s.cyl(0, 0, 1.04, 0.10, 0.08, 0.34, seg=8), M["M_Gold"])
    g.add(s.box(0, 0, 1.52, 0.06, 0.06, 0.62), M["M_Gold"])
    g.add(s.box(0, 0, 1.66, 0.06, 0.42, 0.06), M["M_Gold"])


def cart(g, gx, gz, facing=0.0):
    s = Spot(gx, gz, facing)
    g.add(s.box(0, 0, 0.72, 2.3, 1.15, 0.16), M["M_Timber"])
    for side in (-1.0, 1.0):
        g.add(s.box(0, side * 0.58, 0.92, 2.2, 0.09, 0.34), M["M_Timber"])
        # wheels stand ON the floor -- the disc is centred at its own radius
        g.add(s.cyl(0.7, side * 0.66, 0.54, 0.52, 0.52, 0.11, seg=10,
                    tilt_u=90.0), M["M_TimberDark"])
    g.add(s.box(-1.5, 0, 0.55, 1.1, 0.12, 0.12, tilt_u=-12.0), M["M_Timber"])


def build_dressing():
    """Props hug the walls and stay out of every doorway and walking line.

    Placements are audited against the layout: nothing overlaps a door gap or
    its 1.6 m approach, nothing over 0.95 m (a window sill) sits in a window's
    landing zone, and nothing intersects a wall line or another prop.
    """
    g = Group("Compound_Dressing")

    # ---- BARRACKS  x -13..-1, z -10..-2 ---------------------------------
    for gz in (-8.5, -7.1, -5.7):
        bunk(g, -11.7, gz, facing=0.0)
    for gz in (-8.5, -7.1):
        bunk(g, -3.0, gz, facing=180.0)
    straw(g, -8.8, -8.9, r=0.8)
    crate(g, -10.2, -8.9, 0.60)
    brazier(g, -2.0, -5.0)
    crate(g, -12.2, -2.6, 0.62)
    crate(g, -6.5, -2.6, 0.70)
    crate(g, -5.55, -2.55, 0.58)
    barrel(g, -4.6, -2.6)
    sack(g, -3.7, -2.6)
    sack(g, -3.1, -2.5)

    # ---- STORES  x -1..13, z -10..-2 ------------------------------------
    for k, gx in enumerate((0.2, 1.35, 6.4, 7.55, 8.7, 9.85)):
        crate(g, gx, -9.15, 0.78)
        if k % 2 == 0:
            crate(g, gx + 0.04, -9.1, 0.60, h=0.78)
    for gz in (-8.6, -7.7, -6.8):
        barrel(g, 12.15, gz)
    for gz in (-8.15, -7.25):
        barrel(g, 11.45, gz, r=0.26, h=0.74)
    for gx, gz in ((0.0, -6.3), (0.55, -5.6), (-0.3, -5.3), (0.2, -7.2)):
        sack(g, gx, gz)
    for gx, gz in ((0.1, -3.1), (1.05, -3.2), (2.0, -3.05)):
        crate(g, gx, gz, 0.66)
    barrel(g, 6.2, -3.15, tipped=True)
    crate(g, 8.4, -3.2, 0.74)
    crate(g, 9.35, -3.15, 0.60)
    brazier(g, 2.7, -9.0)
    sack(g, 4.75, -8.85)
    sack(g, 5.45, -9.05)

    # ---- CENTRAL HALL  x -13..13, z -2..2 -------------------------------
    # the well hugs the north wall so the spine stays ~2 m clear end to end
    well(g, -0.2, 0.95)
    brazier(g, -11.9, 0.0)
    brazier(g, 11.9, 0.0)
    bench(g, -5.0, 1.35, facing=-90.0, length=2.4)
    bench(g, -2.6, -1.45, facing=90.0, length=2.0)
    bench(g, 8.6, 1.35, facing=-90.0, length=2.4)
    crate(g, 1.5, 1.25, 0.66)
    barrel(g, 2.4, 1.35)
    barrel(g, -6.0, -1.50, r=0.27, h=0.78)
    straw(g, 6.4, -1.05, r=0.6)

    # ---- ARMOURY  x -13..1, z 2..10 -------------------------------------
    for gx in (-11.9, -9.9, -4.4, -2.4):
        weapon_rack(g, gx, 9.15, facing=-90.0)
    weapon_rack(g, -12.15, 6.6, facing=0.0)
    shield_stack(g, -0.1, 9.15, facing=-90.0)
    shield_stack(g, -12.25, 5.2, facing=0.0)
    anvil(g, -11.6, 3.6, facing=40.0)
    brazier(g, -10.6, 3.0, scale=1.05)       # the forge
    barrel(g, -12.4, 2.70, r=0.28, h=0.82)
    crate(g, -5.6, 2.70, 0.68)
    crate(g, -4.6, 2.65, 0.58)
    barrel(g, -3.75, 2.65)
    for gz in (7.9, 8.6):
        barrel(g, -12.3, gz, r=0.27, h=0.80)
    straw(g, -3.0, 4.6, r=0.7)
    sack(g, -6.4, 2.65)

    # ---- CHAPEL  x 1..13, z 2..10 ---------------------------------------
    # the nave benches leave the aisle from d_chapel (5,2) to d_screen (8,6)
    # clear, and stop short of the d_north_link approach
    for gz in (3.2, 4.1):
        bench(g, 2.7, gz, facing=90.0, length=2.0)   # nave, west of the aisle
    for gz in (3.2, 4.1, 5.0, 5.6):
        bench(g, 10.3, gz, facing=90.0, length=2.0)  # nave, east of the aisle
    altar(g, 12.0, 8.3, facing=180.0)
    candle_stand(g, 1.35, 3.0)
    candle_stand(g, 1.35, 4.3)
    candle_stand(g, 12.5, 3.0)
    candle_stand(g, 12.5, 7.0, h=1.30)
    candle_stand(g, 6.6, 7.9, h=1.35)
    candle_stand(g, 11.3, 7.2, h=1.25)
    brazier(g, 5.4, 7.4)
    brazier(g, 3.4, 8.6)
    brazier(g, 8.6, 3.0)
    crate(g, 2.2, 8.4, 0.60)
    sack(g, 2.8, 7.7)

    # ---- OUTSIDE  (kept off the gate approaches) ------------------------
    brazier(g, -8.1, -11.4)
    brazier(g, -3.9, -11.4)
    brazier(g, 15.2, -2.0)
    crate(g, -11.4, -11.6, 0.74)
    crate(g, -11.6, -12.6, 0.62)
    barrel(g, -10.4, -11.7)
    cart(g, 8.4, -12.4, facing=15.0)
    cart(g, -15.2, 7.6, facing=90.0)
    for gx, gz in ((14.6, -7.4), (15.6, -8.4), (-14.9, 4.6)):
        crate(g, gx, gz, 0.70)
    straw(g, 12.0, -12.0)
    return g.emit()


# ------------------------------------------------------------------- export

def output_path():
    out = os.path.normpath(os.path.join(here(), "..", "public", "models"))
    os.makedirs(out, exist_ok=True)
    return os.path.join(out, "compound.glb")


def export_glb(path):
    kwargs = {
        "filepath": path, "export_format": "GLB", "use_selection": False,
        "export_apply": True, "export_yup": True, "export_materials": "EXPORT",
        "export_cameras": False, "export_lights": False,
        "export_animations": False, "export_skins": False,
        "export_morph": False, "export_normals": True,
        "export_texcoords": False, "export_extras": False,
    }
    while True:
        try:
            bpy.ops.export_scene.gltf(**kwargs)
            return
        except TypeError as exc:
            msg = str(exc)
            drop = next((k for k in list(kwargs)
                         if k not in ("filepath", "export_format")
                         and k in msg), None)
            if drop is None:
                if len(kwargs) > 2:
                    kwargs = {"filepath": path, "export_format": "GLB"}
                    continue
                raise
            print("[build_compound] dropping export kwarg: %s" % drop)
            kwargs.pop(drop)


def triangle_count():
    total = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        ev = obj.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        total += len(me.loop_triangles)
        ev.to_mesh_clear()
    return total


# -------------------------------------------------------------------- verify

def glb_nodes(path):
    with open(path, "rb") as fh:
        data = fh.read()
    magic, _ver, total = struct.unpack("<III", data[:12])
    assert magic == 0x46546C67, "not a GLB"
    off, js = 12, None
    while off < total:
        clen, ctype = struct.unpack("<II", data[off:off + 8])
        if ctype == 0x4E4F534A:
            js = json.loads(data[off + 8:off + 8 + clen])
            break
        off += 8 + clen
    assert js is not None, "no JSON chunk"
    return js


def verify(path):
    """Assert the exported GLB carries every node the game looks up by name."""
    gltf = glb_nodes(path)
    names = [n.get("name", "") for n in gltf.get("nodes", [])]
    seen = {}
    for n in names:
        seen[n] = seen.get(n, 0) + 1

    expected_panels, expected_anchors = [], []
    for wall in LAYOUT["expanded"]:
        for si, span in enumerate(wall["spans"]):
            for pi, _panel in enumerate(span["panels"]):
                expected_panels.append("Panel_%s_%d_%d" % (wall["id"], si, pi))
        for o in wall["openings"]:
            expected_anchors.append("Anchor_" + o["id"])

    problems = []
    for want in expected_panels + expected_anchors + ["Objective_Banner"]:
        c = seen.get(want, 0)
        if c != 1:
            problems.append("%s -> %d" % (want, c))
    extra = [n for n in names
             if n.startswith("Panel_") and n not in set(expected_panels)]
    for n in sorted(set(extra)):
        problems.append("unexpected panel %s" % n)

    # Coordinate-mapping check. The exporter turns Blender Z-up into glTF Y-up,
    # and because we author blender = (game_x, -game_z, h) the exported x/z axes
    # land back on GAME x/z exactly. So the banner must sit at (9.0, 8.2).
    obj_node = next((n for n in gltf["nodes"]
                     if n.get("name") == "Objective_Banner"), None)
    if obj_node is None or "mesh" not in obj_node:
        problems.append("Objective_Banner carries no mesh")
    else:
        lo = [1e9, 1e9, 1e9]
        hi = [-1e9, -1e9, -1e9]
        for prim in gltf["meshes"][obj_node["mesh"]]["primitives"]:
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            for k in range(3):
                lo[k] = min(lo[k], acc["min"][k])
                hi[k] = max(hi[k], acc["max"][k])
        cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
        want = LAYOUT["objective"]
        print("[verify] Objective_Banner centre (game x, z) = (%.2f, %.2f), "
              "want (%.2f, %.2f); height %.2f..%.2f"
              % (cx, cz, want["x"], want["z"], lo[1], hi[1]))
        if abs(cx - want["x"]) > 0.35 or abs(cz - want["z"]) > 0.35:
            problems.append("Objective_Banner is at (%.2f, %.2f), expected "
                            "(%.2f, %.2f) -- coordinate mapping is wrong"
                            % (cx, cz, want["x"], want["z"]))

    tri = 0
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            if "indices" in prim:
                tri += gltf["accessors"][prim["indices"]]["count"] // 3
            else:
                tri += gltf["accessors"][
                    prim["attributes"]["POSITION"]]["count"] // 3

    print("[verify] nodes: %d   meshes: %d   triangles: %d"
          % (len(names), len(gltf.get("meshes", [])), tri))
    print("[verify] panels expected %d, found %d"
          % (len(expected_panels),
             sum(1 for n in names if n.startswith("Panel_"))))
    print("[verify] anchors expected %d, found %d"
          % (len(expected_anchors),
             sum(1 for n in names if n.startswith("Anchor_"))))
    print("[verify] door frames %d, window frames %d, braziers %d"
          % (sum(1 for n in names if n.startswith("DoorFrame_")),
             sum(1 for n in names if n.startswith("WindowFrame_")),
             sum(1 for n in names if n.startswith("Light_Brazier_"))))
    if problems:
        print("[verify] FAILED (%d):" % len(problems))
        for p in problems[:40]:
            print("   ", p)
    else:
        print("[verify] OK - every expected node present exactly once")
    return not problems


# ---------------------------------------------------------------------- main

def main():
    RNG.seed(SEED)
    random.seed(SEED)
    clean_scene()
    build_materials()

    build_ground()
    build_floor()
    panels = build_panels()
    frames, anchors = build_openings()
    build_trim()
    build_objective()
    build_chapel_trim()
    build_dressing()

    bpy.context.view_layer.update()

    tris = triangle_count()
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    print("[build_compound] objects: %d mesh, %d empties"
          % (len(objs), len(bpy.context.scene.objects) - len(objs)))
    print("[build_compound] panels: %d   frames: %d   anchors: %d   braziers: %d"
          % (len(panels), len(frames), len(anchors), len(BRAZIERS)))
    print("[build_compound] triangles: %d" % tris)
    if tris > 90000:
        print("[build_compound] WARNING: triangle budget exceeded "
              "(%d > 90000)" % tris)

    path = output_path()
    export_glb(path)
    print("[build_compound] wrote %s (%.1f KB)"
          % (path, os.path.getsize(path) / 1024.0))
    ok = verify(path)
    if not ok:
        print("[build_compound] VERIFICATION FAILED")


if __name__ == "__main__":
    main()
    if bpy.app.background:
        sys.stdout.flush()
