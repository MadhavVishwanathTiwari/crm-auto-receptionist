import { describe, expect, it } from "vitest";

import {
  clean,
  cleanConfidence,
  cleanEmail,
  cleanRating,
  cleanValue,
  cleanVerification,
} from "@/lib/csv/clean";
import {
  autoMapColumns,
  detectShape,
  mapRow,
  type ColumnMapping,
} from "@/lib/csv/mapping";
import { CsvParseError, detectHeaderRow, parseCsv } from "@/lib/csv/parse";

// Header lists taken verbatim from the brief.
const CLAY_HEADERS =
  "gmaps_url,city,phone,state,company_name,placeId,website,total_score,country_code," +
  "category_name,reviews_count,enrich_company,employee_count,company_linkedin," +
  "scrape_website,email_1,email_2,email_3,company_instagram,company_facebook," +
  "company_twitter,decision_maker_contact,full_name,title,personal_twitter," +
  "personal_facebook,personal_linkedin,personal_instagram,confidence,likely_email,work_email";

const LEGACY_HEADERS =
  "verification,status,lead_owner,tmz,ist_range,demo_txt,demo_web,lead_score," +
  "angle_type,first_touch,second_touch,third_touch,fourth_touch,notes,first_name," +
  "last_name,title,company_name,industry,gmaps_url,city,work_email,email_provider," +
  "phone,website,company_linkedin,company_instagram,company_facebook,company_twitter," +
  "personal_twitter,personal_facebook,personal_linkedin,personal_instagram";

describe("cleanValue", () => {
  it("drops a Clay failure marker entirely", () => {
    // Imported raw this becomes a company literally named "❌ Company Not Found".
    expect(cleanValue("❌ Company Not Found")).toEqual({
      value: null,
      cleaned: true,
    });
    expect(clean("❌ No website found")).toBeNull();
  });

  it("strips a Clay success marker and keeps the payload", () => {
    expect(clean("✅ http://acmehvac.com")).toBe("http://acmehvac.com");
    expect(clean("✅  Acme HVAC ")).toBe("Acme HVAC");
  });

  it("turns every flavour of nothing into null, never an empty string", () => {
    for (const junk of ["", "   ", "-", "N/A", "n/a", "#N/A", "null", "NONE", "not found"]) {
      expect(clean(junk), junk).toBeNull();
    }
    expect(clean(null)).toBeNull();
    expect(clean(undefined)).toBeNull();
  });

  it("leaves real values alone", () => {
    expect(clean("Acme HVAC")).toBe("Acme HVAC");
    expect(cleanValue("Acme HVAC").cleaned).toBe(false);
  });
});

describe("typed cleaners", () => {
  it("rejects non-addresses in an email column", () => {
    // The sample export had the literal word "Response" in decision_maker_contact.
    expect(cleanEmail("Response")).toBeNull();
    expect(cleanEmail("❌ Not Found")).toBeNull();
    expect(cleanEmail("Gabe@ExpertHVAC.com")).toBe("gabe@experthvac.com");
  });

  it("clamps ratings to a real Google range", () => {
    expect(cleanRating("4.7")).toBe(4.7);
    expect(cleanRating("5")).toBe(5);
    expect(cleanRating("0")).toBe(0);
    expect(cleanRating("9.9")).toBeNull();
    expect(cleanRating("-1")).toBeNull();
    expect(cleanRating("N/A")).toBeNull();
  });

  it("maps confidence and verification onto enums, defaulting to unknown", () => {
    expect(cleanConfidence("High")).toBe("high");
    expect(cleanConfidence("moderate")).toBe("medium");
    expect(cleanConfidence("banana")).toBe("unknown");
    expect(cleanConfidence("")).toBe("unknown");

    expect(cleanVerification("Verified")).toBe("verified");
    expect(cleanVerification("catch-all")).toBe("catch_all");
    expect(cleanVerification("bounced")).toBe("invalid");
    expect(cleanVerification("???")).toBe("unknown");
  });
});

describe("header row detection", () => {
  it("picks row 1 for a normal export", () => {
    expect(detectHeaderRow([["a", "b", "c"], ["1", "2", "3"]])).toBe(0);
  });

  it("skips a merged banner row", () => {
    // The legacy outreach sheet: a banner across row 1, real headers on row 2.
    const grid = [
      ["Outreach Management", "", "", ""],
      ["first_name", "last_name", "work_email", "company_name"],
      ["Gabe", "Martinez", "gabe@x.com", "X HVAC"],
    ];
    expect(detectHeaderRow(grid)).toBe(1);
  });

  it("parses a two-row-header file end to end", () => {
    const csv =
      "Outreach Management,,,\n" +
      "first_name,last_name,work_email,company_name\n" +
      "Gabe,Martinez,gabe@x.com,X HVAC\n";
    const parsed = parseCsv(csv);

    expect(parsed.headerRowIndex).toBe(1);
    expect(parsed.headers).toEqual([
      "first_name", "last_name", "work_email", "company_name",
    ]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.work_email).toBe("gabe@x.com");
  });

  it("honours an explicit header row override", () => {
    const csv = "a,b\nc,d\ne,f\n";
    expect(parseCsv(csv, 1).headers).toEqual(["c", "d"]);
  });

  it("names blank trailing headers instead of dropping the column", () => {
    const parsed = parseCsv("name,,email\nGabe,x,g@x.com\n");
    expect(parsed.headers).toEqual(["name", "column_2", "email"]);
    expect(parsed.rows[0]!.column_2).toBe("x");
  });

  it("refuses empty files and files with no data rows", () => {
    expect(() => parseCsv("")).toThrow(CsvParseError);
    expect(() => parseCsv("a,b,c\n")).toThrow(CsvParseError);
  });
});

