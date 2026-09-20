import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
const screenImageUrl = `${import.meta.env.BASE_URL}assets/tracing-paper/iphone-duo-clean-background.jpeg`;
const foldedScreenImageUrl = `${import.meta.env.BASE_URL}assets/tracing-paper/iphone-duo-folded-cover.png`;
import {
  mountCoordinatedPaperScene,
  SEQUENCE_DURATION,
  stateAtTime,
  type CoordinatedPaperScene,
  type ScreenSurface,
} from "./coordinatedDisplayScene";
import "./CoordinatedPaperOpening.css";

const steps = [
  { number: 1, surface: "raw-mesh", label: "Raw mesh", triangles: true },
  { number: 2, surface: "screen-triangles", label: "Screen triangles", triangles: true },
  { number: 3, surface: "solid-mask", label: "Solid-color mask", triangles: false },
  { number: 4, surface: "background", label: "Image background", triangles: false },
  { number: 5, surface: "plane-outlines", label: "Image-plane outlines", triangles: false },
  { number: 6, surface: "mask-composite", label: "Mask + background", triangles: false },
  { number: 7, surface: "matte-paper", label: "Matte paper", triangles: false },
  { number: 8, surface: "edge-darkening", label: "Edge darkening", triangles: false },
] as const;

const DEFAULT_BLUR_INTENSITY = 1.6;
const DEFAULT_TRANSITION_LENGTH = 0.75;
const DEFAULT_EDGE_DARKENING = 1;

type CoordinatedPaperOpeningProps = {
  standalone?: boolean;
};

