// Every row of a query, past PostgREST's row cap.
//
// Supabase answers any API query with at most `max_rows` rows, 1000 by default
// on the hosted project and in supabase/config.toml, and a larger `.limit()` is
// clamped to it without an error: the caller simply gets a short array. For
// months this app asked for `.limit(5000)` and would have got 1000, and the
// places that would have noticed first are the ones that matter most: the
// reply poller's lead index (a reply it cannot match does not halt anything)
// and the planner's candidate list (a lead missing from it has its booked
// sends cancelled as "no longer sendable").
//
// Anything that needs a complete answer reads through selectAll(). Screens
// that show "the newest N" use selectUpTo(). Neither may be replaced with a
// bigger .limit(), because there is no bigger limit.

import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Rows per request. Must not exceed the project's `max_rows`: a page that
 * comes back short is read as the last one, so a server cap below this would
 * truncate exactly the way this file exists to prevent.
 */
export const PAGE_SIZE = 1000;

interface Page {
  data: unknown[] | null;
  error: PostgrestError | null;
}

interface KeysetQuery extends PromiseLike<Page> {
  gt(column: "id", value: string): KeysetQuery;
  order(column: "id", options: { ascending: boolean }): KeysetQuery;
  limit(count: number): KeysetQuery;
}

interface RangeQuery extends PromiseLike<Page> {
  range(from: number, to: number): RangeQuery;
}

export interface AllRows<Row> {
  data: Row[];
  error: PostgrestError | null;
}

/**
 * Every row the query matches, in `id` order.
 *
 * `query` builds a fresh query each call: select and filters, but no order,
 * range or limit, which this adds. The select list must include `id`.
 *
 * Keyset rather than offset, because the send path reads tables the
 * dispatcher is writing to at the same moment. An offset page shifts when a
 * row leaves the filter between two requests and silently skips its
 * neighbour; `id > last seen` cannot skip anything.
 *
 * A failed page returns the error alongside what was read so far. Callers on
 * the send path must treat that as "no answer", never as a short answer.
 */
export async function selectAll<Row extends { id: string }>(
  query: () => KeysetQuery,
): Promise<AllRows<Row>> {
  const rows: Row[] = [];
  let after: string | null = null;

  for (;;) {
    let page = query();
    if (after !== null) page = page.gt("id", after);
    const { data, error } = await page.order("id", { ascending: true }).limit(PAGE_SIZE);
    if (error) return { data: rows, error };

    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { data: rows, error: null };
    after = batch[batch.length - 1]!.id;
  }
}

/**
 * Up to `max` rows in the caller's own order, for a screen that shows the
 * newest N of something and never needed all of them.
 *
 * Offset pages, which can skip a row that moves while they are read. That is
 * acceptable for a list on a screen and is why nothing that decides whether an
 * email goes out may use this.
 */
export async function selectUpTo<Row>(
  query: () => RangeQuery,
  max: number,
): Promise<AllRows<Row>> {
  const rows: Row[] = [];

  for (let from = 0; from < max; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, max) - 1;
    const { data, error } = await query().range(from, to);
    if (error) return { data: rows, error };

    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < to - from + 1) break;
  }

  return { data: rows, error: null };
}
