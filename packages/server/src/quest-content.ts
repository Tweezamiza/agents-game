import { QuestDef, Vec2 } from "@agentworld/protocol";

/**
 * Quest content — the hand-authored Emberfall Isle story campaign, the
 * rotating side-quest templates, and named places for explore objectives.
 * Definitions are code; per-player progress lives in QuestState (quests.ts).
 */

/** Named places for explore objectives (centres of terrain features). */
export const PLACES: Record<string, { name: string; pos: Vec2 }> = {
  highland_summit: { name: "the highland summit", pos: { x: 168, z: 158 } },
  meadow_basin: { name: "the meadow basin", pos: { x: 79, z: 86 } },
};

/** Reaching within this many units of a named place completes an explore step. */
export const EXPLORE_RADIUS = 12;

/**
 * The main campaign: 8 quests chained by `requires`, from kindling to the
 * rekindled ward. Each `story` is the giver speaking, in character.
 */
export const STORY_QUESTS: QuestDef[] = [
  {
    id: "kindling",
    title: "Kindling",
    giver: "Elder Maren",
    story:
      "Every fire on this isle began as an armful of wood, child. Walk the groves, " +
      "take five boughs, and learn the shape of the land while you carry them — " +
      "Emberfall gives to those who bring kindling.",
    objective: { kind: "gather", target: "wood", qty: 5 },
    rewardShards: 15,
    rewardXp: 20,
  },
  {
    id: "smiths_due",
    title: "The Smith's Due",
    giver: "Hob the smith",
    story:
      "Maren sent you? Good. Raw boughs are no use to me — work them into planks, " +
      "two of them, and I'll know your hands are worth teaching.",
    objective: { kind: "craft", target: "plank", qty: 2 },
    rewardShards: 20,
    rewardXp: 25,
    requires: "kindling",
  },
  {
    id: "boar_trouble",
    title: "Boar Trouble",
    giver: "Nessa the fisher",
    story:
      "Boars have rooted up my garden two nights running — fat, fearless things " +
      "out of the meadow basin. Send a couple into the next life and keep the " +
      "hides; you'll want them sooner than you think.",
    objective: { kind: "kill", target: "boar", qty: 2 },
    rewardShards: 25,
    rewardXp: 40,
    rewardItems: { hide: 2 },
    requires: "smiths_due",
  },
  {
    id: "leatherbound",
    title: "Leatherbound",
    giver: "Hob the smith",
    story:
      "Nessa's hides, my pattern: three stitched together make a coat that turns " +
      "a wolf's tooth. Craft yourself leather armor before you take one step up " +
      "the north road.",
    objective: { kind: "craft", target: "leather_armor", qty: 1 },
    rewardShards: 30,
    rewardXp: 50,
    requires: "boar_trouble",
  },
  {
    id: "wolves_between",
    title: "The Wolves Between",
    giver: "Elder Maren",
    story:
      "The road to the highland is cut — wolves between us and the high stones, " +
      "bolder every dusk. Thin the pack by three, and the whole isle will breathe " +
      "easier for it.",
    objective: { kind: "kill", target: "wolf", qty: 3 },
    rewardShards: 45,
    rewardXp: 75,
    requires: "leatherbound",
  },
  {
    id: "high_stones",
    title: "The High Stones",
    giver: "Elder Maren",
    story:
      "Something stirs the golems on the summit; the shrine's embers gutter " +
      "whenever they wake. Climb the north-east heights and see with your own " +
      "eyes what I only feel in the fire.",
    objective: { kind: "explore", target: "highland_summit", qty: 1 },
    rewardShards: 40,
    rewardXp: 60,
    requires: "wolves_between",
  },
  {
    id: "heart_of_stone",
    title: "Heart of Stone",
    giver: "Elder Maren",
    story:
      "So the stones do walk. Break one open, child — at its heart sleeps a core " +
      "of old ember, and we will need more than one before the end.",
    objective: { kind: "kill", target: "golem", qty: 1 },
    rewardShards: 70,
    rewardXp: 100,
    rewardItems: { golem_core: 1 },
    requires: "high_stones",
  },
  {
    id: "ward_rekindled",
    title: "The Ward Rekindled",
    giver: "Elder Maren",
    story:
      "Bind a golem's heart into a ward totem, raise it on a banner over land you " +
      "claim, and the old protection will burn again. Do this, and Emberfall will " +
      "remember your name the way I will.",
    objective: { kind: "build", target: "banner", qty: 1 },
    rewardShards: 150,
    rewardXp: 200,
    requires: "heart_of_stone",
  },
];

