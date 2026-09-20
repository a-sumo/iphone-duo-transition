import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export const SEQUENCE_DURATION = 3.683;

export type SequenceState = {
  rightAngle: number;
  leftAngle: number;
  leftImage: number;
  rightPaper: number;
  leftPaper: number;
};

export type ScreenSurface = "raw-mesh" | "screen-triangles" | "solid-mask" |
  "background" | "plane-outlines" | "mask-composite" | "matte-paper" |
  "edge-darkening" | "inner-left" | "inner-right" | "outer-cover";

export type CoordinatedPaperScene = {
  setTime: (seconds: number) => SequenceState;
  beginGrab: (clientX: number, clientY: number) => boolean;
  hitsPhoneSilhouette: (clientX: number, clientY: number) => boolean;
  moveGrab: (clientX: number, clientY: number) => number | null;
  endGrab: () => void;
  setOrbitEnabled: (enabled: boolean) => void;
  setBlurIntensity: (intensity: number) => void;
  setTransitionLength: (length: number) => void;
  setEdgeDarkening: (intensity: number) => void;
  setMoveView: (enabled: boolean) => void;
  resetView: () => void;
  inspectSurface: (surface: ScreenSurface, triangles: boolean) => void;
  dispose: () => void;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (a: number, b: number, value: number) => {
  const t = clamp01((value - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ease = (t: number) => t * t * (3 - 2 * t);

export function stateAtTime(seconds: number): SequenceState {
  const time = Math.min(SEQUENCE_DURATION, Math.max(0, seconds));
  const rightAngle = 90 * ease(clamp01((time - .15) / (1.5 - .15)));
  const leftAngle = 90 * (1 - ease(clamp01((time - 1.7) / (3.15 - 1.7))));
  const paperVisibility = (angle: number) => smoothstep(0, 8, angle);
  return {
    rightAngle,
    leftAngle,
    leftImage: Math.max(0, Math.cos(leftAngle * Math.PI / 180)),
    rightPaper: paperVisibility(rightAngle),
    leftPaper: paperVisibility(leftAngle),
  };
}

// Object_106 is the exact 280-triangle skinned inner display; Object_72 is
// the exact 1,175-triangle outer display. The inner halves share eight
// triangles across UV.x = .5, so they must be partitioned per fragment.
const DISPLAY_MESHES = [
  { node: "Object_106", outer: false, triangles: 280 },
  { node: "Object_72", outer: true, triangles: 1175 },
] as const;

type ImagePlane = {
  origin: THREE.Vector3;
  axisU: THREE.Vector3;
  axisV: THREE.Vector3;
  normal: THREE.Vector3;
};

type ImagePlaneVisual = {
  mesh: THREE.Mesh;
  outline: THREE.LineLoop;
  texture: THREE.Texture;
};

// Fit a stationary image plane to the display in its fully registered pose.
// UVs are the model's own screen coordinates, so at that pose the image lies
// directly beneath the same authored triangles that carry the paper effect.
function fitImagePlane(screen: THREE.Mesh): ImagePlane {
  const uv = screen.geometry.attributes.uv;
  const count = uv.count;
  const sums = new Array(15).fill(0);
  const vertex = new THREE.Vector3();
  for (let index = 0; index < uv.count; index++) {
    screen.getVertexPosition(index, vertex);
    screen.localToWorld(vertex);
    const u = uv.getX(index);
    const v = 1 - uv.getY(index);
    sums[0] += u;
    sums[1] += v;
    sums[2] += u * u;
    sums[3] += u * v;
    sums[4] += v * v;
    sums[5] += vertex.x;
    sums[6] += vertex.y;
    sums[7] += vertex.z;
    sums[9] += u * vertex.x;
    sums[10] += v * vertex.x;
    sums[11] += u * vertex.y;
    sums[12] += v * vertex.y;
    sums[13] += u * vertex.z;
    sums[14] += v * vertex.z;
  }
  const gram = new THREE.Matrix3().set(
    count, sums[0], sums[1],
    sums[0], sums[2], sums[3],
    sums[1], sums[3], sums[4],
  ).invert();
  const x = new THREE.Vector3(sums[5], sums[9], sums[10]).applyMatrix3(gram);
  const y = new THREE.Vector3(sums[6], sums[11], sums[12]).applyMatrix3(gram);
  const z = new THREE.Vector3(sums[7], sums[13], sums[14]).applyMatrix3(gram);
  const axisU = new THREE.Vector3(x.y, y.y, z.y);
  const axisV = new THREE.Vector3(x.z, y.z, z.z);
  const normal = new THREE.Vector3().crossVectors(axisU, axisV).normalize();
  // This is an analytical sampling surface, not rendered geometry, so it can
  // coincide exactly with the registered display without z-fighting. The
  // paper begins directly on the image and acquires distance only by folding.
  const origin = new THREE.Vector3(x.x, y.x, z.x);
  return { origin, axisU, axisV, normal };
}

function createImagePlaneVisual(
  plane: ImagePlane,
  sourceTexture: THREE.Texture,
  outer: boolean,
): ImagePlaneVisual {
  const p0 = plane.origin.clone();
  const p1 = plane.origin.clone().add(plane.axisU);
  const p2 = p1.clone().add(plane.axisV);
  const p3 = p0.clone().add(plane.axisV);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    ...p0.toArray(), ...p1.toArray(), ...p2.toArray(), ...p3.toArray(),
  ], 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();

  const texture = sourceTexture.clone();
  if (outer) {
    const coverRepeat = 0.9306122449;
    texture.repeat.set(coverRepeat, 1);
    texture.offset.set((1 - coverRepeat) * 0.5, 0);
  }
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.DoubleSide,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = outer ? "OuterCoverImagePlane" : "InnerImagePlane";
  mesh.visible = false;

  const outlineGeometry = new THREE.BufferGeometry().setFromPoints([p0, p1, p2, p3]);
  const outlineMaterial = new THREE.LineBasicMaterial({
    color: outer ? 0x08b98e : 0x5478f2,
    depthTest: false,
    toneMapped: false,
  });
  const outline = new THREE.LineLoop(outlineGeometry, outlineMaterial);
  outline.name = outer ? "OuterCoverImagePlaneOutline" : "InnerImagePlaneOutline";
  outline.renderOrder = 20;
  outline.visible = false;
  return { mesh, outline, texture };
}

export function mountCoordinatedPaperScene(
  stage: HTMLElement,
  innerImageUrl: string,
  outerImageUrl: string,
): CoordinatedPaperScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#ffffff");
  // The GLB already carries Star White polished-metal materials. Metals
  // need an environment to reflect; a white background alone provides none.
  // Screen materials are unlit and do not use this hardware-only lighting.
  const studio = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const studioReflection = pmrem.fromScene(studio, 0.025);
  scene.environment = studioReflection.texture;
  scene.environmentIntensity = 0.85;
  studio.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dfe8, 2.2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(-3, 4, 8);
  scene.add(keyLight);

  const imageWidth = 4.3;
  const imageHeight = imageWidth * 1750 / 2432;
  const displayCrop = new THREE.Vector4(0, 0, 1, 1);
  const imageSize = new THREE.Vector2(imageWidth, imageHeight);
  const darkField = new THREE.Color("#000000");
  const textureLoader = new THREE.TextureLoader();
  const loadScreenTexture = (url: string) => {
    const loaded = textureLoader.load(url, () => render());
    loaded.colorSpace = THREE.SRGBColorSpace;
    loaded.minFilter = THREE.LinearMipmapLinearFilter;
    loaded.generateMipmaps = true;
    loaded.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
    return loaded;
  };
  const innerTexture = loadScreenTexture(innerImageUrl);
  const outerTexture = loadScreenTexture(outerImageUrl);

  const camera = new THREE.OrthographicCamera(-3, 3, 2, -2, 0.1, 100);
  camera.up.set(0, 1, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enabled = false;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.addEventListener("change", () => render());
  let phone: THREE.Group | null = null;
  let phoneHinge: THREE.Bone | null = null;
  let phoneLeaf: THREE.Bone | null = null;
  let hingeRest: THREE.Quaternion | null = null;
  let leafRest: THREE.Quaternion | null = null;
  let sequenceTime = 0;
  let inspectionMode = 0;
  let inspectionTriangles = false;
  let moveView = false;
  let disposed = false;
  const foldAxis = new THREE.Vector3(1, 0, 0);
  const foldQuaternion = new THREE.Quaternion();
  const displayMeshes: THREE.Mesh[] = [];
  let grabPath: Array<{ point: THREE.Vector2; time: number }> | null = null;
  let grabOffset = new THREE.Vector2();
  const hardwareVisibility: Array<{ mesh: THREE.Mesh; visible: boolean }> = [];
  const cameraGlass: Array<{ mesh: THREE.Mesh; material: THREE.Material; visible: boolean }> = [];
  const imagePlaneVisuals: ImagePlaneVisual[] = [];
  const materialStates = new Map<THREE.Material, {
    wireframe?: boolean;
    side: THREE.Side;
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
  }>();
  const cameraDiagnosticMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.0, 0.82, 0.20),
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const inspectionUniform = { value: 0 };
  const hingeAngle = { value: 180 };
  const leftVisible = { value: 0 };
  const outerActive = { value: 1 };
  const leftPaper = { value: 0 };
  const leftAngle = { value: 90 };
  const rightPaper = { value: 0 };
  const blurIntensity = { value: 1.6 };
  const transitionLength = { value: 0.75 };
  const edgeDarkening = { value: 1 };
  const imagePlanes = new Map<boolean, {
    origin: { value: THREE.Vector3 };
    axisU: { value: THREE.Vector3 };
    axisV: { value: THREE.Vector3 };
    normal: { value: THREE.Vector3 };
  }>();

  new GLTFLoader().load(`${import.meta.env.BASE_URL}models/iphone-duo-full-replaced-screen.glb`, (gltf) => {
    if (disposed) return;
    phone = gltf.scene;
    const scale = imageWidth / 0.15856843;
    phone.scale.setScalar(scale);
    phone.position.set(0, -0.05889157 * scale, -0.08);
    phoneHinge = phone.getObjectByName("Bone_Hinge_46") as THREE.Bone | null;
    phoneLeaf = phone.getObjectByName("Bone_01_45") as THREE.Bone | null;
    const phoneAxle = phone.getObjectByName("Axle_9");
    // The exported axle sits about 0.9 mm laterally outside the closed leaf,
    // leaving a white slit between the silver hinge and the black bezel.
    // Move only the rigid axle toward the bezel; the skinned screen, its fold
    // radius, and the registered image planes keep their authored transforms.
    if (phoneAxle) phoneAxle.position.z += 0.0009;

    for (const { node, outer, triangles } of DISPLAY_MESHES) {
      const screen = phone.getObjectByName(node) as THREE.Mesh | null;
      if (!screen || screen.geometry.index?.count !== triangles * 3) {
        throw new Error(`Unexpected display topology for ${node}`);
      }
      const screenTexture = outer ? outerTexture : innerTexture;
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: screenTexture,
        toneMapped: false,
        side: THREE.FrontSide,
      });
      const plane = {
        origin: { value: new THREE.Vector3(0, 0, -0.2) },
        axisU: { value: new THREE.Vector3(imageWidth, 0, 0) },
        axisV: { value: new THREE.Vector3(0, imageHeight, 0) },
        normal: { value: new THREE.Vector3(0, 0, 1) },
      };
      imagePlanes.set(outer, plane);
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uCrop = { value: displayCrop };
        shader.uniforms.uScreenImage = { value: screenTexture };
        shader.uniforms.uImageSize = { value: imageSize };
        shader.uniforms.uDarkField = { value: darkField };
        shader.uniforms.uOuterScreen = { value: outer ? 1 : 0 };
        shader.uniforms.uLeftVisible = leftVisible;
        shader.uniforms.uOuterActive = outerActive;
        shader.uniforms.uLeftPaper = leftPaper;
        shader.uniforms.uLeftAngle = leftAngle;
        shader.uniforms.uRightPaper = rightPaper;
        shader.uniforms.uBlurIntensity = blurIntensity;
        shader.uniforms.uTransitionLength = transitionLength;
        shader.uniforms.uEdgeDarkening = edgeDarkening;
        shader.uniforms.uInspectionMode = inspectionUniform;
        shader.uniforms.uHingeAngle = hingeAngle;
        shader.uniforms.uPlaneOrigin = plane.origin;
        shader.uniforms.uPlaneU = plane.axisU;
        shader.uniforms.uPlaneV = plane.axisV;
        shader.uniforms.uPlaneNormal = plane.normal;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec2 vDisplayUv;\nvarying vec3 vPaperWorld;")
          .replace("#include <uv_vertex>", "#include <uv_vertex>\nvDisplayUv = uv;")
          .replace("#include <project_vertex>",
            "vPaperWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>
            varying vec2 vDisplayUv;
            varying vec3 vPaperWorld;
            uniform sampler2D uScreenImage;
            uniform vec4 uCrop;
            uniform vec2 uImageSize;
            uniform vec3 uDarkField;
            uniform float uOuterScreen;
            uniform float uLeftVisible;
            uniform float uOuterActive;
            uniform float uLeftPaper;
            uniform float uLeftAngle;
            uniform float uRightPaper;
            uniform float uBlurIntensity;
            uniform float uTransitionLength;
            uniform float uEdgeDarkening;
            uniform float uInspectionMode;
            uniform float uHingeAngle;
            uniform vec3 uPlaneOrigin;
            uniform vec3 uPlaneU;
            uniform vec3 uPlaneV;
            uniform vec3 uPlaneNormal;
            float paperHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float paperNoise(vec2 p) {
              vec2 i = floor(p), f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              return mix(mix(paperHash(i), paperHash(i + vec2(1.0, 0.0)), f.x),
                         mix(paperHash(i + vec2(0.0, 1.0)), paperHash(i + 1.0), f.x), f.y);
            }
            vec3 sampleDisplay(vec2 uv, float mipBias) {
              float inside = step(0.0, uv.x) * step(uv.x, 1.0) *
                             step(0.0, uv.y) * step(uv.y, 1.0);
              vec3 pixel = texture2D(uScreenImage,
                mix(uCrop.xy, uCrop.zw, clamp(uv, 0.0, 1.0)), mipBias).rgb;
              return mix(uDarkField, pixel, inside);
            }
            vec3 sampleDisplay(vec2 uv) { return sampleDisplay(uv, 0.0); }
            vec3 sampleDisplaySoft(vec2 uv, float mipBias, float feather) {
              float edgeDistance = min(min(uv.x, 1.0 - uv.x),
                                       min(uv.y, 1.0 - uv.y));
              float coverage = smoothstep(-feather, feather, edgeDistance);
              vec3 pixel = texture2D(uScreenImage,
                mix(uCrop.xy, uCrop.zw, clamp(uv, 0.0, 1.0)), mipBias).rgb;
              return mix(uDarkField, pixel, coverage);
            }
            vec2 imagePlaneUv(vec3 start, vec3 direction) {
              float denominator = dot(direction, uPlaneNormal);
              denominator = abs(denominator) < 0.025 ?
                (denominator < 0.0 ? -0.025 : 0.025) : denominator;
              float distanceAlongRay = dot(uPlaneOrigin - start, uPlaneNormal) / denominator;
              vec3 offset = start + direction * distanceAlongRay - uPlaneOrigin;
              float a = dot(uPlaneU, uPlaneU);
              float b = dot(uPlaneU, uPlaneV);
              float c = dot(uPlaneV, uPlaneV);
              float determinant = max(a * c - b * b, 0.00001);
              float d = dot(offset, uPlaneU);
              float e = dot(offset, uPlaneV);
              return vec2((d * c - e * b) / determinant,
                          (e * a - d * b) / determinant);
            }
            vec3 projectedImage(vec3 start, vec3 direction, float mipBias) {
              vec2 uv = imagePlaneUv(start, direction);
              return sampleDisplay(uv, mipBias);
            }
            vec3 projectedImage(vec3 start, vec3 direction) {
              return projectedImage(start, direction, 0.0);
            }
            // The supplied cover artwork is 1792x2400, while the half-display
            // stencil is approximately 1216x1750. Preserve the full artwork
            // height and crop the surplus width equally on both sides. This
            // keeps circles circular: there is no non-uniform scaling.
            vec2 coverImageUv(vec2 uv) {
              return vec2(0.5 + (uv.x - 0.5) * 0.9306122449, uv.y);
            }`)
          .replace("#include <map_fragment>", `
            vec2 screenUv = vec2(vDisplayUv.x, 1.0 - vDisplayUv.y);
            bool rawMeshMode = uInspectionMode > 8.5 && uInspectionMode < 9.5;
            bool maskDiagnostic = (uInspectionMode > 0.5 && uInspectionMode < 5.5) ||
                                  (uInspectionMode > 6.5 && uInspectionMode < 7.5);
            if (rawMeshMode) {
              diffuseColor.rgb = vec3(0.16, 0.18, 0.22);
            } else if (maskDiagnostic) {
              if (uInspectionMode < 1.5 && (uOuterScreen > 0.5 || screenUv.x >= 0.5)) discard;
              if (uInspectionMode > 1.5 && uInspectionMode < 2.5 &&
                  (uOuterScreen > 0.5 || screenUv.x < 0.5)) discard;
              if (uInspectionMode > 2.5 && uInspectionMode < 3.5 && uOuterScreen < 0.5) discard;
              vec3 isolatedColor = uOuterScreen > 0.5 ? vec3(0.06, 0.56, 0.44) :
                                   screenUv.x < 0.5 ? vec3(0.20, 0.39, 0.94) :
                                                      vec3(0.94, 0.43, 0.20);
              vec3 solidColor = uOuterScreen > 0.5 ? vec3(0.0, 0.82, 0.20) :
                                screenUv.x < 0.5 ? vec3(0.03, 0.22, 1.0) :
                                                   vec3(1.0, 0.23, 0.02);
              diffuseColor.rgb = uInspectionMode > 4.5 ? solidColor : isolatedColor;
            } else {
              // Orthographic projection: every pixel sees the scene along
              // the same ray, irrespective of its position on the display.
              vec3 toEye = normalize(cameraPosition);
              vec3 ray = -toEye;
              float gap = abs(dot(vPaperWorld - uPlaneOrigin, uPlaneNormal));
              // Both wallpapers remain on their stationary registered image
              // planes. The authored display triangles are stencils only:
              // sampling the folding mesh UVs here would make the cover art
              // bend with the hardware instead of revealing the flat plane.
              float planeDenominator = dot(ray, uPlaneNormal);
              planeDenominator = abs(planeDenominator) < 0.025 ?
                (planeDenominator < 0.0 ? -0.025 : 0.025) : planeDenominator;
              float planeDistance = dot(uPlaneOrigin - vPaperWorld, uPlaneNormal) /
                planeDenominator;
              // Contact must retain full image brightness. Fade only after
              // the backing plane lies behind the ray origin, allowing a
              // small tolerance for the registered mesh surface.
              float stencilActive = 1.0 - smoothstep(0.001, 0.025, -planeDistance);
              vec2 fixedUv = imagePlaneUv(vPaperWorld, ray);
              fixedUv = mix(fixedUv, coverImageUv(fixedUv), uOuterScreen);
              vec3 fixedImage = sampleDisplay(fixedUv);
              float coverage = mix(mix(step(0.5, screenUv.x), 1.0, uLeftVisible),
                                   1.0, uOuterScreen);
              // The coordinated transition belongs entirely to the moving
              // half and reaches zero at the shared hinge UV. Scattering rays
              // may still cross the hinge and sample the full wallpaper.
              float transitionWidth = 0.50 * clamp(uTransitionLength, 0.05, 1.0);
              float transitionStart = 0.50 - transitionWidth;
              float transitionMask = 1.0 - smoothstep(transitionStart, 0.50, screenUv.x);
              // Keep the art-directed shade on its established footprint.
              // The user can lengthen the soft paper transition without also
              // moving or widening the darkening profile.
              float darkeningMask = 1.0 - smoothstep(0.25, 0.50, screenUv.x);
              // The inner sheet uses the soft hinge transition. The outer
              // cover is a separate full-screen sheet: as that rigid stencil
              // lifts away from its registered image plane, the entire cover
              // receives the same distance-driven scattering blur.
              float innerPaperAmount = transitionMask * uLeftPaper;
              float coverPaperAmount = uRightPaper;
              float paperAmount = mix(innerPaperAmount, coverPaperAmount, uOuterScreen);
              // The screen mesh is only a stencil. Every visible fragment
              // comes from the stationary registered image plane; never fall
              // back to the screen mesh's UV texture while it is folding.
              vec3 baseColor = mix(uDarkField, fixedImage, coverage);
              if (paperAmount > 0.001 &&
                  (uInspectionMode < 0.5 || uInspectionMode > 7.5)) {
                vec3 normal = normalize(cross(dFdx(vPaperWorld), dFdy(vPaperWorld)));
                float grazing = 1.0 - abs(dot(normal, toEye));
                vec3 axisGuide = abs(dot(ray, uPlaneNormal)) > 0.9 ?
                  vec3(0.0, 1.0, 0.0) : uPlaneNormal;
                vec3 axisX = normalize(cross(axisGuide, ray));
                vec3 axisY = cross(ray, axisX);
                float scatter = 0.55 * (0.10 + 0.16 * grazing) * uBlurIntensity;
                vec3 sharp = fixedImage;
                float revealWeight = 1.0 - smoothstep(82.0, 90.0, uLeftAngle);
                // The backing image is coincident with the registered screen
                // pose. Only the fold itself creates paper-to-image distance;
                // do not inject an artificial recessed backdrop.
                float effectiveGap = gap;
                vec3 scatterOrigin = vPaperWorld;
                float footprint = effectiveGap * scatter /
                  max(abs(dot(ray, uPlaneNormal)), 0.025) * 405.0 / uImageSize.x;
                float blurBlend = smoothstep(0.4, 1.4, footprint);
                vec3 under = sharp;
                if (blurBlend > 0.001) {
                  vec3 blurred = vec3(0.0);
                  float planeFacing = sign(dot(ray, uPlaneNormal));
                  float sampleWidth = effectiveGap * scatter * 2432.0 / uImageSize.x /
                    max(abs(dot(ray, uPlaneNormal)), 0.1) / sqrt(96.0);
                  float mipBias = max(0.0, log2(max(1.0, sampleWidth * 0.8)));
                  float edgeFeather = max(1.5 / 2432.0,
                                          1.5 * sampleWidth / 2432.0);
                  // A stable low-discrepancy disc avoids per-pixel Monte Carlo
                  // speckle; mip filtering integrates between sparse rays.
                  // Every ray contributes the same energy. Rays missing the
                  // finite image plane resolve to the dark field instead of
                  // brightening the remaining valid samples through
                  // renormalization.
                  for (int i = 0; i < 96; i++) {
                    float index = float(i) + 0.5;
                    float radius = sqrt(index / 96.0);
                    float azimuth = index * 2.3999632;
                    vec2 disc = radius * vec2(cos(azimuth), sin(azimuth));
                    vec3 direction = ray + scatter * (axisX * disc.x + axisY * disc.y);
                    vec3 rayColor = uDarkField;
                    if (stencilActive > 0.001 &&
                        planeFacing * dot(direction, uPlaneNormal) > 0.025) {
                      vec2 projectedHit = imagePlaneUv(scatterOrigin, direction);
                      // Blur rays use the same fixed-plane coordinate space as
                      // the sharp sample. The cover crop is applied only after
                      // projection, never via the folding screen's UVs.
                      vec2 hitUv = mix(projectedHit,
                                       coverImageUv(projectedHit), uOuterScreen);
                      rayColor = sampleDisplaySoft(hitUv, mipBias, edgeFeather);
                    }
                    blurred += rayColor;
                  }
                  under = mix(sharp, blurred / 96.0, blurBlend);
                }
                // The behind-plane fallback belongs to the paper effect,
                // not the underlying image. Blending it through paperAmount
                // makes it vanish smoothly at the hinge instead of leaving
                // a signed-distance stripe across the clear stationary half.
                under = mix(uDarkField, under, stencilActive);
                float fiber = paperNoise(screenUv * vec2(90.0, 72.0)) - 0.5;
                float leafGrazing = 1.0 - abs(cos(radians(uLeftAngle)));
                float smoothGrazing = max(grazing,
                  (1.0 - uOuterScreen) * leafGrazing * revealWeight * transitionMask);
                float opticalDepth = pow(1.0 / max(1.0 - smoothGrazing, 0.17), 1.45);
                // Transmission loss is an artistic approximation confined to
                // the lifting interior sheet. The cover scatters without
                // acquiring this additional tint; contact stays unattenuated.
                float distanceLoss = exp(-0.35 * gap);
                float transmission = pow(clamp(0.89 + fiber * 0.008, 0.0, 0.97), opticalDepth)
                  * distanceLoss;
                vec3 dimFill = vec3(0.035, 0.041, 0.047) + fiber * 0.005;
                float interiorAttenuation = (1.0 - uOuterScreen) *
                  smoothstep(0.0, 0.025, gap);
                vec3 paperColor = mix(under, mix(dimFill, under, transmission),
                  interiorAttenuation);
                // Separate art-directed edge falloff visible in the reference:
                // strongest along the free edge, gentle at top/bottom, and
                // absent by the hinge. This is independent of the ray spread.
                float freeEdge = 1.0 - smoothstep(0.0, 0.24, screenUv.x);
                float horizontalEdges = 1.0 - smoothstep(0.0, 0.15,
                  min(screenUv.y, 1.0 - screenUv.y));
                float edgeShade = uEdgeDarkening *
                  min(0.60, 0.43 * freeEdge + 0.12 * horizontalEdges);
                edgeShade = min(edgeShade, 0.95);
                baseColor = mix(baseColor, paperColor, paperAmount);
                float edgeEnabled = (uInspectionMode < 0.5 || uInspectionMode > 9.5) ? 1.0 : 0.0;
                float darkeningAmount = edgeEnabled *
                  (1.0 - uOuterScreen) * uLeftPaper * darkeningMask;
                // Subtract only the darkened paper contribution. At the
                // default profile this is algebraically identical to shading
                // paperColor before the mix, while remaining independent of
                // the adjustable smoothing length.
                baseColor = max(vec3(0.0), baseColor -
                  paperColor * edgeShade * darkeningAmount);
              }
              // Select the receiving display by pose, not playback direction
              // or pause state. The same hinge pose must render identically
              // whether reached by playback, forward scrub or reverse scrub.
              vec2 regularUv = mix(screenUv, coverImageUv(screenUv), uOuterScreen);
              // Model angle is 0 fully open, 180 fully closed.
              float innerStencil = 1.0 - smoothstep(88.0, 90.0, uHingeAngle);
              float coverStencil = smoothstep(90.0, 92.0, uHingeAngle);
              float stencilScreen = mix(innerStencil, coverStencil, uOuterScreen);
              diffuseColor.rgb = mix(sampleDisplay(regularUv), baseColor, stencilScreen);
            }
            diffuseColor.a = opacity;
          `);
      };
      material.customProgramCacheKey = () => `exact-display-${outer ? "outer" : "inner"}`;
      screen.material = material;
      displayMeshes.push(screen);
    }

    phone.traverse((object) => {
      if (object instanceof THREE.Mesh && !displayMeshes.includes(object)) {
        hardwareVisibility.push({ mesh: object, visible: object.visible });
        if (["Object_76", "Object_78", "Object_80", "Object_82"].includes(object.name)) {
          cameraGlass.push({ mesh: object, material: object.material as THREE.Material, visible: object.visible });
        }
      }
    });
    phone.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const wireframeMaterial = material as THREE.Material & { wireframe?: boolean };
        materialStates.set(material, {
          wireframe: wireframeMaterial.wireframe,
          side: material.side,
          transparent: material.transparent,
          opacity: material.opacity,
          depthWrite: material.depthWrite,
        });
      }
    });
    hingeRest = phoneHinge?.quaternion.clone() ?? null;
    leafRest = phoneLeaf?.quaternion.clone() ?? null;
    const initialTime = sequenceTime;
    for (const [outer, referenceTime] of [[true, 0], [false, SEQUENCE_DURATION]] as const) {
      setTime(referenceTime);
      phone.updateMatrixWorld(true);
      phone.traverse((object) => {
        if (object instanceof THREE.SkinnedMesh) object.skeleton.update();
      });
      const screen = displayMeshes.find((mesh) => mesh.name === (outer ? "Object_72" : "Object_106"));
      if (!screen) throw new Error(`Missing ${outer ? "cover" : "inner"} display`);
      const fitted = fitImagePlane(screen);
      const uniforms = imagePlanes.get(outer);
      if (!uniforms) throw new Error("Missing image-plane uniforms");
      uniforms.origin.value.copy(fitted.origin);
      uniforms.axisU.value.copy(fitted.axisU);
      uniforms.axisV.value.copy(fitted.axisV);
      uniforms.normal.value.copy(fitted.normal);
      const visual = createImagePlaneVisual(
        fitted,
        outer ? outerTexture : innerTexture,
        outer,
      );
      imagePlaneVisuals.push(visual);
      scene.add(visual.mesh, visual.outline);
    }
    scene.add(phone);
    setTime(initialTime);
    render();
  });

  function render() {
    if (!disposed) renderer.render(scene, camera);
  }

  function resetCamera() {
    camera.position.set(0, 0, 10);
    camera.zoom = 1;
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    camera.updateProjectionMatrix();
  }

  function resize() {
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    const aspect = width / height;
    const viewHeight = Math.max(imageHeight * 1.3, imageWidth * 1.22 / aspect);
    camera.left = -viewHeight * aspect / 2;
    camera.right = viewHeight * aspect / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    if (!moveView) resetCamera();
    renderer.setSize(width, height, false);
    setTime(sequenceTime);
  }

  function setTime(seconds: number) {
    sequenceTime = seconds;
    const state = stateAtTime(seconds);
    const phoneAngle = 90 + state.leftAngle - state.rightAngle;
    hingeAngle.value = phoneAngle;
    foldQuaternion.setFromAxisAngle(foldAxis, THREE.MathUtils.degToRad(phoneAngle) / 2);
    if (phoneHinge && hingeRest) phoneHinge.quaternion.copy(hingeRest).multiply(foldQuaternion);
    if (phoneLeaf && leafRest) phoneLeaf.quaternion.copy(leafRest).multiply(foldQuaternion);
    leftVisible.value = state.leftAngle < 89.5 ? 1 : 0;
    outerActive.value = 1 - smoothstep(0, 8, state.rightAngle);
    leftPaper.value = state.leftPaper;
    leftAngle.value = state.leftAngle;
    rightPaper.value = state.rightPaper;
    render();
    return state;
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  function refreshPickingBounds() {
    if (!phone) return;
    phone.updateMatrixWorld(true);
    phone.traverse(object => {
      if (object instanceof THREE.SkinnedMesh) object.skeleton.update();
    });
    // Three.js caches these bounds; bone motion does not invalidate them.
    // Refresh on pointer-down so the opened leaf remains raycastable without
    // recomputing every hardware mesh's bounds on every animation frame.
    phone.traverse(object => {
      if (object instanceof THREE.SkinnedMesh) {
        object.computeBoundingSphere();
        if (object.boundingBox !== null) object.computeBoundingBox();
      }
    });
  }

  return {
    setTime,
    hitsPhoneSilhouette(clientX, clientY) {
      if (!phone) return false;
      refreshPickingBounds();
      const bounds = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(
        (clientX - bounds.left) / bounds.width * 2 - 1,
        1 - (clientY - bounds.top) / bounds.height * 2,
      ), camera);
      // Test the visible hardware as well as displays. Failure to grab the
      // anchored screen or a bezel must never fall through into camera orbit.
      return ray.intersectObject(phone, true).some(hit => {
        let object: THREE.Object3D | null = hit.object;
        while (object) {
          if (!object.visible) return false;
          object = object.parent;
        }
        return true;
      });
    },
    beginGrab(clientX, clientY) {
      if (!phone) return false;
      refreshPickingBounds();
      const bounds = renderer.domElement.getBoundingClientRect();
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(
        (clientX - bounds.left) / bounds.width * 2 - 1,
        -(clientY - bounds.top) / bounds.height * 2 + 1,
      ), camera);
      const hit = raycaster.intersectObjects(displayMeshes, false).find(hit => hit.object.visible);
      if (!hit?.face) return false;
      const mesh = hit.object as THREE.Mesh;
      const { a, b, c } = hit.face;
      const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
      mesh.getVertexPosition(a, va); mesh.getVertexPosition(b, vb); mesh.getVertexPosition(c, vc);
      const weights = new THREE.Vector3();
      new THREE.Triangle(va, vb, vc).getBarycoord(mesh.worldToLocal(hit.point.clone()), weights);
      const projectedGrab = () => {
        mesh.getVertexPosition(a, va); mesh.getVertexPosition(b, vb); mesh.getVertexPosition(c, vc);
        const point = va.clone().multiplyScalar(weights.x).addScaledVector(vb, weights.y).addScaledVector(vc, weights.z);
        mesh.localToWorld(point).project(camera);
        return new THREE.Vector2(bounds.left + (point.x + 1) * bounds.width / 2,
          bounds.top + (1 - point.y) * bounds.height / 2);
      };
      const initialPoint = projectedGrab();
      const pose = (angle: number) => {
        foldQuaternion.setFromAxisAngle(foldAxis, THREE.MathUtils.degToRad(angle) / 2);
        if (phoneHinge && hingeRest) phoneHinge.quaternion.copy(hingeRest).multiply(foldQuaternion);
        if (phoneLeaf && leafRest) phoneLeaf.quaternion.copy(leafRest).multiply(foldQuaternion);
        phone!.updateMatrixWorld(true);
        phone!.traverse(object => { if (object instanceof THREE.SkinnedMesh) object.skeleton.update(); });
      };
      const timeForAngle = (angle: number) => {
        let low = 0, high = SEQUENCE_DURATION;
        for (let i = 0; i < 24; i++) {
          const mid = (low + high) / 2, state = stateAtTime(mid);
          if (90 + state.leftAngle - state.rightAngle > angle) low = mid;
          else high = mid;
        }
        return (low + high) / 2;
      };
      const path: Array<{ point: THREE.Vector2; time: number }> = [];
      // Follow this exact barycentric mesh point through the authored hinge
      // rig. Projection makes the grab work from orbit views as well as front.
      for (let angle = 180; angle >= 0; angle--) {
        pose(angle);
        path.push({ point: projectedGrab(), time: timeForAngle(angle) });
      }
      const current = stateAtTime(sequenceTime);
      pose(90 + current.leftAngle - current.rightAngle);
      // A point on the anchored panel has no useful hinge trajectory.
      if (Math.max(...path.map(sample => sample.point.distanceTo(initialPoint))) < 8) return false;
      grabOffset.set(clientX - initialPoint.x, clientY - initialPoint.y);
      grabPath = path;
      controls.enabled = false;
      return true;
    },
    moveGrab(clientX, clientY) {
      if (!grabPath) return null;
      const pointer = new THREE.Vector2(clientX, clientY).sub(grabOffset);
      let best = Infinity, result = sequenceTime;
      for (let i = 0; i < grabPath.length - 1; i++) {
        const a = grabPath[i], b = grabPath[i + 1];
        const segment = b.point.clone().sub(a.point);
        const alpha = THREE.MathUtils.clamp(pointer.clone().sub(a.point).dot(segment) / Math.max(segment.lengthSq(), 1e-8), 0, 1);
        const time = THREE.MathUtils.lerp(a.time, b.time, alpha);
        const distance = a.point.clone().addScaledVector(segment, alpha).distanceToSquared(pointer);
        // Break near-identical projected solutions by continuity, not by
        // snapping to an unrelated branch of the hinge arc.
        const score = distance + Math.pow(time - sequenceTime, 2) * 0.01;
        if (score < best) { best = score; result = time; }
      }
      return result;
    },
    endGrab() { grabPath = null; controls.enabled = moveView; },
    setOrbitEnabled(enabled) {
      controls.enabled = enabled && moveView;
    },
    setBlurIntensity(intensity) {
      blurIntensity.value = THREE.MathUtils.clamp(intensity, 0, 10);
      render();
    },
    setTransitionLength(length) {
      transitionLength.value = THREE.MathUtils.clamp(length, 0.05, 1);
      render();
    },
    setEdgeDarkening(intensity) {
      edgeDarkening.value = THREE.MathUtils.clamp(intensity, 0, 4.5);
      render();
    },
    setMoveView(enabled) {
      moveView = enabled;
      controls.enabled = enabled;
      if (!enabled) resetCamera();
      render();
    },
    resetView() {
      resetCamera();
      render();
    },
    inspectSurface(surface, triangles) {
      inspectionMode = {
        "edge-darkening": 0,
        "inner-left": 1,
        "inner-right": 2,
        "outer-cover": 3,
        "screen-triangles": 4,
        "solid-mask": 5,
        background: 6,
        "mask-composite": 7,
        "matte-paper": 8,
        "raw-mesh": 9,
        "plane-outlines": 10,
      }[surface];
      inspectionTriangles = triangles;
      inspectionUniform.value = inspectionMode;
      const rawMeshMode = inspectionMode === 9;
      const screenTriangleMode = inspectionMode === 4;
      const backgroundMode = inspectionMode === 6;
      const compositeMode = inspectionMode === 7;

      for (const [material, state] of materialStates) {
        const wireframeMaterial = material as THREE.Material & { wireframe?: boolean };
        if (state.wireframe !== undefined) wireframeMaterial.wireframe = state.wireframe;
        material.side = state.side;
        material.transparent = state.transparent;
        material.opacity = state.opacity;
        material.depthWrite = state.depthWrite;
        material.needsUpdate = true;
      }
      if (rawMeshMode) {
        for (const material of materialStates.keys()) {
          const wireframeMaterial = material as THREE.Material & { wireframe?: boolean };
          if (wireframeMaterial.wireframe !== undefined) wireframeMaterial.wireframe = true;
          material.side = THREE.DoubleSide;
          material.needsUpdate = true;
        }
      }

      const hardwareMode = [0, 5, 8, 9, 10].includes(inspectionMode);
      for (const { mesh, visible } of hardwareVisibility) {
        mesh.visible = hardwareMode && visible;
      }
      // The GLB really does cut the outer screen mesh around its camera;
      // separate nearly transparent camera-glass meshes fill that aperture.
      // Color their union green in the screen diagnostics only.
      for (const { mesh, material, visible } of cameraGlass) {
        const coverDiagnostic = inspectionMode === 3 || inspectionMode === 4 ||
          inspectionMode === 5 || compositeMode;
        cameraDiagnosticMaterial.transparent = compositeMode;
        cameraDiagnosticMaterial.opacity = compositeMode ? 0.58 : 1;
        cameraDiagnosticMaterial.depthWrite = !compositeMode;
        cameraDiagnosticMaterial.needsUpdate = true;
        mesh.material = coverDiagnostic ? cameraDiagnosticMaterial : material;
        mesh.visible = coverDiagnostic || (hardwareMode && visible);
      }
      for (const mesh of displayMeshes) {
        const material = mesh.material as THREE.MeshBasicMaterial;
        mesh.visible = !backgroundMode;
        material.wireframe = rawMeshMode || screenTriangleMode ||
          (inspectionMode > 0 && inspectionMode < 4 && inspectionTriangles);
        material.side = inspectionMode > 0 && inspectionMode < 8 ?
          THREE.DoubleSide : THREE.FrontSide;
        material.transparent = compositeMode;
        material.opacity = compositeMode ? 0.58 : 1;
        material.depthWrite = !compositeMode;
        material.needsUpdate = true;
      }
      for (const visual of imagePlaneVisuals) {
        visual.mesh.visible = backgroundMode || compositeMode;
        visual.outline.visible = inspectionMode === 10;
      }
      render();
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      for (const { mesh, material } of cameraGlass) mesh.material = material;
      for (const visual of imagePlaneVisuals) {
        scene.remove(visual.mesh, visual.outline);
        visual.mesh.geometry.dispose();
        (visual.mesh.material as THREE.Material).dispose();
        visual.outline.geometry.dispose();
        (visual.outline.material as THREE.Material).dispose();
        visual.texture.dispose();
      }
      const geometries = new Set<THREE.BufferGeometry>();
      if (phone) {
        phone.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            geometries.add(object.geometry);
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material.dispose());
          }
        });
        scene.remove(phone);
      }
      geometries.forEach((geometry) => geometry.dispose());
      cameraDiagnosticMaterial.dispose();
      innerTexture.dispose();
      outerTexture.dispose();
      studioReflection.dispose();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
