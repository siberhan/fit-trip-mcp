import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, getModel } from "@mariozechner/pi-ai";
import { Type, type TSchema } from "typebox";
import { driveMinutes, geocode, type LatLon } from "./data/geo.js";
import { mapsPlaces, npsDetails, npsPlaces, wikidataByName, wikidataPlaces, type Evidence, type Place, type PlaceKind } from "./data/places.js";
import { forecastHours, nwsAlerts, type HourWeather } from "./data/weather.js";
import { BLOCKS_SERVERS, excerpt, fetchPage, webSearch } from "./data/web.js";
import { getJson } from "./data/http.js";
import type { Profile } from "./profile.js";
import { reviewFor, type Visit } from "./memory.js";

const hostOf = (u: string) => {
  try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; }
};

// `say` is a sentence the research agent wrote for the family to hear while it works.
export type Progress = (message: string, step?: Step, say?: string) => void;

// Structured steps ride along with the progress messages, so a live card can draw the search as it happens.
export type Step =
  | { kind: "home"; lat: number; lon: number; label: string; maxDrive: number }
  | { kind: "search"; source: string; query: string; radiusKm?: number }
  | { kind: "places"; places: { id: string; name: string; lat: number; lon: number; driveMin: number | null; indoor: boolean }[] }
  | { kind: "web"; queries: string[] }
  | { kind: "read"; hosts: string[] }
  | { kind: "access"; id: string; name: string; status: string }
  | { kind: "think"; text: string }
  | { kind: "say"; text: string } // the agent's own sentence about what it found and what it checks next
  | { kind: "rank"; ranking: { id: string; level: string }[] };

export interface Candidate {
  place: Place;
  driveMin: number | null;
  weather: HourWeather[] | null; // that day's hourly forecast at the place, 7am to 7pm
  weatherAlerts: string[]; // active Weather Service alerts
  parkAlerts: { category: string; title: string }[];
  fit?: Fit; // the agent's verdict for this family
  note?: string; // the agent's one-line finding, if any
  memory?: { date: string; rating: number; summary: string; member_notes: { name: string; note: string }[] }; // the family's own review of a past trip
}

export interface Fit {
  level: "great" | "good" | "poor";
  reason: string;
  bestArrivalHour?: number;
}

export interface Plan {
  home: string;
  homeAt: LatLon; // for the card's map
  date: string;
  startHour: number;
  durationH: number;
  members: Profile["members"];
  candidates: Candidate[]; // ranked, best first
  spoken: string; // what the assistant says out loud
  research: { tool: string; input: string; output: string }[]; // agent trace for the inspector
  agentModel: string | null;
  evidence?: string[]; // everything the agent's tools returned, kept on the server to tell about a place later
}

const INTERESTS: Record<string, PlaceKind[]> = {
  nature: ["national_park_site", "park", "nature_reserve", "garden", "beach"],
  animals: ["zoo", "aquarium"],
  museums: ["museum"],
  beach: ["beach"],
  rides: ["theme_park"],
};

interface Request {
  profile: Profile;
  date: string;
  startHour: number;
  durationH: number;
  interests?: string[];
  placeQuery?: string; // set when the family already has a place in mind
  what?: string; // free words for what they want to do ("pumpkin patch"), searched on the maps search
  exclude?: string[]; // names or ids already suggested, so "show me other places" gets new ones
  maxDriveMinutes?: number; // overrides the profile's limit for this one search
  userRequest?: string; // the user's own words, so the agent can choose its sources
  visits?: Visit[]; // the household's trip memory
  justReviewed?: () => { place: string; rating: number } | undefined; // a trip review the user gave a moment ago, read when the agent starts (it may be saved in parallel)
  research?: boolean; // false: data only, no agent (used to keep the caches warm)
}

export async function planOuting(req: Request, progress: Progress): Promise<Plan> {
  const profile = { ...req.profile, max_drive_minutes: req.maxDriveMinutes ?? req.profile.max_drive_minutes };
  progress(`Finding home: ${profile.home}`);
  const home = { ...(await geocode(profile.home)), label: profile.home };
  progress(`Home: ${home.name}`, { kind: "home", lat: home.lat, lon: home.lon, label: profile.home, maxDrive: profile.max_drive_minutes });
  const ctx: Ctx = { req, home, maxDrive: profile.max_drive_minutes, progress };

  const research: Plan["research"] = [];
  let candidates: Candidate[] = [];
  let spoken = "";
  let ranking: string[] = [];
  let agentModel: string | null = null;
  let evidence: string[] = [];
  if (process.env.OPENROUTER_API_KEY && req.research !== false) {
    agentModel = process.env.AGENT_MODEL || DEFAULT_MODEL;
    ({ candidates, spoken, ranking, evidence } = await researchAgent(ctx, agentModel, research).catch((e) => {
      progress(`Agent stopped: ${e.message}`);
      return { candidates: [] as Candidate[], spoken: "", ranking: [] as string[], evidence: [] as string[] };
    }));
  }
  // Without the agent (no key, it failed, or a cache warm-up) the same sources run in a fixed order.
  if (!candidates.length) candidates = await scriptedCandidates(ctx);

  // The agent's ranking decides the order and the list; without it, nearest first.
  if (ranking.length) candidates = ranking.map((id) => candidates.find((c) => c.place.id === id)!);
  else candidates = candidates.sort((a, b) => (a.driveMin ?? 999) - (b.driveMin ?? 999)).slice(0, 8);
  if (candidates[0]?.place.id !== ranking[0]) spoken = ""; // the summary must describe the top card, else use the plain one
  return {
    home: home.name,
    homeAt: { lat: home.lat, lon: home.lon },
    date: req.date,
    startHour: req.startHour,
    durationH: req.durationH,
    members: profile.members,
    candidates,
    spoken: spoken || fallbackSpoken(candidates, req),
    research,
    agentModel,
    evidence,
  };
}

