import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type KeyboardEvent,
  type CSSProperties,
} from "react";
import {
  mountPhoneExperiment,
  type ExperimentState,
} from "./phonePerceptionScene";
import "./labControls.css";
import "./PhonePerceptionExperiment.css";

export default function PhonePerceptionExperiment() {
  const playbackFrame = useRef(0);
  const playbackActive = useRef(false);
  const drag = useRef<{ id: number; index: number } | null>(null);
  const left = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null);
  const viewers = useRef<Awaited<ReturnType<typeof mountPhoneExperiment>>[]>(
    [],
  );
  const [comparison, setComparison] = useState<"blur" | "stencil">("blur");
  // Which side of the comparison is shown alone (0 = without, 1 = with).
  const [solo, setSolo] = useState<0 | 1 | null>(null);
  const [content, setContent] = useState<ExperimentState["content"]>("duo");
  const [samples, setSamples] = useState<{ phase: number; values: number[] }[]>(
    [],
  );
  const [sampling, setSampling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [, refreshScrubPhase] = useState(0);
  // Scattering intensity of the transition's paper model (same default).
  const [blur, setBlur] = useState(2.6);
  const [map, setMap] = useState(false),
    [angle, setAngle] = useState(45),
    [playing, setPlaying] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const direction = useRef(1),
    current = useRef<ExperimentState>({
      comparison,
      map,
      angle,
      direction: 1,
      content,
      blur,
      overlayOpacity: 1,
      playing,
      dragging,
    });
  current.current = {
    comparison,
    map,
    angle,
    direction: direction.current,
    content,
    blur,
    overlayOpacity: 1,
    playing,
    dragging,
  };
  // Optional deep-link state, e.g. ?view=flow&solo=without&fold=50
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    if (view === "energy" || view === "flow") {
      setComparison(view === "flow" ? "stencil" : "blur");
      setMap(true);
    } else if (params.get("effect") === "stencil") setComparison("stencil");
    const side = params.get("solo");
    if (side === "without" || side === "with") setSolo(side === "with" ? 1 : 0);
    const fold = Number(params.get("fold"));
    if (params.has("fold") && Number.isFinite(fold))
      setAngle(Math.max(0, Math.min(180, fold)));
  }, []);
  // ?capture=solo|full: frame-by-frame video export. The exporter sets the
  // view, content and exact fold angle, and waits for sampling to settle.
  const capture = useRef<Record<string, (...args: never[]) => unknown>>({});
  capture.current = {
    ready: () => ready && !sampling,
    set: ((options: {
      view?: "image" | "energy" | "flow";
      comparison?: "blur" | "stencil";
      content?: ExperimentState["content"];
      solo?: 0 | 1 | null;
    }) => {
      if (options.view) {
        setMap(options.view !== "image");
        if (options.view !== "image") setComparison(options.view === "flow" ? "stencil" : "blur");
      }
      if (options.comparison) setComparison(options.comparison);
      if (options.content) setContent(options.content);
      if (options.solo !== undefined) setSolo(options.solo);
    }) as never,
    setAngle: ((next: number, dir: number) => {
      direction.current = dir >= 0 ? 1 : -1;
      current.current.angle = next;
      current.current.direction = direction.current;
      setAngle(next);
    }) as never,
  };
  useEffect(() => {
    const layout = new URLSearchParams(window.location.search).get("capture");
    if (layout === null) return;
    document.documentElement.classList.add("perception-capture", `perception-capture--${layout || "full"}`);
    (window as unknown as { __perceptionCapture: typeof capture }).__perceptionCapture = capture;
  }, []);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    const made: typeof viewers.current = [];
    // ?capture=solo&hero: banner renders (see mountPhoneExperiment).
    const hero = new URLSearchParams(window.location.search).has("hero");
    Promise.all(
      [
        mountPhoneExperiment(left.current!, false, { hero }),
        mountPhoneExperiment(right.current!, true, { hero }),
      ].map((p) =>
        p.then((v) => {
          if (cancelled) v.dispose();
          else made.push(v);
          return v;
        }),
      ),
    )
      .then((v) => {
        if (cancelled) return;
        viewers.current = v;
        setReady(true);
        v.forEach((s) => s.draw(current.current));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      made.forEach((v) => v.dispose());
      viewers.current = [];
    };
  }, []);
  useEffect(() => {
    viewers.current.forEach((v) => v.draw(current.current));
  }, [angle, comparison, map, content, blur, playing, dragging]);
  useEffect(() => {
    if (!ready || viewers.current.length !== 2) return;
    let cancelled = false,
      frame = 0,
      index = 0;
    const result: { phase: number; values: number[] }[] = [];
    setSamples([]);
    setSampling(true);
    setPlaying(false);
    const sample = () => {
      if (cancelled) return;
      if (drag.current) {
        frame = requestAnimationFrame(sample);
        return;
      }
      const phase = index * 6;
      const sampleAngle = phase <= 180 ? phase : 360 - phase;
      const state = {
        ...current.current,
        playing: false,
        dragging: false,
        angle: sampleAngle,
        direction: phase < 180 || phase === 360 ? 1 : -1,
      };
      const values = viewers.current.map((v) => v.draw(state, true));
      result.push({ phase, values });
      if (++index <= 60) frame = requestAnimationFrame(sample);
      else {
        viewers.current.forEach((v) => v.draw(current.current));
        setSamples(result);
        setSampling(false);
      }
    };
    frame = requestAnimationFrame(sample);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [ready, content, comparison, blur]);
  useEffect(() => {
    if (!playing) return;
    playbackActive.current = true;
    const initial = Math.asin(
      Math.sqrt(Math.max(0, Math.min(180, current.current.angle)) / 180),
    );
    const phaseStart =
      current.current.angle < 0.01
        ? 0
        : direction.current < 0
          ? Math.PI - initial
          : initial;
    let start = 0;
    const run = (now: number) => {
      if (!playbackActive.current || drag.current) return;
      if (!start) start = now;
      const phase = Math.min(
        Math.PI,
        phaseStart + ((now - start) / 10000) * Math.PI,
      );
      direction.current = phase < Math.PI / 2 ? 1 : -1;
      const next = phase === Math.PI ? 0 : 180 * Math.sin(phase) ** 2;
      current.current.angle = next;
      setAngle(next);
      if (phase < Math.PI) playbackFrame.current = requestAnimationFrame(run);
      else setPlaying(false);
    };
    playbackFrame.current = requestAnimationFrame(run);
    return () => {
      playbackActive.current = false;
      cancelAnimationFrame(playbackFrame.current);
    };
  }, [playing]);
  const stopPlayback = () => {
    playbackActive.current = false;
    cancelAnimationFrame(playbackFrame.current);
    current.current.playing = false;
    setPlaying(false);
  };
  const changeFold = (next: number) => {
    stopPlayback();
    if (Math.abs(next - current.current.angle) > 0.001)
      direction.current = next > current.current.angle ? 1 : -1;
    current.current.angle = next;
    setAngle(next);
  };
  const dragProps = (index: number) => ({
    tabIndex: 0,
    role: "group",
    "aria-label": "Drag the moving screen to fold. Arrow keys adjust fold.",
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 || drag.current) return;
      // Interrupt before picking: near-edge misses must not leave playback running.
      stopPlayback();
      if (
        !viewers.current[index]?.beginGrab(
          e.clientX,
          e.clientY,
          current.current.angle,
        )
      )
        return;
      e.preventDefault();
      drag.current = { id: e.pointerId, index };
      current.current.dragging = true;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== e.pointerId || drag.current.index !== index)
        return;
      const next = viewers.current[index]?.moveGrab(e.clientX, e.clientY);
      if (next != null) changeFold(next);
    },
    onLostPointerCapture: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== e.pointerId || drag.current.index !== index)
        return;
      viewers.current[index]?.endGrab();
      drag.current = null;
      current.current.dragging = false;
      setDragging(false);
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== e.pointerId || drag.current.index !== index)
        return;
      viewers.current[index]?.endGrab();
      drag.current = null;
      current.current.dragging = false;
      setDragging(false);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      changeFold(
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? 180
            : Math.max(
                0,
                Math.min(
                  180,
                  current.current.angle + (e.key === "ArrowRight" ? 2 : -2),
                ),
              ),
      );
    },
  });
  return (
    <div className="phone-study">
      <div className="phone-study-controls">
        <div
          className="lab-seg"
          role="group"
          aria-label="View"
          style={{ "--seg-count": 3, "--seg-index": !map ? 0 : comparison === "blur" ? 1 : 2 } as CSSProperties}
        >
          <span className="lab-seg__thumb" aria-hidden="true" />
          <button type="button" aria-pressed={!map} onClick={() => setMap(false)}>
            Image
          </button>
          <button
            type="button"
            aria-pressed={map && comparison === "blur"}
            onClick={() => {
              setComparison("blur");
              setMap(true);
            }}
          >
            Energy
          </button>
          <button
            type="button"
            aria-pressed={map && comparison === "stencil"}
            onClick={() => {
              setComparison("stencil");
              setMap(true);
            }}
          >
            Optical flow
          </button>
        </div>
        {!map && (
          <div
            className="lab-seg"
            role="group"
            aria-label="Compare effect"
            style={{ "--seg-count": 2, "--seg-index": comparison === "blur" ? 0 : 1 } as CSSProperties}
          >
            <span className="lab-seg__thumb" aria-hidden="true" />
            <button
              type="button"
              aria-pressed={comparison === "blur"}
              onClick={() => {
                setComparison("blur");
                setMap(false);
              }}
            >
              Blur
            </button>
            <button
              type="button"
              aria-pressed={comparison === "stencil"}
              onClick={() => {
                setComparison("stencil");
                setMap(false);
              }}
            >
              Stenciling
            </button>
          </div>
        )}
        <label className="phone-study-content">
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <rect x="2.5" y="3" width="15" height="14" rx="3" />
            <circle cx="7" cy="7.5" r="1.3" />
            <path d="m3 14 4-4 3 3 3-4 4 5" />
          </svg>
          <select
            className="lab-select"
            aria-label="Screen content"
            value={content}
            onChange={(e) =>
              setContent(e.target.value as ExperimentState["content"])
            }
          >
            <option value="duo">iPhone Duo</option>
            <option value="newspaper">Newspaper</option>
            <option value="dots">Dot grid</option>
          </select>
          <svg
            className="phone-study-chevron"
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m6 8 4 4 4-4" />
          </svg>
        </label>
      </div>
      <div className="phone-study-controls phone-study-transport">
        <button
          type="button"
          className="lab-btn lab-btn--primary"
          disabled={!ready || !!error || sampling}
          onClick={() => {
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
              setAngle(angle < 90 ? 180 : 0);
              return;
            }
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Fold / unfold"}
        </button>
        <span className="phone-study-fold">
          Fold <output>{angle.toFixed(0)}°</output>
        </span>
        {comparison === "blur" && (
          <label className="lab-field phone-study-blur">
            Scattering <output>{Math.round(blur * 100)}%</output>
            <input
              aria-label="Scattering strength"
              type="range"
              min="0"
              max="6"
              step="0.1"
              value={blur}
              onChange={(e) => setBlur(Number(e.target.value))}
            />
          </label>
        )}
      </div>
      {error ? (
        <p role="alert">Preview failed: {error}</p>
      ) : !ready ? (
        <LoadingStatus>Loading phone…</LoadingStatus>
      ) : null}
      <div className={`phone-study-pair${solo === null ? "" : " is-solo"}`}>
        {(
          [
            [0, "baseline", left, comparison === "blur" ? "Without blur" : "Without stenciling"],
            [1, "treatment", right, comparison === "blur" ? "With blur" : "With stenciling"],
          ] as const
        ).map(([index, tone, ref, label]) => (
          <section key={tone} hidden={solo !== null && solo !== index}>
            <h2 className={`phone-study-label ${tone}`}>
              <button
                type="button"
                aria-pressed={solo === index}
                title={solo === index ? "Show both views" : "Show this view alone"}
                onClick={() => setSolo(solo === index ? null : index)}
              >
                {label}
                <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  {solo === index ? (
                    <path d="M1.5 4.5h5v7h-5zM9.5 4.5h5v7h-5z" />
                  ) : (
                    <path d="M3 3h10v10H3z" />
                  )}
                </svg>
              </button>
            </h2>
            <div ref={ref} {...dragProps(index)} />
          </section>
        ))}
      </div>
      {map && comparison === "blur" && (
        <div className="phone-study-key" aria-label="Energy scale: low to high">
          Low <span className="phone-study-energy" /> High
        </div>
      )}
      <MetricGraph
        samples={samples}
        sampling={sampling}
        comparison={comparison}
        phase={direction.current >= 0 ? angle : 360 - angle}
        onScrub={(phase) => {
          changeFold(phase <= 180 ? phase : 360 - phase);
          current.current.direction = direction.current;
          // Opposite halves of the cycle can share the same fold angle.
          refreshScrubPhase((version) => version + 1);
        }}
        onScrubbingChange={(active) => {
          stopPlayback();
          current.current.dragging = active;
          setDragging(active);
        }}
      />
      {content === "newspaper" && (
        <div className="phone-study-source">
          <a
            href="https://www.fubiz.net/wp-content/uploads/2017/06/tomaselli7.jpg"
            target="_blank"
            rel="noreferrer"
          >
            Newspaper artwork reference · Fubiz
          </a>
        </div>
      )}
      <details>
        <summary>
          Methods &amp; notes
          <svg
            className="phone-study-disclosure"
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 9h10" />
            <path className="phone-study-disclosure-vertical" d="M9 4v10" />
          </svg>
        </summary>
        <MeasurementNotes />
      </details>
    </div>
  );
}

function LoadingStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="phone-study-loading" role="status">
      <span className="phone-study-spinner" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

function MetricGraph({
  samples,
  sampling,
  comparison,
  phase,
  onScrub,
  onScrubbingChange,
}: {
  samples: { phase: number; values: number[] }[];
  sampling: boolean;
  comparison: "blur" | "stencil";
  phase: number;
  onScrub: (phase: number) => void;
  onScrubbingChange: (active: boolean) => void;
}) {
  const scrubPointer = useRef<number | null>(null);
  const chartRef = useRef<HTMLElement>(null);
  const [chartSize, setChartSize] = useState({ width: 800, height: 228 });
  useEffect(() => {
    if (window.self !== window.top || !chartRef.current) return;
    const resize = () =>
      setChartSize({
        width: Math.max(360, chartRef.current!.clientWidth),
        // Video export keeps the graph compact so the phones can be larger.
        height: document.documentElement.classList.contains("perception-capture")
          ? 170
          : Math.max(250, Math.min(440, window.innerHeight * 0.38)),
      });
    const observer = new ResizeObserver(resize);
    observer.observe(chartRef.current);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);
  const plotWidth = chartSize.width - 120;
  const plotBottom = chartSize.height - 52;
  const foldAngle = phase <= 180 ? phase : 360 - phase;
  const scrub = (e: PointerEvent<SVGSVGElement>) => {
    const transform = e.currentTarget.getScreenCTM();
    if (!transform) return;
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      transform.inverse(),
    );
    onScrub(Math.max(0, Math.min(180, ((point.x - 76) / plotWidth) * 180)));
  };
  // Presentation smoothing only: retain missing samples and the raw data.
  const angleSamples =
    comparison === "stencil" && phase > 180
      ? samples
          .filter((s) => s.phase >= 180)
          .map((s) => ({ ...s, phase: 360 - s.phase }))
          .reverse()
      : samples.filter((s) => s.phase <= 180);
  const plotted = angleSamples.map((s, j) => ({
    ...s,
    values: s.values.map((v, i) => {
      if (!Number.isFinite(v)) return v;
      const before = angleSamples[j - 1]?.values[i],
        after = angleSamples[j + 1]?.values[i];
      return Number.isFinite(before) && Number.isFinite(after)
        ? (before + 2 * v + after) / 4
        : v;
    }),
  }));
  const max =
    Math.max(
      comparison === "blur" ? 0.000001 : 0.01,
      ...samples.flatMap((s) => s.values).filter(Number.isFinite),
    ) * 1.1;
  const x = (p: number) => 76 + (p / 180) * plotWidth;
  const y = (v: number) => plotBottom - (v / max) * (plotBottom - 36);
  const baseline = samples[0]?.values[0];
  const format = (v: number) => {
    if (!Number.isFinite(v)) return "unavailable";
    if (comparison !== "blur")
      return v > 0 && v < 0.01 ? "<0.01" : v.toFixed(2);
    if (!Number.isFinite(baseline) || baseline <= 1e-12) return "unavailable";
    const percent = (v / baseline) * 100;
    return percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
  };
  const index = Math.min(30, Math.floor(foldAngle / 6)),
    t = (foldAngle - index * 6) / 6,
    eased = t * t * (3 - 2 * t);
  const live = plotted[index]?.values.map((v, i) => {
    const next = plotted[index + 1]?.values[i];
    return t === 0
      ? v
      : Number.isFinite(v) && Number.isFinite(next)
        ? v + (next - v) * eased
        : NaN;
  });
  const effect = comparison === "blur" ? "blur" : "stenciling";
  return (
    <section
      className="phone-study-chart"
      ref={chartRef}
      aria-label={`${comparison === "blur" ? "Energy" : "Optical flow"} over fold and unfold`}
    >
      <h2>
        {comparison === "blur"
          ? "Detail energy · % of open baseline"
          : "Content motion · px / 2°"}
      </h2>
      <div className="phone-study-chart-legend">
        <span className="phone-study-series baseline">
          Without {effect}
          {live ? ` · ${format(live[0])}` : ""}
        </span>
        <span className="phone-study-series treatment">
          With {effect}
          {live ? ` · ${format(live[1])}` : ""}
        </span>
      </div>
      {sampling ? (
        <LoadingStatus>Measuring…</LoadingStatus>
      ) : (
        <svg
          className="phone-study-scrubber"
          viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}
          role="slider"
          tabIndex={0}
          aria-label="Fold cycle. Drag to scrub, or use arrow keys."
          aria-valuemin={0}
          aria-valuemax={180}
          aria-valuenow={Math.round(foldAngle)}
          aria-valuetext={`${Math.round(phase <= 180 ? phase : 360 - phase)} degrees, ${phase <= 180 ? "folding" : "unfolding"}`}
          onPointerDown={(e) => {
            if (e.button !== 0 || scrubPointer.current !== null) return;
            e.preventDefault();
            scrubPointer.current = e.pointerId;
            e.currentTarget.setPointerCapture(e.pointerId);
            onScrubbingChange(true);
            scrub(e);
          }}
          onPointerMove={(e) => {
            if (scrubPointer.current === e.pointerId) scrub(e);
          }}
          onPointerUp={(e) => {
            if (scrubPointer.current !== e.pointerId) return;
            scrub(e);
            e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onLostPointerCapture={() => {
            scrubPointer.current = null;
            onScrubbingChange(false);
          }}
          onPointerCancel={() => {
            scrubPointer.current = null;
            onScrubbingChange(false);
          }}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            onScrub(
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? 180
                  : Math.max(
                      0,
                      Math.min(
                        180,
                        foldAngle + (e.key === "ArrowRight" ? 2 : -2),
                      ),
                    ),
            );
          }}
        >
          {[0, 0.5, 1].map((t) => (
            <g key={t}>
              <line
                x1="76"
                x2={x(180)}
                y1={y(t * max)}
                y2={y(t * max)}
                stroke="#e5e5e8"
              />
              <text x="66" y={y(t * max) + 4} textAnchor="end">
                {format(t * max)}
              </text>
            </g>
          ))}
          {[0, 45, 90, 135, 180].map((p) => (
            <text key={p} x={x(p)} y={plotBottom + 23} textAnchor="middle">
              {p <= 180 ? p : 360 - p}°
            </text>
          ))}
          <text x={x(90)} y={plotBottom + 44} textAnchor="middle">
            Fold angle
          </text>
          {[0, 1].map((i) => (
            <path
              key={i}
              d={plotted
                .map((s, j) =>
                  Number.isFinite(s.values[i])
                    ? j && Number.isFinite(plotted[j - 1].values[i])
                      ? `C${x(plotted[j - 1].phase + 2)},${y(plotted[j - 1].values[i])} ${x(s.phase - 2)},${y(s.values[i])} ${x(s.phase)},${y(s.values[i])}`
                      : `M${x(s.phase)},${y(s.values[i])}`
                    : "",
                )
                .join(" ")}
              fill="none"
              stroke={i ? "#0281C1" : "#8CC8EE"}
              strokeWidth="3"
              strokeLinecap="round"
            />
          ))}
          <line
            x1={x(foldAngle)}
            x2={x(foldAngle)}
            y1="28"
            y2={plotBottom}
            stroke="#555"
            strokeDasharray="3 3"
          />
          {live?.map(
            (v, i) =>
              Number.isFinite(v) && (
                <circle
                  key={i}
                  cx={x(foldAngle)}
                  cy={y(v)}
                  r="7"
                  stroke="white"
                  strokeWidth="2"
                  fill={i ? "#0281C1" : "#8CC8EE"}
                />
              ),
          )}
        </svg>
      )}
    </section>
  );
}

