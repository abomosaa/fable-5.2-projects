import { describe, expect, it } from 'vitest';
import { countryAt, findCountryInText, toIso3 } from './countries.ts';
import { haversineKm, lineGeometry, normaliseGeometry, pointGeometry, representativePoint, simplifyLine, wrapLon } from './geo.ts';
import { decodeEntities, parseCsv, parseCsvObjects, plainText, safeUrl, stableStringify } from './text.ts';
import { fromEpochMillis, fromEpochSeconds, isSaneTime, parseTime, yearStart } from './time.ts';

describe('time parsing (everything becomes UTC epoch milliseconds)', () => {
  it('converts explicit offsets and Z', () => {
    expect(parseTime('2026-11-10T12:00:00Z')).toBe(Date.UTC(2026, 10, 10, 12));
    expect(parseTime('2026-11-10T12:00:00+02:00')).toBe(Date.UTC(2026, 10, 10, 10));
    expect(parseTime('2026-11-10T12:00:00-0930')).toBe(Date.UTC(2026, 10, 10, 21, 30));
    expect(parseTime('2026-11-10T07:15:00-05:00')).toBe(Date.UTC(2026, 10, 10, 12, 15));
    expect(parseTime('2026-11-10T23:30:00+05:45')).toBe(Date.UTC(2026, 10, 10, 17, 45)); // Nepal
    expect(parseTime('2026-11-10 12:00:00 UTC')).toBe(Date.UTC(2026, 10, 10, 12));
  });
  it('treats zone-less timestamps as UTC unless an offset is supplied', () => {
    expect(parseTime('2026-11-10T12:00:00')).toBe(Date.UTC(2026, 10, 10, 12));
    expect(parseTime('2026-11-10 12:00:00.250')).toBe(Date.UTC(2026, 10, 10, 12, 0, 0, 250));
    expect(parseTime('2026-11-10')).toBe(Date.UTC(2026, 10, 10));
    expect(parseTime('2026-11-10T12:00:00', { assumeOffsetMinutes: 120 })).toBe(Date.UTC(2026, 10, 10, 10));
  });
  it('parses RFC 822 and compact forms', () => {
    expect(parseTime('Tue, 10 Nov 2026 17:43:37 GMT')).toBe(Date.UTC(2026, 10, 10, 17, 43, 37));
    expect(parseTime('Tue, 10 Nov 2026 12:43:37 -0500')).toBe(Date.UTC(2026, 10, 10, 17, 43, 37));
    expect(parseTime('20261110174500')).toBe(Date.UTC(2026, 10, 10, 17, 45));
    expect(parseTime('20261110')).toBe(Date.UTC(2026, 10, 10));
  });
  it('returns null for garbage, impossible dates and non-strings', () => {
    for (const v of ['', '   ', 'yesterday', '2026-13-01', '2026-02-30T00:00:00Z', '12/11/2026', 1794355200000, null, undefined, {}]) expect(parseTime(v)).toBeNull();
  });
  it('makes numeric units explicit', () => {
    expect(fromEpochSeconds(1794355200)).toBe(1794355200000);
    expect(fromEpochSeconds('1794355200')).toBe(1794355200000);
    expect(fromEpochMillis(1794355200000)).toBe(1794355200000);
    expect(fromEpochSeconds('abc')).toBeNull();
    expect(fromEpochMillis(null)).toBeNull();
    expect(yearStart('2025')).toBe(Date.UTC(2025, 0, 1));
    expect(yearStart('next year')).toBeNull();
  });
  it('recognises implausible times', () => {
    const now = Date.UTC(2026, 10, 11);
    expect(isSaneTime(now, now)).toBe(true);
    expect(isSaneTime(Date.UTC(1700, 0, 1), now)).toBe(false);
    expect(isSaneTime(Date.UTC(2200, 0, 1), now)).toBe(false);
    expect(isSaneTime(NaN, now)).toBe(false);
  });
});

