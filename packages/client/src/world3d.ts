import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import {
  COMBAT,
  type PlayerPublic,
  type ResourceKind,
  type ResourceNode,
  SAFE_ZONE_CENTER,
  WORLD,
  terrainHeight,
} from "@agentworld/protocol";

export interface PickHandlers {
  onTerrain: (x: number, z: number) => void;
  onNode: (node: ResourceNode) => void;
  onPlayer: (playerId: string) => void;
}

interface PlayerVisual {
  root: TransformNode;
  capsule: Mesh;
  tag: Mesh;
  tagText: string;
  hp: number;
  hpMax: number;
  /** Latest authoritative server position (lerp target). */
  target: Vector3;
  facingY: number;
  busy: boolean;
  /** performance.now() until which the capsule flashes red after a hit. */
  flashUntil: number;
}

interface NodeVisual {
  root: TransformNode;
  data: ResourceNode;
}

/** Floating damage number: a small billboard that rises and fades. */
interface DamageFloater {
  mesh: Mesh;
  mat: StandardMaterial;
  born: number;
  baseY: number;
}

const CAPSULE_HALF_HEIGHT = 0.9;
const SNAP_DISTANCE = 5;
const HIT_FLASH_MS = 300;
const FLOATER_LIFE_MS = 900;
const FLOATER_RISE = 1.3;

export class World3D {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private seed = 0;
  private built = false;
  private terrain: Mesh | null = null;
  private readonly nodeVisuals = new Map<string, NodeVisual>();
  private readonly playerVisuals = new Map<string, PlayerVisual>();
  private readonly floaters: DamageFloater[] = [];
  private myId: string | null = null;
  private hoveredId: string | null = null;
  private safeZoneMat: StandardMaterial | null = null;
  private floaterSeq = 0;

