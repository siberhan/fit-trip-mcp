import express from "express";
import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { DEFAULT_MODEL, planOuting, tellAbout, type Plan, type Step } from "./planner.js";
import { getProfile, profileSchema, saveProfile } from "./profile.js";
import { getVisits, logVisit, pendingReviews, reviewSchema, saveReview } from "./memory.js";
import { assistantTurn, type AssistantEvent } from "./assistant.js";
import { keepWarm } from "./warm.js";

const CARD_URI = "ui://outing/card.html";
const CARD_MIME = "text/html;profile=mcp-app";
const PUBLIC = new URL("../public/", import.meta.url);

// Card meta in both the current and the legacy MCP Apps key, so either kind of host finds the view.
const cardMeta = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI };

const outingArgs = {
  request: z.string().max(300).optional().describe("What the user asked, in their own words"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day of the outing, YYYY-MM-DD, within the next 14 days. Defaults to the coming Saturday."),
  start_hour: z.number().int().min(6).max(20).default(10).describe("Local hour the family wants to arrive, 24h clock"),
  duration_hours: z.number().int().min(1).max(10).default(3),
};

function nextSaturday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
  return d.toISOString().slice(0, 10);
}

// The last results per household, with everything the research read, so a tapped place can be told about at once.
// As soon as the results are in, every place's story is made in the background, so a tap shows it at once.
type Told = Awaited<ReturnType<typeof tellAbout>>;
const lastResearch = new Map<string, { plan: Plan; evidence: string[]; told: Map<string, Promise<Told>> }>();
function remember(household: string, { evidence = [], ...plan }: Plan) {
  const told = new Map<string, Promise<Told>>();
  const t0 = Date.now();
  for (const c of plan.candidates) {
    const p = tellAbout(plan, evidence, c.place.id);
    told.set(c.place.id, p);
    p.then((t) => { console.log(`[tell] ready ${t.place} in ${Date.now() - t0} ms`); }).catch((e) => console.error(`[tell] ${c.place.name} failed: ${e.message}`));
  }
  lastResearch.set(household, { plan, evidence, told });
  return plan;
}

// The card gets the whole plan; the model gets the short spoken answer plus a compact ranking.
function planResult(plan: Plan) {
  const ranking = plan.candidates
    .map((c, i) => `${i + 1}. ${c.place.name}: ${c.driveMin ?? "?"} min drive${c.fit ? `, ${c.fit.level} fit: ${c.fit.reason}` : ""}`)
    .join("\n");
  return {
    content: [{ type: "text" as const, text: `${plan.spoken}\n\n${ranking}` }],
    structuredContent: plan as unknown as Record<string, unknown>,
    _meta: cardMeta,
  };
}

const INSTRUCTIONS = `Fit Trip plans family day trips and remembers how past trips went.
At the start of every conversation call get_outing_memory once. If it lists pending_reviews, first ask the user one short
question about the most recent of those trips (how it went, and how it was for anyone with special needs), save the answer
with save_visit_review, then carry on with what the user asked. If the answer is only a word or two ("it was good") and says nothing
about anyone in particular, ask one short follow-up about the member who needs the most care (for example how the paths were for
the wheelchair), then save both answers together: the summary in their words, member_notes for what they said about each person.
Ask at most that one follow-up. If the user does not want to talk about it, move on.
When the family decides to go somewhere, log it with log_visit so you can ask about it next time.`;