describe("shape detection", () => {
  it("recognises both supported exports", () => {
    expect(detectShape(CLAY_HEADERS.split(","))).toBe("clay");
    expect(detectShape(LEGACY_HEADERS.split(","))).toBe("legacy_sheet");
    expect(detectShape(["name", "email"])).toBe("custom");
  });
});

describe("auto column mapping", () => {
  it("maps the Clay export, including the renames", () => {
    const mapping = autoMapColumns(CLAY_HEADERS.split(","));

    expect(mapping.place_id).toBe("placeId");
    expect(mapping.rating).toBe("total_score");
    expect(mapping.industry).toBe("category_name");
    expect(mapping.email_confidence).toBe("confidence");
    expect(mapping.work_email).toBe("work_email");
    expect(mapping.full_name).toBe("full_name");
    expect(mapping.gmaps_url).toBe("gmaps_url");
  });

  it("maps the legacy sheet", () => {
    const mapping = autoMapColumns(LEGACY_HEADERS.split(","));

    expect(mapping.first_name).toBe("first_name");
    expect(mapping.last_name).toBe("last_name");
    expect(mapping.work_email).toBe("work_email");
    expect(mapping.industry).toBe("industry");
    expect(mapping.email_provider).toBe("email_provider");
    expect(mapping.angle_type).toBe("angle_type");
  });

  it("never assigns one header to two fields", () => {
    // "email" must not simultaneously win work_email, email_1 and likely_email.
    const mapping = autoMapColumns(["email", "email_1", "likely_email"]);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
  });

  it("survives reordered columns", () => {
    const shuffled = CLAY_HEADERS.split(",").reverse();
    expect(autoMapColumns(shuffled).rating).toBe("total_score");
  });
});

describe("mapRow", () => {
  const mapping: ColumnMapping = {
    work_email: "work_email",
    company_name: "company_name",
    full_name: "full_name",
    rating: "total_score",
    industry: "category_name",
    website: "scrape_website",
    phone: "phone",
    email_confidence: "confidence",
    latitude: "latitude",
    longitude: "longitude",
  };

  it("maps and cleans a realistic Clay row", () => {
    const result = mapRow(
      {
        work_email: "Gabe@ExpertHVAC.com",
        company_name: "Expert HVAC Services",
        full_name: "Darrel S. Deokielal",
        total_score: "4.8",
        category_name: "HVAC contractor",
        scrape_website: "✅ http://www.experthvac.com",
        phone: "(602) 555-0142",
        confidence: "High",
        latitude: "33.4484",
        longitude: "-112.0740",
      },
      mapping,
    );

    expect(result.errors).toEqual([]);
    expect(result.values).toMatchObject({
      work_email: "gabe@experthvac.com",
      company_name: "Expert HVAC Services",
      first_name: "Darrel",
      last_name: "Deokielal",
      rating: 4.8,
      industry: "HVAC contractor",
      website: "http://www.experthvac.com", // ✅ prefix stripped
      email_confidence: "high",
      latitude: 33.4484,
      longitude: -112.074,
    });
  });

  it("records which fields were cleaned, for the import report", () => {
    const result = mapRow(
      {
        work_email: "a@b.com",
        company_name: "Acme",
        scrape_website: "❌ Company Not Found",
      },
      { ...mapping, website: "scrape_website" },
    );

    expect(result.values.website).toBeNull();
    expect(result.cleanedFields).toContain("website");
  });

  it("fails a row with no usable work_email", () => {
    const result = mapRow(
      { work_email: "Response", company_name: "Acme" },
      mapping,
    );
    expect(result.errors).toContain("no usable work_email");
  });

  it("prefers explicit name columns over a joined full_name", () => {
    const result = mapRow(
      {
        work_email: "a@b.com",
        company_name: "Acme",
        first_name: "Gabe",
        last_name: "Martinez",
        full_name: "Someone Else Entirely",
      },
      { ...mapping, first_name: "first_name", last_name: "last_name" },
    );

    expect(result.values.first_name).toBe("Gabe");
    expect(result.values.last_name).toBe("Martinez");
  });

  it("does not compute dedupe keys — those are generated columns", () => {
    const result = mapRow(
      { work_email: "a@b.com", company_name: "Acme", phone: "(602) 555-0142" },
      mapping,
    );

    // The database is the only thing that decides what a dedupe key is.
    expect(result.values).not.toHaveProperty("work_email_norm");
    expect(result.values).not.toHaveProperty("phone_e164");
    expect(result.values).not.toHaveProperty("website_domain");
  });
});
