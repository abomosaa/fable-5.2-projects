/**
 * SQLite database (node:sqlite) with forward-only SQL migrations.
 *
 * Why SQLite + R*Tree instead of PostGIS: the workload is bounding-box + time-range filtering of
 * point-dominated records, which the built-in R*Tree module serves well; an embedded database gives a
 * true one-command start with no services, hermetic tests and trivially reproducible fixture runs.
 * See README "Architecture" for limits and the migration path to PostGIS.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { serverRoot } from '../core/paths.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly writers = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -65536; PRAGMA busy_timeout = 5000;');
  }

  prepare(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }
  /**
   * Prepared write statement. Returns the number of changed rows.
   * Writes run in BigInt mode: node:sqlite otherwise throws when the connection's last-insert rowid does not fit a
   * JavaScript number, which happens with FTS5 (its internal segment rowids exceed 2^53). The rowid is never used –
   * statements that need a generated key use `RETURNING` with get().
   */
  writer(sql: string): (...params: SqlValue[]) => number {
    let s = this.writers.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      s.setReadBigInts(true);
      this.writers.set(sql, s);
    }
    const stmt = s;
    return (...params) => Number(stmt.run(...params).changes);
  }
  run(sql: string, ...params: SqlValue[]): { changes: number } {
    return { changes: this.writer(sql)(...params) };
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth--;
    }
  }
  close(): void {
    this.statements.clear();
    this.writers.clear();
    this.raw.close();
  }
}

export function migrationsDir(): string {
  return path.join(serverRoot(), 'src', 'store', 'migrations');
}

/** Apply pending migrations (files named NNN_name.sql, applied in order, each in a transaction). */
export function migrate(db: Db, dir = migrationsDir()): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.all<{ version: string }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(path.join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.run('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)', f, Date.now());
    });
    done.push(f);
  }
  return done;
}

export function openDatabase(file: string): Db {
  const db = new Db(file);
  migrate(db);
  return db;
}
