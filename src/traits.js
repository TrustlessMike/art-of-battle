/**
 * Character building: archetypes and perks.
 *
 * Everything here resolves into one flat modifier object that the fighter,
 * the duel and the gadget layer read. Nothing is cosmetic and nothing is a
 * hidden multiplier on the opponent — an archetype changes how *you* fight, so
 * two players who picked differently are playing recognisably different games.
 */

/**
 * Archetypes. Each one is defined by what it lets you do, not by a stat bump:
 * chain depth, how long your guard holds, how forgiving your parry is.
 */
export const ARCHETYPES = {
  vanguard: {
    name: 'Vanguard',
    blurb: 'Balanced. Three-hit chains.',
    detail: 'No weakness, no trick. Chains light into light into heavy.',
    mods: { chainDepth: 3 },
  },
  bulwark: {
    name: 'Bulwark',
    blurb: 'Blocking costs nothing. Slow.',
    detail: 'Holds the line. Blocked heavies do not drain you, and a matched '
      + 'guard turns aside a fifth of the damage — but every swing is slower.',
    mods: {
      windupMul: 1.14, blockStaminaMul: 0, guardReduction: 0.20,
      chainDepth: 2, healthMul: 1.08,
    },
  },
  berserker: {
    name: 'Berserker',
    blurb: 'Faster as you bleed.',
    detail: 'Swings 12% quicker, and hits harder the closer you are to death — '
      + 'but you have less to give.',
    mods: {
      windupMul: 0.88, damageMul: 1.05, healthMul: 0.86,
      woundedDamage: 0.35, chainDepth: 3,
    },
  },
  skirmisher: {
    name: 'Skirmisher',
    blurb: 'Evasive. Cheap, long dodges.',
    detail: 'Longer invulnerability on a dodge at half the stamina, and quicker '
      + 'on your feet — but you hit lighter.',
    mods: {
      dodgeIFrameMul: 1.45, dodgeCostMul: 0.55, speedMul: 1.08,
      damageMul: 0.90, chainDepth: 2,
    },
  },
  duellist: {
    name: 'Duellist',
    blurb: 'Punishing parries.',
    detail: 'A far more forgiving parry window, and staggered opponents take '
      + 'much more from you — but you are fragile.',
    mods: {
      parryWindowMul: 1.5, staggeredDamageMul: 1.4, healthMul: 0.92,
      chainDepth: 2,
    },
  },
};

/** Perks. Two are chosen; they stack onto the archetype. */
export const PERKS = {
  none: { name: '—', blurb: 'No perk', mods: {} },
  ironclad: {
    name: 'Ironclad', blurb: 'Matched guard sheds 15% damage',
    mods: { guardReduction: 0.15 },
  },
  secondwind: {
    name: 'Second Wind', blurb: 'A parry restores 25 stamina',
    mods: { staminaOnParry: 25 },
  },
  sapper: {
    name: 'Sapper', blurb: '+1 breach charge',
    mods: { gadgetBonus: { breach: 1 } },
  },
  quartermaster: {
    name: 'Quartermaster', blurb: '+1 barricade, +1 reinforcement',
    mods: { gadgetBonus: { barricade: 1, reinforce: 1 } },
  },
  executioner: {
    name: 'Executioner', blurb: '+30% damage to staggered foes',
    mods: { staggeredDamageMul: 1.3 },
  },
  lightfoot: {
    name: 'Lightfoot', blurb: '+10% movement speed',
    mods: { speedMul: 1.10 },
  },
  enduring: {
    name: 'Enduring', blurb: '+25% stamina recovery',
    mods: { staminaRegenMul: 1.25 },
  },
  keeneye: {
    name: 'Keen Eye', blurb: '+25% parry window',
    mods: { parryWindowMul: 1.25 },
  },
};

const DEFAULTS = {
  windupMul: 1,
  damageMul: 1,
  healthMul: 1,
  speedMul: 1,
  parryWindowMul: 1,
  dodgeIFrameMul: 1,
  dodgeCostMul: 1,
  blockStaminaMul: 1,
  staminaRegenMul: 1,
  staggeredDamageMul: 1,
  guardReduction: 0,       // fraction of damage shed on a matched guard
  woundedDamage: 0,        // extra damage at zero health, scaled by missing hp
  staminaOnParry: 0,
  chainDepth: 2,           // how many attacks a chain can run to
  gadgetBonus: {},
};

/**
 * Combine an archetype and its perks into one modifier set.
 *
 * Multipliers multiply, flat bonuses add, and `guardReduction` combines
 * multiplicatively so stacking two sources can never reach total immunity.
 */
export function resolveTraits(archetypeKey, perkKeys = []) {
  const out = { ...DEFAULTS, gadgetBonus: {} };
  const sources = [ARCHETYPES[archetypeKey]?.mods]
    .concat(perkKeys.map((k) => PERKS[k]?.mods))
    .filter(Boolean);

  for (const mods of sources) {
    for (const [key, value] of Object.entries(mods)) {
      if (key === 'gadgetBonus') {
        for (const [g, n] of Object.entries(value)) {
          out.gadgetBonus[g] = (out.gadgetBonus[g] || 0) + n;
        }
      } else if (key === 'guardReduction') {
        // Diminishing: 20% then 15% leaves 68% getting through, not 65%.
        out.guardReduction = 1 - (1 - out.guardReduction) * (1 - value);
      } else if (key === 'chainDepth') {
        out.chainDepth = Math.max(out.chainDepth, value);
      } else if (key.endsWith('Mul')) {
        out[key] = (out[key] ?? 1) * value;
      } else {
        out[key] = (out[key] ?? 0) + value;
      }
    }
  }
  return out;
}

export const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);
export const PERK_KEYS = Object.keys(PERKS);
