import { useMemo } from 'react';
import { choroClasses } from '../lib/choropleth';
import { fmtCount } from '../lib/format';
import { hexToRgba, slotColor } from '../palette';
import { choroplethRoles, layerMap, useStore } from '../state/store';
import { LayerSymbol, StatusBadge } from './Symbol';

/** The legend lists exactly the enabled layers – nothing else – in the form each is currently drawn. */
export function Legend() {
  const meta = useStore((s) => s.meta)!;
  const enabled = useStore((s) => s.enabled) ?? [];
  const open = useStore((s) => s.legendOpen);
  const setOpen = useStore((s) => s.setLegendOpen);
  const status = useStore((s) => s.mapStatus);
  const choropleth = useStore((s) => s.choropleth);
  const sources = useStore((s) => s.sources);
  const theme = useStore((s) => s.theme);
  const palette = useStore((s) => s.palette);
  const view = useStore((s) => s.view);
  const layers = useMemo(() => layerMap(meta), [meta]);
  const roles = choroplethRoles(enabled, layers);

  // catalog order, so the legend does not reshuffle while toggling
  const shown = meta.layers.filter((l) => enabled.includes(l.id));
  const issues = sources.filter((s) => !['healthy', 'pending'].includes(s.health.status) && s.manifest.layers.some((l) => enabled.includes(l.id)));
  const anyPoints = shown.some((l) => ['point', 'track', 'heatmap'].includes(l.render.type));

  return (
    <section className={`legend ${open ? 'open' : ''}`} aria-label="Legend" data-testid="legend">
      <button type="button" className="legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>Legend</span>
        <span className="muted">{shown.length} layer{shown.length === 1 ? '' : 's'}</span>
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {open && (
        <div className="legend-body">
          {shown.length === 0 && <p className="empty">No layers enabled — only the basemap is shown.</p>}
          <ul>
            {shown.map((l) => {
              const hidden = status.hiddenByZoom.includes(l.id);
              const isChoro = l.render.type === 'choropleth';
              const isFill = roles.fill === l.id;
              const data = isChoro ? choropleth[l.id] : undefined;
              const cls = isFill && data ? choroClasses(data, theme) : null;
              const heatNow = l.render.type === 'heatmap' && l.render.heatmapBelowZoom != null && view.zoom < l.render.heatmapBelowZoom;
              const color = slotColor(l.render.color, theme, palette);
              return (
                <li key={l.id} data-legend-layer={l.id}>
                  <div className="legend-row">
                    <LayerSymbol layer={l} />
                    <span className="legend-name" title={l.name}>{l.name}</span>
                    {hidden ? <span className="tag">zoom in</span> : status.counts[l.id] != null && <span className="muted count">{fmtCount(status.counts[l.id]!)}</span>}
                  </div>
                  {heatNow && (
                    <div className="ramp-wrap">
                      <div className="ramp" style={{ background: `linear-gradient(90deg, ${hexToRgba(color, 0.15)}, ${color}, #fff)` }} />
                      <div className="ramp-labels"><span>sparse</span><span>dense (zoom in for points)</span></div>
                    </div>
                  )}
                  {isChoro && data && (
                    <div className="ramp-wrap">
                      {isFill && cls ? (
                        <>
                          <div className="classes">
                            {cls.colors.map((c, i) => (
                              <span key={i} className="class">
                                <i style={{ background: c }} />
                                {cls.labels[i]}
                              </span>
                            ))}
                          </div>
                          <div className="ramp-labels">
                            <span>{data.name} ({data.unit}) · country fill{data.scale === 'diverging' ? ' · blue = decrease, red = increase' : ''}</span>
                          </div>
                        </>
                      ) : (
                        <div className="ramp-labels">
                          <span>
                            <svg width="34" height="14" viewBox="0 0 34 14" aria-hidden="true">
                              <circle cx="5" cy="7" r="3" fill={hexToRgba(color, 0.5)} stroke={color} />
                              <circle cx="22" cy="7" r="6.5" fill={hexToRgba(color, 0.5)} stroke={color} />
                            </svg>{' '}
                            {data.name} ({data.unit}) · circle size = value. Country fill is used by “{layers.get(roles.fill ?? '')?.name}”.
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                  {isChoro && !data && !status.loading && <div className="ramp-labels"><span>No values for this time range.</span></div>}
                </li>
              );
            })}
          </ul>
          {shown.length > 0 && (
            <div className="legend-keys">
              {anyPoints && (
                <>
                  <span className="key"><i className="k-cluster">12</i> cluster: number of records, colour of its most common layer</span>
                  <span className="key"><i className="k-size" /> larger symbol = higher severity</span>
                </>
              )}
              <span className="key"><i className="k-dim" /> dimmed = stale source or expired record</span>
              {status.truncated && <span className="key warn">Some shapes are omitted at this zoom; zoom in to see all.</span>}
            </div>
          )}
          {issues.length > 0 && (
            <div className="legend-issues" data-testid="legend-issues">
              <strong>Source issues affecting enabled layers</strong>
              <ul>
                {issues.map((s) => (
                  <li key={s.manifest.id}>
                    <StatusBadge status={s.health.status} /> <span>{s.manifest.provider}</span>
                  </li>
                ))}
              </ul>
              <button type="button" className="link" onClick={() => useStore.getState().setPanel('sources')}>Open source health</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
