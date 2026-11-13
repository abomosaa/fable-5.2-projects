# World Intelligence Map

A full-stack, public-source intelligence map: **40 independent public datasets** are ingested, validated and
normalised by a backend into one common geospatial record format and explored on a single interactive world map
(**80 independently toggleable layers in 10 domains**).

The browser never talks to a data provider. A Node.js server polls each source on its own schedule through a resilient,
allow-listed HTTP client, stores normalised records in a spatially and temporally indexed database, and serves viewport
queries, clusters, choropleth values, search and live updates to a MapLibre client.

```
npm install
npm run demo        # fixture mode  → http://localhost:8787   (no network, no keys; labelled FIXTURE DATA)
npm start           # live mode     → http://localhost:8787   (real sources; 33 need no credentials)
npm run verify      # type-check + all tests + production build + browser tests
```

Requires **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; developed on Node 26). No other services.

---

## Contents

1. [What you get](#what-you-get)
2. [Running it](#running-it)
3. [Fixture (demo) mode](#fixture-demo-mode)
4. [Live mode and credentials](#live-mode-and-credentials)
5. [Source inventory](#source-inventory)
6. [Licensing decisions](#licensing-decisions)
7. [Architecture](#architecture)
8. [The common record and provenance](#the-common-record-and-provenance)
9. [Freshness, staleness and source health](#freshness-staleness-and-source-health)
10. [Safety, privacy and security](#safety-privacy-and-security)
11. [Testing and verification](#testing-and-verification)
12. [Performance](#performance)
13. [Assumptions, substitutions and known limitations](#assumptions-substitutions-and-known-limitations)

---

## What you get

**Map** – MapLibre GL with a self-hosted Natural Earth basemap (works offline), smooth pan/zoom, server-side
clustering, heat maps for dense layers, polygons, lines, tracks of moving objects (rotated to their heading), and
country choropleths. Rendering adapts to zoom: clusters and density surfaces at world scale, individual symbols when
zoomed in; dense reference layers appear from a minimum zoom.

**Layer catalog** – searchable, grouped by domain, one switch per layer, a tri-state switch per domain, *All off*
(basemap only) and *Defaults*. Toggle state persists across reloads. A disabled layer is not requested, not rendered,
and contributes nothing to clusters, counts, legend, alerts, timeline or search.

**Legend** – lists exactly the enabled layers in the form they are currently drawn (symbol, line, area, heat ramp,
choropleth classes with values), with per-layer counts and any source problems affecting them.

**Timeline** – live mode with a look-back window; history mode with custom UTC range, quick ranges, scrubber, step,
play/pause at several speeds, cumulative or sliding-window playback, and a histogram of activity.

**Filters** – source, category, severity, confidence, freshness, country and free text; time on the timeline. Filters
apply uniformly to map, counts, legend, results and search.

**Results** – latest records or priority alerts (severe/extreme) in the current view; whole-world search; contents of
a cluster of co-located records.

**Detail drawer** – for every record: original source and deep link, event time, upstream update time, fetch time,
first seen, expiry, freshness with explanation, severity and confidence with their basis, which fields were *derived*
by this application, attribution and licence, upstream facts, possibly related reports from other sources, and full
provenance (ids, request URLs, adapter version, revision, content hash).

**Source health** – every source with status (healthy, delayed, rate limited, stale, unavailable, not configured,
pending, disabled), the reason in plain language, last success/attempt, next attempt, last run counts, and its
complete manifest (coverage, cadence, access, attribution, licence, limitations, retention, endpoints).

**Also** – shareable URLs (map position, time range and cursor, filters, layers, selection, theme), dark and light
themes, a colour-blind-safe palette (Okabe–Ito) with shape as a second channel, keyboard operation, screen-reader
labels, responsive layout with bottom sheets on phones, and explicit empty/loading/error states.

## Running it

| Command | What it does |
| --- | --- |
| `npm run demo` | Build, then start **fixture mode** on <http://localhost:8787>. |
| `npm start` | Build, then start **live mode** on <http://localhost:8787>. Reads `.env` if present. |
| `npm run dev` | Development: API with reload (fixture mode) + Vite dev server on <http://localhost:5173>. `-- --live` for real sources. |
| `npm run verify` | The one verification command (see [Testing](#testing-and-verification)). |
| `npm test` | Server and web unit/integration tests only. |
| `npm run test:e2e` | Browser tests (needs `npx playwright install chromium` once). |
| `npm run bench` | Ingestion and query benchmark → `docs/PERFORMANCE.md`. |
| `npm run manifest` | Regenerate `docs/sources.manifest.json` and `docs/SOURCES.md` from the adapter manifests. |

Server flags (also available as environment variables, see `.env.example`):
`--mode=live|fixture`, `--port=8787`, `--host=127.0.0.1`, `--db=<file>`, and for fixture mode
`--scenario=on|static|off`, `--volume=<n>`, `--stale-hold=<seconds>`.

**Docker** (optional – the application is a single process):

```
docker compose up --build                    # live mode
WIM_MODE=fixture docker compose up --build   # fixture mode
```

The image runs as a non-root user and keeps the live database in the `wim-data` volume.
*The Dockerfile and compose file were written but could not be executed on the development machine (no Docker
installed); `npm run demo` / `npm start` are the verified paths.*

## Fixture (demo) mode

`npm run demo` makes the complete product reviewable with **no API keys and no network**:

* Every one of the 40 adapters runs its **real `fetch` and `parse` code** against its bundled fixture through the real
  HTTP client, pipeline, database and API. Only the transport is replaced.
* The clock is simulated: it starts at **2026-11-11 00:00 UTC** on every run and advances in real time, so each run
  begins from an identical state.
* The data contains points, polygons, lines, tracks, country indicators with several years of history, overlapping
  incidents reported by several sources (e.g. the same earthquakes from USGS, EMSC and GDACS), and timestamps spread
  from minutes to years back.
* 45,000 generated VIIRS fire detections (in the exact FIRMS CSV format, parsed by the real adapter) bring the store to
  ~64,000 records; `--volume=` changes this.
* **It cannot be confused with live data:** a hazard-striped banner, a `FIXTURE` chip, a map watermark, a
  `FIXTURE RECORD · not live` tag and "Bundled fixture file (not a live request)" in every record's provenance, and
  `fixture: true` in the API.

A scripted scenario (keyed to ingestion run numbers, never to randomness) demonstrates failure handling. Open
**Sources** and watch:

| Source | What happens | What you see |
| --- | --- | --- |
| NOAA NHC | Last fetched in a simulated session 6 h earlier; not refreshed for the first 4 min | **Stale**; its storm is drawn dimmed, tagged "Stale source", then recovers |
| Cloudflare Radar | No credentials | **Not configured**, with setup instructions; everything else works |
| EMSC | HTTP 503 for two runs | **Delayed** (cached data kept), then healthy |
| NASA EONET | HTTP 429 with `Retry-After: 45` | **Rate limited** until that time, no requests meanwhile, then healthy |
| USGS | One payload with malformed and hostile records | 6 records rejected individually (see last-run counts), 2 valid ones ingested, text sanitised |
| Aviation SIGMET | Upstream never answers | Timeout, retried, then healthy |
| GDACS | Network errors for six runs | **Unavailable**, circuit breaker opens and stops calls, data kept, then recovery |

`--scenario=static` keeps only the first two rows (used by the browser tests); `--scenario=off` disables all of it.

## Live mode and credentials

`npm start` fetches real sources. **Live mode never substitutes generated or fixture data**: if a source fails, its
status says so and the map shows whatever was last fetched, flagged by age (or nothing, if nothing was ever fetched).

On 2026-11-10 a live run from the development machine fully ingested **32 of the 33 keyless default sources** within
about 100 seconds (≈39,000 records). The 33rd, the World Bank API, intermittently answered indicator requests with
HTTP 502 and was shown as *delayed – partially refreshed* with the indicators that did load. Upstream availability changes;
the Sources panel is the truth for your run.

Optional sources are reported as **Not configured** with instructions until their credential is set in `.env`
(copy `.env.example`):

| Variable | Source | How to get it |
| --- | --- | --- |
| `FIRMS_MAP_KEY` | NASA FIRMS active fires | Free key: <https://firms.modaps.eosdis.nasa.gov/api/map_key/> |
| `OPENAQ_API_KEY` | OpenAQ PM2.5 measurements | Free account: <https://explore.openaq.org/register> |
| `RELIEFWEB_APPNAME` | ReliefWeb disasters and headlines | Pre-approved app name: <https://apidoc.reliefweb.int/parameters#appname> |
| `HDX_APP_IDENTIFIER` | HDX HAPI (IDPs, people in need, food insecurity) | base64 of `app:email`, see <https://hdx-hapi.readthedocs.io/> |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Radar outage annotations | Token with *Account → Radar → Read* |
| `ACLED_EMAIL`, `ACLED_PASSWORD` | ACLED events (**opt-in**) | myACLED account; also add `acled` to `WIM_ENABLED_SOURCES` |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | OpenSky aircraft (**opt-in**, keys optional) | Add `opensky` to `WIM_ENABLED_SOURCES` |

Two sources are **opt-in** (`WIM_ENABLED_SOURCES=opensky,acled`) because their terms do not allow this use by default –
see [Licensing decisions](#licensing-decisions). Credentials are read from the server's environment only; they are
never sent to the browser, never stored in records, and are redacted from provenance URLs and logs.

## Source inventory

**40 sources · 80 layers · 10 domains · 34 sources need no credentials** (33 of those are enabled by default; OpenSky is keyless but opt-in).
The complete, generated inventory – endpoints, cadence, licence, limitations, confidence notes, retention and fixture
origin per source – is in **[docs/SOURCES.md](docs/SOURCES.md)**, machine-readable in
**[docs/sources.manifest.json](docs/sources.manifest.json)**, served at `/api/sources`, and shown in the Sources panel.

| Domain | Sources (layers) |
| --- | --- |
| **Natural hazards** | USGS earthquakes · EMSC earthquakes · GDACS (cyclones, floods, droughts, earthquakes, volcanoes, wildfires) · NASA EONET (wildfires, volcanoes, severe-storm tracks, sea ice, other) · NOAA NHC active storms · NOAA IBTrACS cyclone tracks · Smithsonian GVP Holocene volcanoes · Smithsonian/USGS weekly volcanic activity · NOAA tsunami bulletins · NASA FIRMS active fires 🔑 |
| **Weather & environment** | NWS alerts (warnings; watches & advisories) · Aviation Weather Center SIGMETs · Open-Meteo current weather (temperature, precipitation, strong wind) · Open-Meteo/CAMS air quality · OpenAQ PM2.5 🔑 |
| **Humanitarian** | UNHCR (refugees by origin, by asylum, IDPs) · ReliefWeb (disasters, headlines) 🔑 · HDX HAPI (IDPs, people in need, food insecurity) 🔑 |
| **Geopolitical events** | GDELT 2.0 events (conflict, protests, cooperation) · ACLED (violence, protests, strategic developments) 🔑 ⏻ |
| **Transportation** | OurAirports (large, medium airports) · Natural Earth seaports · Digitraffic AIS vessels (Baltic) · OpenSky aircraft ⏻ |
| **Connectivity & cyber** | OONI (web anomalies, confirmed blocking, messaging apps, circumvention tools) · IODA internet outages · RIPEstat routed prefixes · CISA Known Exploited Vulnerabilities · Cloudflare Radar outages 🔑 |
| **Energy & infrastructure** | WRI Global Power Plant Database (nuclear, fossil, hydro, renewable) · PeeringDB data centres |
| **Population, economy & health** | World Bank (population, GDP per capita, life expectancy, under-5 mortality, internet users, electricity access, inflation, unemployment) · WHO Disease Outbreak News |
| **Space** | CelesTrak satellites (stations, navigation, weather, Earth observation – positions computed with SGP4) · NOAA SWPC (aurora forecast, space-weather alerts) · Launch Library 2 upcoming launches · NASA/JPL fireballs |
| **Geographic context** | Natural Earth (populated places, disputed areas) · tectonic plate boundaries (Bird 2003) · UNESCO World Heritage sites |

🔑 credential required · ⏻ opt-in.

Every adapter directory (`server/src/adapters/<id>/`) contains a `manifest.json` with provider and dataset name,
documentation and source URLs, geographic and temporal coverage, update cadence, authentication, attribution, licence
and redistribution terms, limitations, confidence caveats and retention. Adding a source is described in
[docs/ADAPTERS.md](docs/ADAPTERS.md).

## Licensing decisions

"Publicly viewable" is not "freely redistributable". Each manifest records what the provider's current documentation
and terms say (read on 2026-11-10); the UI shows licence, redistribution status and a non-commercial flag per source.
Decisions taken:

* **Bundled fixtures are captured samples only where the terms permit redistribution** (public-domain and open
  licences, or non-commercial licences such as CC BY-NC-SA with attribution). For **RIPEstat** and **PeeringDB**
  (terms prohibit redistribution), **OpenSky** (no distribution to third parties) and **ACLED** (EULA), and for every
  source that needs a credential we did not have (FIRMS, OpenAQ, ReliefWeb, HDX HAPI, Cloudflare Radar), the fixtures
  are **synthetic**, authored from the documented response schema, and say so in `fixtures/index.json`.
* **OpenSky – opt-in.** Its terms limit use to non-profit research and education, forbid making the data available to
  third parties and require a written agreement for operational use. The adapter exists, is off by default and its
  fixture is synthetic.
* **ACLED – opt-in.** The EULA states that it is "not sufficient for Licensed Content to simply be … made available
  through the Licensee's own dashboard". The adapter is off by default and intended only for the account holder's
  private analysis on a non-public instance.
* **Submarine cables – not included.** TeleGeography's current terms do not grant reuse of the underlying data (the
  formerly CC-licensed repository is gone and the raw data is licensed commercially). No adapter was written; no data
  was downloaded.
* **Non-commercial sources** (Open-Meteo free tier, OONI, WHO, Smithsonian GVP, Cloudflare Radar, HDX HAPI, ReliefWeb,
  RIPEstat, PeeringDB; IODA flagged conservatively because it publishes no terms): a deployment for commercial purposes
  must disable them (`WIM_DISABLED_SOURCES`) or obtain permission. **Operating a public instance** needs the
  provider's permission for RIPEstat and PeeringDB.
* **Reports are never copied.** For ReliefWeb, WHO, GVP weekly reports, GDELT and similar, only the title, metadata, a
  short plain-text excerpt (≤ 300–500 characters) and a deep link to the original are stored.
* **Smithsonian GVP**: the terms page could not be read directly (browser challenge); the manifest says so and treats
  the data conservatively as non-commercial. Re-check before any commercial use.
* The basemap is Natural Earth (public domain); glyphs are Noto Sans (SIL OFL 1.1). No OpenStreetMap-derived data is
  included, so no ODbL obligations arise.

## Architecture

```
            ┌────────────────────────────── server (Node.js, one process) ──────────────────────────────┐
 upstream   │  Scheduler ──► Pipeline (per source, isolated)                                             │
 providers ◄┼─ ResilientHttp ◄─ adapter.fetch()        adapter.parse()  ──► normalise + validate ──►     │
 (40)       │  allowlist · timeout · retry+jitter       (pure)               (zod, coords, time, text)    │
            │  Retry-After · per-host spacing                                     │                      │
            │  circuit breaker · ETag/Last-Modified                               ▼                      │
            │  TTL cache · stale-if-error            RecordStore: idempotent upsert by stable id,         │
            │                                         snapshot bookkeeping, tracks, retention            │
            │                                                   │                                        │
            │                              SQLite (node:sqlite): records + R*Tree (bbox) + FTS5           │
            │                              (layer,time) index · incidents · source state · HTTP cache     │
            │                                                   │                                        │
            │  Correlator (conservative, links only) ◄──────────┤                                        │
            │                                                   ▼                                        │
            │  Fastify API: /api/features (viewport: clusters, density, shapes) · /api/choropleth         │
            │  /api/list · /api/histogram · /api/records/:id · /api/sources · /api/stream (SSE)            │
            └───────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                        ▼
                         React + MapLibre client (GeoJSON sources, WebGL layers, URL + localStorage state)
```

| Concern | Where | Notes |
| --- | --- | --- |
| Adapter interface, manifest schema, common record | `server/src/core/types.ts` | `SourceAdapter { manifest, version, fetch(ctx), parse(payloads, ctx) }`; `parse` is pure. |
| Registry | `server/src/adapters/registry.ts` | One line per source; exported to `docs/sources.manifest.json`. |
| Resilient HTTP | `server/src/http/client.ts` | Per-source host allowlist, timeouts, retries with full jitter, `Retry-After`, per-host spacing, three-state circuit breaker with growing cool-down, conditional requests, TTL cache, stale-if-error (copies keep their original fetch time). |
| Normalisation | `server/src/ingest/normalize.ts` | Schema validation, coordinate range/wrapping, ring closing, UTC epoch-ms times, HTML→text, http(s)-only links, country lookup, time interval per time model, content hash. |
| Pipeline | `server/src/ingest/pipeline.ts` | Never throws; one source's failure cannot affect another. Records malformed items individually. Partial refreshes are reported as such. |
| Scheduling | `server/src/ingest/scheduler.ts` | Per-source intervals, bounded concurrency, staggered start, exponential backoff, honours rate limits, periodic retention. |
| Dedup / idempotence | `server/src/store/records.ts` | Stable id `<source>:<upstream id>`; identical content only refreshes bookkeeping; changed content bumps `revision`. |
| Correlation | `server/src/ingest/correlate.ts` | Class-specific tight rules (e.g. earthquakes: 120 s, 100 km, ΔM ≤ 0.6; storms: same name), different sources only. Stored as links with their basis; originals untouched; always labelled an inference. |
| Queries | `server/src/store/queries.ts` | Bounding box (antimeridian-aware) via R*Tree, time ranges, layer/filter isolation, grid clustering in screen space, density cells, zoom-dependent simplification, latest-value choropleths, FTS search. |
| Migrations / retention | `server/src/store/migrations/*.sql`, `RecordStore.applyRetention` | Forward-only SQL migrations; explicit `retentionDays` per layer (null = reference data kept while upstream lists it). |
| Live updates | `/api/stream` | Server-sent events on every ingest; the client refreshes only if an enabled layer changed. |
| Client | `web/src` | Zustand store ↔ URL hash ↔ localStorage; requests carry viewport, zoom, layers, filters, time; obsolete requests are aborted and sequence-checked so stale responses cannot overwrite newer state. |

**Why SQLite instead of PostGIS.** The workload is bounding-box plus time-range filtering of mostly point records with
server-side aggregation, which SQLite's R*Tree and FTS5 modules cover well (see [Performance](#performance)). An
embedded database gives a real one-command start without containers, hermetic tests and exactly reproducible fixture
runs. Limits: one writer process, bounding-box rather than exact polygon intersection, no reprojection or spatial
joins. The store is behind two classes (`RecordStore`, `QueryEngine`) with plain SQL, so moving to PostGIS for a
multi-instance deployment means reimplementing those two files and the migrations.

## The common record and provenance

Every adapter emits `RecordDraft`s; the normaliser turns them into `IntelRecord`s (`server/src/core/types.ts`):

* **Identity** – internal id, upstream id, source id, layer id, domain, category, sub-category.
* **Geometry** – point, line, polygon, track, country-level or non-geographic ("global" bulletins); bounding box,
  representative point, ISO-3 countries.
* **Time** – occurred, published, updated (all upstream), fetched and first seen (ours), expiry, and a derived
  `[tStart, tEnd]` interval according to the layer's time model (event, interval, snapshot, reference, indicator).
* **Assessment** – severity 0–4 with the upstream wording, confidence 0–1 with a stated basis, uncertainty.
* **Content** – title, short description, flat upstream facts, optional metric (value, unit, period), source URL.
* **Provenance** – provider, dataset, adapter version, request URLs (secrets redacted), fetch time, first seen,
  revision, content hash, normalisation notes, fixture flag, and **`derived`: the list of fields this application
  inferred** rather than copied (e.g. `severity` mapped from a magnitude, `country` looked up from coordinates,
  `geometry` computed by orbit propagation). Derived values are marked in the UI; a missing confidence stays missing.

Correlation, geocoding, severity mapping and confidence mapping are therefore never presented as facts from a source.

## Freshness, staleness and source health

Each record has a freshness computed at query time from **upstream** times and fetch bookkeeping:

| Freshness | Meaning |
| --- | --- |
| fresh / recent / aging | Age of the upstream event time (events) or newest upstream update (everything else) relative to the layer's freshness window (≤ 1×, ≤ 4×, older). |
| stale | The source has not been fetched successfully within its `staleAfterSec`; the record could not be re-confirmed. |
| expired | Past its upstream expiry, closed upstream, or no longer listed in a complete snapshot. |
| reference | Timeless reference dataset. |

Stale and expired records are drawn dimmed, tagged in lists and explained in the drawer; they are never silently shown
as live. Snapshot layers (aircraft, vessels, satellites, current weather) additionally hide observations older than
the layer's `liveMaxAgeSec` in live mode. Source status is derived from the last attempts, the circuit breaker and the
staleness budget (`server/src/ingest/health.ts`).

## Safety, privacy and security

* Only documented public APIs, feeds and downloads. No HTML scraping, no bypassing of authentication, paywalls,
  robots rules or rate limits; provider fair-use rules are encoded per source (poll interval, request spacing, cache
  TTL – e.g. CelesTrak at most once per two hours with a self-imposed back-off after any error, Launch Library one
  call per hour).
* No personal data: no private accounts, addresses, faces, plates or dossiers. Aircraft and vessel identifiers are
  shown exactly as broadcast and are **never enriched** with owners, operators, occupants or registry lookups.
  ACLED/GDELT actor fields are organisation-level; GDELT actor names are not stored.
* Machine-coded and measurement-derived layers (GDELT, OONI anomalies, IODA signals, routed-prefix changes) are titled
  and described as reports/signals, with low or absent confidence and explicit caveats.
* Credentials live in the server environment, are sent only as the provider documents, never reach the browser, and
  are redacted from stored URLs. Token responses are never cached.
* **No URL proxy**: adapters can only request hosts on their manifest's allowlist (redirects included).
* Upstream payloads are schema-validated; all text is reduced to plain text server-side and rendered as text by React;
  links are restricted to `http(s)` and opened with `rel="noopener noreferrer"`.
* API hardening: strict parameter validation (400, never 500), per-client rate limiting, throttled manual refresh,
  Content-Security-Policy (`default-src 'self'`), `nosniff`, no-store on API responses. The server binds to
  `127.0.0.1` by default; there is no authentication, so put it behind your own access control before exposing it.

## Testing and verification

```
npx playwright install chromium   # once, for the browser tests
npm run verify                    # everything below; no internet, no secrets   (--skip-e2e to omit browser tests)
```

| Suite | Count | Covers |
| --- | --- | --- |
| Adapter tests (`server/src/adapters/*/adapter.test.ts`) | 40 files, 422 tests | Every adapter on deterministic fixtures: shared contract (valid manifest, allow-listed hosts only, valid records, determinism/idempotence, wholly malformed payloads, no credential leaks) plus source-specific facts: exact values, time zones, severity/confidence mapping, per-item reject reasons, pagination, credentials sent as documented. |
| Core (`server/src/core`, `ingest/normalize`) | 28 tests | Time parsing and zones, coordinates, geometry repair, antimeridian, gazetteer, sanitisation, CSV, schema validation, missing fields. |
| HTTP client (`server/src/http`) | 23 tests | Allowlist, retries and backoff, timeouts, `Retry-After`, request spacing, ETag/Last-Modified, TTL cache, stale-if-error, circuit breaker life-cycle and isolation, secret redaction. |
| Pipeline (`server/src/ingest/pipeline.test.ts`) | 24 tests | Deduplication, idempotent re-ingestion, updates, snapshot expiry and revival, tracks, retention, correlation (positive, negative, idempotent, dissolution), failure isolation, health transitions, stale data, rate limits, partial refresh, missing/rejected credentials, scheduler concurrency and planning. |
| Queries (`server/src/store/queries.test.ts`) | 24 tests | Layer isolation and all-layers-off, bounding boxes incl. antimeridian, time semantics per time model, every filter, search safety, clustering, density, zoom gating, choropleths, histogram, migrations. |
| Application (`server/src/app.test.ts`) | 22 tests | Real app in fixture mode through the HTTP API and database: all 40 sources ingest, **50,000-record volume scenario** with timing bounds, isolation, validation, no proxy, no secret leakage, idempotence, cross-source correlation, SSE, opt-in sources, and the scripted outage / rate-limit / malformed / timeout / breaker / stale / recovery scenario. |
| Web unit (`web/src`) | 4 tests | Shareable-URL encoding and decoding, hostile input. |
| End-to-end (`e2e/*.spec.ts`, Playwright + axe) | 28 tests | Fixture labelling, catalog search, toggles, group switches, all-off (no overlay features, no data requests), persistence across reloads, rapid toggling with out-of-order responses, zoom-dependent rendering with 50k records and zero DOM markers, viewport-only requests, search, priority alerts, drawer contents, map click, correlation links, filters, live/history/custom range, playback and pause, shareable URLs in a fresh browser context, stale and unconfigured sources, API failure with retry, WCAG A/AA audits in both themes and on mobile, keyboard operation, themes and palette, mobile layout. |

CI (`.github/workflows/ci.yml`) runs `npm run verify`.

## Performance

Measured by `npm run bench` on the development machine (Intel i7-14700K, Node 26, in-memory SQLite); full table in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

| Measurement (68,986 records: all fixtures + 50,000 generated detections) | Result |
| --- | --- |
| Complete fixture ingestion of 40 sources (fetch → parse → validate → upsert → index → correlate) | ≈ 5.1 s (≈ 13,600 records/s) |
| Idempotent re-ingestion of the same data | ≈ 3.2 s, 0 records changed |
| Whole world, all 80 layers, zoom 1.5 – 56,234 matching records → 1,687 features | ≈ 160 ms |
| Africa, all layers, zoom 3 – 21,463 records → 751 features | ≈ 53 ms |
| Regional viewport, zoom 6 – 3,706 records → 173 features | ≈ 9 ms |
| City-scale viewport, zoom 9 | < 1 ms |
| Whole world, default layers only | ≈ 1.5 ms |
| Full-text search | < 1 ms |

The client never renders DOM markers: all symbols, clusters, heat maps, lines and fills are WebGL layers fed by
viewport-sized GeoJSON; responses are Brotli/gzip-compressed.

## Assumptions, substitutions and known limitations

**Substitutions and omissions (and why)**

* **NGA World Port Index → Natural Earth ports.** The NGA API answered HTTP 503 (maintenance page) during
  development, so the seaport layer uses Natural Earth's ~1,080 ports (name and rank only – no harbour size, depth or
  facilities).
* **NASA FIRMS uses NOAA-20 VIIRS**, not Suomi NPP: NASA's documentation states that S-NPP no longer delivers new data.
* **Submarine cables** omitted for licensing reasons (above). **Pipelines and power grids** are not included: no
  suitably licensed global dataset with a documented API was identified in the time available.
* **OpenAQ** needs a key, so the keyless **Open-Meteo/CAMS air-quality** layer (modelled values, labelled as such) is
  provided next to it. **ReliefWeb** and **HDX HAPI** now require registered app identifiers and are therefore
  credential-backed; **UNHCR** covers displacement without credentials.
* **Copernicus** services and a commercial AIS provider were not integrated; AIS coverage is the open Finnish
  Digitraffic feed (Baltic Sea only).

**Known limitations**

* Verified against real upstreams once (2026-11-10) for the keyless sources; the nine credential-backed or opt-in
  adapters (FIRMS, OpenAQ, ReliefWeb, HDX HAPI, Cloudflare Radar, ACLED, OpenSky, plus the optional PeeringDB key and
  OpenSky OAuth) were built from provider documentation and **tested only against authored fixtures** – expect to
  adjust details when first run with real credentials.
* Upstream formats and terms change; several providers (World Bank, NGA) were intermittently failing during
  development. The app degrades per source rather than globally, but a changed format needs an adapter update.
* History exists only from when the server started ingesting (plus whatever look-back each feed offers); there is no
  back-fill of archives. Fixture mode offers the richest history.
* Country attribution of point records uses 1:50m Natural Earth polygons with a ~20 km near-shore tolerance and is
  marked *derived*; it can be wrong near borders and coasts. Viewport queries match bounding boxes, so large shapes
  may be returned slightly outside the view.
* Clusters mix layers (coloured by the most common one, composition in the tooltip). Only the most recently enabled
  indicator layer is drawn as a country fill; additional indicators are drawn as proportional circles.
* Correlation is deliberately conservative and incomplete; absence of a link means nothing.
* Single process, single writer; no user accounts or access control; SSE clients capped at 200. See the PostGIS note
  above for scaling out.
* The offline basemap is country polygons, borders and labels only (no terrain, roads or settlements as base tiles;
  populated places are available as a layer). Glyph ranges cover Latin, Greek and Cyrillic.
* The Docker path is untested on the development machine (see above).
* Timeline inputs and all displayed times are UTC.
