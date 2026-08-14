// Location text -> IANA timezone, for leads that arrived without coordinates.
//
// Non-negotiable 6 forbids a state->timezone table, and this is not one. The
// rule here is narrower and it is the whole point of the module:
//
//   * A state that lies entirely inside one zone resolves from the state alone.
//     Connecticut is Eastern in every square metre of it; that is a fact, not a
//     guess, and no DST edge case hides in it.
//   * A state that is split by a zone boundary - FL, TX, TN, ID, OR, KS, NE,
//     ND, SD, MI, IN, KY, AK, NV, and Arizona for its own reason - resolves
//     ONLY from a named city in the table below. There is no "most of the
//     state" fallback, because the whole failure mode being avoided is a lead
//     in Pensacola or the Idaho panhandle getting mailed at the wrong hour.
//   * A city with no state resolves only if its name occurs exactly once in
//     the table AND is not a name that repeats across America. "Glendale"
//     alone stays unresolved forever: Glendale AZ does not observe DST and
//     Glendale CA is three hours off the one the app would have picked.
//   * Anything outside the United States stays unresolved.
//
// An unresolved lead is not a failure. It sits in the manual queue, which is
// exactly where a lead we cannot place belongs.

export type PlaceResolution =
  | { ok: true; timezone: string; matched: "city" | "state" }
  | {
      ok: false;
      reason:
        | "no_location"
        | "not_us"
        | "ambiguous_city"
        | "split_state_unknown_city"
        | "unknown";
    };

const EASTERN = "America/New_York";
const CENTRAL = "America/Chicago";
const MOUNTAIN = "America/Denver";
const PACIFIC = "America/Los_Angeles";
const ARIZONA = "America/Phoenix";
const ALASKA = "America/Anchorage";
const HAWAII = "Pacific/Honolulu";

// Full name -> USPS code. Split states are present here too; being nameable is
// not the same as being resolvable.
const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", "washington dc": "DC", "washington d.c.": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
};

const STATE_CODE_SET = new Set(Object.values(STATE_CODES));

// States lying entirely within a single zone, with no in-state DST exception.
// Deliberately absent: AK, AZ, FL, ID, IN, KS, KY, MI, NE, NV, ND, OR, SD,
// TN, TX. Each of those is crossed by a boundary somewhere.
const SINGLE_ZONE_STATES: Record<string, string> = {
  CT: EASTERN, DE: EASTERN, DC: EASTERN, GA: EASTERN, ME: EASTERN,
  MD: EASTERN, MA: EASTERN, NH: EASTERN, NJ: EASTERN, NY: EASTERN,
  NC: EASTERN, OH: EASTERN, PA: EASTERN, RI: EASTERN, SC: EASTERN,
  VT: EASTERN, VA: EASTERN, WV: EASTERN,

  AL: CENTRAL, AR: CENTRAL, IL: CENTRAL, IA: CENTRAL, LA: CENTRAL,
  MN: CENTRAL, MS: CENTRAL, MO: CENTRAL, OK: CENTRAL, WI: CENTRAL,

  CO: MOUNTAIN, MT: MOUNTAIN, NM: MOUNTAIN, UT: MOUNTAIN, WY: MOUNTAIN,

  CA: PACIFIC, WA: PACIFIC,

  HI: HAWAII,
};

