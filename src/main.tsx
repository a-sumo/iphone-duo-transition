import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TracingPaperSimulation from './components/TracingPaperSimulation';
import CoordinatedPaperOpening from './components/CoordinatedPaperOpening';
import './style.css';

function App() {
  const [duo, setDuo] = useState(location.hash !== '#tracing-paper');
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setDuo(location.hash !== '#tracing-paper');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    let active = true;
    setReady(null);
    const files = duo ? ['models/iphone-duo-full-replaced-screen.glb', 'assets/tracing-paper/iphone-duo-clean-background.jpeg', 'assets/tracing-paper/iphone-duo-folded-cover.png'] : ['assets/tracing-paper/lake-of-zug-turner-1843.jpeg'];
    Promise.all(files.map(async file => {
      const response = await fetch(`${import.meta.env.BASE_URL}${file}`, { method: 'HEAD' });
      return response.ok && !response.headers.get('content-type')?.includes('text/html');
    })).then(results => { if (active) setReady(results.every(Boolean)); }).catch(() => { if (active) setReady(false); });
    return () => { active = false; };
  }, [duo]);
  return <><nav aria-label="Experiments"><a href="#tracing-paper" aria-current={!duo ? 'page' : undefined}>Tracing Paper</a><a href="#iphone-duo" aria-current={duo ? 'page' : undefined}>iPhone Duo Transition</a><a className="source" href="https://github.com/a-sumo/iphone-duo-transition">Source ↗</a></nav>
    <main>{ready ? (duo ? <CoordinatedPaperOpening standalone /> : <TracingPaperSimulation standalone />) : <div className="notice" role="status">{ready === null ? 'Loading…' : <><h1>Supply the demo assets</h1><p>See the README for the local asset paths. Third-party assets are not included in the code license.</p><a href={`https://armandsumo.com/labs/${duo ? 'iphone-duo-transition' : 'tracing-paper'}/`}>Open the hosted demo ↗</a></>}</div>}</main></>;
}
createRoot(document.getElementById('root')!).render(<App />);