  private matHuman: StandardMaterial;
  private matAgent: StandardMaterial;
  private matTrunk: StandardMaterial;
  private matLeaves: StandardMaterial;
  private matRock: StandardMaterial;
  private matCrystal: StandardMaterial;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: PickHandlers,
  ) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.45, 0.6, 0.78, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.0045;
    this.scene.fogColor = new Color3(0.45, 0.6, 0.78);

    const half = WORLD.SIZE / 2;
    this.camera = new ArcRotateCamera(
      "camera",
      -Math.PI / 2,
      1.05,
      32,
      new Vector3(half, 4, half),
      this.scene,
    );
    this.camera.attachControl(canvas, true);
    this.camera.lowerRadiusLimit = 4;
    this.camera.upperRadiusLimit = 90;
    this.camera.lowerBetaLimit = 0.15;
    this.camera.upperBetaLimit = 1.45;
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.panningSensibility = 0; // orbit only; the camera follows the player

    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), this.scene);
    hemi.intensity = 0.65;
    hemi.groundColor = new Color3(0.25, 0.2, 0.3);
    const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.35), this.scene);
    sun.intensity = 0.75;

    this.matHuman = this.solidMat("matHuman", new Color3(0.28, 0.5, 0.9));
    this.matAgent = this.solidMat("matAgent", new Color3(0.95, 0.55, 0.18));
    this.matTrunk = this.solidMat("matTrunk", new Color3(0.42, 0.28, 0.15));
    this.matLeaves = this.solidMat("matLeaves", new Color3(0.1, 0.32, 0.12));
    this.matRock = this.solidMat("matRock", new Color3(0.52, 0.51, 0.54));
    this.matCrystal = this.solidMat("matCrystal", new Color3(0.05, 0.35, 0.4));
    this.matCrystal.emissiveColor = new Color3(0.1, 0.75, 0.85);

    this.scene.onPointerObservable.add((pi) => {
      if (pi.type === PointerEventTypes.POINTERMOVE) {
        this.updateHover();
        return;
      }
      if (pi.type !== PointerEventTypes.POINTERTAP) return;
      const pick = pi.pickInfo;
      if (!pick || !pick.hit || !pick.pickedMesh) return;
      const id = pick.pickedMesh.metadata as string | null;
      if (typeof id === "string") {
        if (id !== this.myId && this.playerVisuals.has(id)) {
          this.handlers.onPlayer(id);
          return;
        }
        const nv = this.nodeVisuals.get(id);
        if (nv) {
          this.handlers.onNode(nv.data);
          return;
        }
      }
      if (pick.pickedMesh === this.terrain && pick.pickedPoint) {
        this.handlers.onTerrain(pick.pickedPoint.x, pick.pickedPoint.z);
      }
    });

    this.scene.onBeforeRenderObservable.add(() => this.animate());
    this.engine.runRenderLoop(() => this.scene.render());
    window.addEventListener("resize", () => this.engine.resize());
  }

  private solidMat(name: string, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    return m;
  }

  // -------------------------------------------------------------------------
  // World construction (after `welcome`)
  // -------------------------------------------------------------------------

  buildWorld(seed: number, nodes: ResourceNode[], myId: string): void {
    if (this.built) return;
    this.built = true;
    this.seed = seed;
    this.myId = myId;
    this.buildTerrain();
    this.buildWater();
    this.buildSafeZone();
    for (const node of nodes) this.createNode(node);
  }

  private buildTerrain(): void {
    const size = WORLD.SIZE; // vertices at every integer in [0, size]
    const n = size + 1;
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (let z = 0; z <= size; z++) {
      for (let x = 0; x <= size; x++) {
        const y = terrainHeight(x, z, this.seed);
        positions.push(x, y, z);
        const [r, g, b] = heightColor(y);
        colors.push(r, g, b, 1);
      }
    }
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const i = col + row * n;
        indices.push(i, i + 1, i + 1 + n);
        indices.push(i, i + 1 + n, i + n);
      }
    }

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const mesh = new Mesh("terrain", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.colors = colors;
    vd.applyToMesh(mesh);

    const mat = new StandardMaterial("matTerrain", this.scene);
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0, 0, 0);
    mesh.material = mat;
    mesh.isPickable = true;
    this.terrain = mesh;
  }

  private buildWater(): void {
    const half = WORLD.SIZE / 2;
    const water = MeshBuilder.CreateGround(
      "water",
      { width: WORLD.SIZE * 3, height: WORLD.SIZE * 3 },
      this.scene,
    );
    water.position = new Vector3(half, 0, half);
    const mat = new StandardMaterial("matWater", this.scene);
    mat.diffuseColor = new Color3(0.1, 0.3, 0.55);
    mat.emissiveColor = new Color3(0.02, 0.08, 0.16);
    mat.specularColor = new Color3(0.3, 0.3, 0.35);
    mat.alpha = 0.55;
    water.material = mat;
    water.isPickable = false;
  }

  /** Glowing no-PvP disc draped over the terrain, plus a shrine obelisk. */
  private buildSafeZone(): void {
    const segments = 64;
    const rings = 8;
    const cx = SAFE_ZONE_CENTER.x;
    const cz = SAFE_ZONE_CENTER.z;

    const positions: number[] = [];
    const indices: number[] = [];
    for (let r = 0; r <= rings; r++) {
      const rad = (COMBAT.SAFE_ZONE_RADIUS * r) / rings;
      for (let s = 0; s < segments; s++) {
        const a = (2 * Math.PI * s) / segments;
        const x = cx + Math.cos(a) * rad;
        const z = cz + Math.sin(a) * rad;
        positions.push(x, terrainHeight(x, z, this.seed) + 0.08, z);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segments; s++) {
        const i = r * segments + s;
        const i2 = r * segments + ((s + 1) % segments);
        indices.push(i, i2, i2 + segments);
        indices.push(i, i2 + segments, i + segments);
      }
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const disc = new Mesh("safeZone", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(disc);
    disc.isPickable = false;

    const mat = new StandardMaterial("matSafeZone", this.scene);
    mat.emissiveColor = new Color3(0.79, 0.65, 0.34);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0.14;
    disc.material = mat;
    this.safeZoneMat = mat; // alpha pulses slowly in animate()

    // Shrine obelisk at the centre, with a glowing ember at the tip.
    const y = terrainHeight(cx, cz, this.seed);
    const obelisk = MeshBuilder.CreateCylinder(
      "shrineObelisk",
      { height: 3.4, diameterBottom: 1.0, diameterTop: 0.18, tessellation: 4 },
      this.scene,
    );
    obelisk.position = new Vector3(cx, y + 1.7, cz);
    const obeliskMat = this.solidMat("matObelisk", new Color3(0.3, 0.27, 0.38));
    obeliskMat.emissiveColor = new Color3(0.35, 0.28, 0.12);
    obelisk.material = obeliskMat;
    obelisk.isPickable = false;

    const ember = MeshBuilder.CreateSphere("shrineEmber", { diameter: 0.5 }, this.scene);
    ember.position = new Vector3(cx, y + 3.6, cz);
    const emberMat = new StandardMaterial("matEmber", this.scene);
    emberMat.emissiveColor = new Color3(1, 0.78, 0.35);
    emberMat.disableLighting = true;
    ember.material = emberMat;
    ember.isPickable = false;
  }

  // -------------------------------------------------------------------------
  // Resource nodes
  // -------------------------------------------------------------------------

  private createNode(node: ResourceNode): void {
    const root = new TransformNode(`node:${node.id}`, this.scene);
    const y = terrainHeight(node.pos.x, node.pos.z, this.seed);
    root.position = new Vector3(node.pos.x, y, node.pos.z);

    const parts = this.buildNodeMeshes(node.kind, node.id);
    for (const part of parts) {
      part.parent = root;
      part.metadata = node.id;
      part.isPickable = true;
    }

    this.nodeVisuals.set(node.id, { root, data: node });
    this.applyNodeState(node);
  }

  private buildNodeMeshes(kind: ResourceKind, id: string): Mesh[] {
    switch (kind) {
      case "tree": {
        const trunk = MeshBuilder.CreateCylinder(
          `trunk:${id}`,
          { height: 1.6, diameter: 0.45 },
          this.scene,
        );
        trunk.position.y = 0.8;
        trunk.material = this.matTrunk;
        const leaves = MeshBuilder.CreateCylinder(
          `leaves:${id}`,
          { height: 2.6, diameterTop: 0, diameterBottom: 2.0, tessellation: 8 },
          this.scene,
        );
        leaves.position.y = 2.7;
        leaves.material = this.matLeaves;
        return [trunk, leaves];
      }
      case "rock": {
        const rock = MeshBuilder.CreateIcoSphere(
          `rock:${id}`,
          { radius: 0.95, subdivisions: 1 },
          this.scene,
        );
        rock.scaling = new Vector3(1.15, 0.55, 1);
        rock.position.y = 0.4;
        rock.material = this.matRock;
        return [rock];
      }
      case "crystal": {
        const crystal = MeshBuilder.CreatePolyhedron(
          `crystal:${id}`,
          { type: 1, size: 0.55 },
          this.scene,
        );
        crystal.position.y = 0.75;
        crystal.rotation = new Vector3(0.3, 0.8, 0.2);
        crystal.material = this.matCrystal;
        return [crystal];
      }
    }
  }

  /** Apply remaining-count visual state: depleted nodes shrink to 20%. */
  updateNode(node: ResourceNode): void {
    const nv = this.nodeVisuals.get(node.id);
    if (!nv) {
      if (this.built) this.createNode(node);
      return;
    }
    nv.data = node;
    this.applyNodeState(node);
  }

  private applyNodeState(node: ResourceNode): void {
    const nv = this.nodeVisuals.get(node.id);
    if (!nv) return;
    const s = node.remaining > 0 ? 1 : 0.2;
    nv.root.scaling.setAll(s);
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  updatePlayers(players: PlayerPublic[]): void {
    if (!this.built) return;
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      let pv = this.playerVisuals.get(p.id);
      if (!pv) {
        pv = this.createPlayer(p);
        this.playerVisuals.set(p.id, pv);
      }
      const y = terrainHeight(p.pos.x, p.pos.z, this.seed) + CAPSULE_HALF_HEIGHT;
      pv.target.set(p.pos.x, y, p.pos.z);
      pv.facingY = Math.atan2(p.facing.x, p.facing.z);
      pv.busy = p.busy;
      const tagText = p.role === "agent" ? `⚙ ${p.name}` : p.name;
      const hp = Math.max(0, Math.round(p.hp));
      if (tagText !== pv.tagText || hp !== pv.hp || p.hpMax !== pv.hpMax) {
        pv.tagText = tagText;
        pv.hp = hp;
        pv.hpMax = p.hpMax;
        this.drawTag(pv.tag, tagText, p.role, p.hpMax > 0 ? hp / p.hpMax : 0);
      }
    }
    for (const [id, pv] of this.playerVisuals) {
      if (!seen.has(id)) {
        if (this.hoveredId === id) this.setHovered(null);
        pv.root.dispose(false, true);
        this.playerVisuals.delete(id);
      }
    }
  }

  private createPlayer(p: PlayerPublic): PlayerVisual {
    const root = new TransformNode(`player:${p.id}`, this.scene);
    const y = terrainHeight(p.pos.x, p.pos.z, this.seed) + CAPSULE_HALF_HEIGHT;
    root.position = new Vector3(p.pos.x, y, p.pos.z);

    const capsule = MeshBuilder.CreateCapsule(
      `capsule:${p.id}`,
      { height: 1.8, radius: 0.38 },
      this.scene,
    );
    capsule.parent = root;
    capsule.material = p.role === "agent" ? this.matAgent : this.matHuman;
    // Other players are attack targets; clicks on self fall through to terrain.
    capsule.isPickable = p.id !== this.myId;
    capsule.metadata = p.id;
    capsule.overlayColor = new Color3(0.9, 0.1, 0.1);
    capsule.overlayAlpha = 0.65;
    capsule.outlineColor = new Color3(0.79, 0.65, 0.34);
    capsule.outlineWidth = 0.04;

    const tag = MeshBuilder.CreatePlane(`tag:${p.id}`, { width: 2.4, height: 0.8 }, this.scene);
    tag.parent = root;
    tag.position.y = 1.7;
    tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    tag.isPickable = false;

    const pv: PlayerVisual = {
      root,
      capsule,
      tag,
      tagText: "",
      hp: Math.max(0, Math.round(p.hp)),
      hpMax: p.hpMax,
      target: root.position.clone(),
      facingY: 0,
      busy: false,
      flashUntil: 0,
    };
    const tagText = p.role === "agent" ? `⚙ ${p.name}` : p.name;
    this.drawTag(tag, tagText, p.role, p.hpMax > 0 ? pv.hp / p.hpMax : 0);
    pv.tagText = tagText;
    return pv;
  }

  private drawTag(tag: Mesh, text: string, role: PlayerPublic["role"], hpFrac: number): void {
    tag.material?.dispose(false, true);
    const tex = new DynamicTexture(
      `tagTex:${tag.name}`,
      { width: 384, height: 128 },
      this.scene,
      true,
    );
    tex.hasAlpha = true;
    const color = role === "agent" ? "#ffc07a" : "#bcd9ff";
    tex.drawText(text, null, 56, "bold 44px Georgia", color, null, true, false);
    // HP bar under the name: green at full health shading to red near death.
    const frac = Math.max(0, Math.min(1, hpFrac));
    const ctx = tex.getContext();
    const barX = 92;
    const barY = 78;
    const barW = 200;
    const barH = 18;
    ctx.fillStyle = "rgba(10, 8, 16, 0.85)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = `hsl(${Math.round(120 * frac)}, 75%, 45%)`;
    ctx.fillRect(barX + 2, barY + 2, (barW - 4) * frac, barH - 4);
    tex.update();
    const mat = new StandardMaterial(`tagMat:${tag.name}`, this.scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    tag.material = mat;
  }

  // -------------------------------------------------------------------------
  // Combat feedback + hover targeting
  // -------------------------------------------------------------------------

  /** Flash the target red and float a damage number above their head. */
  showHit(playerId: string, damage: number, killed: boolean): void {
    const pv = this.playerVisuals.get(playerId);
    if (!pv) return;
    const now = performance.now();
    pv.flashUntil = now + HIT_FLASH_MS;

    const id = this.floaterSeq++;
    const plane = MeshBuilder.CreatePlane(`dmg:${id}`, { width: 1.5, height: 0.75 }, this.scene);
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.position = pv.root.position.add(new Vector3(0, 2.4, 0));
    const tex = new DynamicTexture(`dmgTex:${id}`, { width: 192, height: 96 }, this.scene, true);
    tex.hasAlpha = true;
    tex.drawText(`-${damage}`, null, 66, "bold 56px Georgia", killed ? "#ff4040" : "#ffb3a0", null, true);
    const mat = new StandardMaterial(`dmgMat:${id}`, this.scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    plane.material = mat;
    this.floaters.push({ mesh: plane, mat, born: now, baseY: plane.position.y });
  }

  private updateHover(): void {
    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
    const id = pick?.pickedMesh?.metadata as string | null;
    if (typeof id === "string" && id !== this.myId && this.playerVisuals.has(id)) {
      this.setHovered(id);
    } else {
      this.setHovered(null);
    }
  }

  /** Gold-outline the hovered target and switch to a crosshair cursor. */
  private setHovered(id: string | null): void {
    if (id === this.hoveredId) return;
    if (this.hoveredId) {
      const prev = this.playerVisuals.get(this.hoveredId);
      if (prev) prev.capsule.renderOutline = false;
    }
    this.hoveredId = id;
    const next = id ? this.playerVisuals.get(id) : undefined;
    if (next) next.capsule.renderOutline = true;
    this.canvas.style.cursor = next ? "crosshair" : "default";
  }

  // -------------------------------------------------------------------------
  // Per-frame animation: interpolation, busy bob, camera follow
  // -------------------------------------------------------------------------

  private animate(): void {
    const dt = this.engine.getDeltaTime() / 1000;
    const lerpFactor = 1 - Math.exp(-10 * dt);
    const now = performance.now();

    for (const pv of this.playerVisuals.values()) {
      const dist = Vector3.Distance(pv.root.position, pv.target);
      if (dist > SNAP_DISTANCE) {
        pv.root.position.copyFrom(pv.target);
      } else {
        Vector3.LerpToRef(pv.root.position, pv.target, lerpFactor, pv.root.position);
      }
      // Smoothly turn toward facing.
      let dy = pv.facingY - pv.root.rotation.y;
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      pv.root.rotation.y += dy * lerpFactor;
      // Busy: bob the capsule to show activity.
      pv.capsule.position.y = pv.busy ? Math.sin(now / 110) * 0.16 : 0;
      // Brief red overlay after taking a hit.
      pv.capsule.renderOverlay = now < pv.flashUntil;
    }

    // Damage floaters rise and fade, then expire.
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const t = (now - f.born) / FLOATER_LIFE_MS;
      if (t >= 1) {
        f.mesh.dispose(false, true);
        this.floaters.splice(i, 1);
        continue;
      }
      f.mesh.position.y = f.baseY + t * FLOATER_RISE;
      f.mat.alpha = 1 - t * t;
    }

    // Slow sanctuary pulse.
    if (this.safeZoneMat) {
      this.safeZoneMat.alpha = 0.1 + 0.06 * (Math.sin(now / 1400) + 1) * 0.5;
    }

    const me = this.myId ? this.playerVisuals.get(this.myId) : undefined;
    if (me) {
      Vector3.LerpToRef(
        this.camera.target,
        me.root.position.add(new Vector3(0, 0.8, 0)),
        Math.min(1, lerpFactor * 1.5),
        this.camera.target,
      );
    }
  }

  /** Camera-relative XZ basis for WASD movement. */
  cameraBasis(): { fx: number; fz: number; rx: number; rz: number } {
    const fwd = this.camera.target.subtract(this.camera.position);
    fwd.y = 0;
    const len = fwd.length();
    if (len < 1e-4) return { fx: 0, fz: 1, rx: 1, rz: 0 };
    fwd.scaleInPlace(1 / len);
    // Right-hand vector on XZ for a left-handed scene: right = up x forward.
    return { fx: fwd.x, fz: fwd.z, rx: fwd.z, rz: -fwd.x };
  }
}

// ---------------------------------------------------------------------------

function heightColor(y: number): [number, number, number] {
  const sand: [number, number, number] = [0.8, 0.71, 0.47];
  const grass: [number, number, number] = [0.29, 0.5, 0.25];
  const rock: [number, number, number] = [0.47, 0.46, 0.5];
  if (y < 0.4) return sand;
  if (y < 1.1) return mix(sand, grass, (y - 0.4) / 0.7);
  if (y < 5.0) return grass;
  if (y < 6.0) return mix(grass, rock, y - 5.0);
  return rock;
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