interface Ctx {
  req: Request;
  home: LatLon & { state?: string; name: string; label: string };
  maxDrive: number;
  progress: Progress;
}

async function scriptedCandidates(ctx: Ctx) {
  const { req } = ctx;
  if (req.placeQuery) return scoreCandidates(ctx, await namedSource(ctx, req.placeQuery), { named: true });
  if (req.what) return scoreCandidates(ctx, await mapsSource(ctx, req.what, req.exclude), { perKind: 20 });
  return scoreCandidates(ctx, await landmarkSource(ctx, req.interests, req.exclude));
}

// ---- Place sources. Each returns a shortlist; scoreCandidates adds drive time, weather and alerts. ----

async function landmarkSource(ctx: Ctx, interests?: string[], exclude?: string[], maxDrive = ctx.maxDrive) {
  const radiusKm = maxDrive * 1.1;
  ctx.progress(`Searching Wikidata and the National Park Service within ${Math.round(radiusKm)} km`, { kind: "search", source: "Wikidata + NPS", query: interests?.length ? interests.join(", ") : "landmarks", radiusKm });
  const [osm, nps] = await Promise.all([
    wikidataPlaces(ctx.home, radiusKm).catch(() => []),
    npsPlaces(ctx.home.state ? [ctx.home.state] : [], ctx.home, radiusKm).catch(() => []),
  ]);
  const kinds = interests?.flatMap((i) => INTERESTS[i] ?? []);
  const places = skip([...nps, ...osm], exclude).filter((p) => !kinds?.length || kinds.includes(p.kind));
  ctx.progress(`${places.length} ${places.length === 1 ? "landmark" : "landmarks"} found`);
  return shortlist(places, 60, 12);
}

// Wide enough to cover the drive limit around home; places beyond it are dropped later by real road time.
const mapsZoom = (maxDrive: number) => (maxDrive <= 30 ? 12 : maxDrive <= 75 ? 11 : 10);

async function mapsSource(ctx: Ctx, what: string, exclude?: string[], maxDrive = ctx.maxDrive) {
  ctx.progress(`Searching maps for "${what}" near ${ctx.home.label}`, { kind: "search", source: "Maps", query: what });
  const places = skip(await mapsPlaces(what, ctx.home, mapsZoom(maxDrive)), exclude);
  ctx.progress(`${places.length} ${places.length === 1 ? "place" : "places"} found for "${what}"`);
  return shortlist(places, 40, 40);
}

async function namedSource(ctx: Ctx, name: string) {
  ctx.progress(`Looking up "${name}"`, { kind: "search", source: "Lookup", query: name });
  return findNamedPlace(name, ctx.home, ctx.home.label);
}

async function scoreCandidates(ctx: Ctx, places: Place[], opts: { named?: boolean; perKind?: number; limit?: number; maxDrive?: number } = {}) {
  const { req } = ctx;
  const maxDrive = opts.maxDrive ?? ctx.maxDrive;
  const drives = await driveMinutes(ctx.home, places).catch(() => places.map(() => null));
  let pool = places
    .map((place, i) => ({ place, driveMin: drives[i] }))
    .filter((c) => opts.named || (c.driveMin != null && c.driveMin <= maxDrive));
  if (!opts.named) pool = diverse(pool, opts.limit ?? 20, opts.perKind ?? 5);
  ctx.progress(`${pool.length} ${pool.length === 1 ? "place" : "places"} within ${maxDrive} min drive, checking the forecast and alerts`, {
    kind: "places",
    places: pool.map(({ place: p, driveMin }) => ({ id: p.id, name: p.name, lat: p.lat, lon: p.lon, driveMin, indoor: p.indoor })),
  });
  const weather = forecastHours(pool.map((c) => c.place), req.date).catch(() => pool.map(() => null));
  return Promise.all(
    pool.map(async ({ place, driveMin }, i): Promise<Candidate> => {
      let parkAlerts: Candidate["parkAlerts"] = [];
      const [details, alerts] = await Promise.all([
        place.source === "NPS" ? npsDetails(place.extra.parkCode) : null,
        nwsAlerts(place).catch(() => []),
      ]);
      if (details) {
        place.wheelchair = details.wheelchair;
        parkAlerts = details.alerts;
      }
      const past = reviewFor(req.visits ?? [], place);
      const memory = past?.review && { date: past.date, rating: past.review.rating, summary: past.review.summary, member_notes: past.review.member_notes };
      return { place, driveMin, weather: (await weather)[i], weatherAlerts: alerts.map((a) => a.headline || a.event), parkAlerts, memory };
    }),
  );
}

