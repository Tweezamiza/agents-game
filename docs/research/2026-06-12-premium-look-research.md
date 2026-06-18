# Research: The best path to a premium dark-fantasy look (June 12, 2026)

*Three parallel research agents; ~30 sources each; key claims cited inline. Confidence: High on licensing and ecosystem facts; price ranges are market estimates.*

## Executive summary

1. **No complete open-source 3D game gives us premium dark fantasy.** Exactly one fully-libre complete MMORPG exists — **Ryzom Core** (AGPL code, CC-BY-SA art, still maintained 2026) — but its art is 2004-vintage sci-fantasy jungle, honestly graded **B–**. Veloren (7.3k★) is voxel (excluded aesthetic). Everything else fails on proprietary assets (OpenMW, Daggerfall Unity, PlaneShift, Eternal Lands, MU/WoW emulators), deadness (WorldForge, OpenDungeons), or dimension (FLARE is 2D).
2. **The only free AAA dark-fantasy art is Epic's Paragon ($17M of content) + Infinity Blade packs — but they are contractually "UE-Only Content"** (https://www.unrealengine.com/eula/content). Using them means rebuilding the game in Unreal Engine: 6–12 months solo, losing the browser entirely (UE has no web target). Using them in Babylon.js would violate the EULA.
3. **The MU Online look is UNDER the browser's 2026 ceiling, not above it.** Proof: **Flyff Universe** — a real commercial anime-fantasy MMORPG running in browser tabs since 2022 with 250k+ players (https://universe.flyff.com). Someone is literally rebuilding MU Online itself in Babylon.js (https://github.com/afrokick/muonlinejs). Babylon.js 8 ships glow layers, IBL shadows, area lights, god rays, GPU particles; WebGPU is at ~82% browser support with WebGL2 fallback. Realistic budget: 30–80 unique animated characters (200–500 instanced) at 60fps; 100–300MB of assets streamable per zone (KTX2 + meshopt).
4. **The gap is art, not tech — and art is purchasable + AI-restylable in 2026:**
   - Character/creature packs from Unity Asset Store and CGTrader are **legally usable outside Unity** (https://support.unity.com/hc/en-us/articles/34387186019988) — $300–600 for a full roster.
   - **Meshy Pro ($20/mo)**: text → 3D → auto-rig → animated GLB straight into Babylon; you own outputs. Best current text-to-rigged-boss pipeline (grade B, needs 1–3h Blender polish per hero asset).
   - **Meshy Retexture / StableProjectorz (free, local)**: restyle bought/low-poly meshes into ONE coherent painterly dark-fantasy direction (LoRA-able).
   - Environments: KitBash3D **Dark Fantasy** kit (Cargo $59/mo, cancel after one month), Quixel Megascans free drops on Fab.
   - Animation: **Mixamo is still free in 2026** (https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html); AccuRig 2 free for non-humanoids; UniRig (open) for monsters.
   - **Avoid:** Paragon/Infinity Blade outside UE; Tripo3D free tier (non-commercial); Hunyuan3D (license void in EU/UK/KR — landmine for a web game); Luma Genie (abandoned-tier).
5. **Budget for the full visual reboot: ~$500–1,200 one-off + ~$30–50/mo.**

## Verdict

| Path | Visual ceiling | Effort | Keeps AI citizens? | Publishable? |
|---|---|---|---|---|
| **Stay Babylon.js + bought assets + AI restyle + MU-style post-processing** | **B+/A–** (exactly the MU/Diablo-stylized bar) | Weeks, incremental | Yes, untouched | Yes, fully ours |
| Unreal 5 + Paragon/Infinity Blade | A+ native | 6–12 mo rewrite; browser abandoned; AI agents weakest in UE (binary Blueprints, cook times) | Port needed | Yes (UE-locked, 5% royalty >$1M) |
| Godot 4.x web | C+ on web (WebGL2-only Compatibility renderer) | 3–6 mo rewrite | Port needed | Yes |
| Ryzom Core | B– (dated, wrong aesthetic) | Gnarly C++ shard stack | Re-integration | Yes (AGPL/CC-BY-SA copyleft) |
| MU/WoW private servers (OpenMU, AzerothCore) | A content | Low | Via bots | **NO — proprietary clients/assets** |

**Recommendation: stay on Babylon.js.** The browser MU-look slot is provably achievable (Flyff) and commercially empty. The unique asset — LLM-driven AI citizens — survives intact, and AI coding agents are at maximum effectiveness in a TypeScript codebase.

## The concrete plan ("Operation Ember Dark")

1. **Look pass first (free, 1 sprint):** locked MU-style camera option, night/dusk atmosphere, GlowLayer on gear/crystals/ember effects, volumetric god rays at the shrine, fog, baked-light feel, three.quarks-class skill VFX.
2. **Asset starter kit (~$150–300):** 2–3 dark-fantasy character packs (CGTrader/Unity AS), one dungeon/castle environment kit, weapon pack. Extract → glTF → KTX2 pipeline.
3. **Meshy Pro ($20/mo):** regenerate Bonelord Vekk as a proper dark-fantasy boss + 2–3 more bosses/creatures, auto-rigged, restyled to match.
4. **Style unification:** StableProjectorz/Meshy Retexture pass so everything reads as one art direction.

## Source-quality flags

Single-source/unverified: Fab giveaway cadence; Rodin free-tier commercial rights; Paragon UE-only label removal on Fab (forum thread, no Epic confirmation); Hytopia metrics; 2GB→50MB KTX2 ratio; skeletal animation budgets (forum triangulation); marketplace price ranges (estimates).

## Full agent reports

(Stored in the session transcript of 2026-06-12; ask Claude to re-export if needed.)

---

# Addendum (same day): The FREE creation pipeline — user was right, it exists

## The bombshell: MetaHuman is free for ANY engine since June 2025

Epic changed the MetaHuman license at State of Unreal (June 3, 2025): the "UE-Only" clause was **deleted** (https://www.unrealengine.com/en-US/eula-change-log/content, https://www.metahuman.com/license). MetaHumans — AAA film-grade rigged realistic humans — are now usable **commercially in any engine including Babylon.js**, free under $1M/yr revenue, no royalty (they count as "Non-Engine Products"). You can even sell them. Creation happens inside the free Unreal editor (5.6+/5.7, the old web app dies Nov 2026); export FBX/glTF → Blender → Babylon. Caveats: film-density meshes need LOD/optimization for web; wardrobe is modern (fantasy armor must be made/fitted); NEVER feed MetaHuman data into AI training (the one hard restriction).

## The verified $0 pipelines

**Humans/heroes (grade A):** MetaHuman (free UE editor) → FBX → Blender LOD pass → glTF → Babylon. Animations: Mixamo (still free 2026) + CMU mocap (2,500 clips, commercial OK).
**Fallback without UE (grade C+):** MPFB2 or CharMorph in Blender — outputs CC0, fully open.
**Monsters/bosses (grade B with polish):** concept image → **TRELLIS.2-4B** (Microsoft, MIT license incl. weights, PBR GLB output) → Blender retopo → **UniRig** (MIT, verified at LICENSE) auto-skeleton+skinning → retarget CC0 animations (Quaternius Universal Animation Library / KayKit / CMU) → glTF. Every link MIT/CC0. Note: TRELLIS.2 needs an NVIDIA GPU — use the free HuggingFace Space per-asset or rent a cloud GPU (~$1/session); Macs can't run it locally.
**Environments (grade A- achievable):** Poly Haven (CC0: 767 textures, 972 HDRIs incl. 59 night skies, 456 models) + ambientCG (CC0, 2000+ PBR) + **Smithsonian Open Access** (~2,350 CC0 museum scans as glTF — real statues/reliefs for instant premium ruins) + Three D Scans statues + Gaea Community (1K heightmaps, commercial OK) + Tree It + Blender geo-node rock/tree generators + Material Maker 1.6 (MIT, procedural gothic trim sheets).
**VFX (grade A-):** Babylon's Node Particle Editor + GPU particles + CC0 flipbooks (Unity Labs VFX sequences, CGHEVEN fire, Kenney particle pack). NOTE: three.quarks is three.js-only — skip; lygia shader lib is NOT free for commercial (Prosperity license) — avoid.
**Audio:** Freesound CC0 + OpenGameArt dungeon ambience packs.

## Confirmed traps (look free, aren't)
DAZ outputs (per-asset Interactive License, fatal for extractable web assets) · Bandai Namco mocap (non-commercial) · Blockade Labs Skybox free tier (CC-BY-NC) · BlenderKit "Royalty-Free" tier (forbids extractable distribution = web games) · Truebones (unverifiable license) · Cascadeur free tier (no FBX export, non-commercial) · Hunyuan3D (license void in EU/UK/KR).
