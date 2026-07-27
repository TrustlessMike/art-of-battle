# Art of Battle

A browser game that puts *For Honor*'s melee duelling inside a *Rainbow Six
Siege* round structure: a three-direction guard where every exchange is decided
by reading the incoming blade — fought room to room through a fortified
compound you can barricade, reinforce and blow holes in.

All models are generated procedurally by Blender scripts. The game runs in
Three.js with no runtime dependency beyond `three`, and all sound is
synthesised at runtime — there are no audio files.

```bash
npm install
npm run dev      # http://localhost:5183
npm run assets   # regenerate every .glb from the Blender scripts
```

## The match

Best of five. One life each per round, and **sides swap every round**.

| Phase | Attacker | Defender |
|---|---|---|
| **Preparation** (25s) | Scout the compound from above | Barricade, reinforce, place traps |
| **Action** (150s) | Break the banner, or kill them | Hold the chapel, or kill them |

A round ends when the banner falls, someone dies, or the clock expires — the
defender wins a timeout.

## Controls

It is played in **first person**, and the mouse does two jobs depending on
whether you are locked on — free look when you are moving through the building,
guard control the moment an opponent is close and visible.

| Input | Action |
|---|---|
| Mouse (free) | Look around and steer |
| Mouse (locked on) | Set guard — up / left / right. It stays where you put it. |
| `Q` | Force free look, to break a lock and check an angle |
| Left click | Light attack in the current guard direction |
| Right click | Heavy attack — **hold** to charge it into an unblockable |
| Right click *on an incoming blade* | **Parry** |
| `E` | Guard break (also counters a guard break) |
| `Space` + WASD | Dodge |
| `F` | Feint out of a heavy windup |
| `WASD` | Move |
| `1`–`4` | Use utility (see below) |
| `G` | Graphics quality: high / medium / off |
| `1` `2` `3` before a match | Difficulty: Squire / Warrior / Warlord |
| `R` rematch · `P` pause | |

## Character building

Five **archetypes**, each defined by what it lets you *do* rather than a stat bump:

| Archetype | Identity |
|---|---|
| **Vanguard** | Balanced, three-hit chains |
| **Bulwark** | Blocking costs no stamina, matched guard sheds 20% — but slow |
| **Berserker** | 12% faster, and hits harder the closer to death it gets |
| **Skirmisher** | Long, cheap dodges; lighter hits |
| **Duellist** | 50% wider parry window, punishes the staggered — but fragile |

Plus two **perks** from nine (Ironclad, Second Wind, Sapper, Quartermaster,
Executioner, Lightfoot, Enduring, Keen Eye), which stack onto the archetype.
Perks reach outside combat too — Sapper gives you a third breach charge,
Quartermaster an extra barricade and reinforcement.

Everything resolves into one flat modifier set in `src/traits.js` that the
fighter, the duel and the gadget layer read. Multipliers multiply, flat bonuses
add, and guard reduction combines multiplicatively so stacking two sources can
never reach immunity.

Your opponent rolls a build of their own each match, and it is printed on their
nameplate — knowing you are facing a Bulwark rather than a Berserker should
change how you open.

## Attack chains

A swing that *connects* — landed or blocked — opens a chain window. The
follow-up winds up far faster, and the archetype sets how deep it runs.
Whiffing into thin air earns nothing.

| | Opener | Chained |
|---|---|---|
| Vanguard (depth 3) | 0.42s | **0.26s** |
| Berserker (depth 3) | 0.37s | **0.23s** |
| Bulwark (depth 2) | 0.48s | 0.30s |

A chained Berserker follow-up winds up in 229ms — at the edge of human
reaction. That is the pressure that makes the guard read matter.

## Character creation

Each match opens on a creation screen, with your fighter turning in the
courtyard: six armour kits, six weapons, eight heraldic colours and a name.
`W`/`S` picks a row, `A`/`D` changes it, `Enter` or `Space` takes the field.

