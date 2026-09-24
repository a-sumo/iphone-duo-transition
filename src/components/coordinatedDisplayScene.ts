import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import BezierEasing from "bezier-easing";

export const SEQUENCE_DURATION = 3.683;

// ── Fold-open curve ──────────────────────────────────────────────────────────
// One monotonic ease over the WHOLE fold (180° folded → 0° flat). Edit these
// four cubic-bézier control points to reshape how the phone opens — paste them
// straight from a visual editor:
//   • Chrome DevTools: click the easing swatch beside any CSS transition
//   • https://cubic-bezier.com  — drag the two handles, copy the four numbers
// Because it's a single curve (not two chained smoothsteps), there's no dwell
// and no stop at 90°: the phone opens in one continuous motion.
export const FOLD_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1];
const openEasing = BezierEasing(...FOLD_EASE);

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
  ready: Promise<void>;
  measureDetailEnergy: () => number;
  setTime: (seconds: number) => SequenceState;
  beginGrab: (clientX: number, clientY: number) => boolean;
  hitsPhoneSilhouette: (clientX: number, clientY: number) => boolean;
  moveGrab: (clientX: number, clientY: number) => number | null;
  endGrab: () => void;
  /** Show or hide the flowing dot hint on the moving screen. */
  setDragHint: (active: boolean) => void;
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

