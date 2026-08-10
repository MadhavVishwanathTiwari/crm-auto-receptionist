import { NextResponse } from "next/server";
import { z } from "zod";

import { previewCsv } from "@/lib/csv/commit";
import { CsvParseError } from "@/lib/csv/parse";
import { getOrgContext } from "@/lib/org";

// geo-tz and the Supabase SSR client both need Node, and the CSV parser uses
// Buffer to enforce its size limit.
export const runtime = "nodejs";

const Body = z.object({
  text: z.string().min(1),
  headerRowIndex: z.number().int().min(0).max(20).optional(),
  mapping: z.record(z.string(), z.string()).optional(),
});

/**
 * Parses an upload and reports what it found, without writing anything.
 *
 * Nothing is stored between preview and commit: the browser keeps the file text
 * and posts it again. That costs one extra upload of at most 10 MB and buys a
 * server with no import session state to expire, resume or clean up.
 */
export async function POST(request: Request) {
  // Middleware skips /api, so this route authenticates itself.
  const context = await getOrgContext();
  if (!context) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  try {
    return NextResponse.json(
      previewCsv(parsed.data.text, parsed.data.headerRowIndex, parsed.data.mapping),
    );
  } catch (error) {
    if (error instanceof CsvParseError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