Armour is not cosmetic — the tier trades health against speed (Mail 112hp/110%,
standard 130/100%, Plate 152hp/90%) and both feed the fight. The preview is the
real fighter on the real rig, so the reach it prints is the reach it will use.

Lock-on engages by itself when an opponent is within about 5m and you can
actually see them — your fighter then turns to face them, which is what frees
the mouse up for the guard. Arrow keys also set the guard, and `J`/`K` attack.
Pointer lock is used when available but is never required.

## Utility

**Attacker** — Breach Charge (opens a hole in *any* wall, including stone),
Smoke Pot (blocks line of sight).
**Defender** — Barricade (boards a door or window), Reinforce (hardens a timber
wall so blades cannot cut it), Caltrops (slows and bleeds), Alarm Bell (reveals
the attacker when tripped).

## How a fight resolves

Every attack has one resolution instant, and everything the defender can do is
expressed relative to it:

- **Guard matches** the attack direction → blocked, no damage.
- **Heavy pressed inside the parry window** (~0.26s before contact, guard
  matching) → parry. The attacker is staggered and eats a free heavy. Mistime it
  and your own heavy comes out instead — that is the risk.
- **Dodge i-frames** → whiff.
- **Anything else** → damage.

Guard breaks beat a passive guard but lose to an active swing. Stamina gates
everything; run it to zero and blocked heavies stagger you.

Difficulty changes the opponent's *reaction latency* and how often it reads
correctly — never its damage, and never its information. It sees the same
windup you do, and it cannot see you through a wall either.

## Debug toggles

Query parameters, so a change can be judged against itself on the same build:

| | |
|---|---|
| `?nobatch` | Skip material folding and draw-call batching |
| `?noao` | Skip the baked ambient occlusion |
| `?ao=0.3` | Bake AO at a different strength (default 0.55) |

## Design notes

**One source of truth for the level.** `src/layout.js` defines every wall,
opening, room and spawn. Gameplay reads it directly for collision, line of
sight, destruction and navigation, and `tools/export_layout.mjs` dumps it to
JSON that the Blender script builds the art *from*. The art cannot drift out of
sync with the collision because it is generated from the same numbers.

**Attacks are authored as blade paths, not joint angles.** The weapon hangs off
an anchor under the torso and each clip keyframes where the blade is and which
way it points; both arms are then solved onto grip points with two-bone IK.
Designing an attack means drawing the arc the blade should travel — which is
exactly the thing the player has to read.

**Reach and contact timing are measured, not tuned.** On construction each
fighter runs its own rig through every attack clip, samples the blade tip, and
derives the furthest distance at which every swing still grazes a chest, plus
the instant each swing is closest to it. That is why six very different weapons
all work on the same animations, and why swapping weapons re-measures rather
than re-tunes. An earlier analytic version of this disagreed with the rig and
quietly resolved hits ~2.8m from the target.

**Blade directions interpolate spherically.** A plain lerp between near-opposite
directions collapses through the origin, which made an overhead chop teleport
3m in one frame instead of sweeping.

**First person removes the indoor camera problem entirely.** A third-person
camera in a building full of 3.4m walls spends its life either inside geometry
or jammed against your back. Mounting the lens in the fighter's skull means
there is nothing to occlude — and the fighter's own helm is hidden so it does
not fill the view.

**Draw calls were the bottleneck, not the GPU.** The compound arrives from
Blender as one mesh per architectural piece — 612 of them — and the CPU spent
several times longer submitting them than the GPU spent drawing. Merging was
blocked by material fragmentation rather than by the geometry: 25 materials
differing only in colour, so no two meshes could share a call. Folding each
colour into a vertex-colour attribute lets everything with the same *surface
family and lighting response* share one material, which collapses the panels
and roughly halves the draw calls. Family is part of the fold key because
`materials.js` gives stone and timber different projected patterns, and two
surfaces with matching roughness stop being interchangeable once they do.