// Drops places the family has already been shown, matched by id or by name.
function skip(places: Place[], exclude: string[] = []): Place[] {
  const out = exclude.map((e) => e.toLowerCase().trim()).filter(Boolean);
  return places.filter((p) => !out.some((e) => p.id.toLowerCase() === e || p.name.toLowerCase() === e || p.name.toLowerCase().includes(e)));
}

function shortlist(places: Place[], n: number, perKind = 4): Place[] {
  // Well-known places first (Wikipedia language editions as a popularity signal), nearer ones break ties.
  // NPS sites have no such count, so they get a fixed middle score.
  const appeal = (p: Place) => Math.log1p(p.source === "NPS" ? 20 : Number(p.extra.popularity ?? 0)) - p.distanceKm / 60;
  const byKind = new Map<string, Place[]>();
  for (const p of [...places].sort((a, b) => appeal(b) - appeal(a))) {
    const list = byKind.get(p.kind) ?? [];
    if (list.length < perKind) byKind.set(p.kind, [...list, p]);
  }
  return [...byKind.values()].flat().sort((a, b) => appeal(b) - appeal(a)).slice(0, n);
}

function diverse<T extends { place: Place }>(items: T[], n: number, perKindMax = 2): T[] {
  const perKind = new Map<string, number>();
  const out: T[] = [];
  for (const it of items) {
    const k = it.place.kind;
    if ((perKind.get(k) ?? 0) >= perKindMax) continue;
    perKind.set(k, (perKind.get(k) ?? 0) + 1);
    out.push(it);
    if (out.length >= n) break;
  }
  return out;
}

