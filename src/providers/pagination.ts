/**
 * Cursor pagination, shared by the two admin APIs that use it.
 *
 * OpenAI and Anthropic both page their usage and cost reports with
 * `has_more` + `next_page`, and both list objects with `has_more` + `last_id`.
 * Walking that by hand in four places is where an off-by-one page (silently
 * truncated usage) would hide, so it is written once.
 */

/** Safety net: a server that keeps handing back cursors must not loop forever. */
const DEFAULT_MAX_PAGES = 100;

export type PaginateOptions<TPage, TItem> = {
  /** Requests one page; `cursor` is undefined for the first. */
  fetchPage: (cursor: string | undefined) => Promise<TPage>;
  items: (page: TPage) => TItem[];
  /** The next cursor, or undefined when the API says it is done. */
  nextCursor: (page: TPage) => string | undefined;
  maxPages?: number;
};

export async function paginate<TPage, TItem>(
  options: PaginateOptions<TPage, TItem>,
): Promise<TItem[]> {
  const collected: TItem[] = [];
  let cursor: string | undefined;

  for (let index = 0; index < (options.maxPages ?? DEFAULT_MAX_PAGES); index += 1) {
    const page = await options.fetchPage(cursor);
    collected.push(...options.items(page));
    const next = options.nextCursor(page);
    if (next === undefined) return collected;
    cursor = next;
  }
  return collected;
}

/** `{ has_more, next_page }` — the usage and cost reports. */
export function pageCursor(page: {
  has_more?: boolean;
  next_page?: string | null;
}): string | undefined {
  return page.has_more && page.next_page ? page.next_page : undefined;
}

/** `{ has_more, last_id }` — the object list endpoints. */
export function idCursor(page: {
  has_more?: boolean;
  last_id?: string | null;
}): string | undefined {
  return page.has_more && page.last_id ? page.last_id : undefined;
}