/** Inclusive integer in [lo, hi] from a unit rng. */
function between(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Side-quest templates for the rotating village board. Each draws a
 * level-appropriate quantity and scales rewards from it.
 */
export const SIDE_TEMPLATES: ((rng: () => number) => Omit<QuestDef, "id">)[] = [
  (rng) => {
    const qty = between(rng, 2, 4);
    return {
      title: "Bounty: Boars",
      giver: "Nessa the fisher",
      story: `The meadow boars breed faster than I can mend fences. ${qty} fewer would do nicely.`,
      objective: { kind: "kill", target: "boar", qty },
      rewardShards: 7 * qty,
      rewardXp: 12 * qty,
      side: true,
    };
  },
  (rng) => {
    const qty = between(rng, 2, 3);
    return {
      title: "Bounty: Wolves",
      giver: "Garrick the guard",
      story: `Wolves shadowing the forest road again. Put down ${qty} and travellers sleep sounder.`,
      objective: { kind: "kill", target: "wolf", qty },
      rewardShards: 12 * qty,
      rewardXp: 20 * qty,
      side: true,
    };
  },
  (rng) => {
    const qty = between(rng, 6, 10);
    return {
      title: "Timber for the Village",
      giver: "Hob the smith",
      story: `The woodpile's down to splinters. Bring in ${qty} wood and the forge stays lit.`,
      objective: { kind: "gather", target: "wood", qty },
      rewardShards: 2 * qty,
      rewardXp: 3 * qty,
      side: true,
    };
  },
  (rng) => {
    const qty = between(rng, 6, 10);
    return {
      title: "Stone for the Walls",
      giver: "Hob the smith",
      story: `Good highland stone, ${qty} pieces — the village wall won't mend itself.`,
      objective: { kind: "gather", target: "stone", qty },
      rewardShards: 2 * qty,
      rewardXp: 3 * qty,
      side: true,
    };
  },
  (rng) => {
    const qty = between(rng, 2, 3);
    return {
      title: "Embers for the Shrine",
      giver: "Elder Maren",
      story: `The shrine fire dims. ${qty} ember crystals from the low meadows will feed it a while.`,
      objective: { kind: "gather", target: "ember_crystal", qty },
      rewardShards: 12 * qty,
      rewardXp: 10 * qty,
      side: true,
    };
  },
  (rng) => {
    const qty = between(rng, 3, 5);
    return {
      title: "Planks on Order",
      giver: "Hob the smith",
      story: `An order came in for ${qty} planks and my back's not what it was. Work the saw for me.`,
      objective: { kind: "craft", target: "plank", qty },
      rewardShards: 5 * qty,
      rewardXp: 6 * qty,
      side: true,
    };
  },
  (rng) => {
    const qty = between(rng, 2, 4);
    return {
      title: "Bricks on Order",
      giver: "Hob the smith",
      story: `${qty} bricks, fired square and true. The kiln's yours if your arms are.`,
      objective: { kind: "craft", target: "brick", qty },
      rewardShards: 6 * qty,
      rewardXp: 7 * qty,
      side: true,
    };
  },
  () => ({
    title: "A Light in the Wilds",
    giver: "Elder Maren",
    story: "Raise a campfire out in the dark places — every flame on this isle is a small ward against it.",
    objective: { kind: "build", target: "campfire", qty: 1 },
    rewardShards: 20,
    rewardXp: 25,
    side: true,
  }),
];
