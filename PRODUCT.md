# Fit Trip

## What it is
A voice-assistant skill, served as a self-hosted MCP server, that tells a family whether a day out works for every member: who is coming (ages, wheelchair, stroller, heat or cold sensitivity, low stamina), the hourly forecast at the place, weather and park alerts, drive time from home, and how past trips went. A research agent on the server picks its own public data sources (Wikidata, National Park Service, Google Maps search, web pages, Open-Meteo, Weather Service, OSRM) and ranks places with a fit verdict and a reason.

## Who uses this surface
The demo page is for hackathon judges (Build, Ship, Shape). They open it on a laptop, often with no setup, and decide within a minute whether the project is deep and real. It also appears in the demo video.

## What the page must do
- Simulate the smart display: the assistant (a pi agent) talks over MCP to the server, the MCP App card renders on the device screen, live while research runs.
- Make the two agents visibly distinct: the device agent and the server's research agent.
- Show the MCP traffic between them as it happens.
- Let the judge change the home location and the family members, so they can see results change.
- Keep text minimal. No instructions that repeat what the interface already shows.

## Constraints
- Plain HTML/JS served by the Express server, no build step.
- Must stay live until 2026-11-20 without judges pasting keys.
- No third-party trademarks or product names anywhere: not in the page, the prompts, or the video. The assistant is just "Assistant".
