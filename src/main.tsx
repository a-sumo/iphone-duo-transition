import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TracingPaperSimulation from './components/TracingPaperSimulation';
import CoordinatedPaperOpening from './components/CoordinatedPaperOpening';
import PhonePerceptionExperiment from './components/PhonePerceptionExperiment';
import './style.css';

const DUO_FILES = ['models/iphone-duo-full-replaced-screen.glb', 'assets/tracing-paper/iphone-duo-clean-background.jpeg', 'assets/tracing-paper/iphone-duo-folded-cover.png'];
const LABS = {
  'tracing-paper': { name: 'Tracing Paper', hosted: 'tracing-paper', files: ['assets/tracing-paper/lake-of-zug-turner-1843.jpeg'] },
  'iphone-duo': { name: 'iPhone Duo Transition', hosted: 'iphone-duo-transition', files: DUO_FILES },
  'perception': { name: 'Blur and Stencil', hosted: 'iphone-duo-perception', files: [...DUO_FILES, 'assets/tracing-paper/tomaselli-newspaper-reference.jpg'] },
} as const;
type Lab = keyof typeof LABS;
const labFromHash = (): Lab => (location.hash.slice(1) in LABS ? location.hash.slice(1) as Lab : 'iphone-duo');

function App() {
  const [lab, setLab] = useState<Lab>(labFromHash);
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setLab(labFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  // The perception lab's standalone layout keys off this class.
  useEffect(() => {
    document.documentElement.classList.toggle('perception-standalone', lab === 'perception');
  }, [lab]);
  useEffect(() => {
    let active = true;
    setReady(null);
    Promise.all(LABS[lab].files.map(async file => {
      const response = await fetch(`${import.meta.env.BASE_URL}${file}`, { method: 'HEAD' });
      return response.ok && !response.headers.get('content-type')?.includes('text/html');
    })).then(results => { if (active) setReady(results.every(Boolean)); }).catch(() => { if (active) setReady(false); });
    return () => { active = false; };
  }, [lab]);
  const view = lab === 'tracing-paper' ? <TracingPaperSimulation standalone /> : lab === 'iphone-duo' ? <CoordinatedPaperOpening standalone /> : <PhonePerceptionExperiment />;
  return <><nav aria-label="Experiments">{(Object.keys(LABS) as Lab[]).map(key => <a key={key} href={`#${key}`} aria-current={lab === key ? 'page' : undefined}>{LABS[key].name}</a>)}<a className="source" href="https://github.com/a-sumo/iphone-duo-transition">Source ↗</a></nav>
    <main className={lab === 'perception' ? 'main--scroll' : undefined}>{ready ? view : <div className="notice" role="status">{ready === null ? 'Loading…' : <><h1>Supply the demo assets</h1><p>See the README for the local asset paths. Third-party assets are not included in the code license.</p><a href={`https://armandsumo.com/labs/${LABS[lab].hosted}/`}>Open the hosted demo ↗</a></>}</div>}</main></>;
}
createRoot(document.getElementById('root')!).render(<App />);