async function findNamedPlace(query: string, home: LatLon & { state?: string }, homeName: string): Promise<Place[]> {
  const key = process.env.NPS_API_KEY || "DEMO_KEY";
  const nps = await getJson<{ data: any[] }>(
    `https://developer.nps.gov/api/v1/parks?q=${encodeURIComponent(query)}&limit=5&api_key=${key}`,
  ).catch(() => ({ data: [] }));
  const q = query.toLowerCase();
  const hit = nps.data.find((p) => p.fullName.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
  if (hit) {
    const all = await npsPlaces(hit.states.split(","), home, 5000);
    const p = all.find((x) => x.extra.parkCode === hit.parkCode);
    if (p) return [p];
  }
  const match = await wikidataByName(query, home).catch(() => []);
  if (match.length) return match.slice(0, 1);
  const maps = await mapsPlaces(query, home, 10).catch(() => []);
  if (maps.length) return maps.slice(0, 1);
  throw new Error(`Could not find "${query}" near ${home.lat.toFixed(2)},${home.lon.toFixed(2)}`);
}

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

// pi-ai only knows the models in its generated list; newer OpenRouter ids reuse the closest family entry.
// Both agents talk to a person who is waiting, so OpenRouter picks the provider with the lowest latency.
export function openRouterModel(id: string) {
  const model = getModel("openrouter", id as any) ?? { ...getModel("openrouter", (id.startsWith("deepseek/") ? "deepseek/deepseek-v4-flash" : "anthropic/claude-haiku-4.5") as any), id, name: id };
  return { ...model, compat: { ...(model.compat as {} | undefined), openRouterRouting: { sort: "latency" } } };
}

// Lets TypeScript infer each tool's parameter type from its schema.
function tool<P extends TSchema>(t: AgentTool<P>): AgentTool<any> {
  return t as AgentTool<any>;
}

function hourLabel(h: number) {
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

// The visit window plus an hour on each side, in one short line per hour.
function forecastLines(c: Candidate, req: Request) {
  if (!c.weather) return "forecast unavailable";
  return c.weather
    .filter((w) => w.hour >= req.startHour - 1 && w.hour <= req.startHour + req.durationH)
    .map((w) => `${hourLabel(w.hour)} ${w.tempF}F feels ${w.feelsF}F, rain ${w.rainPct}%, gusts ${w.gustMph}mph, UV ${w.uv}, ${w.sky}`);
}

function fallbackSpoken(cs: Candidate[], req: Request) {
  if (!cs.length) return "I couldn't find a place that fits within your drive limit.";
  const top = cs[0];
  const w = top.weather?.find((x) => x.hour === req.startHour);
  const sky = w ? ` Around ${hourLabel(w.hour)} it should be ${w.tempF} degrees with a ${w.rainPct}% chance of rain.` : "";
  if (req.placeQuery) return `${top.place.name} is ${top.driveMin ?? "?"} minutes by car.${sky}`;
  return `${top.place.name} is the closest fit, ${top.driveMin ?? "?"} minutes by car.${sky}`;
}

// The research agent's skill: how to work in short, narrated steps, and a manual for every tool so it never has to guess.
const SYSTEM = `You are the research step of Outing Fit. A family is waiting for a spoken answer and listens to you while you work,
like a friend looking things up for them. Research the way a careful person would, in short steps, and tell them as you go.
Usually 4 to 7 turns, about 30 to 45 seconds in all. Never more than 9 turns.

# Talking while you work
Every turn, before your tool calls, write exactly one short sentence the family will hear. Hard limit: 12 words.
Longer sentences delay the family's answer, so cut every extra word. Plain words, no lists, no markdown, no dashes.
It says what you just learned from the last results, with a real name or number, and what you check next:
  "Eight trails came up; checking dog rules at Reinhardt and Tilden."
  "Reinhardt allows dogs. Now reading its page for closures."
The first turn has no results yet: say what you are looking for and for whom ("Looking for shady trails Max can join.").
Talk about this family's real people, pets and needs only. Never mention a need nobody in this family has.
Never repeat a sentence, and never announce your final pick here: the answer does that. Do not write anything else
outside tool calls. In the turn that calls submit, write nothing.
If brief.just_reviewed is set, start your first sentence with a short thanks for that review (the place and how it went).

# Working well without dragging on
- In one turn, call together the tools that do not depend on each other (they run in parallel). Steps that build on each other
  go in separate turns, so the family hears what you found before you dig deeper.
- Do not research what does not change the answer: places far down the ranking, needs nobody in this family has, facts already known.
- Look wide before you narrow down: each search returns up to 20 places, and two to four different searches give a real choice.
  The family hears one pick but sees the whole ranking, so a rich list of good options is part of the answer.

# Plan
First find candidates (pick sources from the request, combine them in one turn when it helps):
- The family named a place: lookup_place.
- They want something specific (pumpkin patch, bowling, indoor playground, a farm, a splash pad): search_maps with those words.
- An open question ("where can we go?"): find_landmarks, plus one search_maps when a kind of place clearly suits this family,
  the season or the weather better (an indoor play space on a stormy or hot day, a pumpkin patch in October).
- "Other options" or "somewhere else": the same sources again, every place already suggested in exclude, maybe one new idea.
- "Closer" or "farther": max_drive_minutes.
Then shortlist the 6 to 8 most promising places and check them for what matters to this family: one web_search with a query per place.
Then read the real pages: one fetch_pages call on the official site of every place you plan to rank (the place's own site,
  city or park page, up to 10 at once), with look_for set to what this family needs to know. Every card the family can open
  should rest on its own page, not only on snippets; skip a place only when it has no site you can read.
  Fetch whatever page would settle a question, whenever it comes up: a rules or accessibility page, a link you saw on a page
  you read, an events or tickets page. Follow a link from a page you read when it clearly holds the answer.
  Review, booking and social sites cannot be read; their search snippets are all you get, so do not fetch them.
Stop once the pick's real questions are answered. Never search or read again only to confirm what you already found.
Last turn, all at once: record_access for every ranked place the evidence settles (when someone uses a wheelchair), add_note
for what matters, and submit.
Split or repeat a step when what you found calls for it (a pick turns out closed, a page could not be read), but keep it short.

# Tools
find_landmarks: well-known destinations from Wikidata (places with Wikipedia articles) and the National Park Service.
  - Searches a circle of about 1.1 km per drive minute around home (at most 160 km), then keeps the ones within the drive limit by real road time.
  - Ranks by fame (how many Wikipedia languages cover it) and nearness, at most 5 per kind, returns up to 20.
  - interests narrows the kinds: nature = national park sites, parks, nature reserves, gardens, beaches; animals = zoos, aquariums;
    museums = museums; beach = beaches; rides = theme parks. Leave it out for a broad mix.
  - Does not know small local businesses, farms, play spaces, seasonal events. Use search_maps for those.
  - National Park Service sites come with official accessibility info and current park alerts (closures).
search_maps: maps search for anything in plain words, on a map centered on the family's home. About 20 results,
  all within the drive limit are returned (up to 20), each with its opening hours that day.
  - what: short words a person would type into Maps ("pumpkin patch", "indoor playground", "petting zoo", "splash pad").
    Add a need only when it is how the place is listed ("wheelchair accessible playground"); otherwise check access later.
  - Returns category, address, website. Wheelchair access always starts unknown. Indoor is guessed from the category.
  - Call it several times in one turn for different ideas, not with near-duplicate words.
lookup_place: one place by name. Tries the National Park Service, then Wikidata, then the maps search. No drive limit, so a far place
  still comes back with its drive time. Use the name as the family says it.
exclude (find_landmarks, search_maps): names of places already suggested; matching names are skipped so new ones come back.
max_drive_minutes (find_landmarks, search_maps): only for this search, when the family asks for closer or farther places.

Every place comes back with:
  place_id: use it in record_access, add_note, submit.
  drive_minutes, indoor (guessed for maps places), wheelchair (yes/limited/no/unknown with its source).
  hours_that_day (maps places): the listed opening hours on the visit day. A place that is closed then is a poor fit;
    no need to search the web for hours when this is set.
  forecast: that day's hourly forecast at the place for the visit window plus an hour on each side
    (temperature, feels like, chance of rain, gusts, UV, sky). It is a normal forecast; treat it as likely, not certain.
  weather_alerts: active Weather Service alerts there. park_alerts: current National Park Service notices (closures).
  past_visit: the family's own review of an earlier trip.

web_search: web results (title, url, snippet), 4 per query, up to 8 queries in one call, all in parallel, about 1 to 2 seconds.
  - One query per place about this family's real need: "<name> <city> wheelchair accessible" only if someone uses a wheelchair,
    "<name> dogs allowed" for a dog, "<name> stroller" for a stroller, "<name> hours <day>" when opening hours matter for the date.
  - Prefer the place's own site, city or park pages; Yelp and TripAdvisor answers are weaker but usable, say so in the source.
fetch_pages: reads up to 10 urls in one call, in parallel, about 7 seconds at most. Menus, headers and footers are removed.
  look_for: words for what you want from these pages ("dogs leash", "pumpkin prices", "stroller parking"). With it you get the
  passages around those words (plus access, closures and hours), up to about 3500 characters a page; without it, the start of
  the main text. Each page also lists links whose text matches look_for, so you can fetch a deeper page next.
  Some sites block it or build the page with scripts; then rely on snippets or try another page.
record_access: sets wheelchair access for a place, shown on its card. Only matters when someone uses a wheelchair.
  Quote the source and give its url. Record only what the evidence clearly says; leave unclear places as they are.
add_note: one short line on a place's card for this family (step-free routes, stroller rules, accessible restrooms, hours that day,
  how to avoid a problem from past_visit). A second note on the same place replaces the first.
submit: ends the research. ranking lists the places best first, 6 to 10 of them when the area has that many worth going to, each with:
  fit: great (works for everyone as planned), good (works with a small change or caveat), poor (someone would struggle or it is closed).
  reason: one short line for the card, about this family ("Paved loop and shade for Grandpa Joe; 66F, dry").
  best_arrival_hour: when to arrive for the best weather, if it differs from the plan.
  spoken: a very short wrap-up, under 30 words, plain words, no markdown or emoji: name two or three of the best places with a
    few words each ("Speer Farms for the petting zoo, Lafayette Reservoir for an easy flat loop"). The family taps a place to hear more.

# Judging fit
You judge each place for this family yourself, from the forecast and the facts. Each person has an "about" text in their own words
(mobility aids, health, allergies, stamina, likes). Read it and think about what it means at each place:
- Heat sensitive people, older people and small children: outdoors with feels like above about 85F is hard, above 95F is a no. Shade and indoor parts help.
- People who get cold: outdoors with feels like below about 45F is hard.
- Rain: a 50% or higher chance during the visit spoils an outdoor plan; under 30% is fine. Gusts above 35mph are bad for beaches, cliffs and trees.
- UV 8 or more with no shade: mention it for small children and older people.
- Indoor places barely care about weather. A bad weather day is a reason to rank them higher.
- Wheelchair, walker or stroller: unknown access is a caveat, limited is a caveat, no is poor. A cane or low stamina: long walks or big sites are a caveat.
- Anything else in the about text (an allergy, a fear, a need for quiet, a favorite thing) counts too when a place clearly helps or hurts it.
- A severe weather alert or a closure is poor. A long drive near the limit is a small caveat.
- If a later or earlier arrival avoids the problem, give best_arrival_hour and say so in reason.

# Rules
- Never invent numbers or facts. Quote the forecast as it is.
- Trust past_visit over the web. When it names a problem for a person (steep trails, long walks), say how this trip avoids it or rank another place higher.
- A place rated 2/5 or lower in past_visit goes below equally good places.`;

const NEED_WORDS = /wheelchair|accessib|\bADA\b|stroller|ramp|elevator|paved|closed|closure|hours|\bdogs?\b|\bpets?\b|leash|service animal|allerg/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The listed opening hours for the visit's weekday, e.g. "9 AM–6 PM" or "Closed".
function hoursOn(place: Place, date: string) {
  if (!place.extra.hours) return undefined;
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  try { return JSON.parse(place.extra.hours)[day] as string | undefined; } catch { return undefined; }
}

function candidateRow(c: Candidate, req: Request) {
  return {
    place_id: c.place.id,
    name: c.place.name,
    kind: c.place.extra.category || c.place.kind,
    address: c.place.extra.address || undefined,
    website: c.place.url,
    hours_that_day: hoursOn(c.place, req.date),
    drive_minutes: c.driveMin,
    indoor: c.place.indoor,
    wheelchair: c.place.wheelchair.status === "unknown" ? "unknown" : `${c.place.wheelchair.status} (${c.place.wheelchair.source})`,
    forecast: forecastLines(c, req),
    weather_alerts: c.weatherAlerts.length ? c.weatherAlerts : undefined,
    park_alerts: c.parkAlerts.slice(0, 3).map((a) => a.title),
    past_visit: c.memory,
  };
}

async function researchAgent(ctx: Ctx, modelId: string, trace: Plan["research"]) {
  const { req, progress } = ctx;
  const byId = new Map<string, Candidate>();
  let spoken = "";
  let ranking: string[] = [];
  const log = (tool: string, input: unknown, output: string) => trace.push({ tool, input: JSON.stringify(input), output: output.slice(0, 600) });

  // Adds scored places to the shared pool and shows the agent the ones it has not seen yet.
  const addPlaces = async (name: string, input: unknown, places: Promise<Place[]>, opts: Parameters<typeof scoreCandidates>[2] = {}) => {
    // The same place can come from Wikidata and from the maps search under different ids.
    const seen = new Set([...byId.values()].map((c) => c.place.name.toLowerCase()));
    const fresh = (await places).filter((p) => !byId.has(p.id) && !seen.has(p.name.toLowerCase()) && (seen.add(p.name.toLowerCase()), true));
    const scored = await scoreCandidates(ctx, fresh, opts);
    for (const c of scored) byId.set(c.place.id, c);
    const rows = scored.map((c) => candidateRow(c, req));
    const text = rows.length ? JSON.stringify(rows) : "No new places found.";
    log(name, input, rows.map((r) => `${r.name}: ${r.drive_minutes} min`).join("\n") || text);
    return { content: [{ type: "text" as const, text }], details: {} };
  };
  const exclude = Type.Optional(Type.Array(Type.String(), { description: "Names of places already suggested" }));
  const maxDrive = Type.Optional(Type.Number({ description: "Drive limit in minutes for this search; defaults to the family's" }));

  const tools: AgentTool<any>[] = [
    tool({
      name: "find_landmarks",
      label: "Find landmarks",
      description: "Well-known places within the drive limit from Wikidata and the National Park Service: parks, museums, zoos, aquariums, gardens, beaches, theme parks. Returns up to 20 with forecast.",
      parameters: Type.Object({
        interests: Type.Optional(Type.Array(Type.Union(Object.keys(INTERESTS).map((k) => Type.Literal(k))))),
        exclude,
        max_drive_minutes: maxDrive,
      }),
      execute: async (_id, a) => addPlaces("find_landmarks", a, landmarkSource(ctx, a.interests, a.exclude, a.max_drive_minutes ?? ctx.maxDrive), { maxDrive: a.max_drive_minutes }),
    }),
    tool({
      name: "search_maps",
      label: "Search maps",
      description: "Maps search near home for anything in plain words: 'pumpkin patch', 'indoor playground', 'bowling alley'. Returns up to 20 with forecast.",
      parameters: Type.Object({ what: Type.String(), exclude, max_drive_minutes: maxDrive }),
      execute: async (_id, a) => addPlaces("search_maps", a, mapsSource(ctx, a.what, a.exclude, a.max_drive_minutes ?? ctx.maxDrive), { perKind: 20, maxDrive: a.max_drive_minutes }),
    }),
    tool({
      name: "lookup_place",
      label: "Look up a place",
      description: "Find one place by name (national parks, landmarks, or any local business) with its forecast.",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, a) => addPlaces("lookup_place", a, namedSource(ctx, a.name), { named: true }),
    }),
    tool({
      name: "web_search",
      label: "Web search",
      description: "Web search, many queries at once (they run in parallel). Up to 8 queries.",
      parameters: Type.Object({ queries: Type.Array(Type.String(), { maxItems: 8 }) }),
      execute: async (_id, a) => {
        const { queries } = a;
        progress(`Searching the web: ${queries.length} ${queries.length === 1 ? "query" : "queries"} at once`, { kind: "web", queries: queries.slice(0, 8) });
        const results = await Promise.all(queries.slice(0, 8).map((q: string) => webSearch(q, 4).catch(() => [])));
        const text = queries
          .map((q: string, i: number) => `## ${q}\n` + (results[i].map((h) => `- ${h.title} | ${h.url}\n  ${h.snippet}`).join("\n") || "No results"))
          .join("\n\n");
        log("web_search", { queries }, text);
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
    tool({
      name: "fetch_pages",
      label: "Fetch pages",
      description: "Fetch and read several web pages at once (in parallel), up to 10 urls. look_for picks the passages you want; links on the page come back too.",
      parameters: Type.Object({
        urls: Type.Array(Type.String(), { maxItems: 10 }),
        look_for: Type.Optional(Type.String({ description: "Words for what you want from these pages, e.g. 'dogs leash water'" })),
      }),
      execute: async (_id, a) => {
        const urls: string[] = a.urls.slice(0, 10);
        const words = (a.look_for ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w: string) => w.length > 2);
        const want = words.length ? new RegExp(`${words.map(escapeRe).join("|")}|${NEED_WORDS.source}`) : null;
        progress(`Reading ${urls.length} ${urls.length === 1 ? "page" : "pages"} at once`, { kind: "read", hosts: urls.map(hostOf) });
        const pages = await Promise.all(
          urls.map((u) =>
            Promise.race([fetchPage(u), new Promise<null>((ok) => setTimeout(() => ok(null), 7000))])
              .then((p) => {
                if (!p) return "Could not read the page in time.";
                if (BLOCKS_SERVERS.test(hostOf(u))) return "This site cannot be read; use its search snippet.";
                if (p.text.length < 200) return "The page has almost no text, even rendered; try another source.";
                const body = want ? excerpt(p.text, want, 3500, 300) : p.text.slice(0, 4000);
                const links = want ? p.links.filter((l) => want.test(l.text.toLowerCase())).slice(0, 8) : [];
                return body + (links.length ? `\nLinks: ${links.map((l) => `${l.text} | ${l.url}`).join("\n  ")}` : "");
              })
              .catch(() => "Could not read the page."),
          ),
        );
        const text = urls.map((u, i) => `## ${u}\n${pages[i]}`).join("\n\n");
        log("fetch_pages", { urls, look_for: a.look_for }, text);
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
    tool({
      name: "record_access",
      label: "Record wheelchair access",
      description: "Record verified wheelchair access for a place.",
      parameters: Type.Object({
        place_id: Type.String(),
        status: Type.Union([Type.Literal("yes"), Type.Literal("limited"), Type.Literal("no")]),
        source: Type.String({ description: "Short quote or summary of what the source says" }),
        url: Type.String(),
      }),
      execute: async (_id, a) => {
        const c = byId.get(a.place_id);
        if (!c) throw new Error(`Unknown place_id ${a.place_id}`);
        let host = a.url;
        try { host = new URL(a.url).host; } catch {}
        c.place.wheelchair = { status: a.status, source: `${host}: ${a.source}`, url: a.url } satisfies Evidence;
        progress(`${c.place.name}: wheelchair access ${a.status}`, { kind: "access", id: c.place.id, name: c.place.name, status: a.status });
        log("record_access", a, "ok");
        return { content: [{ type: "text", text: "Recorded." }], details: {} };
      },
    }),
    tool({
      name: "add_note",
      label: "Add note",
      description: "Attach one short finding to a place, shown on its card.",
      parameters: Type.Object({ place_id: Type.String(), note: Type.String() }),
      execute: async (_id, a) => {
        const c = byId.get(a.place_id);
        if (!c) throw new Error(`Unknown place_id ${a.place_id}`);
        c.note = a.note;
        log("add_note", a, "ok");
        return { content: [{ type: "text", text: "Noted." }], details: {} };
      },
    }),
    tool({
      name: "submit",
      label: "Submit",
      description: "Finish with your ranking (best first, each with fit, reason and best arrival hour) and the spoken wrap-up.",
      parameters: Type.Object({
        ranking: Type.Array(
          Type.Object({
            place_id: Type.String(),
            fit: Type.Union([Type.Literal("great"), Type.Literal("good"), Type.Literal("poor")]),
            reason: Type.String(),
            best_arrival_hour: Type.Optional(Type.Integer({ minimum: 6, maximum: 20 })),
          }),
          { minItems: 1, maxItems: 10 },
        ),
        spoken: Type.String(),
      }),
      execute: async (_id, a) => {
        if (!byId.size) throw new Error("Find some places before submitting.");
        const unknown = a.ranking.filter((r: any) => !byId.has(r.place_id)).map((r: any) => r.place_id);
        if (unknown.length) throw new Error(`Unknown place_id: ${unknown.join(", ")}`);
        for (const r of a.ranking) byId.get(r.place_id)!.fit = { level: r.fit, reason: r.reason, bestArrivalHour: r.best_arrival_hour, };
        ranking = a.ranking.map((r: any) => r.place_id);
        spoken = a.spoken;
        progress(`Ranked ${ranking.length} places`, { kind: "rank", ranking: a.ranking.map((r: any) => ({ id: r.place_id, level: r.fit })) });
        log("submit", a, "done");
        return { content: [{ type: "text", text: "Submitted." }], details: {}, terminate: true };
      },
    }),
  ];

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM, model: openRouterModel(modelId), tools, thinkingLevel: "off" },
    toolExecution: "parallel",
  });
  let turns = 0;
  agent.subscribe((e) => {
    if (e.type === "turn_end" && ++turns >= 10) agent.abort(); // the prompt asks for 4 to 7; this is the hard stop
    // The sentence the agent writes before its tool calls is its narration: spoken on the device and shown on the card.
    if (e.type === "message_end" && e.message.role === "assistant") {
      const calls = e.message.content.filter((c) => c.type === "toolCall");
      const text = e.message.content.map((c) => (c.type === "text" ? c.text : "")).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
      if (text && calls.length && !calls.some((c) => c.type === "toolCall" && c.name === "submit")) progress(`Agent: ${text}`, { kind: "say", text }, text);
    }
    if (e.type === "turn_end" && byId.size && !ranking.length) progress("Agent is weighing what it found", { kind: "think", text: "Weighing what it found" });
  });

  const brief = {
    request: req.userRequest,
    named_place: req.placeQuery,
    wants: req.what,
    interests: req.interests,
    already_suggested: req.exclude,
    date: req.date,
    start_hour: req.startHour,
    hours: req.durationH,
    home: ctx.home.label,
    max_drive_minutes: ctx.maxDrive,
    family: req.profile.members,
    just_reviewed: req.justReviewed?.(),
  };

  progress("Agent is choosing where to look", { kind: "think", text: "Choosing where to look" });
  const timer = setTimeout(() => agent.abort(), Number(process.env.AGENT_TIMEOUT_MS || 90000));
  try {
    await agent.prompt(JSON.stringify(brief));
  } finally {
    clearTimeout(timer);
  }
  const err = agent.state.errorMessage;
  if (!byId.size && err) throw new Error(err);
  const evidence = agent.state.messages
    .filter((m: any) => m.role === "toolResult")
    .map((m: any) => m.content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n"));
  return { candidates: [...byId.values()], spoken, ranking, evidence };
}

// ---- Telling about one place ----
// When the family taps a place, the research agent's findings are already here: one short model call, no tools,
// turns them into a few spoken sentences while the card flies the map there.
const TELL = `You are the research agent of a family outing planner. You already researched these places for the family.
They opened one of them on screen. Reply with JSON only:
{"say": "...", "members": [{"name": "...", "ok": true, "note": "...", "tag": "..."}]}
say: what you tell them out loud, 2 short sentences, at most 35 words: what it is like there and the best thing for this family,
  or one practical tip. Plain spoken words, no markdown, no emoji. The drive time and fit badge are on screen; do not repeat them.
members: one entry per family member and pet, in family order. ok is false when they need a change or would struggle there.
  note: at most eight words on what this place means for them ("Paved loop, accessible restroom by the gate").
  tag: only when ok is false, the fix or problem in one to three words ("bring water", "go early", "steep paths").
Use only the facts given; never invent hours, prices or rules.`;

const NAME_NOISE = new Set(["the", "park", "farm", "farms", "family", "museum", "center", "centre", "garden", "gardens", "regional", "state", "national", "trail", "beach", "pumpkin", "patch", "zoo", "and", "for", "children's"]);

// Lines of what the agent read that mention the place, with a little context around each.
function passagesAbout(name: string, evidence: string[], max = 5000) {
  const keys = name.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3 && !NAME_NOISE.has(w));
  if (!keys.length) keys.push(name.toLowerCase());
  const out: string[] = [];
  let size = 0;
  for (const text of evidence) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (size > max || !keys.some((k) => line.toLowerCase().includes(k))) return;
      const chunk = lines.slice(Math.max(0, i - 1), i + 4).join(" ").replace(/\s+/g, " ").trim().slice(0, 700);
      if (out.includes(chunk)) return;
      out.push(chunk);
      size += chunk.length;
    });
  }
  return out.join("\n");
}

