import "@babylonjs/loaders/glTF";
import {
  ArcRotateCamera,
  Bone,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  Engine,
  FresnelParameters,
  GlowLayer,
  HemisphericLight,
  LoadAssetContainerAsync,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PointLight,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
} from "@babylonjs/core";

const ASSETS = "/assets";
const EMBER = new Color3(1.0, 0.42, 0.12);
const EMBER4 = new Color4(1.0, 0.45, 0.14, 1);

const DOT_TEXTURE =
  "data:image/svg+xml;base64," +
  btoa(
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'><defs><radialGradient id='g'><stop offset='0' stop-color='white'/><stop offset='1' stop-color='white' stop-opacity='0'/></radialGradient></defs><circle cx='16' cy='16' r='16' fill='url(#g)'/></svg>",
  );

/**
 * Hero showcase: proof that pure-code VFX (dark armor + ember rim, a glowing
 * greatsword, a rotating rune circle, rising motes, and a periodic skill
 * shockwave) turn a plain model into an MMO-grade dark-fantasy hero. No new
 * meshes downloaded — the Skeleton Warrior we already ship, dressed in light.
 */
export class HeroShowcase {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private root!: TransformNode;
  private dot: Texture;
  private clock = 0;
  private nextSkill = 2.5;
  private emberLight: PointLight;
  private rune: TransformNode;
  private wings: TransformNode[] = [];
  private chestCore: StandardMaterial | null = null;
  private shockwaves: { mesh: Mesh; mat: StandardMaterial; t: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { stencil: true });
    this.scene = new Scene(this.engine);
    this.dot = new Texture(DOT_TEXTURE, this.scene);
    this.scene.clearColor = new Color4(0.015, 0.012, 0.03, 1);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.04;
    this.scene.fogColor = new Color3(0.03, 0.025, 0.06);

    this.camera = new ArcRotateCamera("cam", -Math.PI / 2.4, 1.34, 6.6, new Vector3(0, 1.2, 0), this.scene);
    this.camera.attachControl(canvas, true);
    this.camera.lowerRadiusLimit = 3.5;
    this.camera.upperRadiusLimit = 12;
    this.camera.lowerBetaLimit = 0.6;
    this.camera.upperBetaLimit = 1.5;
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.minZ = 0.1;

    // Cool moonlit fill so the dark armor reads as a metal form, not a void.
    const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, 0.1), this.scene);
    hemi.intensity = 0.45;
    hemi.diffuse = new Color3(0.42, 0.52, 0.85);
    hemi.groundColor = new Color3(0.05, 0.04, 0.08);
    const key = new DirectionalLight("key", new Vector3(-0.5, -0.7, 0.4), this.scene);
    key.intensity = 0.7;
    key.diffuse = new Color3(0.7, 0.8, 1.0);

    this.emberLight = new PointLight("ember", new Vector3(0, 1.0, 0.5), this.scene);
    this.emberLight.diffuse = EMBER;
    this.emberLight.specular = new Color3(1, 0.7, 0.4);
    this.emberLight.intensity = 5;
    this.emberLight.range = 7;

    const glow = new GlowLayer("glow", this.scene, { mainTextureSamples: 4 });
    glow.intensity = 0.6;

    const pipe = new DefaultRenderingPipeline("pipe", true, this.scene, [this.camera]);
    pipe.fxaaEnabled = true;
    pipe.bloomEnabled = true;
    pipe.bloomThreshold = 0.75;
    pipe.bloomWeight = 0.34;
    pipe.bloomKernel = 64;
    pipe.bloomScale = 0.5;
    pipe.imageProcessingEnabled = true;
    if (pipe.imageProcessing) {
      pipe.imageProcessing.vignetteEnabled = true;
      pipe.imageProcessing.vignetteWeight = 2.2;
      pipe.imageProcessing.vignetteColor = new Color4(0, 0, 0.02, 0);
      pipe.imageProcessing.contrast = 1.12;
      pipe.imageProcessing.exposure = 1.0;
    }

    this.buildStage();
    this.rune = this.buildRuneCircle();
    this.buildAura();
    void this.loadHero();

    this.engine.runRenderLoop(() => {
      this.tick(this.engine.getDeltaTime() / 1000);
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
  }

  private darkSteel(name: string): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = new Color3(0.07, 0.08, 0.12);
    m.specularColor = new Color3(0.6, 0.66, 0.82);
    m.specularPower = 64;
    // Faint ember on the silhouette edge only — the MU "glowing armor" tell,
    // kept subtle (high power = thin rim) so the body stays a lit metal form.
    const fr = new FresnelParameters();
    fr.bias = 0.0;
    fr.power = 4.5;
    fr.leftColor = EMBER.scale(0.6);
    fr.rightColor = Color3.Black();
    m.emissiveColor = new Color3(0, 0, 0);
    m.emissiveFresnelParameters = fr;
    return m;
  }

  private buildStage(): void {
    const floor = MeshBuilder.CreateDisc("floor", { radius: 9, tessellation: 64 }, this.scene);
    floor.rotation.x = Math.PI / 2;
    const fm = new StandardMaterial("floorMat", this.scene);
    fm.diffuseColor = new Color3(0.02, 0.02, 0.04);
    fm.specularColor = new Color3(0.1, 0.1, 0.16);
    fm.emissiveColor = new Color3(0.015, 0.01, 0.03);
    floor.material = fm;
  }

  private buildRuneCircle(): TransformNode {
    const rune = new TransformNode("rune", this.scene);
    const ring = (radius: number, thickness: number, name: string): void => {
      const t = MeshBuilder.CreateTorus(name, { diameter: radius * 2, thickness, tessellation: 64 }, this.scene);
      t.rotation.x = Math.PI / 2;
      const m = new StandardMaterial(name + "Mat", this.scene);
      m.emissiveColor = EMBER;
      m.disableLighting = true;
      t.material = m;
      t.parent = rune;
      t.position.y = 0.02;
    };
    ring(2.3, 0.04, "runeOuter");
    ring(1.7, 0.02, "runeInner");
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tick = MeshBuilder.CreateBox("tick" + i, { width: 0.04, height: 0.02, depth: 0.3 }, this.scene);
      tick.position.set(Math.cos(a) * 2.0, 0.02, Math.sin(a) * 2.0);
      tick.rotation.y = -a;
      const tm = new StandardMaterial("tickMat" + i, this.scene);
      tm.emissiveColor = EMBER;
      tm.disableLighting = true;
      tick.material = tm;
      tick.parent = rune;
    }
    return rune;
  }

  private buildAura(): void {
    const ps = new ParticleSystem("aura", 600, this.scene);
    ps.particleTexture = this.dot;
    ps.emitter = new Vector3(0, 0.1, 0);
    ps.createCylinderEmitter(1.6, 0.2, 0, 0);
    ps.color1 = new Color4(1, 0.55, 0.18, 1);
    ps.color2 = new Color4(1, 0.3, 0.05, 1);
    ps.colorDead = new Color4(0.4, 0.05, 0, 0);
    ps.minSize = 0.03;
    ps.maxSize = 0.11;
    ps.minLifeTime = 1.2;
    ps.maxLifeTime = 2.6;
    ps.emitRate = 90;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.gravity = new Vector3(0, 1.1, 0);
    ps.minEmitPower = 0.2;
    ps.maxEmitPower = 0.7;
    ps.start();
  }

  private async loadHero(): Promise<void> {
    const c = await LoadAssetContainerAsync(`${ASSETS}/characters/Skeleton_Warrior.glb`, this.scene);
    const entries = c.instantiateModelsToScene((n) => n, false, { doNotInstantiate: true });
    this.root = new TransformNode("heroRoot", this.scene);
    for (const r of entries.rootNodes) {
      r.parent = this.root;
      if (r instanceof TransformNode) r.scaling.setAll(1.0);
    }
    this.root.computeWorldMatrix(true);
    const b = this.root.getHierarchyBoundingVectors(true);
    const lift = Number.isFinite(b.min.y) ? -b.min.y : 0;
    for (const r of entries.rootNodes) if (r instanceof TransformNode) r.position.y += lift;

    const steel = this.darkSteel("knightSteel");
    let skinned: Mesh | undefined;
    for (const m of this.root.getChildMeshes()) {
      if (!(m instanceof Mesh)) continue;
      if (m.skeleton && !skinned) skinned = m;
      if ((m.material?.name ?? "").toLowerCase().includes("glow")) continue; // keep ember eyes
      m.material = steel;
    }
    const idle = entries.animationGroups.find((g) => /idle/i.test(g.name)) ?? entries.animationGroups[0];
    idle?.start(true, 1);

    const skel = entries.skeletons[0] ?? skinned?.skeleton ?? null;
    const handBone =
      skel?.bones.find((b) => b.name === "handslot.r") ?? skel?.bones.find((b) => b.name === "hand.r") ?? null;

    this.buildArmor();
    this.buildWings();
    this.buildSword(handBone && skinned ? { bone: handBone, mesh: skinned } : null);
  }

  /** Spiked pauldrons, gauntlet plates, and a pulsing ember chest core. */
  private buildArmor(): void {
    const steel = this.darkSteel("plateSteel");
    for (const side of [1, -1]) {
      const pauldron = MeshBuilder.CreateSphere("pauldron" + side, { diameter: 0.46, segments: 12 }, this.scene);
      pauldron.scaling.set(1.05, 0.72, 1.05);
      pauldron.position.set(side * 0.34, 1.46, 0);
      pauldron.material = steel;
      pauldron.parent = this.root;
      for (let s = 0; s < 2; s++) {
        const spike = MeshBuilder.CreateCylinder("spike" + side + s, { height: 0.26, diameterTop: 0, diameterBottom: 0.09, tessellation: 6 }, this.scene);
        spike.position.set(side * (0.32 + s * 0.1), 1.6 + s * 0.04, -0.02);
        spike.rotation.z = side * (0.5 + s * 0.25);
        spike.material = steel;
        spike.parent = this.root;
      }
    }
    const core = MeshBuilder.CreatePolyhedron("chestCore", { type: 1, size: 0.1 }, this.scene);
    core.position.set(0, 1.28, 0.17);
    const cm = new StandardMaterial("chestCoreMat", this.scene);
    cm.emissiveColor = EMBER;
    cm.diffuseColor = Color3.Black();
    cm.disableLighting = true;
    core.material = cm;
    core.parent = this.root;
    this.chestCore = cm;
  }

  /** Procedural dark wings — fanned feathers with ember-glowing edges. */
  private buildWings(): void {
    const fm = new StandardMaterial("featherMat", this.scene);
    fm.diffuseColor = new Color3(0.03, 0.03, 0.06);
    fm.specularColor = new Color3(0.2, 0.2, 0.32);
    fm.backFaceCulling = false;
    const fr = new FresnelParameters();
    fr.bias = 0.0;
    fr.power = 1.8;
    fr.leftColor = EMBER.scale(0.9);
    fr.rightColor = Color3.Black();
    fm.emissiveFresnelParameters = fr;

    for (const side of [1, -1]) {
      const wing = new TransformNode("wing" + side, this.scene);
      wing.parent = this.root;
      wing.position.set(side * 0.12, 1.42, -0.18);
      wing.rotation.x = 0.18;
      const n = 6;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const len = 0.65 + Math.sin(t * Math.PI) * 0.75;
        const holder = new TransformNode("fh" + side + i, this.scene);
        holder.parent = wing;
        holder.rotation.y = side * (0.18 + t * 1.2);
        holder.rotation.x = -0.45 - t * 0.4;
        const f = MeshBuilder.CreateBox("feather" + side + i, { width: 0.07, height: 0.015, depth: len }, this.scene);
        f.position.z = -len / 2;
        f.material = fm;
        f.parent = holder;
      }
      this.wings.push(wing);
    }
  }

  private buildSword(grip: { bone: Bone; mesh: Mesh } | null): void {
    const sword = new TransformNode("sword", this.scene);
    if (grip) {
      sword.attachToBone(grip.bone, grip.mesh);
      sword.position.set(0, 0.04, 0);
      sword.rotation.set(Math.PI / 2, 0, 0);
      sword.scaling.setAll(1);
    } else {
      sword.parent = this.root;
      sword.position.set(0.55, 0, 0.75);
      sword.rotation.set(0.16, 0, 0.08);
    }

    const blade = MeshBuilder.CreateBox("blade", { width: 0.12, height: 1.7, depth: 0.03 }, this.scene);
    blade.position.y = 1.15;
    const bm = new StandardMaterial("bladeMat", this.scene);
    bm.emissiveColor = new Color3(0.6, 0.85, 1.0);
    bm.disableLighting = true;
    blade.material = bm;
    blade.parent = sword;

    const core = MeshBuilder.CreateBox("bladeCore", { width: 0.035, height: 1.6, depth: 0.05 }, this.scene);
    core.position.y = 1.15;
    const cm = new StandardMaterial("coreMat", this.scene);
    cm.emissiveColor = new Color3(1, 1, 1);
    cm.disableLighting = true;
    core.material = cm;
    core.parent = sword;

    const gm = new StandardMaterial("hiltMat", this.scene);
    gm.diffuseColor = new Color3(0.08, 0.08, 0.1);
    gm.emissiveColor = EMBER.scale(0.4);

    const guard = MeshBuilder.CreateBox("guard", { width: 0.5, height: 0.07, depth: 0.1 }, this.scene);
    guard.position.y = 0.32;
    guard.material = gm;
    guard.parent = sword;

    const gripMesh = MeshBuilder.CreateCylinder("grip", { height: 0.3, diameter: 0.06 }, this.scene);
    gripMesh.position.y = 0.16;
    gripMesh.material = gm;
    gripMesh.parent = sword;

    const pommel = MeshBuilder.CreateSphere("pommel", { diameter: 0.14 }, this.scene);
    pommel.position.y = 0.0;
    const pm = new StandardMaterial("pommelMat", this.scene);
    pm.emissiveColor = EMBER;
    pm.disableLighting = true;
    pommel.material = pm;
    pommel.parent = sword;
  }

  private castSkill(): void {
    const ring = MeshBuilder.CreateTorus("shock" + this.clock.toFixed(2), { diameter: 1, thickness: 0.12, tessellation: 48 }, this.scene);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    const m = new StandardMaterial("shockMat", this.scene);
    m.emissiveColor = new Color3(0.7, 0.85, 1.0);
    m.disableLighting = true;
    m.alpha = 0.9;
    ring.material = m;
    this.shockwaves.push({ mesh: ring, mat: m, t: 0 });
    this.emberLight.intensity = 34;

    const burst = new ParticleSystem("burst", 220, this.scene);
    burst.particleTexture = this.dot;
    burst.emitter = new Vector3(0, 0.2, 0);
    burst.createCylinderEmitter(0.6, 0.3, 0, 0);
    burst.color1 = new Color4(0.7, 0.9, 1, 1);
    burst.color2 = EMBER4;
    burst.colorDead = new Color4(0.3, 0.1, 0, 0);
    burst.minSize = 0.05;
    burst.maxSize = 0.18;
    burst.minLifeTime = 0.4;
    burst.maxLifeTime = 0.9;
    burst.manualEmitCount = 220;
    burst.blendMode = ParticleSystem.BLENDMODE_ADD;
    burst.gravity = new Vector3(0, 3, 0);
    burst.minEmitPower = 2;
    burst.maxEmitPower = 5;
    burst.disposeOnStop = true;
    burst.start();
    setTimeout(() => burst.stop(), 120);
  }

  private tick(dt: number): void {
    this.clock += dt;
    this.camera.alpha += dt * 0.12;
    const pulse = 0.7 + Math.sin(this.clock * 2) * 0.3;
    this.rune.rotation.y += dt * 0.35;
    for (const m of this.rune.getChildMeshes()) {
      const mat = m.material as StandardMaterial | null;
      if (mat) mat.emissiveColor = EMBER.scale(pulse);
    }
    const flick = 5 + Math.sin(this.clock * 13) * 1.2;
    this.emberLight.intensity += (flick - this.emberLight.intensity) * Math.min(1, dt * 4);

    // Slow wing flap and a breathing ember chest core.
    const flap = Math.sin(this.clock * 1.6) * 0.16;
    for (let i = 0; i < this.wings.length; i++) {
      const dir = i === 0 ? 1 : -1;
      this.wings[i].rotation.z = dir * (0.12 + flap);
    }
    if (this.chestCore) this.chestCore.emissiveColor = EMBER.scale(0.7 + Math.sin(this.clock * 2.5) * 0.3);

    for (const s of this.shockwaves) {
      s.t += dt;
      const scale = 1 + s.t * 9;
      s.mesh.scaling.set(scale, scale, 1);
      s.mat.alpha = Math.max(0, 0.9 - s.t * 1.1);
    }
    this.shockwaves = this.shockwaves.filter((s) => {
      if (s.t > 0.85) {
        s.mesh.dispose();
        return false;
      }
      return true;
    });

    this.nextSkill -= dt;
    if (this.nextSkill <= 0) {
      this.castSkill();
      this.nextSkill = 5;
    }
  }
}
