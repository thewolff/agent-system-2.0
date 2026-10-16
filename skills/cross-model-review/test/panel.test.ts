// Panel kit (wl-mv5m7qvgkxhpj4 PLAN.md § 3.5, CONTRACT.md §§ 1–4): `panel.ts prep` stages every mode
// into a fresh run under a temp HOME's agent-scratch with a manifest whose hashes match, refuses a
// reused or out-of-scratch run, copies the base prompts unchanged; `panel.ts check` accepts a good
// published panel and rejects each PLAN § 3.5 fixture, reading a temp ledger written through the ledger
// module exactly as the classifier writes it (CONTRACT § 3). Last, every kit file has a manifest row.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { Ledger } from "../../../ledger/src/index";
import { finishSynth } from "../../../classifier/src/panel";
import { renderFlags } from "../../../gates/src/rows/r03-receipts";
import { baseExcerpt, check, type Env, type Lab, LABS, main, type Manifest, type Mode, MODES, PanelError, prep, type PrepOptions, sha256 } from "../references/panel/scripts/panel";

const REPO = join(import.meta.dir, "..", "..", "..");
const KIT = join(import.meta.dir, "..", "references", "panel");
const REFS = join(KIT, "..");
const SCRIPT = join(KIT, "scripts", "panel.ts");
const WL = "wl-kittest";
const SL = "sl-kit-review";

let home: string;
let env: Env;
let ledger: Ledger;
let inputs: string;
let repo: string;
let runs = 0;
let groups = 0;

const newRun = () => join(home, "agent-scratch", "runs", `run-${++runs}`);
const input = (name: string, text: string) => {
	const p = join(inputs, name);
	writeFileSync(p, text);
	return p;
};

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", "-c", "user.name=kit", "-c", "user.email=kit@test", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

beforeAll(() => {
	home = realpathSync(mkdtempSync(join(process.env.LEDGER_TEST_TMP ?? tmpdir(), "panel-kit-")));
	mkdirSync(join(home, "agent-scratch"));
	env = { HOME: home, AGENT_SYSTEM_LEDGER_DB: join(home, "as2", "ledger.db") };
	ledger = Ledger.open(env.AGENT_SYSTEM_LEDGER_DB!, { create: true, backup: false });
	ledger.openWorkload({ id: WL, brief: "panel kit test", stakes: "production", mode: "autonomous", by: "orch-test" });
	// The reviewed slice the manifests name: the classifier records a group's synthesis ends on it.
	ledger.addSlice({ id: SL, workloadId: WL, task: "review", doneCondition: "d", inputs: "i", by: "lane-test" });
	inputs = join(home, "inputs");
	mkdirSync(inputs);
	repo = join(home, "repo");
	mkdirSync(repo);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "cache.ts"), "export const ttl = 60;\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "base");
	git(repo, "checkout", "-q", "-b", "feature");
	writeFileSync(join(repo, "cache.ts"), "export const ttl = 600; // ten minutes\nexport const read = (k: string) => k;\n");
	git(repo, "commit", "-q", "-am", "change");
});

afterAll(() => {
	ledger.close();
	rmSync(home, { recursive: true, force: true });
});

function opts(mode: Mode, args: Record<string, string>): PrepOptions {
	return { mode, run: newRun(), workload: WL, slice: SL, args, cwd: repo };
}

const ARGS: Record<Exclude<Mode, "quorum-refute">, () => Record<string, string>> = {
	triad: () => ({ base: "main", ticket: input("ticket.md", "Raise the cache TTL to ten minutes.\n") }),
	"triad-verify": () => ({ base: "main", finding: input("finding.json", JSON.stringify({ title: "TTL unit unclear", severity: "medium", where: "cache.ts:1", what: "600 has no unit", legs: ["A", "C"] })) }),
	quorum: () => ({ brief: input("brief.md", "Plan a cache for the read path.\n"), context: input("context.md", "cache.ts holds ttl.\n"), draft: input("draft.md", "# Draft\n\nStep 1: add an LRU.\n") }),
	refute: () => ({ plan: input("plan.md", "# Plan\n\n1. Add an LRU.\n2. Ship it.\n") }),
	doubt: () => ({ artifact: input("artifact.md", "The cache is thread-safe.\n"), contract: input("contract.md", "Reads never block writes.\n") }),
};