export function stateAtTime(seconds: number): SequenceState {
  const progress = clamp01(seconds / SEQUENCE_DURATION);
  // Eased "openness": 0 = folded (phoneAngle 180°), 1 = flat (phoneAngle 0°).
  const open = openEasing(progress);
  // Keep the right-then-left reveal choreography: the right leaf reads as
  // opening across the first half of the fold, the left leaf across the second.
  // Their combination is exactly phoneAngle = 180·(1 − open), so the physical
  // hinge follows the single eased curve with no hold at 90°.
  const rightAngle = 90 * clamp01(open * 2);
  const leftAngle = 90 * (1 - clamp01(open * 2 - 1));
  // The paper effect must never let go before rest: fading it over the last
  // 8° left a sharp, visibly stenciled image just short of open/closed.
  const paperVisibility = (angle: number) => smoothstep(0, 1.5, angle);
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
const BLUR_FLOOR = 0.25;

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
  // UV winding is not a reliable front/back convention. Orient each reference
  // plane using its own registered display's largest triangle.
  const indices = screen.geometry.index;
  if (indices) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const faceNormal = new THREE.Vector3();
    let largest = 0;
    for (let i = 0; i < indices.count; i += 3) {
      screen.localToWorld(screen.getVertexPosition(indices.getX(i), a));
      screen.localToWorld(screen.getVertexPosition(indices.getX(i + 1), b));
      screen.localToWorld(screen.getVertexPosition(indices.getX(i + 2), c));
      const triangle = new THREE.Triangle(a, b, c);
      if (triangle.getArea() > largest) {
        largest = triangle.getArea();
        triangle.getNormal(faceNormal);
      }
    }
    if (normal.dot(faceNormal) < 0) normal.negate();
  }
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
  comparison: { stencil?: boolean; shading?: boolean; view?: [number, number, number] } = {},
): CoordinatedPaperScene {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The normal interactive callers need not await readiness.
  void ready.catch(() => {});
  const loading = new THREE.LoadingManager(() => resolveReady());
  loading.onError = url => rejectReady(new Error(`Unable to load ${url}`));
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#ececee");
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
  const captureMask = { value: false };
  let captureTarget: THREE.WebGLRenderTarget | null = null;
  const textureLoader = new THREE.TextureLoader(loading);
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
  // Horizontal centring of the fold. As the phone opens its visual centre drifts
  // (the GLB pivot is off to one side and the unfolding leaf grows the body one
  // way), so we slide the *view* to follow it — like the Apple newsroom clip
  // where the phone eases sideways as it opens. This offsets the orthographic
  // frustum only; geometry never moves, so the stencil / image-plane
  // registration stays valid. Measured once per pose at load, lerped by fold.
  let frustumHalfWidth = 3;
  let frustumHalfHeight = 2;
  let panX = 0;
  let centreFolded = 0;
  let centreOpen = 0;
  let foldAngleClosed = 180;
  let foldAngleOpen = 0;
  let foldCentringReady = false;
  const foldAxis = new THREE.Vector3(1, 0, 0);
  const foldQuaternion = new THREE.Quaternion();
  const displayMeshes: THREE.Mesh[] = [];
  let grabPath: Array<{ point: THREE.Vector2; time: number }> | null = null;
  const grabPointer = new THREE.Vector2();
  let grabIndex = 0;
  const viewToEye = { value: new THREE.Vector3(0, 0, 1) };
  const leafFacing = { value: 1 };
  let leafFace: { mesh: THREE.Mesh; a: number; b: number; c: number } | null = null;
  // The cover's image plane keeps its registered orientation, but its hinge-side
  // border rides with the display's hinge-side edge. The hinge axis sits off the
  // glass, so a fully stationary plane would slide away from that edge and
  // expose the dark field between bezel and artwork while the cover swings.
  let coverAnchor: {
    mesh: THREE.Mesh;
    index: number;
    rest: THREE.Vector3;
    origin: THREE.Vector3;
    visual: ImagePlaneVisual;
  } | null = null;
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
  // Drag hint: a dot texture on the moving screen, lit by bands that flow
  // from its free edge toward the hinge (the direction a drag folds it).
  const dragHint = { value: 0 };
  const dragHintTime = { value: 0 };
  const dragHintCover = { value: 1 };
  const dragHintStatic = { value: 0 };
  const hingeAngle = { value: 180 };
  const outerActive = { value: 1 };
  const leftPaper = { value: 0 };
  const leftBlurFloor = { value: 0 };
  const rightBlurFloor = { value: 0 };
  const leftAngle = { value: 90 };
  const rightPaper = { value: 0 };
  const blurIntensity = { value: 2.6 };
  const transitionLength = { value: 0.75 };
  const edgeDarkening = { value: 1.4 };
  const imagePlanes = new Map<boolean, {
    origin: { value: THREE.Vector3 };
    axisU: { value: THREE.Vector3 };
    axisV: { value: THREE.Vector3 };
    normal: { value: THREE.Vector3 };
  }>();

  new GLTFLoader(loading).load(`${import.meta.env.BASE_URL}models/iphone-duo-full-replaced-screen.glb`, (gltf) => {
    if (disposed) return;
    phone = gltf.scene;
    const scale = imageWidth / 0.15856843;
    phone.scale.setScalar(scale);
    phone.position.set(0, -0.05889157 * scale, -0.08);
    phoneHinge = phone.getObjectByName("Bone_Hinge_46") as THREE.Bone | null;
    phoneLeaf = phone.getObjectByName("Bone_01_45") as THREE.Bone | null;
    // The black border around the displays reads as matte on the real
    // device. The exported semi-gloss finish reflected the studio as a grey
    // sheen with a highlight along the top edge.
    phone.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        // BASE_Black_Plastic is the thin glossy ring right around each display;
        // at a slight angle it mirrored the studio as a bright edge.
        if (material.name !== "BASE_Black_Front_Border" && material.name !== "BASE_Black_Plastic") continue;
        const border = material as THREE.MeshStandardMaterial;
        border.color.setRGB(0, 0, 0);
        border.roughness = 1;
        border.metalness = 0;
        border.envMapIntensity = 0.12;
      }
    });
    // The Star White frame is one metal mesh per half, but on the device only
    // its sides are polished metal: the lip facing the user around a display
    // is black. Blend faces aligned with a display's normal (+Z for the inner
    // screen on both halves, -Z for the cover on the left half) to matte black.
    for (const [name, bothFaces] of [["Object_10", false], ["Object_66", true]] as const) {
      const frame = phone.getObjectByName(name) as THREE.Mesh | null;
      if (!frame || Array.isArray(frame.material)) continue;
      const material = (frame.material as THREE.MeshStandardMaterial).clone();
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying float vFrameFacing;")
          .replace("#include <begin_vertex>", `#include <begin_vertex>
            vFrameFacing = ${bothFaces ? "abs(normal.z)" : "normal.z"};`);
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vFrameFacing;")
          .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
            float frameLip = smoothstep(0.55, 0.8, vFrameFacing);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0), frameLip);
            metalnessFactor = mix(metalnessFactor, 0.0, frameLip);
            roughnessFactor = mix(roughnessFactor, 1.0, frameLip);`)
          .replace("#include <opaque_fragment>", `outgoingLight *= 1.0 - 0.85 * frameLip;
            #include <opaque_fragment>`);
      };
      material.customProgramCacheKey = () => `frame-lip-${bothFaces ? "both" : "front"}`;
      frame.material = material;
    }
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
      if (!outer) {
        const uv = screen.geometry.getAttribute("uv");
        const index = screen.geometry.index!;
        let largest = 0;
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        for (let i = 0; i < index.count; i += 3) {
          const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2);
          if ((uv.getX(ia) + uv.getX(ib) + uv.getX(ic)) / 3 >= 0.4) continue;
          screen.getVertexPosition(ia, a); screen.getVertexPosition(ib, b); screen.getVertexPosition(ic, c);
          const area = new THREE.Triangle(a, b, c).getArea();
          if (area > largest) { largest = area; leafFace = { mesh: screen, a: ia, b: ib, c: ic }; }
        }
      }
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
        shader.uniforms.uCaptureMask = captureMask;
        shader.uniforms.uUseStencil = { value: comparison.stencil !== false };
        shader.uniforms.uUseShading = { value: comparison.shading !== false ? 1 : 0 };
        shader.uniforms.uCrop = { value: displayCrop };
        shader.uniforms.uScreenImage = { value: screenTexture };
        shader.uniforms.uImageSize = { value: imageSize };
        shader.uniforms.uDarkField = { value: darkField };
        shader.uniforms.uOuterScreen = { value: outer ? 1 : 0 };
        shader.uniforms.uOuterActive = outerActive;
        shader.uniforms.uLeftPaper = leftPaper;
        shader.uniforms.uLeftBlurFloor = leftBlurFloor;
        shader.uniforms.uRightBlurFloor = rightBlurFloor;
        shader.uniforms.uLeftAngle = leftAngle;
        shader.uniforms.uRightPaper = rightPaper;
        shader.uniforms.uBlurIntensity = blurIntensity;
        shader.uniforms.uTransitionLength = transitionLength;
        shader.uniforms.uEdgeDarkening = edgeDarkening;
        shader.uniforms.uInspectionMode = inspectionUniform;
        shader.uniforms.uDragHint = dragHint;
        shader.uniforms.uDragHintTime = dragHintTime;
        shader.uniforms.uDragHintCover = dragHintCover;
        shader.uniforms.uDragHintStatic = dragHintStatic;
        shader.uniforms.uHingeAngle = hingeAngle;
        shader.uniforms.uViewToEye = viewToEye;
        shader.uniforms.uLeafFacing = leafFacing;
        shader.uniforms.uPlaneOrigin = plane.origin;
        shader.uniforms.uPlaneU = plane.axisU;
        shader.uniforms.uPlaneV = plane.axisV;
        shader.uniforms.uPlaneNormal = plane.normal;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec2 vDisplayUv;\nvarying vec3 vPaperWorld;\nvarying vec3 vPaperNormal;")
          .replace("#include <uv_vertex>", "#include <uv_vertex>\nvDisplayUv = uv;")
          .replace("#include <project_vertex>", `vPaperWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
            // Smooth, skinned vertex normals. Screen-space derivatives give one
            // normal per triangle, which steps the blur along the fold crease.
            #if defined( USE_ENVMAP ) || defined( USE_SKINNING )
              vPaperNormal = normalize(inverseTransformDirection(transformedNormal, viewMatrix));
            #else
              vPaperNormal = normalize(mat3(modelMatrix) * normal);
            #endif
            #include <project_vertex>`);
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", `#include <common>
            varying vec2 vDisplayUv;
            varying vec3 vPaperWorld;
            varying vec3 vPaperNormal;
            uniform sampler2D uScreenImage;
            uniform vec4 uCrop;
            uniform vec2 uImageSize;
            uniform vec3 uDarkField;
            uniform float uOuterScreen;
            uniform float uOuterActive;
            uniform float uLeftPaper;
            uniform float uLeftBlurFloor;
            uniform float uRightBlurFloor;
            uniform float uLeftAngle;
            uniform float uRightPaper;
            uniform float uBlurIntensity;
            uniform float uTransitionLength;
            uniform float uEdgeDarkening;
            uniform float uDragHint;
            uniform float uDragHintTime;
            uniform float uDragHintCover;
            uniform float uDragHintStatic;
            uniform bool uUseStencil;
            uniform bool uCaptureMask;
            uniform float uUseShading;
            uniform float uInspectionMode;
            uniform float uHingeAngle;
            uniform vec3 uViewToEye;
            uniform float uLeafFacing;
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
            if (uCaptureMask) {
              diffuseColor.rgb = vec3(uOuterScreen > 0.5 || screenUv.x < 0.5 ? 1.0 : 0.0);
            } else if (rawMeshMode) {
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
              vec3 toEye = uViewToEye;
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
              float stencilActive = 1.0 - smoothstep(0.001, 0.025, -planeDistance);
              vec2 fixedUv = imagePlaneUv(vPaperWorld, ray);
              fixedUv = mix(fixedUv, coverImageUv(fixedUv), uOuterScreen);
              vec3 fixedImage = sampleDisplay(fixedUv);
              // Rasterization already determines which screen faces are visible.
              // A fold-angle cutoff incorrectly blanks the inner leaf in orbit
              // views where it is visible before the front-view reveal point.
              float coverage = 1.0;
              // The coordinated transition belongs entirely to the moving
              // half and reaches zero at the shared hinge UV. Scattering rays
              // may still cross the hinge and sample the full wallpaper.
              float transitionWidth = 0.50 * clamp(uTransitionLength, 0.05, 1.0);
              float transitionStart = 0.50 - transitionWidth;
              float transitionMask = 1.0 - smoothstep(transitionStart, 0.50, screenUv.x);
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
                vec3 normal = normalize(vPaperNormal);
                float grazing = 1.0 - abs(dot(normal, toEye));
                vec3 axisGuide = abs(dot(ray, uPlaneNormal)) > 0.9 ?
                  vec3(0.0, 1.0, 0.0) : uPlaneNormal;
                vec3 axisX = normalize(cross(axisGuide, ray));
                vec3 axisY = cross(ray, axisX);
                // Taper the scattering radius, not the opacity of a blurred
                // overlay: mixing sharp artwork back in leaves its finite
                // projected boundary visible through the blur off-axis.
                float scatter = 0.55 * (0.10 + 0.16 * grazing) * uBlurIntensity * paperAmount;
                vec3 sharp = fixedImage;
                float revealWeight = 1.0 - smoothstep(82.0, 90.0, uLeftAngle);
                // The backing image is coincident with the registered screen
                // pose. Only the fold itself creates paper-to-image distance;
                // do not inject an artificial recessed backdrop.
                // Near rest the sheet-to-image gap shrinks toward zero, which
                // would sharpen the offset content before the fold completes.
                // Hold a minimum scattering distance until the last degrees.
                float effectiveGap = max(gap, mix(uLeftBlurFloor, uRightBlurFloor, uOuterScreen));
                vec3 scatterOrigin = vPaperWorld;
                // Fade the blur in by its footprint on the image, in texels.
                // A near-zero distance cutoff switched it on abruptly and drew
                // a visible line along the fold edge.
                float radiusTexels = effectiveGap * scatter * 2432.0 / uImageSize.x /
                  max(abs(dot(ray, uPlaneNormal)), 0.1);
                float blurBlend = smoothstep(0.5, 3.0, radiusTexels);
                vec3 under = sharp;
                if (blurBlend > 0.001) {
                  vec3 blurred = vec3(0.0);
                  float planeFacing = sign(dot(ray, uPlaneNormal));
                  float sampleWidth = effectiveGap * scatter * 2432.0 / uImageSize.x /
                    max(abs(dot(ray, uPlaneNormal)), 0.1) / sqrt(96.0);
                  float mipBias = max(0.0, log2(max(1.0, sampleWidth * 0.8)));
                  float edgeFeather = max(max(fwidth(fixedUv.x), fwidth(fixedUv.y)),
                    max(1.5 / 2432.0, 1.5 * sampleWidth / 2432.0));
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
                // Transmission loss is an artistic approximation applied to
                // whichever sheet is lifting; contact stays unattenuated.
                float distanceLoss = exp(-0.35 * gap);
                float transmission = pow(clamp(0.89 + fiber * 0.008, 0.0, 0.97), opticalDepth)
                  * distanceLoss;
                vec3 dimFill = vec3(0.035, 0.041, 0.047) + fiber * 0.005;
                // Both sheets lose light as they lift away, the cover included:
                // Apple's cover dims as it swings open rather than washing out.
                float interiorAttenuation = paperAmount *
                  smoothstep(0.0, 0.025, gap);
                vec3 paperColor = mix(under, mix(dimFill, under, transmission),
                  interiorAttenuation * uUseShading);
                // The convolution already approaches sharp at zero radius.
                // Do not reintroduce an unfiltered image boundary here.
                baseColor = mix(baseColor, paperColor, coverage);
                // Darkening follows the blur. The further the sheet lifts off
                // its glowing image, the wider each point's scattering cone:
                // more of its light is absorbed along the way and more of the
                // cone falls past the image onto the dark housing. Attenuate by
                // the same radius that sets the blur, so shade and softness
                // share one gradient instead of a painted edge profile.
                float blurRadius = effectiveGap * scatter / max(abs(dot(ray, uPlaneNormal)), 0.1);
                float edgeEnabled = (uInspectionMode < 0.5 || uInspectionMode > 9.5) ? 1.0 : 0.0;
                float lightLoss = 1.0 - exp(-3.5 * uEdgeDarkening * blurRadius);
                baseColor *= 1.0 - edgeEnabled * lightLoss;
              }
              // Keep each display on its own stationary image plane at every
              // viewpoint. Switching to mesh UVs would abruptly change the
              // image position as the camera crosses the plane's edge-on view.
              // Geometry and depth determine which display is visible. The
              // source image itself is one-sided: looking through a stencil
              // at the back of its image plane must not reveal reversed art.
              // Fade only near grazing incidence, without changing UV mapping.
              float imageFacing = smoothstep(0.0, 0.06, dot(toEye, uPlaneNormal));
              diffuseColor.rgb = mix(uDarkField, baseColor, imageFacing);
              if (!uUseStencil) {
                vec2 attachedUv = mix(screenUv, coverImageUv(screenUv), uOuterScreen);
                diffuseColor.rgb = sampleDisplay(attachedUv);
              }
              if (uDragHint > 0.001 && uInspectionMode < 0.5) {
                // Only the sheet that moves: the cover when closed, the inner
                // leaf (u < .5) when open. "along" runs free edge -> hinge.
                float onCover = uOuterScreen * uDragHintCover;
                float onLeaf = (1.0 - uOuterScreen) * (1.0 - uDragHintCover) * step(screenUv.x, 0.5);
                float along = mix(screenUv.x / 0.5, 1.0 - screenUv.x, uOuterScreen);
                // Grid in physical units so the dots stay round on both screens.
                vec2 grid = vec2(screenUv.x * mix(4.3, 2.15, uOuterScreen), screenUv.y * 3.09);
                const float spacing = 0.13;
                float dotDistance = length(fract(grid / spacing) - 0.5) * spacing;
                float aa = max(fwidth(dotDistance), 1e-4);
                float dotMask = 1.0 - smoothstep(0.011 - aa, 0.011 + aa, dotDistance);
                // Soft bands travelling toward the hinge, fading at both ends.
                float flow = pow(0.5 + 0.5 * sin(6.2831853 * (along * 1.25 - uDragHintTime * 0.55)), 6.0);
                flow = mix(flow, 0.45, uDragHintStatic);
                float envelope = smoothstep(0.0, 0.12, along) * (1.0 - smoothstep(0.75, 1.0, along));
                float shimmer = 0.6 + 0.4 * sin(grid.y * 9.0 + uDragHintTime * 1.7 + grid.x * 3.0);
                diffuseColor.rgb += vec3(dotMask * flow * envelope * shimmer * 0.6 *
                  uDragHint * (onCover + onLeaf));
              }
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
      if (outer) {
        // Hinge-side edge: smallest u, nearest the vertical middle.
        const uv = screen.geometry.getAttribute("uv");
        let minU = Infinity;
        for (let i = 0; i < uv.count; i++) minU = Math.min(minU, uv.getX(i));
        let index = 0, best = Infinity;
        for (let i = 0; i < uv.count; i++) {
          if (uv.getX(i) > minU + 0.01) continue;
          const score = Math.abs(uv.getY(i) - 0.5);
          if (score < best) { best = score; index = i; }
        }
        coverAnchor = {
          mesh: screen,
          index,
          rest: screen.localToWorld(screen.getVertexPosition(index, new THREE.Vector3())),
          origin: fitted.origin.clone(),
          visual,
        };
      }
    }
    scene.add(phone);
    // Sample the phone's horizontal centre AND the hinge angle at the folded and
    // fully-open poses. The slide is then keyed to the actual hinge angle (not
    // elapsed time), so the view reaches its final position exactly as the fold
    // completes — the opening is eased, so a time-based slide would keep drifting
    // after the phone already looks open.
    setTime(0);
    centreFolded = measureCentreX();
    foldAngleClosed = hingeAngle.value;
    setTime(SEQUENCE_DURATION);
    centreOpen = measureCentreX();
    foldAngleOpen = hingeAngle.value;
    foldCentringReady = true;
    setTime(initialTime);
    render();
  });

  let dragHintTarget = 0;
  let dragHintFrame = 0;
  let dragHintLast = 0;
  let dragHintStart = 0;
  function dragHintTick(now: number) {
    const dt = Math.min(0.1, (now - dragHintLast) / 1000);
    dragHintLast = now;
    dragHint.value += (dragHintTarget - dragHint.value) * (1 - Math.exp(-dt / 0.25));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    dragHintStatic.value = still ? 1 : 0;
    if (!still) dragHintTime.value = (now - dragHintStart) / 1000;
    dragHintCover.value = hingeAngle.value > 90 ? 1 : 0;
    if (dragHintTarget === 0 && dragHint.value < 0.002) {
      dragHint.value = 0;
      dragHintFrame = 0;
      render();
      return;
    }
    render();
    dragHintFrame = requestAnimationFrame(dragHintTick);
  }

  function render() {
    if (disposed) return;
    camera.getWorldDirection(viewToEye.value).negate();
    if (coverAnchor) {
      const { mesh, index, rest, origin, visual } = coverAnchor;
      phone?.updateMatrixWorld(true);
      if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton.update();
      const shift = mesh.localToWorld(mesh.getVertexPosition(index, new THREE.Vector3())).sub(rest);
      imagePlanes.get(true)?.origin.value.copy(origin).add(shift);
      visual.mesh.position.copy(shift);
      visual.outline.position.copy(shift);
    }
    if (leafFace) {
      phone?.updateMatrixWorld(true);
      const { mesh, a, b, c } = leafFace;
      mesh.updateWorldMatrix(true, false);
      if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton.update();
      const va = mesh.localToWorld(mesh.getVertexPosition(a, new THREE.Vector3()));
      const vb = mesh.localToWorld(mesh.getVertexPosition(b, new THREE.Vector3()));
      const vc = mesh.localToWorld(mesh.getVertexPosition(c, new THREE.Vector3()));
      leafFacing.value = new THREE.Triangle(va, vb, vc).getNormal(new THREE.Vector3()).dot(viewToEye.value);
    }
    renderer.render(scene, camera);
  }

  function resetCamera() {
    camera.position.set(...(comparison.view ?? [0, 0, 10]));
    camera.zoom = 1;
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    camera.updateProjectionMatrix();
  }

  // Offset the (symmetric) orthographic frustum horizontally by panX so a phone
  // whose visual centre sits at world-x panX renders in the middle of the stage.
  function applyFrustum() {
    camera.left = -frustumHalfWidth + panX;
    camera.right = frustumHalfWidth + panX;
    camera.top = frustumHalfHeight;
    camera.bottom = -frustumHalfHeight;
    camera.updateProjectionMatrix();
  }

  // World-x centre of the display screens at the current fold, using the skinned
  // vertex positions so it tracks the bones as the phone opens.
  function measureCentreX() {
    let min = Infinity;
    let max = -Infinity;
    const vertex = new THREE.Vector3();
    for (const mesh of displayMeshes) {
      const position = mesh.geometry.getAttribute("position");
      if (!position) continue;
      const skinned = mesh as THREE.SkinnedMesh;
      const isSkinned = skinned.isSkinnedMesh === true;
      if (isSkinned) skinned.skeleton.update();
      mesh.updateWorldMatrix(true, false);
      const step = Math.max(1, Math.floor(position.count / 240));
      for (let i = 0; i < position.count; i += step) {
        vertex.fromBufferAttribute(position, i);
        if (isSkinned) skinned.applyBoneTransform(i, vertex);
        mesh.localToWorld(vertex);
        if (vertex.x < min) min = vertex.x;
        if (vertex.x > max) max = vertex.x;
      }
    }
    return Number.isFinite(min) ? (min + max) / 2 : 0;
  }

  function resize() {
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    const aspect = width / height;
    const viewHeight = Math.max(imageHeight * 1.3, imageWidth * 1.22 / aspect);
    frustumHalfWidth = viewHeight * aspect / 2;
    frustumHalfHeight = viewHeight / 2;
    applyFrustum();
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
    outerActive.value = 1 - smoothstep(0, 8, state.rightAngle);
    leftPaper.value = state.leftPaper;
    leftAngle.value = state.leftAngle;
    rightPaper.value = state.rightPaper;
    // Minimum blur distance while a sheet is off its rest pose; it releases
    // only in the final 2.5°, which the terminal clack crosses in milliseconds.
    leftBlurFloor.value = BLUR_FLOOR * smoothstep(0, 2.5, state.leftAngle);
    rightBlurFloor.value = BLUR_FLOOR * smoothstep(0, 2.5, state.rightAngle);
    if (foldCentringReady) {
      // Slide the view between the folded and fully-open centres in step with
      // the actual hinge angle (not elapsed time). This way the phone reaches
      // its final centred position exactly as the fold finishes and then stops —
      // it never keeps drifting once the phone already looks open.
      const span = foldAngleOpen - foldAngleClosed;
      const openFraction = Math.abs(span) > 1e-3
        ? THREE.MathUtils.clamp((phoneAngle - foldAngleClosed) / span, 0, 1)
        : 0;
      panX = centreFolded + (centreOpen - centreFolded) * openFraction;
      applyFrustum();
    }
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
    ready,
    measureDetailEnergy() {
      // Fixed square render, linear luminance, moving display only. Use the
      // production material itself so progressive scattering is measured too.
      const size = 512;
      captureTarget ??= new THREE.WebGLRenderTarget(size, size, {
        type: THREE.HalfFloatType, samples: Math.min(4, renderer.capabilities.maxSamples),
      });
      const saved = [camera.left, camera.right, camera.top, camera.bottom];
      const span = Math.max(imageHeight * 1.3, imageWidth * 1.22);
      camera.left = camera.bottom = -span / 2;
      camera.right = camera.top = span / 2;
      camera.updateProjectionMatrix();
      const target = renderer.getRenderTarget();
      const background = scene.background;
      const pixels = new Uint16Array(size * size * 4);
      const mask = new Uint16Array(size * size * 4);
      const black = new THREE.MeshBasicMaterial({ color: 0, toneMapped: false });
      const changed: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
      // Measure the display itself, never the drag hint drawn on it.
      const hintLevel = dragHint.value;
      dragHint.value = 0;
      try {
        renderer.setRenderTarget(captureTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null); // Resolve the multisampled target before readback.
        renderer.readRenderTargetPixels(captureTarget, 0, 0, size, size, pixels);
        scene.background = new THREE.Color(0);
        phone?.traverse(object => {
          if (object instanceof THREE.Mesh && !displayMeshes.includes(object)) {
            changed.push([object, object.material]);
            object.material = black;
          }
        });
        captureMask.value = true;
        renderer.setRenderTarget(captureTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.readRenderTargetPixels(captureTarget, 0, 0, size, size, mask);
      } finally {
        dragHint.value = hintLevel;
        captureMask.value = false;
        changed.forEach(([object, material]) => { object.material = material; });
        black.dispose();
        scene.background = background;
        [camera.left, camera.right, camera.top, camera.bottom] = saved;
        camera.updateProjectionMatrix();
        renderer.setRenderTarget(target);
      }
      const gray = new Float32Array(size * size);
      for (let i = 0; i < gray.length; i++) gray[i] =
        .2126 * THREE.DataUtils.fromHalfFloat(pixels[i * 4]) +
        .7152 * THREE.DataUtils.fromHalfFloat(pixels[i * 4 + 1]) +
        .0722 * THREE.DataUtils.fromHalfFloat(pixels[i * 4 + 2]);
      const kernel: Array<[number, number, number]> = [];
      let weight = 0;
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        const w = Math.exp(-(x * x + y * y) / 1.28);
        kernel.push([x, y, w]); weight += w;
      }
      let energy = 0, count = 0;
      for (let y = 3; y < size - 3; y++) for (let x = 3; x < size - 3; x++) {
        let eligible = true;
        for (let dy = -3; dy <= 3 && eligible; dy++) for (let dx = -3; dx <= 3; dx++) {
          if (THREE.DataUtils.fromHalfFloat(mask[((y + dy) * size + x + dx) * 4]) < .99) { eligible = false; break; }
        }
        if (!eligible) continue;
        let low = 0;
        for (const [dx, dy, w] of kernel) low += gray[(y + dy) * size + x + dx] * w;
        energy += (gray[y * size + x] - low / weight) ** 2;
        count++;
      }
      return count >= 64 ? energy / count : NaN;
    },
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
      // A nearly edge-on leaf can be only a few pixels wide. Probe a small
      // screen-space halo, retaining the actual hit point as the drag anchor.
      const probes = [[0, 0]];
      for (const radius of [8, 16, 24]) {
        for (let i = 0; i < 8; i++) probes.push([Math.cos(i * Math.PI / 4) * radius, Math.sin(i * Math.PI / 4) * radius]);
      }
      const seen = new Set<string>();
      for (const [dx, dy] of probes) {
      raycaster.setFromCamera(new THREE.Vector2(
        (clientX + dx - bounds.left) / bounds.width * 2 - 1,
        -(clientY + dy - bounds.top) / bounds.height * 2 + 1,
      ), camera);
      for (const hit of raycaster.intersectObjects(displayMeshes, false)) {
      if (!hit.object.visible || !hit.face) continue;
      const key = `${hit.object.uuid}:${hit.faceIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
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
      const current = stateAtTime(sequenceTime);
      const currentAngle = 90 + current.leftAngle - current.rightAngle;
      pose(currentAngle < 90 ? currentAngle + 30 : currentAngle - 30);
      const mobility = projectedGrab().distanceTo(initialPoint);
      pose(currentAngle);
      if (mobility < 1) continue;
      const path: Array<{ point: THREE.Vector2; time: number }> = [];
      // Follow this exact barycentric mesh point through the authored hinge
      // rig. Projection makes the grab work from orbit views as well as front.
      for (let angle = 180; angle >= 0; angle--) {
        pose(angle);
        path.push({ point: projectedGrab(), time: timeForAngle(angle) });
      }
      pose(90 + current.leftAngle - current.rightAngle);
      // A point on the anchored panel has no useful hinge trajectory.
      if (Math.max(...path.map(sample => sample.point.distanceTo(initialPoint))) < 8) continue;
      grabPointer.set(clientX, clientY);
      grabIndex = 180 - currentAngle;
      grabPath = path;
      controls.enabled = false;
      return true;
      }
      }
      return false;
    },
    moveGrab(clientX, clientY) {
      if (!grabPath) return null;
      const delta = new THREE.Vector2(clientX, clientY).sub(grabPointer);
      grabPointer.set(clientX, clientY);
      // Integrate only the local screen-space tangent. No global nearest
      // search: overlapping projected arcs cannot switch rotation branches.
      // Regularization reduces sensitivity near a projected turning point.
      const steps = Math.max(1, Math.ceil(delta.length() / 4));
      delta.divideScalar(steps);
      for (let step = 0; step < steps; step++) {
        const low = Math.max(0, Math.floor(grabIndex) - 1);
        const high = Math.min(180, Math.ceil(grabIndex) + 1);
        const tangent = grabPath[high].point.clone().sub(grabPath[low].point).divideScalar(high - low);
        const change = delta.dot(tangent) / (tangent.lengthSq() + 1);
        grabIndex = THREE.MathUtils.clamp(grabIndex + THREE.MathUtils.clamp(change, -3, 3), 0, 180);
      }
      const i = Math.min(179, Math.floor(grabIndex));
      return THREE.MathUtils.lerp(grabPath[i].time, grabPath[i + 1].time, grabIndex - i);
    },
    endGrab() { grabPath = null; controls.enabled = moveView; },
    setDragHint(active) {
      dragHintTarget = active ? 1 : 0;
      if (active && dragHint.value < 0.002) dragHintStart = performance.now();
      if (!dragHintFrame) {
        dragHintLast = performance.now();
        dragHintFrame = requestAnimationFrame(dragHintTick);
      }
    },
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
      cancelAnimationFrame(dragHintFrame);
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
      captureTarget?.dispose();
      renderer.domElement.remove();
    },
  };
}
