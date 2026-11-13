export function fmtTime(ms: number | null | undefined, opts: { seconds?: boolean } = {}): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, opts.seconds ? 19 : 16)} UTC`;
}

export function fmtDate(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().slice(0, 10);
}

export function fmtAgo(ms: number | null | undefined, now: number): string {
  if (ms == null) return '—';
  const d = now - ms;
  const abs = Math.abs(d);
  const unit = (n: number, u: string) => `${n} ${u}${d < 0 ? ' from now' : ' ago'}`;
  if (abs < 45_000) return d < 0 ? 'in a moment' : 'just now';
  if (abs < 90 * 60_000) return unit(Math.round(abs / 60_000), 'min');
  if (abs < 36 * 3_600_000) return unit(Math.round(abs / 3_600_000), 'h');
  if (abs < 60 * 86_400_000) return unit(Math.round(abs / 86_400_000), 'd');
  if (abs < 730 * 86_400_000) return unit(Math.round(abs / (30.44 * 86_400_000)), 'mo');
  return unit(Math.round(abs / (365.25 * 86_400_000)), 'y');
}

export function fmtDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86_400)} d`;
}

export function fmtNumber(n: number, unit?: string): string {
  const abs = Math.abs(n);
  let s: string;
  if (abs >= 1e9) s = `${(n / 1e9).toFixed(abs >= 1e10 ? 1 : 2)} B`;
  else if (abs >= 1e6) s = `${(n / 1e6).toFixed(abs >= 1e7 ? 1 : 2)} M`;
  else if (abs >= 1e4) s = `${(n / 1e3).toFixed(1)} k`;
  else if (abs >= 100 || Number.isInteger(n)) s = n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  else if (abs >= 1) s = n.toLocaleString('en-US', { maximumFractionDigits: 1 });
  else s = n.toLocaleString('en-US', { maximumSignificantDigits: 2 });
  return unit ? `${s} ${unit}` : s;
}

export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/** camelCase / snake_case attribute keys → readable labels. */
export function humanizeKey(key: string): string {
  const s = key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/\b(Km|Kt|Kn|Mw|Deg|Sec|Ms|Ft|Hpa|Pct|Id|Url|Iso|Utc|Cve|Asn|Ix|Aqi|Pm)\b/g, (m) => {
    const map: Record<string, string> = { Km: 'km', Kt: 'kt', Kn: 'kn', Mw: 'MW', Deg: '°', Sec: 's', Ms: 'm/s', Ft: 'ft', Hpa: 'hPa', Pct: '%', Id: 'ID', Url: 'URL', Iso: 'ISO', Utc: 'UTC', Cve: 'CVE', Asn: 'ASN', Ix: 'IX', Aqi: 'AQI', Pm: 'PM' };
    return map[m] ?? m;
  });
}

export const SEVERITY_NAMES = ['Info', 'Minor', 'Moderate', 'Severe', 'Extreme'];

/** datetime-local value (UTC) ↔ epoch ms */
export function toLocalInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const ms = Date.parse(`${v}${v.length === 16 ? ':00' : ''}Z`);
  return Number.isFinite(ms) ? ms : null;
}
