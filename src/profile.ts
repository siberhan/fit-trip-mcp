import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";

export const memberSchema = z.object({
  name: z.string().describe("First name or role, e.g. 'Grandpa Joe'"),
  age: z.number().int().min(0).max(110),
  about: z.string().max(300).default("").describe("Plain words on what matters for a day out: mobility aids, health, allergies, stamina, likes. E.g. 'Uses a wheelchair, struggles in the heat.'"),
  kind: z.string().max(40).optional().describe("Avatar the demo page shows; leave as it is"),
});

export const profileSchema = z.object({
  home: z.string().describe("Home city, e.g. 'Oakland, CA'"),
  members: z.array(memberSchema).min(1),
  max_drive_minutes: z.number().int().min(10).max(600).default(120),
});

export type Member = z.infer<typeof memberSchema>;
export type Profile = z.infer<typeof profileSchema>;

const FILE = new URL("../data/profiles.json", import.meta.url);

// The demo household every new session starts from, so judges see a full profile right away.
const DEMO: Profile = {
  home: "Oakland, CA",
  max_drive_minutes: 120,
  members: [
    { name: "Maya", age: 38, about: "Woman, 38. Mom and the planner of the family. Loves a short nature walk and a good coffee stop.", kind: "adult-woman" },
    { name: "Daniel", age: 40, about: "Man, 40. Dad, does the driving, so easy parking matters to him. Happy anywhere with decent food.", kind: "adult" },
    { name: "Grandpa Joe", age: 74, about: "Man, 74. Uses a wheelchair: needs step-free paths and an accessible restroom. Tires in strong heat and likes shade. Loves trains and animals.", kind: "grandpa-wheelchair" },
    { name: "Leo", age: 4, about: "Boy, 4. Rides in a stroller and tires fast on long walks. Naps after lunch. Crazy about animals and playgrounds.", kind: "kid" },
    { name: "Biscuit", age: 6, about: "Dog, 6. Calm golden retriever on a leash. Comes along only where dogs are allowed, needs water and shade.", kind: "dog" },
  ],
};

async function load(): Promise<Record<string, Profile>> {
  try {
    return JSON.parse(await readFile(FILE, "utf8"));
  } catch {
    return {};
  }
}

// Profiles saved before members had an "about" text listed needs as flags; read those as words.
const OLD_NEEDS: Record<string, string> = { wheelchair: "Uses a wheelchair.", stroller: "Rides in a stroller.", low_stamina: "Tires fast.", heat_sensitive: "Struggles in the heat.", cold_sensitive: "Gets cold easily." };
export async function getProfile(household: string): Promise<Profile> {
  const p = (await load())[household] ?? structuredClone(DEMO);
  for (const m of p.members as (Member & { needs?: string[] })[]) {
    if (m.needs) { m.about ||= m.needs.map((n) => OLD_NEEDS[n] ?? n).join(" "); delete m.needs; }
    m.about ??= "";
    if (!/\d/.test(m.about)) m.about = `Age ${m.age}. ${m.about}`.trim();
  }
  return p;
}

export async function saveProfile(household: string, profile: Profile): Promise<void> {
  const all = await load();
  all[household] = profile;
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(FILE, JSON.stringify(all, null, 2));
}
