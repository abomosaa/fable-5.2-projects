import { describe, expect, it } from 'vitest';
import type { RecordDraft } from '../core/types.ts';
import { DAY, HOUR, point, T0, testManifest } from '../test/helpers.ts';
import { makeRecordId, normaliseDraft, type NormaliseContext } from './normalize.ts';

const manifest = testManifest('norm', [
  { id: 'ev', timeModel: 'event' },
  { id: 'iv', timeModel: 'interval' },
  { id: 'ref', timeModel: 'reference', retentionDays: null },
  { id: 'ind', timeModel: 'indicator', geometry: 'country', render: { type: 'choropleth', color: 'blue', shape: 'circle' }, metric: { name: 'M', unit: 'u', scale: 'sequential', higherIs: 'neutral', transform: 'linear' } },
]);
const ctx: NormaliseContext = { manifest, adapterVersion: '1.0.0', now: T0, fetchedAt: T0 - 1000, fetchUrls: ['https://norm.example.org/feed'], fixture: false };
const base: RecordDraft = { upstreamId: 'a1', layerId: 'ev', title: 'An event', geometry: point(10, 20), occurredAt: T0 - HOUR };

function norm(over: Partial<RecordDraft>) {
  return normaliseDraft({ ...base, ...over }, ctx);
}
function okRecord(over: Partial<RecordDraft>) {
  const r = norm(over);
  if (!r.ok) throw new Error(`unexpected reject: ${r.rejected.reason}`);
  return r.record;
}
function reason(over: Partial<RecordDraft>): string {
  const r = norm(over);
  if (r.ok) throw new Error('unexpectedly accepted');
  return r.rejected.reason;
}

describe('schema validation', () => {
  it('builds a complete common record with provenance', () => {
    const r = okRecord({ severity: 3, severityLabel: 'M 6.1', confidence: 0.9, confidenceBasis: 'reviewed', attributes: { depthKm: 12, note: ' <i>x</i> ', skip: undefined, empty: '' }, url: 'https://example.org/e/a1', derived: ['severity'] });
    expect(r).toMatchObject({
      id: 'norm:a1', upstreamId: 'a1', sourceId: 'norm', layerId: 'ev', domain: 'hazards', category: 'test', geometryKind: 'point',
      point: [10, 20], bbox: [10, 20, 10, 20], occurredAt: T0 - HOUR, fetchedAt: T0 - 1000, tStart: T0 - HOUR, tEnd: T0 - HOUR,
      severity: 3, severityLabel: 'M 6.1', confidence: 0.9, title: 'An event', url: 'https://example.org/e/a1',
      attribution: 'Attribution norm', licenseUrl: 'https://example.org/licence',
    });
    expect(r.attributes).toEqual({ depthKm: 12, note: 'x' });
    expect(r.provenance).toMatchObject({ sourceId: 'norm', adapterVersion: '1.0.0', fetchUrls: ['https://norm.example.org/feed'], revision: 1, fixture: false });
    expect(r.provenance.contentHash).toMatch(/^[0-9a-f]{32}$/);
    // the country was looked up from the coordinates, so it is recorded as derived next to the adapter's own list
    expect(r.countries).toEqual(['NER']); // 10°E 20°N lies in Niger
    expect(r.provenance.derived).toEqual(['country', 'severity']);
  });

  it('rejects records with missing or wrongly typed fields', () => {
    expect(reason({ title: '' })).toMatch(/schema: title/);
    expect(reason({ title: '<b></b>' })).toBe('title: empty after sanitisation');
    expect(reason({ upstreamId: '' })).toMatch(/schema: upstreamId/);
    expect(reason({ layerId: 'nope' })).toBe('unknown layer "nope" for source norm');
    expect(reason({ severity: 7 as never })).toMatch(/schema: severity/);
    expect(reason({ confidence: 1.5 })).toMatch(/schema: confidence/);
    expect(reason({ occurredAt: 'yesterday' as never })).toMatch(/schema: occurredAt/);
    expect(reason({ occurredAt: NaN })).toMatch(/schema: occurredAt/);
    expect(reason({ attributes: { nested: { a: 1 } as never } })).toMatch(/schema: attributes/);
  });

  it('rejects invalid coordinates and geometry', () => {
    expect(reason({ geometry: point(10, 95) })).toBe('geometry: latitude 95 out of range');
    expect(reason({ geometry: point(400, 5) })).toBe('geometry: longitude 400 out of range');
    expect(reason({ geometry: { type: 'Point', coordinates: [NaN, 5] } })).toBe('geometry: non-numeric coordinate');
    expect(reason({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } })).toMatch(/too few positions/);
    expect(reason({ geometry: null })).toBe('geometry: record has neither geometry nor country');
    expect(reason({ geometry: null, country: 'Atlantis' })).toBe('country: unrecognised country "Atlantis"');
  });

  it('rejects implausible and missing times', () => {
    expect(reason({ occurredAt: Date.UTC(1500, 0, 1) })).toMatch(/time: occurredAt out of range/);
    expect(reason({ occurredAt: T0 + 2 * DAY })).toMatch(/event occurredAt is in the future/);
    expect(reason({ occurredAt: null })).toBe('time: record has no occurrence, publication or update time');
    // modest clock skew is tolerated
    expect(norm({ occurredAt: T0 + HOUR }).ok).toBe(true);
  });
});

