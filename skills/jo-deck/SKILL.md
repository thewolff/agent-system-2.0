---
name: jo-deck
description: Build a slide deck for Jo as a reveal.js project, following Jo's house rules and researched presentation principles. Use when Jo wants to create, build, design, or draft a presentation, slideshow, slide deck, or talk — whether invoked as /jo-deck or asked for in plain words ("make me a deck", "build slides for X", "I need a presentation about Y"). Runs a disciplined interview → outline → build flow so every deck is a story told through panels, not a wall of bullets.
---

<!-- owned: agent-system 2.0 row #23: ~/.agents/skills/jo-deck (newest of the two copies, SKILL.md 2026-07-24) copied once 2026-10-13 and owned from here (skills/VENDOR.md). -->

# jo-deck

Build Jo a presentation as a **reveal.js project**. A deck is a **story told through panels** — the audience should leave feeling they went on a journey and that they're smarter at the end of it. This skill enforces that discipline.

## Before anything: load the principles

Read `references/presentation-principles.md` (co-located with this skill) **before** outlining. It is the cited research synthesis plus **Jo's house rules (§0)**, which take precedence. The non-negotiables:

- **A deck is a story told through panels.** Narrative, not a report. Every panel is a beat.
- **The audience leaves smarter, having gone on a journey.** Engagement is the whole game.
- **Never fill a panel with small text — especially long bullet lists.** A slide supports the speaker; it is not a document. The words go in the speaker notes, not on the panel (this is the *redundancy effect* — on-screen text duplicating speech measurably lowers retention).
- **Don't overuse transitions.** Fancy slide transitions make everyone mad. Keep them invisible (`fade` or `none`).

Treat the **PLEASE DON'TS checklist (§5)** as a pre-flight gate before handing any deck back.

<!-- owned: agent-system 2.0 row #23: voice/VOICE.md § HTML artifacts governs every jo-deck deck (Jo, 2026-10-13); the paragraph below and the marked edits after it carry that rule. -->

Every deck also follows `voice/VOICE.md` § HTML artifacts: its files live under `/Users/jowolff/html-artifacts/<slug>/` and are never published anywhere, and Jo's Venture Bros template at `/Users/jowolff/references/venture-bros-palette.html` is read before designing, every time, for its palette and design language, not hex values from memory.

## Workflow — always interview → outline → build

This skill may auto-invoke when Jo asks for a presentation. Do **not** skip to building.

### 1. Interview (pin the story before any slide)

Ask Jo (batch the questions; skip any already answered in the request):

- **Topic** — what's the deck about?
- **Audience** — who's in the room, how technical, what do they already know?
- **The Big Idea / throughline** — the ONE thing, in ≤15 words, they should be able to repeat afterward. If Jo can't name it, help them find it before moving on.
- **The contrast** — what's the "what is" (status quo / problem / tension) and the "what could be" (the better future)? This is the spine of the story.
- **Where it's presented** — from a browser, screen-shared? (The *files* always go to `/Users/jowolff/html-artifacts/<slug>/` — this asks about the presenting context, which shapes layout and contrast.) <!-- owned: agent-system 2.0 row #23: "hosted as a static site?" dropped and ~/decks/<slug>/ replaced, per voice/VOICE.md § HTML artifacts (never published). -->
- **Length** — rough duration or panel budget.
- **Must-includes** — specific data, images, quotes, a hero moment, a brand/visual vibe.

If the Big Idea or the contrast is missing, stop and get it. A deck without a throughline has nothing to stick.

### 2. Outline (panel-by-panel, for sign-off)

Draft the deck as an ordered list of panels **before building**. For each panel: its single idea, and what carries it (image / one line / a chart). Map the whole thing to the contrast arc:

- **Open** with something curious/unexpected that earns attention.
- Alternate **"what is" ↔ "what could be"** to build tension (Duarte's Sparkline).
- **One idea per panel.** If a panel has two ideas, split it.
- **Close** on the Big Idea and the stakes — never an "any questions?" fade-out.

Present the outline and wait for Jo's sign-off (or edits). Do not build until approved.

### 3. Build (reveal.js project)

Scaffold the deck (see **Scaffold** below).

**Optional delegation (for big or image-heavy decks):** once Jo has signed off on the outline, the build may be handed to a `builder` subagent for context isolation — generating dozens of panels of HTML and fetching reveal.js docs is verbose and doesn't need the main thread. The **interview and outline stay in the main loop** (a subagent can't talk to Jo); only delegate phase 3 *after* sign-off. When delegating, the prompt must include: the approved panel outline, the absolute path to this skill's `references/presentation-principles.md` (instruct the agent to read §0 house rules and §5 don'ts), the target `/Users/jowolff/html-artifacts/<slug>/` (instruct the agent to keep the deck local there and never publish it anywhere), the Venture Bros template `/Users/jowolff/references/venture-bros-palette.html` (instruct the agent to read it before designing, for the palette and design language), <!-- owned: agent-system 2.0 row #23: target folder replaced and the keep-local / never-publish / read-the-template requirements added, per voice/VOICE.md § HTML artifacts. --> and the npm-scaffold + verify-against-reveal-docs requirements below. The subagent runs the pre-flight gate (step 4) before returning. For a normal-size deck, just build it inline — delegation is for when the volume would clog the conversation.

