/**
 * On-disk cache for fetched price sources.
 *
 * Price tables are large and change slowly, while `aiusage` may be run many
 * times a day. The cache also makes `--offline` meaningful: offline runs use the
 * cached table and refuse rather than silently reporting no cost at all.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type CacheEntry<T> = {
  fetchedAt: string;
  payload: T;
};

export type PriceCacheOptions = {
  dir: string;
  /** Entries older than this are refetched (unless offline). */
  maxAgeMs?: number;
  now?: () => Date;
};

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class PriceCache {
  private readonly dir: string;
  private readonly maxAgeMs: number;
  private readonly now: () => Date;

  constructor(options: PriceCacheOptions) {
    this.dir = options.dir;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? (() => new Date());
  }

  private path(name: string): string {
    return join(this.dir, `${name}.json`);
  }

  async read<T>(name: string): Promise<CacheEntry<T> | null> {
    try {
      const raw = await readFile(this.path(name), 'utf8');
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (typeof entry?.fetchedAt !== 'string' || entry.payload === undefined) return null;
      return entry;
    } catch {
      // A missing or corrupt cache is not an error — it just means "refetch".
      return null;
    }
  }

  isFresh(entry: CacheEntry<unknown>): boolean {
    const age = this.now().getTime() - new Date(entry.fetchedAt).getTime();
    return Number.isFinite(age) && age >= 0 && age < this.maxAgeMs;
  }

  async write<T>(name: string, payload: T): Promise<void> {
    const entry: CacheEntry<T> = { fetchedAt: this.now().toISOString(), payload };
    const target = this.path(name);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(entry), 'utf8');
    } catch {
      // Caching is best-effort; a read-only home directory must not fail a run.
    }
  }

  /**
   * Fresh cache → cached. Stale/missing → fetch, then cache. Offline → cached at
   * any age, or null so the caller can report the gap instead of guessing.
   */
  async resolve<T>(
    name: string,
    fetcher: () => Promise<T>,
    options: { offline: boolean },
  ): Promise<{ payload: T; fetchedAt: string; fromCache: boolean } | null> {
    const cached = await this.read<T>(name);
    if (cached && (options.offline || this.isFresh(cached))) {
      return { payload: cached.payload, fetchedAt: cached.fetchedAt, fromCache: true };
    }
    if (options.offline) return null;

    try {
      const payload = await fetcher();
      await this.write(name, payload);
      return { payload, fetchedAt: this.now().toISOString(), fromCache: false };
    } catch (error) {
      // A failed refresh falls back to a stale cache rather than losing pricing.
      if (cached) {
        return { payload: cached.payload, fetchedAt: cached.fetchedAt, fromCache: true };
      }
      throw error;
    }
  }
}
