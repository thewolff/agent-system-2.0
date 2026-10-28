---
date: 2026-10-27T13:50-07:00
engineer: Ilex
session: wl-mvpmehjj3ea9ds
status: resolved
durable: false
supersedes:
workload: wl-mvpmehjj3ea9ds
---

# Jo (2026-10-26 ~19:05Z, answer in-mvpmdhxxyfinsw on q-mvpmbv5oes52io, input in-mvpmdawiy84e0w: "i will want to access linear through as2 often in the future, so we are going with the second re: adding linear to the as2 profile"): add the Linear MCP server to the agent-system-2 OMP profile durably. Per Plumb (msg-ch-1793041129046-69f1156c-9e1c-4d1b-bfc5-868662825bbd): the installed /Users/jowolff/.omp/profiles/agent-system-2/agent/mcp.json is generated from the repo's profile/mcp.json (install/manifest.tsv row `profile/mcp.json  profile  {profile}/agent/mcp.json`; install/install.sh `cp -f "$REPO/$MCP_ROW" "$PROFILE_DIR/mcp.json"`; its only check requires mcpServers.ctx with a command). Change: in profile/mcp.json add under mcpServers, keeping ctx unchanged: "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } (same entry as the default profile's /Users/jowolff/.omp/agent/mcp.json). Update any docs or tests that enumerate the profile's MCP servers. OMP keeps MCP OAuth per profile, so Jo authorizes Linear in the browser on the first as2 call; no credentials in the repo. Do not touch the uncommitted testRunner fullCapMin/fullWorkers values in the main checkout's profile/config.yml (temporary serial-run setting Plumb will restore). Do not run `as2 install`; Jo or Plumb installs after merge. PR only, no merge. Run on Anthropic or OpenAI, not Kimi (Moonshot account suspended).

done: An open, unmerged PR on thewolff/agent-system-2.0 adds the linear http MCP server (https://mcp.linear.app/mcp) to profile/mcp.json alongside ctx, with install.sh's check still passing and the full suite green at its head.
done-because: (no receipt recorded)

Rendered from the ledger by Ilex (they/them) at workload close; stakes normal, mode autonomous, opened 2026-10-26T18:59:04.399Z.

## What changed

- sl-ceiling-mvpmehjj3ea9ds-1: Jo decides the ceiling overrun — artifact: answered stop in-mvpmg8zlq6yqdc

## Decisions made (and why)

- jo answered "stop" to q-mvpmf72ew6aziw (wl-mvpmehjj3ea9ds has used $0.59 of its $0.01 ceiling (5880 %) and 1 of 1 minutes (50 %), normal stakes; 360592 tokens.
stop (the default): the lane keeps working and is stopped at the ceiling; nothing relaunches.
extend: the ceiling grows by one more block of this workload's own size and the lane goes on (a stopped lane relaunches); for an exact figure say `ceiling <usd> [<hours>] wl-mvpmehjj3ea9ds` instead.
split: the lane is stopped at the ceiling like stop, and the remaining work is split into a new workload; nothing relaunches here.)
- jo (surface): Jo: "cancel" — answers q-mvpmf853sqpssg: You told Plumb Linear should not be baked into as2 ("i want this to be configurable. not every user will be using linear"). The workload I opened 19:06Z to add linear to the repo's shared profile/mcp.json (wl-mvpmehjj3ea9ds) contradicts that; I lowered its ceiling to $0.01 / 1 min so its lane stops. Cancel that workload, with any branch or PR it made closed unmerged (cancel), or keep it stopped as-is for later (keep)? Recommend cancel: Plumb is putting a per-user MCP overlay design to you instead, and that would be a different change.
- jo (surface): withdraw wl-mvpmehjj3ea9ds
- orchestrator (surface): close receipt: withdrawn by Jo (in-mvr5r8wfxnttrx): closed with no done-because: receipt
- assumption (orchestrator-surface): brief-judged: change-small confidence 1.00 judge typesafe/jev-1.13.0
- assumption (classifier): pair-exposure: lane-mvpmehjj3ea9ds-1 on
- assumption (classifier): pair-signal: taste no 1 ambiguous no 0.94 judge typesafe/jev-1.13.0 tokens 980 cost 0.00004116
- assumption (lane-mvpmehjj3ea9ds-1): builder-lab: anthropic lane lane-mvpmehjj3ea9ds-1 model anthropic/claude-opus-5-5

## Dead ends — don't retry these

- none

## Heads-up for whoever touches this next

- none