// Cities in the split states. A lead in a split state that is not on this list
// stays unresolved; adding a city is a one-line, reviewable change.
//
// Arizona is here rather than in the table above for a reason that costs an
// hour twice a year: the state does not observe DST, but the Navajo Nation
// inside it does. Page, Kayenta, Tuba City, Chinle and Window Rock are
// therefore deliberately NOT listed.
const CITY_ZONES: Record<string, Record<string, string>> = {
  AZ: zones(ARIZONA, [
    "phoenix", "maryvale", "glendale", "tucson", "mesa", "scottsdale",
    "chandler", "gilbert", "tempe", "peoria", "surprise", "goodyear",
    "avondale", "buckeye", "yuma", "flagstaff", "prescott", "prescott valley",
    "sedona", "casa grande", "sun city", "sun city west", "queen creek",
    "apache junction", "lake havasu city", "bullhead city", "kingman",
    "marana", "oro valley", "sierra vista", "anthem", "litchfield park",
    "el mirage", "tolleson", "fountain hills", "cave creek", "carefree",
    "paradise valley", "laveen", "ahwatukee", "gold canyon", "san tan valley",
    "chino valley", "cottonwood", "camp verde", "payson", "globe", "safford",
    "nogales", "douglas", "eloy", "coolidge", "maricopa", "wickenburg",
    "youngtown", "guadalupe", "tanque verde", "catalina foothills", "vail",
    "green valley", "sahuarita", "rio rico", "somerton", "san luis",
  ]),

  TX: zones(CENTRAL, [
    "houston", "dallas", "austin", "san antonio", "fort worth", "arlington",
    "plano", "addison", "irving", "garland", "frisco", "mckinney", "denton",
    "richardson", "carrollton", "lewisville", "allen", "grand prairie",
    "mesquite", "corpus christi", "laredo", "lubbock", "amarillo", "waco",
    "killeen", "college station", "round rock", "cedar park", "pflugerville",
    "georgetown", "san marcos", "new braunfels", "sugar land", "pearland",
    "the woodlands", "spring", "katy", "cypress", "conroe", "humble",
    "baytown", "pasadena", "league city", "galveston", "beaumont", "tyler",
    "longview", "abilene", "san angelo", "midland", "odessa", "wichita falls",
    "temple", "bryan", "victoria", "harlingen", "mcallen", "brownsville",
    "edinburg", "mission", "pharr", "weslaco", "kyle", "leander", "buda",
    "mansfield", "burleson", "cleburne", "waxahachie", "rockwall", "wylie",
    "sherman", "denison", "texarkana", "nacogdoches", "lufkin", "huntsville",
    // El Paso and its neighbours are Mountain. Listed explicitly, never
    // inherited from "Texas is Central".
  ]),
  TXM: zones(MOUNTAIN, ["el paso", "socorro", "horizon city", "fabens"]),

  FL: zones(EASTERN, [
    "miami", "orlando", "tampa", "jacksonville", "st petersburg",
    "saint petersburg", "hialeah", "fort lauderdale", "port st lucie",
    "cape coral", "tallahassee", "sarasota", "naples", "fort myers",
    "clearwater", "brandon", "lakeland", "palm bay", "melbourne", "kissimmee",
    "boca raton", "west palm beach", "delray beach", "boynton beach",
    "pompano beach", "hollywood", "miramar", "coral springs", "davie",
    "plantation", "sunrise", "pembroke pines", "doral", "kendall", "homestead",
    "gainesville", "ocala", "daytona beach", "deltona", "sanford", "altamonte springs",
    "winter park", "winter garden", "apopka", "clermont", "leesburg",
    "spring hill", "new port richey", "largo", "pinellas park", "bradenton",
    "venice", "port charlotte", "punta gorda", "bonita springs", "estero",
    "jupiter", "stuart", "vero beach", "port saint lucie", "wellington",
    "coral gables", "aventura", "weston", "parkland", "deerfield beach",
    // The western panhandle is Central: Pensacola, Panama City, Destin.
  ]),
  FLC: zones(CENTRAL, [
    "pensacola", "panama city", "panama city beach", "destin",
    "fort walton beach", "navarre", "crestview", "niceville", "gulf breeze",
    "milton", "marianna", "defuniak springs",
  ]),

  TN: zones(CENTRAL, [
    "nashville", "memphis", "clarksville", "murfreesboro", "franklin",
    "jackson", "hendersonville", "smyrna", "brentwood", "columbia",
    "spring hill", "gallatin", "mount juliet", "lebanon", "cookeville",
    "dickson", "shelbyville", "tullahoma", "germantown", "collierville",
    "bartlett", "cordova", "millington", "la vergne", "goodlettsville",
  ]),
  TNE: zones(EASTERN, [
    "knoxville", "chattanooga", "kingsport", "johnson city", "bristol",
    "cleveland", "morristown", "maryville", "oak ridge", "sevierville",
    "gatlinburg", "athens", "greeneville", "farragut", "alcoa", "elizabethton",
  ]),

  KY: zones(EASTERN, [
    "louisville", "lexington", "frankfort", "richmond", "georgetown",
    "nicholasville", "florence", "covington", "newport", "independence",
    "erlanger", "danville", "winchester", "berea", "somerset", "london",
    "corbin", "pikeville", "ashland", "maysville", "shelbyville", "shepherdsville",
    "elizabethtown", "bardstown", "mount washington", "jeffersontown",
    "st matthews", "middletown", "fern creek", "okolona", "radcliff",
  ]),
  KYC: zones(CENTRAL, [
    "bowling green", "owensboro", "paducah", "henderson", "hopkinsville",
    "madisonville", "murray", "mayfield", "central city", "franklin",
  ]),

  IN: zones(EASTERN, [
    "indianapolis", "fort wayne", "carmel", "fishers", "noblesville",
    "westfield", "greenwood", "zionsville", "brownsburg", "avon", "plainfield",
    "lawrence", "anderson", "muncie", "kokomo", "marion", "columbus",
    "bloomington", "terre haute", "lafayette", "west lafayette", "elkhart",
    "goshen", "south bend", "mishawaka", "richmond", "new albany",
    "jeffersonville", "clarksville", "greenfield", "franklin", "shelbyville",
  ]),
  INC: zones(CENTRAL, [
    "gary", "hammond", "merrillville", "crown point", "valparaiso", "portage",
    "michigan city", "schererville", "highland", "munster", "st john",
    "evansville", "newburgh", "boonville", "jasper", "vincennes",
  ]),

  MI: zones(EASTERN, [
    "detroit", "grand rapids", "warren", "sterling heights", "ann arbor",
    "lansing", "east lansing", "flint", "dearborn", "livonia", "troy",
    "westland", "farmington hills", "kalamazoo", "wyoming", "southfield",
    "rochester hills", "taylor", "saginaw", "pontiac", "novi", "royal oak",
    "battle creek", "portage", "midland", "muskegon", "holland", "jackson",
    "bay city", "traverse city", "petoskey", "alpena", "marquette",
    "canton", "clinton township", "macomb", "shelby township", "novi",
  ]),
  MIC: zones(CENTRAL, ["iron mountain", "menominee", "ironwood", "bessemer"]),

  OR: zones(PACIFIC, [
    "portland", "eugene", "salem", "gresham", "hillsboro", "beaverton",
    "bend", "medford", "springfield", "corvallis", "albany", "tigard",
    "lake oswego", "keizer", "grants pass", "oregon city", "mcminnville",
    "redmond", "tualatin", "west linn", "woodburn", "forest grove",
    "newberg", "wilsonville", "roseburg", "klamath falls", "ashland",
    "milwaukie", "sherwood", "happy valley", "central point", "canby",
    "hermiston", "pendleton", "the dalles", "coos bay", "st helens",
    // Malheur County (Ontario, Nyssa, Vale) is Mountain.
  ]),
  ORM: zones(MOUNTAIN, ["ontario", "nyssa", "vale", "jordan valley"]),

  ID: zones(MOUNTAIN, [
    "boise", "meridian", "nampa", "idaho falls", "pocatello", "caldwell",
    "twin falls", "rexburg", "eagle", "kuna", "ammon", "chubbuck",
    "mountain home", "blackfoot", "burley", "jerome", "hailey", "ketchum",
    "rigby", "star", "middleton", "emmett", "payette", "weiser", "salmon",
    "rupert", "preston", "montpelier", "driggs", "victor", "sun valley",
  ]),
  IDP: zones(PACIFIC, [
    "coeur d'alene", "coeur dalene", "post falls", "hayden", "sandpoint",
    "rathdrum", "moscow", "lewiston", "bonners ferry", "kellogg", "orofino",
    "grangeville", "priest river",
  ]),

  KS: zones(CENTRAL, [
    "wichita", "overland park", "kansas city", "olathe", "topeka", "lawrence",
    "shawnee", "lenexa", "manhattan", "salina", "hutchinson", "leavenworth",
    "leawood", "prairie village", "emporia", "junction city", "derby",
    "gardner", "great bend", "dodge city", "garden city", "liberal",
    "newton", "mcpherson", "el dorado", "pittsburg", "hays", "ottawa",
    // Four far-western counties (Sharon Springs, Tribune, St Francis) are Mountain.
  ]),
  KSM: zones(MOUNTAIN, ["sharon springs", "tribune", "st francis", "goodland"]),

  NE: zones(CENTRAL, [
    "omaha", "lincoln", "bellevue", "grand island", "kearney", "fremont",
    "hastings", "norfolk", "papillion", "la vista", "columbus", "north platte",
    "seward", "york", "beatrice", "lexington", "gretna", "elkhorn", "blair",
  ]),
  NEM: zones(MOUNTAIN, ["scottsbluff", "gering", "sidney", "chadron", "alliance", "ogallala"]),

  ND: zones(CENTRAL, [
    "fargo", "bismarck", "grand forks", "minot", "west fargo", "mandan",
    "jamestown", "wahpeton", "devils lake", "valley city", "williston",
  ]),
  NDM: zones(MOUNTAIN, ["dickinson", "beach", "hettinger", "bowman"]),

  SD: zones(CENTRAL, [
    "sioux falls", "brookings", "watertown", "aberdeen", "mitchell", "yankton",
    "huron", "pierre", "vermillion", "madison", "brandon", "harrisburg",
  ]),
  SDM: zones(MOUNTAIN, ["rapid city", "spearfish", "sturgis", "belle fourche", "custer", "hot springs"]),

  NV: zones(PACIFIC, [
    "las vegas", "north las vegas", "henderson", "reno", "sparks",
    "carson city", "paradise", "enterprise", "spring valley", "sunrise manor",
    "summerlin", "elko", "mesquite", "pahrump", "fernley", "winnemucca",
    "boulder city", "fallon", "ely", "carlin", "dayton", "gardnerville",
    "minden", "laughlin", "logandale", "moapa valley", "indian springs",
    // West Wendover is Mountain, and is not listed.
  ]),

  AK: zones(ALASKA, [
    "anchorage", "fairbanks", "juneau", "wasilla", "sitka", "ketchikan",
    "kenai", "soldotna", "palmer", "homer", "kodiak", "bethel", "barrow",
    "utqiagvik", "nome", "valdez", "seward", "eagle river", "north pole",
    "petersburg", "wrangell", "cordova", "dillingham", "haines", "skagway",
  ]),
};