describe('normalisation', () => {
  it('sanitises text and drops unsafe links, noting it in provenance', () => {
    const r = okRecord({ title: 'Alert <script>alert(1)</script>for <b>region</b>', description: '<p>Line&nbsp;one</p><p>two</p>', url: 'javascript:alert(1)' });
    expect(r.title).toBe('Alert for region');
    expect(r.description).toBe('Line one two');
    expect(r.url).toBeNull();
    expect(r.provenance.normalisation).toContain('dropped non-http(s) source link');
  });

  it('wraps longitudes, records the normalisation and keeps explicit countries', () => {
    const r = okRecord({ geometry: point(181.5, -17), country: 'FJ' });
    expect(r.point).toEqual([-178.5, -17]);
    expect(r.provenance.normalisation).toContain('wrapped longitude into [-180, 180]');
    expect(r.countries).toEqual(['FJI']);
    expect(r.provenance.derived).toEqual([]);
  });

  it('derives the timeline interval per time model', () => {
    expect(okRecord({ layerId: 'ref', occurredAt: null })).toMatchObject({ tStart: null, tEnd: null });
    const iv = (o: Partial<RecordDraft>) => okRecord({ layerId: 'iv', occurredAt: T0 - 5 * HOUR, ...o });
    expect(iv({ expiresAt: T0 + 2 * HOUR })).toMatchObject({ tStart: T0 - 5 * HOUR, tEnd: T0 + 2 * HOUR });
    expect(iv({ endedAt: T0 - HOUR, expiresAt: T0 + 2 * HOUR })).toMatchObject({ tEnd: T0 - HOUR }); // explicit close wins over expiry
    expect(iv({ ongoing: true })).toMatchObject({ tEnd: ctx.fetchedAt, ongoing: true }); // confirmed active as of this fetch
    expect(iv({ updatedAt: T0 - 2 * HOUR })).toMatchObject({ tEnd: T0 - 2 * HOUR });
    expect(iv({ expiresAt: T0 - 9 * HOUR })).toMatchObject({ tEnd: T0 - 5 * HOUR }); // never ends before it starts
  });

  it('turns country-only drafts into country records at the label point', () => {
    const r = okRecord({ layerId: 'ind', geometry: undefined, country: 'KE', occurredAt: Date.UTC(2025, 0, 1), metric: { name: 'M', value: 5, unit: 'u', period: '2025' } });
    expect(r.geometryKind).toBe('country');
    expect(r.geometry).toBeNull();
    expect(r.countries).toEqual(['KEN']);
    expect(r.point![0]).toBeGreaterThan(33);
    expect(r.point![0]).toBeLessThan(42);
    expect(r.bbox).not.toBeNull();
  });

  it('supports non-geographic bulletins', () => {
    const r = okRecord({ geometry: undefined, geometryKind: 'global' });
    expect(r).toMatchObject({ geometryKind: 'global', geometry: null, point: null, bbox: null, countries: [] });
  });

  it('is deterministic: identical drafts hash identically, any content change alters the hash', () => {
    const a = okRecord({ attributes: { x: 1, y: 'two' } });
    const b = okRecord({ attributes: { y: 'two', x: 1 } });
    const c = okRecord({ attributes: { x: 2, y: 'two' } });
    expect(a.provenance.contentHash).toBe(b.provenance.contentHash);
    expect(a.provenance.contentHash).not.toBe(c.provenance.contentHash);
    // fetch bookkeeping is not content
    const later = normaliseDraft({ ...base, attributes: { x: 1, y: 'two' } }, { ...ctx, fetchedAt: T0 + HOUR, now: T0 + HOUR });
    expect(later.ok && later.record.provenance.contentHash).toBe(a.provenance.contentHash);
  });

  it('builds stable, URL-safe ids', () => {
    expect(makeRecordId('s', 'abc-1.2_x')).toBe('s:abc-1.2_x');
    const odd = makeRecordId('s', 'urn:oid:2.49.0.1.840.0/a b?c');
    expect(odd).toMatch(/^s:urn_oid_2\.49\.0\.1\.840\.0_a_b_c~[0-9a-f]{16}$/);
    expect(makeRecordId('s', 'urn:oid:2.49.0.1.840.0/a b?c')).toBe(odd);
    expect(makeRecordId('s', 'a/b')).not.toBe(makeRecordId('s', 'a_b')); // no collisions after escaping
    expect(makeRecordId('s', 'x'.repeat(300)).length).toBeLessThan(80);
  });
});
