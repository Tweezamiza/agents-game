import "@babylonjs/loaders/glTF";
import {
  AbstractMesh,
  AnimationGroup,
  ArcRotateCamera,
  AssetContainer,
  Color3,
  Color4,
  CubeTexture,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  Engine,
  HDRCubeTexture,
  HemisphericLight,
  LoadAssetContainerAsync,
  Mesh,
  MeshBuilder,
  PointerEventTypes,
  PointLight,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import {
  COMBAT,
  type MobPublic,
  type PlayerPublic,
  type ResourceKind,
  type ResourceNode,
  SAFE_ZONE_CENTER,
  type Structure,
  WORLD,
  terrainHeight,
} from "@agentworld/protocol";
import { addFlameOrb, addMoonRays, applyDuskLighting, buildDuskSky, tuneNightPipeline } from "./atmosphere";
import { MobLayer } from "./mobs3d";
import { StructureLayer } from "./structures3d";

export interface PickHandlers {
  onTerrain: (x: number, z: number) => void;
  onNode: (node: ResourceNode) => void;
  onPlayer: (playerId: string) => void;
  onMob: (mobId: string) => void;
}

// ---------------------------------------------------------------------------
// Asset manifest — everything lives under packages/client/public/assets.
// ---------------------------------------------------------------------------

const ASSETS = "/assets";

interface CharacterSpec {
  url: string;
  /** Accessory mesh-name fragments to hide (KayKit ships every weapon). */
  hide: string[];
  /** Animation-group name used for the attack swing. */
  attackAnim: string;
}

const CHARACTERS: Record<"human" | "agent", CharacterSpec> = {
  human: {
    url: `${ASSETS}/characters/Knight.glb`,
    hide: ["1H_Sword_Offhand", "Badge_Shield", "Rectangle_Shield", "Spike_Shield", "2H_Sword"],
    attackAnim: "1H_Melee_Attack_Slice_Diagonal",
  },
  agent: {
    url: `${ASSETS}/characters/Mage.glb`,
    hide: ["Spellbook", "Spellbook_open", "1H_Wand"],
    attackAnim: "Spellcast_Shoot",
  },
};

/** World-boss character model (KayKit Skeletons pack), rendered by MobLayer. */
const BOSS_URL = `${ASSETS}/characters/Skeleton_Warrior.glb`;

interface PropSpec {
  url: string;
  scale: number;
}

const TREE_VARIANTS: PropSpec[] = [
  { url: `${ASSETS}/nature/tree_single_A.gltf`, scale: 5.4 },
  { url: `${ASSETS}/nature/tree_single_B.gltf`, scale: 5.0 },
  { url: `${ASSETS}/nature/trees_B_medium.gltf`, scale: 3.6 },
];

const ROCK_VARIANTS: PropSpec[] = [
  { url: `${ASSETS}/nature/rock_single_C.gltf`, scale: 8.0 },
  { url: `${ASSETS}/nature/rock_single_E.gltf`, scale: 7.0 },
  { url: `${ASSETS}/nature/rock_single_A.gltf`, scale: 9.0 },
];

/** Toggle for the warm vignette/contrast grade layered on the pipeline. */
const ATMOSPHERE_GRADE = true;

const CHARACTER_HEIGHT = 1.8;
const TAG_HEIGHT = 2.35;
const SNAP_DISTANCE = 6;
const HIT_FLASH_MS = 280;
const DEATH_MS = 1700;
const FLOATER_LIFE_MS = 950;
const FLOATER_RISE = 1.4;
const WALK_SPEED_MIN = 0.5;
const RUN_SPEED_MIN = 2.6;

// ---------------------------------------------------------------------------

interface AnimSet {
  idle: AnimationGroup | null;
  walk: AnimationGroup | null;
  run: AnimationGroup | null;
  attack: AnimationGroup | null;
  death: AnimationGroup | null;
  interact: AnimationGroup | null;
}

interface PlayerVisual {
  root: TransformNode;
  model: TransformNode;
  meshes: AbstractMesh[];
  tag: Mesh;
  tagText: string;
  hp: number;
  hpMax: number;
  /** Latest authoritative server position (lerp target). */
  target: Vector3;
  facingY: number;
  busy: boolean;
  flashUntil: number;
  anim: AnimSet;
  current: AnimationGroup | null;
  /** performance.now() until which a one-shot attack animation owns the rig. */
  attackUntil: number;
  /** performance.now() until which the death animation + fade plays. */
  deadUntil: number;
  /** Previous server position, for deriving walk/run speed from 10 Hz frames. */
  prevX: number;
  prevZ: number;
  prevT: number;
  speed: number;
  /** Resting model Y offset (feet-on-ground correction). */
  lift: number;
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
  private mobLayer: MobLayer | null = null;
  private structureLayer: StructureLayer | null = null;
  private safeZoneMat: StandardMaterial | null = null;
  private waterMat: StandardMaterial | null = null;
  private waterBump: Texture | null = null;
  private emberMat: StandardMaterial | null = null;
  private floaterSeq = 0;
  private shadows: ShadowGenerator | null = null;

  /** Loaded glTF containers, keyed by URL. Null until loadAssets resolves. */
  private containers: Map<string, AssetContainer> | null = null;
  private pendingNodes: ResourceNode[] = [];
  private pendingPlayers: PlayerPublic[] = [];
  private crystalTemplate: TransformNode | null = null;

  private matRockBase: StandardMaterial;
  private matCrystal: StandardMaterial;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: PickHandlers,
  ) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    (window as unknown as Record<string, unknown>).__scene = this.scene;
    // Clear color, fog, and scene lights come from the dusk rig below.

    const half = WORLD.SIZE / 2;
    this.camera = new ArcRotateCamera(
      "camera",
      -Math.PI / 2,
      1.15,
      13,
      new Vector3(half, 7, half),
      this.scene,
    );
    this.camera.attachControl(canvas, true);
    this.camera.lowerRadiusLimit = 4;
    this.camera.upperRadiusLimit = 80;
    this.camera.lowerBetaLimit = 0.15;
    this.camera.upperBetaLimit = 1.45;
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.panningSensibility = 0; // orbit only; the camera follows the player
    this.camera.minZ = 0.5;
    this.camera.maxZ = 1200;

    const rig = applyDuskLighting(this.scene);
    rig.moon.position = new Vector3(half + 80, 120, half - 70);

    this.shadows = new ShadowGenerator(2048, rig.moon);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = 0.002;
    this.shadows.normalBias = 0.03;
    this.shadows.darkness = 0.55;

    // Night IBL from a real moonlit HDRI (Poly Haven, CC0) so PBR materials
    // pick up cool ambient sky light instead of a daylight cubemap.
    const sky = new HDRCubeTexture(`${ASSETS}/sky/satara_night_1k.hdr`, this.scene, 128, false, true, false, true);
    this.scene.environmentTexture = sky;
    this.scene.environmentIntensity = 0.55;

    // Star dome + moon, with volumetric shafts hung off the moon disc.
    const moonDisc = buildDuskSky(this.scene, new Vector3(half, 0, half));
    if (ATMOSPHERE_GRADE) addMoonRays(this.scene, this.camera, moonDisc);

    const pipeline = new DefaultRenderingPipeline("rp", false, this.scene, [this.camera]);
    pipeline.fxaaEnabled = true;
    tuneNightPipeline(pipeline);

    this.matRockBase = this.solidMat("matRockBase", new Color3(0.45, 0.44, 0.47));
    this.matCrystal = this.solidMat("matCrystal", new Color3(0.05, 0.3, 0.36));
    this.matCrystal.emissiveColor = new Color3(0.15, 0.85, 0.95);

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
        if (this.mobLayer?.has(id)) {
          this.handlers.onMob(id);
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
  // Asset loading
  // -------------------------------------------------------------------------

  private async loadAssets(): Promise<void> {
    const urls = new Set<string>();
    urls.add(CHARACTERS.human.url);
    urls.add(CHARACTERS.agent.url);
    urls.add(BOSS_URL);
    for (const v of TREE_VARIANTS) urls.add(v.url);
    for (const v of ROCK_VARIANTS) urls.add(v.url);
    for (const b of VILLAGE_BUILDINGS) urls.add(b.url);
    for (const p of VILLAGE_PROPS) urls.add(p.url);
    urls.add(TORCH_URL);
    urls.add(PILLAR_URL);
    urls.add(FENCE_URL);
    urls.add(CHEST_URL);
    urls.add(SPHINX_URL);
    urls.add(SIREN_URL);

    const loaded = new Map<string, AssetContainer>();
    await Promise.all(
      [...urls].map(async (url) => {
        try {
          const c = await LoadAssetContainerAsync(url, this.scene);
          loaded.set(url, c);
        } catch (err) {
          console.error(`asset load failed: ${url}`, err);
        }
      }),
    );
    this.containers = loaded;
  }

  /** Instantiate a container as mesh instances under a fresh wrapper node. */
  private spawnProp(
    url: string,
    name: string,
    pickableId: string | null = null,
  ): TransformNode | null {
    const c = this.containers?.get(url);
    if (!c) return null;
    const entries = c.instantiateModelsToScene((n) => `${name}:${n}`, false);
    const wrapper = new TransformNode(name, this.scene);
    for (const root of entries.rootNodes) {
      root.parent = wrapper;
      for (const mesh of root.getChildMeshes()) {
        mesh.isPickable = pickableId !== null;
        if (pickableId !== null) mesh.metadata = pickableId;
        this.shadows?.addShadowCaster(mesh);
      }
    }
    return wrapper;
  }

  // -------------------------------------------------------------------------
  // World construction (after `welcome`)
  // -------------------------------------------------------------------------

  buildWorld(seed: number, nodes: ResourceNode[], myId: string, mobs: MobPublic[] = [], structures: Structure[] = []): void {
    if (this.built) return;
    this.built = true;
    this.seed = seed;
    this.myId = myId;
    this.buildTerrain();
    this.buildWater();
    this.buildSafeZoneRing();
    const ground = (x: number, z: number) => this.groundY(x, z);
    this.mobLayer = new MobLayer(this.scene, this.shadows, ground, () => this.containers?.get(BOSS_URL) ?? null);
    this.structureLayer = new StructureLayer(this.scene, this.shadows, ground);
    this.mobLayer.update(mobs);
    this.structureLayer.setAll(structures);
    this.pendingNodes = nodes.slice();
    void this.loadAssets().then(() => {
      this.buildCrystalTemplate();
      this.buildVillage();
      // The Siren of the High Stones — a lone landmark on the boss highland.
      const siren = this.spawnProp(SIREN_URL, "highlandSiren");
      if (siren) this.placeAt(siren, 152, 130, Math.atan2(120 - 152, 120 - 130), 1.6);
      for (const node of this.pendingNodes) this.createNode(node);
      this.pendingNodes = [];
      const players = this.pendingPlayers;
      this.pendingPlayers = [];
      if (players.length) this.updatePlayers(players);
    });
  }

  private groundY(x: number, z: number): number {
    return terrainHeight(x, z, this.seed);
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
        const [r, g, b] = terrainColor(x, y, z);
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
    // Cool night tint over the daylight vertex colors — moonlit grass, not lime.
    mat.diffuseColor = new Color3(0.58, 0.64, 0.8);
    mat.specularColor = new Color3(0, 0, 0);
    mesh.material = mat;
    mesh.isPickable = true;
    mesh.receiveShadows = true;
    mesh.freezeWorldMatrix();
    this.terrain = mesh;
  }

  private buildWater(): void {
    const half = WORLD.SIZE / 2;
    const water = MeshBuilder.CreateGround(
      "water",
      { width: WORLD.SIZE * 4, height: WORLD.SIZE * 4, subdivisions: 4 },
      this.scene,
    );
    water.position = new Vector3(half, -0.12, half);
    const mat = new StandardMaterial("matWater", this.scene);
    mat.diffuseColor = new Color3(0.12, 0.38, 0.52);
    mat.emissiveColor = new Color3(0.02, 0.1, 0.16);
    mat.specularColor = new Color3(0.7, 0.7, 0.75);
    mat.specularPower = 128;
    mat.alpha = 0.78;
    const bump = new Texture(`${ASSETS}/textures/waterbump.png`, this.scene);
    bump.uScale = 60;
    bump.vScale = 60;
    bump.level = 0.45;
    mat.bumpTexture = bump;
    this.waterBump = bump;
    water.material = mat;
    water.isPickable = false;
    this.waterMat = mat;
  }

  /** Subtle glowing boundary ring draped on the terrain at the safe radius. */
  private buildSafeZoneRing(): void {
    const segments = 128;
    const cx = SAFE_ZONE_CENTER.x;
    const cz = SAFE_ZONE_CENTER.z;
    const rInner = COMBAT.SAFE_ZONE_RADIUS - 0.55;
    const rOuter = COMBAT.SAFE_ZONE_RADIUS + 0.25;

    const positions: number[] = [];
    const indices: number[] = [];
    for (let s = 0; s < segments; s++) {
      const a = (2 * Math.PI * s) / segments;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const xi = cx + ca * rInner;
      const zi = cz + sa * rInner;
      const xo = cx + ca * rOuter;
      const zo = cz + sa * rOuter;
      positions.push(xi, this.groundY(xi, zi) + 0.06, zi);
      positions.push(xo, this.groundY(xo, zo) + 0.06, zo);
    }
    for (let s = 0; s < segments; s++) {
      const i = s * 2;
      const j = ((s + 1) % segments) * 2;
      indices.push(i, j, j + 1);
      indices.push(i, j + 1, i + 1);
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const ring = new Mesh("safeZoneRing", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(ring);
    ring.isPickable = false;

    const mat = new StandardMaterial("matSafeZone", this.scene);
    mat.emissiveColor = new Color3(0.45, 0.36, 0.18);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0.3;
    ring.material = mat;
    ring.freezeWorldMatrix();
    this.safeZoneMat = mat; // alpha pulses slowly in animate()
  }

  // -------------------------------------------------------------------------
  // Village + shrine
  // -------------------------------------------------------------------------

  private placeAt(
    wrapper: TransformNode,
    x: number,
    z: number,
    rotY: number,
    scale: number,
    sinkY = 0.04,
  ): void {
    wrapper.scaling.setAll(scale);
    wrapper.rotation.y = rotY;
    wrapper.position.set(x, this.groundY(x, z) - sinkY, z);
    wrapper.computeWorldMatrix(true);
    for (const m of wrapper.getChildMeshes()) m.freezeWorldMatrix();
    wrapper.freezeWorldMatrix();
  }

  private buildVillage(): void {
    const cx = SAFE_ZONE_CENTER.x;
    const cz = SAFE_ZONE_CENTER.z;
    const at = (angleDeg: number, r: number): { x: number; z: number; facing: number } => {
      const a = (angleDeg * Math.PI) / 180;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      // Face the village centre.
      const facing = Math.atan2(cx - x, cz - z);
      return { x, z, facing };
    };

    // --- Shrine centrepiece -------------------------------------------------
    const baseY = this.groundY(cx, cz);
    const plinth = MeshBuilder.CreateCylinder(
      "shrinePlinth",
      { height: 0.5, diameter: 7, tessellation: 24 },
      this.scene,
    );
    plinth.position = new Vector3(cx, baseY + 0.22, cz);
    plinth.material = this.matRockBase;
    plinth.isPickable = false;
    plinth.receiveShadows = true;
    plinth.freezeWorldMatrix();

    const step = MeshBuilder.CreateCylinder(
      "shrineStep",
      { height: 0.35, diameter: 9.5, tessellation: 24 },
      this.scene,
    );
    step.position = new Vector3(cx, baseY + 0.05, cz);
    step.material = this.matRockBase;
    step.isPickable = false;
    step.receiveShadows = true;
    step.freezeWorldMatrix();

    const pillar = this.spawnProp(PILLAR_URL, "shrinePillar");
    if (pillar) this.placeAt(pillar, cx, cz, Math.PI / 4, 0.85, -0.42);

    const ember = MeshBuilder.CreateSphere("shrineEmber", { diameter: 0.85 }, this.scene);
    ember.position = new Vector3(cx, baseY + 4.4, cz);
    const emberMat = new StandardMaterial("matEmber", this.scene);
    emberMat.emissiveColor = new Color3(1.0, 0.72, 0.25);
    emberMat.disableLighting = true;
    ember.material = emberMat;
    ember.isPickable = false;
    this.emberMat = emberMat;

    // The village's warm anchor: one real point light pooling ember light
    // over the shrine plaza against the cool moonlit night.
    const emberLight = new PointLight("shrineEmberLight", ember.position.clone(), this.scene);
    emberLight.diffuse = new Color3(1.0, 0.6, 0.24);
    emberLight.specular = new Color3(0.6, 0.35, 0.12);
    emberLight.intensity = 2.4;
    emberLight.range = 15;

    // Torches around the shrine — flame orbs bloom through the glow layer.
    for (let i = 0; i < 4; i++) {
      const p = at(45 + i * 90, 3.6);
      const torch = this.spawnProp(TORCH_URL, `shrineTorch${i}`);
      if (torch) {
        this.placeAt(torch, p.x, p.z, p.facing + Math.PI, 1.5);
        addFlameOrb(this.scene, p.x, this.groundY(p.x, p.z) + 2.5, p.z);
      }
    }

    // --- Buildings ----------------------------------------------------------
    for (const b of VILLAGE_BUILDINGS) {
      const p = at(b.angle, b.radius);
      const prop = this.spawnProp(b.url, b.name);
      if (prop) this.placeAt(prop, p.x, p.z, p.facing + b.faceOffset, b.scale, 0.1);
    }

    // --- Props --------------------------------------------------------------
    for (const pr of VILLAGE_PROPS) {
      const p = at(pr.angle, pr.radius);
      const prop = this.spawnProp(pr.url, pr.name);
      if (prop) this.placeAt(prop, p.x, p.z, (pr.angle * Math.PI) / 57, pr.scale);
    }

    // Gold chest by the market stall (where trading happens).
    const chest = this.spawnProp(CHEST_URL, "marketChest");
    if (chest) {
      const p = at(262, 7.6);
      this.placeAt(chest, p.x, p.z, p.facing, 0.8);
    }

    // Sphinx guardians flanking the east entrance — real museum scans give
    // the shrine a weight no low-poly prop can.
    for (const [name, angle] of [["sphinxL", 12], ["sphinxR", -12]] as const) {
      const p = at(angle, 16.2);
      const sphinx = this.spawnProp(SPHINX_URL, name);
      // Face along the entrance path, out toward the wilds.
      if (sphinx) this.placeAt(sphinx, p.x, p.z, p.facing + Math.PI, 1.15);
    }

    // --- Perimeter: torch ring + fence arcs with gaps at the entrances ------
    for (let i = 0; i < 6; i++) {
      const p = at(i * 60 + 30, 13.4);
      const torch = this.spawnProp(TORCH_URL, `ringTorch${i}`);
      if (torch) {
        this.placeAt(torch, p.x, p.z, p.facing, 1.6);
        addFlameOrb(this.scene, p.x, this.groundY(p.x, p.z) + 2.7, p.z, 1.1);
      }
    }
    const fenceR = 15.2;
    for (let arc = 0; arc < 4; arc++) {
      for (let k = -1; k <= 1; k++) {
        const angle = arc * 90 + 45 + k * 16;
        const p = at(angle, fenceR);
        const fence = this.spawnProp(FENCE_URL, `fence${arc}-${k}`);
        // The barrier model runs along X; rotate tangentially to the circle.
        if (fence) this.placeAt(fence, p.x, p.z, p.facing + Math.PI / 2, 1.0);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Resource nodes
  // -------------------------------------------------------------------------

  private buildCrystalTemplate(): void {
    const tpl = new TransformNode("crystalTemplate", this.scene);
    const base = MeshBuilder.CreateIcoSphere(
      "crystalBase",
      { radius: 0.7, subdivisions: 1 },
      this.scene,
    );
    base.scaling = new Vector3(1.25, 0.42, 1.1);
    base.position.y = 0.12;
    base.material = this.matRockBase;
    base.parent = tpl;
    const shards: [number, number, number, number][] = [
      // x, z, size, tilt
      [0, 0, 0.62, 0.08],
      [-0.42, 0.25, 0.4, 0.45],
      [0.38, -0.18, 0.34, -0.4],
    ];
    for (let i = 0; i < shards.length; i++) {
      const [sx, sz, size, tilt] = shards[i];
      const c = MeshBuilder.CreatePolyhedron(`crystalShard${i}`, { type: 1, size }, this.scene);
      c.position.set(sx, 0.55 + size * 0.6, sz);
      c.rotation.set(tilt, i * 1.7, tilt * 0.6);
      c.material = this.matCrystal;
      c.parent = tpl;
    }
    tpl.setEnabled(false);
    this.crystalTemplate = tpl;
  }

  /** Deterministic per-node hash for stable rotation/scale jitter. */
  private static hash(id: string): number {
    let v = 2166136261;
    for (let i = 0; i < id.length; i++) {
      v ^= id.charCodeAt(i);
      v = Math.imul(v, 16777619);
    }
    return (v >>> 0) / 4294967296;
  }

  private createNode(node: ResourceNode): void {
    if (!this.containers) {
      this.pendingNodes.push(node);
      return;
    }
    const h1 = World3D.hash(node.id);
    const h2 = World3D.hash(`${node.id}#`);
    const y = this.groundY(node.pos.x, node.pos.z);
    let root: TransformNode | null = null;

    if (node.kind === "crystal") {
      if (!this.crystalTemplate) return;
      const clone = this.crystalTemplate.clone(`node:${node.id}`, null);
      if (!clone) return;
      clone.setEnabled(true);
      for (const m of clone.getChildMeshes()) {
        m.isPickable = true;
        m.metadata = node.id;
        this.shadows?.addShadowCaster(m);
      }
      root = clone;
      root.scaling.setAll(0.9 + h2 * 0.4);
    } else {
      const variants = node.kind === "tree" ? TREE_VARIANTS : ROCK_VARIANTS;
      const v = variants[Math.floor(h1 * variants.length) % variants.length];
      const prop = this.spawnProp(v.url, `node:${node.id}`, node.id);
      if (!prop) return;
      root = prop;
      root.scaling.setAll(v.scale * (0.85 + h2 * 0.4));
    }

    root.rotation.y = h1 * Math.PI * 2;
    root.position.set(node.pos.x, y - 0.06, node.pos.z);
    this.nodeVisuals.set(node.id, { root, data: node });
    this.applyNodeState(node);
  }

  /** Apply a 10 Hz mob frame (positions, HP, deaths-by-absence). */
  updateMobs(mobs: MobPublic[]): void {
    this.mobLayer?.update(mobs);
  }

  /** Reconcile the structure layer with the authoritative full list. */
  setStructures(structures: Structure[]): void {
    this.structureLayer?.setAll(structures);
  }

  /** Apply remaining-count visual state: depleted nodes shrink. */
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
    const base = nv.root.metadata as { baseScale?: number } | string | null;
    let baseScale = nv.root.scaling.x;
    if (typeof base === "object" && base && base.baseScale !== undefined) {
      baseScale = base.baseScale;
    } else {
      nv.root.metadata = { baseScale };
    }
    const s = node.remaining > 0 ? baseScale : baseScale * 0.25;
    nv.root.scaling.setAll(s);
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  updatePlayers(players: PlayerPublic[]): void {
    if (!this.built) return;
    if (!this.containers) {
      this.pendingPlayers = players.slice();
      return;
    }
    const now = performance.now();
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      let pv = this.playerVisuals.get(p.id);
      if (!pv) {
        const created = this.createPlayer(p);
        if (!created) continue;
        pv = created;
        this.playerVisuals.set(p.id, pv);
      }
      const y = this.groundY(p.pos.x, p.pos.z);
      pv.target.set(p.pos.x, y, p.pos.z);
      pv.facingY = Math.atan2(p.facing.x, p.facing.z);
      pv.busy = p.busy;
      // Derive ground speed from consecutive 10 Hz frames.
      const dt = (now - pv.prevT) / 1000;
      if (dt > 0.02) {
        const dx = p.pos.x - pv.prevX;
        const dz = p.pos.z - pv.prevZ;
        const inst = Math.min(12, Math.hypot(dx, dz) / dt);
        pv.speed = pv.speed * 0.6 + inst * 0.4;
        pv.prevX = p.pos.x;
        pv.prevZ = p.pos.z;
        pv.prevT = now;
      }
      const tagText = `${p.role === "agent" ? "⚙ " : ""}${p.name} · ${p.level}`;
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

  /** Instantiated groups are renamed to "<playerId>:<original>". */
  private findAnim(groups: AnimationGroup[], name: string): AnimationGroup | null {
    return (
      groups.find((g) => g.name === name) ??
      groups.find((g) => g.name.endsWith(`:${name}`)) ??
      null
    );
  }

  private createPlayer(p: PlayerPublic): PlayerVisual | null {
    const spec = CHARACTERS[p.role === "agent" ? "agent" : "human"];
    const container = this.containers?.get(spec.url);
    if (!container) return null;

    const root = new TransformNode(`player:${p.id}`, this.scene);
    const y = this.groundY(p.pos.x, p.pos.z);
    root.position = new Vector3(p.pos.x, y, p.pos.z);

    const entries = container.instantiateModelsToScene((n) => `${p.id}:${n}`, false, {
      doNotInstantiate: true,
    });
    const model = new TransformNode(`model:${p.id}`, this.scene);
    model.parent = root;
    for (const r of entries.rootNodes) r.parent = model;

    // Hide the accessory weapons/shields this loadout doesn't use.
    const meshes: AbstractMesh[] = [];
    for (const r of entries.rootNodes) {
      for (const mesh of r.getChildMeshes()) {
        if (spec.hide.some((frag) => mesh.name.includes(frag))) {
          mesh.setEnabled(false);
          continue;
        }
        mesh.isPickable = p.id !== this.myId;
        mesh.metadata = p.id;
        mesh.overlayColor = new Color3(0.9, 0.1, 0.1);
        mesh.overlayAlpha = 0.55;
        if (mesh instanceof Mesh) {
          mesh.outlineColor = new Color3(0.95, 0.78, 0.4);
          mesh.outlineWidth = 0.012;
        }
        this.shadows?.addShadowCaster(mesh);
        meshes.push(mesh);
      }
    }

    // Normalize to CHARACTER_HEIGHT with feet on the ground.
    model.computeWorldMatrix(true);
    const bounds = root.getHierarchyBoundingVectors(true, (m) => m.isEnabled());
    const rawH = Math.max(0.01, bounds.max.y - bounds.min.y);
    const k = CHARACTER_HEIGHT / rawH;
    model.scaling.setAll(k);
    model.position.y = -(bounds.min.y - root.position.y) * k;

    const groups = entries.animationGroups;
    for (const g of groups) g.stop();
    const anim: AnimSet = {
      idle: this.findAnim(groups, "Idle"),
      walk: this.findAnim(groups, "Walking_A"),
      run: this.findAnim(groups, "Running_A"),
      attack: this.findAnim(groups, spec.attackAnim),
      death: this.findAnim(groups, "Death_A"),
      interact: this.findAnim(groups, "Interact"),
    };

    const tag = MeshBuilder.CreatePlane(`tag:${p.id}`, { width: 2.4, height: 0.8 }, this.scene);
    tag.parent = root;
    tag.position.y = TAG_HEIGHT;
    tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    tag.isPickable = false;
    tag.applyFog = false;
    // Your own name over your own head is clutter — and at the shared shrine
    // spawn it z-fights with nearby citizens' tags into garbage text.
    if (p.id === this.myId) tag.setEnabled(false);

    const pv: PlayerVisual = {
      root,
      model,
      meshes,
      tag,
      tagText: "",
      hp: Math.max(0, Math.round(p.hp)),
      hpMax: p.hpMax,
      target: root.position.clone(),
      facingY: 0,
      busy: false,
      flashUntil: 0,
      anim,
      current: null,
      attackUntil: 0,
      deadUntil: 0,
      prevX: p.pos.x,
      prevZ: p.pos.z,
      prevT: performance.now(),
      speed: 0,
      lift: model.position.y,
    };
    this.play(pv, anim.idle, true);
    const tagText = `${p.role === "agent" ? "⚙ " : ""}${p.name} · ${p.level}`;
    this.drawTag(tag, tagText, p.role, p.hpMax > 0 ? pv.hp / p.hpMax : 0);
    pv.tagText = tagText;
    return pv;
  }

  private play(pv: PlayerVisual, group: AnimationGroup | null, loop: boolean, speed = 1): void {
    if (!group || pv.current === group) return;
    if (pv.current) pv.current.stop();
    group.start(loop, speed);
    pv.current = group;
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

  /** Play the attacker's swing/cast animation. */
  showAttack(playerId: string): void {
    const pv = this.playerVisuals.get(playerId);
    if (!pv || !pv.anim.attack) return;
    const now = performance.now();
    if (now < pv.deadUntil) return;
    const group = pv.anim.attack;
    if (pv.current) pv.current.stop();
    group.start(false, 1.4);
    pv.current = group;
    const span = (group.to - group.from) / 30; // KayKit exports at 30 fps
    pv.attackUntil = now + Math.min(1200, (span * 1000) / 1.4);
  }

  /** Flash the target (player or mob) red and float a damage number. */
  showHit(targetId: string, damage: number, killed: boolean): void {
    const now = performance.now();
    let at: Vector3 | null = null;
    const pv = this.playerVisuals.get(targetId);
    if (pv) {
      pv.flashUntil = now + HIT_FLASH_MS;
      if (killed) {
        pv.deadUntil = now + DEATH_MS;
        pv.attackUntil = 0;
        if (pv.anim.death) {
          if (pv.current) pv.current.stop();
          pv.anim.death.start(false, 1.1);
          pv.current = pv.anim.death;
        }
      }
      at = pv.root.position;
    } else if (this.mobLayer?.has(targetId)) {
      this.mobLayer.hit(targetId);
      at = this.mobLayer.positionOf(targetId);
    }
    if (!at) return;

    const id = this.floaterSeq++;
    const plane = MeshBuilder.CreatePlane(`dmg:${id}`, { width: 1.5, height: 0.75 }, this.scene);
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
    plane.isPickable = false;
    plane.applyFog = false;
    plane.position.copyFrom(at);
    plane.position.y += 2.6;
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
    } else if (typeof id === "string" && this.mobLayer?.has(id)) {
      this.setHovered(null);
      this.canvas.style.cursor = "crosshair";
    } else {
      this.setHovered(null);
    }
  }

  /** Gold-outline the hovered target and switch to a crosshair cursor. */
  private setHovered(id: string | null): void {
    if (id === this.hoveredId) return;
    if (this.hoveredId) {
      const prev = this.playerVisuals.get(this.hoveredId);
      if (prev) for (const m of prev.meshes) if (m instanceof Mesh) m.renderOutline = false;
    }
    this.hoveredId = id;
    const next = id ? this.playerVisuals.get(id) : undefined;
    if (next) for (const m of next.meshes) if (m instanceof Mesh) m.renderOutline = true;
    this.canvas.style.cursor = next ? "crosshair" : "default";
  }

  // -------------------------------------------------------------------------
  // Per-frame animation: interpolation, animation states, camera follow
  // -------------------------------------------------------------------------

  private animate(): void {
    const dt = this.engine.getDeltaTime() / 1000;
    const lerpFactor = 1 - Math.exp(-10 * dt);
    const now = performance.now();

    for (const pv of this.playerVisuals.values()) {
      const dead = now < pv.deadUntil;
      if (dead) {
        // Hold position; sink and fade through the death animation.
        const t = 1 - (pv.deadUntil - now) / DEATH_MS;
        const fade = Math.max(0, 1 - Math.max(0, t - 0.55) / 0.45);
        for (const m of pv.meshes) m.visibility = fade;
        pv.model.position.y = pv.lift - (Math.max(0, t - 0.6) / 0.4) * 0.9;
        pv.tag.visibility = fade;
        pv.speed = 0;
        continue;
      }
      if (pv.meshes.length > 0 && pv.meshes[0].visibility < 1) {
        // Respawn: restore, snap to the authoritative position.
        for (const m of pv.meshes) m.visibility = 1;
        pv.tag.visibility = 1;
        pv.model.position.y = pv.lift;
        pv.root.position.copyFrom(pv.target);
        pv.current?.stop();
        pv.current = null;
        this.play(pv, pv.anim.idle, true);
      }

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

      // Animation state machine.
      if (now < pv.attackUntil) {
        // one-shot attack owns the rig
      } else if (pv.busy) {
        this.play(pv, pv.anim.interact ?? pv.anim.idle, true);
      } else if (pv.speed > RUN_SPEED_MIN) {
        this.play(pv, pv.anim.run, true);
      } else if (pv.speed > WALK_SPEED_MIN) {
        this.play(pv, pv.anim.walk, true);
      } else {
        this.play(pv, pv.anim.idle, true);
      }

      // Brief red overlay after taking a hit.
      const flashing = now < pv.flashUntil;
      for (const m of pv.meshes) m.renderOverlay = flashing;
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

    // Mobs lerp gently (they move on 1 s game ticks); fires flicker.
    this.mobLayer?.animate(now, 1 - Math.exp(-3 * dt));
    this.structureLayer?.animate(now);

    // Slow sanctuary pulse + shrine ember flicker.
    if (this.safeZoneMat) {
      this.safeZoneMat.alpha = 0.22 + 0.1 * (Math.sin(now / 1400) + 1) * 0.5;
    }
    if (this.emberMat) {
      const flicker = 0.92 + 0.08 * Math.sin(now / 230) * Math.sin(now / 77);
      this.emberMat.emissiveColor.set(1.0 * flicker, 0.72 * flicker, 0.25 * flicker);
    }
    // Animated water: scroll the bump texture two ways for a cross-chop.
    if (this.waterBump) {
      this.waterBump.uOffset = now * 0.0000125;
      this.waterBump.vOffset = now * 0.0000085;
    }

    const me = this.myId ? this.playerVisuals.get(this.myId) : undefined;
    if (me) {
      this.cameraTargetTmp.copyFrom(me.root.position);
      this.cameraTargetTmp.y += 1.1;
      Vector3.LerpToRef(
        this.camera.target,
        this.cameraTargetTmp,
        Math.min(1, lerpFactor * 1.5),
        this.camera.target,
      );
    }
  }

  private readonly cameraTargetTmp = new Vector3();

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
// Village layout tables
// ---------------------------------------------------------------------------

interface BuildingSpec {
  name: string;
  url: string;
  angle: number;
  radius: number;
  scale: number;
  /** Extra Y rotation on top of "face the centre". */
  faceOffset: number;
}

const VILLAGE_BUILDINGS: BuildingSpec[] = [
  { name: "tavern", url: `${ASSETS}/village/building_tavern_yellow.gltf`, angle: 18, radius: 11.5, scale: 6, faceOffset: 0 },
  { name: "homeA", url: `${ASSETS}/village/building_home_A_yellow.gltf`, angle: 85, radius: 11, scale: 6, faceOffset: 0 },
  { name: "homeB", url: `${ASSETS}/village/building_home_B_yellow.gltf`, angle: 140, radius: 11.5, scale: 6, faceOffset: 0 },
  { name: "blacksmith", url: `${ASSETS}/village/building_blacksmith_yellow.gltf`, angle: 207, radius: 11.5, scale: 5.5, faceOffset: 0 },
  { name: "market", url: `${ASSETS}/village/building_market_yellow.gltf`, angle: 277, radius: 10, scale: 5, faceOffset: 0 },
  { name: "well", url: `${ASSETS}/village/building_well_yellow.gltf`, angle: 330, radius: 6.5, scale: 4, faceOffset: 0 },
];

interface VillagePropSpec {
  name: string;
  url: string;
  angle: number;
  radius: number;
  scale: number;
}

const VILLAGE_PROPS: VillagePropSpec[] = [
  { name: "barrel1", url: `${ASSETS}/village/barrel.gltf`, angle: 32, radius: 9, scale: 5 },
  { name: "crate1", url: `${ASSETS}/village/crate_A_big.gltf`, angle: 28, radius: 8.2, scale: 5 },
  { name: "sack1", url: `${ASSETS}/village/sack.gltf`, angle: 286, radius: 8, scale: 6 },
  { name: "sack2", url: `${ASSETS}/village/sack.gltf`, angle: 292, radius: 8.8, scale: 5 },
  { name: "lumber", url: `${ASSETS}/village/resource_lumber.gltf`, angle: 214, radius: 8.6, scale: 5 },
  { name: "wheelbarrow", url: `${ASSETS}/village/wheelbarrow.gltf`, angle: 95, radius: 8.4, scale: 5 },
  { name: "tent", url: `${ASSETS}/village/tent.gltf`, angle: 118, radius: 12.6, scale: 6 },
  { name: "flag", url: `${ASSETS}/village/flag_yellow.gltf`, angle: 0, radius: 14.6, scale: 6 },
  { name: "flag2", url: `${ASSETS}/village/flag_yellow.gltf`, angle: 180, radius: 14.6, scale: 6 },
];

const TORCH_URL = `${ASSETS}/dungeon/torch_lit.glb`;
/** Museum statue scans (Three D Scans, free for any use) — premium set dressing. */
const SPHINX_URL = `${ASSETS}/statues/sphinx.glb`;
const SIREN_URL = `${ASSETS}/statues/siren.glb`;
const PILLAR_URL = `${ASSETS}/dungeon/pillar_decorated.glb`;
const FENCE_URL = `${ASSETS}/dungeon/barrier.glb`;
const CHEST_URL = `${ASSETS}/dungeon/chest_gold.glb`;

// ---------------------------------------------------------------------------

/** Vertex colors: beach sand, meadow grass with tonal variation, highland rock. */
function terrainColor(x: number, y: number, z: number): [number, number, number] {
  const sand: [number, number, number] = [0.85, 0.76, 0.52];
  const grassA: [number, number, number] = [0.33, 0.55, 0.27];
  const grassB: [number, number, number] = [0.42, 0.6, 0.28];
  const rock: [number, number, number] = [0.5, 0.48, 0.5];
  const snow: [number, number, number] = [0.78, 0.78, 0.8];
  // Cheap deterministic tone noise so meadows aren't a flat green sheet.
  const n = 0.5 + 0.5 * Math.sin(x * 0.31 + z * 0.17) * Math.sin(x * 0.05 - z * 0.23);
  const grass = mix(grassA, grassB, n);
  if (y < 0.55) return sand;
  if (y < 1.4) return mix(sand, grass, (y - 0.55) / 0.85);
  if (y < 6.2) return grass;
  if (y < 7.6) return mix(grass, rock, (y - 6.2) / 1.4);
  if (y < 8.6) return rock;
  return mix(rock, snow, Math.min(1, (y - 8.6) / 1.2));
}

function mix(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
