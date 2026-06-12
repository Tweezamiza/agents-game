import {
  ArcRotateCamera,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  GlowLayer,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  VolumetricLightScatteringPostProcess,
} from "@babylonjs/core";

/**
 * Ember-dusk atmosphere: deep indigo night sky with stars and a low moon,
 * cool moonlight, warm ember pools at the shrine, and glow on everything
 * magical. The single biggest lever for the "premium dark fantasy" read —
 * dramatic lighting is texture-free and ships in pure code.
 */

/** Where the moon hangs in the sky; the directional light matches it. */
const MOON_DIR = new Vector3(-0.45, -0.62, 0.35).normalize();

export interface DuskRig {
  hemi: HemisphericLight;
  moon: DirectionalLight;
  glow: GlowLayer;
}

/** Scene-wide colors: clear color, fog, and the two scene lights. */
export function applyDuskLighting(scene: Scene): DuskRig {
  scene.clearColor = new Color4(0.045, 0.05, 0.105, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.0034;
  scene.fogColor = new Color3(0.075, 0.085, 0.16);

  // Cool moonlit fill; ground bounce stays faintly warm so torchlit areas read.
  const hemi = new HemisphericLight("hemi", new Vector3(0.1, 1, 0.05), scene);
  hemi.intensity = 0.34;
  hemi.diffuse = new Color3(0.52, 0.6, 0.85);
  hemi.groundColor = new Color3(0.16, 0.13, 0.17);

  const moon = new DirectionalLight("moon", MOON_DIR.clone(), scene);
  moon.intensity = 0.85;
  moon.diffuse = new Color3(0.6, 0.7, 1.0);
  moon.specular = new Color3(0.25, 0.3, 0.45);

  // Emissive surfaces (crystals, flames, cores, the shrine ember) bloom out.
  const glow = new GlowLayer("glow", scene, { mainTextureSamples: 2 });
  glow.intensity = 0.85;

  return { hemi, moon, glow };
}

/**
 * Star-field gradient dome + a visible moon disc. Returns the moon mesh so
 * the caller can hang volumetric god rays off it.
 */
export function buildDuskSky(scene: Scene, worldCenter: Vector3): Mesh {
  const tex = new DynamicTexture("skyTex", { width: 1024, height: 1024 }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;

  // Vertical dusk gradient: indigo zenith to a dying ember band at the horizon.
  const grad = ctx.createLinearGradient(0, 0, 0, 1024);
  grad.addColorStop(0, "#0a0c1f");
  grad.addColorStop(0.55, "#141a38");
  grad.addColorStop(0.78, "#2c2546");
  grad.addColorStop(0.92, "#54304a");
  grad.addColorStop(1, "#7a4434");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 1024);

  // Stars: denser and brighter near the zenith, fading toward the horizon.
  for (let i = 0; i < 720; i++) {
    const x = Math.random() * 1024;
    const y = Math.pow(Math.random(), 1.6) * 860;
    const r = Math.random() < 0.06 ? 1.6 : Math.random() * 0.9 + 0.35;
    const a = (1 - y / 1024) * (0.35 + Math.random() * 0.65);
    ctx.fillStyle = `rgba(255, 248, 235, ${a.toFixed(2)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update(false);

  const dome = MeshBuilder.CreateSphere(
    "skyDome",
    { diameter: 1000, sideOrientation: Mesh.BACKSIDE, segments: 16 },
    scene,
  );
  const mat = new StandardMaterial("matSkyDome", scene);
  mat.emissiveTexture = tex;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  dome.material = mat;
  dome.position = worldCenter.clone();
  dome.infiniteDistance = true;
  dome.applyFog = false;
  dome.isPickable = false;

  // The moon: a glowing disc hung opposite the moonlight direction.
  const moonDisc = MeshBuilder.CreateDisc("moonDisc", { radius: 14, tessellation: 48 }, scene);
  const moonMat = new StandardMaterial("matMoon", scene);
  moonMat.emissiveColor = new Color3(0.92, 0.95, 1.0);
  moonMat.diffuseColor = Color3.Black();
  moonMat.specularColor = Color3.Black();
  moonMat.disableLighting = true;
  moonDisc.material = moonMat;
  moonDisc.position = worldCenter.subtract(MOON_DIR.scale(460));
  moonDisc.billboardMode = Mesh.BILLBOARDMODE_ALL;
  moonDisc.infiniteDistance = true;
  moonDisc.applyFog = false;
  moonDisc.isPickable = false;
  return moonDisc;
}

/** Moon god rays — soft volumetric shafts. Guarded: skipped if unsupported. */
export function addMoonRays(
  scene: Scene,
  camera: ArcRotateCamera,
  moonDisc: Mesh,
): void {
  try {
    const rays = new VolumetricLightScatteringPostProcess(
      "moonRays",
      0.5,
      camera,
      moonDisc,
      48,
    );
    rays.exposure = 0.22;
    rays.decay = 0.968;
    rays.weight = 0.5;
    rays.density = 0.94;
  } catch {
    // Post-process unavailable on this device — the sky still reads as dusk.
  }
}

/** Night-tuned bloom + grade on the shared pipeline. */
export function tuneNightPipeline(pipeline: DefaultRenderingPipeline): void {
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 0.6;
  pipeline.bloomWeight = 0.45;
  pipeline.bloomKernel = 64;
  pipeline.bloomScale = 0.5;
  try {
    pipeline.imageProcessingEnabled = true;
    const ip = pipeline.imageProcessing;
    if (ip) {
      ip.vignetteEnabled = true;
      ip.vignetteWeight = 1.9;
      ip.vignetteColor = new Color4(0.02, 0.01, 0.05, 0);
      ip.exposure = 1.12;
      ip.contrast = 1.14;
    }
  } catch {
    // Image processing unavailable — bloom alone still sells the night.
  }
}

/** A small emissive flame orb (GlowLayer makes it bloom) for torch tips. */
export function addFlameOrb(scene: Scene, x: number, y: number, z: number, scale = 1): Mesh {
  const orb = MeshBuilder.CreateSphere(
    `flameOrb:${x.toFixed(0)}:${z.toFixed(0)}`,
    { diameter: 0.34 * scale, segments: 6 },
    scene,
  );
  let mat = scene.getMaterialByName("matFlameOrb") as StandardMaterial | null;
  if (!mat) {
    mat = new StandardMaterial("matFlameOrb", scene);
    mat.emissiveColor = new Color3(1.0, 0.58, 0.16);
    mat.disableLighting = true;
  }
  orb.material = mat;
  orb.position.set(x, y, z);
  orb.isPickable = false;
  return orb;
}
