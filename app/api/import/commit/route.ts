import { NextResponse } from "next/server";
import { z } from "zod";

import { commitImport, ImportError } from "@/lib/csv/commit";
import { CsvParseError } from "@/lib/csv/parse";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";
// A 1000-row import does four lookups and a handful of chunked writes.
export const maxDuration = 60;

const Body = z.object({
  filename: z.string().min(1).max(255),
  text: z.string().min(1),
  headerRowIndex: z.number().int().min(0).max(20).optional(),
  mapping: z.record(z.string(), z.string()).optional(),
});

export async function POST(request: Request) {
  const context = await getOrgContext();
  if (!context) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Malformed request body." }, { status: 400 });
  }

  try {
    const result = await commitImport(context, {
      filename: parsed.data.filename,
      text: parsed.data.text,
      headerRowIndex: parsed.data.headerRowIndex,
      mapping: parsed.data.mapping,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CsvParseError || error instanceof ImportError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}
