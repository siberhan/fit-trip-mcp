import { planOuting } from "./planner.js";
import { getProfile } from "./profile.js";

// Public APIs (Wikidata above all) can take 25 s on a cold query. Every 15 to 35 minutes, at a random moment,
// this runs the demo family's plans without the agent, so the caches refresh here instead of while someone waits.

const MIN_MS = 15 * 60 * 1000;
const MAX_MS = 35 * 60 * 1000;

function nextDay(dow: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + (((dow - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

async function warm() {
  const t0 = Date.now();
  const profile = await getProfile("demo");
  const plans = [nextDay(6), nextDay(0)].flatMap((date) => [
    { profile, date, startHour: 10, durationH: 3, research: false },
    { profile, date, startHour: 10, durationH: 3, placeQuery: "Muir Woods", research: false },
  ]);
  // One after another, so the warm-up never bursts the weather API's rate limit.
  for (const req of plans) await planOuting(req, () => {}).catch((e) => console.warn("warm-up:", e.message));
  console.log(`warm-up done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

export function keepWarm() {
  const loop = async () => {
    await warm();
    setTimeout(loop, MIN_MS + Math.random() * (MAX_MS - MIN_MS)).unref();
  };
  setTimeout(loop, 5000).unref();
}
