# Writing a source adapter

Every upstream dataset is integrated by one **source adapter**: a directory under
`server/src/adapters/<source-id>/` that contains

| File | Purpose |
| --- | --- |
| `manifest.json` | Machine-readable source manifest (provider, docs, endpoints, cadence, auth, attribution, licence, limitations, retention, layers). Validated by `SourceManifestSchema` in `server/src/core/types.ts`. |
| `adapter.ts` | Default export built with `defineAdapter({ manifest, version, fetch, parse })`. |
| `adapter.test.ts` | Vitest file: `adapterContractSuite(adapter, …)` plus source-specific assertions. |
| `fixtures/index.json` + files | Deterministic fixtures (captured from the live endpoint and trimmed, or authored from the documented schema when a credential is required). |

Reference implementations: `usgs-earthquakes` (GeoJSON point events), `worldbank-indicators` (multi-request country
indicators rendered as choropleths), `nasa-firms` (credential in the URL path, high-volume CSV), `acled` (OAuth,
pagination, opt-in), `celestrak` (computed positions, provider usage policy enforced in code).

## The contract

```ts
interface SourceAdapter {
  manifest: SourceManifest;            // loadManifest(manifestJson)
  version: string;                     // bump when parse semantics change
  fetch(ctx: FetchContext): Promise<FetchedPayload[]>;       // upstream requests, ONLY through ctx.http.get()
  parse(payloads: FetchedPayload[], ctx: ParseContext): ParseOutput;  // pure, no I/O
}
```

### fetch

* Use only `ctx.http.get(url, opts)`. It enforces the manifest's `allowedHosts`, timeouts, retries with jitter,
  `Retry-After`, per-host spacing, the circuit breaker, ETag/Last-Modified revalidation and the body cache.
  Never call `fetch()` directly, never read files, never use `Date.now()` (use `ctx.now`).
