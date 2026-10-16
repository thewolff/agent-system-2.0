#!/usr/bin/env bun
// Panel kit (wl-mv5m7qvgkxhpj4 PLAN.md § 3.5; the byte-level interface is that workload's CONTRACT.md §§ 1–4):
// stage a panel run for the classifier, and check a published panel against the ledger.
//
// Usage (from the repo root; paths may be relative to the cwd):
//   bun skills/cross-model-review/references/panel/scripts/panel.ts prep <mode> --run <dir> --workload <wl> --slice <sl>
//       [--leg-timeout-min <lab|default>=<minutes>]... <mode args>
//     triad          --base <ref> --ticket <path> [--repo <worktree>]
//     triad-verify   --finding <json path> --base <ref> [--repo <worktree>]
//     quorum         --brief <path> [--context <path> | --repo-context all] [--draft <path>] [--repo <worktree>]
//     quorum-refute  --from <quorum pdir or quorum staging run>
//     refute         --plan <path>
//     doubt          --artifact <path> --contract <path>
//   bun skills/cross-model-review/references/panel/scripts/panel.ts check <staging run or pdir>
//
// prep creates <run> (it must not exist, and its realpath must sit under the realpath of
// $HOME/agent-scratch/), writes the inputs and manifest.json with every input's sha256, and nothing else.
// Base prompts are copied unchanged from references/triad/prompts, references/quorum/prompts and
// references/doubt-driven-development.md; the synthesis prompts expand their `{{base …}}` lines from the
// base files at prep time, so a run always carries the base's current rules verbatim.
// check never writes: it reads the panel directory and the ledger (read-only, through the ledger module)
// and prints one line per failed rule.
// Exit: 0 ok · 1 prep refused or check failed · 2 usage.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { defaultLedgerPath, Ledger } from "../../../../../ledger/src/index";

export type Lab = "anthropic" | "openai" | "kimi";
export const LABS: readonly Lab[] = ["anthropic", "openai", "kimi"];
export const MODES = ["triad", "triad-verify", "quorum", "quorum-refute", "refute", "doubt"] as const;
export type Mode = (typeof MODES)[number];
export type Env = Record<string, string | undefined>;

/** references/panel/ */
export const KIT_DIR = join(import.meta.dir, "..");
/** references/ — the bases' root */
export const REFS_DIR = join(KIT_DIR, "..");

export const LEG_SCHEMA = "schema/leg.schema.json";
export const SYNTH_PROMPT = "synth.md";
export const SYNTH_SCHEMA = "schema/synth.schema.json";
export const DEFAULT_LEG_TIMEOUT_MIN = 90;

/** A refusal: prep would stage something the contract forbids, or a source cannot be trusted. Exit 1. */
export class PanelError extends Error {}
/** A malformed command line. Exit 2. */
export class UsageError extends Error {}

export interface Manifest {
	version: 1;
	mode: Mode;
	workload: string;
	slice: string;
	createdAt: string;
	repoAccess: boolean;
	repo: string | null;
	legSchema: string;
	synthPrompt: string;
	synthSchema: string;
	legTimeoutMin: Record<string, number>;
	inputs: Record<string, string>;
	legInputs: Record<Lab, string[]>;
	synthInputs: string[];
	withheld: string[];
	canary: string | null;
}

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

// ---- base text ---------------------------------------------------------------------------------

/**
 * The lines of references/<rel> from the first line starting with `start` up to (not including) the
 * next line starting with `end`, trailing whitespace trimmed. Throws when either marker is missing, so a
 * base edit that moves a heading fails prep loudly instead of shipping a truncated rule.
 */
export function baseExcerpt(rel: string, start: string, end: string): string {
	const lines = readFileSync(join(REFS_DIR, rel), "utf8").split("\n");
	const from = lines.findIndex((l) => l.startsWith(start));
	if (from < 0) throw new PanelError(`base ${rel}: no line starts with ${JSON.stringify(start)}`);
	const to = lines.findIndex((l, i) => i > from && l.startsWith(end));
	if (to < 0) throw new PanelError(`base ${rel}: no line starts with ${JSON.stringify(end)} after ${JSON.stringify(start)}`);
	return lines.slice(from, to).join("\n").trimEnd();
}

/** A kit prompt with every `{{base <rel> :: <start> :: <end>}}` line replaced by that base excerpt. */
export function expandBase(prompt: string): string {
	return prompt.replace(/^\{\{base (.+?) :: (.+?) :: (.+?)\}\}$/gm, (_m, rel: string, start: string, end: string) => baseExcerpt(rel, start, end));
}

/** A base prompt file under references/, as written, minus its trailing newline. */
export function basePrompt(rel: string): string {
	return readFileSync(join(REFS_DIR, rel), "utf8").trimEnd();
}

/** doubt-driven-development.md Step 3's adversarial prompt: the first fenced block after the Step 3 heading. */
export function doubtAdversarialPrompt(): string {
	const rel = "doubt-driven-development.md";
	const lines = readFileSync(join(REFS_DIR, rel), "utf8").split("\n");
	const step = lines.findIndex((l) => l.startsWith("### Step 3: DOUBT"));
	const open = lines.findIndex((l, i) => i > step && l.trimEnd() === "```");
	const close = lines.findIndex((l, i) => i > open && l.trimEnd() === "```");
	if (step < 0 || open < 0 || close < 0) throw new PanelError(`base ${rel}: Step 3's adversarial prompt block not found`);
	const block = lines.slice(open + 1, close).join("\n");
	if (!block.includes("ARTIFACT: <paste artifact>") || !block.includes("CONTRACT: <paste contract>")) {
		throw new PanelError(`base ${rel}: Step 3's prompt no longer has its ARTIFACT/CONTRACT placeholders`);
	}
	return block;
}

const kitText = (rel: string): string => readFileSync(join(KIT_DIR, rel), "utf8");

// ---- prep --------------------------------------------------------------------------------------

export interface PrepOptions {
	mode: Mode;
	run: string;
	workload: string;
	slice: string;
	legTimeoutMin?: Record<string, number>;
	/** mode arguments by flag name without the leading dashes */
	args: Record<string, string>;
	/** where relative paths resolve and the default --repo; process.cwd() when omitted */
	cwd?: string;
	/** clock for createdAt */
	now?: () => string;
}

export interface PrepResult {
	run: string;
	manifest: Manifest;
}

interface Staged {
	files: Map<string, string>;
	repoAccess: boolean;
	repo: string | null;
	legInputs: Record<Lab, string[]>;
	synthInputs: string[];
	withheld: string[];
	canary: string | null;
}

const MODE_ARGS: Record<Mode, { required: string[]; optional: string[] }> = {
	triad: { required: ["base", "ticket"], optional: ["repo"] },
	"triad-verify": { required: ["finding", "base"], optional: ["repo"] },
	quorum: { required: ["brief"], optional: ["context", "repo-context", "draft", "repo"] },
	"quorum-refute": { required: ["from"], optional: [] },
	refute: { required: ["plan"], optional: [] },
	doubt: { required: ["artifact", "contract"], optional: [] },
};

