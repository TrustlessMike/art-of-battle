# Asset contract — art-of-battle

All assets are authored procedurally by Blender python scripts in `tools/`,
exported as **GLB** into `public/models/`. Units = meters, Y-up (glTF export
converts from Blender Z-up automatically — author in Blender's Z-up).

Characters face **+Z** in glTF space (Blender: -Y forward is the export default,
so author the character facing **-Y** in Blender).

## Character rigs (`knight_warden.glb`, `knight_raider.glb`)

Rigid-part hierarchy built from **Empties** (joints) with **Meshes** parented to
them. Node names must match EXACTLY — the game looks them up by name.

```
Root                      (0, 0, 0)          feet on ground
└─ Hips                   y=0.98
   ├─ Torso               y=0.98 (pivot at hips)
   │  ├─ Head             y=1.56
   │  ├─ ShoulderL        (+0.20, 1.44, 0)
   │  │  └─ ElbowL        local (0, -0.29, 0)
   │  │     └─ HandL      local (0, -0.27, 0)
   │  │        └─ GripL   local (0, -0.04, 0)   weapon mount
   │  └─ ShoulderR        (-0.20, 1.44, 0)
   │     └─ ElbowR        local (0, -0.29, 0)
   │        └─ HandR      local (0, -0.27, 0)
   │           └─ GripR   local (0, -0.04, 0)   weapon mount
   ├─ HipL                (+0.11, 0.94, 0)
   │  └─ KneeL            local (0, -0.44, 0)
   │     └─ FootL         local (0, -0.44, 0)
   └─ HipR                (-0.11, 0.94, 0)
      └─ KneeR            local (0, -0.44, 0)
         └─ FootR         local (0, -0.44, 0)
```

Rest pose: arms straight down, legs straight, character standing upright.
The game rotates these nodes procedurally; meshes must be parented so they
rotate correctly about the joint origin.

Mesh naming: `M_<Joint>` (e.g. `M_Torso`, `M_ArmL_Upper` under ShoulderL).

## Weapons (`weapon_longsword.glb`, `weapon_daneaxe.glb`)

Root node `Weapon`. **Grip at origin**, blade extends along **+Y**, edge faces
+X/-X. Total length: longsword 1.35m, dane axe 1.55m. The game parents the
`Weapon` node under `GripR`.

## Arena (`arena.glb`)

Static geometry, origin at the centre of a circular fighting floor of radius
**11m**, floor top surface at **y = 0**. Nothing may intrude inside radius 9.5m
above y=0 (that's the play space). Faces no particular direction.

## Materials

Use Principled BSDF with baseColor / metallic / roughness only (no textures —
glTF exports them as PBR factors). Keep total triangles under ~40k per file.