function zones(zone: string, cities: string[]): Record<string, string> {
  return Object.fromEntries(cities.map((city) => [city, zone]));
}

// The split states, and which pseudo-keys above hold their cities. A state in
// this map NEVER resolves from the state alone.
const SPLIT_STATE_KEYS: Record<string, string[]> = {
  AZ: ["AZ"],
  TX: ["TX", "TXM"],
  FL: ["FL", "FLC"],
  TN: ["TN", "TNE"],
  KY: ["KY", "KYC"],
  IN: ["IN", "INC"],
  MI: ["MI", "MIC"],
  OR: ["OR", "ORM"],
  ID: ["ID", "IDP"],
  KS: ["KS", "KSM"],
  NE: ["NE", "NEM"],
  ND: ["ND", "NDM"],
  SD: ["SD", "SDM"],
  NV: ["NV"],
  AK: ["AK"],
};

// Names that name several American towns in different zones. A bare city that
// is on this list is refused even if this file happens to list it only once,
// because the file being incomplete is not evidence that the name is unique.
const AMBIGUOUS_CITY_NAMES = new Set([
  "portland", "springfield", "columbus", "columbia", "kansas city", "jackson",
  "franklin", "glendale", "aurora", "richmond", "salem", "bristol",
  "charleston", "dover", "athens", "manchester", "arlington", "alexandria",
  "lebanon", "marion", "newport", "union", "clinton", "georgetown",
  "hamilton", "madison", "milton", "oxford", "winchester", "danville",
  "greenville", "florence", "lancaster", "warren", "washington", "wilmington",
  "canton", "cleveland", "clarksville", "shelbyville", "spring hill",
  "peoria", "pasadena", "sunrise", "hollywood", "ontario", "portage",
  "wyoming", "eugene", "midland", "monroe", "auburn", "burlington", "concord",
  "dayton", "fairfield", "greenwood", "henderson", "jamestown", "lexington",
  "lima", "logan", "mesquite", "milford", "norwalk", "plymouth", "rochester",
  "salisbury", "sidney", "somerset", "troy", "york",
]);

