import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";

// The household's long-term memory: trips it took and how they went.
// The assistant asks about a past trip with no review, and the planner uses the reviews.

export const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5).describe("1 = would not go again, 5 = loved it"),
  summary: z.string().describe("One or two sentences in the family's own words"),
  member_notes: z
    .array(z.object({ name: z.string(), note: z.string() }))
    .default([])
    .describe("What it was like for specific people, e.g. Grandpa Joe found the side trails too steep"),
});

export interface Visit {
  id: string;
  place: string;
  place_id?: string;
  date: string; // YYYY-MM-DD
  logged_at: string;
  review?: z.infer<typeof reviewSchema> & { reviewed_at: string };
}

const FILE = new URL("../data/memory.json", import.meta.url);

function daysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function lastSaturday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (((d.getUTCDay() + 1) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

// A new demo household starts with one reviewed trip and one trip nobody has talked about yet,
// so the first conversation shows both the follow-up question and a plan shaped by an old review.
function demoVisits(): Visit[] {
  return [
    {
      id: randomUUID().slice(0, 8),
      place: "Muir Woods National Monument",
      date: daysAgo(24),
      logged_at: daysAgo(26),
      review: {
        rating: 2,
        summary: "The main boardwalk was fine, but parking was far and it was crowded.",
        member_notes: [
          { name: "Grandpa Joe", note: "Only the main boardwalk worked for his wheelchair; side trails were too steep." },
          { name: "Leo", note: "Got tired after an hour." },
        ],
        reviewed_at: daysAgo(23),
      },
    },
    { id: randomUUID().slice(0, 8), place: "Oakland Zoo", date: lastSaturday(), logged_at: daysAgo(9) },
  ];
}

async function load(): Promise<Record<string, Visit[]>> {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

async function save(all: Record<string, Visit[]>) {
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}

export async function getVisits(household: string): Promise<Visit[]> {
  const all = await load();
  if (!all[household]) {
    all[household] = household.startsWith("demo") ? demoVisits() : [];
    await save(all);
  }
  return all[household];
}

// Trips whose day has passed and that nobody has told us about yet.
export function pendingReviews(visits: Visit[]) {
  const today = new Date().toISOString().slice(0, 10);
  return visits.filter((v) => !v.review && v.date < today);
}

export async function logVisit(household: string, v: { place: string; date: string; place_id?: string }): Promise<Visit> {
  const all = await load();
  const visits = all[household] ?? (household.startsWith("demo") ? demoVisits() : []);
  const visit: Visit = { id: randomUUID().slice(0, 8), ...v, logged_at: new Date().toISOString().slice(0, 10) };
  all[household] = [...visits, visit];
  await save(all);
  return visit;
}

export async function saveReview(household: string, visitId: string, review: z.infer<typeof reviewSchema>): Promise<Visit> {
  const all = await load();
  const visit = all[household]?.find((v) => v.id === visitId);
  if (!visit) throw new Error(`No trip with id ${visitId}`);
  visit.review = { ...review, reviewed_at: new Date().toISOString().slice(0, 10) };
  await save(all);
  return visit;
}

// The review that matches a place, by id or by name, newest first.
export function reviewFor(visits: Visit[], place: { id: string; name: string }) {
  const name = place.name.toLowerCase();
  return visits
    .filter((v) => v.review && (v.place_id === place.id || v.place.toLowerCase() === name || name.includes(v.place.toLowerCase()) || v.place.toLowerCase().includes(name)))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
}