function buildServer(household: string) {
  const server = new McpServer({ name: "fit-trip", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerResource("outing-card", CARD_URI, { mimeType: CARD_MIME, description: "Outing results card" }, async () => ({
    contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: await readFile(new URL("card.html", PUBLIC), "utf8") }],
  }));

  server.registerTool(
    "get_family_profile",
    {
      title: "Get family profile",
      description: "Read the household: home city, each member's age and a short text about what matters for them (wheelchair, cane, stroller, heat, allergies...), and the longest drive they accept.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const profile = await getProfile(household);
      return { content: [{ type: "text", text: JSON.stringify(profile) }], structuredContent: profile };
    },
  );

  server.registerTool(
    "update_family_profile",
    {
      title: "Update family profile",
      description: "Replace the household profile. Read it first with get_family_profile and send the full updated profile.",
      inputSchema: { profile: profileSchema },
    },
    async ({ profile }) => {
      await saveProfile(household, profile);
      return { content: [{ type: "text", text: `Saved: ${profile.members.length} people, home ${profile.home}.` }], structuredContent: profile };
    },
  );

  server.registerTool(
    "set_max_drive",
    {
      title: "Set max drive",
      description: "Change how long the family is willing to drive one way, in minutes, for every search from now on. Use it when they ask for a different drive limit; for a one-off \"somewhere closer\" use max_drive_minutes on find_outings instead.",
      inputSchema: { minutes: z.number().int().min(10).max(240) },
    },
    async ({ minutes }) => {
      const profile = await getProfile(household);
      const before = profile.max_drive_minutes;
      await saveProfile(household, { ...profile, max_drive_minutes: minutes });
      return { content: [{ type: "text", text: `Max drive is now ${minutes} minutes (was ${before}).` }], structuredContent: { before, minutes } };
    },
  );

  server.registerTool(
    "get_outing_memory",
    {
      title: "Get trip memory",
      description: "The family's past and planned trips with their reviews, and pending_reviews: past trips nobody has said how they went.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const visits = await getVisits(household);
      const memory = { today: new Date().toISOString().slice(0, 10), visits, pending_reviews: pendingReviews(visits) };
      const next = memory.pending_reviews.length
        ? `Before planning anything, ask the user how the ${memory.pending_reviews.at(-1)!.place} trip went and wait for the answer.\n`
        : "";
      return { content: [{ type: "text", text: next + JSON.stringify(memory) }], structuredContent: memory };
    },
  );

  server.registerTool(
    "log_visit",
    {
      title: "Log a trip",
      description: "Remember a trip the family took or decided to take, so the assistant can ask how it went afterwards.",
      inputSchema: {
        place: z.string().describe("Place name as the family says it"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Day of the trip, YYYY-MM-DD"),
        place_id: z.string().optional().describe("place.id from a find_outings or check_place result, if known"),
      },
    },
    async (args) => {
      const visit = await logVisit(household, args);
      return { content: [{ type: "text", text: `Logged ${visit.place} on ${visit.date} (trip ${visit.id}).` }], structuredContent: visit as any };
    },
  );

  server.registerTool(
    "save_visit_review",
    {
      title: "Save how a trip went",
      description: "Save the family's review of a past trip. Future plans use it: low ratings and per-person problems are taken into account.",
      inputSchema: { visit_id: z.string().describe("id from get_outing_memory"), ...reviewSchema.shape },
    },
    async ({ visit_id, ...review }) => {
      const visit = await saveReview(household, visit_id, review);
      reviewed.set(household, { place: visit.place, rating: review.rating, at: Date.now() });
      return {
        content: [{ type: "text", text: `Saved: ${visit.place} rated ${review.rating}/5. The research thanks the user for it when the next search starts; do not mention the review in your answer.` }],
        structuredContent: visit as any,
      };
    },
  );

  server.registerTool(
    "find_outings",
    {
      title: "Find outings that fit the family",
      description:
        "Find places to go within the family's drive limit and rank them by how well they fit every member that day: the hourly forecast at each place, weather and park alerts, wheelchair access and past trips. Use when the user asks where to go. Without `what` it searches well-known landmarks (parks, museums, zoos). When the user wants something specific (a pumpkin patch, an indoor playground, bowling), pass it as `what`. When they want other options, call again with every place already suggested in `exclude`.",
      inputSchema: {
        ...outingArgs,
        interests: z.array(z.enum(["nature", "animals", "museums", "beach", "rides"])).optional().describe("Landmark categories; ignored when `what` is set"),
        what: z.string().max(80).optional().describe("What they want to do, in plain words, e.g. 'pumpkin patch' or 'indoor playground'. Searched on maps near home."),
        exclude: z.array(z.string()).max(40).optional().describe("Only when the user asks for other or different options: the places already suggested. Never exclude on a new request."),
        max_drive_minutes: z.number().int().min(10).max(240).optional().describe("Only for this search, when the user asks for closer or farther places"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: cardMeta,
    },
    async (args, extra) => {
      const plan = await planOuting(
        { profile: await getProfile(household), visits: await getVisits(household), date: args.date ?? nextSaturday(), startHour: args.start_hour, durationH: args.duration_hours, interests: args.interests, what: args.what, exclude: args.exclude, maxDriveMinutes: args.max_drive_minutes, userRequest: args.request, justReviewed: () => justReviewed(household) },
        progressFor(extra),
      );
      return planResult(remember(household, plan));
    },
  );

  server.registerTool(
    "check_place",
    {
      title: "Check one place for the family",
      description: "Check whether a place the user names works for this family on a given day: hourly forecast, alerts, drive time and accessibility. Works for any place, from national parks to a local playground or farm.",
      inputSchema: { place: z.string().describe("Place name, e.g. 'Oakland Zoo' or 'Muir Woods'"), ...outingArgs },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: cardMeta,
    },
    async (args, extra) => {
      const plan = await planOuting(
        { profile: await getProfile(household), visits: await getVisits(household), date: args.date ?? nextSaturday(), startHour: args.start_hour, durationH: args.duration_hours, placeQuery: args.place, userRequest: args.request, justReviewed: () => justReviewed(household) },
        progressFor(extra),
      );
      return planResult(remember(household, plan));
    },
  );

  server.registerTool(
    "tell_about_place",
    {
      title: "Tell about a place",
      description: "Tell the family about one place from the last results, out loud, from what the research already found. No new searching, so it answers in a couple of seconds. The card calls it when a place is tapped; call it when they ask to hear more about one of the results.",
      inputSchema: {
        place: z.string().describe("The place's name as in the results, or its id"),
        speak: z.boolean().optional().describe("False when the card only needs the per-person fit, without speaking"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ place, speak }) => {
      const last = lastResearch.get(household);
      if (!last) return { content: [{ type: "text", text: "There are no results to tell about yet." }], isError: true };
      const want = place.toLowerCase();
      const c = last.plan.candidates.find((x) => x.place.id === place) ?? last.plan.candidates.find((x) => x.place.name.toLowerCase().includes(want) || want.includes(x.place.name.toLowerCase()));
      if (!c) return { content: [{ type: "text", text: `${place} is not in the last results.` }], isError: true };
      const t0 = Date.now();
      // The story made in the background; if that one failed, it is made again now.
      let told: Told;
      try {
        told = await (last.told.get(c.place.id) ?? Promise.reject()).catch(() => {
          const p = tellAbout(last.plan, last.evidence, c.place.id);
          last.told.set(c.place.id, p);
          return p;
        });
      } catch (e: any) {
        console.error(`[tell] ${c.place.name} failed on tap: ${e.message}`);
        return { content: [{ type: "text", text: `Could not tell about ${c.place.name} right now.` }], isError: true };
      }
      console.log(`[tell] ${told.place} in ${Date.now() - t0} ms`);
      return { content: [{ type: "text", text: told.text }], structuredContent: told, _meta: speak === false ? {} : { [SAY_META]: told.text } };
    },
  );

  return server;
}

// Sends planner steps as MCP progress notifications when the client asked for them.
// The structured step goes in _meta, so a host can hand it to the card while the call is still running.
// When the research agent wrote a sentence for the step, it rides along in _meta so a voice device can say it
// instead of going silent for twenty seconds. The server never makes up these lines itself.
const STEP_META = "outing-fit/step";
const SAY_META = "outing-fit/say";
// A review saved just before a search goes to the research agent, which thanks the user in its first spoken line.
const reviewed = new Map<string, { place: string; rating: number; at: number }>();
function justReviewed(household: string) {
  const r = reviewed.get(household);
  reviewed.delete(household);
  return r && Date.now() - r.at < 5 * 60_000 ? { place: r.place, rating: r.rating } : undefined;
}
function progressFor(extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> }) {
  const token = extra._meta?.progressToken;
  let step = 0;
  return (message: string, data?: Step, say?: string) => {
    console.log(say ? `${message} | says: ${say}` : message);
    if (token === undefined) return;
    step++;
    const params = { progressToken: token, progress: step, message, ...(data && { _meta: { [STEP_META]: data, ...(say && { [SAY_META]: say }) } }) };
    extra.sendNotification({ method: "notifications/progress", params }).catch(() => {});
  };
}

const port = Number(process.env.PORT ?? 8787);
const app = express();
app.use(express.json({ limit: "1mb" }));

app.post("/mcp", async (req, res) => {
  // Stateless: one server per request. The household id would come from account linking on a real device.
  const household = String(req.headers["x-household"] ?? "demo").slice(0, 64);
  const server = buildServer(household);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

const OPENROUTER = "https://openrouter.ai/api/v1";
const orHeaders = () => ({ Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` });

// The simulated device's brain: a pi agent that uses this server's tools over real MCP.
// Events stream back as server-sent events so the page can show status, MCP traffic, cards and the spoken answer.
app.post("/api/assistant", async (req, res) => {
  const { session, text, today, screen } = req.body ?? {};
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: "OPENROUTER_API_KEY is not set on the server" });
  if (typeof session !== "string" || typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "session and text are required" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const emit = (e: AssistantEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  try {
    await assistantTurn({
      session: session.slice(0, 64),
      household: String(req.headers["x-household"] ?? "demo").slice(0, 64),
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      today: String(today ?? new Date().toDateString()).slice(0, 40),
      text: text.slice(0, 1000),
      screen: Array.isArray(screen?.places) ? { date: String(screen.date ?? "").slice(0, 10), places: screen.places.slice(0, 10).map((n: unknown) => String(n).slice(0, 80)) } : undefined,
      emit,
    });
  } catch (e: any) {
    console.error(e);
    emit({ type: "error", message: e.message });
  }
  res.end();
});

// Speech to text: the page sends the WAV that voice activity detection cut out of the microphone stream.
app.post("/api/stt", express.raw({ type: "audio/*", limit: "15mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "send audio/wav in the body" });
  const t0 = Date.now();
  // Groq first, OpenRouter if Groq fails; both run Whisper large v3.
  const tries = [
    { name: "groq", url: "https://api.groq.com/openai/v1/audio/transcriptions", headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, model: "whisper-large-v3" },
    { name: "openrouter", url: `${OPENROUTER}/audio/transcriptions`, headers: orHeaders(), model: "openai/whisper-large-v3" },
  ];
  try {
    let data: any, last: any;
    for (const t of tries) {
      try {
        const form = new FormData();
        form.append("model", t.model);
        form.append("language", "en");
        form.append("file", new Blob([new Uint8Array(req.body)], { type: "audio/wav" }), "speech.wav");
        const r = await fetch(t.url, { method: "POST", headers: t.headers, body: form, signal: AbortSignal.timeout(t.name === "groq" ? 6000 : 30000) });
        const d: any = await r.json();
        if (!r.ok) throw new Error(d?.error?.message ?? `${t.name} ${r.status}`);
        data = d;
        console.log(`[voice] stt ${t.name} ${Date.now() - t0} ms, ${(req.body.length / 32000).toFixed(1)} s audio: "${String(d.text ?? "").trim().slice(0, 60)}"`);
        break;
      } catch (e: any) {
        last = e;
        console.error(`[voice] stt ${t.name} failed after ${Date.now() - t0} ms: ${e.message}`);
      }
    }
    if (!data) throw last;
    res.json({ text: String(data.text ?? "").trim() });
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// Text to speech. The model returns raw 16-bit PCM, which is passed straight on to the browser as it arrives,
// so the first words play while the rest is still being made.
// Groq's Orpheus is the voice. When Groq fails, OpenRouter's Grok voice takes over (a minute after a rate limit, a few otherwise),
// so the voice does not switch back and forth between sentences and nobody waits on a dead provider.
const VOICES = [
  { model: "canopylabs/orpheus-v1-english", voice: process.env.TTS_VOICE || "hannah", groq: true, timeout: 5000 },
  { model: "x-ai/grok-voice-tts-1.0", voice: "eve", timeout: 6000 },
];
let firstDownUntil = 0; // the first voice is skipped for a while after it fails
// Groq answers with a WAV stream: read until the "data" chunk starts, take the rate from the header, keep only the samples.
async function skipWav(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let head = Buffer.alloc(0);
  while (head.length < 4096) {
    const r = await reader.read();
    if (r.done) break;
    head = Buffer.concat([head, r.value]);
    const at = head.indexOf("data", 12);
    if (at > 0 && head.length >= at + 8) return { rate: head.readUInt32LE(24), first: new Uint8Array(head.subarray(at + 8)) };
  }
  throw new Error("no WAV data chunk");
}
// Opens the audio stream of the first voice that answers. The timeout covers only the wait for the first byte.
async function openVoice(text: string) {
  const t0 = Date.now();
  for (const v of Date.now() < firstDownUntil ? VOICES.slice(1) : VOICES) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), v.timeout);
    try {
      const r = v.groq
        ? await fetch("https://api.groq.com/openai/v1/audio/speech", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
            signal: ctl.signal,
            body: JSON.stringify({ model: v.model, voice: v.voice, input: text, response_format: "wav" }),
          })
        : await fetch(`${OPENROUTER}/audio/speech`, {
            method: "POST",
            headers: { ...orHeaders(), "Content-Type": "application/json" },
            signal: ctl.signal,
            body: JSON.stringify({ model: v.model, voice: v.voice, input: text, response_format: "pcm" }),
          });
      if (!r.ok || !r.body) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      const reader = r.body.getReader();
      let rate: number, first: Uint8Array | undefined;
      if (v.groq) ({ rate, first } = await skipWav(reader));
      else { first = (await reader.read()).value; rate = Number(/rate=(\d+)/.exec(r.headers.get("content-type") ?? "")?.[1] ?? 24000); }
      clearTimeout(timer);
      console.log(`[voice] tts ${v.model} first audio in ${Date.now() - t0} ms, ${text.length} chars`);
      return { rate, first, reader };
    } catch (e: any) {
      clearTimeout(timer);
      console.error(`[voice] tts ${v.model} failed after ${Date.now() - t0} ms: ${e.message}`);
      if (v === VOICES[0]) firstDownUntil = Date.now() + (/^429/.test(e.message) ? 60 : 5 * 60) * 1000; // a rate limit clears within a minute
    }
  }
  throw new Error("No voice available");
}
// Spoken lines are kept for a while, so a place story made ahead of time plays without waiting.
const voiced = new Map<string, { rate: number; pcm: Buffer }>();
function keepVoice(text: string, rate: number, pcm: Buffer) {
  voiced.set(text, { rate, pcm });
  if (voiced.size > 60) voiced.delete(voiced.keys().next().value!);
}
app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").slice(0, 1500);
  if (!text.trim()) return res.status(400).json({ error: "text is required" });
  const kept = voiced.get(text);
  if (kept) return res.set("x-sample-rate", String(kept.rate)).type("application/octet-stream").send(kept.pcm);
  let voice;
  try { voice = await openVoice(text); } catch { return res.status(502).json({ error: "No voice available" }); }
  const { rate, first, reader } = voice;
  res.set({ "x-sample-rate": String(rate), "Cache-Control": "no-store" }).type("application/octet-stream");
  res.flushHeaders();
  const parts: Uint8Array[] = [];
  const send = (b?: Uint8Array) => { if (b?.length) { parts.push(b); res.write(b); } };
  send(first);
  res.on("close", () => { if (!res.writableEnded) reader.cancel().catch(() => {}); });
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) send(r.value);
    keepVoice(text, rate, Buffer.concat(parts));
  } catch {}
  res.end();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use(express.static(PUBLIC.pathname));

app.listen(port, () => console.log(`Fit Trip on http://localhost:${port} (MCP at /mcp)`));
if (process.env.WARM_CACHES !== "0") keepWarm();
