import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_MODEL, openRouterModel } from "./planner.js";

// The simulated voice assistant's brain: a pi agent that reaches the outing skill only through MCP,
// the same way the real assistant would. Each browser tab gets its own session and conversation.

export type AssistantEvent =
  | { type: "status"; text: string }
  | { type: "mcp"; dir: "→" | "←"; body: unknown }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "progress"; name: string; message: string; say?: string; step?: unknown }
  | { type: "tool"; name: string; args: unknown; result: any }
  | { type: "say"; text: string }
  | { type: "preface"; text: string }
  | { type: "error"; message: string };

interface Session {
  agent: Agent;
  client: Client;
  emit: (e: AssistantEvent) => void;
  lastUsed: number;
  reviewAsked: boolean; // the pending-review question was asked (or answered) in this conversation
  holdTurn: boolean; // this turn held a search back to ask about a past trip first
  preface?: string; // what the model wrote alongside a search call, spoken once the search really starts
}

// A past trip nobody reviewed is asked about before any search starts, never after the answer.
// The model tends to call the memory and the search in one parallel turn, so the order is enforced here, not left to the prompt.
const SEARCH_TOOLS = new Set(["find_outings", "check_place"]);
async function pendingTrip(client: Client): Promise<string | undefined> {
  const r: any = await client.callTool({ name: "get_outing_memory", arguments: {} }).catch(() => null);
  return r?.structuredContent?.pending_reviews?.at(-1)?.place;
}

const sessions = new Map<string, Session>();
const IDLE_MS = 30 * 60 * 1000;