/** Every regular file under `dir`, relative to `base`, `/`-separated. */
function filesUnder(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...filesUnder(p, base));
		else out.push(relative(base, p).split(sep).join("/"));
	}
	return out.sort();
}

function expectHashesMatch(run: string, manifest: Manifest): void {
	const onDisk = filesUnder(run).filter((f) => f !== "manifest.json");
	expect(Object.keys(manifest.inputs).sort()).toEqual(onDisk);
	for (const rel of onDisk) expect(manifest.inputs[rel]).toBe(sha256(readFileSync(join(run, rel))));
	for (const rel of onDisk) expect(lstatSync(join(run, rel)).isSymbolicLink()).toBe(false);
	expect(JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"))).toEqual(manifest);
}

// ---- the classifier's side, as CONTRACT §§ 2–3 pin it -------------------------------------------

type LegFixture = { status: "landed"; model: string; output: Record<string, unknown> & { items: Record<string, unknown>[] } } | { status: "missing" | "excluded"; reason: string };

/** Ingest a staging run and publish its legs (and report) the way the classifier does: pdir copies, ledger lines, hashes. */
function publish(run: string, legs: Record<Lab, LegFixture>, report?: Record<string, unknown>): { pg: string; pdir: string } {
	const pg = `pg-kit${++groups}`;
	const pdir = join(home, "as2", "lanes", WL, "panels", pg);
	cpSync(run, join(pdir, "in"), { recursive: true });
	const manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8")) as Manifest;
	const record = (body: string) => ledger.recordEntry({ by: "classifier-test", workloadId: WL, sliceId: null, kind: "assumption", body });
	const groupInputs = { ...manifest.inputs, "manifest.json": sha256(readFileSync(join(pdir, "in", "manifest.json"))) };
	record(`panel-group: ${pg} ${JSON.stringify({ run, pdir, slice: manifest.slice, mode: manifest.mode, inputs: groupInputs, members: { anthropic: "dt-a", openai: "dt-o", kimi: "dt-k" } })}`);
	mkdirSync(join(pdir, "out", "legs"), { recursive: true });
	const published: Record<string, string> = {};
	const status: Record<string, unknown> = {};
	for (const lab of LABS) {
		const leg = legs[lab];
		if (leg.status === "landed") {
			const delivered = JSON.stringify(leg.output);
			const items = leg.output.items.map((it, n) => ({ ...it, id: `${lab}-${n + 1}` }));
			const text = `${JSON.stringify({ ...leg.output, items }, null, 2)}\n`;
			writeFileSync(join(pdir, "out", "legs", `${lab}.json`), text);
			published[`out/legs/${lab}.json`] = sha256(text);
			record(`panel-leg: ${pg} ${lab} landed sha256 ${sha256(delivered)} bound session`);
			status[lab] = { status: "landed", reason: null, model: leg.model, token: `dt-${lab}`, findingIds: items.map((i) => i.id) };
		} else {
			record(`panel-leg: ${pg} ${lab} ${leg.status} ${leg.reason}`);
			status[lab] = { status: leg.status, reason: leg.reason, model: null, token: null, findingIds: [] };
		}
	}
	const statusText = `${JSON.stringify({ group: pg, legs: status }, null, 2)}\n`;
	writeFileSync(join(pdir, "out", "status.json"), statusText);
	published["out/status.json"] = sha256(statusText);
	record(`panel-published: ${pg} out ${JSON.stringify(published)}`);
	if (report) {
		const json = `${JSON.stringify(report, null, 2)}\n`;
		const md = String(report.markdown);
		writeFileSync(join(pdir, "out", "report.json"), json);
		writeFileSync(join(pdir, "out", "REPORT.md"), md);
		record(`panel-synth: ${pg} dt-synth landed sha256 ${sha256(json)}`);
		record(`panel-published: ${pg} report ${JSON.stringify({ "out/report.json": sha256(json), "out/REPORT.md": sha256(md) })}`);
	}
	return { pg, pdir };
}

const doubtItem = (title: string) => ({ category: "unstated_assumption", title, where: "line 1", what: `${title}: fails on an empty read`, basis: "the artifact's line 1" });

const DOUBT_LEGS: Record<Lab, LegFixture> = {
	anthropic: { status: "landed", model: "claude-test", output: { status: "issues", items: [doubtItem("empty input"), doubtItem("ordering"), doubtItem("naming")] } },
	openai: { status: "landed", model: "gpt-test", output: { status: "issues", items: [doubtItem("empty input"), doubtItem("ordering is fine")] } },
	kimi: { status: "missing", reason: "cancelled" },
};

const LEGS_JSON = [
	{ lab: "anthropic", status: "landed", model: "claude-test", reason: "" },
	{ lab: "openai", status: "landed", model: "gpt-test", reason: "" },
	{ lab: "kimi", status: "missing", model: "", reason: "cancelled" },
];

const DOUBT_MD = `## doubt — kit fixture — 2026-10-12

**CLAIM**
**Legs:** anthropic claude-test landed | openai gpt-test landed | kimi no model missing (cancelled)
Two of three legs landed (out/status.json).

## Contract misread

**PMDW**
None.

## Valid + actionable

### S1 · empty input unchecked · 2/3
**GUESS(inference)**
- anthropic, openai — both name the empty read.

## Valid trade-off

**PMDW**
None.

## Noise

**PMDW**
None.

## Disagreements worth your attention

- **GUESS(inference)** S2 · ordering assumption · 1/3 — anthropic raises it; openai's item says the ordering holds.
`;

function doubtReport(change: { markdown?: (md: string) => string; findings?: unknown; dropped?: unknown } = {}): Record<string, unknown> {
	return {
		legs: LEGS_JSON,
		synth: { lab: "openai", builderLab: false },
		findings: change.findings ?? [
			{ id: "S1", title: "empty input unchecked", section: "Valid + actionable", supportIds: ["anthropic-1", "openai-1"], refuteIds: [] },
			{ id: "S2", title: "ordering assumption", section: "Disagreements worth your attention", supportIds: ["anthropic-2"], refuteIds: ["openai-2"] },
		],
		dropped: change.dropped ?? [{ id: "anthropic-3", reason: "taste: a naming preference with no defect behind it" }],
		markdown: (change.markdown ?? ((m: string) => m))(DOUBT_MD),
	};
}

function doubtPanel(report: Record<string, unknown>, legs = DOUBT_LEGS): { run: string; pg: string; pdir: string } {
	const { run } = prep(opts("doubt", ARGS.doubt()), env);
	return { run, ...publish(run, legs, report) };
}

/** check's failures, asserting every one comes from the rule under test. */
function failuresOnly(target: string, prefix: string): string[] {
	const { failures } = check(target, env);
	expect(failures.length).toBeGreaterThan(0);
	for (const f of failures) expect(f.startsWith(prefix)).toBe(true);
	return failures;
}

// ---- prep --------------------------------------------------------------------------------------

describe("prep", () => {
	for (const mode of ["triad", "triad-verify", "quorum", "refute", "doubt"] as const) {
		test(`${mode}: a fresh run whose manifest hashes every input`, () => {
			const { run, manifest } = prep(opts(mode, ARGS[mode]()), env);
			expect(run.startsWith(realpathSync(join(home, "agent-scratch")) + sep)).toBe(true);
			expect(manifest).toMatchObject({ version: 1, mode, workload: WL, slice: SL, legSchema: "schema/leg.schema.json", synthPrompt: "synth.md", synthSchema: "schema/synth.schema.json", legTimeoutMin: { default: 90 } });
			expectHashesMatch(run, manifest);
			for (const lab of LABS) expect(manifest.legInputs[lab]).toEqual(["packet.md"]);
			const schema = JSON.parse(readFileSync(join(run, manifest.legSchema), "utf8"));
			expect(schema.required).toContain("items");
			expect(schema.properties.items.type).toBe("array");
			expect(readFileSync(join(run, "synth.md"), "utf8")).not.toContain("{{base");
		});
	}

	test("triad: the three lens prompts verbatim in one packet, the diff, the ticket, repo access", () => {
		const { run, manifest } = prep(opts("triad", ARGS.triad()), env);
		const packet = readFileSync(join(run, "packet.md"), "utf8");
		for (const lens of ["architecture", "correctness", "cold-read"]) expect(packet).toContain(readFileSync(join(REFS, "triad", "prompts", `${lens}.md`), "utf8").trimEnd());
		expect(packet).toContain("+export const ttl = 600; // ten minutes");
		expect(packet).toContain("Raise the cache TTL to ten minutes.");
		expect(manifest.repoAccess).toBe(true);
		expect(manifest.repo).toBe(realpathSync(repo));
		const schema = JSON.parse(readFileSync(join(run, manifest.legSchema), "utf8"));
		expect(schema.properties.items.items.properties.lens.enum).toEqual(["architecture", "correctness", "cold-read"]);
		const synth = readFileSync(join(run, "synth.md"), "utf8");
		expect(synth).toContain(baseExcerpt("triad/triad.md", "4. **Read the three outputs cold.**", "## Verify stage (opt-in)"));
		expect(synth).toContain("10. **Write the report** in the house newdle-* severity format below.");
		expect(synth).toContain(baseExcerpt("triad/triad.md", "## Output format", "## Anti-Patterns"));
	});

	test("triad-verify: refute.md verbatim and the finding without which legs raised it", () => {
		const { run } = prep(opts("triad-verify", ARGS["triad-verify"]()), env);
		const packet = readFileSync(join(run, "packet.md"), "utf8");
		expect(packet).toContain(readFileSync(join(REFS, "triad", "prompts", "refute.md"), "utf8").trimEnd());
		expect(packet).toContain("- where: cache.ts:1");
		expect(packet).not.toContain('"A"');
		expect(readFileSync(join(run, "synth.md"), "utf8")).toContain(baseExcerpt("triad/triad.md", "**Scoring.**", "**Expect this to feel wrong at first.**"));
	});

	test("quorum: plan.md verbatim; the draft withheld with a canary in it and in the manifest, never in a packet", () => {
		const { run, manifest } = prep(opts("quorum", ARGS.quorum()), env);
		const packet = readFileSync(join(run, "packet.md"), "utf8");
		expect(packet).toContain(readFileSync(join(REFS, "quorum", "prompts", "plan.md"), "utf8").trimEnd());
		expect(packet).toContain("--- BRIEF ---");
		expect(packet).toContain("cache.ts holds ttl.");
		expect(packet).not.toContain("add an LRU");
		expect(manifest.canary).toMatch(/^panel-canary-[0-9a-f]{32}$/);
		expect(manifest.withheld).toEqual(["withheld/draft.md"]);
		expect(manifest.synthInputs).toEqual(["withheld/draft.md"]);
		expect(readFileSync(join(run, "withheld", "draft.md"), "utf8")).toContain(manifest.canary!);
		expect(packet).not.toContain(manifest.canary!);
		expect(manifest.repoAccess).toBe(false);
		expect(readFileSync(join(run, "synth.md"), "utf8")).toContain(baseExcerpt("quorum/quorum.md", "### Step 4 — Synthesize", "### Step 5 — Hand back"));
	});

	test("quorum --repo-context all: live repo access, no pack", () => {
		const { manifest } = prep(opts("quorum", { brief: input("brief2.md", "Plan it.\n"), "repo-context": "all" }), env);
		expect(manifest.repoAccess).toBe(true);
		expect(manifest.repo).toBe(realpathSync(repo));
		expect(manifest.canary).toBeNull();
	});

	test("refute: refute-plan.md verbatim and the plan as PLAN 1", () => {
		const { run } = prep(opts("refute", ARGS.refute()), env);
		const packet = readFileSync(join(run, "packet.md"), "utf8");
		expect(packet).toContain(readFileSync(join(REFS, "quorum", "prompts", "refute-plan.md"), "utf8").trimEnd());
		expect(packet).toContain("--- PLAN 1 ---\n\n# Plan");
	});

	test("doubt: Step 3's adversarial prompt verbatim with ARTIFACT and CONTRACT pasted, never a CLAIM", () => {
		const { run, manifest } = prep(opts("doubt", ARGS.doubt()), env);
		const packet = readFileSync(join(run, "packet.md"), "utf8");
		const doc = readFileSync(join(REFS, "doubt-driven-development.md"), "utf8");
		const block = doc.slice(doc.indexOf("```", doc.indexOf("### Step 3: DOUBT")) + 4);
		expect(packet.startsWith(block.slice(0, block.indexOf("ARTIFACT: <paste artifact>")))).toBe(true);
		expect(packet).toContain("ARTIFACT: \nThe cache is thread-safe.");
		expect(packet).toContain("CONTRACT: \nReads never block writes.");
		expect(packet).not.toContain("CLAIM:");
		expect(manifest.repoAccess).toBe(false);
		expect(readFileSync(join(run, "synth.md"), "utf8")).toContain(baseExcerpt("doubt-driven-development.md", "### Step 4: RECONCILE — Fold findings back", "### Step 5: STOP"));
	});

	test("--leg-timeout-min sets per-lab timeouts beside the default", () => {
		const o = opts("doubt", ARGS.doubt());
		const { manifest } = prep({ ...o, legTimeoutMin: { kimi: 1 } }, env);
		expect(manifest.legTimeoutMin).toEqual({ default: 90, kimi: 1 });
	});

	test("refuses a run dir that already exists, and writes nothing", () => {
		const o = opts("doubt", ARGS.doubt());
		mkdirSync(o.run, { recursive: true });
		expect(() => prep(o, env)).toThrow(/already exists/);
		expect(readdirSync(o.run)).toEqual([]);
		expect(main(["prep", "doubt", "--run", o.run, "--workload", WL, "--slice", SL, "--artifact", ARGS.doubt().artifact!, "--contract", join(inputs, "contract.md")], env)).toBe(1);
	});

	test("refuses a run outside agent-scratch, directly or through a symlink", () => {
		const outside = join(home, "elsewhere", "run");
		expect(() => prep({ ...opts("doubt", ARGS.doubt()), run: outside }, env)).toThrow(PanelError);
		expect(() => lstatSync(dirname(outside))).toThrow();
		mkdirSync(join(home, "elsewhere"));
		symlinkSync(join(home, "elsewhere"), join(home, "agent-scratch", "escape"));
		expect(() => prep({ ...opts("doubt", ARGS.doubt()), run: join(home, "agent-scratch", "escape", "run") }, env)).toThrow(/not under/);
		expect(readdirSync(join(home, "elsewhere"))).toEqual([]);
	});

	test("refuses an argument the mode does not take, as a usage error", () => {
		expect(main(["prep", "refute", "--run", newRun(), "--workload", WL, "--slice", SL, "--plan", join(inputs, "plan.md"), "--draft", "x"], env)).toBe(2);
	});
});

// ---- quorum, then quorum-refute ------------------------------------------------------------------

const step = (title: string) => ({ kind: "step", title, what: `${title}, verified by a test`, where: "cache.ts", depends_on: [], mitigation: "" });

function quorumLegs(canaryIn?: string): Record<Lab, LegFixture> {
	return {
		anthropic: { status: "landed", model: "claude-test", output: { summary: "ANTHROPIC-PLAN an LRU", items: [step("add an LRU")] } },
		openai: { status: "landed", model: "gpt-test", output: { summary: "OPENAI-PLAN an LRU", items: [step("add an LRU cache")] } },
		kimi: { status: "landed", model: "kimi-test", output: { summary: "KIMI-PLAN a TTL", items: [step(canaryIn ? `tune ttl ${canaryIn}` : "tune ttl")] } },
	};
}

const QUORUM_MD = `## quorum — kit fixture

**CLAIM**
**Legs:** anthropic claude-test landed | openai gpt-test landed | kimi kimi-test landed

## Converged across labs

### S1 · add an LRU · 2/3
**GUESS(inference)**
anthropic and openai both add an LRU.

## Divergent — the real decision points

**PMDW**
None.

## Unique and load-bearing

### S2 · tune the TTL · 1/3
**GUESS(inference)**
kimi alone tunes the TTL.

## Vs. the withheld draft

**GUESS(inference)**
The draft's LRU step is corroborated by two labs.
`;

const QUORUM_REPORT = {
	legs: [
		{ lab: "anthropic", status: "landed", model: "claude-test", reason: "" },
		{ lab: "openai", status: "landed", model: "gpt-test", reason: "" },
		{ lab: "kimi", status: "landed", model: "kimi-test", reason: "" },
	],
	synth: { lab: "kimi", builderLab: false },
	findings: [
		{ id: "S1", title: "add an LRU", section: "Converged across labs", supportIds: ["anthropic-1", "openai-1"], refuteIds: [] },
		{ id: "S2", title: "tune the TTL", section: "Unique and load-bearing", supportIds: ["kimi-1"], refuteIds: [] },
	],
	dropped: [],
	markdown: QUORUM_MD,
};

describe("quorum panel and quorum-refute", () => {
	let quorum: { run: string; pg: string; pdir: string; canary: string };

	beforeAll(() => {
		const { run, manifest } = prep(opts("quorum", ARGS.quorum()), env);
		quorum = { run, canary: manifest.canary!, ...publish(run, quorumLegs(), QUORUM_REPORT) };
	});

	test("check accepts the good quorum report", () => {
		expect(check(quorum.run, env)).toEqual({ pg: quorum.pg, failures: [] });
	});

	test("check rejects a leg output that carries the withheld draft's canary", () => {
		const { run, manifest } = prep(opts("quorum", ARGS.quorum()), env);
		publish(run, quorumLegs(manifest.canary!), QUORUM_REPORT);
		const failures = failuresOnly(run, "canary:");
		expect(failures.join("\n")).toContain("out/legs/kimi.json carries the withheld draft's canary");
	});

	test("prep quorum-refute: each lab's own packet holds the other two plans as PLAN 1/PLAN 2, anonymized", () => {
		for (const from of [quorum.pdir, quorum.run]) {
			const { run, manifest } = prep(opts("quorum-refute", { from }), env);
			expectHashesMatch(run, manifest);
			const own: Record<Lab, string> = { anthropic: "ANTHROPIC-PLAN", openai: "OPENAI-PLAN", kimi: "KIMI-PLAN" };
			for (const lab of LABS) {
				expect(manifest.legInputs[lab]).toEqual([`legs/${lab}/packet.md`]);
				const packet = readFileSync(join(run, "legs", lab, "packet.md"), "utf8");
				expect(packet).toContain(readFileSync(join(REFS, "quorum", "prompts", "refute-plan.md"), "utf8").trimEnd());
				expect(packet).toContain("--- PLAN 1 ---");
				expect(packet).toContain("--- PLAN 2 ---");
				expect(packet).not.toContain(own[lab]);
				for (const other of LABS.filter((l) => l !== lab)) expect(packet).toContain(own[other]);
				expect(packet).not.toMatch(/\b(anthropic|openai|kimi)-\d/);
				expect(packet).not.toContain(quorum.canary);
			}
			expect(readFileSync(join(run, "synth.md"), "utf8")).toContain("- anthropic's packet: PLAN 1 (plan-1) = openai's plan, PLAN 2 (plan-2) = kimi's plan");
		}
	});

	test("prep quorum-refute refuses a source whose bytes no longer match the ledger", () => {
		const { run } = prep(opts("quorum", ARGS.quorum()), env);
		const { pdir } = publish(run, quorumLegs(), QUORUM_REPORT);
		appendFileSync(join(pdir, "out", "legs", "openai.json"), " ");
		expect(() => prep(opts("quorum-refute", { from: pdir }), env)).toThrow(/hash: out\/legs\/openai.json/);
	});
});

// ---- check: the good fixture and each PLAN § 3.5 failure ------------------------------------------

describe("check", () => {
	test("accepts a good published panel, by staging run and by panel directory, and through the CLI", () => {
		const { run, pg, pdir } = doubtPanel(doubtReport());
		expect(check(run, env)).toEqual({ pg, failures: [] });
		expect(check(pdir, env)).toEqual({ pg, failures: [] });
		const r = Bun.spawnSync(["bun", SCRIPT, "check", run], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toBe(`check: ok ${pg}\n`);
	});

	test("accepts the report the classifier publishes from a plain-JSON synthesis reply; a fenced reply publishes none", () => {
		const { run } = prep(opts("doubt", ARGS.doubt()), env);
		const { pg, pdir } = publish(run, DOUBT_LEGS);
		const synthesise = (token: string, text: string) => {
			ledger.recordEntry({ by: "classifier-test", workloadId: WL, kind: "assumption", body: `panel-synth: ${pg} ${token}` });
			return finishSynth(ledger, { workloadId: WL, by: "classifier-test" }, pg, token, { lab: "openai", builderLab: false }, text);
		};
		const fenced = `\`\`\`json\n${JSON.stringify(doubtReport())}\n\`\`\`\n`;
		expect(synthesise("dt-s1", fenced)).toMatchObject({ status: "failed" });
		expect(existsSync(join(pdir, "out", "report.json"))).toBe(false);
		expect(check(run, env).failures).toEqual([`ledger: no panel-published: ${pg} report entry`]);
		const text = JSON.stringify(doubtReport());
		expect(synthesise("dt-s2", text)).toEqual({ status: "landed", sha: sha256(text) });
		expect(readFileSync(join(pdir, "out", "report.json"), "utf8")).toBe(text);
		expect(check(run, env)).toEqual({ pg, failures: [] });
	});

	test("rejects a disagreement case placed outside the disagreement section", () => {
		const report = doubtReport({
			markdown: (md) => md.replace("## Noise\n\n**PMDW**\nNone.\n", "## Noise\n\n- **GUESS(inference)** S2 · ordering assumption · 1/3 — misfiled.\n").replace(/\n## Disagreements[\s\S]*$/, "\n"),
			findings: [
				{ id: "S1", title: "empty input unchecked", section: "Valid + actionable", supportIds: ["anthropic-1", "openai-1"], refuteIds: [] },
				{ id: "S2", title: "ordering assumption", section: "Noise", supportIds: ["anthropic-2"], refuteIds: ["openai-2"] },
			],
		});
		const { run } = doubtPanel(report);
		expect(failuresOnly(run, "disagreements:")).toHaveLength(1);
		const r = Bun.spawnSync(["bun", SCRIPT, "check", run], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("check: FAIL disagreements: S2 has both support and refute ids");
	});

	test("rejects an item dropped without a reason", () => {
		const { run } = doubtPanel(doubtReport({ dropped: [{ id: "anthropic-3", reason: " " }] }));
		expect(failuresOnly(run, "accounting:")).toEqual(["accounting: anthropic-3 is dropped without a reason"]);
	});

	test("rejects an item silently lost, and one counted twice", () => {
		const { run: lost } = doubtPanel(doubtReport({ dropped: [] }));
		expect(failuresOnly(lost, "accounting:")).toEqual(["accounting: anthropic-3 is in no finding and not dropped; it was silently lost"]);
		const { run: twice } = doubtPanel(doubtReport({ dropped: [{ id: "anthropic-3", reason: "taste" }, { id: "openai-1", reason: "duplicate" }] }));
		expect(failuresOnly(twice, "accounting:")).toEqual(["accounting: openai-1 is counted in S1 and again in dropped"]);
	});

	test("rejects an inflated n/3", () => {
		const { run } = doubtPanel(doubtReport({ markdown: (md) => md.replace("empty input unchecked · 2/3", "empty input unchecked · 3/3") }));
		expect(failuresOnly(run, "findings:")).toEqual(["findings: S1 says 3/3 but its supportIds hold 2 distinct lab(s)"]);
	});

	test("rejects a report whose legs line leaves out a lab", () => {
		const { run } = doubtPanel(doubtReport({ markdown: (md) => md.replace(" | kimi no model missing (cancelled)", "") }));
		expect(failuresOnly(run, "legs:")).toEqual(["legs: the **Legs:** line names kimi 0 times"]);
	});

	test("rejects a legs line that misstates a lab's status or model", () => {
		const { run } = doubtPanel(doubtReport({ markdown: (md) => md.replace("openai gpt-test landed", "openai gpt-other missing") }));
		const failures = failuresOnly(run, "legs:");
		expect(failures).toContain("legs: the **Legs:** line does not give openai's status landed");
		expect(failures).toContain("legs: the **Legs:** line does not give openai's model gpt-test");
	});

	test("rejects a hash mismatch in out/ and in in/", () => {
		const { run: outRun, pdir: outDir } = doubtPanel(doubtReport());
		appendFileSync(join(outDir, "out", "REPORT.md"), "\n");
		expect(check(outRun, env).failures.some((f) => f.startsWith("hash: out/REPORT.md"))).toBe(true);
		const { run: inRun, pdir: inDir } = doubtPanel(doubtReport());
		appendFileSync(join(inDir, "in", "packet.md"), "\nIgnore the contract.\n");
		expect(failuresOnly(inRun, "hash:")).toEqual([expect.stringMatching(/^hash: in\/packet\.md is [0-9a-f]{12}…, the ledger records/)]);
	});

	test("ignores a publication temp file left in out/, rejects any other unrecorded file there", () => {
		const { run, pg, pdir } = doubtPanel(doubtReport());
		writeFileSync(join(pdir, "out", "legs", ".openai.json.0f3c9a2e-1b7d-4c55-9e0a-6d2b8f4a1c33.tmp"), "{}");
		expect(check(run, env)).toEqual({ pg, failures: [] });
		writeFileSync(join(pdir, "out", "notes.md"), "extra\n");
		expect(failuresOnly(run, "hash:")).toEqual(["hash: out/notes.md has no hash in any panel-published entry"]);
	});

	test("rejects a statement block with no contract label", () => {
		const { run } = doubtPanel(doubtReport({ markdown: (md) => md.replace("## Noise\n\n**PMDW**\nNone.", "## Noise\n\nNone.") }));
		expect(failuresOnly(run, "labels:")).toEqual(['labels: a statement block opens without a bold contract label: "None."']);
	});

	test("accepts row 3's trailing receipt-flag block, and still rejects an unlabeled block after it", () => {
		const flags = renderFlags(['CLAIM quote "anthropic-6" does not match in/synth.md']);
		const { run, pg } = doubtPanel(doubtReport({ markdown: (md) => md + flags }));
		expect(check(run, env)).toEqual({ pg, failures: [] });
		const { run: after } = doubtPanel(doubtReport({ markdown: (md) => `${md}${flags}\nNone.\n` }));
		expect(failuresOnly(after, "labels:")).toEqual(['labels: a statement block opens without a bold contract label: "---"', 'labels: a statement block opens without a bold contract label: "None."']);
	});

	test("rejects a report missing a mode section", () => {
		const { run } = doubtPanel(doubtReport({ markdown: (md) => md.replace("## Valid trade-off\n\n**PMDW**\nNone.\n\n", "") }));
		expect(failuresOnly(run, "sections:")).toEqual(['sections: doubt report has no "## Valid trade-off" section']);
	});

	test("rejects a landed panel-leg line without its hash and binding (CONTRACT § 3)", () => {
		for (const tail of ["", ` sha256 ${"a".repeat(64)}`, ` sha256 ${"a".repeat(64)} bound guessed`]) {
			const { run, pg } = doubtPanel(doubtReport());
			const body = `panel-leg: ${pg} openai landed${tail}`;
			ledger.recordEntry({ by: "classifier-test", workloadId: WL, kind: "assumption", body });
			expect(failuresOnly(run, "ledger:")).toEqual([`ledger: malformed panel-leg entry: ${body}`]);
		}
	});

	test("rejects a void run and a group with no published report", () => {
		const { run, pg } = doubtPanel(doubtReport());
		ledger.recordEntry({ by: "classifier-test", workloadId: WL, kind: "assumption", body: `panel-run: ${pg} void hash in/packet.md` });
		expect(check(run, env).failures).toEqual([`run void: panel-run: ${pg} void hash in/packet.md`]);
		const unreported = prep(opts("doubt", ARGS.doubt()), env).run;
		const { pg: pg2 } = publish(unreported, DOUBT_LEGS);
		expect(check(unreported, env).failures).toEqual([`ledger: no panel-published: ${pg2} report entry`]);
	});

	test("rejects a staging run no panel-group entry names", () => {
		const { run } = prep(opts("doubt", ARGS.doubt()), env);
		expect(check(run, env).failures).toEqual([`ledger: no panel-group entry on ${WL} names run ${run}`]);
		expect(main(["check", run], env)).toBe(1);
	});
});

// ---- install manifest ---------------------------------------------------------------------------

test("every file under references/panel/ and this test directory has an install/manifest.tsv row", () => {
	const rows = new Set(
		readFileSync(join(REPO, "install", "manifest.tsv"), "utf8")
			.split("\n")
			.filter((l) => l !== "" && !l.startsWith("#"))
			.map((l) => l.split("\t")[0]!),
	);
	const files = [KIT, import.meta.dir].flatMap((d) => filesUnder(d).filter((f) => !f.endsWith(".DS_Store")).map((f) => relative(REPO, join(d, f))));
	expect(files.length).toBeGreaterThan(MODES.length * 3);
	expect(files.filter((f) => !rows.has(f))).toEqual([]);
});
