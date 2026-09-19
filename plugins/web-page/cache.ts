// The page cache: URL (+ selectors) keyed entries with a TTL, the conditional
// request inputs (ETag / Last-Modified) a plain HTTP revalidation needs, and a
// CONTENT HASH of the extracted markdown.
//
// The hash is what makes a repeat visit cheap: an unchanged page answers
// `unchanged since <hash>` (about 20 tokens) instead of the body. The hash is
// computed over the extracted markdown (what the caller would see), so a
// re-render that only changed markup noise does not churn the answer.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Outline } from './extract.ts'
import { PageError } from './errors.ts'
import { writeFileAtomic } from './spill.ts'

export interface CacheEntry {
  /** The cache key: URL + the selectors that scoped the read. */
  key: string
  /** The requested URL. */
  url: string
  /** The selectors of the read, when it used any. */
  selectors?: string[]
  /** The URL after redirects (what relative links resolve against). */
  finalUrl: string
  title: string
  markdown: string
  hash: string
  chars: number
  outline: Outline
  /** HTTP status of the render. */
  status: number
  /** Conditional-request inputs, when the response carried them. */
  etag?: string
  lastModified?: string
  /** ISO instant of the last successful fetch. */
  fetchedAt: string
}

/** What the cache says to do for a request. */
export type CacheDecision = 'hit' | 'revalidate' | 'render'

/** The `freshness` parameter of `page read`. */
export type Freshness = 'cache' | 'revalidate' | 'force'

/** The cache key: the URL plus the scope, so two scopes never collide. */
export function cacheKey(url: string, selectors?: string[]): string {
  const scope = (selectors ?? []).map((selector) => selector.trim()).filter((selector) => selector.length > 0).sort().join(',')
  return scope.length === 0 ? url : `${url}\u0000${scope}`
}

/** The CONTENT HASH of a markdown body: sha256 of its collapsed form. */
export function contentHash(markdown: string): string {
  const canonical = markdown.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

/** The file name of a cache entry (stable, filesystem safe). */
export function entryFileName(key: string): string {
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`
}

/** The short form a caller gets when nothing changed. */
export function unchangedAnswer(entry: CacheEntry, state: CacheDecision | 'revalidated', ageSeconds: number): Record<string, unknown> {
  return {
    status: 'unchanged',
    message: `unchanged since ${entry.hash}`,
    url: entry.url,
    finalUrl: entry.finalUrl,
    hash: entry.hash,
    chars: entry.chars,
    title: entry.title,
    cache: { state, ageSeconds },
  }
}

/** Seconds since the entry was fetched (never negative). */
export function ageSeconds(entry: CacheEntry, now: number = Date.now()): number {
  const fetched = Date.parse(entry.fetchedAt)
  if (!Number.isFinite(fetched)) return 0
  return Math.max(0, Math.floor((now - fetched) / 1000))
}

/** One entry per file under `dir`; every write is atomic. */
export class PageCache {
  readonly dir: string
  private readonly ttlSeconds: number

  constructor(dir: string, ttlSeconds: number) {
    this.dir = dir
    this.ttlSeconds = ttlSeconds
  }

  fileFor(key: string): string {
    return path.join(this.dir, entryFileName(key))
  }

  /** Read an entry; a corrupt entry is treated as absent (and reported). */
  async read(key: string): Promise<CacheEntry | undefined> {
    try {
      const text = await fs.promises.readFile(this.fileFor(key), 'utf8')
      const entry = JSON.parse(text) as CacheEntry
      if (typeof entry.hash !== 'string' || typeof entry.markdown !== 'string' || entry.key !== key) return undefined
      return entry
    } catch {
      return undefined
    }
  }

  /** Write an entry atomically. */
  async write(entry: CacheEntry): Promise<void> {
    try {
      await writeFileAtomic(this.fileFor(entry.key), JSON.stringify(entry, null, 2))
    } catch (error) {
      throw new PageError('cache', 'could not write the page cache', { url: entry.url, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The decision for a request: `force` always renders; `cache` is a hit while
   * the entry is younger than the TTL and a conditional revalidation after it;
   * `revalidate` asks the origin whether anything changed (falling back to a
   * render when the entry carried no ETag/Last-Modified).
   */
  decide(entry: CacheEntry | undefined, freshness: Freshness): CacheDecision {
    if (freshness === 'force') return 'render'
    if (entry === undefined) return 'render'
    const age = ageSeconds(entry)
    const stale = this.ttlSeconds <= 0 || age > this.ttlSeconds
    if (freshness === 'cache') return stale ? 'revalidate' : 'hit'
    return 'revalidate'
  }

  /** Whether a plain HTTP revalidation of this entry is possible. */
  canRevalidate(entry: CacheEntry | undefined): boolean {
    return entry !== undefined && (entry.etag !== undefined || entry.lastModified !== undefined)
  }
}