**Ambient occlusion is baked into those same vertex colours.** The world pass
draws the viewmodel into the same target, so a fullscreen AO pass would shade
the player's own hands with world depth. The compound never moves, so occlusion
is solved once at load against a voxelisation of the *collision* surfaces — the
AO then agrees with the geometry the game actually simulates.

The first bake turned every interior black. The instinct was that the floors
were too coarse to carry vertex shading, and tessellating them made it far
worse: `TessellateModifier` is recursive, so the ground quads multiplied 33k
vertices into 13M and the frame went to 36ms. Measuring afterwards showed the
premise was simply wrong — the flagstones average 0.001 m² per triangle, finer
than anything else in the scene, and the only coarse mesh is the floor bed
hidden underneath them. What the bake actually needed was a gentler strength
and a floor under the result, so that a fully occluded vertex reads as deep
shadow rather than as a hole. AO is still damped by local triangle size, which
matters for the mortar panels, but that was not the fix.

**Post-processing is one combined grade.** Bloom is thresholded so only fire,
sparks and blade glints pick it up — this is a dark scene and the mood has to
survive. Vignette, animated grain, chromatic aberration and the gameplay
signals (`damage`, `lowHealth`, `hitFlash`, `slowmo`) all live in a single
shader pass rather than five chained ones.

**The score is adaptive, and synthesised like everything else.** Layers fade
with a continuous intensity driven by proximity, engagement and how hurt you
are, and the state follows the round — menu, prep, stalk, combat, victory,
defeat. Notes are scheduled ahead on the audio clock, so a frame hitch cannot
make it stutter.

**The viewmodel is a second render pass.** Your own forearms, hands and weapon
live on their own layer, drawn after the world by a camera that sits *behind*
the eye — the fighter's hands are about 0.17m back from it, so no field of view
on the main camera could ever pull them into frame. Two things that pass has to
get right: `scene.background` must be cleared for it, because three repaints the
background on every `render()` regardless of `autoClear` and would otherwise
erase the world; and the viewmodel needs its own lights, because a light only
illuminates objects sharing its layer and every world light is on layer 0.

**Feet are planted in world space.** A cadence clock alternates the feet while
travelling and places each step ahead of where the body is going; near-stationary,
a foot only moves once it is genuinely out of position. Legs are IK'd onto those
world positions, so nothing skates.

**Destruction changes navigation.** The nav graph joins room centres through
openings. Breaking a panel adds an edge and barricading one removes it, so the
AI routes through the holes you make and around the ones you board up without
any of it being special-cased.

## Layout

```
index.html
src/
  main.js      bootstrap, loop, loadout, event → feedback wiring
  layout.js    the compound's authoritative geometry
  compound.js  runtime walls: collision, line of sight, destruction, barricades
  nav.js       waypoint graph, rebuilt as the building changes
  round.js     match structure: phases, roles, objective, win conditions
  gadgets.js   utility and its effects
  fighter.js   combat state machine, locomotion, rig driving, calibration
  combat.js    interaction rules (block / parry / guard break / damage)
  poses.js     animation library — guards, attack arcs, reactions
  rig.js       glTF rig binding, two-bone IK, weapon mounting
  ai.js        the opponent: duelling, navigation, fortification
  camera.js    first-person head-mounted camera, plus the third-person duel cam
  hud.js       guard indicator, vitals, feedback
  siegehud.js  round state, objective, utility, intel
  vfx.js       blade trails, sparks, impacts, dust
  world.js     scene, dusk lighting, braziers
  audio.js     fully synthesised SFX
tools/
  rigkit.py            Blender primitive/mesh helpers
  build_characters.py  six armour variants across two fighters
  build_weapons.py     six weapons
  build_compound.py    the compound, built from the layout JSON
  export_layout.mjs    layout.js -> compound_layout.json
  inspect_glb.py       node-tree / triangle-count inspector
ASSET_CONTRACT.md      the joint hierarchy the game depends on
```

Joint names, offsets and bone lengths are hard-coded on the JS side, so any
change to the rig has to happen in `ASSET_CONTRACT.md`, the Blender scripts and
`src/rig.js` together.