export default function CoordinatedPaperOpening({
  standalone = false,
}: CoordinatedPaperOpeningProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CoordinatedPaperScene | null>(null);
  const timeRef = useRef(0);
  const foldDrag = useRef<{ id: number; time: number; grabbed: boolean; direction: number; lastMotion: number } | null>(null);
  const foldFrame = useRef(0);
  const [time, setTime] = useState(0);
  const [foldDestination, setFoldDestination] = useState<boolean | null>(null);
  const [error, setError] = useState(false);
  const [surface, setSurface] = useState<ScreenSurface>("edge-darkening");
  const [triangles, setTriangles] = useState(false);
  const [moveView, setMoveView] = useState(true);
  const [scattering, setScattering] = useState(DEFAULT_BLUR_INTENSITY);
  const [darkening, setDarkening] = useState(DEFAULT_EDGE_DARKENING);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorId = useId();
  const inspectButtonRef = useRef<HTMLButtonElement>(null);
  const state = stateAtTime(time);
  const openOnClick = foldDestination === null
    ? 90 + state.leftAngle - state.rightAngle >= 90
    : !foldDestination;

  useEffect(() => {
    if (!stageRef.current) return;
    try {
      sceneRef.current = mountCoordinatedPaperScene(
        stageRef.current,
        screenImageUrl,
        foldedScreenImageUrl,
      );
      sceneRef.current.setBlurIntensity(DEFAULT_BLUR_INTENSITY);
      sceneRef.current.setTransitionLength(DEFAULT_TRANSITION_LENGTH);
      sceneRef.current.setEdgeDarkening(DEFAULT_EDGE_DARKENING);
      sceneRef.current.inspectSurface(surface, triangles);
      sceneRef.current.setMoveView(moveView);
    } catch {
      setError(true);
    }
    return () => {
      cancelAnimationFrame(foldFrame.current);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);


  function showTime(nextTime: number) {
    const clamped = Math.min(SEQUENCE_DURATION, Math.max(0, nextTime));
    timeRef.current = clamped;
    setTime(clamped);
    sceneRef.current?.setTime(clamped);
  }

  function stop() {
    cancelAnimationFrame(foldFrame.current);
    setFoldDestination(null);
  }

  function foldStart(event: PointerEvent<HTMLDivElement>) {
    if (foldDrag.current) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    const scene = sceneRef.current;
    if (!scene?.hitsPhoneSilhouette(event.clientX, event.clientY)) return;
    const grabbed = event.button === 0 && scene.beginGrab(event.clientX, event.clientY);
    stop();
    cancelAnimationFrame(foldFrame.current);
    foldDrag.current = { id: event.pointerId, time: timeRef.current, grabbed, direction: 0, lastMotion: 0 };
    scene.setOrbitEnabled(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.style.cursor = grabbed ? "grabbing" : "default";
  }

  function foldMove(event: PointerEvent<HTMLDivElement>) {
    const drag = foldDrag.current;
    if (!drag || drag.id !== event.pointerId) return;
    const next = sceneRef.current?.moveGrab(event.clientX, event.clientY);
    if (next != null) {
      const delta = next - timeRef.current;
      if (Math.abs(delta) > 0.002) {
        drag.direction = Math.sign(delta);
        drag.lastMotion = performance.now();
      }
      showTime(next);
    }
    event.stopPropagation();
  }

  function foldEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = foldDrag.current;
    if (drag?.id !== event.pointerId) return;
    foldDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    sceneRef.current?.endGrab();
    event.currentTarget.style.cursor = "";
    event.stopPropagation();
    if (event.type === "pointerup" && drag.grabbed && Math.abs(timeRef.current - drag.time) > 0.005) {
      const pose = stateAtTime(timeRef.current);
      const angle = 90 + pose.leftAngle - pose.rightAngle;
      // Only assist the last few degrees. Mid-fold release must retain the
      // pose so the user can re-grab and reverse freely.
      if (angle <= 10) settleFold(true);
      else if (angle >= 170) settleFold(false);
    }
  }

  function settleFold(open: boolean) {
    cancelAnimationFrame(foldFrame.current);
    setFoldDestination(open);
    const pose = stateAtTime(timeRef.current);
    const from = 90 + pose.leftAngle - pose.rightAngle;
    const to = open ? 0 : 180;
    const duration = 1600 + 800 * Math.abs(to - from) / 180;
    const started = performance.now();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animate = (now: number) => {
      const progress = reducedMotion ? 1 : Math.min(1, (now - started) / duration);
      // Ease the actual hinge angle, not the already-eased playback timeline.
      // Keep a gentle launch, but give the landing a longer, quintic slowdown.
      // This asymmetric curve reaches zero velocity without bounce or overshoot.
      const remaining = 1 - progress;
      const eased = 1 - remaining ** 5 * (1 + 5 * progress + 15 * progress * progress);
      const angle = from + (to - from) * eased;
      let low = 0, high = SEQUENCE_DURATION;
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        const sample = stateAtTime(mid);
        if (90 + sample.leftAngle - sample.rightAngle > angle) low = mid;
        else high = mid;
      }
      showTime(progress === 1 ? (open ? SEQUENCE_DURATION : 0) : (low + high) / 2);
      if (progress < 1) foldFrame.current = requestAnimationFrame(animate);
      else setFoldDestination(null);
    };
    foldFrame.current = requestAnimationFrame(animate);
  }

  function inspect(nextSurface: ScreenSurface, nextTriangles: boolean) {
    if (nextSurface === "plane-outlines" && !moveView) {
      setMoveView(true);
      sceneRef.current?.setMoveView(true);
    }
    setSurface(nextSurface);
    setTriangles(nextTriangles);
    sceneRef.current?.inspectSurface(nextSurface, nextTriangles);
  }

  function updateMoveView(enabled: boolean) {
    setMoveView(enabled);
    sceneRef.current?.setMoveView(enabled);
  }

  function showFrontView() {
    updateMoveView(false);
    sceneRef.current?.resetView();
  }

  return (
    <figure className={`tp-opening${standalone ? " tp-opening--standalone" : ""}${inspectorOpen ? " tp-opening--inspecting" : ""}`} aria-label="iPhone Duo transition">
      <div className={`tp-opening__stage${moveView ? " tp-opening__stage--view" : ""}`} ref={stageRef}
        onPointerDownCapture={foldStart} onPointerMoveCapture={foldMove}
        onPointerUpCapture={foldEnd} onPointerCancelCapture={foldEnd} onLostPointerCapture={foldEnd}
        tabIndex={0} aria-label="Grab the moving screen and drag it around its hinge. Drag background to orbit. Arrow keys adjust fold."
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); stop(); cancelAnimationFrame(foldFrame.current);
          showTime(event.key === "Home" ? 0 : event.key === "End" ? SEQUENCE_DURATION : timeRef.current + (event.key === "ArrowRight" ? 0.1 : -0.1));
        }}>
        {error && <span className="tp-opening__error" role="alert">3D preview unavailable on this device.</span>}
      </div>
      <div className="tp-opening__transport">
        <button type="button" onClick={() => settleFold(openOnClick)} disabled={error}
          aria-label={openOnClick ? "Open phone" : "Close phone"}>
          {openOnClick ? "Open" : "Close"}
        </button>
      <div className="tp-opening__view-controls" role="group" aria-label="View controls">
        <button type="button" aria-pressed={!moveView}
          onClick={showFrontView} disabled={error}>
          Front
        </button>
        <button type="button" aria-pressed={moveView}
          onClick={() => updateMoveView(true)} disabled={error}>
          Orbit
        </button>
      </div>
        <button ref={inspectButtonRef} type="button" aria-expanded={inspectorOpen} aria-controls={inspectorId}
          onClick={() => setInspectorOpen(!inspectorOpen)}>Inspect</button>
        <span className="tp-opening__gesture-hint">Drag phone to fold · drag background to orbit</span>
      </div>
      <aside id={inspectorId} className="tp-opening__inspector" aria-hidden={!inspectorOpen}
        ref={(element) => element?.toggleAttribute("inert", !inspectorOpen)} aria-label="Rendering inspector"
        onKeyDown={(event) => { if (event.key === "Escape") { setInspectorOpen(false); inspectButtonRef.current?.focus(); } }}>
      <div className="tp-opening__inspector-content">
      <div className="tp-opening__inspector-heading">Inspect</div>
      <div className="tp-opening__step-tools">
        <div className="tp-opening__steps" role="group" aria-label="Visualization controls">
          {steps.map((step) => (
            <button key={step.number} type="button" aria-pressed={surface === step.surface}
              aria-label={step.label}
              title={step.label}
              onClick={() => inspect(step.surface, step.triangles)} disabled={error}>
              {step.label}
            </button>
          ))}
        </div>
      </div>
      <section className="tp-opening__adjust" aria-label="Adjust effects">
      <div className="tp-opening__adjust-heading"><span>Effects</span>
        <button type="button" className="tp-opening__reset" disabled={error || (scattering === DEFAULT_BLUR_INTENSITY && darkening === DEFAULT_EDGE_DARKENING)}
          onClick={() => {
            setScattering(DEFAULT_BLUR_INTENSITY); setDarkening(DEFAULT_EDGE_DARKENING);
            sceneRef.current?.setBlurIntensity(DEFAULT_BLUR_INTENSITY);
            sceneRef.current?.setEdgeDarkening(DEFAULT_EDGE_DARKENING);
          }}>Reset</button>
      </div>
      <div className="tp-opening__effects" role="group" aria-label="Paper effects">
        <label>
          <span>Scattering strength <output>{Math.round(scattering * 100)}%</output></span>
          <input type="range" min="0" max="10" step="0.05" value={scattering}
            aria-label="Scattering strength" aria-valuetext={`${Math.round(scattering * 100)} percent`}
            disabled={error} onChange={(event) => {
              const value = Number(event.target.value);
              setScattering(value);
              sceneRef.current?.setBlurIntensity(value);
            }} />
          <small>Sharp <span>Diffuse</span></small>
        </label>
        <label title="Artistic shading on the moving interior screen">
          <span>Edge darkening <output>{Math.round(darkening * 100)}%</output></span>
          <input type="range" min="0" max="4.5" step="0.05" value={darkening}
            aria-label="Edge darkening" aria-valuetext={`${Math.round(darkening * 100)} percent`}
            disabled={error} onChange={(event) => {
              const value = Number(event.target.value);
              setDarkening(value);
              sceneRef.current?.setEdgeDarkening(value);
            }} />
          <small>None <span>Strong</span></small>
        </label>
      </div>
      </section>
      </div>
      </aside>
    </figure>
  );
}