While authoring:

- **One idea per slide. Big, legible type. Images over text.** No long bullet lists — if you're typing a paragraph onto a slide, it belongs in speaker notes.
- **Words go in `<aside class="notes">`**, not on the panel. The panel shows; the speaker tells.
- **Transitions: `fade` or `none`.** Never the flashy ones.
- **High-res images, full-bleed where it serves the story.** No clip-art, no chartjunk, no 3D pie charts.
- **Whitespace is a feature.** Don't fill the canvas because it's there.
- Keep a consistent type scale, color, and layout across panels.

### 4. Pre-flight (gate before handoff)

Walk the **PLEASE DON'TS checklist** in `references/presentation-principles.md §5`. Fix any hit before handing back. Confirm: every panel has one idea, no wall-of-text, the throughline is repeatable, the close lands the stakes, transitions are restrained.

## Scaffold

**Every deck lives at `/Users/jowolff/html-artifacts/<slug>/`** — this is the home for Jo's decks. Pick a short kebab-case `<slug>` from the topic (confirm it with Jo). Don't scatter decks into the current working directory. <!-- owned: agent-system 2.0 row #23: ~/decks/<slug>/ replaced, per voice/VOICE.md § HTML artifacts. -->

Default to a **full npm reveal.js project** — reveal.js installed locally so the deck runs fully **offline** and can export to PDF. No reliance on a CDN at present-time.

reveal.js versions and setup drift. **Before scaffolding, fetch the current reveal.js installation docs (https://revealjs.com/installation/) and confirm the exact steps** rather than trusting the snippet below from memory. The shape is:

<!-- owned: agent-system 2.0 row #23: ~/decks/<slug>/ replaced in this block, per voice/VOICE.md § HTML artifacts. -->

```
/Users/jowolff/html-artifacts/<slug>/
├── package.json          # reveal.js as a dependency + a local static-server / dev script
├── index.html            # the deck — references local node_modules, not a CDN
└── assets/               # images, fonts, etc. (kept local so the deck is self-contained)
```

<!-- owned: agent-system 2.0 row #23: ~/decks/<slug> replaced in this block, per voice/VOICE.md § HTML artifacts. -->

```bash
mkdir -p /Users/jowolff/html-artifacts/<slug> && cd /Users/jowolff/html-artifacts/<slug>
npm init -y
npm install reveal.js
# add a dev-server dependency (e.g. vite or a static server) and a "start" script
```

`index.html` references the **local** install (not a CDN), e.g.:

<!-- owned: agent-system 2.0 row #23: reveal's theme/black.css replaced by a local assets/theme.css built from the Venture Bros template, per voice/VOICE.md § HTML artifacts. -->

```html
<link rel="stylesheet" href="node_modules/reveal.js/dist/reveal.css" />
<link rel="stylesheet" href="assets/theme.css" id="theme" />
...
<div class="reveal"><div class="slides">
  <!-- one <section> per panel; one idea each -->
  <section>
    <h1>The Big Idea</h1>
    <aside class="notes">Spoken words live here, NOT on the slide.</aside>
  </section>
</div></div>
<script type="module">
  import Reveal from 'node_modules/reveal.js/dist/reveal.esm.js';
  import Notes from 'node_modules/reveal.js/plugin/notes/notes.esm.js';
  Reveal.initialize({
    hash: true,
    transition: 'fade', // restrained, per house rules — never 'zoom'/'convex'/etc.
    plugins: [Notes],
  });
</script>
```

- **Theme:** `assets/theme.css` is the deck's own theme, built from Jo's Venture Bros template (`/Users/jowolff/references/venture-bros-palette.html`, read before designing) on top of the kept `reveal.css` base; reveal's stock themes are not used. <!-- owned: agent-system 2.0 row #23: bullet added, per voice/VOICE.md § HTML artifacts. -->
- Modules load over `http://`, not `file://` — run the dev server to view. **Confirm the exact import paths and server command against the fetched docs**; ESM paths in particular change between major versions.
- Keep images/fonts in `assets/` locally so the whole `/Users/jowolff/html-artifacts/<slug>/` folder is portable and offline-safe. <!-- owned: agent-system 2.0 row #23: ~/decks/<slug>/ replaced, per voice/VOICE.md § HTML artifacts. -->
- Speaker notes: press **S** in the browser for the notes view.
- **PDF export:** reveal.js prints via the `?print-pdf` query string + browser print-to-PDF (or decktape). Confirm the current method in the docs before promising it.
- Before handing back: run the dev server, verify the deck opens and navigates, then print the folder path and the run command (`npm start` or whatever the scaffold uses), plus "press S for notes, arrow keys to navigate."

## Notes

- This is Jo's personal skill, vendored in agent-system 2.0's `skills/` (skills/VENDOR.md row 23) <!-- owned: agent-system 2.0 row #23: "a personal skill in Jo's `~/.Codex`" rewritten to name this repo. --> — it is not customer-facing copy, so no humanizer pass on the deck-building process itself. Any end-user-facing *copy inside the deck* still follows good writing; lean on the principles file.
- The references file is the source of truth for *why* each rule exists. When Jo pushes back on a rule, cite the section rather than defending from memory.
