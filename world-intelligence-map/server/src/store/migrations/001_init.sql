-- Core record store. Spatial index: SQLite R*Tree on the record bounding box. Temporal index: (layer_id, t_start).
CREATE TABLE records (
  rowid         INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  upstream_id   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  layer_id      TEXT NOT NULL,
  domain        TEXT NOT NULL,
  category      TEXT NOT NULL,
  subcategory   TEXT,
  geom_kind     TEXT NOT NULL,
  geometry      TEXT,              -- GeoJSON geometry (null for country / global records)
  lon           REAL,              -- representative point
  lat           REAL,
  minx REAL, miny REAL, maxx REAL, maxy REAL,
  countries     TEXT NOT NULL DEFAULT '',   -- ISO3 codes, comma separated; first = primary
  country       TEXT,                       -- primary ISO3
  occurred_at   INTEGER,
  published_at  INTEGER,
  updated_at    INTEGER,
  fetched_at    INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  expires_at    INTEGER,
  t_start       INTEGER,           -- timeline interval; NULL = timeless reference data
  t_end         INTEGER,
  ongoing       INTEGER NOT NULL DEFAULT 0,
  ended_at      INTEGER,           -- set when a full-snapshot source no longer lists the record
  severity      INTEGER,
  severity_label TEXT,
  confidence    REAL,
  confidence_basis TEXT,
  uncertainty   TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  attributes    TEXT NOT NULL DEFAULT '{}',
  metric_name   TEXT,
  metric_value  REAL,
  metric_unit   TEXT,
  metric_period TEXT,
  url           TEXT,
  provenance    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  seen_run      INTEGER NOT NULL DEFAULT 0,  -- last ingestion run that listed this record (full-snapshot bookkeeping)
  track         TEXT,              -- accumulated recent positions for moving objects: [[lon,lat,t_ms],...]
  is_fixture    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX records_layer_time ON records(layer_id, t_start);
CREATE INDEX records_source ON records(source_id, fetched_at);
CREATE INDEX records_t_end ON records(t_end);
CREATE INDEX records_country ON records(country, layer_id);

CREATE VIRTUAL TABLE records_rtree USING rtree(rowid, minx, maxx, miny, maxy);

-- Full-text search over titles, descriptions and places (contentless, kept in sync by the store).
CREATE VIRTUAL TABLE records_fts USING fts5(title, description, extra, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');

CREATE TABLE source_state (
  source_id            TEXT PRIMARY KEY,
  last_attempt_at      INTEGER,
  last_success_at      INTEGER,
  last_error_at        INTEGER,
  last_error           TEXT,
  last_error_kind      TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  rate_limited_until   INTEGER,
  next_run_at          INTEGER,
  last_duration_ms     INTEGER,
  last_upstream_time   INTEGER,
  last_counts          TEXT,
  serving_stale_cache  INTEGER NOT NULL DEFAULT 0,
  total_runs           INTEGER NOT NULL DEFAULT 0,
  total_failures       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE ingest_runs (
  run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  outcome     TEXT NOT NULL,       -- ok | partial | failed | rate_limited | circuit_open | misconfigured | skipped
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  ended       INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL DEFAULT 0,
  reject_samples TEXT,
  error       TEXT,
  http_events TEXT
);
CREATE INDEX ingest_runs_source ON ingest_runs(source_id, started_at);

CREATE TABLE http_cache (
  cache_key     TEXT PRIMARY KEY,
  url           TEXT NOT NULL,     -- secrets redacted
  status        INTEGER NOT NULL,
  content_type  TEXT,
  etag          TEXT,
  last_modified TEXT,
  fetched_at    INTEGER NOT NULL,
  validated_at  INTEGER NOT NULL,
  body          BLOB NOT NULL
);

CREATE TABLE source_cursor (
  source_id TEXT NOT NULL,
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (source_id, key)
);

-- Conservative cross-source correlation. Original records are never modified or merged.
CREATE TABLE incidents (
  incident_id  TEXT PRIMARY KEY,
  class        TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  t_start      INTEGER,
  t_end        INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE incident_members (
  incident_id TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  basis       TEXT NOT NULL,       -- JSON: which rule linked it, distance, time difference
  PRIMARY KEY (incident_id, record_id)
);
CREATE INDEX incident_members_record ON incident_members(record_id);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
