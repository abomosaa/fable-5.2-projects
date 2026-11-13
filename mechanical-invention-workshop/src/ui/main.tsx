import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { initKernel } from '../core/geom/kernel';
import { App } from './App';

const root = createRoot(document.getElementById('root')!);
root.render(<div className="splash"><div className="spinner" /><p>Loading geometry kernel…</p></div>);
initKernel(wasmUrl)
  .then(() => root.render(<App kernelError={null} />))
  .catch((e) => root.render(<App kernelError={String(e?.message ?? e)} />));
