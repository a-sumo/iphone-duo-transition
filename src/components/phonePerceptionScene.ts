import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;
const duoInnerUrl = asset("assets/tracing-paper/iphone-duo-clean-background.jpeg");
const duoCoverUrl = asset("assets/tracing-paper/iphone-duo-folded-cover.png");
import { estimateRenderedFlow, type FlowFrame } from "./renderedOpticalFlow";
import { applyStarWhiteFinish } from "./phoneFinish";

export type ExperimentState = {
  angle: number;
  comparison: "blur" | "stencil";
  map: boolean;
  direction: number;
  content: "duo" | "newspaper" | "dots";
  blur: number;
  overlayOpacity: number;
  playing?: boolean;
  dragging?: boolean;
};

// Separate rendering experiment: the production transition is not modified.
// hero: banner/cover renders only. Measures at twice the resolution so the
// energy map is crisp, and draws flow as the screen's true on-screen motion on
// an even grid (what the tracker estimates) instead of sparse tracked patches.
export async function mountPhoneExperiment(
  stage: HTMLElement,
  treatment: boolean,
  { hero = false }: { hero?: boolean } = {},
) {
  const size = hero ? 1024 : 512;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const displaySize = Math.min(
    hero ? 3072 : 2048,
    Math.max(
      window.self === window.top ? 1536 : 1024,
      Math.ceil(
        stage.getBoundingClientRect().width *
          Math.min(window.devicePixelRatio || 1, 2),
      ),
    ),
  );
  renderer.setPixelRatio(1);
  renderer.setSize(displaySize, displaySize, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);
  const arrows = document.createElement("canvas");
  arrows.width = arrows.height = displaySize;
  arrows.className = "phone-study-arrows";
  stage.appendChild(arrows);
  const arrowContext = arrows.getContext("2d")!;
  arrowContext.scale(displaySize / size, displaySize / size);
  const scene = new THREE.Scene();
  // Hero matches the transition lab's framing: orthographic, and panned so the
  // screens stay centred as the phone folds.
  const camera = hero
    ? new THREE.OrthographicCamera(-2.775, 2.775, 2.775, -2.775, 0.1, 100)
    : new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(0, 0, 8.8);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const pmrem = new THREE.PMREMGenerator(renderer),
    room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.025);
  const newspaper = await new THREE.TextureLoader().loadAsync(
    asset("assets/tracing-paper/tomaselli-newspaper-reference.jpg"),
  );
  newspaper.colorSpace = THREE.SRGBColorSpace;
  newspaper.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const duo = await Promise.all(
    [duoInnerUrl, duoCoverUrl].map((url) =>
      new THREE.TextureLoader().loadAsync(url),
    ),
  );
  duo.forEach((t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  });
  scene.environment = env.texture;
  scene.environmentIntensity = 0.85;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dfe8, 2.2));
  // Same lighting and hardware finish as the transition lab.
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(-3, 4, 8);
  scene.add(keyLight);
  room.dispose();
  pmrem.dispose();
  const gltf = await new GLTFLoader().loadAsync(
    asset("models/iphone-duo-full-replaced-screen.glb"),
  );
  const phone = gltf.scene;
  phone.scale.setScalar(4.3 / 0.15856843);
  phone.position.set(0, -0.05889157 * phone.scale.x, -0.08);
  const axle = phone.getObjectByName("Axle_9");
  if (axle) axle.position.z += 0.0009;
  applyStarWhiteFinish(phone);
  scene.add(phone);
  const hinge = phone.getObjectByName("Bone_Hinge_46") as THREE.Bone;
  const leaf = phone.getObjectByName("Bone_01_45") as THREE.Bone;
  const hingeRest = hinge.quaternion.clone(),
    leafRest = leaf.quaternion.clone();
  const axis = new THREE.Vector3(1, 0, 0),
    q = new THREE.Quaternion();
  const screens = ["Object_106", "Object_72"].map(
    (n) => phone.getObjectByName(n) as THREE.Mesh,
  );
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  phone.traverse((o) => {
    if (o instanceof THREE.Mesh) originals.set(o, o.material);
  });
  const maskMaterial = new THREE.MeshBasicMaterial({
    color: 0,
    opacity: 0,
    transparent: true,
    blending: THREE.NoBlending,
    depthWrite: true,
  });
  // Alpha zero but depth writes retained: hardware occludes the screen target.
  const pose = (angle: number) => {
    q.setFromAxisAngle(axis, THREE.MathUtils.degToRad(angle) / 2);
    hinge.quaternion.copy(hingeRest).multiply(q);
    leaf.quaternion.copy(leafRest).multiply(q);
    phone.updateMatrixWorld(true);
    phone.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) o.skeleton.update();
    });
  };
  const u = {
    stencil: { value: 0 },
    flow: { value: 0 },
    newspaper: { value: 1 },
    region: { value: 0 },
    overlay: { value: 0.5 },
    // "With blur" uses the transition's own paper model (see the display
    // shader): scattering grows with the sheet's distance from its image,
    // darkening follows the blur radius, and a floor holds it until rest.
    blurTreatment: { value: 0 },
    scatter: { value: 2.6 },
    darken: { value: 1.4 },
    vp: {
      value: new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      ),
    },
  };
  const materials: THREE.MeshBasicMaterial[] = [];
  // Per-screen paper state and the cover's hinge-edge anchor.
  const paperUniforms = screens.map(() => ({ paper: { value: 0 }, floor: { value: 0 } }));
  const planeOrigins: { value: THREE.Vector3 }[] = [];
  let coverAnchor: { index: number; rest: THREE.Vector3; origin: THREE.Vector3 } | null = null;
  const imageUniforms: {
    image: { value: THREE.Texture };
    crop: { value: THREE.Vector2 };
    aspect: number;
  }[] = [];
  screens.forEach((mesh, index) => {
    pose(index === 0 ? 0 : 180);
    // Least-squares registration of the authored UV coordinates to world space.
    const uv = mesh.geometry.getAttribute("uv"),
      gram = new THREE.Matrix3();
    let n = 0,
      su = 0,
      sv = 0,
      suu = 0,
      suv = 0,
      svv = 0;
    const bx = new THREE.Vector3(),
      by = new THREE.Vector3(),
      bz = new THREE.Vector3(),
      p = new THREE.Vector3();
    for (let i = 0; i < uv.count; i++) {
      const a = uv.getX(i),
        b = 1 - uv.getY(i);
      mesh.getVertexPosition(i, p);
      mesh.localToWorld(p);
      n++;
      su += a;
      sv += b;
      suu += a * a;
      suv += a * b;
      svv += b * b;
      bx.add(new THREE.Vector3(p.x, a * p.x, b * p.x));
      by.add(new THREE.Vector3(p.y, a * p.y, b * p.y));
      bz.add(new THREE.Vector3(p.z, a * p.z, b * p.z));
    }
    gram.set(n, su, sv, su, suu, suv, sv, suv, svv).invert();
    bx.applyMatrix3(gram);
    by.applyMatrix3(gram);
    bz.applyMatrix3(gram);
    const origin = new THREE.Vector3(bx.x, by.x, bz.x),
      U = new THREE.Vector3(bx.y, by.y, bz.y),
      V = new THREE.Vector3(bx.z, by.z, bz.z),
      N = new THREE.Vector3().crossVectors(U, V).normalize();
    const originUniform = { value: origin.clone() };
    planeOrigins.push(originUniform);
    if (index === 1) {
      // As in the transition: the cover's image plane follows its hinge-side
      // edge, so stenciled artwork never detaches from the bezel.
      let minU = Infinity;
      for (let i = 0; i < uv.count; i++) minU = Math.min(minU, uv.getX(i));
      let anchor = 0, best = Infinity;
      for (let i = 0; i < uv.count; i++) {
        if (uv.getX(i) > minU + 0.01) continue;
        const score = Math.abs(uv.getY(i) - 0.5);
        if (score < best) { best = score; anchor = i; }
      }
      coverAnchor = {
        index: anchor,
        rest: mesh.localToWorld(mesh.getVertexPosition(anchor, new THREE.Vector3())),
        origin: origin.clone(),
      };
    }
    mesh.geometry = mesh.geometry.clone();
    // Identify the physical moving leaf once, independent of content or blur.
    pose(0);
    const restPositions = Array.from({ length: uv.count }, (_, i) => {
      const v = new THREE.Vector3();
      mesh.getVertexPosition(i, v);
      return mesh.localToWorld(v);
    });
    pose(60);
    const mobility = new Float32Array(uv.count);
    for (let i = 0; i < uv.count; i++) {
      const v = new THREE.Vector3();
      mesh.getVertexPosition(i, v);
      mobility[i] = mesh.localToWorld(v).distanceTo(restPositions[i]);
    }
    mesh.geometry.setAttribute(
      "mobility",
      new THREE.BufferAttribute(mobility, 1),
    );
    mesh.geometry.setAttribute(
      "nextPosition",
      new THREE.BufferAttribute(new Float32Array(uv.count * 3), 3),
    );
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    const image = { value: duo[index] },
      crop = { value: new THREE.Vector2(1, 1) };
    imageUniforms.push({ image, crop, aspect: U.length() / V.length() });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, {
        uStencil: u.stencil,
        uFlow: u.flow,
        uNewspaper: u.newspaper,
        uRegion: u.region,
        uOverlay: u.overlay,
        uImage: image,
        uCrop: crop,
        uVP: u.vp,
        uOrigin: originUniform,
        uBlurTreatment: u.blurTreatment,
        uScatter: u.scatter,
        uDarken: u.darken,
        uPaper: paperUniforms[index].paper,
        uFloor: paperUniforms[index].floor,
        uIsCover: { value: index === 1 ? 1 : 0 },
        uU: { value: U },
        uV: { value: V },
        uN: { value: N },
        uCount: { value: new THREE.Vector2(index === 0 ? 48 : 24, 32) },
        uRes: { value: new THREE.Vector2(size, size) },
      });
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
attribute float mobility; varying float vMobility; attribute vec3 nextPosition; varying vec2 vDotUv; varying vec3 vWorld; varying vec4 vNext; uniform mat4 uVP; varying vec3 vPaperNormal;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>\nvMobility=mobility;vDotUv=vec2(uv.x,1.0-uv.y);`,
        )
        .replace(
          "#include <project_vertex>",
          `vWorld=(modelMatrix*vec4(transformed,1.0)).xyz;vNext=uVP*vec4(nextPosition,1.0);
#if defined( USE_ENVMAP ) || defined( USE_SKINNING )
vPaperNormal=normalize(inverseTransformDirection(transformedNormal,viewMatrix));
#else
vPaperNormal=normalize(mat3(modelMatrix)*normal);
#endif
#include <project_vertex>`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying float vMobility; uniform float uRegion; varying vec2 vDotUv; varying vec3 vWorld; varying vec4 vNext;
uniform float uStencil,uFlow,uNewspaper,uOverlay;uniform sampler2D uImage;uniform vec2 uCrop;uniform vec3 uOrigin,uU,uV,uN;uniform vec2 uCount,uRes;
varying vec3 vPaperNormal;uniform float uBlurTreatment,uScatter,uDarken,uPaper,uFloor,uIsCover;
vec3 contentAt(vec2 c,float bias,float aa){
 float valid=step(0.,c.x)*step(c.x,1.)*step(0.,c.y)*step(c.y,1.);
 if(uNewspaper>.5)return texture2D(uImage,(c-.5)*uCrop+.5,bias).rgb*valid;
 float d=length(fract(c*uCount)-.5);
 return vec3(mix(.018,.92,smoothstep(.16-aa,.16+aa,d))*valid);
}
float segmentDistance(vec2 p,vec2 a,vec2 b){vec2 ab=b-a;return length(p-a-ab*clamp(dot(p-a,ab)/max(dot(ab,ab),.00001),0.,1.));}`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
vec2 coord=vDotUv;
if(uStencil>.5){
 vec3 ray=normalize(vWorld-cameraPosition);float den=dot(ray,uN);
 float t=dot(uOrigin-vWorld,uN)/(abs(den)<.00001?.00001:den);
 vec3 off=vWorld+ray*t-uOrigin;float a=dot(uU,uU),b=dot(uU,uV),c=dot(uV,uV);
 coord=vec2((dot(off,uU)*c-dot(off,uV)*b),(dot(off,uV)*a-dot(off,uU)*b))/max(a*c-b*b,.00001);
}
vec2 cell=fract(coord*uCount)-.5;float d=length(cell);float aa=max(fwidth(d),.001);
float dotValue=smoothstep(.16-aa,.16+aa,d);
float valid=step(0.,coord.x)*step(coord.x,1.)*step(0.,coord.y)*step(coord.y,1.);
diffuseColor.rgb=vec3(mix(.018,.92,dotValue)*valid);
if(uNewspaper>.5){vec2 imageUv=(coord-.5)*uCrop+.5;diffuseColor.rgb=texture2D(uImage,imageUv).rgb*valid;}
if(uBlurTreatment>.5){
 // The transition's paper model on the attached content. Only the moving
 // sheet lifts: the cover as a whole, the inner leaf (u < .5) with the same
 // soft transition toward the hinge.
 vec3 toEye=normalize(cameraPosition-vWorld);
 float grazing=1.-abs(dot(normalize(vPaperNormal),toEye));
 float transitionMask=1.-smoothstep(.5-.5*.75,.5,vDotUv.x);
 float paperAmount=uPaper*mix(transitionMask,1.,uIsCover);
 float gap=max(abs(dot(vWorld-uOrigin,uN)),uFloor);
 float scatter=.55*(.10+.16*grazing)*uScatter*paperAmount;
 vec3 ray=-toEye;
 float blurRadius=gap*scatter/max(abs(dot(ray,uN)),.1);
 vec2 radiusUv=vec2(blurRadius/length(uU),blurRadius/length(uV));
 float radiusTexels=radiusUv.x*1024.;
 float blurBlend=smoothstep(.5,3.,radiusTexels);
 vec3 sharpColor=diffuseColor.rgb;
 vec3 under=sharpColor;
 if(blurBlend>.001){
  vec3 sum=vec3(0.);
  float bias=max(0.,log2(max(1.,radiusTexels/6.9)));
  for(int i=0;i<48;i++){
   float index=float(i)+.5;float r=sqrt(index/48.);float az=index*2.3999632;
   sum+=contentAt(coord+radiusUv*r*vec2(cos(az),sin(az)),bias,.04);
  }
  under=mix(sharpColor,sum/48.,blurBlend);
 }
 // Transmission loss through the lifting sheet, then darkening that follows
 // the blur radius, exactly as in the transition.
 float opticalDepth=pow(1./max(1.-grazing,.17),1.45);
 float transmission=pow(.89,opticalDepth)*exp(-.35*gap);
 float attenuation=paperAmount*smoothstep(0.,.025,gap);
 vec3 paperColor=mix(under,mix(vec3(.035,.041,.047),under,transmission),attenuation);
 float lightLoss=1.-exp(-3.5*uDarken*blurRadius);
 diffuseColor.rgb=paperColor*(1.-lightLoss);
}
if(uRegion>.5)diffuseColor.rgb=vec3(step(.001,vMobility));
// Screen-space motion of this surface point to the next pose, in pixels.
if(uFlow>.5)diffuseColor.rgb=vec3((vNext.xy/vNext.w-(gl_FragCoord.xy/uRes*2.-1.))*.5*uRes,1.);
`,
        );
    };
    mat.customProgramCacheKey = () => `perception-${index}`;
    materials.push(mat);
    mesh.material = mat;
  });
  const target = () =>
    new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
  const raw = target(),
    horizontal = target(),
    filtered = target(),
    energy = target(),
    region = target();
  const postScene = new THREE.Scene(),
    postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uniforms = {
    tex: { value: raw.texture },
    mode: { value: 0 },
    presentation: { value: false },
    sigma: { value: 0 },
    // Colour-map range. The high-pass is per pixel, so twice the resolution
    // leaves less contrast in each pixel.
    energyScale: { value: hero ? 0.012 : 0.04 },
    axis: { value: new THREE.Vector2(1, 0) },
    step: { value: new THREE.Vector2(1 / size, 1 / size) },
  };
  const postMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms,
    vertexShader:
      "varying vec2 v;void main(){v=uv;gl_Position=vec4(position.xy,0.,1.);}",
    fragmentShader:
      `varying vec2 v;uniform sampler2D tex;uniform int mode;uniform bool presentation;uniform float sigma;uniform float energyScale;uniform vec2 axis;uniform vec2 step;
vec4 get(vec2 p){return texture2D(tex,p);}
void main(){vec4 center=get(v);if(center.a<(presentation?.001:.99))discard;
 if(mode==0){vec3 sum=vec3(0.);float weight=0.;for(int i=-12;i<=12;i++){vec4 s=get(v+float(i)*axis*pixel);float w=exp(-float(i*i)/(2.*max(sigma*sigma,.001)))*step(.99,s.a);sum+=s.rgb*w;weight+=w;}gl_FragColor=vec4(sum/max(weight,.0001),1.);}
 else if(mode==1){vec3 low=vec3(0.);float weight=0.;for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){vec4 s=get(v+vec2(float(x),float(y))*step);if(s.a<.99){gl_FragColor=vec4(0.,0.,0.,1.);return;}float w=exp(-float(x*x+y*y)/1.28);low+=s.rgb*w;weight+=w;}float hp=dot(center.rgb-low/weight,vec3(.2126,.7152,.0722));gl_FragColor=vec4(hp*hp,0.,0.,1.);}
 else if(mode==2){float e=0.,weight=0.;for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){vec4 s=get(v+vec2(float(x),float(y))*step*2.);float w=exp(-float(x*x+y*y)/3.);e+=s.r*w;weight+=w;}float t=clamp(e/weight/energyScale,0.,1.);vec3 c=mix(vec3(.02,.01,.10),vec3(.78,.12,.32),smoothstep(0.,.55,t));c=mix(c,vec3(1.,.93,.38),smoothstep(.45,1.,t));gl_FragColor=vec4(c,1.);}
 else gl_FragColor=center;
 if(presentation)gl_FragColor.a=center.a;
 #include <colorspace_fragment>
}`
        .replace("uniform vec2 step;", "uniform vec2 pixel;")
        .replaceAll("*step)", "*pixel)")
        .replaceAll("*step*", "*pixel*"),
  });
  // The uniform is named pixel because step() is also a GLSL builtin.
  postMat.uniforms.pixel = uniforms.step;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
  postScene.add(quad);
  function pass(
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null,
    mode: number,
  ) {
    uniforms.tex.value = input;
    uniforms.mode.value = mode;
    renderer.setRenderTarget(output);
    if (output) renderer.clear();
    renderer.render(postScene, postCamera);
  }
  const pixels = new Uint16Array(size * size * 4);
  const regionPixels = new Uint16Array(size * size * 4);
  function captureFrame(): FlowFrame {
    const gray = new Float32Array(size * size),
      mask = new Uint8Array(size * size);
    renderer.readRenderTargetPixels(raw, 0, 0, size, size, pixels);
    u.region.value = 1;
    renderer.setRenderTarget(region);
    renderer.clear();
    renderer.render(scene, camera);
    u.region.value = 0;
    renderer.readRenderTargetPixels(region, 0, 0, size, size, regionPixels);
    for (let i = 0; i < gray.length; i++) {
      const k = i * 4;
      gray[i] =
        0.2126 * THREE.DataUtils.fromHalfFloat(pixels[k]) +
        0.7152 * THREE.DataUtils.fromHalfFloat(pixels[k + 1]) +
        0.0722 * THREE.DataUtils.fromHalfFloat(pixels[k + 2]);
      mask[i] =
        THREE.DataUtils.fromHalfFloat(pixels[k + 3]) > 0.99 &&
        THREE.DataUtils.fromHalfFloat(regionPixels[k]) > 0.5 &&
        THREE.DataUtils.fromHalfFloat(regionPixels[k + 3]) > 0.99
          ? 1
          : 0;
    }
    return { gray, mask, size };
  }
  // Flow glyph in measurement pixels (y up), drawn on the overlay canvas.
  function arrow(x: number, y: number, dx: number, dy: number, len: number, head: number, shaft: number, line: number) {
    arrowContext.save();
    arrowContext.translate(x, size - y);
    arrowContext.rotate(Math.atan2(-dy, dx));
    const tail = -len / 2,
      tip = len / 2;
    const shoulder = tip - head;
    arrowContext.beginPath();
    arrowContext.moveTo(tail + shaft, -shaft);
    arrowContext.lineTo(shoulder, -shaft);
    arrowContext.lineTo(shoulder, -head * 0.65);
    arrowContext.lineTo(tip, 0);
    arrowContext.lineTo(shoulder, head * 0.65);
    arrowContext.lineTo(shoulder, shaft);
    arrowContext.lineTo(tail + shaft, shaft);
    arrowContext.quadraticCurveTo(tail, shaft, tail, 0);
    arrowContext.quadraticCurveTo(tail, -shaft, tail + shaft, -shaft);
    arrowContext.closePath();
    arrowContext.lineJoin = "round";
    arrowContext.lineWidth = line;
    arrowContext.strokeStyle = "rgba(255,255,255,0.95)";
    arrowContext.stroke();
    arrowContext.fillStyle = treatment ? "#0281C1" : "#269EE5";
    arrowContext.fill();
    arrowContext.restore();
  }
  // Hero flow: render each screen point's motion to the next pose, then place
  // one glyph per cell of an even grid wherever the cell is fully on-screen.
  function drawMotionField(opacity: number) {
    u.flow.value = 1;
    renderer.setRenderTarget(raw);
    renderer.setClearColor(0, 0);
    renderer.clear();
    renderer.render(scene, camera);
    u.flow.value = 0;
    renderer.setRenderTarget(null);
    renderer.readRenderTargetPixels(raw, 0, 0, size, size, pixels);
    const half = (x: number, y: number, c: number) => {
      const px = Math.round(x), py = Math.round(y);
      if (px < 0 || py < 0 || px >= size || py >= size) return NaN;
      return THREE.DataUtils.fromHalfFloat(pixels[(py * size + px) * 4 + c]);
    };
    const cell = size / 22, k = size / 512;
    arrowContext.globalAlpha = opacity;
    for (let y = cell / 2; y < size; y += cell)
      for (let x = cell / 2; x < size; x += cell) {
        const onScreen = [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].every(
          ([ox, oy]) => half(x + ox * cell, y + oy * cell, 3) > 0.99,
        );
        if (!onScreen) continue;
        const dx = half(x, y, 0), dy = half(x, y, 1), magnitude = Math.hypot(dx, dy);
        if (!(magnitude > 0.1 * k)) continue;
        const len = Math.min(magnitude * 6, cell * 0.92);
        arrow(x, y, dx, dy, len, Math.min(9 * k, len * 0.45), Math.min(2 * k, len * 0.16), 1.5 * k);
      }
  }
  function centreCamera() {
    let min = Infinity, max = -Infinity;
    const p = new THREE.Vector3();
    for (const mesh of screens) {
      const count = mesh.geometry.getAttribute("position").count;
      for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 240))) {
        mesh.localToWorld(mesh.getVertexPosition(i, p));
        min = Math.min(min, p.x);
        max = Math.max(max, p.x);
      }
    }
    camera.position.x = (min + max) / 2;
    camera.updateMatrixWorld();
    u.vp.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }
  const flowCache = new Map<string, ReturnType<typeof estimateRenderedFlow>>();
  const energyCache = new Map<string, number>();
  function draw(
    state: ExperimentState,
    measure = false,
    captureOnly = false,
  ): number {
    const energyKey = `${state.content}:${state.angle}:${treatment ? state.blur : 0}`;
    if (measure && state.comparison === "blur" && energyCache.has(energyKey))
      return energyCache.get(energyKey)!;
    uniforms.presentation.value = false;
    if (!measure && !captureOnly) arrowContext.clearRect(0, 0, size, size);
    if (state.comparison === "stencil" && (measure || state.map)) {
      const base = { ...state, map: false };
      if (!measure) draw(base);
      const nextAngle = Math.max(
        0,
        Math.min(180, state.angle + 2 * state.direction),
      );
      if (nextAngle === state.angle) {
        return NaN;
      }
      if (hero && !treatment && !measure) {
        if (state.map) drawMotionField(state.overlayOpacity);
        return 0;
      }
      const key = `${state.content}:${state.angle}:${nextAngle}`;
      let vectors = flowCache.get(key);
      const visibility = new Map<string, number>();
      if (!measure && (state.playing || state.dragging)) {
        const low = Math.floor(state.angle / 6) * 6,
          high = Math.min(180, low + 6);
        const at = (angle: number) =>
          flowCache.get(
            `${state.content}:${angle}:${Math.max(0, Math.min(180, angle + 2 * state.direction))}`,
          ) ?? [];
        const a = at(low),
          b = at(high),
          fraction = (state.angle - low) / 6,
          t = fraction * fraction * (3 - 2 * fraction);
        const matches = new Map(b.map((v) => [`${v.x}:${v.y}`, v]));
        // Fixed screen-grid anchors: blend vector components, never angle-wrap.
        // Confidence changes fade rather than dropping a glyph for a full interval.
        vectors = a.map((v) => {
          const id = `${v.x}:${v.y}`,
            w = matches.get(id);
          matches.delete(id);
          visibility.set(id, w ? 1 : 1 - t);
          return w
            ? {
                ...v,
                dx: v.dx + (w.dx - v.dx) * t,
                dy: v.dy + (w.dy - v.dy) * t,
              }
            : v;
        });
        for (const [id, v] of matches) {
          visibility.set(id, t);
          vectors.push(v);
        }
      }
      if (!vectors) {
        draw(base, false, true);
        const a = captureFrame();
        draw({ ...base, angle: nextAngle }, false, true);
        const b = captureFrame();
        if (!measure) draw(base);
        vectors = estimateRenderedFlow(a, b);
        if (flowCache.size >= 256)
          flowCache.delete(flowCache.keys().next().value!);
        flowCache.set(key, vectors);
      }
      if (state.map && !measure) {
        for (const v of vectors) {
          const alpha = visibility.get(`${v.x}:${v.y}`) ?? 1;
          arrowContext.globalAlpha = state.overlayOpacity * alpha;
          const magnitude = Math.hypot(v.dx, v.dy);
          if (magnitude < 0.05) continue;
          const len = Math.min(magnitude * 5, 34);
          arrow(v.x, v.y, v.dx, v.dy, len, Math.min(9, len * 0.45), Math.min(2, len * 0.16), 1.5);
        }
      }
      return vectors.length >= 4
        ? vectors.reduce((s, v) => s + Math.hypot(v.dx, v.dy), 0) /
            vectors.length
        : NaN;
    }
    const next = Math.max(0, Math.min(180, state.angle + 2 * state.direction));
    pose(next);
    screens.forEach((mesh) => {
      const attr = mesh.geometry.getAttribute(
          "nextPosition",
        ) as THREE.BufferAttribute,
        p = new THREE.Vector3();
      for (let i = 0; i < attr.count; i++) {
        mesh.getVertexPosition(i, p);
        // Capture the next pose in world space: the cover moves through its
        // parent transform as well as any skin deformation.
        mesh.localToWorld(p);
        attr.setXYZ(i, p.x, p.y, p.z);
      }
      attr.needsUpdate = true;
    });
    pose(state.angle);
    if (hero) centreCamera();
    if (coverAnchor) {
      const cover = screens[1];
      const now = cover.localToWorld(cover.getVertexPosition(coverAnchor.index, new THREE.Vector3()));
      planeOrigins[1].value.copy(coverAnchor.origin).add(now.sub(coverAnchor.rest));
    }
    u.overlay.value = state.overlayOpacity;
    u.blurTreatment.value = state.comparison === "blur" && treatment ? 1 : 0;
    u.scatter.value = state.blur;
    // Paper state per sheet: the inner leaf rests open (0°), the cover closed
    // (180°). The effect releases only in the last 1.5°; the blur floor in the
    // last 2.5°.
    const innerLift = Math.min(state.angle, 90), coverLift = Math.min(180 - state.angle, 90);
    paperUniforms[0].paper.value = THREE.MathUtils.smoothstep(innerLift, 0, 1.5);
    paperUniforms[1].paper.value = THREE.MathUtils.smoothstep(coverLift, 0, 1.5);
    paperUniforms[0].floor.value = 0.25 * THREE.MathUtils.smoothstep(innerLift, 0, 2.5);
    paperUniforms[1].floor.value = 0.25 * THREE.MathUtils.smoothstep(coverLift, 0, 2.5);
    u.stencil.value = state.comparison === "stencil" && treatment ? 1 : 0;
    u.newspaper.value = state.content === "dots" ? 0 : 1;
    imageUniforms.forEach((item, i) => {
      const texture = state.content === "newspaper" ? newspaper : duo[i];
      item.image.value = texture;
      const ratio = texture.image.width / texture.image.height;
      item.crop.value.set(
        Math.min(1, item.aspect / ratio),
        Math.min(1, ratio / item.aspect),
      );
    });
    u.flow.value = 0;
    // Hardware remains visible around the analytical screen overlay.
    originals.forEach((m, o) => {
      o.material = m;
    });
    screens.forEach((s, i) => {
      s.material = materials[i];
    });
    originals.forEach((_, o) => {
      if (!screens.includes(o as THREE.SkinnedMesh)) o.material = maskMaterial;
    });
    renderer.setRenderTarget(raw);
    renderer.setClearColor(0, 0);
    renderer.clear();
    renderer.render(scene, camera);
    if (captureOnly) return 0;
    renderer.autoClear = false;
    // Blur is rendered by the display shader itself (paper model), not by a
    // uniform screen-space post blur.
    uniforms.sigma.value = 0;
    if (uniforms.sigma.value > 0) {
      uniforms.axis.value.set(1, 0);
      pass(raw.texture, horizontal, 0);
      uniforms.axis.value.set(0, 1);
      pass(horizontal.texture, filtered, 0);
    } else pass(raw.texture, filtered, 3);
    if (state.comparison === "blur" && (state.map || measure)) {
      pass(filtered.texture, energy, 1);
    }
    renderer.autoClear = true;
    if (measure) {
      renderer.readRenderTargetPixels(
        state.comparison === "blur" ? energy : raw,
        0,
        0,
        size,
        size,
        pixels,
      );
      u.region.value = 1;
      renderer.setRenderTarget(region);
      renderer.clear();
      renderer.render(scene, camera);
      u.region.value = 0;
      renderer.readRenderTargetPixels(region, 0, 0, size, size, regionPixels);
      let sum = 0,
        count = 0;
      // Summed-area mask: identical 7×7 erosion with four lookups per pixel.
      const stride = size + 1;
      const invalid = new Uint32Array(stride * stride);
      for (let y = 0; y < size; y++) {
        let row = 0;
        for (let x = 0; x < size; x++) {
          const j = (y * size + x) * 4;
          row +=
            THREE.DataUtils.fromHalfFloat(regionPixels[j]) > 0.5 &&
            THREE.DataUtils.fromHalfFloat(regionPixels[j + 3]) > 0.99
              ? 0
              : 1;
          invalid[(y + 1) * stride + x + 1] = invalid[y * stride + x + 1] + row;
        }
      }
      for (let y = 3; y < size - 3; y++)
        for (let x = 3; x < size - 3; x++) {
          // Erode by 3 render pixels to exclude hinge, silhouette and occlusion edges.
          const left = x - 3,
            right = x + 4,
            top = y - 3,
            bottom = y + 4;
          if (
            invalid[bottom * stride + right] -
              invalid[top * stride + right] -
              invalid[bottom * stride + left] +
              invalid[top * stride + left] !==
            0
          )
            continue;
          const i = (y * size + x) * 4;
          if (THREE.DataUtils.fromHalfFloat(pixels[i + 3]) < 0.99) continue;
          sum += THREE.DataUtils.fromHalfFloat(pixels[i]);
          count++;
        }
      const value =
        count >= 64
          ? (sum / count) * (state.comparison === "stencil" ? 512 : 1)
          : NaN;
      if (state.comparison === "blur") {
        if (energyCache.size >= 512)
          energyCache.delete(energyCache.keys().next().value!);
        energyCache.set(energyKey, value);
      }
      return value;
    }
    // Re-render the visible image at display resolution; raw/energy/region stay
    // untouched so optical-flow captures and graph units remain reproducible.
    originals.forEach((m, o) => {
      o.material = m;
    });
    screens.forEach((s, i) => {
      s.material = materials[i];
    });
    renderer.setRenderTarget(null);
    renderer.setClearColor(0xececee, 1);
    renderer.clear();
    renderer.render(scene, camera);
    if (state.map && state.comparison === "blur") {
      renderer.autoClear = false;
      pass(energy.texture, null, 2);
    }
    renderer.autoClear = true;
    originals.forEach((_, o) => {
      if (!screens.includes(o)) o.material = maskMaterial;
    });
    return 0;
  }
  let grabPath: THREE.Vector2[] | null = null;
  let grabAngle = 0;
  const grabPointer = new THREE.Vector2();
  const grabDirection = new THREE.Vector2();
  let grabDegreesPerPixel = 1;
  return {
    draw,
    beginGrab(clientX: number, clientY: number, angle: number) {
      pose(angle);
      screens.forEach((s) => {
        if (s instanceof THREE.SkinnedMesh) {
          s.computeBoundingSphere();
          s.computeBoundingBox();
        } else {
          s.geometry.computeBoundingSphere();
          s.geometry.computeBoundingBox();
        }
      });
      const bounds = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      const probes = [[0, 0]];
      for (const radius of [8, 16, 24])
        for (let i = 0; i < 8; i++)
          probes.push([
            Math.cos((i * Math.PI) / 4) * radius,
            Math.sin((i * Math.PI) / 4) * radius,
          ]);
      for (const [dx, dy] of probes) {
        ray.setFromCamera(
          new THREE.Vector2(
            ((clientX + dx - bounds.left) / bounds.width) * 2 - 1,
            1 - ((clientY + dy - bounds.top) / bounds.height) * 2,
          ),
          camera,
        );
        for (const hit of ray.intersectObjects(screens, false)) {
          if (!hit.face) continue;
          const mesh = hit.object as THREE.Mesh;
          const { a, b, c } = hit.face;
          const va = new THREE.Vector3(),
            vb = new THREE.Vector3(),
            vc = new THREE.Vector3(),
            weights = new THREE.Vector3();
          mesh.getVertexPosition(a, va);
          mesh.getVertexPosition(b, vb);
          mesh.getVertexPosition(c, vc);
          new THREE.Triangle(va, vb, vc).getBarycoord(
            mesh.worldToLocal(hit.point.clone()),
            weights,
          );
          const path: THREE.Vector2[] = [];
          for (let theta = 0; theta <= 180; theta++) {
            pose(theta);
            mesh.getVertexPosition(a, va);
            mesh.getVertexPosition(b, vb);
            mesh.getVertexPosition(c, vc);
            const p = va
              .clone()
              .multiplyScalar(weights.x)
              .addScaledVector(vb, weights.y)
              .addScaledVector(vc, weights.z);
            mesh.localToWorld(p).project(camera);
            path.push(
              new THREE.Vector2(
                bounds.left + ((p.x + 1) * bounds.width) / 2,
                bounds.top + ((1 - p.y) * bounds.height) / 2,
              ),
            );
          }
          pose(angle);
          if (Math.max(...path.map((p) => p.distanceTo(path[0]))) < 8) continue;
          grabPath = path;
          grabAngle = angle;
          grabPointer.set(clientX, clientY);
          // The local projected tangent can flatten or reverse near the open
          // pose (perspective foreshortening). Keep one direction and gain for
          // the entire gesture instead of inverting that unstable derivative.
          grabDirection.copy(path[180]).sub(path[0]).normalize();
          grabDegreesPerPixel = 180 / Math.max(100, bounds.width * 0.45);
          return true;
        }
      }
      return false;
    },
    moveGrab(clientX: number, clientY: number) {
      if (!grabPath) return null;
      const delta = new THREE.Vector2(clientX, clientY).sub(grabPointer);
      grabPointer.set(clientX, clientY);
      grabAngle = THREE.MathUtils.clamp(
        grabAngle + delta.dot(grabDirection) * grabDegreesPerPixel,
        0,
        180,
      );
      return grabAngle;
    },
    endGrab() {
      grabPath = null;
    },
    dispose() {
      originals.forEach((m, o) => {
        o.geometry.dispose();
        for (const v of Array.isArray(m) ? m : [m]) v.dispose();
      });
      materials.forEach((m) => m.dispose());
      maskMaterial.dispose();
      raw.dispose();
      horizontal.dispose();
      newspaper.dispose();
      duo.forEach((t) => t.dispose());
      filtered.dispose();
      energy.dispose();
      region.dispose();
      quad.geometry.dispose();
      postMat.dispose();
      env.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      arrows.remove();
    },
  };
}