// city name -> the zones this file assigns it. Built once.
const CITY_INDEX: Map<string, Set<string>> = (() => {
  const index = new Map<string, Set<string>>();
  for (const table of Object.values(CITY_ZONES)) {
    for (const [city, zone] of Object.entries(table)) {
      let set = index.get(city);
      if (!set) index.set(city, (set = new Set()));
      set.add(zone);
    }
  }
  return index;
})();

const COUNTRY_TOKENS = new Set([
  "united states", "united states of america", "usa", "us", "u s", "u s a",
  "america",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    // strip combining marks left by NFKD (U+0300-U+036F)
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.]/g, "")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bft\b/g, "fort")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve a zone from whatever location text a lead carries.
 *
 * `city` may be a bare city, or the whole "Phoenix, Arizona, United States"
 * string the importer sometimes lands there when the source had one column for
 * the lot. `state` and `countryCode` are used when present and ignored when
 * they disagree with a more specific signal in the string.
 */
export function resolveTimezoneFromPlace(
  city: string | null | undefined,
  state?: string | null,
  countryCode?: string | null,
): PlaceResolution {
  if (countryCode && normalize(countryCode) !== "us") {
    return { ok: false, reason: "not_us" };
  }

  const parts = `${city ?? ""},${state ?? ""}`
    .split(",")
    .map(normalize)
    .filter((part) => part.length > 0 && !COUNTRY_TOKENS.has(part));

  if (parts.length === 0) return { ok: false, reason: "no_location" };

  // Walk right to left for the first token that names a state; everything
  // before it is the city candidate. "Maryvale, Arizona" and "Phoenix" both
  // fall out of this, and so does a stray "Maricopa County" in the middle.
  let stateCode: string | null = null;
  let stateAt = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const token = parts[i]!;
    const code = STATE_CODES[token] ??
      (token.length === 2 && STATE_CODE_SET.has(token.toUpperCase())
        ? token.toUpperCase()
        : null);
    if (code) {
      stateCode = code;
      stateAt = i;
      break;
    }
  }

  const cityToken = stateAt > 0 ? parts[stateAt - 1]! : stateAt === -1 ? parts[0]! : null;

  if (stateCode) {
    const splitKeys = SPLIT_STATE_KEYS[stateCode];
    if (splitKeys) {
      if (!cityToken) return { ok: false, reason: "split_state_unknown_city" };
      for (const key of splitKeys) {
        const zone = CITY_ZONES[key]![cityToken];
        if (zone) return { ok: true, timezone: zone, matched: "city" };
      }
      // A split state with a city we do not know is precisely the case that
      // must never be guessed.
      return { ok: false, reason: "split_state_unknown_city" };
    }

    const zone = SINGLE_ZONE_STATES[stateCode];
    if (zone) return { ok: true, timezone: zone, matched: "state" };
    return { ok: false, reason: "unknown" };
  }

  // No state at all. Only a city name that is unique here and not a name that
  // repeats across the country gets through.
  if (!cityToken) return { ok: false, reason: "no_location" };
  if (AMBIGUOUS_CITY_NAMES.has(cityToken)) {
    return { ok: false, reason: "ambiguous_city" };
  }
  const candidates = CITY_INDEX.get(cityToken);
  if (!candidates || candidates.size !== 1) {
    return { ok: false, reason: candidates ? "ambiguous_city" : "unknown" };
  }
  return { ok: true, timezone: [...candidates][0]!, matched: "city" };
}