/** The realpath of $HOME/agent-scratch, which every staging run must sit under. */
export function scratchRoot(env: Env): string {
	const home = env.HOME;
	if (!home) throw new PanelError("HOME is not set; a staging run must sit under $HOME/agent-scratch/");
	const root = join(home, "agent-scratch");
	try {
		return realpathSync(root);
	} catch {
		throw new PanelError(`${root} does not exist; a staging run must sit under it`);
	}
}

/** The path the OS would open for a not-yet-existing `abs`: the nearest existing ancestor's realpath plus the rest. */
function prospectiveRealpath(abs: string): string {
	const rest: string[] = [];
	let head = abs;
	for (;;) {
		try {
			lstatSync(head);
			return join(realpathSync(head), ...rest.reverse());
		} catch {
			const up = dirname(head);
			if (up === head) return abs;
			rest.push(head.slice(up.length).replace(/^[/\\]+/, ""));
			head = up;
		}
	}
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** Where a new staging run will be created (its prospective realpath); refuses an existing path or one outside agent-scratch. */
export function stagingTarget(run: string, env: Env, cwd = process.cwd()): string {
	const abs = resolve(cwd, run);
	if (exists(abs)) throw new PanelError(`run dir ${abs} already exists; a panel run is never reused, prep a new one`);
	const root = scratchRoot(env);
	const real = prospectiveRealpath(abs);
	if (!real.startsWith(root + sep)) throw new PanelError(`run dir ${abs} resolves to ${real}, which is not under ${root}`);
	return real;
}

function readInput(path: string, what: string, cwd: string): { abs: string; text: string } {
	const abs = resolve(cwd, path);
	let st;
	try {
		st = statSync(abs);
	} catch {
		throw new PanelError(`${what} ${abs} does not exist`);
	}
	if (!st.isFile()) throw new PanelError(`${what} ${abs} is not a regular file`);
	const text = readFileSync(abs, "utf8");
	if (text.trim() === "") throw new PanelError(`${what} ${abs} is empty`);
	return { abs, text };
}

function git(repo: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new PanelError(`git ${args.join(" ")} in ${repo} failed: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`);
	return r.stdout.toString();
}

function worktree(path: string | undefined, cwd: string): string {
	const start = resolve(cwd, path ?? ".");
	return realpathSync(git(start, "rev-parse", "--show-toplevel").trim());
}

function checkRef(ref: string): string {
	if (ref === "" || ref.startsWith("-") || /\s/.test(ref)) throw new PanelError(`--base ${JSON.stringify(ref)} is not a git ref`);
	return ref;
}

/** `git diff <base>...HEAD` of the worktree plus the scope lines that pin it. */
function branchDiff(repo: string, base: string): { diff: string; scope: string } {
	const head = git(repo, "rev-parse", "HEAD").trim();
	const mergeBase = git(repo, "merge-base", base, "HEAD").trim();
	const diff = git(repo, "diff", `${base}...HEAD`);
	if (diff.trim() === "") throw new PanelError(`git diff ${base}...HEAD in ${repo} is empty; there is nothing to review`);
	const changed = diff.split("\n").filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---")).length;
	const scope = [`worktree: ${repo}`, `base: ${base} (merge-base ${mergeBase})`, `head: ${head}`, `diff: git diff ${base}...HEAD — ${changed} changed lines`].join("\n");
	return { diff: diff.trimEnd(), scope };
}

const section = (label: string, body: string): string => `--- ${label} ---\n\n${body.trimEnd()}`;

/** The leg's output instruction (prompts/<mode>.leg.md) with its access paragraph, then the leg schema inline. */
function legInstruction(mode: Mode, schema: string, access = ""): string {
	return `${kitText(`prompts/${mode}.leg.md`).replace("{{access}}", access).trimEnd()}\n\n\`\`\`json\n${schema.trimEnd()}\n\`\`\``;
}

/** synth.md: the mode's synthesis prompt with its base rules expanded, the common rules, then the material. */
function synthPrompt(mode: Mode, material: string[]): string {
	return [
		expandBase(kitText(`prompts/${mode}.synth.md`)).trimEnd(),
		kitText("prompts/synth-common.md").trimEnd(),
		`## Material\n\n${material.join("\n\n")}`,
	].join("\n\n") + "\n";
}

const sameForAll = (files: string[]): Record<Lab, string[]> => ({ anthropic: [...files], openai: [...files], kimi: [...files] });

const PACKET_ONLY = "This leg is packet-only: everything you may read is in this packet. Do not run shell commands, evaluate code, browse, or search the web, and read no file: a tool call of any of those kinds is a breach and excludes this leg's output.";
const liveRepo = (repo: string): string =>
	`This run has no grounding pack: every leg alike has live read access to the worktree at \`${repo}\` instead (quorum's \`--repo-context all\`). Its files stand where the prompt's ground rule 1 puts the pack: use what you read there verbatim, and cite the paths.`;

function stageTriad(o: PrepOptions, cwd: string, schema: string): Staged {
	const repo = worktree(o.args.repo, cwd);
	const base = checkRef(o.args.base!);
	const ticket = readInput(o.args.ticket!, "--ticket", cwd);
	const { diff, scope } = branchDiff(repo, base);
	const packet = [
		section("LENS 1: architecture (references/triad/prompts/architecture.md)", basePrompt("triad/prompts/architecture.md")),
		section("LENS 2: correctness (references/triad/prompts/correctness.md)", basePrompt("triad/prompts/correctness.md")),
		section("LENS 3: cold read (references/triad/prompts/cold-read.md)", basePrompt("triad/prompts/cold-read.md")),
		section("SCOPE", scope),
		section("TICKET", ticket.text),
		section("DIFF", diff),
		legInstruction("triad", schema),
	].join("\n\n") + "\n";
	const synth = synthPrompt("triad", [section("SCOPE", scope), section(`TICKET (manually supplied: ${ticket.abs})`, ticket.text), section("DIFF", diff)]);
	return { files: new Map([["packet.md", packet], [SYNTH_PROMPT, synth]]), repoAccess: true, repo, legInputs: sameForAll(["packet.md"]), synthInputs: [], withheld: [], canary: null };
}

/** The finding under test, as triad's refute.md asks: title, severity, where, what — never which legs raised it. */
function findingText(path: string, cwd: string): string {
	const { abs, text } = readInput(path, "--finding", cwd);
	let f: unknown;
	try {
		f = JSON.parse(text);
	} catch (e) {
		throw new PanelError(`--finding ${abs} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (typeof f !== "object" || f === null || Array.isArray(f)) throw new PanelError(`--finding ${abs} is not a JSON object`);
	const rec = f as Record<string, unknown>;
	const lines: string[] = [];
	for (const k of ["title", "severity", "where", "what"]) {
		const v = rec[k];
		if (v === undefined && k === "severity") continue;
		if (typeof v !== "string" || v.trim() === "") throw new PanelError(`--finding ${abs}: "${k}" must be a non-empty string`);
		lines.push(`- ${k}: ${v.trim()}`);
	}
	return lines.join("\n");
}

function stageTriadVerify(o: PrepOptions, cwd: string, schema: string): Staged {
	const repo = worktree(o.args.repo, cwd);
	const base = checkRef(o.args.base!);
	const finding = findingText(o.args.finding!, cwd);
	const { diff, scope } = branchDiff(repo, base);
	const packet = [
		basePrompt("triad/prompts/refute.md"),
		section("THE FINDING", finding),
		section("SCOPE", scope),
		section("DIFF", diff),
		legInstruction("triad-verify", schema),
	].join("\n\n") + "\n";
	const synth = synthPrompt("triad-verify", [section("THE FINDING", finding), section("SCOPE", scope)]);
	return { files: new Map([["packet.md", packet], [SYNTH_PROMPT, synth]]), repoAccess: true, repo, legInputs: sameForAll(["packet.md"]), synthInputs: [], withheld: [], canary: null };
}

const CONTEXT_LABEL = "CONTEXT (grounding pack — the only codebase facts available; do not invent paths beyond it)";

function stageQuorum(o: PrepOptions, cwd: string, schema: string): Staged {
	const repoContext = o.args["repo-context"];
	if (repoContext !== undefined && repoContext !== "all") throw new UsageError(`--repo-context takes only "all" (quorum.md: there is deliberately no per-leg variant)`);
	if (repoContext && o.args.context !== undefined) throw new UsageError("--context and --repo-context all are exclusive: a shared pack, or live repo access for every leg");
	if (o.args.repo !== undefined && !repoContext) throw new UsageError("--repo is only meaningful with --repo-context all");
	const brief = readInput(o.args.brief!, "--brief", cwd);
	const context = o.args.context !== undefined ? readInput(o.args.context, "--context", cwd) : null;
	const repo = repoContext ? worktree(o.args.repo, cwd) : null;
	const files = new Map<string, string>();
	files.set("brief.md", brief.text);
	if (context) files.set("context.md", context.text);
	const payload = [section("BRIEF", brief.text), ...(context ? [section(CONTEXT_LABEL, context.text)] : [])];
	files.set("packet.md", [basePrompt("quorum/prompts/plan.md"), ...payload, legInstruction("quorum", schema, repo ? liveRepo(repo) : PACKET_ONLY)].join("\n\n") + "\n");
	let canary: string | null = null;
	const withheld: string[] = [];
	if (o.args.draft !== undefined) {
		const draft = readInput(o.args.draft, "--draft", cwd);
		canary = `panel-canary-${randomBytes(16).toString("hex")}`;
		files.set("withheld/draft.md", `${draft.text.trimEnd()}\n\n<!-- ${canary} -->\n`);
		withheld.push("withheld/draft.md");
	}
	const grounding = context ? "shared pack (context.md)" : repo ? `live repo, all legs: ${repo}` : "ungrounded (no pack, no repo)";
	const draftLine = canary ? "A draft plan was withheld from every leg: read it at `in/withheld/draft.md` for the vs-draft section." : "No draft was withheld: there is no vs-draft section.";
	files.set(SYNTH_PROMPT, synthPrompt("quorum", [`grounding: ${grounding}\n\n${draftLine}`, ...payload]));
	return { files, repoAccess: repo !== null, repo, legInputs: sameForAll(["packet.md"]), synthInputs: [...withheld], withheld, canary };
}

interface PlanItem {
	kind?: unknown;
	title?: unknown;
	what?: unknown;
	where?: unknown;
	depends_on?: unknown;
	mitigation?: unknown;
}

/** A landed quorum leg's plan back in plan.schema.json's shape, with no panel ids, so a reader cannot tell whose it is. */
export function renderPlan(leg: { summary?: unknown; items?: unknown }): string {
	const items = Array.isArray(leg.items) ? (leg.items as PlanItem[]) : [];
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	const of = (k: string) => items.filter((i) => i.kind === k);
	const plan = {
		summary: str(leg.summary),
		steps: of("step").map((i) => ({ title: str(i.title), what: str(i.what), where: str(i.where), depends_on: Array.isArray(i.depends_on) ? i.depends_on.filter((d) => typeof d === "string") : [] })),
		risks: of("risk").map((i) => ({ risk: str(i.title), mitigation: str(i.mitigation) })),
		assumptions: of("assumption").map((i) => str(i.title)),
		open_questions: of("open_question").map((i) => (str(i.where) ? `${str(i.title)} (${str(i.where)})` : str(i.title))),
	};
	return JSON.stringify(plan, null, 2);
}

function stageQuorumRefute(o: PrepOptions, cwd: string, schema: string, env: Env): Staged {
	const loaded = loadPanel(resolve(cwd, o.args.from!), env, { requireReport: false });
	if (loaded.failures.length > 0 || !loaded.panel) {
		throw new PanelError(`--from ${o.args.from} cannot be trusted:\n  ${loaded.failures.join("\n  ")}`);
	}
	const p = loaded.panel;
	if (p.manifest.mode !== "quorum") throw new PanelError(`--from ${p.pdir} is a ${p.manifest.mode} panel, not quorum`);
	if (p.manifest.workload !== o.workload) throw new PanelError(`--from ${p.pdir} belongs to ${p.manifest.workload}, not ${o.workload}`);
	const landed = LABS.filter((l) => p.status.legs[l]?.status === "landed");
	if (landed.length < 2) throw new PanelError(`--from ${p.pdir}: cross-refutation needs at least two landed plans; ${landed.length} landed`);
	const brief = readFileSync(join(p.pdir, "in", "brief.md"), "utf8");
	const contextPath = join(p.pdir, "in", "context.md");
	const context = existsSync(contextPath) ? readFileSync(contextPath, "utf8") : null;
	const plans = new Map(landed.map((l) => [l, renderPlan(JSON.parse(readFileSync(join(p.pdir, "out", "legs", `${l}.json`), "utf8")))]));
	const repo = p.manifest.repoAccess ? p.manifest.repo : null;
	const access = repo ? liveRepo(repo) : PACKET_ONLY;
	// quorum-fanout.sh's refute payload: brief, the pack when one ran, then the other plans as PLAN 1 / PLAN 2.
	const payload = [section("BRIEF", brief), ...(context ? [section("CONTEXT (grounding pack)", context)] : [])];
	const files = new Map<string, string>();
	const legInputs = {} as Record<Lab, string[]>;
	const mapping: string[] = [];
	for (const lab of LABS) {
		const others = landed.filter((l) => l !== lab);
		const packet = [
			basePrompt("quorum/prompts/refute-plan.md"),
			...payload,
			...others.map((other, i) => section(`PLAN ${i + 1}`, plans.get(other)!)),
			legInstruction("quorum-refute", schema, access),
		].join("\n\n") + "\n";
		files.set(`legs/${lab}/packet.md`, packet);
		legInputs[lab] = [`legs/${lab}/packet.md`];
		mapping.push(`- ${lab}'s packet: ${others.map((other, i) => `PLAN ${i + 1} (plan-${i + 1}) = ${other}'s plan`).join(", ")}`);
	}
	files.set(SYNTH_PROMPT, synthPrompt("quorum-refute", [
		`source quorum panel: ${p.pg} (${p.pdir})`,
		`Which plan each leg attacked:\n\n${mapping.join("\n")}`,
		...landed.map((l) => section(`${l}'s plan`, plans.get(l)!)),
		...payload,
	]));
	return { files, repoAccess: repo !== null, repo, legInputs, synthInputs: [], withheld: [], canary: null };
}

function stageRefute(o: PrepOptions, cwd: string, schema: string): Staged {
	const plan = readInput(o.args.plan!, "--plan", cwd);
	const packet = [basePrompt("quorum/prompts/refute-plan.md"), section("PLAN 1", plan.text), legInstruction("refute", schema)].join("\n\n") + "\n";
	const synth = synthPrompt("refute", [section(`PLAN 1 (${plan.abs})`, plan.text)]);
	return { files: new Map([["packet.md", packet], [SYNTH_PROMPT, synth]]), repoAccess: false, repo: null, legInputs: sameForAll(["packet.md"]), synthInputs: [], withheld: [], canary: null };
}

function stageDoubt(o: PrepOptions, cwd: string, schema: string): Staged {
	const artifact = readInput(o.args.artifact!, "--artifact", cwd);
	const contract = readInput(o.args.contract!, "--contract", cwd);
	// Step 3: "Pass ARTIFACT + CONTRACT only" — pasted where the prompt's placeholders stand, nothing else changed.
	const prompt = doubtAdversarialPrompt()
		.replace("ARTIFACT: <paste artifact>", () => `ARTIFACT: \n${artifact.text.trimEnd()}\n`)
		.replace("CONTRACT: <paste contract>", () => `CONTRACT: \n${contract.text.trimEnd()}`);
	const packet = [prompt, legInstruction("doubt", schema)].join("\n\n") + "\n";
	const synth = synthPrompt("doubt", [section(`ARTIFACT (${artifact.abs})`, artifact.text), section(`CONTRACT (${contract.abs})`, contract.text)]);
	return { files: new Map([["packet.md", packet], [SYNTH_PROMPT, synth]]), repoAccess: false, repo: null, legInputs: sameForAll(["packet.md"]), synthInputs: [], withheld: [], canary: null };
}

const WORKLOAD_ID = /^wl-[A-Za-z0-9]+$/;
const SLICE_ID = /^sl-[A-Za-z0-9-]+$/;

/** Stage a panel run: refuse, or create <run> with its inputs and manifest.json. */
export function prep(o: PrepOptions, env: Env = process.env): PrepResult {
	const cwd = o.cwd ?? process.cwd();
	if (!MODES.includes(o.mode)) throw new UsageError(`unknown mode ${o.mode}; one of ${MODES.join(", ")}`);
	if (!WORKLOAD_ID.test(o.workload)) throw new UsageError(`--workload ${JSON.stringify(o.workload)} is not a workload id (wl-…)`);
	if (!SLICE_ID.test(o.slice)) throw new UsageError(`--slice ${JSON.stringify(o.slice)} is not a slice id (sl-…)`);
	const spec = MODE_ARGS[o.mode];
	for (const k of Object.keys(o.args)) if (!spec.required.includes(k) && !spec.optional.includes(k)) throw new UsageError(`--${k} is not an argument of ${o.mode}`);
	for (const k of spec.required) if (o.args[k] === undefined) throw new UsageError(`${o.mode} needs --${k}`);
	const legTimeoutMin = { default: DEFAULT_LEG_TIMEOUT_MIN, ...o.legTimeoutMin };
	const target = stagingTarget(o.run, env, cwd);
	const schema = kitText(`schema/${o.mode}.leg.schema.json`);
	const staged =
		o.mode === "triad" ? stageTriad(o, cwd, schema)
		: o.mode === "triad-verify" ? stageTriadVerify(o, cwd, schema)
		: o.mode === "quorum" ? stageQuorum(o, cwd, schema)
		: o.mode === "quorum-refute" ? stageQuorumRefute(o, cwd, schema, env)
		: o.mode === "refute" ? stageRefute(o, cwd, schema)
		: stageDoubt(o, cwd, schema);
	staged.files.set(LEG_SCHEMA, schema);
	staged.files.set(SYNTH_SCHEMA, kitText("schema/synth.schema.json"));
	const inputs: Record<string, string> = {};
	for (const rel of [...staged.files.keys()].sort()) inputs[rel] = sha256(staged.files.get(rel)!);
	const manifest: Manifest = {
		version: 1,
		mode: o.mode,
		workload: o.workload,
		slice: o.slice,
		createdAt: (o.now ?? (() => new Date().toISOString()))(),
		repoAccess: staged.repoAccess,
		repo: staged.repo,
		legSchema: LEG_SCHEMA,
		synthPrompt: SYNTH_PROMPT,
		synthSchema: SYNTH_SCHEMA,
		legTimeoutMin,
		inputs,
		legInputs: staged.legInputs,
		synthInputs: staged.synthInputs,
		withheld: staged.withheld,
		canary: staged.canary,
	};
	writeRun(target, staged.files, manifest);
	return { run: target, manifest };
}

/** Create <run> exclusively and write every file with an exclusive create; on any failure remove what this call created. */
function writeRun(target: string, files: Map<string, string>, manifest: Manifest): void {
	mkdirSync(dirname(target), { recursive: true });
	mkdirSync(target); // not recursive: fails when something appeared at <run> since the check
	try {
		if (realpathSync(target) !== target) throw new PanelError(`run dir ${target} resolved elsewhere after it was created`);
		for (const [rel, text] of files) {
			const path = join(target, rel);
			let dir = target;
			for (const part of relative(target, dirname(path)).split(sep).filter(Boolean)) {
				dir = join(dir, part);
				if (!exists(dir)) mkdirSync(dir);
			}
			writeFileSync(path, text, { flag: "wx" });
		}
		writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	} catch (e) {
		rmSync(target, { recursive: true, force: true });
		throw e;
	}
}

// ---- ledger entries (CONTRACT § 3) ---------------------------------------------------------------

export interface GroupEntry {
	pg: string;
	run: string;
	pdir: string;
	slice: string;
	mode: string;
	inputs: Record<string, string>;
	members: Record<string, string | null>;
}

interface PanelLines {
	groups: GroupEntry[];
	legs: Map<string, { lab: string; status: string; rest: string }[]>;
	published: Map<string, { out: Record<string, string>[]; report: Record<string, string>[] }>;
	voids: Map<string, string[]>;
}

const PG = "pg-[A-Za-z0-9-]+";

/** The panel lines among a workload's `assumption` entries, parsed; a malformed line is a failure, never skipped silently. */
function panelLines(bodies: string[], failures: string[]): PanelLines {
	const out: PanelLines = { groups: [], legs: new Map(), published: new Map(), voids: new Map() };
	const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
	for (const body of bodies) {
		let m: RegExpMatchArray | null;
		if (body.startsWith("panel-group: ")) {
			m = body.match(new RegExp(`^panel-group: (${PG}) (\\{.*\\})$`));
			try {
				const j = m ? JSON.parse(m[2]!) : null;
				if (!j || typeof j.run !== "string" || typeof j.pdir !== "string" || typeof j.inputs !== "object" || j.inputs === null) throw new Error("fields");
				out.groups.push({ pg: m![1]!, run: j.run, pdir: j.pdir, slice: String(j.slice), mode: String(j.mode), inputs: j.inputs, members: j.members ?? {} });
			} catch {
				failures.push(`ledger: malformed panel-group entry: ${body.slice(0, 120)}`);
			}
		} else if ((m = body.match(new RegExp(`^panel-leg: (${PG}) (\\S+) (landed|missing|excluded)(?: (.*))?$`)))) {
			// CONTRACT § 3: a landed leg names its result file's hash and how that file is bound (classifier PANEL_LEG);
			// a landed line without them is reported for its own group only.
			const malformed = m[3] === "landed" && !/^sha256 [0-9a-f]{64} bound (session|delivered|file)$/.test(m[4] ?? "");
			push(out.legs, m[1]!, { lab: m[2]!, status: malformed ? "malformed" : m[3]!, rest: malformed ? body : (m[4] ?? "") });
		} else if ((m = body.match(new RegExp(`^panel-published: (${PG}) (out|report) (\\{.*\\})$`)))) {
			const pg = m[1]!;
			try {
				const j = JSON.parse(m[3]!);
				const cur = out.published.get(pg) ?? { out: [], report: [] };
				cur[m[2] as "out" | "report"].push(j);
				out.published.set(pg, cur);
			} catch {
				failures.push(`ledger: malformed panel-published entry: ${body.slice(0, 120)}`);
			}
		} else if ((m = body.match(new RegExp(`^panel-run: (${PG}) void(?: (.*))?$`)))) {
			push(out.voids, m[1]!, m[2] ?? "");
		}
	}
	return out;
}

// ---- loading a panel directory -------------------------------------------------------------------

interface LegStatus {
	status: string;
	reason: string | null;
	model: string | null;
	token: string | null;
	findingIds: string[];
}

export interface LoadedPanel {
	pg: string;
	pdir: string;
	group: GroupEntry;
	manifest: Manifest;
	status: { group: string; legs: Record<string, LegStatus> };
	legOutputs: Map<Lab, { raw: string; items: Record<string, unknown>[] }>;
	report: { raw: string; markdown: string; json: Record<string, unknown> } | null;
}

function readJson(path: string, what: string, failures: string[]): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		failures.push(`${what} is unreadable or not JSON: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
}

/** Every regular file under `dir`, relative to it; a symlink or other non-regular entry is a failure. */
function walk(dir: string, failures: string[], base = dir): string[] {
	if (!exists(dir)) return [];
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, failures, base));
		else if (e.isFile()) out.push(relative(base, p).split(sep).join("/"));
		else failures.push(`${relative(base, p)} under ${base} is not a regular file`);
	}
	return out.sort();
}

/** Re-hash `<root>/<rel>` against `expect` (lstat first: a symlink never passes). */
function hashMatches(root: string, rel: string, expect: string, label: string, failures: string[]): string | null {
	const path = join(root, rel);
	try {
		if (!lstatSync(path).isFile()) {
			failures.push(`hash: ${label}${rel} is not a regular file`);
			return null;
		}
	} catch {
		failures.push(`hash: ${label}${rel} is missing (the ledger records ${expect.slice(0, 12)}…)`);
		return null;
	}
	const bytes = readFileSync(path);
	const got = sha256(bytes);
	if (got !== expect) {
		failures.push(`hash: ${label}${rel} is ${got.slice(0, 12)}…, the ledger records ${expect.slice(0, 12)}…`);
		return null;
	}
	return bytes.toString("utf8");
}

/**
 * Resolve a staging run or a panel directory to its panel through the ledger (read-only) and verify every
 * byte against the ledger's hashes. With `requireReport` the synthesis report must be published too.
 */
export function loadPanel(target: string, env: Env, opts: { requireReport: boolean }): { failures: string[]; panel: LoadedPanel | null } {
	const failures: string[] = [];
	let abs: string;
	try {
		abs = realpathSync(target);
	} catch {
		return { failures: [`${target} does not exist`], panel: null };
	}
	const isPdir = exists(join(abs, "in", "manifest.json"));
	const firstManifest = readJson(join(abs, isPdir ? "in/manifest.json" : "manifest.json"), `${abs}/${isPdir ? "in/manifest.json" : "manifest.json"}`, failures) as Manifest | null;
	if (!firstManifest) return { failures, panel: null };
	if (typeof firstManifest.workload !== "string") return { failures: [`${abs}: manifest has no workload`], panel: null };

	let ledger: Ledger;
	const ledgerPath = defaultLedgerPath(env);
	try {
		ledger = Ledger.open(ledgerPath, { readonly: true });
	} catch (e) {
		return { failures: [`ledger ${ledgerPath}: ${e instanceof Error ? e.message : String(e)}`], panel: null };
	}
	let lines: PanelLines;
	let ledgerDir: string;
	try {
		ledgerDir = dirname(ledger.path);
		lines = panelLines(ledger.entries(firstManifest.workload, "assumption").map((e) => e.body), failures);
	} finally {
		ledger.close();
	}
	const real = (p: string) => {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	};
	const matches = lines.groups.filter((g) => (isPdir ? real(g.pdir) === abs : g.run === abs || real(g.run) === abs));
	if (matches.length !== 1) {
		failures.push(matches.length === 0
			? `ledger: no panel-group entry on ${firstManifest.workload} names ${isPdir ? "pdir" : "run"} ${abs}`
			: `ledger: ${matches.length} panel-group entries name ${abs}; one group per run`);
		return { failures, panel: null };
	}
	const group = matches[0]!;
	const pg = group.pg;
	const pdir = real(group.pdir);
	const expected = real(join(ledgerDir, "lanes", firstManifest.workload, "panels", pg));
	if (pdir !== expected) failures.push(`ledger: ${pg}'s pdir ${pdir} is not the panel directory ${expected}`);
	for (const reason of lines.voids.get(pg) ?? []) failures.push(`run void: panel-run: ${pg} void ${reason}`);

	// in/: every recorded input re-hashed, nothing unrecorded, the manifest itself among them.
	const inDir = join(pdir, "in");
	if (!Object.hasOwn(group.inputs, "manifest.json")) failures.push(`ledger: ${pg}'s panel-group entry records no hash for in/manifest.json`);
	for (const [rel, sha] of Object.entries(group.inputs)) hashMatches(inDir, rel, sha, "in/", failures);
	for (const rel of walk(inDir, failures)) if (!Object.hasOwn(group.inputs, rel)) failures.push(`hash: in/${rel} has no hash in ${pg}'s panel-group entry`);
	const manifest = readJson(join(inDir, "manifest.json"), "in/manifest.json", failures) as Manifest | null;
	if (!manifest) return { failures, panel: null };
	for (const [rel, sha] of Object.entries(manifest.inputs ?? {})) {
		if (group.inputs[rel] !== sha) failures.push(`hash: in/manifest.json lists ${rel} as ${String(sha).slice(0, 12)}…, the ledger records ${String(group.inputs[rel] ?? "nothing").slice(0, 12)}…`);
	}
	for (const rel of Object.keys(group.inputs)) if (rel !== "manifest.json" && !Object.hasOwn(manifest.inputs ?? {}, rel)) failures.push(`hash: in/${rel} is recorded in the ledger but not in in/manifest.json`);
	if (manifest.slice !== group.slice) failures.push(`ledger: ${pg} is on slice ${group.slice}, in/manifest.json says ${manifest.slice}`);
	if (!MODES.includes(manifest.mode)) failures.push(`in/manifest.json: unknown mode ${manifest.mode}`);

	// panel-leg lines: one per lab.
	const legLines = new Map<string, { status: string; rest: string }>();
	for (const l of lines.legs.get(pg) ?? []) {
		if (l.status === "malformed") failures.push(`ledger: malformed panel-leg entry: ${l.rest.slice(0, 120)}`);
		else if (!LABS.includes(l.lab as Lab)) failures.push(`ledger: panel-leg line for unknown lab ${l.lab}`);
		else if (legLines.has(l.lab)) failures.push(`ledger: more than one panel-leg line for ${l.lab}`);
		else legLines.set(l.lab, l);
	}
	for (const lab of LABS) if (!legLines.has(lab)) failures.push(`ledger: no panel-leg line for ${lab}; the group is not terminal`);

	// out/: published hashes.
	const pub = lines.published.get(pg);
	const outDir = join(pdir, "out");
	const covered = new Set<string>();
	const verifyPublished = (kind: "out" | "report"): Map<string, string> => {
		const texts = new Map<string, string>();
		const maps = pub?.[kind] ?? [];
		if (maps.length !== 1) {
			failures.push(maps.length === 0 ? `ledger: no panel-published: ${pg} ${kind} entry` : `ledger: ${maps.length} panel-published: ${pg} ${kind} entries`);
			if (maps.length === 0) return texts;
		}
		for (const [rel, sha] of Object.entries(maps[0]!)) {
			covered.add(rel);
			if (!rel.startsWith("out/")) {
				failures.push(`ledger: panel-published ${kind} names ${rel}, outside out/`);
				continue;
			}
			const text = hashMatches(pdir, rel, String(sha), "", failures);
			if (text !== null) texts.set(rel, text);
		}
		return texts;
	};
	const outTexts = verifyPublished("out");
	const reportTexts = opts.requireReport ? verifyPublished("report") : new Map<string, string>();
	if (!opts.requireReport) for (const rel of Object.keys(pub?.report?.[0] ?? {})) covered.add(rel);
	// The classifier publishes through `.<name>.<uuid>.tmp` siblings (renamed into place); one left behind is not an output.
	for (const rel of walk(outDir, failures)) if (!covered.has(`out/${rel}`) && !/(^|\/)\.[^/]*\.tmp$/.test(rel)) failures.push(`hash: out/${rel} has no hash in any panel-published entry`);

	// status.json against the ledger's leg lines.
	const statusRaw = outTexts.get("out/status.json");
	if (statusRaw === undefined) {
		if (pub?.out?.length === 1) failures.push("out/status.json is not among the published out files");
		return { failures, panel: null };
	}
	let status: LoadedPanel["status"];
	try {
		status = JSON.parse(statusRaw);
	} catch {
		failures.push("out/status.json is not JSON");
		return { failures, panel: null };
	}
	if (status.group !== pg) failures.push(`out/status.json names group ${status.group}, not ${pg}`);
	const legOutputs = new Map<Lab, { raw: string; items: Record<string, unknown>[] }>();
	for (const lab of LABS) {
		const s = status.legs?.[lab];
		if (!s) {
			failures.push(`out/status.json has no entry for ${lab}`);
			continue;
		}
		const line = legLines.get(lab);
		if (line && line.status !== s.status) failures.push(`out/status.json says ${lab} ${s.status}, the ledger's panel-leg line says ${line.status}`);
		const rel = `out/legs/${lab}.json`;
		if (s.status !== "landed") {
			if (exists(join(pdir, rel))) failures.push(`${rel} exists for a ${s.status} leg`);
			continue;
		}
		const raw = outTexts.get(rel);
		if (raw === undefined) {
			if (!Object.hasOwn(pub?.out?.[0] ?? {}, rel)) failures.push(`${rel} (a landed leg) is not among the published out files`);
			continue;
		}
		let items: Record<string, unknown>[] = [];
		try {
			const j = JSON.parse(raw);
			if (!Array.isArray(j.items)) throw new Error("no top-level items array");
			items = j.items;
		} catch (e) {
			failures.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		const ids = items.map((i) => i.id);
		const want = items.map((_i, n) => `${lab}-${n + 1}`);
		if (JSON.stringify(ids) !== JSON.stringify(want)) failures.push(`${rel}: item ids ${JSON.stringify(ids)} are not ${lab}-1…${lab}-${items.length} by position`);
		if (JSON.stringify(s.findingIds ?? []) !== JSON.stringify(want)) failures.push(`out/status.json findingIds for ${lab} ${JSON.stringify(s.findingIds)} do not match ${rel}'s items`);
		legOutputs.set(lab, { raw, items });
	}

	let report: LoadedPanel["report"] = null;
	if (opts.requireReport) {
		const raw = reportTexts.get("out/report.json");
		const md = reportTexts.get("out/REPORT.md");
		if (raw !== undefined && md !== undefined) {
			try {
				const json = JSON.parse(raw);
				if (json.markdown !== md) failures.push("out/REPORT.md is not equal to out/report.json's markdown");
				report = { raw, markdown: md, json };
			} catch {
				failures.push("out/report.json is not JSON");
			}
		} else if ((pub?.report?.length ?? 0) === 1) {
			failures.push("out/report.json and out/REPORT.md must both be published and match their hashes");
		}
	}
	return { failures, panel: { pg, pdir, group, manifest, status, legOutputs, report } };
}

// ---- check -------------------------------------------------------------------------------------

const LABEL = /^(?:[-*]\s+)?\*\*(?:CLAIM|CITE|GUESS(?:\((?:inference|pattern|recall)\))?|ACTION|PMDW|QUESTION)\*\*/;
const HEADING = /^#{1,6}\s/;
const labOf = (id: string): string => id.slice(0, id.lastIndexOf("-"));
const norm = (s: string): string => s.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** The heading (`##`/`###`) or list-item line opening each finding: the first such line whose first S<n> token is its id. */
function findingLine(lines: string[], id: string): number {
	return lines.findIndex((l) => /^(#{2,6}\s|\s*[-*]\s)/.test(l) && l.match(/\bS\d+\b/)?.[0] === id);
}

const DISAGREEMENT: Record<Mode, RegExp> = {
	triad: /^disagreements/,
	"triad-verify": /^disagreements/,
	quorum: /^divergent/,
	"quorum-refute": /^disagreements/,
	refute: /^disagreements/,
	doubt: /^disagreements/,
};

/** Section headings each mode's report must carry (PLAN § 3.5), by normalized prefix. */
function requiredSections(mode: Mode, manifest: Manifest, markdown: string): { name: string; re: RegExp }[] {
	switch (mode) {
		case "triad":
			return [
				{ name: "Disagreements", re: /^disagreements/ },
				{ name: "FYI", re: /^fyi/ },
				// triad.md "Output format": the Refuted section exists exactly when the verify stage ran.
				...(/^\*\*Verify:\*\*/m.test(markdown) ? [{ name: "Refuted", re: /^refuted/ }] : []),
			];
		case "quorum":
			return [
				{ name: "Converged", re: /^converged/ },
				{ name: "Divergent", re: /^divergent/ },
				{ name: "Unique", re: /^unique/ },
				...(manifest.withheld.length > 0 ? [{ name: "Vs. the withheld draft", re: /^vs\.? (the )?withheld draft/ }] : []),
			];
		case "doubt":
			return [
				{ name: "Contract misread", re: /^contract misread/ },
				{ name: "Valid + actionable", re: /^valid \+ actionable/ },
				{ name: "Valid trade-off", re: /^valid trade-?off/ },
				{ name: "Noise", re: /^noise/ },
			];
		default:
			return [];
	}
}

/** Every statement block of the report opens with a bold output-types label (contract/output-types.md § Marking). */
function unlabeledBlocks(markdown: string): string[] {
	const bad: string[] = [];
	let block: string[] = [];
	let fence: string | null = null;
	const close = () => {
		const first = block[0];
		if (first !== undefined) {
			if (first.trimStart().startsWith("|")) {
				const cell = first.split("|").map((c) => c.trim()).filter((c) => c !== "")[0];
				if (cell !== "Type") bad.push(first);
			} else if (!LABEL.test(first.trimStart())) bad.push(first);
		}
		block = [];
	};
	for (const line of markdown.split("\n")) {
		const f = line.trimStart().match(/^(```|~~~)/);
		if (fence) {
			if (f && f[1] === fence) fence = null;
			continue;
		}
		if (f) {
			close();
			fence = f[1]!;
			continue;
		}
		if (line.trim() === "" || HEADING.test(line)) {
			close();
			continue;
		}
		block.push(line);
	}
	close();
	return bad;
}

/** The opener of the informational flag block P-11 row 3 appends to a hand's reply strings (gates/src/rows/r03-receipts.ts renderFlags). */
const RECEIPT_FLAGS = "\n\n---\nP-11 row 3 receipt check (informational";

/** The report without row 3's trailing flag block: the block stays in the published REPORT.md as the gate wrote it, but it is machinery output, not a statement of the synthesis. */
function withoutReceiptFlags(markdown: string): string {
	const at = markdown.lastIndexOf(RECEIPT_FLAGS);
	return at >= 0 && !markdown.slice(at + RECEIPT_FLAGS.length).includes("\n\n") ? markdown.slice(0, at) : markdown;
}

/** Check a published panel: every rule of PLAN § 3.5 plus the ledger hashes. Never writes. */
export function check(target: string, env: Env = process.env): { pg: string | null; failures: string[] } {
	const { failures, panel } = loadPanel(target, env, { requireReport: true });
	if (!panel) return { pg: null, failures };
	const { pg, manifest, status, legOutputs, report } = panel;
	const mode = manifest.mode;

	// The canary: a withheld draft carries it, and no leg output may.
	if (manifest.withheld?.length > 0 && !manifest.canary) failures.push("canary: in/manifest.json withholds a draft but sets no canary");
	if (manifest.canary) {
		for (const rel of manifest.withheld ?? []) {
			if (!readFileSync(join(panel.pdir, "in", rel), "utf8").includes(manifest.canary)) failures.push(`canary: in/${rel} does not carry the manifest's canary`);
		}
		for (const [lab, leg] of legOutputs) if (leg.raw.includes(manifest.canary)) failures.push(`canary: out/legs/${lab}.json carries the withheld draft's canary; that leg saw the draft`);
	}
	if (!report) {
		if (failures.length === 0) failures.push("report: out/report.json is not published");
		return { pg, failures };
	}
	const r = report.json as { legs?: unknown; synth?: unknown; findings?: unknown; dropped?: unknown };
	const md = withoutReceiptFlags(report.markdown);
	const lines = md.split("\n");

	// Legs: report.json and REPORT.md's legs line against status.json.
	const legs = Array.isArray(r.legs) ? (r.legs as { lab?: string; status?: string; model?: string | null }[]) : [];
	const legsLine = lines.find((l) => l.startsWith("**Legs:**"));
	if (!legsLine) failures.push("legs: REPORT.md has no **Legs:** line");
	const segments = legsLine ? legsLine.slice("**Legs:**".length).split("|") : [];
	for (const lab of LABS) {
		const s = status.legs?.[lab];
		if (!s) continue;
		const model = s.model ?? "";
		const entries = legs.filter((l) => l.lab === lab);
		if (entries.length !== 1) failures.push(`legs: report.json lists ${lab} ${entries.length} times`);
		else if (entries[0]!.status !== s.status || (entries[0]!.model ?? "") !== model) {
			failures.push(`legs: report.json says ${lab} ${entries[0]!.status} ${entries[0]!.model ?? ""}, status.json says ${s.status} ${model}`);
		}
		if (!legsLine) continue;
		const seg = segments.filter((g) => new RegExp(`\\b${lab}\\b`).test(g));
		if (seg.length !== 1) failures.push(`legs: the **Legs:** line names ${lab} ${seg.length} times`);
		else {
			if (!new RegExp(`\\b${s.status}\\b`).test(seg[0]!)) failures.push(`legs: the **Legs:** line does not give ${lab}'s status ${s.status}`);
			if (model !== "" && !seg[0]!.includes(model)) failures.push(`legs: the **Legs:** line does not give ${lab}'s model ${model}`);
		}
	}
	const synth = r.synth as { lab?: string } | undefined;
	if (!synth || !LABS.includes(synth.lab as Lab)) failures.push("report: synth.lab is not a lab");

	// Accounting: every landed id exactly once, in a finding or dropped with a reason.
	const landed = new Set<string>();
	for (const [, leg] of legOutputs) for (const i of leg.items) landed.add(String(i.id));
	const seen = new Map<string, string>();
	const count = (id: string, where: string) => {
		if (!landed.has(id)) failures.push(`accounting: ${where} names ${id}, which is no landed leg item`);
		else if (seen.has(id)) failures.push(`accounting: ${id} is counted in ${seen.get(id)} and again in ${where}`);
		else seen.set(id, where);
	};
	const findings = Array.isArray(r.findings) ? (r.findings as { id?: string; section?: string; supportIds?: string[]; refuteIds?: string[] }[]) : [];
	const fids = new Set<string>();
	for (const f of findings) {
		const id = String(f.id);
		if (!/^S\d+$/.test(id) || fids.has(id)) failures.push(`findings: id ${id} is not a fresh S<n>`);
		fids.add(id);
		for (const x of [...(f.supportIds ?? []), ...(f.refuteIds ?? [])]) count(String(x), id);
	}
	const dropped = Array.isArray(r.dropped) ? (r.dropped as { id?: string; reason?: string }[]) : [];
	for (const d of dropped) {
		count(String(d.id), "dropped");
		if (typeof d.reason !== "string" || d.reason.trim() === "") failures.push(`accounting: ${d.id} is dropped without a reason`);
	}
	for (const id of landed) if (!seen.has(id)) failures.push(`accounting: ${id} is in no finding and not dropped; it was silently lost`);

	// Each finding: its line, its n/3, its section; disagreements where they belong; attackers named.
	const findingLines = new Set<number>();
	for (const f of findings) {
		const at = findingLine(lines, String(f.id));
		if (at >= 0) findingLines.add(at);
	}
	for (const f of findings) {
		const id = String(f.id);
		const at = findingLine(lines, id);
		if (at < 0) {
			failures.push(`findings: ${id} has no heading or list-item line in REPORT.md`);
			continue;
		}
		const line = lines[at]!;
		const support = new Set((f.supportIds ?? []).map((x) => labOf(String(x))));
		const n = line.slice(line.search(new RegExp(`\\b${id}\\b`))).match(/\b([0-3])\/3\b/);
		if (!n) failures.push(`findings: ${id}'s line carries no n/3`);
		else if (Number(n[1]) !== support.size) failures.push(`findings: ${id} says ${n[1]}/3 but its supportIds hold ${support.size} distinct lab(s)`);
		let h = at;
		while (h >= 0 && !/^##\s/.test(lines[h]!)) h--;
		const heading = h >= 0 ? norm(lines[h]!.replace(/^##\s+/, "")) : "";
		if (heading === "") failures.push(`findings: ${id} sits under no ## section`);
		else if (heading !== norm(String(f.section ?? ""))) failures.push(`findings: ${id}'s section is ${JSON.stringify(f.section)} in report.json but it sits under "## ${lines[h]!.replace(/^##\s+/, "")}"`);
		if ((f.supportIds ?? []).length > 0 && (f.refuteIds ?? []).length > 0 && !DISAGREEMENT[mode].test(heading)) {
			failures.push(`disagreements: ${id} has both support and refute ids but sits under "${heading}", not the disagreement section`);
		}
		if (mode === "refute" || mode === "quorum-refute") {
			let end = at + 1;
			while (end < lines.length && !HEADING.test(lines[end]!) && !findingLines.has(end)) end++;
			const block = lines.slice(at, end).join("\n");
			for (const lab of support) if (!new RegExp(`\\b${lab}\\b`).test(block)) failures.push(`sections: ${id} does not name its attacker ${lab}`);
		}
	}

	const headings = lines.filter((l) => /^##\s/.test(l)).map((l) => norm(l.replace(/^##\s+/, "")));
	for (const s of requiredSections(mode, manifest, md)) if (!headings.some((h) => s.re.test(h))) failures.push(`sections: ${mode} report has no "## ${s.name}" section`);
	if (mode === "triad-verify" && !/^\*\*Verify:\*\*/m.test(md)) failures.push("sections: triad-verify report has no **Verify:** line");

	for (const first of unlabeledBlocks(md)) failures.push(`labels: a statement block opens without a bold contract label: ${JSON.stringify(first.slice(0, 80))}`);
	return { pg, failures };
}

// ---- CLI ---------------------------------------------------------------------------------------

const USAGE = `usage:
  panel.ts prep <mode> --run <dir> --workload <wl> --slice <sl> [--leg-timeout-min <lab|default>=<minutes>]... <mode args>
    triad          --base <ref> --ticket <path> [--repo <worktree>]
    triad-verify   --finding <json path> --base <ref> [--repo <worktree>]
    quorum         --brief <path> [--context <path> | --repo-context all] [--draft <path>] [--repo <worktree>]
    quorum-refute  --from <quorum pdir or quorum staging run>
    refute         --plan <path>
    doubt          --artifact <path> --contract <path>
  panel.ts check <staging run or pdir>`;

/** Parse `prep`'s flags: each `--name value` once, `--leg-timeout-min` repeatable. */
export function parsePrepArgs(argv: string[]): PrepOptions {
	const [mode, ...rest] = argv;
	if (!mode || !MODES.includes(mode as Mode)) throw new UsageError(`prep needs a mode: ${MODES.join(", ")}`);
	const args: Record<string, string> = {};
	const legTimeoutMin: Record<string, number> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i]!;
		const value = rest[i + 1];
		if (!flag.startsWith("--") || value === undefined) throw new UsageError(`expected --flag value, got ${JSON.stringify(flag)}`);
		const name = flag.slice(2);
		if (name === "leg-timeout-min") {
			const m = value.match(/^(default|anthropic|openai|kimi)=([1-9][0-9]*)$/);
			if (!m || Number(m[2]) > 1440) throw new UsageError(`--leg-timeout-min takes <lab|default>=<minutes 1-1440>, got ${JSON.stringify(value)}`);
			legTimeoutMin[m[1]!] = Number(m[2]);
			continue;
		}
		if (Object.hasOwn(args, name)) throw new UsageError(`--${name} given twice`);
		args[name] = value;
	}
	const take = (k: string): string => {
		const v = args[k];
		if (v === undefined) throw new UsageError(`prep needs --${k}`);
		delete args[k];
		return v;
	};
	return { mode: mode as Mode, run: take("run"), workload: take("workload"), slice: take("slice"), legTimeoutMin, args };
}

export function main(argv: string[], env: Env = process.env): number {
	const [cmd, ...rest] = argv;
	try {
		if (cmd === "prep") {
			const { run, manifest } = prep(parsePrepArgs(rest), env);
			const packets = Object.keys(manifest.inputs).filter((k) => k.endsWith("packet.md"));
			console.log(`prep: ${manifest.mode} staged at ${run} (${Object.keys(manifest.inputs).length} inputs, ${packets.join(", ")}; repoAccess ${manifest.repoAccess}${manifest.canary ? "; draft withheld with canary" : ""})`);
			console.log(`next: a deep task item on ${manifest.slice} with the line "panel: ${run}"`);
			return 0;
		}
		if (cmd === "check") {
			if (rest.length !== 1) throw new UsageError("check takes one path: a staging run or a panel directory");
			const { pg, failures } = check(rest[0]!, env);
			if (failures.length > 0) {
				for (const f of failures) console.error(`check: FAIL ${f}`);
				console.error(`check: ${failures.length} rule(s) failed${pg ? ` for ${pg}` : ""}`);
				return 1;
			}
			console.log(`check: ok ${pg}`);
			return 0;
		}
		throw new UsageError(cmd ? `unknown command ${cmd}` : "no command");
	} catch (e) {
		if (e instanceof UsageError) {
			console.error(`panel: ${e.message}\n${USAGE}`);
			return 2;
		}
		console.error(`panel: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