setInterval(() => {
  for (const [id, s] of sessions) {
    if (Date.now() - s.lastUsed > IDLE_MS) {
      s.client.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

function systemPrompt(today: string, instructions: string) {
  return `You are the home voice assistant on a smart display in a family's kitchen. Today is ${today}.
You speak out loud, so answer in one to three short plain sentences, under 40 words in total: no markdown, no lists, no emoji, no URLs.
Every extra word delays the voice, so never read out the card or the tool output.
Outing tools show a detailed card on the screen, so give the answer and the one reason that matters, not every number.
Ask at most one question at a time.
The research speaks while it works, so never talk over it:
- If what you heard is garbled, cut off or makes no sense, ask them to say it again in a few words, and call no tool.
- When you call find_outings or check_place, write one short sentence of at most eight words in that same message, before the call, like "On it, looking for places now." Never thank or mention a review in it: the research thanks for the review itself. The research then narrates its own progress out loud, so stay silent until it returns.
- When the results are in, give a very short wrap-up that names two or three of the best places with a few words each, under 30 words. The card shows the full ranking.
- When they ask to hear more about one place from the results, call tell_about_place and then say exactly what it returns.
Write no text in a message that calls any other tool. Turn relative days like "this Saturday" or "tomorrow" into YYYY-MM-DD yourself.
If the user only answers your question, act on it and then continue with what they asked before.
When they choose where to go ("we want to go to number two", "let's do the first one", "book that one"), that is a decision,
not a question: call log_visit right away with that place and the day of the search (not tell_about_place), then confirm in
one short sentence with the day and that you will ask how it went. Only "tell me about" or "what is" asks for tell_about_place.

The family's outing skill is connected over MCP. Its instructions:
${instructions}`;
}

async function openSession(id: string, household: string, mcpUrl: string, today: string): Promise<Session> {
  const client = new Client({ name: "outing-fit-device", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { "x-household": household } } }));
  const { tools: mcpTools } = await client.listTools();

  const session = { client, emit: () => {}, lastUsed: Date.now(), reviewAsked: false, holdTurn: false } as unknown as Session;
  const tools: AgentTool<any>[] = mcpTools.map((t) => ({
    name: t.name,
    label: t.title ?? t.name,
    description: t.description ?? "",
    parameters: t.inputSchema as any,
    execute: async (_id, args) => {
      if (SEARCH_TOOLS.has(t.name) && !session.reviewAsked) {
        const trip = await pendingTrip(client);
        if (trip) {
          session.holdTurn = true;
          throw new Error(`Not yet. The ${trip} trip has no review. In this turn only ask the user how it went, in one short question, and stop. Search after they answer.`);
        }
        session.reviewAsked = true;
      }
      // One short line from the assistant before the research takes over the voice; a held search drops it.
      if (SEARCH_TOOLS.has(t.name) && session.preface) { session.emit({ type: "preface", text: session.preface }); session.preface = undefined; }
      if (t.name === "save_visit_review") session.reviewAsked = true;
      session.emit({ type: "mcp", dir: "→", body: { method: "tools/call", params: { name: t.name, arguments: args } } });
      session.emit({ type: "tool_start", name: t.name, args });
      const result: any = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, {
        timeout: 180_000,
        resetTimeoutOnProgress: true,
        onprogress: (p: any) => {
          if (!p.message) return;
          session.emit({ type: "status", text: p.message });
          session.emit({ type: "progress", name: t.name, message: p.message, step: p._meta?.["outing-fit/step"], say: p._meta?.["outing-fit/say"] });
        },
      });
      session.emit({ type: "mcp", dir: "←", body: { content: result.content, _meta: result._meta } });
      session.emit({ type: "tool", name: t.name, args, result });
      const text = result.content?.map((c: any) => (c.type === "text" ? c.text : "")).join("\n") || "Done.";
      if (result.isError) throw new Error(text);
      return { content: [{ type: "text", text }], details: {} };
    },
  }));

  const modelId = process.env.ASSISTANT_MODEL || process.env.AGENT_MODEL || DEFAULT_MODEL;
  session.agent = new Agent({
    initialState: { systemPrompt: systemPrompt(today, client.getInstructions() ?? ""), model: openRouterModel(modelId), tools, thinkingLevel: "off" },
  });
  let mark = 0;
  session.agent.subscribe((e) => {
    if (e.type === "turn_start") mark = Date.now();
    if (e.type === "message_end" && e.message.role === "assistant") {
      console.log(`[device] model ${Date.now() - mark} ms`);
      const content = e.message.content;
      const text = content.map((c) => (c.type === "text" ? c.text : "")).join(" ").replace(/\s+/g, " ").trim();
      session.preface = text && content.some((c) => c.type === "toolCall" && SEARCH_TOOLS.has(c.name)) ? text.slice(0, 120) : undefined;
    }
    if (e.type === "tool_execution_end") { console.log(`[device] ${e.toolName} ${Date.now() - mark} ms`); mark = Date.now(); }
    if (e.type === "tool_execution_start") session.emit({ type: "status", text: `Asking the outing skill: ${e.toolName.replace(/_/g, " ")}` });
  });
  return session;
}

function lastAssistantText(agent: Agent) {
  const msg = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant") as any;
  return (msg?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ").trim();
}

export async function assistantTurn(opts: {
  session: string;
  household: string;
  mcpUrl: string;
  today: string;
  text: string;
  screen?: { date: string; places: string[] }; // the ranked places on the screen right now, so a fresh session still knows "number two"
  emit: (e: AssistantEvent) => void;
}) {
  let s = sessions.get(opts.session);
  let input = opts.text;
  if (!s) {
    if (opts.screen?.places.length) input = `(On the screen from the last search, for ${opts.screen.date}: ${opts.screen.places.map((n, i) => `${i + 1}. ${n}`).join("; ")}.)\n${input}`;
    opts.emit({ type: "status", text: "Connecting to the outing skill" });
    s = await openSession(opts.session, opts.household, opts.mcpUrl, opts.today);
    sessions.set(opts.session, s);
  }
  if (s.agent.state.isStreaming) s.agent.abort();
  s.emit = opts.emit;
  s.lastUsed = Date.now();
  opts.emit({ type: "status", text: "Thinking" });
  const t0 = Date.now();
  await s.agent.prompt(input);
  console.log(`[device] turn ${Date.now() - t0} ms for "${opts.text.slice(0, 60)}"`);
  // The question went out this turn; whatever the user says next, the search goes ahead.
  if (s.holdTurn) { s.holdTurn = false; s.reviewAsked = true; }
  const err = s.agent.state.errorMessage;
  const text = lastAssistantText(s.agent);
  if (text) opts.emit({ type: "say", text });
  else if (err) opts.emit({ type: "error", message: err });
}

export function endSession(id: string) {
  const s = sessions.get(id);
  s?.client.close().catch(() => {});
  sessions.delete(id);
}
