# Outing Fit

A voice assistant skill that answers one question families ask every weekend: **"Where can we go that works for all of us?"**

Tell it who lives at home (a grandparent in a wheelchair, a four-year-old who naps, a dog) and where home is. Ask for a place or name one. A research agent on the MCP server searches the live web, reads the places' own sites, checks the hourly forecast and weather alerts, and comes back with a ranked list of places, with a verdict for every family member.

**Live demo:** https://13-51-225-247.sslip.io (no keys needed)
**MCP endpoint:** `https://13-51-225-247.sslip.io/mcp` (Streamable HTTP)

## How it works

```
 voice ─► device agent (pi agent + MCP client) ──MCP──► Outing Fit server
                 ▲                                         │
                 │                              research agent (pi agent)
          MCP App card  ◄──────────────────────  web search · page reads · forecast
          on the screen                          places DB · park alerts · drive times
```

- **Device agent** (`src/assistant.ts`): stands in for the smart-display assistant. It is a pi agent that uses the server's tools through a real MCP client. It asks how the last trip went before it starts a new search, and saves the answer.
- **Research agent** (`src/planner.ts`): runs on the server for each search. Tools: `web_search`, `fetch_pages` (up to 10 sites at once), `record_access`, `add_note`, `submit`. It narrates what it is doing while it works, and the device shows that live.
- **MCP App card** (`public/card.html`): the ranked places rendered on the device screen. Tapping a place calls `tell_about_place` through the host and shows a per-member breakdown.
- **Memory** (`src/memory.ts`): the family profile, the visits and the reviews, kept between sessions.

### MCP tools

| Tool | What it does |
|---|---|
| `get_family_profile` / `update_family_profile` | Who is in the household, their needs, and where home is |
| `set_max_drive` | How far the family is willing to drive |
| `find_outings` | "Where can we go?": researches and ranks candidates |
| `check_place` | "Does this place work for us?": a fit check of one place |
| `tell_about_place` | The story of one place, member by member |
| `log_visit` / `save_visit_review` / `get_outing_memory` | Remembers where the family went and how it went |

## Run it

```bash
npm install
cp .env.example .env   # fill in the keys
npm start              # http://localhost:8787
```

Node 20+. The keys:

- `OPENROUTER_API_KEY`: the LLM for both agents (default `deepseek/deepseek-v4.1-flash-1017`), plus fallback speech
- `SERPER_API_KEY`: web and maps search, page scraping
- `GROQ_API_KEY`: speech to text (whisper-large-v3) and text to speech (Orpheus)
- `NPS_API_KEY`: US national park alerts

## Data sources and credits

- [Open-Meteo](https://open-meteo.com): hourly forecast and geocoding
- [National Weather Service](https://www.weather.gov/documentation/services-web-api): weather alerts
- [NPS API](https://www.nps.gov/subjects/developer/api-documentation.htm): park alerts and closures
- [Wikidata](https://www.wikidata.org) via [QLever](https://qlever.dev): places near home
- [OSRM](https://project-osrm.org): drive times
- [Serper](https://serper.dev): web search, maps search and page scraping
- [OpenRouter](https://openrouter.ai) and [Groq](https://groq.com): models, speech
- [pi-agent](https://github.com/badlogic/pi-mono) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## License

MIT
