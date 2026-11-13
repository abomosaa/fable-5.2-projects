import { useEffect, useMemo, useRef, useState } from 'react';
import { api, effectiveRange, filterParams, serverNow } from '../api';
import { fmtDuration, fmtTime, fromLocalInput, toLocalInput } from '../lib/format';
import { useStore } from '../state/store';
import type { TimeState } from '../types';

const LIVE_WINDOWS = [3600, 6 * 3600, 86400, 3 * 86400, 7 * 86400, 30 * 86400, 365 * 86400];
const SLIDING = [0, 3600, 6 * 3600, 86400, 7 * 86400, 30 * 86400];
const PRESETS: [string, number][] = [['24 h', 86400], ['7 d', 7 * 86400], ['30 d', 30 * 86400], ['90 d', 90 * 86400], ['1 y', 365 * 86400]];
const BUCKETS = 72;

interface Hist { from: number; to: number; bucketMs: number; counts: number[]; total: number }

export function Timeline() {
  const meta = useStore((s) => s.meta)!;
  const time = useStore((s) => s.time);
  const setTime = useStore((s) => s.setTime);
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const enabled = useStore((s) => s.enabled);
  const filters = useStore((s) => s.filters);
  const bbox = useStore((s) => s.viewBbox);
  const dataVersion = useStore((s) => s.dataVersion);
  const open = useStore((s) => s.timelineOpen);
  const lastUpdated = useStore((s) => s.mapStatus.lastUpdated);
  const liveConnected = useStore((s) => s.liveConnected);
  const [hist, setHist] = useState<Hist | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [, tick] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // The histogram always spans the whole selected range (live: the look-back window), not just the playback window.
  const span = useMemo(() => {
    if (time.mode === 'live') {
      const now = serverNow();
      return { from: now - time.windowSec * 1000, to: now };
    }
    return { from: time.from, to: time.to };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time.mode, time.mode === 'live' ? time.windowSec : time.from, time.mode === 'range' ? time.to : 0, dataVersion, lastUpdated && time.mode === 'live' ? Math.floor(lastUpdated / 60_000) : 0]);

  const boxKey = bbox ? bbox.map((n) => n.toFixed(2)).join(',') : '';
  useEffect(() => {
    if (!enabled || !open) return;
    if (enabled.length === 0) {
      setHist(null);
      return;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      api
        .histogram(filterParams(enabled, filters, { mode: 'live', windowSec: 86400 }), span.from, span.to, BUCKETS, bbox, ac.signal)
        .then((h) => setHist(h))
        .catch(() => {
          /* the histogram is decorative context; the map reports its own errors */
        });
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, filters, boxKey, span, open]);

  const goLive = (windowSec?: number) => setTime({ mode: 'live', windowSec: windowSec ?? (time.mode === 'live' ? time.windowSec : 7 * 86400) });
  const goRange = (from: number, to: number) => setTime({ mode: 'range', from, to, cursor: to, windowSec: time.mode === 'range' ? time.windowSec : 0 });
  const startHistory = () => {
    const now = serverNow();
    const w = time.mode === 'live' ? time.windowSec : 7 * 86400;
    goRange(now - w * 1000, now);
  };
  const patch = (p: Partial<Extract<TimeState, { mode: 'range' }>>) => time.mode === 'range' && setTime({ ...time, ...p });

  const eff = effectiveRange(time);
  const max = hist ? Math.max(1, ...hist.counts) : 1;
  const W = 720;
  const H = 44;
  const bw = W / BUCKETS;

  const onBarClick = (i: number) => {
    if (!hist) return;
    const t = hist.from + (i + 1) * hist.bucketMs;
    if (time.mode === 'range') patch({ cursor: Math.min(time.to, t) });
    else {
      // clicking the live histogram opens that bucket for historical exploration
      setTime({ mode: 'range', from: hist.from, to: hist.to, cursor: Math.min(hist.to, t), windowSec: 0 });
    }
  };

  const summary = time.mode === 'live'
    ? `Live · last ${fmtDuration(time.windowSec)}`
    : `${fmtTime(eff!.from)} → ${fmtTime(eff!.to)}`;

  return (
    <footer className={`timeline ${open ? 'open' : 'collapsed'}`} aria-label="Timeline">
      <div className="tl-bar">
        <div className="seg" role="group" aria-label="Time mode">
          <button type="button" className={time.mode === 'live' ? 'active' : ''} aria-pressed={time.mode === 'live'} onClick={() => goLive()} data-testid="mode-live">
            <span className={`live-dot ${time.mode === 'live' && liveConnected ? 'on' : ''}`} aria-hidden="true" /> Live
          </button>
          <button type="button" className={time.mode === 'range' ? 'active' : ''} aria-pressed={time.mode === 'range'} onClick={startHistory} data-testid="mode-history">History</button>
        </div>

        {time.mode === 'live' ? (
          <label className="inline">
            <span>Look-back</span>
            <select value={time.windowSec} onChange={(e) => goLive(Number(e.target.value))} data-testid="live-window">
              {[...new Set([...LIVE_WINDOWS, time.windowSec])].sort((a, b) => a - b).map((w) => <option key={w} value={w}>{fmtDuration(w)}</option>)}
            </select>
          </label>
        ) : (
          <>
            <div className="playback" role="group" aria-label="Playback">
              <button type="button" className="icon-btn" aria-label="Step back" onClick={() => patch({ cursor: Math.max(time.from, time.cursor - (time.to - time.from) / 120) })}>⏮</button>
              <button type="button" className="icon-btn play" aria-label={playing ? 'Pause playback' : 'Play'} onClick={() => useStore.getState().setPlaying(!playing)} data-testid="play">
                {playing ? '⏸' : '▶'}
              </button>
              <button type="button" className="icon-btn" aria-label="Step forward" onClick={() => patch({ cursor: Math.min(time.to, time.cursor + (time.to - time.from) / 120) })}>⏭</button>
              <label className="inline">
                <span className="sr-only">Playback speed</span>
                <select value={speed} onChange={(e) => useStore.getState().setSpeed(Number(e.target.value))} aria-label="Playback speed">
                  <option value={0.5}>0.5×</option>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
            </div>
            <label className="inline">
              <span>From <abbr title="Coordinated Universal Time">UTC</abbr></span>
              <input type="datetime-local" value={toLocalInput(time.from)} max={toLocalInput(time.to - 60_000)} data-testid="range-from"
                onChange={(e) => { const v = fromLocalInput(e.target.value); if (v != null && v < time.to) setTime({ ...time, from: v, cursor: Math.max(v, time.cursor) }); }} />
            </label>
            <label className="inline">
              <span>To <abbr title="Coordinated Universal Time">UTC</abbr></span>
              <input type="datetime-local" value={toLocalInput(time.to)} min={toLocalInput(time.from + 60_000)} data-testid="range-to"
                onChange={(e) => { const v = fromLocalInput(e.target.value); if (v != null && v > time.from) setTime({ ...time, to: v, cursor: v }); }} />
            </label>
            <label className="inline">
              <span>Show</span>
              <select value={time.windowSec} onChange={(e) => patch({ windowSec: Number(e.target.value) })} aria-label="Playback window" data-testid="play-window">
                {SLIDING.map((w) => <option key={w} value={w}>{w === 0 ? 'everything up to the cursor' : `the ${fmtDuration(w)} before the cursor`}</option>)}
              </select>
            </label>
            <span className="presets" role="group" aria-label="Quick ranges (UTC)">
              {PRESETS.map(([label, sec]) => (
                <button type="button" key={label} className="chip" onClick={() => { const now = serverNow(); goRange(now - sec * 1000, now); }}>{label}</button>
              ))}
              {meta.timeExtent.min != null && (
                <button type="button" className="chip" onClick={() => goRange(Math.max(meta.timeExtent.min!, serverNow() - 5 * 365 * 86400_000), serverNow())}>all data</button>
              )}
            </span>
          </>
        )}
        <span className="tl-summary mono" data-testid="time-summary" aria-live="off">{summary}</span>
        <button type="button" className="icon-btn tl-collapse" aria-expanded={open} aria-label={open ? 'Collapse timeline' : 'Expand timeline'} onClick={() => useStore.getState().setTimelineOpen(!open)}>
          <span className={`chev ${open ? 'open down' : 'up'}`} aria-hidden="true">▸</span>
        </button>
      </div>

      {open && (
        <div className="tl-chart">
          {time.mode === 'range' && (
            <input
              className="scrubber"
              type="range"
              min={time.from}
              max={time.to}
              step={Math.max(1000, Math.round((time.to - time.from) / 480))}
              value={time.cursor}
              onChange={(e) => patch({ cursor: Number(e.target.value) })}
              aria-label="Timeline cursor"
              aria-valuetext={fmtTime(time.cursor)}
              data-testid="scrubber"
            />
          )}
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H + 1}`} preserveAspectRatio="none" role="img" aria-label={hist ? `Records over time: ${hist.total} in range` : 'Records over time'} onMouseLeave={() => setHover(null)}>
            {eff && hist && (
              <rect
                className="tl-window"
                x={((eff.from - hist.from) / (hist.to - hist.from)) * W}
                width={Math.max(2, ((eff.to - eff.from) / (hist.to - hist.from)) * W)}
                y={0}
                height={H}
              />
            )}
            <line className="tl-axis" x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} />
            {hist?.counts.map((c, i) => {
              const h = c === 0 ? 0 : Math.max(2, (c / max) * (H - 4));
              return (
                <g key={i} onMouseEnter={() => setHover(i)} onClick={() => onBarClick(i)} className="tl-hit">
                  <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
                  {c > 0 && <path className={`tl-bar-mark ${hover === i ? 'hover' : ''}`} d={`M${i * bw + 1},${H} v${-(h - 2)} q0,-2 2,-2 h${bw - 6} q2,0 2,2 v${h - 2} z`} />}
                </g>
              );
            })}
          </svg>
          {hist && (
            <div className="tl-ticks" aria-hidden="true">
              {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{fmtTime(hist.from + f * (hist.to - hist.from)).replace(' UTC', '')}</span>)}
            </div>
          )}
          {hover != null && hist && (
            <div className="tl-tip" style={{ left: `${((hover + 0.5) / BUCKETS) * 100}%` }} role="tooltip">
              <strong>{hist.counts[hover]!.toLocaleString('en-US')}</strong> records
              <span>{fmtTime(hist.from + hover * hist.bucketMs)} – {fmtTime(hist.from + (hover + 1) * hist.bucketMs).slice(11)}</span>
            </div>
          )}
          {enabled && enabled.length === 0 && <p className="tl-empty">Enable layers to see activity over time.</p>}
          {enabled && enabled.length > 0 && hist && hist.total === 0 && <p className="tl-empty">No dated records in this range (reference layers and country indicators have no event times).</p>}
        </div>
      )}
    </footer>
  );
}
