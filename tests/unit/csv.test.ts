import { describe, expect, it } from "vitest";

import {
  clean,
  cleanConfidence,
  cleanEmail,
  cleanRating,
  cleanValue,
  cleanVerification,
} from "@/lib/csv/clean";
import { previewCsv } from "@/lib/csv/commit";
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

// A later Clay export, verbatim from
// home_services_24_hour_Las_Vegas_NV_Run_1-upload-batch-1.csv. It differs from
// CLAY_HEADERS in two ways that both used to map wrong: the Google Maps link is
// called `url` rather than `gmaps_url`, and the decision maker's name and title
// are qualified with the enrichment step that produced them.
const RUN1_HEADERS =
  "url,city,phone,state,company_name,street,address,placeId,website,Scrape Website," +
  "Possible Phonenumbers,Valid Phonenumbers,Regioncode Phonenumbers,email_1,email_2," +
  "company_facebook,company_twitter,personal_facebook,latitude,company_linkedin," +
  "personal_linkedin,company_instagram,personal_instagram,longitude,postalCode," +
  "totalScore,countryCode,categoryName,reviewsCount,E164 Number Phonenumbers," +
  "Decision Maker,Use AI Person Name,Use AI Person Title,Use AI Confidence Reason," +
  "Use AI Status,Work Email";

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

  it("keeps both columns when a header name repeats", () => {
    // Rows are keyed by header name, so without this the first `email` column
    // is silently overwritten by the second and its values are simply gone.
    const parsed = parseCsv("email,name,email\na@x.com,Gabe,b@x.com\n");

    expect(parsed.headers).toEqual(["email", "name", "email (2)"]);
    expect(parsed.rows[0]!.email).toBe("a@x.com");
    expect(parsed.rows[0]!["email (2)"]).toBe("b@x.com");
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
    // `email_provider` satisfies work_email's `email` synonym as readily as its
    // own, so without the claim rule the send target would be an ESP name.
    const mapping = autoMapColumns(["email", "email_provider", "company"]);
    const used = Object.values(mapping);

    expect(new Set(used).size).toBe(used.length);
    expect(mapping.work_email).toBe("email");
    expect(mapping.email_provider).toBe("email_provider");
  });

  it("has nowhere to put a second address", () => {
    // 0034 dropped email_1/2/3 and likely_email. The columns still arrive in
    // real Clay exports; they must now land in "not imported" rather than in a
    // column nothing is allowed to read.
    const mapping = autoMapColumns(CLAY_HEADERS.split(","));

    expect(mapping.work_email).toBe("work_email");
    for (const field of ["email_1", "email_2", "email_3", "likely_email"]) {
      expect(mapping[field as keyof typeof mapping]).toBeUndefined();
    }
  });

  it("survives reordered columns", () => {
    const shuffled = CLAY_HEADERS.split(",").reverse();
    expect(autoMapColumns(shuffled).rating).toBe("total_score");
  });

  it("maps the later Clay export, whatever it renamed", () => {
    const mapping = autoMapColumns(RUN1_HEADERS.split(","));

    expect(mapping.work_email).toBe("Work Email");
    expect(mapping.place_id).toBe("placeId");
    expect(mapping.postal_code).toBe("postalCode");
    expect(mapping.rating).toBe("totalScore");
    expect(mapping.industry).toBe("categoryName");
    expect(mapping.reviews_count).toBe("reviewsCount");
    expect(mapping.title).toBe("Use AI Person Title");
    expect(mapping.full_name).toBe("Use AI Person Name");
  });

  it("gives `website` the real column and `url` the maps link", () => {
    // `url` is the first header in the file and used to win `website` outright,
    // which made website_domain `google.com` for every lead in the import.
    const mapping = autoMapColumns(RUN1_HEADERS.split(","));

    expect(mapping.website).toBe("website");
    expect(mapping.gmaps_url).toBe("url");
  });

  it("still gives `url` to website when it is the only thing on offer", () => {
    // The weak tier is a preference, not a ban: a bare CSV means the company
    // site by `url`, and website is listed before gmaps_url so it claims it.
    const mapping = autoMapColumns(["company_name", "work_email", "url"]);

    expect(mapping.website).toBe("url");
    expect(mapping.gmaps_url).toBeUndefined();
  });

  it("does not let a prose column win a typed enum", () => {
    // "confidence" is inside "Use AI Confidence Reason", which is a paragraph
    // explaining who the decision maker is, not high/medium/low.
    const mapping = autoMapColumns(RUN1_HEADERS.split(","));

    expect(mapping.email_confidence).toBeUndefined();
    // ...but an exact match is still an exact match.
    expect(autoMapColumns(CLAY_HEADERS.split(",")).email_confidence).toBe("confidence");
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

  it("splits the shapes a decision-maker column actually contains", () => {
    // Every one of these is a real value from the Las Vegas run.
    const split = (fullName: string) =>
      mapRow(
        { work_email: "a@b.com", company_name: "Acme", full_name: fullName },
        mapping,
      ).values;

    expect(split("Kenneth Melvin Ray Jr.")).toMatchObject({
      first_name: "Kenneth",
      middle_name: "Melvin",
      last_name: "Ray",
      name_suffix: "Jr.",
    });

    expect(split("Patrick W. Ledbetter")).toMatchObject({
      first_name: "Patrick",
      middle_name: "W.",
      last_name: "Ledbetter",
    });

    expect(split("Elizabeth Renteria-Cosio")).toMatchObject({
      first_name: "Elizabeth",
      last_name: "Renteria-Cosio",
    });

    // One-word names are common on a sole trader's site. A first name with no
    // surname is right; inventing one, or dropping the row, is not.
    expect(split("Sam")).toMatchObject({ first_name: "Sam", last_name: null });
  });

  it("lets an explicit middle or suffix column win over the splitter", () => {
    const result = mapRow(
      {
        work_email: "a@b.com",
        company_name: "Acme",
        full_name: "Kenneth Melvin Ray Jr.",
        middle_name: "Q.",
      },
      { ...mapping, middle_name: "middle_name" },
    );

    expect(result.values.middle_name).toBe("Q.");
    expect(result.values.name_suffix).toBe("Jr.");
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

describe("preview evidence", () => {
  // Two rows of the Las Vegas run, cut down to the columns that matter here.
  const CSV =
    "url,company_name,website,city,state,latitude,longitude,Use AI Person Name,Work Email\n" +
    "https://www.google.com/maps/search/?api=1&query=Red%20Rock,Red Rock Heating," +
    "https://www.redrockhvaclv.com/,Las Vegas,Nevada,36.16,-115.14,Travis Larson,tlarson@larsonairlv.com\n" +
    "https://www.google.com/maps/search/?api=1&query=Polar,Polar Inc.," +
    "https://mypolarair.com/,Las Vegas,Nevada,36.20,-115.25,Edward Sandoval,ed@mypolarair.com\n";

  it("reports what each column would become, not just its name", () => {
    const preview = previewCsv(CSV);

    expect(preview.fieldStats.website).toMatchObject({
      header: "website",
      filled: 2,
      total: 2,
    });
    expect(preview.fieldStats.website!.examples[0]).toBe(
      "https://www.redrockhvaclv.com/",
    );

    // full_name has no column of its own, so its evidence is what the splitter
    // made of it — which is the only way to see that the split worked.
    expect(preview.fieldStats.full_name!.examples[0]).toBe("Travis Larson");
  });

  it("names the columns it is dropping", () => {
    // `url` is claimed by gmaps_url here, so nothing is silently lost.
    expect(previewCsv(CSV).unmapped).toEqual([]);

    // "Decision Maker" holds the literal word "Response" in this export, so
    // nothing claims it — and the operator should be able to see that.
    expect(
      previewCsv("company_name,work_email,Decision Maker\nA,a@b.com,Response\n").unmapped,
    ).toEqual(["Decision Maker"]);
  });

  it("warns when website is pointed at a directory link", () => {
    const auto = previewCsv(CSV).mapping;
    expect(previewCsv(CSV).warnings.filter((w) => w.field === "website")).toEqual([]);

    const wrong = previewCsv(CSV, undefined, {
      ...auto,
      website: "url",
      gmaps_url: undefined,
    });
    expect(wrong.warnings.some((w) => w.field === "website")).toBe(true);
  });

  it("warns when nothing in the mapping can resolve a timezone", () => {
    // Qualified, importable, and permanently unschedulable. The whole point of
    // saying so here is that /queue is where it would otherwise surface.
    const bare = previewCsv(CSV, undefined, {
      work_email: "Work Email",
      company_name: "company_name",
    });

    expect(bare.warnings.some((w) => !w.field && /timezone/.test(w.message))).toBe(true);
    // Either route out of it is enough.
    for (const mapping of [
      { latitude: "latitude", longitude: "longitude" },
      { city: "city", state: "state" },
    ]) {
      const fixed = previewCsv(CSV, undefined, {
        work_email: "Work Email",
        company_name: "company_name",
        ...mapping,
      });
      expect(fixed.warnings.some((w) => !w.field && /timezone/.test(w.message))).toBe(false);
    }
  });

  it("stays quiet about empty columns that change nothing", () => {
    // A file with no Twitter handles is not a problem, and a warning nobody can
    // act on is what teaches people to stop reading the warnings.
    const csv = "company_name,work_email,city,state,website,company_twitter\n" +
      "Acme,a@b.com,Las Vegas,Nevada,https://acme.com,\n";
    const warnings = previewCsv(csv).warnings;

    expect(warnings.some((w) => w.field === "company_twitter")).toBe(false);
  });
});
