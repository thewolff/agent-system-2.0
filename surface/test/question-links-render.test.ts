/**
 * Links render clickable at display only (PLAN wl-mv66q5b148uznk revision 6, § Display: links first,
 * clickable; § Slices sl-links-tests, kind "render"). The surface registers a message renderer for its
 * displayed custom types; each `plan:` / `review:` / `pr:` link line renders as a pi-tui `Text` row whose
 * target is wrapped by OMP's own `fileHyperlink` / `uriHyperlink`: with hyperlinks on the row carries
 * `ESC]8;` and shows the path once; with them off it shows the path once and no escape. Paths with
 * Markdown-special characters (`*x*`), spaces, `(` and `#` keep every character. The message content
 * (what the model reads) has no ESC byte.
 *
 * pi-tui is OMP's, loaded from the install the `omp` on PATH runs (as PR #112's test 8b finds it): a bare
 * `@oh-my-pi/pi-tui` import from this repo resolves elsewhere and cannot load OMP's native addon. The
 * surface receives the modules through its `deps.tui` seam (the build's: the extension entry imports
 * pi-tui and hands it over), and `pi.registerMessageRenderer` is OMP's ExtensionAPI method, which
 * fakePi lacks, so this file adds it to its fake. Native OSC 8 coverage skips visibly without OMP;
 * the pure displayRuns coverage runs regardless.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { handSettledBody, handSpawnBody } from "../../classifier/src/lab";
import { reviewRoundBody } from "../../classifier/src/rounds";
import { Ledger } from "../../ledger/src/index";
import orchestratorSurface from "../index";
import { displayRuns } from "../extensions/display";
import { recordRepo } from "../src/decision-log";
import { planFirstBody } from "../src/launch";
import { SURFACE_BY } from "../src/types";
import { ctxOf, fakePi, git, notices, tempRepo, timeouts, timers, tmp, workloadWithSlice } from "./helpers";

const OTHER_LAB = "openai-codex/gpt-6-astra";
const PR_URL = "https://github.com/acme/widgets/pull/9";

/** The `@oh-my-pi/pi-tui` directory of the OMP install the `omp` on PATH runs; null when there is none. */
function piTui(): string | null {
	const omp = Bun.which("omp");
	if (!omp) return null;
	let dir = dirname(realpathSync(omp));
	while (basename(dir) !== "@oh-my-pi") {
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
	const tui = join(dir, "pi-tui");
	return existsSync(join(tui, "src", "render", "hyperlink.ts")) ? tui : null;
}
const PI_TUI = piTui();

interface Component { render(width: number): string[] }
type Renderer = (message: { role: "custom"; customType: string; content: string; display: boolean; timestamp: number }, options: { expanded: boolean }, theme: unknown) => Component | undefined;

const OSC8 = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SGR = /\x1b\[[0-9;]*m/g;
const count = (text: string, part: string): number => text.split(part).length - 1;

describe("displayRuns without OMP", () => {
	test("keeps plan, verdict and PR targets intact in order while leaving non-links as text", () => {
		const plan = "/workspace/a/*x*/my plan (v2) #3/PLAN.md";
		const verdict = "/workspace/reviews (r1)/#1 *v* verdict.md";
		const content = `before\nplan: ${plan}\nreview (sl-a, round 2): ${verdict}\npr: ${PR_URL}\npr: unverified — gh unavailable\nafter`;
		expect(displayRuns(content)).toEqual([
			{ kind: "text", text: "before" },
			{ kind: "link", prefix: "plan: ", target: plan },
			{ kind: "link", prefix: "review (sl-a, round 2): ", target: verdict },
			{ kind: "link", prefix: "pr: ", target: PR_URL },
			{ kind: "text", text: "pr: unverified — gh unavailable\nafter" },
		]);
		expect(displayRuns(`plan: none — no plan\nreview: none — no review`)).toEqual([
			{ kind: "text", text: "plan: none — no plan\nreview: none — no review" },
		]);
	});

	test("recognizes a plan question's bare path and unescapes the displayed plan-path target", () => {
		const path = "/workspace/my plan *draft* (v2) #3.md";
		expect(displayRuns(`- q-a on sl-a:\n  ${path}\nanswer approve`)).toEqual([
			{ kind: "text", text: "- q-a on sl-a:" },
			{ kind: "link", prefix: "  ", target: path },
			{ kind: "text", text: "answer approve" },
		]);
		expect(displayRuns("plan for sl-a: /workspace/my plan \\*draft\\* (v2) #3.md", true)).toEqual([
			{ kind: "link", prefix: "plan for sl-a: ", target: path },
		]);
	});
});

describe("question links: render", () => {
	test.skipIf(PI_TUI === null)("the surface registers a renderer for surface-needs-you; link rows carry ESC]8; with hyperlinks on and the path once with them off, for *x*, spaces, ( and #; the content has no ESC byte", async () => {
		// A plan-first workload whose slice has a complete review round, a recorded plan file and PR, and
		// paths with Markdown-special characters, spaces, ( and #.
		const voice = join(tmp("voice"), "VOICE.md");
		writeFileSync(voice, "VOICE DOC BODY");
		// AGENT_SYSTEM_SURFACE_BATCH_MS 0: a held needs-you line goes out at the poll that finds it (PLAN wl-mv5msri070p0qo D3), as this test reads it.
		const e = { AGENT_SYSTEM_ROLE: "orchestrator", AGENT_SYSTEM_LEDGER_DB: join(tmp("ledger"), "ledger.db"), AGENT_SYSTEM_VOICE: voice, HOME: "/nonexistent-home", AGENT_SYSTEM_SURFACE_BATCH_MS: "0" };
		const open = () => Ledger.open(e.AGENT_SYSTEM_LEDGER_DB, { create: true, backup: false, backupOnOpen: false });
		const l = open();
		const { wl, sl } = workloadWithSlice(l, { brief: "Render workload" });
		l.recordEntry({ by: SURFACE_BY, workloadId: wl, kind: "assumption", body: planFirstBody("your word") });
		expect(l.claimWorkload(wl, { by: "lane-r-1", holder: "lane-r-1", leaseMs: null }).won).toBe(true);
		const repo = tempRepo();
		expect(git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]).code).toBe(0);
		recordRepo(l, wl, repo);
		const base = realpathSync(tmp("render"));
		const P = join(base, "a", "*x*", "my plan (v2) #3", "PLAN.md");
		const V = join(base, "reviews (r1)", "#1 *v* verdict.md");
		for (const file of [P, V]) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "# file\n");
		}
		const entry = (body: string) => l.recordEntry({ by: "lane-r-1", workloadId: wl, sliceId: sl, kind: "assumption", body });
		entry(`plan-file: ${P}`);
		const token = "dt-render1";
		entry(handSpawnBody({ token, root: "/tmp/lane-r-1", spawnKey: sl, review: true, group: "dg-render1", row: [OTHER_LAB] }));
		const routing = l.recordRouting({
			by: "lane-r-1", workloadId: wl, sliceId: sl, spawnKey: sl, sessionRoot: "/tmp/lane-r-1", agentId: `${sl}-1`,
			kind: "judge", confidence: 0.9, probabilities: { judge: 0.9 }, classifiedTier: "strong", tier: "strong",
			models: [OTHER_LAB], judgeModel: "typesafe/jev-1.13.0", outcome: "ran", ranModels: [OTHER_LAB],
		});
		entry(handSettledBody(token, routing));
		entry(reviewRoundBody({ slice: sl, round: 1, token, group: "dg-render1", verdict: "accepted", findings: { counts: { blocking: {}, major: {}, minor: {} }, titles: [] } }));
		entry(`review-verdict: ${token} ${V}`);
		entry(`pr-seen: 9 ${PR_URL}`);
		l.close();

		// OMP's pi-tui, handed to the surface; OMP's registerMessageRenderer on the fake host.
		// Dynamic: the install is found at run time (PI_TUI), outside this repo, so no static import can name it.
		const index = await import(join(PI_TUI!, "src", "index.ts"));
		const hyperlink = await import(join(PI_TUI!, "src", "render", "hyperlink.ts"));
		const tui = { ...index, ...hyperlink };
		const renderers = new Map<string, Renderer>();
		timers.length = 0;
		timeouts.length = 0;
		notices.length = 0;
		const f = fakePi(undefined, { exec: true });
		f.execs.answer = (command, args) => {
			if (command === "git") {
				const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
				return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode, killed: false };
			}
			return { stdout: command === "gh" ? JSON.stringify([{ number: 9, url: PR_URL }]) : "", stderr: "", code: 0, killed: false };
		};
		Object.assign(f.pi, { registerMessageRenderer: (customType: string, renderer: Renderer) => renderers.set(customType, renderer) });
		const deps = { tui };
		orchestratorSurface(f.pi, e, deps);
		const ctx = ctxOf();
		await f.emit("session_start", { type: "session_start" }, ctx);
		await f.emit("before_agent_start", { prompt: "hi", systemPrompt: [] }, ctx);
		await f.tool("orchestrator_wake_read").execute("1", { body: "resuming" }, undefined, undefined, ctx);

		// A lane's accept question after the wake: the tick pushes it as a needs-you aside.
		const l2 = open();
		const q = l2.raiseQuestion({ by: "lane-r-1", workloadId: wl, sliceId: sl, body: "Accept the token move as built?", options: ["accept", "rework"] });
		l2.close();
		timers[0]!.fn();
		let sent = f.sent.find((s) => s.message.customType === "surface-needs-you" && s.message.content.includes(q));
		for (let i = 0; i < 200 && !sent; i++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			sent = f.sent.find((s) => s.message.customType === "surface-needs-you" && s.message.content.includes(q));
		}
		expect(sent).toBeDefined();
		const content = sent!.message.content;
		expect(content).not.toContain("\x1b");
		expect(content).toContain(`plan: ${P}`);
		expect(content).toContain(`review: ${V}`);
		expect(content).toContain(`pr: ${PR_URL}`);

		// The renderer OMP calls for that message.
		const renderer = renderers.get("surface-needs-you");
		expect(renderer).toBeDefined();
		for (const customType of ["surface-wake", "surface-notices"]) expect(renderers.has(customType)).toBe(true);
		index.getMarkdownTheme();
		const rows = (mode: "always" | "off") => {
			hyperlink.applyHyperlinkSetting(mode);
			return renderer!({ role: "custom", customType: "surface-needs-you", content, display: true, timestamp: 0 }, { expanded: true }, index.theme)!.render(400);
		};
		try {
			const on = rows("always");
			const off = rows("off");
			for (const [prefix, target] of [["plan: ", P], ["review: ", V], ["pr: ", PR_URL]] as const) {
				const linked = on.find((r) => r.replace(OSC8, "").replace(SGR, "").includes(`${prefix}${target}`));
				expect(linked).toBeDefined();
				expect(linked).toContain("\x1b]8;");
				expect(count(linked!.replace(OSC8, "").replace(SGR, ""), target)).toBe(1);
				const plain = off.find((r) => r.replace(SGR, "").includes(`${prefix}${target}`));
				expect(plain).toBeDefined();
				expect(plain).not.toContain("\x1b]8;");
				expect(count(plain!.replace(SGR, ""), target)).toBe(1);
			}
		} finally {
			hyperlink.applyHyperlinkSetting("auto");
		}
	});
});
