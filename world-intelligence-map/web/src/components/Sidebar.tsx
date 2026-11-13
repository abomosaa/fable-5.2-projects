import { useStore } from '../state/store';
import { FeedPanel } from './FeedPanel';
import { FilterPanel } from './FilterPanel';
import { LayerPanel } from './LayerPanel';
import { SourcesPanel } from './SourcesPanel';

const TITLES = { layers: 'Layers', filters: 'Filters', feed: 'Results', sources: 'Sources' } as const;

export function Sidebar({ onReloadSources }: { onReloadSources: () => void }) {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  return (
    <aside id="sidebar" className={`sidebar ${panel ? 'open' : 'closed'}`} aria-label="Catalog, filters, results and sources" tabIndex={-1}>
      {panel && (
        <>
          <div className="sidebar-title">
            <h2>{TITLES[panel]}</h2>
            <button type="button" className="icon-btn" aria-label="Close panel" onClick={() => setPanel(null)}>×</button>
          </div>
          {panel === 'layers' && <LayerPanel />}
          {panel === 'filters' && <FilterPanel />}
          {panel === 'feed' && <FeedPanel />}
          {panel === 'sources' && <SourcesPanel onReload={onReloadSources} />}
        </>
      )}
    </aside>
  );
}
