import './editor/style.css';
import { App } from './editor/App.js';

const app = new App();
window.__app = app; // automation hook used by the functional tests and capture tools
app.init().catch((e) => {
  console.error(e);
  app.errors.push(String(e.message || e));
  const el = document.getElementById('fatal') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'fatal' }));
  el.innerHTML = '';
  const h1 = document.createElement('h1');
  h1.textContent = 'Terraforge could not start';
  const p = document.createElement('p');
  p.textContent = String(e.message || e);
  el.append(h1, p);
  document.getElementById('progress')?.remove();
});
