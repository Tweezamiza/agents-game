import {
  type AnimationGroup,
  type AssetContainer,
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  PointLight,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { MOBS, type MobKind, type MobPublic } from "@agentworld/protocol";

const DEATH_MS = 1100;
const SPAWN_POP_MS = 450;
const HIT_FLASH_MS = 280;
const SNAP_DISTANCE = 8;
/** Name tags fade out beyond this camera distance (no haunted horizon bars). */
const TAG_VIEW_RANGE = 55;

/** Tag height above the ground per kind (heavier undead stand taller). */
const TAG_HEIGHTS: Record<MobKind, number> = { boar: 1.7, wolf: 2.0, golem: 2.9, bonelord: 3.6 };

/** Body scale per kind — the bestiary is now coherent KayKit undead. */
const MOB_SCALE: Record<MobKind, number> = { boar: 0.85, wolf: 1.0, golem: 1.45, bonelord: 1.8 };

interface MobVisual {
  root: TransformNode;
  meshes: Mesh[];
  tag: Mesh;
  hp: number;
  /** Latest authoritative server position (lerp target). */
  target: Vector3;
  facingY: number;
  flashUntil: number;
  /** performance.now() until which the death fall/fade plays; then dispose. */
  dyingUntil: number;
  bornAt: number;
  /** Walk/idle/death animation groups + the one currently playing. */
  idle: AnimationGroup | null;
  walk: AnimationGroup | null;
  death: AnimationGroup | null;
  current: AnimationGroup | null;
  /** performance.now() until which the mob counts as moving (plays walk). */
  movingUntil: number;
}

/**
 * Mob rendering: every creature is a coherent KayKit skeleton model (the same
 * art family as the player knight), scaled and named per kind, interpolated
 * from 10 Hz frames. The undead bestiary matches the dark-fantasy isle.
 */
export class MobLayer {
  private readonly visuals = new Map<string, MobVisual>();

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator | null,
    private readonly groundY: (x: number, z: number) => number,
    /** Resolves the loaded character container for a kind (may still load). */
    private readonly containerFor: (kind: MobKind) => AssetContainer | null = () => null,
  ) {}

  has(id: string): boolean {
    return this.visuals.has(id);
  }

  positionOf(id: string): Vector3 | null {
    return this.visuals.get(id)?.root.position ?? null;
  }

  /** Apply a 10 Hz frame: spawn-pop new mobs, retarget the living. */
  update(mobs: MobPublic[]): void {
    const now = performance.now();
    const seen = new Set<string>();
    for (const m of mobs) {
      seen.add(m.id);
      let mv = this.visuals.get(m.id);
      if (!mv) {
        const created = this.create(m, now);
        if (!created) continue;
        mv = created;
        this.visuals.set(m.id, mv);
      }
      const y = this.groundY(m.pos.x, m.pos.z);
      const dx = m.pos.x - mv.target.x;
      const dz = m.pos.z - mv.target.z;
      if (Math.hypot(dx, dz) > 0.05) {
        mv.facingY = Math.atan2(dx, dz);
        // Mobs step on the 1 s server tick and lerp across it; keep walking a
        // touch past one tick so continuous movers never flicker back to idle.
        mv.movingUntil = now + 1200;
      }
      mv.target.set(m.pos.x, y, m.pos.z);
      if (m.hp !== mv.hp) {
        mv.hp = m.hp;
        this.drawTag(mv.tag, MOBS[m.kind].name, m.level, m.hpMax > 0 ? m.hp / m.hpMax : 0);
      }
    }
    // Mobs absent from the frame are dead — fall/fade unless already dying.
    for (const [id, mv] of this.visuals) {
      if (!seen.has(id) && mv.dyingUntil === 0) mv.dyingUntil = now + DEATH_MS;
    }
  }

  /** Red flash on hit; the death fade itself is driven by frame absence. */
  hit(id: string): void {
    const mv = this.visuals.get(id);
    if (mv) mv.flashUntil = performance.now() + HIT_FLASH_MS;
  }

  /** Per-frame: lerp, spawn pop, death fall/fade, flash overlays. */
  animate(now: number, lerpFactor: number): void {
    for (const [id, mv] of this.visuals) {
      if (mv.dyingUntil > 0) {
        this.play(mv, mv.death, false);
        const t = 1 - (mv.dyingUntil - now) / DEATH_MS;
        if (t >= 1) {
          mv.root.dispose(false, true);
          this.visuals.delete(id);
          continue;
        }
        // If the rig has no death clip, fall over; otherwise let it play.
        if (!mv.death) mv.root.rotation.x = t * (Math.PI / 2) * 0.6;
        const fade = Math.max(0, 1 - Math.max(0, t - 0.35) / 0.65);
        for (const m of mv.meshes) m.visibility = fade;
        mv.tag.visibility = fade;
        continue;
      }

      // Walk while the server is still advancing the mob; idle once it stops.
      this.play(mv, now < mv.movingUntil ? mv.walk ?? mv.idle : mv.idle, true);
      const pop = Math.min(1, (now - mv.bornAt) / SPAWN_POP_MS);
      const scale = 0.4 + 0.6 * (1 - (1 - pop) * (1 - pop));
      mv.root.scaling.setAll(scale);

      if (Vector3.Distance(mv.root.position, mv.target) > SNAP_DISTANCE) {
        mv.root.position.copyFrom(mv.target);
      } else {
        Vector3.LerpToRef(mv.root.position, mv.target, lerpFactor, mv.root.position);
      }
      let dy = mv.facingY - mv.root.rotation.y;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      mv.root.rotation.y += dy * lerpFactor;

      const flashing = now < mv.flashUntil;
      for (const m of mv.meshes) m.renderOverlay = flashing;

      const cam = this.scene.activeCamera;
      if (cam) mv.tag.isVisible = Vector3.Distance(cam.position, mv.root.position) < TAG_VIEW_RANGE;
    }
  }

  // -------------------------------------------------------------------------

  private create(m: MobPublic, now: number): MobVisual | null {
    const built = this.createSkeletonMob(m);
    if (!built) return null; // container still loading — retried next frame
    const clone = built.node;
    const meshes: Mesh[] = [];
    for (const mesh of clone.getChildMeshes()) {
      if (!(mesh instanceof Mesh)) continue;
      mesh.isPickable = true;
      mesh.metadata = m.id;
      mesh.overlayColor = new Color3(0.9, 0.1, 0.1);
      mesh.overlayAlpha = 0.55;
      mesh.outlineColor = new Color3(0.95, 0.78, 0.4);
      mesh.outlineWidth = 0.012;
      this.shadows?.addShadowCaster(mesh);
      meshes.push(mesh);
    }
    const y = this.groundY(m.pos.x, m.pos.z);
    clone.position.set(m.pos.x, y, m.pos.z);

    const tag = MeshBuilder.CreatePlane(`mobTag:${m.id}`, { width: 2.2, height: 0.75 }, this.scene);
    tag.parent = clone;
    tag.position.y = TAG_HEIGHTS[m.kind];
    tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    tag.isPickable = false;
    tag.applyFog = false;
    this.drawTag(tag, MOBS[m.kind].name, m.level, m.hpMax > 0 ? m.hp / m.hpMax : 0);

    return {
      root: clone,
      meshes,
      tag,
      hp: m.hp,
      target: new Vector3(m.pos.x, y, m.pos.z),
      facingY: Math.random() * Math.PI * 2,
      flashUntil: 0,
      dyingUntil: 0,
      bornAt: now,
      idle: built.idle,
      walk: built.walk,
      death: built.death,
      current: built.idle,
      movingUntil: 0,
    };
  }

  private drawTag(tag: Mesh, name: string, level: number, hpFrac: number): void {
    tag.material?.dispose(false, true);
    const tex = new DynamicTexture(`mobTagTex:${tag.name}`, { width: 384, height: 128 }, this.scene, true);
    tex.hasAlpha = true;
    tex.drawText(`${name} · ${level}`, null, 56, "bold 40px Georgia", "#e8b9a0", null, true, false);
    const frac = Math.max(0, Math.min(1, hpFrac));
    const ctx = tex.getContext();
    ctx.fillStyle = "rgba(10, 8, 16, 0.85)";
    ctx.fillRect(92, 78, 200, 18);
    ctx.fillStyle = `hsl(${Math.round(120 * frac)}, 75%, 45%)`;
    ctx.fillRect(94, 80, 196 * frac, 14);
    tex.update();
    const mat = new StandardMaterial(`mobTagMat:${tag.name}`, this.scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    tag.material = mat;
  }

  /**
   * Every mob is a KayKit skeleton model, scaled per kind, idling on its rig.
   * Returns null while the container is still streaming (retried next frame).
   * The Bonelord additionally carries an ember glow light.
   */
  private createSkeletonMob(
    m: MobPublic,
  ): { node: TransformNode; idle: AnimationGroup | null; walk: AnimationGroup | null; death: AnimationGroup | null } | null {
    const container = this.containerFor(m.kind);
    if (!container) return null;
    const entries = container.instantiateModelsToScene((n) => `${m.id}:${n}`, false, {
      doNotInstantiate: true,
    });
    const node = new TransformNode(`mob:${m.id}`, this.scene);
    const scale = MOB_SCALE[m.kind];
    for (const r of entries.rootNodes) {
      r.parent = node;
      if (r instanceof TransformNode) r.scaling.setAll(scale);
    }
    // Ground the feet — KayKit rigs don't sit at y=0.
    node.computeWorldMatrix(true);
    const bounds = node.getHierarchyBoundingVectors(true);
    const lift = Number.isFinite(bounds.min.y) ? -bounds.min.y : 0;
    for (const r of entries.rootNodes) {
      if (r instanceof TransformNode) r.position.y += lift;
    }
    const groups = entries.animationGroups;
    for (const g of groups) g.stop();
    const find = (frag: string): AnimationGroup | null =>
      groups.find((g) => g.name === frag || g.name.endsWith(`:${frag}`)) ??
      groups.find((g) => g.name.includes(frag)) ??
      null;
    const idle = find("Idle") ?? groups[0] ?? null;
    const walk = find("Walking_A") ?? find("Running_A") ?? find("Walk") ?? null;
    const death = find("Death_A") ?? find("Death") ?? null;
    idle?.start(true);

    if (m.kind === "bonelord") {
      const glow = new PointLight(`bossGlow:${m.id}`, new Vector3(0, 2.4, 0), this.scene);
      glow.diffuse = new Color3(1.0, 0.45, 0.15);
      glow.intensity = 0.85;
      glow.range = 10;
      glow.parent = node;
    }
    return { node, idle, walk, death };
  }

  /** Crossfade-free animation swap: stop the current group, start the next. */
  private play(mv: MobVisual, next: AnimationGroup | null, loop: boolean): void {
    if (!next || mv.current === next) return;
    mv.current?.stop();
    next.start(loop, 1);
    mv.current = next;
  }
}
