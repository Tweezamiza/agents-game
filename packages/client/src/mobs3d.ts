import {
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

/** Tag height above the ground per kind (golems are tall). */
const TAG_HEIGHTS: Record<MobKind, number> = { boar: 1.7, wolf: 1.9, golem: 3.1, bonelord: 4.1 };

/** The Bonelord towers over the player characters (~1.8u tall). */
const BOSS_SCALE = 1.8;

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
}

/**
 * Mob rendering: characterful primitive composites (no fitting KayKit animal
 * meshes ship with the downloaded packs), interpolated from 10 Hz frames.
 */
export class MobLayer {
  private readonly visuals = new Map<string, MobVisual>();
  private readonly templates = new Map<MobKind, TransformNode>();

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator | null,
    private readonly groundY: (x: number, z: number) => number,
    /** Lazily resolves the boss character container (may still be loading). */
    private readonly bossContainer: () => AssetContainer | null = () => null,
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
      if (Math.hypot(dx, dz) > 0.05) mv.facingY = Math.atan2(dx, dz);
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
        const t = 1 - (mv.dyingUntil - now) / DEATH_MS;
        if (t >= 1) {
          mv.root.dispose(false, true);
          this.visuals.delete(id);
          continue;
        }
        mv.root.rotation.x = t * (Math.PI / 2) * 0.6;
        const fade = Math.max(0, 1 - Math.max(0, t - 0.35) / 0.65);
        for (const m of mv.meshes) m.visibility = fade;
        mv.tag.visibility = fade;
        continue;
      }
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
    const clone = m.kind === "bonelord" ? this.createBoss(m) : this.createComposite(m);
    if (!clone) return null;
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

  /** Boars/wolves/golems clone from a shared primitive-composite template. */
  private createComposite(m: MobPublic): TransformNode | null {
    const clone = this.template(m.kind).clone(`mob:${m.id}`, null);
    clone?.setEnabled(true);
    return clone;
  }

  /**
   * The Bonelord is a real KayKit character (Skeleton Warrior) scaled to
   * boss size with an ember glow, idling on its rig. Falls back to the golem
   * composite while the container is still loading.
   */
  private createBoss(m: MobPublic): TransformNode | null {
    const container = this.bossContainer();
    if (!container) return this.createComposite({ ...m, kind: "golem" });
    const entries = container.instantiateModelsToScene((n) => `${m.id}:${n}`, false, {
      doNotInstantiate: true,
    });
    const node = new TransformNode(`mob:${m.id}`, this.scene);
    for (const r of entries.rootNodes) {
      r.parent = node;
      if (r instanceof TransformNode) r.scaling.setAll(BOSS_SCALE);
    }
    // Ground the feet like createPlayer does — KayKit rigs don't sit at y=0.
    node.computeWorldMatrix(true);
    const bounds = node.getHierarchyBoundingVectors(true);
    const lift = Number.isFinite(bounds.min.y) ? -bounds.min.y : 0;
    for (const r of entries.rootNodes) {
      if (r instanceof TransformNode) r.position.y += lift;
    }
    for (const g of entries.animationGroups) g.stop();
    const idle =
      entries.animationGroups.find((g) => g.name === "Idle" || g.name.endsWith(":Idle")) ?? null;
    idle?.start(true);
    const glow = new PointLight(`bossGlow:${m.id}`, new Vector3(0, 2.4, 0), this.scene);
    glow.diffuse = new Color3(1.0, 0.45, 0.15);
    glow.intensity = 0.85;
    glow.range = 10;
    glow.parent = node;
    return node;
  }

  // -- Primitive composite templates, one per kind ----------------------------

  private template(kind: MobKind): TransformNode {
    let tpl = this.templates.get(kind);
    if (tpl) return tpl;
    tpl = new TransformNode(`mobTemplate:${kind}`, this.scene);
    if (kind === "boar") this.buildBoar(tpl);
    else if (kind === "wolf") this.buildWolf(tpl);
    else this.buildGolem(tpl);
    tpl.setEnabled(false);
    this.templates.set(kind, tpl);
    return tpl;
  }

  private mat(name: string, color: Color3, emissive?: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    if (emissive) {
      m.emissiveColor = emissive;
      m.disableLighting = true;
    }
    return m;
  }

  private buildBoar(tpl: TransformNode): void {
    const hide = this.mat("matBoarHide", new Color3(0.42, 0.29, 0.18));
    const snoutMat = this.mat("matBoarSnout", new Color3(0.72, 0.5, 0.45));
    const body = MeshBuilder.CreateSphere("boarBody", { diameter: 1 }, this.scene);
    body.scaling.set(0.85, 0.75, 1.3);
    body.position.y = 0.55;
    body.material = hide;
    const head = MeshBuilder.CreateSphere("boarHead", { diameter: 0.6 }, this.scene);
    head.position.set(0, 0.62, 0.75);
    head.material = hide;
    const snout = MeshBuilder.CreateCylinder("boarSnout", { height: 0.22, diameter: 0.26 }, this.scene);
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, 0.55, 1.05);
    snout.material = snoutMat;
    const legs: Mesh[] = [];
    for (const [lx, lz] of [[-0.28, 0.42], [0.28, 0.42], [-0.28, -0.42], [0.28, -0.42]]) {
      const leg = MeshBuilder.CreateCylinder("boarLeg", { height: 0.4, diameter: 0.16 }, this.scene);
      leg.position.set(lx, 0.2, lz);
      leg.material = hide;
      legs.push(leg);
    }
    for (const m of [body, head, snout, ...legs]) m.parent = tpl;
  }

  private buildWolf(tpl: TransformNode): void {
    const fur = this.mat("matWolfFur", new Color3(0.45, 0.47, 0.52));
    const dark = this.mat("matWolfDark", new Color3(0.28, 0.29, 0.33));
    const body = MeshBuilder.CreateBox("wolfBody", { width: 0.55, height: 0.5, depth: 1.3 }, this.scene);
    body.position.y = 0.62;
    body.material = fur;
    const head = MeshBuilder.CreateBox("wolfHead", { width: 0.42, height: 0.4, depth: 0.5 }, this.scene);
    head.position.set(0, 0.85, 0.8);
    head.material = fur;
    const snout = MeshBuilder.CreateBox("wolfSnout", { width: 0.2, height: 0.18, depth: 0.32 }, this.scene);
    snout.position.set(0, 0.76, 1.12);
    snout.material = dark;
    const earL = MeshBuilder.CreateCylinder("wolfEarL", { height: 0.26, diameterTop: 0, diameterBottom: 0.16, tessellation: 4 }, this.scene);
    earL.position.set(-0.13, 1.12, 0.74);
    earL.material = dark;
    const earR = earL.clone("wolfEarR");
    earR.position.x = 0.13;
    const tail = MeshBuilder.CreateCylinder("wolfTail", { height: 0.55, diameterTop: 0.05, diameterBottom: 0.14, tessellation: 6 }, this.scene);
    tail.rotation.x = -Math.PI / 3;
    tail.position.set(0, 0.78, -0.78);
    tail.material = dark;
    const legs: Mesh[] = [];
    for (const [lx, lz] of [[-0.18, 0.45], [0.18, 0.45], [-0.18, -0.45], [0.18, -0.45]]) {
      const leg = MeshBuilder.CreateCylinder("wolfLeg", { height: 0.5, diameter: 0.13 }, this.scene);
      leg.position.set(lx, 0.25, lz);
      leg.material = dark;
      legs.push(leg);
    }
    for (const m of [body, head, snout, earL, earR, tail, ...legs]) m.parent = tpl;
  }

  private buildGolem(tpl: TransformNode): void {
    const stone = this.mat("matGolemStone", new Color3(0.42, 0.42, 0.46));
    const moss = this.mat("matGolemMoss", new Color3(0.34, 0.4, 0.32));
    const core = this.mat("matGolemCore", new Color3(0, 0, 0), new Color3(1.0, 0.55, 0.15));
    const hips = MeshBuilder.CreateBox("golemHips", { width: 1.0, height: 0.6, depth: 0.7 }, this.scene);
    hips.position.y = 0.85;
    hips.material = moss;
    const torso = MeshBuilder.CreateBox("golemTorso", { width: 1.4, height: 1.1, depth: 0.9 }, this.scene);
    torso.position.y = 1.7;
    torso.rotation.y = 0.12;
    torso.material = stone;
    const head = MeshBuilder.CreateBox("golemHead", { width: 0.55, height: 0.5, depth: 0.55 }, this.scene);
    head.position.set(0, 2.5, 0.1);
    head.material = moss;
    const coreOrb = MeshBuilder.CreateSphere("golemCore", { diameter: 0.4 }, this.scene);
    coreOrb.position.set(0, 1.75, 0.48);
    coreOrb.material = core;
    const armL = MeshBuilder.CreateBox("golemArmL", { width: 0.4, height: 1.3, depth: 0.45 }, this.scene);
    armL.position.set(-0.95, 1.45, 0);
    armL.rotation.z = 0.12;
    armL.material = stone;
    const armR = armL.clone("golemArmR");
    armR.position.x = 0.95;
    armR.rotation.z = -0.12;
    const legL = MeshBuilder.CreateBox("golemLegL", { width: 0.42, height: 0.7, depth: 0.5 }, this.scene);
    legL.position.set(-0.32, 0.32, 0);
    legL.material = stone;
    const legR = legL.clone("golemLegR");
    legR.position.x = 0.32;
    for (const m of [hips, torso, head, coreOrb, armL, armR, legL, legR]) m.parent = tpl;
  }
}
