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
  type PlayerPublic,
  type ResourceKind,
  type ResourceNode,
  WORLD,
  terrainHeight,
} from "@agentworld/protocol";

export interface PickHandlers {
  onTerrain: (x: number, z: number) => void;
  onNode: (node: ResourceNode) => void;
}

interface PlayerVisual {
  root: TransformNode;
  capsule: Mesh;
  tag: Mesh;
  tagText: string;
  /** Latest authoritative server position (lerp target). */
  target: Vector3;
  facingY: number;
  busy: boolean;
}

interface NodeVisual {
  root: TransformNode;
  data: ResourceNode;
}

const CAPSULE_HALF_HEIGHT = 0.9;
const SNAP_DISTANCE = 5;

export class World3D {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private seed = 0;
  private built = false;
  private terrain: Mesh | null = null;
  private readonly nodeVisuals = new Map<string, NodeVisual>();
  private readonly playerVisuals = new Map<string, PlayerVisual>();
  private myId: string | null = null;

  private matHuman: StandardMaterial;
  private matAgent: StandardMaterial;
  private matTrunk: StandardMaterial;
  private matLeaves: StandardMaterial;
  private matRock: StandardMaterial;
  private matCrystal: StandardMaterial;

  constructor(
    canvas: HTMLCanvasElement,
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
      if (pi.type !== PointerEventTypes.POINTERTAP) return;
      const pick = pi.pickInfo;
      if (!pick || !pick.hit || !pick.pickedMesh) return;
      const nodeId = pick.pickedMesh.metadata as string | null;
      if (typeof nodeId === "string") {
        const nv = this.nodeVisuals.get(nodeId);
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
      if (tagText !== pv.tagText) {
        this.drawTag(pv.tag, tagText, p.role);
        pv.tagText = tagText;
      }
    }
    for (const [id, pv] of this.playerVisuals) {
      if (!seen.has(id)) {
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
    capsule.isPickable = false;

    const tag = MeshBuilder.CreatePlane(`tag:${p.id}`, { width: 2.4, height: 0.6 }, this.scene);
    tag.parent = root;
    tag.position.y = 1.6;
    tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
    tag.isPickable = false;

    const pv: PlayerVisual = {
      root,
      capsule,
      tag,
      tagText: "",
      target: root.position.clone(),
      facingY: 0,
      busy: false,
    };
    const tagText = p.role === "agent" ? `⚙ ${p.name}` : p.name;
    this.drawTag(tag, tagText, p.role);
    pv.tagText = tagText;
    return pv;
  }

  private drawTag(tag: Mesh, text: string, role: PlayerPublic["role"]): void {
    tag.material?.dispose(false, true);
    const tex = new DynamicTexture(
      `tagTex:${tag.name}`,
      { width: 384, height: 96 },
      this.scene,
      true,
    );
    tex.hasAlpha = true;
    const color = role === "agent" ? "#ffc07a" : "#bcd9ff";
    tex.drawText(text, null, 64, "bold 44px Georgia", color, null, true);
    const mat = new StandardMaterial(`tagMat:${tag.name}`, this.scene);
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    tag.material = mat;
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
