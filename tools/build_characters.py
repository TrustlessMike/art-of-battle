"""Procedurally build the two duellists and their weapons, export as GLB.

    blender --background --python tools/build_characters.py

Writes public/models/knight_warden.glb, knight_raider.glb,
weapon_longsword.glb, weapon_daneaxe.glb.

See ASSET_CONTRACT.md for the joint hierarchy the game depends on.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector, Matrix  # noqa: E402

from rigkit import (  # noqa: E402
    TAU, Part, box, cylinder, dome, export_glb, frustum, joint, loft, material,
    mirror_x, plate, reset_scene, ring, rot, sheet, shell_band, tube,
)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "public", "models")


# ------------------------------------------------------------------ palettes

def palette(spec):
    return {
        "steel":  material(f"{spec}_steel", (0.60, 0.63, 0.69), 1.0, 0.34),
        "dark":   material(f"{spec}_dark", (0.17, 0.18, 0.21), 1.0, 0.52),
        "mail":   material(f"{spec}_mail", (0.20, 0.21, 0.25), 0.95, 0.60),
        "black":  material(f"{spec}_black", (0.03, 0.03, 0.04), 0.2, 0.7),
        "gold":   material(f"{spec}_gold", (0.83, 0.64, 0.24), 1.0, 0.28),
        "leather": material(f"{spec}_leather", (0.042, 0.022, 0.011), 0.0, 0.82),
        "hide":   material(f"{spec}_hide", (0.098, 0.052, 0.025), 0.0, 0.85),
        "fur":    material(f"{spec}_fur", (0.115, 0.096, 0.068), 0.0, 0.95),
        "furdark": material(f"{spec}_furdark", (0.026, 0.021, 0.016), 0.0, 0.97),
        "bone":   material(f"{spec}_bone", (0.58, 0.52, 0.38), 0.0, 0.62),
        "skin":   material(f"{spec}_skin", (0.38, 0.19, 0.115), 0.0, 0.7),
        "hair":   material(f"{spec}_hair", (0.135, 0.052, 0.020), 0.0, 0.85),
        "wood":   material(f"{spec}_wood", (0.107, 0.055, 0.022), 0.0, 0.78),
    }


# Every fighter is described by the same feature vector; the builders below
# branch on these keys so all six variants share one construction.
DEFAULTS = dict(
    accent=(0.09, 0.16, 0.44),
    build=1.0,
    torso="plate",       # plate | mail | lamellar | harness
    arms="plate",        # plate | mail | bare | leather
    legs="plate",        # plate | mail | leather
    helm="great",        # great | open | horned | masked | none
    pauldron="layered",  # layered | heavy | spaulder | fur | none
    tassets="strips",    # full | strips | none
    mantle="none",       # fur | heavy | none
    crest=1.0,
    cloak=False,
    surcoat=True,
    paint=False,
)


def spec(key, **kw):
    s = dict(DEFAULTS, key=key)
    s.update(kw)
    return s


WARDEN = spec(
    "warden", accent=(0.030, 0.055, 0.230),   # Iron Legion blue
    cloak=True,
)

WARDEN_HEAVY = spec(
    "warden_heavy", accent=(0.024, 0.045, 0.200),
    cloak=True, build=1.06, pauldron="heavy", tassets="full", crest=1.45,
)

WARDEN_LIGHT = spec(
    "warden_light", accent=(0.040, 0.075, 0.270),
    torso="mail", arms="mail", legs="mail", helm="open", pauldron="spaulder",
    tassets="none", build=0.94, crest=0.0,
)

RAIDER = spec(
    "raider", accent=(0.300, 0.026, 0.020),   # Warborn red
    torso="harness", arms="bare", legs="leather", helm="horned",
    pauldron="fur", tassets="strips", mantle="fur", build=1.05, crest=0.0,
    surcoat=False,
)

RAIDER_HEAVY = spec(
    "raider_heavy", accent=(0.240, 0.020, 0.016),
    torso="lamellar", arms="leather", legs="leather", helm="masked",
    pauldron="heavy", tassets="full", mantle="heavy", build=1.10, crest=0.0,
    surcoat=False,
)

RAIDER_LIGHT = spec(
    "raider_light", accent=(0.400, 0.035, 0.026),
    torso="bare", arms="bare", legs="leather", helm="none",
    pauldron="none", tassets="strips", mantle="none", build=1.00, crest=0.0,
    surcoat=False, paint=True,
)

ALL_SPECS = (WARDEN, WARDEN_HEAVY, WARDEN_LIGHT,
             RAIDER, RAIDER_HEAVY, RAIDER_LIGHT)


# ------------------------------------------------------------------ skeleton

def build_skeleton():
    root = joint("Root", (0, 0, 0))
    hips = joint("Hips", (0, 0, 0.98), root)
    torso = joint("Torso", (0, 0, 0), hips)
    head = joint("Head", (0, 0, 0.58), torso)
    cloak = joint("Cloak", (0, 0.10, 0.46), torso)

    j = dict(Root=root, Hips=hips, Torso=torso, Head=head, Cloak=cloak)
    for s, sign in (("L", 1), ("R", -1)):
        sh = joint(f"Shoulder{s}", (0.20 * sign, 0, 0.46), torso)
        el = joint(f"Elbow{s}", (0, 0, -0.29), sh)
        ha = joint(f"Hand{s}", (0, 0, -0.27), el)
        gr = joint(f"Grip{s}", (0, 0, -0.04), ha)
        hp = joint(f"Hip{s}", (0.11 * sign, 0, -0.04), hips)
        kn = joint(f"Knee{s}", (0, 0, -0.44), hp)
        ft = joint(f"Foot{s}", (0, 0, -0.44), kn)
        j.update({f"Shoulder{s}": sh, f"Elbow{s}": el, f"Hand{s}": ha,
                  f"Grip{s}": gr, f"Hip{s}": hp, f"Knee{s}": kn,
                  f"Foot{s}": ft})
    return j


# ------------------------------------------------------------------- body bits

# The cuirass is lofted from this profile: (z, half-x, half-y, keel). `keel` is
# how far the breastplate ridge juts forward of the ellipse at the centreline.
def _torso_profile(spec):
    b = spec["build"]
    return [
        (-0.125, 0.132 * b, 0.112, 0.006),
        (0.020, 0.145 * b, 0.126, 0.020),
        (0.140, 0.172 * b, 0.150, 0.038),
        (0.270, 0.194 * b, 0.170, 0.050),
        (0.380, 0.200 * b, 0.174, 0.045),
        (0.450, 0.190 * b, 0.160, 0.028),
        (0.508, 0.140 * b, 0.122, 0.008),
    ]


def _torso_pt(hx, hy, keel, a):
    """One plan-view point: an ellipse pulled forward into a keel at -Y."""
    ca, sa = math.cos(a), math.sin(a)
    f = max(0.0, -sa)
    return (ca * hx * (1.0 - 0.09 * f * f), sa * hy - keel * f ** 1.5)


def _torso_at(prof, z):
    if z <= prof[0][0]:
        return prof[0][1:]
    if z >= prof[-1][0]:
        return prof[-1][1:]
    for lo, hi in zip(prof, prof[1:]):
        if lo[0] <= z <= hi[0]:
            t = (z - lo[0]) / (hi[0] - lo[0])
            return tuple(lo[i + 1] + (hi[i + 1] - lo[i + 1]) * t
                         for i in range(3))
    return prof[-1][1:]


def _torso_ring(prof, z, segs=16, swell=1.0):
    hx, hy, keel = _torso_at(prof, z)
    return [_torso_pt(hx * swell, hy * swell, keel * swell, TAU * i / segs)
            for i in range(segs)]


def fur_radius(base, phase, amp=0.15, open_front=0.0):
    """Deterministic lumpy radius — reads as fur clumps rather than beads.

    `open_front` pulls the mantle back off the chest so it rides the shoulders.
    """
    def f(a):
        front = max(0.0, -math.sin(a)) ** 0.8
        return base * (1.0 - open_front * front) * (
            1.0 + amp * math.sin(5 * a + phase)
            + 0.55 * amp * math.sin(9 * a + 2.1 - phase)
            + 0.30 * amp * math.sin(17 * a + 0.7))
    return f


def add_mantle(p, P, spec, heavy=False):
    b = spec["build"]
    k = 1.10 if heavy else 1.0
    secs = ((0.278, 0.222, 0.0), (0.348, 0.268, 0.6), (0.416, 0.284, 1.2),
            (0.472, 0.252, 1.8), (0.516, 0.170, 2.4))
    p.add(loft([(z, ring(30, fur_radius(r * b * k, ph, 0.15, 0.34),
                         squash=0.88)) for z, r, ph in secs]),
          P["fur"], bevel=False)
    p.add(loft([(0.262, ring(24, fur_radius(0.192 * b * k, 1.4, 0.13, 0.30),
                             squash=0.90)),
                (0.330, ring(24, fur_radius(0.216 * b * k, 1.4, 0.13, 0.32),
                             squash=0.90))]), P["furdark"], bevel=False)
    if heavy:
        # a second, longer layer of pelt falling over the back and shoulders
        p.add(loft([(0.070, ring(26, fur_radius(0.196 * b, 2.9, 0.17, 0.46),
                                 squash=0.92)),
                    (0.190, ring(26, fur_radius(0.228 * b, 2.4, 0.17, 0.42),
                                 squash=0.92)),
                    (0.320, ring(26, fur_radius(0.244 * b, 1.9, 0.17, 0.38),
                                 squash=0.92))]), P["furdark"], bevel=False)


def build_torso(spec, P, accent):
    p = Part("M_Torso")
    b = spec["build"]
    kind = spec["torso"]
    acc = material(f"{spec['key']}_accent", accent, 0.0, 0.55)
    prof = _torso_profile(spec)
    shell = {"plate": P["steel"], "mail": P["mail"], "lamellar": P["dark"],
             "harness": P["hide"], "bare": P["skin"]}[kind]

    p.add(loft([(z, _torso_ring(prof, z, segs=20)) for z, *_ in prof]), shell)

    # gorget shelf rising out of the cuirass, then the mail-covered neck
    gorget = P["leather"] if kind == "bare" else P["dark"]
    p.add(loft([(0.455, ring(16, 0.150 * b, squash=0.76)),
                (0.508, ring(16, 0.133 * b, squash=0.79)),
                (0.548, ring(16, 0.112 * b, squash=0.83))]), gorget)
    p.add(cylinder(0.505, 0.616, 0.075, 0.068, segments=12),
          P["skin"] if kind == "bare" else P["mail"])

    if kind == "plate":
        # overlapping lames stepping down the belly
        for z0, z1, s0, s1 in ((0.075, 0.125, 1.05, 1.015),
                               (0.005, 0.058, 1.07, 1.03),
                               (-0.062, -0.008, 1.09, 1.05)):
            p.add(loft([(z0, _torso_ring(prof, z0, segs=20, swell=s0)),
                        (z1, _torso_ring(prof, z1, segs=20, swell=s1))]),
                  P["dark"])
        # riveted seam either side of the breastplate keel
        for s in (1, -1):
            for k in range(9):
                t = k / 8
                z = 0.10 + 0.30 * t
                hx, hy, keel = _torso_at(prof, z)
                x, y = _torso_pt(hx * 1.03, hy * 1.03, keel * 1.06,
                                 math.radians(270 + 30 * s))
                p.add(dome((x, y, z), (0.013, 0.013, 0.013), rings=2,
                           segments=6, hemi=False), P["gold"])
    elif kind == "mail":
        # hauberk: rows of mail over a quilted gambeson
        for k in range(13):
            z0 = -0.115 + k * 0.049
            p.add(loft([(z0, _torso_ring(prof, z0, segs=20, swell=1.035)),
                        (z0 + 0.036,
                         _torso_ring(prof, z0 + 0.036, segs=20, swell=1.06))]),
                  P["mail"], bevel=False)
        # a light plate placard over the chest keeps it from reading as a sack
        p.add(loft([(0.190, _torso_ring(prof, 0.190, segs=20, swell=1.09)),
                    (0.300, _torso_ring(prof, 0.300, segs=20, swell=1.10)),
                    (0.380, _torso_ring(prof, 0.380, segs=20, swell=1.07))]),
              P["leather"])
    elif kind == "lamellar":
        # rows of overlapping scales laced across the cuirass
        for row in range(9):
            z = -0.09 + row * 0.062
            hx, hy, keel = _torso_at(prof, z)
            for i in range(18):
                a = TAU * (i + 0.5 * (row % 2)) / 18
                x, y = _torso_pt(hx * 1.03, hy * 1.03, keel * 1.05, a)
                m = (Matrix.Translation(Vector((x, y, z)))
                     @ Matrix.Rotation(a - math.pi / 2, 4, 'Z')
                     @ Matrix.Rotation(math.radians(-8), 4, 'X'))
                p.add(plate([(-0.030, 0.038), (0.030, 0.038),
                             (0.026, -0.040), (-0.026, -0.040)], 0.016,
                            matrix=m),
                      P["steel"] if row % 3 else P["dark"])
    else:                                    # harness: straps over hide/skin
        if kind == "harness":
            # leather jerkin: a laced chest panel with studded edges
            p.add(loft([(0.030, _torso_ring(prof, 0.030, segs=20, swell=1.04)),
                        (0.180, _torso_ring(prof, 0.180, segs=20, swell=1.06)),
                        (0.320, _torso_ring(prof, 0.320, segs=20, swell=1.05)),
                        (0.400, _torso_ring(prof, 0.400, segs=20,
                                            swell=1.02))]), P["leather"])
            for k in range(7):
                z = 0.070 + k * 0.048
                hx, hy, keel = _torso_at(prof, z)
                for s2 in (1, -1):
                    x, y = _torso_pt(hx * 1.09, hy * 1.09, keel * 1.10,
                                     math.radians(270 + 22 * s2))
                    p.add(dome((x, y, z), (0.014, 0.014, 0.014), rings=2,
                               segments=6, hemi=False), P["dark"])
        else:
            # bare chest: pectoral and abdominal shaping
            for s2 in (1, -1):
                p.add(dome((0.072 * s2, -0.104, 0.300),
                           (0.104, 0.096, 0.052), rings=4, segments=12),
                      P["skin"])
        baldric = [(-0.030, -0.09), (0.030, -0.062), (0.148, 0.398),
                   (0.088, 0.424)]
        p.add(plate(baldric, 0.045, matrix=rot(translate=(0, -0.158, 0))),
              P["leather"])
        p.add(plate(baldric, 0.045,
                    matrix=mirror_x() @ rot(translate=(0, 0.152, 0))),
              P["leather"])
        p.add(loft([(-0.055, _torso_ring(prof, -0.055, segs=20, swell=1.05)),
                    (0.005, _torso_ring(prof, 0.005, segs=20, swell=1.05))]),
              P["leather"])
        if spec["paint"]:
            # war paint: three chevrons daubed across the chest
            for k, z in enumerate((0.285, 0.215, 0.145)):
                hx, hy, keel = _torso_at(prof, z)
                p.add(shell_band(z, z + 0.020, hx * 1.02, hx * 1.02, 0.018,
                                 segments=9, squash=(hy + keel * 0.4) / hx,
                                 arc=math.radians(126 - k * 10),
                                 arc_start=math.radians(207 + k * 5)),
                      acc, bevel=False)

    if spec["surcoat"]:
        def panel(u, v):
            a = math.radians(216 + 108 * u)
            z = 0.415 - 0.285 * v
            hx, hy, keel = _torso_at(prof, z)
            x, y = _torso_pt(hx * 1.05, hy * 1.05, keel * 1.06, a)
            return (x, y, z)
        p.add(sheet(panel, 13, 9, 0.014), acc, bevel=False)
        for z0, z1 in ((0.406, 0.440),):
            p.add(loft([(z0, _torso_ring(prof, z0, segs=20, swell=1.065)),
                        (z1, _torso_ring(prof, z1, segs=20, swell=1.065))]),
                  P["gold"])

    if spec["mantle"] != "none":
        add_mantle(p, P, spec, heavy=spec["mantle"] == "heavy")
    return p


def build_hips(spec, P, accent):
    p = Part("M_Hips")
    b = spec["build"]
    p.add(cylinder(-0.11, -0.02, 0.185 * b, 0.19 * b, segments=16, squash=0.70),
          P["leather"])
    p.add(box((0, -0.132, -0.065), (0.09, 0.035, 0.07)), P["gold"])
    # mail skirt beneath the belt
    p.add(cylinder(-0.22, -0.09, 0.175 * b, 0.185 * b, segments=16, squash=0.72),
          P["mail"])

    acc = material(f"{spec['key']}_accent", accent, 0.0, 0.55)
    tass = spec["tassets"]
    if tass == "none":
        return p
    if tass == "full":
        # broad articulated tassets front and back, plus hip wings
        for ang, length, mat in ((-30, 0.40, P["steel"]), (30, 0.40, P["steel"]),
                                 (-74, 0.32, acc), (74, 0.32, acc),
                                 (-124, 0.28, P["steel"]),
                                 (124, 0.28, P["steel"]),
                                 (180, 0.30, P["steel"])):
            t = math.radians(ang)
            r = 0.175 * b
            for k, (z0, ln, wf) in enumerate(((-0.045, 0.10, 1.0),
                                              (-0.125, 0.13, 0.97),
                                              (-0.235, length - 0.19, 0.9))):
                pos = (math.sin(t) * r, -math.cos(t) * r * 0.84, z0)
                m = (Matrix.Translation(Vector(pos))
                     @ Matrix.Rotation(t, 4, 'Z')
                     @ Matrix.Rotation(math.radians(-11), 4, 'X'))
                w = 0.098 * wf
                p.add(plate([(-w, 0.0), (w, 0.0),
                             (w * 0.86, -ln), (-w * 0.86, -ln)], 0.024,
                            matrix=m), mat if k else P["dark"])
        return p

    if spec["torso"] == "plate" or spec["torso"] == "mail":
        strips = [(-52, 0.30, P["steel"]), (-18, 0.34, acc),
                  (18, 0.34, acc), (52, 0.30, P["steel"]),
                  (150, 0.26, P["steel"]), (-150, 0.26, P["steel"])]
        thick, wide = 0.022, 0.075
    else:
        strips = [(a, 0.34, P["hide"]) for a in
                  (-72, -43, -14, 14, 43, 72, 120, 155, -120, -155)]
        thick, wide = 0.018, 0.055

    for ang, length, mat in strips:
        t = math.radians(ang)
        r = 0.17 * b
        pos = (math.sin(t) * r, -math.cos(t) * r * 0.82, -0.06)
        m = (Matrix.Translation(Vector(pos))
             @ Matrix.Rotation(t, 4, 'Z')
             @ Matrix.Rotation(math.radians(-9), 4, 'X'))
        p.add(plate([(-wide, 0.0), (wide, 0.0),
                     (wide * 0.8, -length), (-wide * 0.8, -length)],
                    thick, matrix=m), mat)
    return p


def horn(p, base, side, mat, length=0.30, steps=12, r0=0.052):
    """A thick horn sweeping out, back and then up into a curl."""
    path = []
    for i in range(steps + 1):
        t = i / steps
        # out and back first, curling up and forward toward the tip
        x = side * (0.62 * math.sin(t * 1.30))
        y = 0.20 * t ** 1.4 - 0.46 * t ** 2.6
        z = -0.10 * t + 0.78 * t ** 2.2
        path.append(Vector(base) + Vector((x, y, z)) * (length / 0.90))
    p.add(tube(path, lambda t: r0 * (1.0 - 0.92 * t ** 1.15), segments=9), mat)
    # growth ridges along the lower two thirds
    for i in range(1, 5):
        t = i / 7.0
        k = int(t * steps)
        c = path[k]
        p.add(cylinder(-0.008, 0.008, r0 * (1.0 - 0.9 * t ** 0.85) * 1.16,
                       r0 * (1.0 - 0.9 * t ** 0.85) * 1.16, segments=8,
                       matrix=Matrix.Translation(c)
                       @ (path[k + 1] - path[k - 1]).normalized()
                       .to_track_quat('Z', 'Y').to_matrix().to_4x4()), mat)


# Great-helm plan outline: a rounded skull pulled forward to a point at -Y.
def _helm_plan(hx, fy, by):
    return [
        (0.0, -fy),
        (hx * 0.56, -fy * 0.80),
        (hx * 0.95, -fy * 0.18),
        (hx, by * 0.32),
        (hx * 0.78, by * 0.80),
        (hx * 0.33, by),
        (-hx * 0.33, by),
        (-hx * 0.78, by * 0.80),
        (-hx, by * 0.32),
        (-hx * 0.95, -fy * 0.18),
        (-hx * 0.56, -fy * 0.80),
    ]


def _front_bias(base, front_gain, back_keep=0.34, power=0.5):
    """Radius that swells toward the face (-Y) and shrinks behind it."""
    def f(a):
        t = max(0.0, -math.sin(a)) ** power
        return base * (back_keep + (front_gain - back_keep) * t)
    return f


def _back_bias(base, cut=0.44, power=0.6):
    """Radius that pulls away from the face — hair, coifs, mantles."""
    def f(a):
        return base * (1.0 - cut * max(0.0, -math.sin(a)) ** power)
    return f


def add_face(p, P, spec, beard=True, hair=True):
    """Bare head: skull, brow, nose, beard, hair. Chin sits just above the
    gorget at z ~= -0.04; the crown reaches z ~= 0.19."""
    p.add(dome((0, -0.010, 0.072), (0.100, 0.112, 0.116), rings=5,
               segments=16, hemi=False), P["skin"])
    p.add(box((0, -0.110, 0.082), (0.032, 0.044, 0.050)), P["skin"])
    p.add(box((0, -0.096, 0.128), (0.146, 0.038, 0.024)), P["skin"])
    for s2 in (1, -1):
        p.add(box((0.044 * s2, -0.098, 0.106), (0.046, 0.028, 0.018)),
              P["black"])
    if beard:
        p.add(loft([(z, ring(16, _front_bias(r, 1.0), squash=1.05,
                             center=(0, -0.008)))
                    for z, r in ((-0.070, 0.062), (-0.026, 0.096),
                                 (0.018, 0.114), (0.060, 0.118),
                                 (0.092, 0.108))]), P["hair"])
    if hair:
        p.add(loft([(z, ring(16, _back_bias(r, 0.58), squash=1.06,
                             center=(0, 0.026)))
                    for z, r in ((0.050, 0.100), (0.118, 0.112),
                                 (0.164, 0.108), (0.200, 0.074),
                                 (0.222, 0.030))]), P["hair"])


def add_skullcap(p, P, ribs=True, mat=None):
    """Faceted skull cap sitting over the crown, with a brow band."""
    mat = mat or P["steel"]
    cap = [(0.096, 0.128, 0.138), (0.148, 0.124, 0.134),
           (0.196, 0.110, 0.118), (0.234, 0.084, 0.090),
           (0.262, 0.044, 0.048)]
    p.add(loft([(z, ring(12, rx, squash=ry / rx, phase=math.pi / 12))
                for z, rx, ry in cap]), mat)
    if ribs:
        for ang in (0, 45, 90, 135):
            p.add(plate([(0.128, 0.096), (0.122, 0.150), (0.100, 0.204),
                         (0.026, 0.252), (0.0, 0.262), (0.0, 0.246),
                         (0.020, 0.240), (0.088, 0.196), (0.108, 0.148),
                         (0.114, 0.096)], 0.024,
                        matrix=Matrix.Rotation(math.radians(ang), 4, 'Z')
                        @ rot(rz=90)), P["dark"])
    p.add(shell_band(0.086, 0.136, 0.132, 0.130, 0.016, segments=18,
                     arc=TAU, squash=1.06), P["dark"])


def build_head(spec, P, accent):
    p = Part("M_Head")
    acc = material(f"{spec['key']}_accent", accent, 0.0, 0.55)
    helm = spec["helm"]

    if helm == "great":
        # tapered great helm: the face plate angles forward to a soft point
        shell = [
            (-0.050, 0.111, 0.098, 0.111),
            (0.020, 0.126, 0.142, 0.124),
            (0.098, 0.135, 0.166, 0.133),
            (0.168, 0.134, 0.162, 0.134),
            (0.208, 0.128, 0.124, 0.130),
            (0.262, 0.103, 0.080, 0.107),
            (0.302, 0.058, 0.042, 0.062),
            (0.322, 0.020, 0.015, 0.023),
        ]
        p.add(loft([(z, _helm_plan(hx, fy, by)) for z, hx, fy, by in shell]),
              P["steel"])
        # heavy brow ridge overhanging the occularia
        p.add(loft([(0.155, _helm_plan(0.139, 0.170, 0.138)),
                    (0.180, _helm_plan(0.143, 0.178, 0.141)),
                    (0.204, _helm_plan(0.132, 0.136, 0.134))]), P["steel"])
        # vision slits, angled to lie on the two halves of the face plate
        for s in (1, -1):
            p.add(box((0, 0, 0), (0.088, 0.040, 0.026),
                      matrix=rot(rz=23 * s,
                                 translate=(0.041 * s, -0.147, 0.140))),
                  P["black"])
            for k, (dx, dz) in enumerate(((0.018, 0.078), (0.040, 0.062),
                                          (0.030, 0.040), (0.052, 0.028))):
                p.add(box((0, 0, 0), (0.017, 0.036, 0.030),
                          matrix=rot(rz=23 * s,
                                     translate=(dx * s, -0.146, dz))),
                      P["black"])
        # keel down the front of the face plate
        p.add(plate([(-0.176, 0.196), (-0.150, 0.210), (-0.108, 0.020),
                     (-0.132, -0.010)], 0.034, matrix=rot(rz=90)), P["steel"])
        # raised comb over the skull, with an enamelled inlay
        cr = spec["crest"]

        def cz(pts):
            return [(y, 0.196 + (z - 0.196) * cr) for y, z in pts]

        comb = [(-0.124, 0.198), (-0.080, 0.258), (-0.038, 0.298),
                (0.000, 0.316), (0.056, 0.300), (0.104, 0.258),
                (0.130, 0.198), (0.152, 0.206), (0.140, 0.288),
                (0.076, 0.342), (0.000, 0.366), (-0.078, 0.338),
                (-0.138, 0.276), (-0.152, 0.200)]
        p.add(plate(cz(comb), 0.034, matrix=rot(rz=90)), P["steel"])
        p.add(plate(cz([(-0.126, 0.222), (-0.062, 0.300), (0.000, 0.330),
                        (0.066, 0.302), (0.124, 0.226), (0.108, 0.222),
                        (0.052, 0.284), (0.000, 0.308), (-0.052, 0.284),
                        (-0.110, 0.222)]), 0.042, matrix=rot(rz=90)), acc)
        p.add(plate([(-0.156, 0.196), (0.156, 0.202), (0.150, 0.176),
                     (-0.150, 0.170)], 0.040, matrix=rot(rz=90)), P["gold"])
        # gorget flaring under the helm — a clear neck transition
        p.add(loft([(-0.036, ring(14, 0.118, squash=0.94)),
                    (-0.082, ring(14, 0.142, squash=0.92)),
                    (-0.118, ring(14, 0.152, squash=0.90))]), P["dark"])
        p.add(cylinder(-0.118, -0.150, 0.150, 0.140, segments=14, squash=0.90),
              P["steel"])
    elif helm == "none":
        # bare head: braided hair and war paint, no helm at all
        add_face(p, P, spec)
        for s2 in (1, -1):
            braid = [Vector((0.072 * s2, 0.082, 0.150))
                     + Vector((0.014 * s2 * math.sin(t * 3.0),
                               0.026 * t, -0.30 * t))
                     for t in [i / 8 for i in range(9)]]
            p.add(tube(braid, lambda t: 0.028 * (1.0 - 0.5 * t), segments=8),
                  P["hair"])
            for k in range(3):
                c = braid[2 + k * 2]
                p.add(cylinder(-0.006, 0.006, 0.030, 0.030, segments=8,
                               matrix=Matrix.Translation(c)), P["leather"])
            # war paint daubed across the eyes and down the cheek
            p.add(box((0, 0, 0), (0.090, 0.024, 0.026),
                      matrix=rot(rz=14 * s2,
                                 translate=(0.046 * s2, -0.092, 0.112))), acc)
            p.add(box((0, 0, 0), (0.020, 0.024, 0.078),
                      matrix=rot(rz=8 * s2,
                                 translate=(0.066 * s2, -0.082, 0.052))), acc)
        p.add(loft([(0.010, ring(16, 0.118, squash=0.98)),
                    (-0.052, ring(16, 0.138, squash=0.96))]), P["leather"])
    elif helm == "open":
        # open-faced bascinet: brow band, nasal bar, mail coif, no visor
        add_face(p, P, spec, beard=False)
        add_skullcap(p, P, ribs=False)
        p.add(plate([(-0.150, 0.146), (-0.124, 0.150), (-0.118, 0.048),
                     (-0.146, 0.056)], 0.034, matrix=rot(rz=90)), P["steel"])
        for s2 in (1, -1):
            p.add(plate([(0.062, 0.104), (0.128, 0.098), (0.130, 0.014),
                         (0.070, -0.014)], 0.022,
                        matrix=(mirror_x() if s2 < 0 else Matrix.Identity(4))
                        @ rot(rz=-12, translate=(0, -0.030, 0))), P["steel"])
        p.add(loft([(0.078, ring(18, _back_bias(0.134, 0.24), squash=1.02)),
                    (0.000, ring(18, _back_bias(0.150, 0.26), squash=0.99)),
                    (-0.076, ring(18, _back_bias(0.152, 0.22), squash=0.97))]),
              P["mail"])
    else:
        # bearded face first, so the helm reads as sitting on top of it
        add_face(p, P, spec, hair=False)

        add_skullcap(p, P, ribs=True)
        # nasal bar down the front of the brow band
        p.add(plate([(-0.148, 0.144), (-0.120, 0.148), (-0.116, 0.030),
                     (-0.146, 0.038)], 0.036, matrix=rot(rz=90)), P["steel"])
        p.add(box((0, -0.104, 0.126), (0.186, 0.044, 0.028)), P["dark"])
        # cheek guards hanging either side of the face
        cheek = rot(rz=-14, translate=(0, -0.030, 0.096))
        for m in (cheek, mirror_x() @ cheek):
            p.add(plate([(0.058, 0.010), (0.128, 0.004), (0.132, -0.086),
                         (0.070, -0.116)], 0.024, matrix=m), P["steel"])
        if helm == "masked":
            # riveted iron face mask with eye slots and a snarling ridge
            p.add(loft([(0.010, _helm_plan(0.098, 0.118, 0.030)),
                        (0.062, _helm_plan(0.122, 0.150, 0.030)),
                        (0.106, _helm_plan(0.132, 0.162, 0.030)),
                        (0.140, _helm_plan(0.130, 0.150, 0.030))],
                       caps=False), P["dark"])
            for s2 in (1, -1):
                p.add(box((0, 0, 0), (0.068, 0.040, 0.022),
                          matrix=rot(rz=21 * s2,
                                     translate=(0.046 * s2, -0.130, 0.106))),
                      P["black"])
            p.add(plate([(-0.168, 0.150), (-0.144, 0.154), (-0.138, 0.020),
                         (-0.166, 0.028)], 0.030, matrix=rot(rz=90)),
                  P["steel"])
        hl = 0.38 if helm == "masked" else 0.30
        horn(p, (0.104, 0.014, 0.168), 1, P["bone"], length=hl)
        horn(p, (-0.104, 0.014, 0.168), -1, P["bone"], length=hl)
        p.add(loft([(0.010, ring(18, _back_bias(0.126, 0.12), squash=0.98)),
                    (-0.042, ring(18, _back_bias(0.146, 0.14), squash=0.96)),
                    (-0.092, ring(18, _back_bias(0.150, 0.12), squash=0.95))]),
              P["mail"])
    return p


def build_pauldron(up, P, spec, side, acc):
    """Layered angular pauldron: a main plate sweeping out and down over the
    shoulder with overlapping lames beneath it. Built for the left arm and
    mirrored for the right; the whole stack is tilted so it flares outward."""
    kind = spec["pauldron"]
    if kind == "none":
        return
    m = rot(ry=-9, translate=(0.012, 0, -0.018))
    if side < 0:
        m = mirror_x() @ m
    steel, dark = P["steel"], P["dark"]
    trim = P["gold"] if spec["torso"] in ("plate", "mail") else dark

    if kind == "fur":
        return                       # handled by the arm's fur spaulder
    if kind == "spaulder":
        # light: a single small cap plate and one lame
        up.add(shell_band(-0.062, 0.056, 0.116, 0.070, 0.020, segments=9,
                          arc=math.radians(240), arc_start=math.radians(-120),
                          matrix=m), steel)
        up.add(dome((0, 0, 0.050), (0.074, 0.074, 0.036), rings=3, segments=9,
                    matrix=m), steel)
        up.add(shell_band(-0.116, -0.048, 0.124, 0.112, 0.018, segments=8,
                          arc=math.radians(214), arc_start=math.radians(-107),
                          matrix=m), steel)
        up.add(shell_band(-0.068, -0.048, 0.120, 0.118, 0.024, segments=9,
                          arc=math.radians(240), arc_start=math.radians(-120),
                          matrix=m), trim)
        return

    k = 1.16 if kind == "heavy" else 1.0     # heavy = bigger, one more lame
    # main plate — a downward-flaring cone, open toward the body
    up.add(shell_band(-0.088 * k, 0.062, 0.150 * k, 0.072, 0.024, segments=11,
                      arc=math.radians(252), arc_start=math.radians(-126),
                      matrix=m), steel)
    up.add(dome((0, 0, 0.054), (0.076, 0.076, 0.040), rings=3, segments=11,
                matrix=m), steel)
    # faceted reinforcing rib down the outer face of the main plate
    up.add(shell_band(-0.092 * k, 0.048, 0.158 * k, 0.086, 0.032, segments=3,
                      arc=math.radians(46), arc_start=math.radians(-23),
                      matrix=m), dark)
    # overlapping lames, each sliding under the plate above it
    lames = [(-0.156, -0.070, 0.161, 0.140, 232, steel),
             (-0.218, -0.138, 0.166, 0.152, 208, steel),
             (-0.268, -0.200, 0.158, 0.152, 184, dark)]
    if kind == "heavy":
        lames = [(-0.150, -0.062, 0.178, 0.156, 244, steel),
                 (-0.208, -0.130, 0.188, 0.170, 226, steel),
                 (-0.264, -0.190, 0.190, 0.178, 204, steel),
                 (-0.312, -0.248, 0.180, 0.176, 180, dark)]
    for z0, z1, r0, r1, arc_deg, mat in lames:
        up.add(shell_band(z0, z1, r0, r1, 0.022, segments=10,
                          arc=math.radians(arc_deg),
                          arc_start=math.radians(-arc_deg / 2), matrix=m), mat)
    # gilt trim strip along the bottom edge of the main plate
    up.add(shell_band(-0.096 * k, -0.072 * k, 0.154 * k, 0.152 * k, 0.028,
                      segments=11, arc=math.radians(252),
                      arc_start=math.radians(-126), matrix=m), trim)
    # angular wing jutting forward off the front of the plate
    up.add(plate([(0.052, 0.024), (0.150 * k, 0.006), (0.168 * k, -0.058),
                  (0.070, -0.066)], 0.026,
                 matrix=m @ rot(rx=90, translate=(0, 0, -0.030))), acc)


def build_arm(spec, P, side, accent):
    """Returns (upper, lower, hand) parts for one arm. side: +1 L, -1 R."""
    kind = spec["arms"]
    plated = kind in ("plate", "leather", "mail")
    acc = material(f"{spec['key']}_accent", accent, 0.0, 0.55)
    b = spec["build"]

    mir = mirror_x() if side < 0 else None
    up = Part(f"M_Arm{'L' if side > 0 else 'R'}_Upper")
    build_pauldron(up, P, spec, side, acc)

    sm = {"plate": P["steel"], "mail": P["mail"],
          "leather": P["leather"]}.get(kind, P["skin"])

    if plated:
        # ---- rerebrace. Its lower cuff flares wide so the elbow cop nests
        # inside it and the joint stays closed through a deep bend.
        up.add(dome((0, 0, -0.015), (0.100, 0.100, 0.072), rings=3,
                    segments=14), sm)
        up.add(loft([(-0.015, ring(14, 0.098)), (-0.120, ring(14, 0.094)),
                     (-0.215, ring(14, 0.090))]), sm)
        up.add(shell_band(-0.300, -0.208, 0.101, 0.094, 0.014, segments=14,
                          arc=TAU), P["steel"] if kind != "mail" else sm)
        up.add(shell_band(-0.186, -0.160, 0.096, 0.096, 0.012, segments=14,
                          arc=TAU), P["dark"])
        if kind == "mail":
            for z in (-0.06, -0.115, -0.170, -0.225):
                up.add(shell_band(z, z + 0.030, 0.096, 0.100, 0.010,
                                  segments=14, arc=TAU), P["mail"],
                       bevel=False)
    else:
        # ---- bare arm: deltoid, bicep, then the taper into the elbow
        up.add(loft([(0.010, ring(12, 0.072 * b)),
                     (-0.070, ring(12, 0.080 * b)),
                     (-0.150, ring(12, 0.072 * b)),
                     (-0.245, ring(12, 0.062 * b)),
                     (-0.325, ring(12, 0.060 * b))]), P["skin"])
        # lumpy fur spaulder, matching the mantle
        def fur_r(base, phase, amp=0.16):
            def f(a):
                return base * (1.0 + amp * math.sin(5 * a + phase)
                               + 0.5 * amp * math.sin(11 * a + 1.7))
            return f
        if spec["pauldron"] == "fur":
            up.add(loft([(0.052, ring(20, fur_r(0.062, 0.4))),
                         (-0.010, ring(20, fur_r(0.116, 1.0))),
                         (-0.072, ring(20, fur_r(0.122, 1.6))),
                         (-0.120, ring(20, fur_r(0.088, 2.2)))]),
                   P["fur"], bevel=False)
        else:
            up.add(loft([(0.044, ring(16, 0.084 * b)),
                         (-0.014, ring(16, 0.112 * b)),
                         (-0.068, ring(16, 0.116 * b)),
                         (-0.104, ring(16, 0.096 * b))]), P["leather"],
                   bevel=False)
            up.add(shell_band(-0.112, -0.086, 0.098 * b, 0.098 * b, 0.014,
                              segments=14, arc=TAU), P["dark"])
        if spec["paint"]:
            for z in (-0.120, -0.155):
                up.add(shell_band(z, z + 0.016, 0.073 * b, 0.073 * b, 0.008,
                                  segments=12, arc=TAU), acc, bevel=False)
        # arm ring + strapping on the bicep
        up.add(shell_band(-0.190, -0.164, 0.070 * b, 0.070 * b, 0.012,
                          segments=12, arc=TAU), P["gold"])
        up.add(shell_band(-0.262, -0.216, 0.066 * b, 0.064 * b, 0.011,
                          segments=12, arc=TAU), P["leather"])

    lo = Part(f"M_Arm{'L' if side > 0 else 'R'}_Lower")
    if plated:
        # elbow cop centred on the joint, small enough to live inside the cuff
        lo.add(dome((0, 0, 0), (0.084, 0.084, 0.082), rings=4, segments=14,
                    hemi=False), P["steel"])
        # couter wing flaring off the outside of the elbow
        lo.add(plate([(0.062, 0.050), (0.126, 0.024), (0.130, -0.044),
                      (0.060, -0.072)], 0.020, matrix=mir), P["steel"])
        lo.add(loft([(-0.040, ring(14, 0.086)), (-0.130, ring(14, 0.080)),
                     (-0.215, ring(14, 0.066)),
                     (-0.262, ring(14, 0.058))]), sm)
        lo.add(shell_band(-0.268, -0.236, 0.060, 0.062, 0.013, segments=14,
                          arc=TAU),
               P["gold"] if kind == "plate" else P["dark"])
    else:
        lo.add(dome((0, 0, 0), (0.058 * b, 0.058 * b, 0.058 * b), rings=4,
                    segments=10, hemi=False), P["skin"])
        lo.add(loft([(-0.030, ring(10, 0.060 * b)),
                     (-0.090, ring(10, 0.062 * b)),
                     (-0.190, ring(10, 0.050 * b)),
                     (-0.262, ring(10, 0.046 * b))]), P["skin"])
        # leather vambrace wrapped over the forearm
        lo.add(loft([(-0.252, ring(12, 0.052 * b)),
                     (-0.228, ring(12, 0.062 * b)),
                     (-0.150, ring(12, 0.066 * b)),
                     (-0.118, ring(12, 0.058 * b))]), P["leather"])
        for z in (-0.236, -0.194, -0.150):
            lo.add(shell_band(z, z + 0.014, 0.064 * b, 0.064 * b, 0.010,
                              segments=12, arc=TAU), P["dark"])

    ha = Part(f"M_Hand{'L' if side > 0 else 'R'}")
    hmat = P["steel"] if kind == "plate" else P["leather"]
    ha.add(frustum(0.0, -0.10, (0.10, 0.115), (0.098, 0.125),
                   center=(0, -0.008)), hmat)
    ha.add(frustum(-0.10, -0.145, (0.098, 0.125), (0.075, 0.10),
                   center=(0, -0.012)), hmat)
    if kind == "plate":
        ha.add(box((0, -0.062, -0.058), (0.085, 0.025, 0.09)), P["dark"])
        for k in range(3):
            ha.add(box((0, -0.058, -0.036 - k * 0.036),
                       (0.092, 0.030, 0.020)), P["steel"])
    return up, lo, ha


def build_leg(spec, P, side, accent):
    b = spec["build"]
    plated = spec["legs"] in ("plate", "mail")
    mir = mirror_x() if side < 0 else None
    up = Part(f"M_Leg{'L' if side > 0 else 'R'}_Upper")
    up.add(dome((0, 0, -0.02), (0.118, 0.122, 0.088), rings=4, segments=12),
           P["mail"])
    up.add(loft([(-0.030, ring(12, 0.112 * b, squash=1.06)),
                 (-0.130, ring(12, 0.108 * b, squash=1.06)),
                 (-0.270, ring(12, 0.094 * b, squash=1.08)),
                 (-0.380, ring(12, 0.085 * b, squash=1.08))]),
           P["steel"] if plated else P["hide"])
    # flared cuisse cuff — the knee cop nests inside it so the joint stays shut
    up.add(shell_band(-0.452, -0.352, 0.094, 0.087, 0.016, segments=12,
                      arc=TAU, squash=1.08),
           P["steel"] if plated else P["leather"])

    lo = Part(f"M_Leg{'L' if side > 0 else 'R'}_Lower")
    lo.add(dome((0, -0.006, 0), (0.080, 0.084, 0.080), rings=4, segments=12,
                hemi=False), P["steel"] if plated else P["leather"])
    if plated:
        # poleyn wing on the outside of the knee
        lo.add(plate([(0.062, 0.036), (0.122, 0.012), (0.124, -0.048),
                      (0.058, -0.066)], 0.020, matrix=mir), P["steel"])
    lo.add(loft([(-0.055, ring(12, 0.082, squash=1.06)),
                 (-0.140, ring(12, 0.086, squash=1.08)),
                 (-0.300, ring(12, 0.068, squash=1.10)),
                 (-0.430, ring(12, 0.056, squash=1.12))]),
           P["steel"] if plated else P["leather"])
    if not plated:
        for z in (-0.10, -0.19, -0.28, -0.37):
            lo.add(shell_band(z, z + 0.030, 0.076, 0.074, 0.020, segments=14,
                              arc=TAU, squash=1.10), P["hide"])
        lo.add(loft([(-0.300, ring(14, 0.070, squash=1.10)),
                     (-0.440, ring(14, 0.058, squash=1.12))]), P["leather"])

    ft = Part(f"M_Foot{'L' if side > 0 else 'R'}")
    ft.add(frustum(-0.06, 0.01, (0.115, 0.24), (0.11, 0.22),
                   center=(0, -0.045)), P["steel"] if plated else P["leather"])
    ft.add(frustum(-0.055, -0.005, (0.10, 0.10), (0.075, 0.09),
                   center=(0, -0.175)), P["steel"] if plated else P["leather"])
    return up, lo, ft


FOLDS = 4.6          # vertical folds across the cape
FOLD_PHASE = 0.42


def _cape(u, v, r_extra=0.0, drop=0.0):
    """Cloth surface wrapped around the shoulders. u across, v down."""
    s = u * 2.0 - 1.0
    span = math.radians(88) * (1.0 - 0.10 * v)
    t = s * span
    fold = 0.040 * (0.16 + 1.0 * v) * math.cos(s * FOLDS * math.pi + FOLD_PHASE)
    r = 0.215 + 0.190 * v ** 1.2 + fold + r_extra
    z = 0.052 - (0.80 + drop) * v \
        + 0.028 * v * v * math.cos(s * FOLDS * math.pi + FOLD_PHASE)
    return (math.sin(t) * r,
            -0.10 + math.cos(t) * r * (0.88 + 0.22 * v),
            z)


def build_cloak(spec, P, accent):
    """A wrapped cape the game sways from the Cloak joint."""
    acc = material(f"{spec['key']}_accent", accent, 0.0, 0.6)
    lining = material(f"{spec['key']}_lining", (0.10, 0.10, 0.12), 0.0, 0.8)
    p = Part("M_Cloak")
    p.add(sheet(_cape, 26, 16, 0.020), acc, bevel=False)
    # dark lining showing along the hem
    p.add(sheet(lambda u, v: _cape(u, 0.78 + 0.22 * v, -0.012), 26, 3, 0.008),
          lining, bevel=False)
    # fur-trimmed mantle collar riding over the top of the cloth
    p.add(sheet(lambda u, v: _cape(0.02 + 0.96 * u, 0.055 * v, 0.030), 22, 3,
                0.052), P["fur"], bevel=False)
    # clasps where the cape meets the shoulders
    for s in (1, -1):
        x, y, z = _cape(0.5 + 0.5 * s, 0.02, 0.03)
        p.add(dome((x, y, z), (0.030, 0.030, 0.030), rings=3, segments=8,
                   hemi=False), P["gold"])
    return p


# --------------------------------------------------------------- assembly

def build_character(spec):
    reset_scene()
    P = palette(spec["key"])
    accent = spec["accent"]
    j = build_skeleton()

    build_torso(spec, P, accent).bake(j["Torso"])
    build_hips(spec, P, accent).bake(j["Hips"])
    build_head(spec, P, accent).bake(j["Head"])
    if spec["cloak"]:
        build_cloak(spec, P, accent).bake(j["Cloak"], bevel=0.0)

    for s, sign in (("L", 1), ("R", -1)):
        up, lo, ha = build_arm(spec, P, sign, accent)
        up.bake(j[f"Shoulder{s}"])
        lo.bake(j[f"Elbow{s}"])
        ha.bake(j[f"Hand{s}"])
        lup, llo, lft = build_leg(spec, P, sign, accent)
        lup.bake(j[f"Hip{s}"])
        llo.bake(j[f"Knee{s}"])
        lft.bake(j[f"Foot{s}"])

    path = os.path.normpath(os.path.join(OUT, f"knight_{spec['key']}.glb"))
    export_glb(path)
    print(f"[art-of-battle] wrote {path}")


if __name__ == "__main__":
    for _s in ALL_SPECS:
        build_character(_s)
    print("[art-of-battle] characters done")
