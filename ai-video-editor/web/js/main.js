// Entry point: boots the app shell and wires routing.
import { html, render } from './lib/ui.js';
import { App } from './app.js';
import * as actions from './state/actions.js';
import { applyRoute, loadHealth } from './state/actions.js';
import { store } from './state/store.js';
import { transport } from './player/transport.js';

window.addEventListener('hashchange', applyRoute);

render(html`<${App} />`, document.getElementById('app'));
loadHealth();
applyRoute();

// Debug / test hook (read-only use in tests: state inspection and driving the transport).
window.__cutline = { store, transport, actions };

// Surface unexpected errors instead of failing silently.
window.addEventListener('unhandledrejection', (e) => console.error('[cutline] unhandled rejection:', e.reason));
