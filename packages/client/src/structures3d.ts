import {
  Color3,
  Mesh,
  MeshBuilder,
  PointLight,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import { TERRITORY, type Structure } from "@agentworld/protocol";

/** Stable owner hue so each player's banners/territory share a colour. */
function ownerColor(ownerId: string): Color3 {
  let v = 2166136261;
  for (let i = 0; i < ownerId.length; i++) {
    v ^= ownerId.charCodeAt(i);
    v = Math.imul(v, 16777619);
  }
  return Color3.FromHSV(((v >>> 0) % 360 + 360) % 360, 0.65, 0.9);
}

interface StructureVisual {
  root: TransformNode;
  flame: StandardMaterial | null;
  light: PointLight | null;
}

/** Player-built structures: campfires, walls, banners + territory rings. */
export class StructureLayer {
  private readonly visuals = new Map<string, StructureVisual>();

  constructor(
    private readonly scene: Scene,
    private readonly shadows: ShadowGenerator | null,
    private readonly groundY: (x: number, z: number) => number,
  ) {}

  /** Reconcile with the authoritative full list (build/banner-move/removal). */
  setAll(structures: Structure[]): void {
    const seen = new Set<string>();
    for (const s of structures) {
      seen.add(s.id);
      if (!this.visuals.has(s.id)) this.visuals.set(s.id, this.create(s));
    }
    for (const [id, sv] of this.visuals) {
      if (!seen.has(id)) {
        sv.light?.dispose();
        sv.root.dispose(false, true);
        this.visuals.delete(id);
      }
    }
  }

  /** Campfire flame + light flicker. */
  animate(now: number): void {
    for (const sv of this.visuals.values()) {
      if (!sv.flame) continue;
      const flicker = 0.85 + 0.15 * Math.sin(now / 170) * Math.sin(now / 53);
      sv.flame.emissiveColor.set(1.0 * flicker, 0.55 * flicker, 0.12 * flicker);
      if (sv.light) sv.light.intensity = 0.85 * flicker;
    }
  }

  // -------------------------------------------------------------------------

  private create(s: Structure): StructureVisual {
    const root = new TransformNode(`structure:${s.id}`, this.scene);
    const y = this.groundY(s.pos.x, s.pos.z);
    root.position.set(s.pos.x, y, s.pos.z);
    if (s.kind === "campfire") return this.buildCampfire(s, root);
    if (s.kind === "wall") return this.buildWall(s, root);
    return this.buildBanner(s, root);
  }

  private solid(name: string, color: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = color;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    return m;
  }

  private buildCampfire(s: Structure, root: TransformNode): StructureVisual {
    const wood = this.solid(`matLogs:${s.id}`, new Color3(0.38, 0.26, 0.15));
    for (let i = 0; i < 3; i++) {
      const log = MeshBuilder.CreateCylinder(`log${i}:${s.id}`, { height: 1.1, diameter: 0.16 }, this.scene);
      log.rotation.z = Math.PI / 2 - 0.5;
      log.rotation.y = (i * 2 * Math.PI) / 3;
      log.position.y = 0.22;
      log.material = wood;
      log.parent = root;
      this.shadows?.addShadowCaster(log);
    }
    const flameMat = new StandardMaterial(`matFlame:${s.id}`, this.scene);
    flameMat.emissiveColor = new Color3(1.0, 0.55, 0.12);
    flameMat.disableLighting = true;
    flameMat.alpha = 0.85;
    const flame = MeshBuilder.CreateCylinder(`flame:${s.id}`, { height: 0.8, diameterTop: 0, diameterBottom: 0.5, tessellation: 8 }, this.scene);
    flame.position.y = 0.65;
    flame.material = flameMat;
    flame.isPickable = false;
    flame.parent = root;
    const light = new PointLight(`fireLight:${s.id}`, new Vector3(0, 0.9, 0), this.scene);
    light.parent = root;
    light.diffuse = new Color3(1.0, 0.6, 0.25);
    light.range = 10;
    light.intensity = 0.85;
    return { root, flame: flameMat, light };
  }

  private buildWall(s: Structure, root: TransformNode): StructureVisual {
    const wall = MeshBuilder.CreateBox(`wall:${s.id}`, { width: 3, height: 1.4, depth: 0.5 }, this.scene);
    wall.position.y = 0.6;
    wall.material = this.solid(`matWall:${s.id}`, new Color3(0.46, 0.45, 0.48));
    wall.parent = root;
    // Deterministic orientation from the id so walls aren't all axis-aligned.
    root.rotation.y = (s.id.charCodeAt(s.id.length - 1) % 8) * (Math.PI / 8);
    this.shadows?.addShadowCaster(wall);
    return { root, flame: null, light: null };
  }

  private buildBanner(s: Structure, root: TransformNode): StructureVisual {
    const color = ownerColor(s.ownerId);
    const pole = MeshBuilder.CreateCylinder(`pole:${s.id}`, { height: 3.2, diameter: 0.12 }, this.scene);
    pole.position.y = 1.6;
    pole.material = this.solid(`matPole:${s.id}`, new Color3(0.32, 0.24, 0.16));
    pole.parent = root;
    this.shadows?.addShadowCaster(pole);
    const clothMat = this.solid(`matCloth:${s.id}`, color);
    clothMat.emissiveColor = color.scale(0.25);
    clothMat.backFaceCulling = false;
    const cloth = MeshBuilder.CreatePlane(`cloth:${s.id}`, { width: 1.1, height: 0.8 }, this.scene);
    cloth.position.set(0.6, 2.7, 0);
    cloth.material = clothMat;
    cloth.parent = root;
    this.buildTerritoryRing(s, root, color);
    return { root, flame: null, light: null };
  }

  /** Translucent territory ring draped on the terrain at the claim radius. */
  private buildTerritoryRing(s: Structure, root: TransformNode, color: Color3): void {
    const segments = 96;
    const rInner = TERRITORY.BANNER_RADIUS - 0.6;
    const rOuter = TERRITORY.BANNER_RADIUS + 0.3;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const r of [rInner, rOuter]) {
        const x = s.pos.x + ca * r;
        const z = s.pos.z + sa * r;
        positions.push(x, this.groundY(x, z) + 0.08, z);
      }
    }
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      const b = ((i + 1) % segments) * 2;
      indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    const ring = new Mesh(`territory:${s.id}`, this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.applyToMesh(ring);
    ring.isPickable = false;
    const mat = new StandardMaterial(`matTerritory:${s.id}`, this.scene);
    mat.emissiveColor = color;
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0.28;
    ring.material = mat;
    ring.parent = root;
    // Ring vertices are in world space; cancel the root's offset.
    ring.position.set(-s.pos.x, -root.position.y, -s.pos.z);
  }
}
