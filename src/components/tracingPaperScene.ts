import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export type FoldSide = "left" | "right";

export type TracingPaperScene = {
  ready: Promise<void>;
  renderFold: (side: FoldSide, degrees: number) => void;
  setFold: (side: FoldSide, degrees: number) => void;
  setRaySpread: (amount: number) => void;
  setMoveView: (enabled: boolean) => void;
  resetTopView: () => void;
  dispose: () => void;
};

export function mountTracingPaperScene(
  stage: HTMLElement,
  imageUrl: string,
  onFoldChange?: (side: FoldSide, degrees: number) => void,
): TracingPaperScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.append(renderer.domElement);

  const scene = new THREE.Scene();
  // A subtle cool grey instead of pure white, shared by every lab scene.
  scene.background = new THREE.Color("#ececee");

  // Match Turner's 1200 × 782 source without cropping or stretching it.
  const screenWidth = 3.82;
  const screenHeight = (screenWidth * 782) / 1200;
  const paperWidth = screenWidth * 1.8;
  const paperHeight = screenHeight * 2.9;
  const halfPaperWidth = paperWidth / 2;

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  // Keep the image's top edge as screen-up; orbiting around the sheet normal
  // from overhead would otherwise look like rolling the camera in place.
  camera.up.set(0, 1, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enableRotate = false;
  controls.enablePan = false;
  controls.minDistance = 3.4;
  controls.maxDistance = 48;
  controls.rotateSpeed = 0.68;
  controls.zoomSpeed = 0.85;
  controls.minPolarAngle = THREE.MathUtils.degToRad(28);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(152);
  controls.minAzimuthAngle = THREE.MathUtils.degToRad(-82);
  controls.maxAzimuthAngle = THREE.MathUtils.degToRad(82);
  controls.screenSpacePanning = true;
  controls.target.set(0, 0, 0);

  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const screenTexture = new THREE.TextureLoader().load(imageUrl, () => resolveReady(),
    undefined, () => rejectReady(new Error(`Unable to load ${imageUrl}`)));
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  screenTexture.anisotropy = Math.min(
    renderer.capabilities.getMaxAnisotropy(),
    8,
  );
  const screenMaterial = new THREE.MeshBasicMaterial({
    map: screenTexture,
    side: THREE.DoubleSide,
  });
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(screenWidth, screenHeight),
    screenMaterial,
  );
  scene.add(screen);

  const paperUniforms = {
    uScreen: { value: screenTexture },
    uSize: { value: new THREE.Vector2(screenWidth, screenHeight) },
    uAngle: { value: 0 },
    uFoldSide: { value: 1 },
    uRaySpread: { value: 0.55 },
    // The tabletop around the image, as seen through the paper.
    uTable: { value: (scene.background as THREE.Color).clone() },
    // Grab hint: a faint dot grid printed on the sheet, lit by a passing wave.
    uPaperSize: { value: new THREE.Vector2(paperWidth, paperHeight) },
    uHint: { value: 0 },
    uHintTime: { value: 0 },
    uHintFocus: { value: new THREE.Vector2() },
    uHintGather: { value: 0 },
    uHintStatic: { value: 0 },
  };
  const paperMaterial = new THREE.ShaderMaterial({
    uniforms: paperUniforms,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormal;
      uniform float uAngle;
      uniform float uFoldSide;
      void main() {
        vUv=uv;
        vec3 p=position;
        // Mirroring about the center keeps the stationary half on the image,
        // whichever page is being turned. Both halves share one mesh column.
        const float foldHalfWidth=.42;
        float foldX=position.x*uFoldSide;
        float surfaceAngle=0.;
        if (uAngle<.0001 || foldX<=-foldHalfWidth) {
          p.z=0.;
        } else {
          float radius=2.*foldHalfWidth/uAngle;
          float t=clamp((foldX+foldHalfWidth)/(2.*foldHalfWidth),0.,1.);
          surfaceAngle=uAngle*t;
          float bentX=-foldHalfWidth+radius*sin(surfaceAngle);
          p.z=radius*(1.-cos(surfaceAngle));
          if (foldX>foldHalfWidth) {
            float freeLength=foldX-foldHalfWidth;
            bentX+=freeLength*cos(uAngle);
            p.z+=freeLength*sin(uAngle);
          }
          p.x=bentX*uFoldSide;
        }
        float edgeCurl=pow(clamp(foldX/${halfPaperWidth.toFixed(6)},0.,1.),5.)*sin(uAngle)*.045;
        p.x-=uFoldSide*sin(surfaceAngle)*edgeCurl;
        p.z+=cos(surfaceAngle)*edgeCurl;
        vec4 world=modelMatrix*vec4(p,1.);
        vWorld=world.xyz;
        vec3 paperNormal=vec3(-uFoldSide*sin(surfaceAngle),0.,cos(surfaceAngle));
        vNormal=normalize(mat3(modelMatrix)*paperNormal);
        gl_Position=projectionMatrix*viewMatrix*world;
      }`,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormal;
      uniform sampler2D uScreen;
      uniform vec2 uSize;
      uniform float uRaySpread;
      uniform vec3 uTable;
      uniform vec2 uPaperSize;
      uniform float uHint;
      uniform float uHintTime;
      uniform vec2 uHintFocus;
      uniform float uHintGather;
      uniform float uHintStatic;
      float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      float noise(vec2 p) {
        vec2 i=floor(p), f=fract(p);
        f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),
                   mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);
      }
      vec3 imageAt(vec2 point) {
        vec2 uv=point/uSize+.5;
        float inside=step(0.,uv.x)*step(uv.x,1.)*step(0.,uv.y)*step(uv.y,1.);
        vec4 pixel=texture2D(uScreen,clamp(uv,0.,1.));
        return mix(uTable,pixel.rgb,pixel.a*inside);
      }
      void main() {
        vec3 normal=normalize(vNormal);
        vec3 toEye=normalize(cameraPosition-vWorld);
        float facing=abs(dot(normal,toEye));
        float grazing=1.-facing;

        // The ray cone intersects the fixed z=0 image plane. Its footprint
        // grows with the local paper-to-image gap, not a uniform blur map.
        vec3 ray=-toEye;
        float gap=max(vWorld.z,0.);
        vec3 axisGuide=abs(ray.z)>.9?vec3(0.,1.,0.):vec3(0.,0.,1.);
        vec3 axisX=normalize(cross(axisGuide,ray));
        vec3 axisY=cross(ray,axisX);
        float scatter=uRaySpread*(.10+.16*grazing);
        float rotation=hash(floor(gl_FragCoord.xy))*6.2831853;
        vec2 directHit=vWorld.xy-ray.xy*gap/min(ray.z,-.025);
        vec3 sharp=imageAt(directHit);
        // Fade the cone in by its projected footprint. A hard gap threshold
        // makes an artificial vertical blur boundary next to the hinge.
        float footprint=gap*scatter/max(-ray.z,.025)*405./uSize.x;
        float blurBlend=smoothstep(.4,1.4,footprint);
        vec3 under=sharp;
        float samples=0.;
        if (blurBlend>.001) {
          vec3 blurred=vec3(0.);
          for (int i=0;i<32;i++) {
            float index=float(i)+.5;
            float radius=sqrt(index/32.);
            float azimuth=index*2.3999632+rotation;
            vec2 disc=radius*vec2(cos(azimuth),sin(azimuth));
            vec3 direction=ray+scatter*(axisX*disc.x+axisY*disc.y);
            if (direction.z<-.025) {
              vec2 hit=vWorld.xy-direction.xy*gap/direction.z;
              blurred+=imageAt(hit);
              samples+=1.;
            }
          }
          under=mix(sharp,blurred/max(samples,1.),blurBlend);
        }
        float fiber=noise(vUv*vec2(260.,185.))-.5;
        float fleck=hash(floor(vUv*vec2(980.,690.)))-.5;

        float opticalDepth=pow(1./max(facing,.17),1.45);
        float transmission=pow(clamp(.89+fiber*.03,0.,.97),opticalDepth);
        transmission*=gl_FrontFacing?1.:.12;
        vec3 paper=vec3(.91,.91,.895)+(fiber*.027+fleck*.009);
        vec3 color=mix(paper,under,transmission);
        vec3 litNormal=normal*(gl_FrontFacing?1.:-1.);
        color*=.87+.13*max(dot(litNormal,normalize(vec3(-.4,.6,1.))),0.);
        color+=pow(grazing,3.)*.07;
        if (uHint>.001) {
          // Dots live in the sheet's own coordinates, so they bend with it.
          vec2 local=(vUv-.5)*uPaperSize;
          const float spacing=.16;
          float dotDistance=length(fract(local/spacing)-.5)*spacing;
          float aa=max(fwidth(dotDistance),1e-4);
          float dotMask=1.-smoothstep(.011-aa,.011+aa,dotDistance);
          // Idle: a soft front travels outward from the spine, then rests.
          float cycle=mod(uHintTime,4.8);
          float front=cycle/2.6*3.0;
          float idle=exp(-pow((abs(local.x)-front)/.5,2.))*(1.-smoothstep(2.2,2.6,cycle));
          // Grabbed: the front contracts onto the grab point.
          float ring=length(local-uHintFocus)-mix(2.8,0.,uHintGather);
          float gather=exp(-pow(ring/.35,2.));
          float wave=mix(mix(idle,gather,step(.001,uHintGather)),.45,uHintStatic);
          float shimmer=.45+.55*noise(local*2.2+vec2(uHintTime*.35,0.));
          color+=vec3(dotMask*wave*shimmer*uHint*.55);
        }
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  // The center column is shared by both sides, so the hinge cannot expose a
  // rasterized gap between two independently drawn planes.
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(paperWidth, paperHeight, 192, 48),
    paperMaterial,
  );
  paper.position.z = 0.035;
  paper.renderOrder = 2;
  scene.add(paper);

  let targetAngle = 0;
  let currentAngle = 0;
  let activeSide: FoldSide = "right";
  let queuedFold: { side: FoldSide; angle: number } | null = null;
  let moveView = false;
  let drag: {
    pointerId: number;
    side: FoldSide;
    startX: number;
    startY: number;
    startAngle: number;
    directionX: number;
    directionY: number;
  } | null = null;
  const pointerRay = new THREE.Raycaster();
  const paperPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.035);
  const planeHit = new THREE.Vector3();
  const hingeProjected = new THREE.Vector3();
  const rightProjected = new THREE.Vector3();
  let lastFrameTime = performance.now();
  const HINT_KEY = "tracing-paper-fold-hint-done";
  const readHintDone = () => {
    try { return localStorage.getItem(HINT_KEY) === "1"; } catch { return false; }
  };
  let hintDone = readHintDone();
  let hintStart = performance.now() + 1200;
  let gatherStart: number | null = null;
  // Hovering the sheet replays the wave on demand, even after the one-time
  // hint has been retired.
  let hovering = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function finishHint() {
    if (hintDone) return;
    hintDone = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* storage unavailable */ }
  }
  let cameraMoved = false;
  let visible = true;
  let frame = 0;
  controls.addEventListener("start", () => {
    if (moveView) cameraMoved = true;
  });

  function requestFold(side: FoldSide, degrees: number) {
    const angle = THREE.MathUtils.clamp(degrees, 0, 175);
    if (side === activeSide) {
      queuedFold = null;
      targetAngle = angle;
    } else if (currentAngle < 0.5) {
      activeSide = side;
      paperUniforms.uFoldSide.value = side === "right" ? 1 : -1;
      queuedFold = null;
      targetAngle = angle;
    } else {
      queuedFold = { side, angle };
      targetAngle = 0;
    }
  }

  function pointerDown(event: PointerEvent) {
    if (moveView || !event.isPrimary || event.button !== 0) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    pointerRay.setFromCamera(new THREE.Vector2(x, y), camera);
    if (!pointerRay.ray.intersectPlane(paperPlane, planeHit)) return;
    if (
      Math.abs(planeHit.x) > halfPaperWidth ||
      Math.abs(planeHit.y) > paperHeight / 2
    ) return;
    const side: FoldSide = planeHit.x < 0 ? "left" : "right";
    if (!hintDone) {
      gatherStart = performance.now();
      paperUniforms.uHintFocus.value.set(planeHit.x, planeHit.y);
    }
    hingeProjected.set(0, 0, 0.035).project(camera);
    rightProjected.set(1, 0, 0.035).project(camera);
    const directionX = (rightProjected.x - hingeProjected.x) * bounds.width / 2;
    const directionY = -(rightProjected.y - hingeProjected.y) * bounds.height / 2;
    const length = Math.hypot(directionX, directionY) || 1;
    drag = {
      pointerId: event.pointerId,
      side,
      startX: event.clientX,
      startY: event.clientY,
      startAngle: side === activeSide && !queuedFold ? targetAngle : 0,
      directionX: directionX / length,
      directionY: directionY / length,
    };
    renderer.domElement.setPointerCapture(event.pointerId);
    renderer.domElement.style.cursor = "grabbing";
    event.preventDefault();
  }

  function paperHitAt(clientX: number, clientY: number) {
    const bounds = renderer.domElement.getBoundingClientRect();
    const x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
    pointerRay.setFromCamera(new THREE.Vector2(x, y), camera);
    return !!pointerRay.ray.intersectPlane(paperPlane, planeHit) &&
      Math.abs(planeHit.x) <= halfPaperWidth &&
      Math.abs(planeHit.y) <= paperHeight / 2;
  }

  function updateHover(event: PointerEvent) {
    const over = !drag && !moveView && event.pointerType === "mouse" &&
      paperHitAt(event.clientX, event.clientY);
    if (over && !hovering) {
      hintStart = performance.now();
      gatherStart = null;
      paperUniforms.uHintGather.value = 0;
    }
    hovering = over;
    if (!drag) renderer.domElement.style.cursor = over ? "grab" : "";
  }

  function pointerLeave() {
    hovering = false;
    if (!drag) renderer.domElement.style.cursor = "";
  }

  function pointerMove(event: PointerEvent) {
    if (!drag) updateHover(event);
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta =
      (event.clientX - drag.startX) * drag.directionX +
      (event.clientY - drag.startY) * drag.directionY;
    // A swipe toward the spine opens either page. The sheet remains rigid;
    // only its target hinge angle changes, with a short visual ease below.
    const sideSign = drag.side === "right" ? 1 : -1;
    const degrees = THREE.MathUtils.clamp(
      drag.startAngle - (delta * sideSign * 175) / Math.max(stage.clientWidth * 0.38, 180),
      0,
      175,
    );
    requestFold(drag.side, degrees);
    if (Math.abs(degrees - drag.startAngle) > 8) finishHint();
    onFoldChange?.(drag.side, Math.round(degrees));
    event.preventDefault();
  }

  function pointerEnd(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    renderer.domElement.style.cursor = hovering ? "grab" : "";
    // A grab without a fold: bring the hint back after a pause.
    if (!hintDone) {
      gatherStart = null;
      paperUniforms.uHintGather.value = 0;
      hintStart = performance.now() + 2500;
    }
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
  }

  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointermove", pointerMove);
  renderer.domElement.addEventListener("pointerup", pointerEnd);
  renderer.domElement.addEventListener("pointercancel", pointerEnd);
  renderer.domElement.addEventListener("pointerleave", pointerLeave);

  function fitDistance() {
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    // Frame the image and folding boundary, rather than the oversized sheet.
    // Leave room around the image for the lifted paper to remain legible.
    return Math.max(
      (screenHeight * 1.5) / (2 * Math.tan(halfFov)),
      (screenWidth * 1.5) / (2 * Math.tan(halfFov) * camera.aspect),
    );
  }
  function resetTopView() {
    cameraMoved = false;
    const wasDamping = controls.enableDamping;
    controls.enableDamping = false;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 0, fitDistance());
    controls.update();
    controls.enableDamping = wasDamping;
  }
  function resize() {
    const width = Math.max(stage.clientWidth, 1);
    const height = Math.max(stage.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    if (!cameraMoved) resetTopView();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  resize();

  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  });
  visibilityObserver.observe(stage);

  function updateHint(now: number, elapsed: number) {
    let target = ((hovering && !drag) || !hintDone) && !moveView && now >= hintStart ? 1 : 0;
    if (gatherStart !== null) {
      const gather = Math.min((now - gatherStart) / 650, 1);
      paperUniforms.uHintGather.value = gather;
      if (gather >= 1) target = 0;
    }
    const hint = paperUniforms.uHint;
    hint.value += (target - hint.value) * (1 - Math.exp(-elapsed / 0.35));
    if (hint.value < 0.002) hint.value = target === 0 ? 0 : hint.value;
    paperUniforms.uHintStatic.value = reducedMotion.matches ? 1 : 0;
    if (!reducedMotion.matches) paperUniforms.uHintTime.value = Math.max(0, (now - hintStart) / 1000);
  }

  function render() {
    frame = requestAnimationFrame(render);
    if (!visible || document.hidden) return;
    const now = performance.now();
    const elapsed = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;
    const ease = 1 - Math.exp(-elapsed / (drag ? 0.075 : 0.13));
    currentAngle += (targetAngle - currentAngle) * ease;
    if (Math.abs(currentAngle - targetAngle) < 0.02) currentAngle = targetAngle;
    if (queuedFold && currentAngle < 0.5) {
      activeSide = queuedFold.side;
      paperUniforms.uFoldSide.value = activeSide === "right" ? 1 : -1;
      targetAngle = queuedFold.angle;
      currentAngle = 0;
      queuedFold = null;
    }
    const radians = THREE.MathUtils.degToRad(currentAngle);
    paperUniforms.uAngle.value = radians;
    updateHint(now, elapsed);
    controls.update();
    // Screen-space panning is intuitive overhead; project its target back
    // onto the XY tabletop when the view becomes oblique.
    if (Math.abs(controls.target.z) > 1e-6) {
      camera.position.z -= controls.target.z;
      controls.target.z = 0;
    }
    renderer.render(scene, camera);
  }
  render();

  return {
    ready,
    renderFold(side, degrees) {
      // Deterministic export: bypass only pointer smoothing, not the shader.
      activeSide = side;
      queuedFold = null;
      currentAngle = targetAngle = THREE.MathUtils.clamp(degrees, 0, 180);
      paperUniforms.uFoldSide.value = side === "right" ? 1 : -1;
      paperUniforms.uAngle.value = THREE.MathUtils.degToRad(currentAngle);
      const hint = paperUniforms.uHint.value;
      paperUniforms.uHint.value = 0;
      renderer.render(scene, camera);
      paperUniforms.uHint.value = hint;
    },
    setFold: requestFold,
    setRaySpread(amount) {
      paperUniforms.uRaySpread.value = THREE.MathUtils.clamp(amount, 0, 1);
    },
    setMoveView(enabled) {
      moveView = enabled;
      controls.enableRotate = enabled;
      controls.enablePan = enabled;
      if (enabled) drag = null;
    },
    resetTopView,
    dispose() {
      cancelAnimationFrame(frame);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointermove", pointerMove);
      renderer.domElement.removeEventListener("pointerup", pointerEnd);
      renderer.domElement.removeEventListener("pointercancel", pointerEnd);
      renderer.domElement.removeEventListener("pointerleave", pointerLeave);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      controls.dispose();
      screen.geometry.dispose();
      screenMaterial.dispose();
      paper.geometry.dispose();
      paperMaterial.dispose();
      screenTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