export async function tellAbout(plan: Plan, evidence: string[], placeId: string) {
  const c = plan.candidates.find((x) => x.place.id === placeId);
  if (!c) throw new Error("That place is not in the last results.");
  const facts = {
    family: plan.members.map((m) => ({ name: m.name, about: m.about })),
    place: { name: c.place.name, kind: c.place.extra?.category || c.place.kind, indoor: c.place.indoor, hours_that_day: hoursOn(c.place, plan.date) },
    verdict: c.fit,
    note: c.note,
    weather_during_visit: forecastLines(c, { startHour: plan.startHour, durationH: plan.durationH } as Request),
    alerts: [...c.weatherAlerts, ...c.parkAlerts.map((a) => a.title)],
    past_visit: c.memory,
  };
  const read = passagesAbout(c.place.name, evidence);
  // Many places are told at once right after a search, so a stalled or garbled answer is simply asked for again.
  let out: { say?: string; members?: { name: string; ok: boolean; note: string; tag?: string }[] } = {};
  let why = "";
  for (let attempt = 0; attempt < 3 && !out.say; attempt++) {
    const msg = await completeSimple(openRouterModel(process.env.AGENT_MODEL || DEFAULT_MODEL) as any, {
      systemPrompt: TELL,
      messages: [{ role: "user", content: `${JSON.stringify(facts)}\n\nWhat you read about it:\n${read || "nothing beyond the facts above"}`, timestamp: Date.now() }],
    }, { maxTokens: 1200 });
    const raw = msg.content.map((x) => (x.type === "text" ? x.text : "")).join("");
    try { out = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch {}
    why = msg.errorMessage || `${msg.stopReason}: ${raw.slice(0, 120)}`;
  }
  const text = (out.say ?? "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(why || "No answer");
  return { id: c.place.id, place: c.place.name, text, members: Array.isArray(out.members) ? out.members : [] };
}