* Give each request a short `key` (e.g. the indicator code). `parse` receives payloads in the order returned.
* Credentials come from `ctx.env[NAME]` (declared in `manifest.auth.envVars`). Pass every secret that ends up in a URL
  via `opts.redact: [secret]`; pass header secrets via `opts.headers`. The pipeline does not call `fetch` at all when a
  required env var is missing (the source is reported as *misconfigured* with the manifest's setup text).
* Respect provider fair-use rules: set `updateCadence.pollIntervalSec`, `http.minIntervalMs` and `http.cacheTtlSec`
  in the manifest (or `cacheTtlSec` per request) so that slow-changing files are not re-downloaded needlessly.
* `ctx.cursor.get/set` persists small strings between runs (e.g. the last processed file name).
* Let errors propagate. Do not catch-and-ignore; failure isolation is the pipeline's job.
* Several **independent** requests (one per country, per indicator, …): use `getEach(ctx, requests)` from `base.ts`.
  A failed request is reported through `ctx.partialFailure` and the others are still ingested; the run is recorded as
  *partial*, the source is shown as *delayed – partially refreshed* and retried on the failure back-off. Do not use it
  when payloads are only meaningful together.
* Token or session responses: pass `noStore: true` so the body is never written to the persistent HTTP cache; keep the
  token in memory only (see `acled`).
* Sources whose terms do not permit this use by default set `"enabledByDefault": false` in the manifest. They stay off
  in live mode until the operator lists them in `WIM_ENABLED_SOURCES`; say why in `license.notes` and `auth.setup`.

### parse

* Pure function of the payloads. Deterministic. No clock other than `ctx.now`.
* A wholly malformed payload (not JSON, wrong top-level shape) → `throw new Error('malformed …')`
  (`jsonPayload(payload, shapeCheck, 'what')` does this). The run is then recorded as failed and existing data is kept.
* A single bad item must never abort the batch. Use `ParseCollector.item(raw, sample, fn)`: return a `RecordDraft`
  (or an array), or a **string reason** to reject that item. Exceptions thrown inside `fn` become rejects too.
* Skip things that are legitimately not records (aggregates, empty observations) silently; *reject* things that are broken.
* Call `out.noteUpstreamTime(ms)` with the payload's own generation/update timestamp when it has one.

### RecordDraft essentials (see `core/types.ts`)

* `upstreamId` – stable across fetches. If upstream has no id, build a deterministic composite (never an array index).
* `layerId` – one of the manifest's layers.
* `geometry` – GeoJSON in WGS84. Use `pointGeometry(lon, lat)` (returns null for invalid values → reject the item),
  `lineGeometry(positions)` (splits at the antimeridian), `bboxPolygon`. Omit geometry and set `country` for
  country-level facts; set `geometryKind: 'global'` (no geometry, no country) for non-geographic bulletins.
* Times are **epoch milliseconds**: `parseTime(isoOrRfc822String)`, `fromEpochSeconds`, `fromEpochMillis`, `yearStart`.
  `parseTime` treats zone-less ISO strings as UTC; pass `{ assumeOffsetMinutes }` when the source documents local time.
  Unparseable required time → reject the item.
* `severity` 0–4 (info, minor, moderate, severe, extreme) or null. Always keep the upstream wording in `severityLabel`.
  If *you* mapped a number/colour onto the scale, add `'severity'` to `derived`.
* `confidence` 0–1 or null, with a one-sentence `confidenceBasis`. If the source gives no basis, use null – do not invent one.
  If you mapped an upstream quality flag onto a number, add `'confidence'` to `derived`.
* `derived` – every field that this application inferred instead of copying (e.g. `'geometry'` when a country was
  geocoded from a title, `'country'`, `'severity'`). Inferred values are shown to users as inferred, never as facts.
* `title` + optional short `description` (plain text; a lawful excerpt of at most ~500 characters, never a full report)
  and `url` (deep link to the original item). `attributes` – flat upstream facts needed to interpret the record
  (numbers stay numbers; use clear camelCase names; include units in the name, e.g. `depthKm`).
* `metric` – `{ name, value, unit, period? }` for indicator / measurement layers (required for choropleth layers).

### Time models (per layer, in the manifest)

| `timeModel` | Meaning | Draft fields |
| --- | --- | --- |
| `event` | Instantaneous occurrence (earthquake, fireball). | `occurredAt` (must not be in the future) |
| `interval` | Active between a start and an end (alert, cyclone, outage, scheduled launch). | `occurredAt` (start; use the issue/update time for *future* scheduled items and put the scheduled time in attributes + `expiresAt`), `expiresAt` or `endedAt`, or `ongoing: true` while upstream still lists it as active |
| `snapshot` | Current state of a moving/changing thing (aircraft, vessel, satellite, current weather). | `occurredAt` = observation time; set `liveMaxAgeSec` on the layer |
| `reference` | Timeless reference data (airports, power plants). | none required |
| `indicator` | Periodic country statistic. | `occurredAt` = start of the period, `metric` |

`manifest.snapshot`: `"full"` means every successful fetch returns the complete current set, so records that disappear
are marked as ended by the pipeline; `"incremental"` means fetches only add or update.

**Moving objects:** emit the *current position* as a Point on a layer whose `render.type` is `"track"`.
The pipeline accumulates the recent path per object – adapters do not manage history.

### Layers

Each layer needs: `id` (globally unique, kebab-case), `name`, `description`, `domain`, `category`, `geometry`,
`timeModel`, `render` (`type`: point | heatmap | line | polygon | choropleth | track; `color`: one of the named slots;
`shape` for point symbols), `retentionDays` (explicit number, or `null` for reference data that is kept while upstream
lists it), and usually `freshForSec`. Split a dataset into several layers only when an analyst would genuinely want to
toggle the parts independently (e.g. nuclear vs. hydro plants) – not for cosmetic variations.
`defaultOn: true` only for a source's most important layer.

Domains: `hazards`, `weather`, `humanitarian`, `geopolitics`, `transport`, `cyber`, `infrastructure`, `society`, `space`, `reference`.
Colour slots: red, orange, yellow, green, teal, blue, purple, pink, brown, gray.
Shapes: circle, triangle, square, diamond, star, cross, hexagon, pentagon, plane, ship, satellite.
`correlationClass` (optional): earthquake, tropical_cyclone, wildfire, volcano, flood, drought, outage – lets the
correlator conservatively link reports of the same incident from different sources.

## Fixtures

`fixtures/index.json`:

```json
{
  "capturedAt": "2026-11-10T17:44:00Z",
  "notes": "How the fixture was obtained and trimmed.",
  "routes": [
    { "match": "/summary/2.5_week.geojson", "file": "2.5_week.geojson",
      "etag": "\"abc\"", "variants": { "malformed": "2.5_week.malformed.geojson" } }
  ]
}
```

* A request is answered by the first route whose `match` is a substring of the URL (or whose `regex` matches).
* Prefer a **captured** real response, trimmed to a representative sample (keep the envelope intact; keep edge cases).
  When a credential is required and none is available, **author** the fixture strictly from the provider's documented
  response schema and say so in `notes`.
* Budget: ≤ 400 KB per adapter (hard limit 1 MB). Enough records to be interesting on a world map; several timestamps.
* Provide a `malformed` variant for the main route: a syntactically valid payload in which individual items are broken
  in the ways that source can realistically break (missing geometry, out-of-range coordinates, bad dates, wrong types,
  hostile HTML in text), next to at least one valid item.
* The fixture world starts at `FIXTURE_EPOCH` = **2026-11-11T00:00:00Z** (`core/fixtureEpoch.ts`). All fixture timestamps
  must be earlier. For `snapshot` layers, re-time the fixture so that observation times fall within the ten minutes
  before the epoch (and say so in `notes`); for alerts, keep some that are still active at the epoch.
* Never put real credentials, personal data or anything not lawfully public in a fixture.

## Tests

```ts
adapterContractSuite(adapter, { minRecords: 50 });   // manifest, allowlist, validity, determinism, garbage payloads, no secret leaks
```

plus source-specific tests: exact values of at least one known fixture record (title, coordinates, times with the
correct time zone, severity/confidence mapping), the reject reasons for the `malformed` variant, and any special
behaviour (pagination, cursors, de-duplication, credentials sent as documented).

Run: `cd server && npx vitest run src/adapters/<source-id> && npx tsc --noEmit -p tsconfig.json`

## Rules for sources

* Documented public APIs, feeds (CAP/RSS/Atom/GeoJSON) or published downloads only. No HTML scraping, no bypassing
  authentication, paywalls, robots rules or rate limits.
* Read the provider's current documentation and terms. Record the licence honestly in the manifest
  (`redistribution`, `nonCommercialOnly`, notes). "Publicly viewable" does not mean "freely redistributable".
* No personal data. Aircraft and vessel identifiers are shown as broadcast; they are never enriched into owners,
  occupants or identities.
* If the terms do not allow redistributing captured responses, author a synthetic fixture instead (see `peeringdb`,
  `ripestat-routing`, `opensky`, `acled`).
* Register the adapter in `server/src/adapters/registry.ts`, add any new environment variable to `.env.example`
  (a test checks this), and run `npm run manifest` to regenerate `docs/SOURCES.md`.
