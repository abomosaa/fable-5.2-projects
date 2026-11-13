import { describe, expect, it } from 'vitest';
import { adapterContractSuite, runAdapterOnFixtures } from '../testing.ts';
import adapter, { EXCERPT_MAX, FEED_URL, locationFromTitle } from './adapter.ts';

adapterContractSuite(adapter, { minRecords: 60 });

describe('who-don specifics', () => {
  it('requests the newest 60 notices with only the fields it uses', async () => {
    const run = await runAdapterOnFixtures(adapter);
    expect(run.requests).toEqual([FEED_URL]);
    expect(FEED_URL).toContain('$orderby=PublicationDateAndTime%20desc&$top=60&$select=Id,DonId,Title,');
    expect(FEED_URL).not.toMatch(/Overview|Epidemiology|Assessment|Advice|Response/); // full report sections are never requested
    expect(run.rejected).toHaveLength(0);
    expect(run.records).toHaveLength(60);
  });

  it('maps a single-country notice to a country-level record with the location marked as derived', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const r = run.records.find((x) => x.upstreamId === '2026-DON623')!;
    expect(r.title).toBe('Shamonda virus in human - France');
    expect(r.geometryKind).toBe('country');
    expect(r.geometry).toBeNull();
    expect(r.countries).toEqual(['FRA']);
    expect(r.subcategory).toBe('Shamonda virus in human');
    // PublicationDateAndTime 2026-11-02T19:00:00Z (UTC); LastModified 2026-11-03.
    expect(r.occurredAt).toBe(Date.UTC(2026, 10, 2, 19, 0, 0));
    expect(r.publishedAt).toBe(r.occurredAt);
    expect(r.updatedAt).toBeGreaterThan(r.occurredAt!);
    expect(r.severity).toBeNull();
    expect(r.confidence).toBeNull();
    expect(r.confidenceBasis).toBeNull();
    expect(r.provenance.derived).toEqual(['country', 'geometry', 'subcategory']);
    expect(r.url).toBe('https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON623');
    expect(r.attributes.locationText).toBe('France');
    expect(r.attributes.locationScope).toBe('country');
  });

  it('attaches multi-country notices to every named country and keeps regional/global notices as bulletins', async () => {
    const run = await runAdapterOnFixtures(adapter);
    const multi = run.records.find((x) => x.upstreamId === '2026-DON625')!;
    expect(multi.title).toBe('Ebola disease caused by Bundibugyo virus - Democratic Republic of the Congo, Kenya and Nigeria');
    expect(multi.countries).toEqual(['COD', 'KEN', 'NGA']);
    expect(multi.attributes.locationScope).toBe('multi-country');
    expect(multi.occurredAt).toBe(Date.UTC(2026, 10, 6, 20, 42, 12));

    const regional = run.records.find((x) => x.upstreamId === '2026-DON624')!;
    expect(regional.title).toBe('Yellow fever - WHO African Region');
    expect(regional.geometryKind).toBe('global');
    expect(regional.countries).toEqual([]);
    expect(regional.point).toBeNull();
    expect(regional.provenance.derived).toEqual(['subcategory']);

    // A slug-style UrlName is used as published.
    const slug = run.records.find((x) => x.upstreamId === '2026-DON618')!;
    expect(slug.countries).toEqual(['SAU']);
    expect(slug.url).toBe('https://www.who.int/emergencies/disease-outbreak-news/item/middle-east-respiratory-syndrome-coronavirus---kingdom-of-saudi-arabia');

    const byScope = new Map<string, number>();
    for (const r of run.records) byScope.set(String(r.attributes.locationScope), (byScope.get(String(r.attributes.locationScope)) ?? 0) + 1);
    expect(byScope.get('country')).toBeGreaterThan(25);
    expect(byScope.get('multi-country')).toBeGreaterThan(5);
    expect(byScope.get('global-or-regional')).toBeGreaterThan(10);
    expect(byScope.get('unresolved')).toBe(1); // "Chikungunya - La Réunion and Mayotte": territories outside the gazetteer
    for (const r of run.records) {
      const located = r.geometryKind === 'country';
      expect(located).toBe(r.countries.length > 0);
      expect(r.provenance.derived.includes('geometry')).toBe(located);
      expect(r.geometryKind === 'global' || located).toBe(true);
    }
  });

  it('stores only a short plain-text excerpt of the summary', async () => {
    const run = await runAdapterOnFixtures(adapter);
    for (const r of run.records) {
      expect(r.description).toBeTruthy();
      expect(r.description!.length).toBeLessThanOrEqual(EXCERPT_MAX);
      expect(r.description).not.toMatch(/<[a-z]/i);
      expect(JSON.stringify(r.attributes).length).toBeLessThan(600);
    }
    expect(run.records.some((r) => r.description!.endsWith('…'))).toBe(true);
  });

  it('infers the location only from the location part of the title', () => {
    const loc = (t: string) => {
      const l = locationFromTitle(t);
      return [l.scope, l.countries.join(','), l.topic];
    };
    expect(loc('Sudan virus disease – Uganda')).toEqual(['country', 'UGA', 'Sudan virus disease']);
    expect(loc('Crimean-Congo haemorrhagic fever - Iraq')).toEqual(['country', 'IRQ', 'Crimean-Congo haemorrhagic fever']);
    expect(loc('Marburg virus disease- Ethiopia')).toEqual(['country', 'ETH', 'Marburg virus disease']);
    expect(loc('Pneumonia of undetermined etiology - the Russian Federation')).toEqual(['country', 'RUS', 'Pneumonia of undetermined etiology']);
    expect(loc('Ebola disease caused by Bundibugyo virus, Democratic Republic of the Congo & Uganda')).toEqual(['multi-country', 'COD,UGA', 'Ebola disease caused by Bundibugyo virus']);
    expect(loc('Cholera - Bosnia and Herzegovina and Serbia')).toEqual(['multi-country', 'BIH,SRB', 'Cholera']);
    expect(loc('Mpox – Trinidad and Tobago')).toEqual(['country', 'TTO', 'Mpox']);
    expect(loc('Avian Influenza A(H5N1) - United States of America - update')).toEqual(['country', 'USA', 'Avian Influenza A(H5N1)']);
    expect(loc('Measles – Region of the Americas')).toEqual(['global-or-regional', '', 'Measles']);
    expect(loc('Cholera – Multi-country with a focus on countries experiencing current surges')).toEqual(['global-or-regional', '', 'Cholera']);
    expect(loc('Middle East respiratory syndrome coronavirus - Global update')).toEqual(['global-or-regional', '', 'Middle East respiratory syndrome coronavirus']);
    expect(loc('Seasonal influenza')).toEqual(['unresolved', '', 'Seasonal influenza']);
    expect(locationFromTitle('Dengue - Kenya and Atlantis').unresolvedParts).toBe(1);
  });

  it('rejects malformed items individually and sanitises hostile markup', async () => {
    const run = await runAdapterOnFixtures(adapter, { scenario: [{ source: adapter.manifest.id, fromRun: 1, effect: { variant: 'malformed' } }] });
    expect(run.records.map((r) => r.upstreamId).sort()).toEqual(['2026-DON901', '2026-DON902', '2026-DON909']);
    expect(run.rejected.map((r) => r.reason)).toEqual([
      'missing title',
      'unparseable publication time "32/13/2026"',
      'missing DonId and Id',
      'missing title',
      'item is not an object',
      'time: event occurredAt is in the future (2027-05-01T16:00:00.000Z)',
    ]);

    const ok = run.records.find((r) => r.upstreamId === '2026-DON901')!;
    expect(ok.title).toBe('Cholera - Haiti'); // the later duplicate of the same DonId is ignored
    expect(ok.countries).toEqual(['HTI']);
    expect(ok.occurredAt).toBe(Date.UTC(2026, 10, 3, 16, 30, 0));

    const hostile = run.records.find((r) => r.upstreamId === '2026-DON902')!;
    expect(hostile.title).toBe('Measles – Peru');
    expect(hostile.countries).toEqual(['PER']);
    expect(hostile.description).toBe('Authored test item with markup. Cases were reported in two provinces.');
    expect(hostile.occurredAt).toBe(Date.UTC(2026, 10, 1, 14, 0, 0)); // 16:00+02:00
    expect(hostile.url).toBe('https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON902'); // javascript: ItemDefaultUrl ignored

    const unresolved = run.records.find((r) => r.upstreamId === '2026-DON909')!;
    expect(unresolved.geometryKind).toBe('global'); // "Atlantis" is not a country; "Congo" in the disease name is not used
    expect(unresolved.countries).toEqual([]);
    expect(unresolved.attributes.locationScope).toBe('unresolved');
  });
});
