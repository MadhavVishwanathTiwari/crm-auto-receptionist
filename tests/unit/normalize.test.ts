import { describe, expect, it } from "vitest";

import {
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  splitFullName,
} from "@/lib/normalize";
import {
  DOMAIN_VECTORS,
  EMAIL_VECTORS,
  PHONE_VECTORS,
} from "../fixtures/normalize-vectors";

describe("normalizeEmail", () => {
  for (const [input, expected] of EMAIL_VECTORS) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeEmail(input)).toBe(expected);
    });
  }

  it("collapses gmail aliases that differ only by dots and tags", () => {
    const forms = [
      "FirstLast@gmail.com",
      "first.last@gmail.com",
      "f.i.r.s.t.last+outreach@googlemail.com",
    ];
    const normalized = new Set(forms.map((f) => normalizeEmail(f)));
    expect(normalized.size).toBe(1);
  });
});

describe("normalizeDomain", () => {
  for (const [input, expected] of DOMAIN_VECTORS) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeDomain(input)).toBe(expected);
    });
  }
});

describe("normalizePhone", () => {
  for (const [input, expected] of PHONE_VECTORS) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizePhone(input)).toBe(expected);
    });
  }

  it("collapses every common US formatting of one number", () => {
    const forms = [
      "(602) 555-0142",
      "602.555.0142",
      "602 555 0142",
      "+1-602-555-0142",
      "16025550142",
    ];
    const normalized = new Set(forms.map((f) => normalizePhone(f)));
    expect(normalized).toEqual(new Set(["+16025550142"]));
  });
});

describe("splitFullName", () => {
  it("splits a plain two-part name", () => {
    expect(splitFullName("Gabe Martinez")).toMatchObject({
      firstName: "Gabe",
      middleName: null,
      lastName: "Martinez",
      suffix: null,
    });
  });

  it("keeps a middle initial out of the last name", () => {
    // The exact row in the sample Clay export that motivated this function.
    expect(splitFullName("Darrel S. Deokielal")).toMatchObject({
      firstName: "Darrel",
      middleName: "S.",
      lastName: "Deokielal",
      suffix: null,
    });
  });

  it("handles a single token", () => {
    expect(splitFullName("Gabe")).toMatchObject({
      firstName: "Gabe",
      lastName: null,
    });
  });

  it("extracts trailing suffixes", () => {
    expect(splitFullName("John Smith Jr.")).toMatchObject({
      firstName: "John",
      lastName: "Smith",
      suffix: "Jr.",
    });
    expect(splitFullName("Jane Doe, DDS")).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      suffix: "DDS",
    });
  });

  it("strips leading titles", () => {
    expect(splitFullName("Dr. Jane Doe")).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
    });
  });

  it("reverses surname-first form", () => {
    expect(splitFullName("Deokielal, Darrel")).toMatchObject({
      firstName: "Darrel",
      lastName: "Deokielal",
    });
  });

  it("keeps compound surnames together", () => {
    expect(splitFullName("Jan van der Berg")).toMatchObject({
      firstName: "Jan",
      lastName: "van der Berg",
    });
    expect(splitFullName("Maria de la Cruz")).toMatchObject({
      firstName: "Maria",
      lastName: "de la Cruz",
    });
  });

  it("returns all-null for empty input rather than empty strings", () => {
    for (const input of ["", "   ", null, undefined]) {
      expect(splitFullName(input)).toEqual({
        firstName: null,
        middleName: null,
        lastName: null,
        suffix: null,
      });
    }
  });
});
