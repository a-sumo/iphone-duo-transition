import { useEffect, useRef, useState, type CSSProperties } from "react";
const lakeOfZugImageUrl = `${import.meta.env.BASE_URL}assets/tracing-paper/lake-of-zug-turner-1843.jpeg`;
import {
  mountTracingPaperScene,
  type TracingPaperScene,
} from "./tracingPaperScene";
import "./labControls.css";
import "./TracingPaperSimulation.css";

type TracingPaperSimulationProps = {
  standalone?: boolean;
};

export default function TracingPaperSimulation({
  standalone = false,
}: TracingPaperSimulationProps) {
  const figureRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<TracingPaperScene | null>(null);
  const [moveView, setMoveView] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [raySpread, setRaySpread] = useState(55);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!stageRef.current) return;
    try {
      sceneRef.current = mountTracingPaperScene(
        stageRef.current,
        lakeOfZugImageUrl,
      );
    } catch {
      setError(true);
    }
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const syncFullscreen = () => {
      setFullscreen(document.fullscreenElement === figureRef.current);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  function updateMoveView(enabled: boolean) {
    setMoveView(enabled);
    sceneRef.current?.setMoveView(enabled);
  }

  function updateRaySpread(value: number) {
    setRaySpread(value);
    sceneRef.current?.setRaySpread(value / 100);
  }

  async function toggleFullscreen() {
    if (!figureRef.current) return;
    if (document.fullscreenElement === figureRef.current) {
      await document.exitFullscreen();
    } else {
      await figureRef.current.requestFullscreen();
    }
  }

  return (
    <figure
      ref={figureRef}
      className={`tp-sim${standalone ? " tp-sim--standalone" : ""}`}
      aria-label="Interactive tracing-paper simulation"
    >
      <div
        ref={stageRef}
        className={`tp-sim-stage ${moveView ? "tp-sim-stage--view" : "tp-sim-stage--fold"}`}
        aria-label="Three-dimensional hinged tracing paper over a fixed image"
      >
        {error && (
          <div className="tp-sim-error" role="alert">
            3D preview unavailable on this device.
          </div>
        )}
      </div>
      <figcaption className="tp-sim-artwork">
        <cite>The Lake of Zug</cite>
        <strong>Joseph Mallord William Turner</strong>
        <span>1843</span>
      </figcaption>
      <div className="tp-sim-controls">
        <label className="lab-field">
          <span>Ray spread</span>
          <input
            type="range"
            min="0"
            max="100"
            value={raySpread}
            onChange={(event) => updateRaySpread(Number(event.target.value))}
            aria-label="Paper scattering ray spread"
          />
          <output>{raySpread}%</output>
        </label>
        <div
          className="lab-seg"
          role="group"
          aria-label="Drag mode"
          style={{ "--seg-count": 2, "--seg-index": moveView ? 1 : 0 } as CSSProperties}
        >
          <span className="lab-seg__thumb" aria-hidden="true" />
          <button type="button" aria-pressed={!moveView} onClick={() => updateMoveView(false)}>
            Fold
          </button>
          <button type="button" aria-pressed={moveView} onClick={() => updateMoveView(true)}>
            Move view
          </button>
        </div>
        <button
          className="lab-btn lab-btn--secondary"
          type="button"
          onClick={() => sceneRef.current?.resetTopView()}
          aria-label="Reset to top-down view"
        >
          Top view
        </button>
        {!standalone && (
          <button
            className="lab-btn lab-btn--secondary"
            type="button"
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
        )}
      </div>
    </figure>
  );
}
