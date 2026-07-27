"""Procedurally build the duel weapons, export as GLB.

    blender --background --python tools/build_weapons.py

Writes public/models/weapon_{longsword,daneaxe,greatsword,warhammer,
spear,katana}.glb.

Authoring convention (Blender, Z-up) per ASSET_CONTRACT.md:
    grip at the origin, blade/haft runs along +Z, cutting edge faces +X/-X.
The glTF exporter converts to Y-up, so in the game the weapon runs along +Y.
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from rigkit import (  # noqa: E402
    TAU, Part, box, cylinder, dome, export_glb, frustum, joint, loft, material,
    plate, reset_scene, ring, rot, shell_band, tube,
)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "..", "public", "models")

SPECS = []          # (name, lead_y, rear_y, tip_y) filled in by the builders


# ------------------------------------------------------------------ palette

def pal():
    """Materials are rebuilt per weapon (reset_scene wipes the datablocks)."""
    return {
        "steel":  material("steel", (0.60, 0.63, 0.69), 1.0, 0.30),
        "jigane": material("steel_jigane", (0.44, 0.46, 0.51), 1.0, 0.36),
        "bright": material("steel_bright", (0.86, 0.88, 0.92), 1.0, 0.16),
        "dark":   material("steel_dark", (0.23, 0.24, 0.27), 1.0, 0.44),
        "iron":   material("iron", (0.13, 0.13, 0.15), 1.0, 0.56),
        "brass":  material("brass", (0.78, 0.60, 0.24), 1.0, 0.30),
        "leather": material("leather", (0.17, 0.105, 0.065), 0.0, 0.82),
        "oxblood": material("oxblood", (0.19, 0.065, 0.055), 0.0, 0.78),
        "wrap":   material("wrap", (0.06, 0.06, 0.075), 0.0, 0.86),
        "ray":    material("rayskin", (0.74, 0.72, 0.66), 0.0, 0.60),
        "wood":   material("wood_ash", (0.52, 0.40, 0.25), 0.0, 0.72),
        "wooddk": material("wood_dark", (0.30, 0.21, 0.13), 0.0, 0.76),
    }


# ------------------------------------------------------- local mesh helpers

def _xf(verts, matrix):
    if matrix is None:
        return verts
    return [tuple(matrix @ Vector(v)) for v in verts]


def loft3(rings, caps=True, matrix=None):
    """Loft equal-length rings of *3D* points (free-form spine)."""
    n = len(rings[0])
    verts, faces = [], []
    for r in rings:
        verts.extend(tuple(v) for v in r)
    for s in range(len(rings) - 1):
        a0, b0 = s * n, (s + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a0 + i, a0 + j, b0 + j, b0 + i))
    if caps:
        faces.append(tuple(range(n)))
        faces.append(tuple(range(len(verts) - n, len(verts))))
    return _xf(verts, matrix), faces


def sweep(path, sec_fn, caps=True, matrix=None):
    """Sweep 2D sections along a spine that lives in the XZ plane.

    path:   [(x, z), ...]
    sec_fn: (i, t) -> [(a, b), ...]  a = in-plane perpendicular, b = Y.
    For a spine running +Z the section's `a` axis is world +X.
    """
    n = len(path)
    P = [Vector((p[0], 0.0, p[1])) for p in path]
    rings = []
    for i, pt in enumerate(P):
        if i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = P[i + 1] - P[i - 1]
        t.normalize()
        u = Vector((t.z, 0.0, -t.x))
        rings.append([tuple(pt + u * a + Vector((0.0, b, 0.0)))
                      for a, b in sec_fn(i, i / (n - 1))])
    return loft3(rings, caps=caps, matrix=matrix)


def revolve(profile, segments=10, squash=1.0, phase=0.0, center=(0.0, 0.0),
            matrix=None):
    """Solid of revolution from a [(z, r), ...] profile."""
    secs = [(z, ring(segments, max(r, 0.0006), squash=squash, center=center,
                     phase=phase)) for z, r in profile]
    return loft(secs, matrix=matrix)


def sec_lens(w, t, fd=0.0):
    """10-pt double-edged blade section. fd>0 fuller groove, fd<0 midrib."""
    hw, ht = w / 2, t / 2
    return [(-hw, 0.0), (-0.34 * w, ht), (-0.13 * w, ht - fd),
            (0.13 * w, ht - fd), (0.34 * w, ht), (hw, 0.0),
            (0.34 * w, -ht), (0.13 * w, -(ht - fd)),
            (-0.13 * w, -(ht - fd)), (-0.34 * w, -ht)]


def sec_bar(hz, hy, round_=0.86):
    """6-pt flattened bar/blade section (crossguards, axe bits, langets)."""
    return [(hz, 0.0), (round_ * hz, hy), (-round_ * hz, hy),
            (-hz, 0.0), (-round_ * hz, -hy), (round_ * hz, -hy)]


def sq_ring(s, c):
    """Square with chamfered corners, 8 points — reads as forged, faceted."""
    return [(s, s - c), (s - c, s), (-(s - c), s), (-s, s - c),
            (-s, -(s - c)), (-(s - c), -s), (s - c, -s), (s, -(s - c))]


def helix(spine, r_fn, turns, phase=0.0, samples=44):
    """Path of points spiralling around an XZ-plane spine.

    spine: fn(t) -> (x, z);  r_fn: fn(t) -> radius.
    """
    pts = []
    for i in range(samples + 1):
        t = i / samples
        x, z = spine(t)
        dt = 1e-3
        x1, z1 = spine(min(t + dt, 1.0))
        x0, z0 = spine(max(t - dt, 0.0))
        tan = Vector((x1 - x0, 0.0, z1 - z0))
        tan.normalize()
        u = Vector((tan.z, 0.0, -tan.x))
        v = Vector((0.0, 1.0, 0.0))
        a = phase + TAU * turns * t
        r = r_fn(t)
        pts.append(tuple(Vector((x, 0.0, z)) + u * (math.cos(a) * r)
                         + v * (math.sin(a) * r)))
    return pts


def write(part, root, name):
    part.bake(root, bevel=0.0022)
    path = os.path.normpath(os.path.join(OUT, name))
    export_glb(path)
    print(f"[art-of-battle] wrote {path}")


def blade(p, stations, mat, spine=None, bevel=False):
    """stations: [(z, w, t, fd), ...] straight blade along +Z."""
    secs = [sec_lens(w, t, fd) for _, w, t, fd in stations]
    path = [(0.0, z) for z, _, _, _ in stations] if spine is None else spine
    p.add(sweep(path, lambda i, t: secs[i]), mat, bevel=bevel)


# ------------------------------------------------------------------ weapons

def build_longsword():
    reset_scene()
    P = pal()
    root = joint("Weapon", (0, 0, 0))
    p = Part("M_Weapon")

    # scent-stopper pommel
    p.add(revolve([(-0.268, 0.006), (-0.263, 0.022), (-0.256, 0.034),
                   (-0.248, 0.038), (-0.238, 0.036), (-0.222, 0.028),
                   (-0.206, 0.022), (-0.196, 0.020), (-0.190, 0.026),
                   (-0.183, 0.026), (-0.177, 0.019)],
                  segments=8), P["steel"], bevel=False)
    # leather grip core, slightly waisted
    p.add(revolve([(-0.184, 0.0165), (-0.170, 0.0180), (-0.100, 0.0172),
                   (-0.040, 0.0178), (0.010, 0.0192), (0.030, 0.0196)],
                  segments=12), P["leather"], bevel=False)

    # wire wrap: two counter-wound steel wires
    def gspine(t):
        return (0.0, -0.172 + t * 0.196)

    for phase, turns in ((0.0, 13), (math.pi, -13)):
        p.add(tube(helix(gspine, lambda t: 0.0203, turns, phase, 60),
                   lambda u: 0.0032, segments=5, caps=False),
              P["bright"], bevel=False)

    # cruciform guard, arms swept toward the blade, flared tips
    n = 13
    guard = []
    for i in range(n):
        x = -0.166 + 0.332 * i / (n - 1)
        guard.append((x, 0.049 + 0.058 * abs(x / 0.166) ** 2.2))

    def gsec(i, t):
        k = abs(2 * t - 1)
        flare = 1.0 + 0.9 * max(0.0, k - 0.86) / 0.14
        return sec_bar((0.019 - 0.010 * k ** 1.6) * flare,
                       (0.014 - 0.007 * k ** 1.6) * flare)

    p.add(sweep(guard, gsec), P["steel"], bevel=False)
    # écusson / blade collar
    p.add(box((0, 0, 0.048), (0.060, 0.030, 0.044)), P["steel"])
    p.add(revolve([(0.070, 0.028), (0.079, 0.030), (0.088, 0.026)],
                  segments=10), P["brass"], bevel=False)

    blade(p, [(0.030, 0.050, 0.0092, 0.0000),
              (0.092, 0.052, 0.0090, 0.0018),
              (0.170, 0.051, 0.0086, 0.0029),
              (0.430, 0.047, 0.0080, 0.0029),
              (0.620, 0.043, 0.0074, 0.0016),
              (0.780, 0.039, 0.0068, 0.0000),
              (0.940, 0.032, 0.0060, 0.0000),
              (1.020, 0.023, 0.0052, 0.0000),
              (1.058, 0.012, 0.0038, 0.0000),
              (1.072, 0.003, 0.0016, 0.0000)], P["steel"])

    write(p, root, "weapon_longsword.glb")
    SPECS.append(("longsword", -0.050, -0.160, 1.072))


def build_daneaxe():
    reset_scene()
    P = pal()
    root = joint("Weapon", (0, 0, 0))
    p = Part("M_Weapon")

    # oval ash haft
    p.add(revolve([(-0.995, 0.0175), (-0.925, 0.0190), (-0.400, 0.0205),
                   (0.150, 0.0215), (0.430, 0.0205), (0.527, 0.0175)],
                  segments=10, squash=0.80), P["wood"], bevel=False)
    p.add(revolve([(-1.005, 0.021), (-0.995, 0.027), (-0.941, 0.027),
                   (-0.933, 0.022)], segments=10, squash=0.82),
          P["dark"], bevel=False)
    p.add(revolve([(0.523, 0.019), (0.533, 0.021), (0.543, 0.014),
                   (0.545, 0.005)], segments=10, squash=0.82),
          P["dark"], bevel=False)
    # leather at both grips
    for z0, z1 in ((-0.90, -0.62), (-0.16, 0.15)):
        p.add(revolve([(z0, 0.0235), (z0 + 0.012, 0.0252),
                       (z1 - 0.012, 0.0252), (z1, 0.0235)],
                      segments=10, squash=0.82), P["leather"], bevel=False)

    # eye / socket: narrow drum with upper and lower lugs
    p.add(revolve([(0.330, 0.026), (0.342, 0.033), (0.360, 0.034),
                   (0.432, 0.034), (0.446, 0.033), (0.458, 0.026)],
                  segments=10, squash=0.76), P["dark"], bevel=False)
    for z in (0.324, 0.452):
        p.add(revolve([(z - 0.010, 0.024), (z, 0.031), (z + 0.010, 0.024)],
                      segments=10, squash=0.80), P["dark"], bevel=False)
    # langets bracing the head against the haft
    for a0 in (math.pi / 2 - 0.75, -math.pi / 2 - 0.75):
        p.add(shell_band(0.125, 0.340, 0.0222, 0.0240, thickness=0.006,
                         segments=5, arc=1.50, arc_start=a0), P["dark"])

    # bearded bit: thin blade flaring out along +X to a long arced edge.
    # stations are (x, top z, bottom z, thickness)
    bit = [(0.028, 0.424, 0.358, 0.0300),
           (0.075, 0.432, 0.316, 0.0250),
           (0.126, 0.446, 0.270, 0.0190),
           (0.172, 0.464, 0.230, 0.0135),
           (0.212, 0.488, 0.198, 0.0085),
           (0.238, 0.508, 0.178, 0.0045),
           (0.252, 0.496, 0.194, 0.0016)]
    def bitring(x, top, bot, th, scale=1.0):
        h, r = th / 2, (top - bot) * 0.10
        c = (top + bot) / 2
        top, bot = c + (top - c) * scale, c + (bot - c) * scale
        return [(x, 0.0, top), (x, h, top - r), (x, h, bot + r),
                (x, 0.0, bot), (x, -h, bot + r), (x, -h, top - r)]

    p.add(loft3([bitring(*s) for s in bit]), P["steel"], bevel=False)
    # bright hardened edge along the outer third of the bit
    p.add(loft3([bitring(x, a, b, min(th, 0.0042), 1.004)
                 for x, a, b, th in bit[3:]]), P["bright"], bevel=False)
    # small counterweight lug behind the eye
    p.add(frustum(0.348, 0.440, (0.030, 0.036), (0.018, 0.026),
                  center=(-0.038, 0.0)), P["dark"])

    write(p, root, "weapon_daneaxe.glb")
    SPECS.append(("daneaxe", 0.000, -0.800, 0.545))


def build_greatsword():
    reset_scene()
    P = pal()
    root = joint("Weapon", (0, 0, 0))
    p = Part("M_Weapon")

    # pear pommel
    p.add(revolve([(-0.420, 0.006), (-0.412, 0.020), (-0.398, 0.032),
                   (-0.378, 0.038), (-0.356, 0.034), (-0.342, 0.024),
                   (-0.334, 0.026), (-0.324, 0.021)], segments=10),
          P["dark"], bevel=False)
    # long two-hand grip
    p.add(revolve([(-0.328, 0.019), (-0.300, 0.023), (-0.190, 0.025),
                   (-0.090, 0.023), (-0.040, 0.021)], segments=12),
          P["leather"], bevel=False)
    for z in (-0.300, -0.196, -0.092):
        p.add(revolve([(z, 0.024), (z + 0.008, 0.027), (z + 0.016, 0.024)],
                      segments=12), P["dark"], bevel=False)

    # wide guard with upswept ends and terminal knobs
    n = 13
    gp = [(-0.218 + 0.436 * i / (n - 1), 0.0) for i in range(n)]
    guard = [(x, 0.004 + 0.062 * (abs(x) / 0.218) ** 2.4) for x, _ in gp]

    def gsec(i, t):
        k = abs(2 * t - 1)
        return sec_bar(0.020 - 0.009 * k ** 2, 0.016 - 0.007 * k ** 2)

    p.add(sweep(guard, gsec), P["steel"], bevel=False)
    for x in (-0.218, 0.218):
        p.add(revolve([(0.058, 0.010), (0.066, 0.019), (0.078, 0.019),
                       (0.086, 0.010)], segments=8, center=(x, 0.0)),
              P["steel"], bevel=False)
    p.add(box((0, 0, 0.010), (0.070, 0.038, 0.052)), P["steel"])

    # sweeping side rings arcing up alongside the ricasso
    for y in (0.042, -0.042):
        path = [(math.sin(TAU * i / 18) * 0.058,
                 0.078 + math.cos(TAU * i / 18) * 0.070)
                for i in range(19)]
        p.add(tube([(x, y, z) for x, z in path], lambda u: 0.0058, segments=6,
                   caps=False), P["steel"], bevel=False)
        p.add(box((0, y * 0.60, 0.012), (0.018, 0.052, 0.020)), P["steel"])

    # ricasso, leather wrapped, then the parry hooks
    blade(p, [(0.014, 0.052, 0.0124, 0.0),
              (0.056, 0.049, 0.0118, 0.0),
              (0.230, 0.047, 0.0112, 0.0),
              (0.262, 0.050, 0.0112, 0.0)], P["dark"])
    p.add(revolve([(0.058, 0.030), (0.070, 0.033), (0.196, 0.033),
                   (0.208, 0.030)], segments=10, squash=0.56),
          P["leather"], bevel=False)
    for phase in (0.0, math.pi):
        p.add(tube(helix(lambda t: (0.0, 0.070 + t * 0.132),
                         lambda t: 0.0338, 7, phase, 44),
                   lambda u: 0.0034, segments=5, caps=False), P["dark"],
              bevel=False)

    # parrying hooks — bold, swept toward the tip
    for sgn in (1, -1):
        hp = [(sgn * 0.019, 0.258), (sgn * 0.052, 0.264),
              (sgn * 0.082, 0.284), (sgn * 0.098, 0.314),
              (sgn * 0.100, 0.338)]

        def hsec(i, t):
            return sec_bar(0.022 - 0.017 * t ** 1.2, 0.014 - 0.010 * t ** 1.2)

        p.add(sweep(hp, hsec), P["steel"], bevel=False)
    p.add(revolve([(0.262, 0.033), (0.278, 0.035), (0.296, 0.031)],
                  segments=10, squash=0.62), P["brass"], bevel=False)

    blade(p, [(0.288, 0.060, 0.0106, 0.0018),
              (0.420, 0.059, 0.0100, 0.0028),
              (0.700, 0.056, 0.0094, 0.0028),
              (0.920, 0.052, 0.0086, 0.0014),
              (1.070, 0.045, 0.0076, 0.0),
              (1.150, 0.030, 0.0064, 0.0),
              (1.188, 0.014, 0.0042, 0.0),
              (1.200, 0.003, 0.0018, 0.0)], P["steel"])

    write(p, root, "weapon_greatsword.glb")
    SPECS.append(("greatsword", -0.075, -0.270, 1.200))


def build_warhammer():
    reset_scene()
    P = pal()
    root = joint("Weapon", (0, 0, 0))
    p = Part("M_Weapon")

    p.add(revolve([(-0.608, 0.0158), (-0.540, 0.0172), (-0.100, 0.0188),
                   (0.230, 0.0192), (0.300, 0.0188)],
                  segments=10, squash=0.82), P["wooddk"], bevel=False)
    # faceted steel butt
    p.add(revolve([(-0.630, 0.007), (-0.622, 0.021), (-0.608, 0.025),
                   (-0.556, 0.025), (-0.546, 0.019)],
                  segments=8, squash=0.86, phase=math.pi / 8),
          P["dark"], bevel=False)
    for z0, z1 in ((-0.500, -0.320), (-0.070, 0.090)):
        p.add(revolve([(z0, 0.0198), (z0 + 0.010, 0.0216),
                       (z1 - 0.010, 0.0216), (z1, 0.0198)],
                      segments=10, squash=0.84), P["leather"], bevel=False)
    # langets strapping the head to the haft
    for a0 in (math.pi / 2 - 0.85, -math.pi / 2 - 0.85):
        p.add(shell_band(0.108, 0.296, 0.0188, 0.0194, thickness=0.0065,
                         segments=5, arc=1.70, arc_start=a0), P["dark"])

    # head block: squared drum around the haft
    p.add(loft3([[(x, y, z) for x, y in sq_ring(s, c)] for z, s, c in
                 ((0.272, 0.026, 0.009), (0.284, 0.036, 0.012),
                  (0.298, 0.039, 0.013), (0.412, 0.039, 0.013),
                  (0.426, 0.036, 0.012), (0.438, 0.026, 0.009))]),
          P["dark"], bevel=False)
    # faceted hammer face toward +X
    p.add(loft3([[(x, y, 0.355 + z) for y, z in sq_ring(s, c)] for x, s, c in
                 ((0.028, 0.042, 0.013), (0.070, 0.040, 0.012),
                  (0.110, 0.037, 0.011), (0.118, 0.036, 0.011),
                  (0.128, 0.034, 0.010))]), P["steel"], bevel=False)
    for dz, dy in ((0.019, 0.019), (0.019, -0.019),
                   (-0.019, 0.019), (-0.019, -0.019)):
        p.add(revolve([(0.0, 0.0150), (0.026, 0.0020)], segments=4,
                      phase=math.pi / 4,
                      matrix=rot(ry=90, translate=(0.124, dy, 0.355 + dz))),
              P["bright"], bevel=False)

    # curved fluke sweeping back and down toward -X
    fl = [(-0.030, 0.362), (-0.074, 0.358), (-0.118, 0.342),
          (-0.156, 0.312), (-0.182, 0.270), (-0.196, 0.226)]

    def flsec(i, t):
        hz = 0.040 - 0.0385 * t ** 1.4
        hy = 0.021 - 0.0202 * t ** 1.3
        return [(hz, 0.0), (0.0, hy), (-hz, 0.0), (0.0, -hy)]

    p.add(sweep(fl, flsec), P["steel"], bevel=False)
    # top spike
    p.add(revolve([(0.432, 0.026), (0.450, 0.022), (0.486, 0.013),
                   (0.520, 0.002)], segments=8, phase=math.pi / 8),
          P["steel"], bevel=False)

    write(p, root, "weapon_warhammer.glb")
    SPECS.append(("warhammer", 0.010, -0.420, 0.520))


def build_spear():
    reset_scene()
    P = pal()
    root = joint("Weapon", (0, 0, 0))
    p = Part("M_Weapon")

    p.add(revolve([(-0.958, 0.0152), (-0.860, 0.0168), (-0.200, 0.0180),
                   (0.240, 0.0176), (0.430, 0.0162)], segments=10),
          P["wood"], bevel=False)
    # iron buttspike
    p.add(revolve([(-0.975, 0.0195), (-0.958, 0.0208), (-0.900, 0.0198),
                   (-0.888, 0.0176)], segments=10), P["dark"], bevel=False)
    p.add(revolve([(-0.975, 0.0190), (-1.020, 0.0130), (-1.090, 0.0015)],
                  segments=4, phase=math.pi / 4), P["dark"], bevel=False)
    for z0, z1 in ((-0.430, -0.240), (-0.075, 0.120)):
        p.add(revolve([(z0, 0.0182), (z0 + 0.010, 0.0202),
                       (z1 - 0.010, 0.0202), (z1, 0.0182)], segments=10),
              P["leather"], bevel=False)
    for z in (-0.560, 0.215):
        p.add(revolve([(z, 0.0176), (z + 0.006, 0.0196),
                       (z + 0.022, 0.0196), (z + 0.028, 0.0176)],
                      segments=10), P["dark"], bevel=False)

    # socket
    p.add(revolve([(0.396, 0.0168), (0.412, 0.0250), (0.470, 0.0244),
                   (0.540, 0.0196), (0.566, 0.0158)], segments=10),
          P["dark"], bevel=False)
    # side lugs / wings, curving up and out
    for sgn in (1, -1):
        wp = [(sgn * 0.016, 0.436), (sgn * 0.052, 0.444),
              (sgn * 0.084, 0.468), (sgn * 0.100, 0.506),
              (sgn * 0.098, 0.542)]

        def wsec(i, t):
            return sec_bar(0.019 - 0.010 * t, 0.011 - 0.006 * t)

        p.add(sweep(wp, wsec), P["dark"], bevel=False)

    # leaf head with a raised midrib
    blade(p, [(0.530, 0.028, 0.0115, -0.0032),
              (0.566, 0.056, 0.0126, -0.0040),
              (0.612, 0.070, 0.0122, -0.0038),
              (0.668, 0.066, 0.0112, -0.0032),
              (0.730, 0.052, 0.0098, -0.0024),
              (0.790, 0.036, 0.0080, -0.0014),
              (0.836, 0.017, 0.0054, 0.0),
              (0.855, 0.005, 0.0024, 0.0),
              (0.860, 0.002, 0.0010, 0.0)], P["steel"])

    write(p, root, "weapon_spear.glb")
    SPECS.append(("spear", 0.020, -0.400, 0.860))


def build_katana():
    reset_scene()
    P = pal()
    root = joint("Weapon", (0, 0, 0))
    p = Part("M_Weapon")

    R = 3.70                       # curvature radius (sori ~ 18mm)
    Z0 = -0.020                    # machi: where the curve starts

    def spine(s):
        return (-R * (1.0 - math.cos(s / R)), Z0 + R * math.sin(s / R))

    # blade stations along arc length s
    st = [(0.000, 0.0338, 0.0076), (0.060, 0.0334, 0.0075),
          (0.200, 0.0322, 0.0072), (0.360, 0.0306, 0.0068),
          (0.520, 0.0286, 0.0063), (0.630, 0.0266, 0.0058),
          (0.700, 0.0244, 0.0054), (0.735, 0.0190, 0.0046),
          (0.758, 0.0104, 0.0034), (0.768, 0.0025, 0.0014)]
    path = [spine(s) for s, _, _ in st]

    def hb_of(i):
        s, w, t = st[i]
        frac = 0.30 + 0.055 * math.sin(s * 13.0)      # wavy temper line
        hb = w / 2 - frac * w
        yb = 0.5 * t * (w / 2 - hb) / (0.65 * w)
        return w, t, hb, yb

    def ha_sec(i, u):
        w, t, hb, yb = hb_of(i)
        return [(w / 2, 0.0), (hb, yb), (hb, -yb)]

    def ji_sec(i, u):
        w, t, hb, yb = hb_of(i)
        return [(hb, yb), (-0.15 * w, 0.5 * t), (-w / 2, 0.34 * t),
                (-w / 2, -0.34 * t), (-0.15 * w, -0.5 * t), (hb, -yb)]

    p.add(sweep(path, ha_sec), P["bright"], bevel=False)
    p.add(sweep(path, ji_sec), P["jigane"], bevel=False)

    # habaki + seppa + tsuba + fuchi
    p.add(revolve([(0.008, 0.019), (0.014, 0.021), (0.046, 0.019),
                   (0.052, 0.016)], segments=10, squash=0.42),
          P["brass"], bevel=False)
    p.add(revolve([(-0.011, 0.038), (-0.008, 0.044), (-0.004, 0.047),
                   (0.004, 0.047), (0.008, 0.044), (0.011, 0.038)],
                  segments=18, squash=0.90), P["iron"], bevel=False)
    p.add(revolve([(-0.006, 0.024), (0.000, 0.026), (0.006, 0.024)],
                  segments=12, squash=0.55), P["brass"], bevel=False)
    p.add(revolve([(-0.036, 0.021), (-0.030, 0.024), (-0.014, 0.024),
                   (-0.010, 0.021)], segments=12, squash=0.62),
          P["iron"], bevel=False)

    # tsuka: straight, slight taper, tangent-continuous with the blade
    p.add(revolve([(-0.300, 0.0175), (-0.288, 0.0195), (-0.180, 0.0200),
                   (-0.060, 0.0192), (-0.014, 0.0180)],
                  segments=12, squash=0.66), P["ray"], bevel=False)
    p.add(revolve([(-0.308, 0.0165), (-0.299, 0.0205), (-0.282, 0.0205),
                   (-0.274, 0.0180)], segments=12, squash=0.68),
          P["iron"], bevel=False)

    # tsuka-ito: two counter-wound cords make the diamond wrap
    def tspine(t):
        return (0.0, -0.292 + t * 0.268)

    for phase, turns in ((0.0, 8), (math.pi * 0.5, -8)):
        p.add(tube(helix(tspine, lambda t: 0.0200 - 0.0012 * t, turns,
                         phase, 46), lambda u: 0.0042, segments=5,
                   caps=False),
              P["wrap"], bevel=False)
    # menuki
    for z, y in ((-0.230, 0.013), (-0.120, -0.013)):
        p.add(dome((0.0, y, z), (0.010, 0.006, 0.014), rings=3, segments=8,
                   hemi=False, matrix=None), P["brass"], bevel=False)

    tip = path[-1][1]
    write(p, root, "weapon_katana.glb")
    SPECS.append(("katana", -0.060, -0.250, tip))


if __name__ == "__main__":
    build_longsword()
    build_daneaxe()
    build_greatsword()
    build_warhammer()
    build_spear()
    build_katana()
    print("\n[art-of-battle] grip specs (exported glTF frame, +Y along weapon)")
    for name, lead, rear, tip in SPECS:
        print(f"  {name:<11} {{ lead: [0, {lead:.3f}, 0], "
              f"rear: [0, {rear:.3f}, 0], length: {tip:.3f} }}")