describe('coordinates and geometry', () => {
  it('rejects invalid coordinates and wraps longitudes beyond 180', () => {
    expect(pointGeometry(10, 91)).toBeNull();
    expect(pointGeometry(10, -90.01)).toBeNull();
    expect(pointGeometry(361, 0)).toBeNull();
    expect(pointGeometry('abc', 1)).toBeNull();
    expect(pointGeometry('', '')).toBeNull();
    expect(pointGeometry(null, 5)).toBeNull();
    expect(pointGeometry(NaN, 5)).toBeNull();
    expect(pointGeometry('12.5', '-7.25')).toEqual({ type: 'Point', coordinates: [12.5, -7.25] });
    expect(pointGeometry(190, 0)).toEqual({ type: 'Point', coordinates: [-170, 0] });
    expect(pointGeometry(359, 0)).toEqual({ type: 'Point', coordinates: [-1, 0] });
    expect(wrapLon(180)).toBe(180);
    expect(wrapLon(-180)).toBe(-180);
    expect(wrapLon(540)).toBe(180);
  });
  it('validates GeoJSON structure, closes rings, drops altitude and rounds', () => {
    const open = normaliseGeometry({ type: 'Polygon', coordinates: [[[0, 0, 100], [1.00000049, 0], [1, 1], [0, 1]]] });
    expect(open.ok).toBe(true);
    expect(open.geometry).toEqual({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] });
    expect(open.notes).toContain('closed open polygon ring');
    expect(normaliseGeometry({ type: 'Point', coordinates: [10, 95] })).toMatchObject({ ok: false, reason: 'latitude 95 out of range' });
    expect(normaliseGeometry({ type: 'Point', coordinates: [null, 5] }).ok).toBe(false);
    expect(normaliseGeometry({ type: 'Point', coordinates: ['a', 'b'] }).ok).toBe(false);
    expect(normaliseGeometry({ type: 'LineString', coordinates: [[0, 0]] }).ok).toBe(false);
    expect(normaliseGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] }).ok).toBe(false);
    expect(normaliseGeometry({ type: 'Circle', coordinates: [0, 0] }).ok).toBe(false);
    expect(normaliseGeometry(null).ok).toBe(false);
    expect(normaliseGeometry({ type: 'Point', coordinates: [200, 0] })).toMatchObject({ ok: true, geometry: { coordinates: [-160, 0] } });
  });
  it('picks sensible representative points', () => {
    expect(representativePoint({ type: 'Polygon', coordinates: [[[0, 0], [4, 0], [4, 2], [0, 2], [0, 0]]] })).toEqual([2, 1]);
    expect(representativePoint({ type: 'LineString', coordinates: [[0, 0], [5, 5], [10, 0]] }, 'track')).toEqual([10, 0]);
    expect(representativePoint({ type: 'LineString', coordinates: [[0, 0], [5, 5], [10, 0]] })).toEqual([5, 5]);
    // the centroid of the largest part wins for multi-polygons
    expect(representativePoint({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], [[[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]]] })).toEqual([15, 15]);
  });
  it('splits tracks at the antimeridian and simplifies lines', () => {
    const g = lineGeometry([[170, 0], [178, 1], [-178, 2], [-170, 3]]);
    expect(g).toEqual({ type: 'MultiLineString', coordinates: [[[170, 0], [178, 1]], [[-178, 2], [-170, 3]]] });
    expect(lineGeometry([[0, 0]])).toBeNull();
    expect(simplifyLine([[0, 0], [1, 0.001], [2, 0], [3, 5], [4, 0]], 0.1)).toEqual([[0, 0], [2, 0], [3, 5], [4, 0]]);
    expect(haversineKm([0, 0], [0, 1])).toBeCloseTo(111.2, 0);
  });
});

describe('country gazetteer', () => {
  it('normalises ISO codes, provider-specific codes and names to alpha-3', () => {
    expect(toIso3('US')).toBe('USA');
    expect(toIso3('usa')).toBe('USA');
    expect(toIso3('United States of America')).toBe('USA');
    expect(toIso3('XKX')).toBe('KOS');
    expect(toIso3('Türkiye')).toBe('TUR');
    expect(toIso3("Côte d'Ivoire")).toBe('CIV');
    expect(toIso3('Democratic Republic of the Congo')).toBe('COD');
    expect(toIso3('WLD')).toBeNull();
    expect(toIso3('')).toBeNull();
    expect(toIso3(42)).toBeNull();
  });
  it('locates points in countries and returns null over open ocean', () => {
    expect(countryAt(2.35, 48.86)).toBe('FRA');
    expect(countryAt(139.69, 35.69)).toBe('JPN');
    expect(countryAt(-58.38, -34.6)).toBe('ARG');
    expect(countryAt(-30, 0)).toBeNull();
  });
  it('finds a country named in free text on word boundaries only', () => {
    expect(findCountryInText('Cholera - Democratic Republic of the Congo')).toBe('COD');
    expect(findCountryInText('Avian Influenza A(H5N1) – United States of America')).toBe('USA');
    expect(findCountryInText('Marburg virus disease – Ethiopia')).toBe('ETH');
    expect(findCountryInText('Nigerian officials said')).toBeNull(); // "Niger" must not match inside "Nigerian"
    expect(findCountryInText('Multi-country outbreak of mpox')).toBeNull();
  });
});

describe('text sanitisation', () => {
  it('reduces HTML to plain text and removes active content', () => {
    expect(plainText('<p>Hello <b>world</b></p><script>alert(1)</script>')).toBe('Hello world');
    expect(plainText('a &lt;script&gt;alert(1)&lt;/script&gt; b')).toBe('a alert(1) b');
    expect(plainText('<img src=x onerror=alert(1)>caption')).toBe('caption');
    expect(plainText('tab\tand\nnewline   collapse')).toBe('tab and newline collapse');
    expect(plainText('x\u0000y‮z')).toBe('xyz');
    expect(plainText('abcdefghij', 5)).toBe('abcd…');
    expect(plainText(null)).toBe('');
    expect(decodeEntities('&amp;&#39;&#x41;&nbsp;&unknown;')).toBe("&'A &unknown;");
  });
  it('only lets http(s) links through', () => {
    expect(safeUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeUrl('http://example.org')).toBe('http://example.org/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', '/relative', 'ftp://x', 'https://user:pass@example.org/', '', null, 5]) expect(safeUrl(bad)).toBeNull();
  });
  it('parses RFC 4180 CSV', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",z\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', 'z']]);
    expect(parseCsvObjects('﻿id,name\n1,A\n2\n')).toEqual([{ id: '1', name: 'A' }, { id: '2', name: '' }]);
    expect(parseCsv('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('produces key-order-independent JSON for hashing', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(stableStringify({ a: [2, { d: 1 }], b: 1 }));
  });
});