function MeasurementNotes() {
  return (
    <div className="phone-study-method">
      <section>
        <h3>Detail energy</h3>
        <p>
          Subtract a softly filtered image from the original, then average the
          squared difference to measure fine-detail contrast.
        </p>
        <p className="phone-study-equation">
          E = mean[(L − G₀.₈ ∗ L)²]
          <br />
          Energy (%) = 100 E / E₀
        </p>
        <p>
          <b>L</b>: linear image brightness. <b>G₀.₈ ∗ L</b>: brightness
          smoothed by a Gaussian filter (σ = 0.8 px). <b>E₀</b>: unblurred,
          fully open energy.
        </p>
        <p>
          The average covers the visible moving panel, excluding a 3 px edge
          margin. Treatment uses the transition&apos;s paper blur (growing with
          the sheet&apos;s distance from its image, with darkening that follows
          it) at the selected scattering strength.
        </p>
      </section>
      <section>
        <h3>Optical flow</h3>
        <p>
          Match image patches between two rendered frames, then average their
          displacement to estimate content motion.
        </p>
        <p className="phone-study-equation">
          d = argminᵤ Σq∈P [A(q) − B(q + u)]²
          <br />
          Motion = mean(‖d‖)
        </p>
        <p>
          <b>A, B</b>: rendered brightness frames 2° apart. <b>P</b>: sampled
          image patch; <b>q</b>: a pixel in it. <b>u</b>: candidate pixel
          offset. <b>d</b>: best-matching offset; <b>‖d‖</b>: its length. Motion
          is in pixels per 2° of folding.
        </p>
        <p>
          Only reliable, visible moving-panel matches count; fewer than four
          produces a gap. Arrows exaggerate displacement ×5, capped at 34 px.
        </p>
      </section>
      <p>
        Fixed camera, 512 × 512 px. Graphs use 6° samples, a 1:2:1 smoothing
        filter, and interpolation. These metrics do not establish visual
        comfort.
      </p>
    </div>
  );
}
