/**
 * Persistence boundary: best-lap records per track.
 *
 * Records are only ever written from server-validated lap times. The store
 * is an interface so a database-backed implementation can be dropped in; the
 * built-in ones keep records in memory or in a small JSON file.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NAME_MAX } from '../../../shared/constants';
import { sanitizeText, type TrackRecord } from '../../../shared/protocol';
import { isTrackId } from '../../../shared/sim/tracks';
import type { Logger } from '../util/logger';

export interface RecordsStore {
  all(): TrackRecord[];
  /** Stores the lap if it beats the current record. Returns true if it did. */
  submit(trackId: string, name: string, ms: number): boolean;
  /** Flushes pending writes (called on shutdown). */
  close(): Promise<void>;
}

const MIN_PLAUSIBLE_LAP_MS = 5_000;

export class MemoryRecordsStore implements RecordsStore {
  protected readonly records = new Map<string, TrackRecord>();

  all(): TrackRecord[] {
    return [...this.records.values()];
  }

  submit(trackId: string, name: string, ms: number): boolean {
    if (!isTrackId(trackId) || !Number.isInteger(ms) || ms < MIN_PLAUSIBLE_LAP_MS) return false;
    const current = this.records.get(trackId);
    if (current && current.ms <= ms) return false;
    this.records.set(trackId, { trackId, name: sanitizeText(name, NAME_MAX) || 'Driver', ms });
    this.changed();
    return true;
  }

  async close(): Promise<void> {}

  protected changed(): void {}
}

export class FileRecordsStore extends MemoryRecordsStore {
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    super();
  }

  /** Loads (and validates) existing records; a corrupt file is ignored. */
  static async open(file: string, logger: Logger): Promise<FileRecordsStore> {
    const store = new FileRecordsStore(file, logger);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const row of parsed.slice(0, 64)) {
          if (typeof row !== 'object' || row === null) continue;
          const { trackId, name, ms } = row as Record<string, unknown>;
          if (typeof trackId !== 'string' || typeof name !== 'string' || typeof ms !== 'number') continue;
          if (!isTrackId(trackId) || !Number.isInteger(ms) || ms < MIN_PLAUSIBLE_LAP_MS) continue;
          store.records.set(trackId, { trackId, name: sanitizeText(name, NAME_MAX) || 'Driver', ms });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('could not read records file, starting empty', { file, error: String(error) });
      }
    }
    return store;
  }

  protected override changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 1000);
    this.timer.unref();
  }

  private flush(): Promise<void> {
    const data = JSON.stringify(this.all(), null, 2);
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, data, 'utf8');
        await rename(tmp, this.file);
      } catch (error) {
        this.logger.warn('could not write records file', { file: this.file, error: String(error) });
      }
    });
    return this.writing;
  }

  override async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.flush();
    }
    await this.writing;
  }
}
