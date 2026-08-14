import { describe, expect, it } from "vitest";
import { resolveTimezoneFromPlace } from "@/lib/timezone/places";

function zone(city: string | null, state?: string | null, country?: string | null) {
  const result = resolveTimezoneFromPlace(city, state, country);
  return result.ok ? result.timezone : `refused:${result.reason}`;
}

describe("resolveTimezoneFromPlace", () => {
  it("reads a whole location string out of the city column", () => {
    // What the importer actually landed for these leads.
    expect(zone("Phoenix, Arizona, United States")).toBe("America/Phoenix");
    expect(zone("Maryvale, Arizona, United States")).toBe("America/Phoenix");
    expect(zone("Addison", "TX")).toBe("America/Chicago");
    expect(zone("Dallas", "Texas")).toBe("America/Chicago");
  });

  it("resolves a single-zone state without needing the city", () => {
    expect(zone("Some Village Nobody Listed", "Connecticut")).toBe("America/New_York");
    expect(zone(null, "CA")).toBe("America/Los_Angeles");
    expect(zone("Hilo", "HI")).toBe("Pacific/Honolulu");
  });

  it("refuses a split state whose city it does not know", () => {
    expect(zone(null, "Texas")).toBe("refused:split_state_unknown_city");
    expect(zone("Nowheresville", "Florida")).toBe("refused:split_state_unknown_city");
    expect(zone("Idaho City", "ID")).toBe("refused:split_state_unknown_city");
  });

  it("gets the wrong side of every boundary right", () => {
    expect(zone("El Paso", "TX")).toBe("America/Denver");
    expect(zone("Pensacola", "FL")).toBe("America/Chicago");
    expect(zone("Miami", "FL")).toBe("America/New_York");
    expect(zone("Knoxville", "TN")).toBe("America/New_York");
    expect(zone("Nashville", "TN")).toBe("America/Chicago");
    expect(zone("Coeur d'Alene", "ID")).toBe("America/Los_Angeles");
    expect(zone("Boise", "ID")).toBe("America/Denver");
    expect(zone("Gary", "IN")).toBe("America/Chicago");
    expect(zone("Indianapolis", "IN")).toBe("America/New_York");
    expect(zone("Bowling Green", "KY")).toBe("America/Chicago");
    expect(zone("Ontario", "OR")).toBe("America/Denver");
    expect(zone("Portland", "OR")).toBe("America/Los_Angeles");
    expect(zone("Rapid City", "SD")).toBe("America/Denver");
    expect(zone("Sioux Falls", "SD")).toBe("America/Chicago");
  });

  it("keeps Arizona's DST exception out of the Navajo Nation", () => {
    expect(zone("Tucson", "AZ")).toBe("America/Phoenix");
    // Page and Kayenta observe DST with the Navajo Nation. Unlisted on purpose.
    expect(zone("Page", "AZ")).toBe("refused:split_state_unknown_city");
    expect(zone("Kayenta", "Arizona")).toBe("refused:split_state_unknown_city");
  });

  it("never resolves a bare city whose name repeats", () => {
    expect(zone("Glendale")).toBe("refused:ambiguous_city");
    expect(zone("Portland")).toBe("refused:ambiguous_city");
    expect(zone("Springfield")).toBe("refused:ambiguous_city");
    expect(zone("Columbus")).toBe("refused:ambiguous_city");
  });

  it("resolves a bare city only when the name is unique here", () => {
    expect(zone("Maryvale")).toBe("America/Phoenix");
    expect(zone("Coeur d'Alene")).toBe("America/Los_Angeles");
  });

  it("refuses anything outside the US", () => {
    expect(zone("London", null, "GB")).toBe("refused:not_us");
    expect(zone("Toronto, Ontario, Canada", null, "CA")).toBe("refused:not_us");
  });

  it("refuses empty and unknown input", () => {
    expect(zone(null)).toBe("refused:no_location");
    expect(zone("")).toBe("refused:no_location");
    expect(zone("United States")).toBe("refused:no_location");
    expect(zone("Some Place")).toBe("refused:unknown");
  });

  it("survives the punctuation the imports carry", () => {
    expect(zone("  st. petersburg , florida , usa ")).toBe("America/New_York");
    expect(zone("Ft. Walton Beach, FL")).toBe("America/Chicago");
    expect(zone("PHOENIX, AZ")).toBe("America/Phoenix");
  });
});
