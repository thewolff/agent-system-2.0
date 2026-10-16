/**
 * Three-lab review panels (PLAN wl-mv5m7qvgkxhpj4 § 3; CONTRACT.md §§ 2–4 beside it). A lane runs a
 * cross-model-review mode as a panel: one judge hand per lab (anthropic, openai, kimi), each pinned
 * to its lab, each given the byte-identical task text, packet and output schema; then one synthesis
 * hand writes the report from the landed outputs. classifier/extension.ts dispatches and settles the
 * hands and calls this module at its hooks; everything here is the panel's own logic:
 *
 * - The ledger entry bodies (`panel-group:`, `panel-leg:`, `panel-synth:`, `panel-published:`,
 *   `panel-run:`), their parsers, and `panelGroups`, which folds a workload's entries into each
 *   group's state. Members and the synthesis hand are recorded with the ordinary `hand-spawn: …
 *   review yes group pg-<id>` entry, so row 17, `builderLabs` and recovery count them as reviews;
 *   `countRounds` skips `pg-` groups, and a panel writes no `review-round:`.
 * - Ingest (`ingestRun`): the staging run's manifest and inputs, each opened with `O_NOFOLLOW`,
 *   regular files only, hashed on the read that copies it into the classifier-owned `<pdir>/in/`.
 *   From then on nothing reads the staging run.
 * - Tamper evidence (`verifyFiles`): the ledger, not the directory, is the record. Every input's
 *   sha256 is in the `panel-group:` entry, every published output's in a `panel-published:` entry;
 *   every consumer re-hashes against them and a mismatch voids the run (`panel-run: <pg> void hash
 *   <path>`). In-process `eval` code can still write under `<pdir>`; this detects it, nothing more.
 * - The breach audit (`auditSession`): every tool call in a hand's own session `.jsonl` (the same
 *   file at a live settle and at recovery) against its role's allowlist.
 * - Publication (`finalizeLegs`, `finishSynth`, through `publish`): deterministic from the ledger and
 *   the hands' result files (`<session root>/<agent id>.md`). Every file is first written to a unique
 *   temp name beside its target; then one ledger write transaction re-reads the group, and only when
 *   the publication still stands (not void, not published, the synthesis attempt not ended) renames
 *   the temps into place, `status.json` / `REPORT.md` last, and writes `panel-published:` (with the
 *   attempt's `panel-synth: … landed`). The write lock serializes that step against every other
 *   instance's publication and timeout, so a published file is never replaced. An interrupted
 *   publication is redone; two finalizers write identical bytes.
 * - Output binding (`legLine`): a leg's result file is bound to the reply its own session records
 *   (`recordedReply`, the `yield` OMP serialized into the file) and to what was delivered for it
 *   (`deliveredForm`); its landed line says which bound it (`bound session|delivered|file`).
 * - Timeouts and recovery (`sweepPanels`): no timers; a leg with no `panel-leg:` line `legTimeoutMin`
 *   after its `hand-spawn:` (or the group's entry, if it never spawned) is `missing timeout`, and a
 *   settled synthesis whose publication was cut off is finished from its result file, evaluated at
 *   every settle, at session start and at `panel-synth:` dispatch. A late result is discarded.
 * - Spawn admission (`legHeld`, `synthHeld`), read from the ledger, so it holds across instances.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { EntryRow, InstructionRow, Ledger, RoutingRow, Stakes } from "../../ledger/src/index";
import { type Lab, LABS, labOf, parseHandSpawn, settledTokens, withheldTokens } from "./lab";
import type { RoutingLedger } from "./ledger-port";
import { reviewStopOn } from "./review-stop";
import { effectiveRoundLimit, type InstructionInput } from "./rounds";

/** The ledger the classifier hands this module: the routing port plus the file's path and the slices (the plan slice). */
export type PanelLedger = RoutingLedger & Pick<Ledger, "path" | "slices">;

type Entry = Pick<EntryRow, "kind" | "body" | "created_at"> & { slice_id?: string | null };

export const PANEL_MODES = ["triad", "triad-verify", "quorum", "quorum-refute", "refute", "doubt"] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

/** A panel hand's role (`Hand.panel` in classifier/extension.ts): rebuilt on recovery from `panel-group:` plus its `hand-spawn:`. */
export interface PanelRole {
	group: string;
	pdir: string;
	/** A leg's lab; the synthesis hand's pinned lab. */
	lab: Lab;
	role: "leg" | "synth";
	/** Synthesis only: it runs on a builder lab (no other lab was usable at dispatch). */
	builderLab?: boolean;
}

// ---- the manifest (CONTRACT § 1) ---------------------------------------------------------------

export interface Manifest {
	version: 1;
	mode: PanelMode;
	workload: string;
	slice: string;
	createdAt: string;
	repoAccess: boolean;
	repo: string | null;
	legSchema: string;
	synthPrompt: string;
	synthSchema: string;
	legTimeoutMin: { default: number } & Partial<Record<Lab, number>>;
	inputs: Record<string, string>;
	legInputs: Record<Lab, string[]>;
	synthInputs: string[];
	withheld: string[];
	canary: string | null;
}

const SHA256 = /^[0-9a-f]{64}$/;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every(s => typeof s === "string");

/** A path relative to the run: no absolute path, no `.` / `..` / empty segment, not the manifest itself. */
function relProblem(rel: string): string | null {
	if (rel === "" || isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) return `input path ${JSON.stringify(rel)} is not a relative path`;
	if (rel.split("/").some(part => part === "" || part === "." || part === "..")) return `input path ${JSON.stringify(rel)} has an empty, . or .. segment`;
	if (rel === "manifest.json") return "manifest.json is listed as an input";
	return null;
}

/** The manifest's text parsed and checked against CONTRACT § 1; throws with the reason. */
export function parseManifest(text: string): Manifest {
	let m: unknown;
	try {
		m = JSON.parse(text);
	} catch (error) {
		throw new Error(`manifest.json is not JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	const bad = (why: string): never => {
		throw new Error(`manifest.json ${why}`);
	};
	if (!isObject(m)) return bad("is not an object");
	if (m.version !== 1) bad("version is not 1");
	if (typeof m.mode !== "string" || !(PANEL_MODES as readonly string[]).includes(m.mode)) bad(`mode ${JSON.stringify(m.mode)} is not one of ${PANEL_MODES.join(", ")}`);
	for (const key of ["workload", "slice", "legSchema", "synthPrompt", "synthSchema"]) if (typeof m[key] !== "string" || !m[key]) bad(`${key} is not a string`);
	if (typeof m.repoAccess !== "boolean") bad("repoAccess is not a boolean");
	if (m.repo !== null && m.repo !== undefined && typeof m.repo !== "string") bad("repo is not a string or null");
	if (!isObject(m.inputs)) return bad("inputs is not an object");
	for (const [rel, sha] of Object.entries(m.inputs)) {
		const problem = relProblem(rel);
		if (problem) bad(problem);
		if (typeof sha !== "string" || !SHA256.test(sha)) bad(`inputs[${JSON.stringify(rel)}] is not a lowercase sha256`);
	}
	const listed = (rel: unknown, where: string) => {
		if (typeof rel !== "string" || !Object.hasOwn(m.inputs as object, rel)) bad(`${where} ${JSON.stringify(rel)} is not in inputs`);
	};
	for (const key of ["legSchema", "synthPrompt", "synthSchema"]) listed(m[key], key);
	if (!isObject(m.legInputs)) return bad("legInputs is not an object");
	for (const lab of LABS) {
		const list = m.legInputs[lab];
		if (!isStrings(list) || list.length === 0) bad(`legInputs.${lab} is not a non-empty list of paths`);
		for (const rel of list as string[]) listed(rel, `legInputs.${lab}`);
	}
	if (!isStrings(m.synthInputs)) bad("synthInputs is not a list of paths");
	for (const rel of m.synthInputs as string[]) listed(rel, "synthInputs");
	if (!isStrings(m.withheld)) bad("withheld is not a list of paths");
	for (const rel of m.withheld as string[]) {
		listed(rel, "withheld");
		for (const lab of LABS) if ((m.legInputs[lab] as string[]).includes(rel)) bad(`withheld ${rel} is in legInputs.${lab}`);
	}
	const t = m.legTimeoutMin;
	if (!isObject(t) || typeof t.default !== "number" || !(t.default > 0)) bad("legTimeoutMin.default is not a positive number");
	for (const [key, value] of Object.entries(t as object)) {
		if (key !== "default" && !(LABS as readonly string[]).includes(key)) bad(`legTimeoutMin.${key} names no lab`);
		if (typeof value !== "number" || !(value > 0)) bad(`legTimeoutMin.${key} is not a positive number`);
	}
	if (m.canary !== null && m.canary !== undefined && typeof m.canary !== "string") bad("canary is not a string or null");
	return { ...(m as unknown as Manifest), repo: (m.repo as string | null | undefined) ?? null, canary: (m.canary as string | null | undefined) ?? null };
}

/** A leg's timeout in minutes: its lab's override, else the default. */
export function legTimeoutMin(manifest: Pick<Manifest, "legTimeoutMin">, lab: Lab): number {
	return manifest.legTimeoutMin[lab] ?? manifest.legTimeoutMin.default;
}

// ---- entry bodies (CONTRACT § 3) ---------------------------------------------------------------

export interface PanelGroup {
	run: string;
	pdir: string;
	slice: string;
	mode: PanelMode;
	/** Every ingested file, relative to `<pdir>/in/`, with its sha256: the manifest's inputs plus `manifest.json`. */
	inputs: Record<string, string>;
	members: Record<Lab, string | null>;
}

/**
 * What bound a landed leg's result file (`legLine`): `session`, the reply its own session records
 * (`recordedReply`), which also authenticates whatever was delivered; `delivered`, no session record,
 * but its whole text was delivered (`deliveredForm` `full`); `file`, neither — nothing was delivered,
 * or only part of it (a preview's head, a capped tail), so the file alone is the output.
 */
export type Binding = "session" | "delivered" | "file";
/** A leg's line. `excluded`: its output reached the lane but is kept out of the panel — `breach <call>` (the audit) or `delivered-mismatch <why>` (its result file is not the reply its session records, or not what was delivered for it). */
export type LegLine = { status: "landed"; sha: string; bound: Binding } | { status: "missing"; reason: string } | { status: "excluded"; reason: string };
export type SynthEnd = { status: "landed"; sha: string } | { status: "failed"; reason: string };
export type Published = Record<string, string>;

/** Free text as one line of single-spaced words, capped: an entry body is one line. */
export function words(text: string, cap = 240): string {
	const one = text.replace(/\s+/g, " ").trim() || "unknown";
	return one.length > cap ? `${one.slice(0, cap - 1)}…` : one;
}

export const panelGroupBody = (pg: string, g: PanelGroup) =>
	`panel-group: ${pg} ${JSON.stringify({ run: g.run, pdir: g.pdir, slice: g.slice, mode: g.mode, inputs: g.inputs, members: { anthropic: g.members.anthropic, openai: g.members.openai, kimi: g.members.kimi } })}`;

export function panelLegBody(pg: string, lab: Lab, line: LegLine): string {
	if (line.status === "landed") return `panel-leg: ${pg} ${lab} landed sha256 ${line.sha} bound ${line.bound}`;
	if (line.status === "missing") return `panel-leg: ${pg} ${lab} missing ${words(line.reason)}`;
	return `panel-leg: ${pg} ${lab} excluded ${words(line.reason)}`;
}

export const panelSynthBody = (pg: string, token: string) => `panel-synth: ${pg} ${token}`;
export const panelSynthEndBody = (pg: string, token: string, end: SynthEnd) =>
	end.status === "landed" ? `panel-synth: ${pg} ${token} landed sha256 ${end.sha}` : `panel-synth: ${pg} ${token} failed ${words(end.reason)}`;
export const panelPublishedBody = (pg: string, what: "out" | "report", hashes: Published) => `panel-published: ${pg} ${what} ${JSON.stringify(hashes)}`;
export const panelVoidBody = (pg: string, reason: string) => `panel-run: ${pg} void ${words(reason)}`;

const PANEL_GROUP = /^panel-group:\s+(pg-\S+)\s+(\{[\s\S]*\})$/;
const PANEL_LEG = /^panel-leg:\s+(pg-\S+)\s+(anthropic|openai|kimi)\s+(?:landed\s+sha256\s+([0-9a-f]{64})\s+bound\s+(session|delivered|file)|missing\s+(\S[\s\S]*)|excluded\s+(\S[\s\S]*))$/;
const PANEL_SYNTH = /^panel-synth:\s+(pg-\S+)\s+(\S+)(?:\s+(?:landed\s+sha256\s+([0-9a-f]{64})|failed\s+(\S[\s\S]*)))?$/;
const PANEL_PUBLISHED = /^panel-published:\s+(pg-\S+)\s+(out|report)\s+(\{[\s\S]*\})$/;
const PANEL_VOID = /^panel-run:\s+(pg-\S+)\s+void\s+(\S[\s\S]*)$/;

export function parsePanelGroup(body: string): (PanelGroup & { pg: string }) | null {
	const m = PANEL_GROUP.exec(body.trim());
	if (!m) return null;
	let j: unknown;
	try {
		j = JSON.parse(m[2]!);
	} catch {
		return null;
	}
	if (!isObject(j) || typeof j.run !== "string" || typeof j.pdir !== "string" || typeof j.slice !== "string" || typeof j.mode !== "string") return null;
	if (!(PANEL_MODES as readonly string[]).includes(j.mode) || !isObject(j.inputs) || !isObject(j.members)) return null;
	if (!Object.values(j.inputs).every(v => typeof v === "string")) return null;
	const members = {} as Record<Lab, string | null>;
	for (const lab of LABS) {
		const token = j.members[lab];
		if (token !== null && typeof token !== "string") return null;
		members[lab] = token;
	}
	return { pg: m[1]!, run: j.run, pdir: j.pdir, slice: j.slice, mode: j.mode as PanelMode, inputs: j.inputs as Record<string, string>, members };
}

export function parsePanelLeg(body: string): { pg: string; lab: Lab; line: LegLine } | null {
	const m = PANEL_LEG.exec(body.trim());
	if (!m) return null;
	const line: LegLine = m[3] ? { status: "landed", sha: m[3], bound: m[4] as Binding } : m[5] ? { status: "missing", reason: m[5] } : { status: "excluded", reason: m[6]! };
	return { pg: m[1]!, lab: m[2] as Lab, line };
}

export function parsePanelSynth(body: string): { pg: string; token: string; end: SynthEnd | null } | null {
	const m = PANEL_SYNTH.exec(body.trim());
	if (!m) return null;
	const end: SynthEnd | null = m[3] ? { status: "landed", sha: m[3] } : m[4] ? { status: "failed", reason: m[4] } : null;
	return { pg: m[1]!, token: m[2]!, end };
}

export function parsePanelPublished(body: string): { pg: string; what: "out" | "report"; hashes: Published } | null {
	const m = PANEL_PUBLISHED.exec(body.trim());
	if (!m) return null;
	try {
		const hashes = JSON.parse(m[3]!);
		if (!isObject(hashes) || !Object.values(hashes).every(v => typeof v === "string")) return null;
		return { pg: m[1]!, what: m[2] as "out" | "report", hashes: hashes as Published };
	} catch {
		return null;
	}
}

export function parsePanelVoid(body: string): { pg: string; reason: string } | null {
	const m = PANEL_VOID.exec(body.trim());
	return m ? { pg: m[1]!, reason: m[2]! } : null;
}

// ---- a workload's groups, from its entries -----------------------------------------------------

export interface PanelState {
	pg: string;
	group: PanelGroup;
	/** The `panel-group:` entry's time (ms): an unspawned leg's timeout counts from it. */
	at: number;
	/** The first line per lab: a later one (another instance's race) is ignored. */
	legs: Map<Lab, LegLine>;
	/** Synthesis attempts by token, dispatch order: when dispatched (ms) and how each ended. */
	synths: Map<string, { at: number; end: SynthEnd | null }>;
	published: { out: Published | null; report: Published | null };
	void: string | null;
}

/** Every panel group of a workload's entries (oldest first), by `pg-` id, in entry order. */
export function panelGroups(entries: readonly Entry[]): Map<string, PanelState> {
	const out = new Map<string, PanelState>();
	for (const e of entries) {
		if (e.kind !== "assumption" || !e.body.startsWith("panel-")) continue;
		const g = parsePanelGroup(e.body);
		if (g) {
			if (!out.has(g.pg)) {
				const { pg, ...group } = g;
				out.set(pg, { pg, group, at: Date.parse(e.created_at), legs: new Map(), synths: new Map(), published: { out: null, report: null }, void: null });
			}
			continue;
		}
		const leg = parsePanelLeg(e.body);
		if (leg) {
			const s = out.get(leg.pg);
			if (s && !s.legs.has(leg.lab)) s.legs.set(leg.lab, leg.line);
			continue;
		}
		const synth = parsePanelSynth(e.body);
		if (synth) {
			const s = out.get(synth.pg);
			if (!s) continue;
			const known = s.synths.get(synth.token);
			if (!known) s.synths.set(synth.token, { at: Date.parse(e.created_at), end: synth.end });
			else if (known.end === null) known.end = synth.end;
			continue;
		}
		const published = parsePanelPublished(e.body);
		if (published) {
			const s = out.get(published.pg);
			if (s && s.published[published.what] === null) s.published[published.what] = published.hashes;
			continue;
		}
		const v = parsePanelVoid(e.body);
		if (v) {
			const s = out.get(v.pg);
			if (s && s.void === null) s.void = v.reason;
		}
	}
	return out;
}

/** The group a staging run is ingested as (one group per run), by the run's realpath. */
export function groupOfRun(entries: readonly Entry[], runReal: string): PanelState | null {
	for (const s of panelGroups(entries).values()) if (s.group.run === runReal) return s;
	return null;
}

/** A panel hand's role, from its group and its token: rebuilt on recovery. */
export function roleOf(state: PanelState, token: string): PanelRole | null {
	for (const lab of LABS) if (state.group.members[lab] === token) return { group: state.pg, pdir: state.group.pdir, lab, role: "leg" };
	return null;
}

/** Synthesis failures that count toward the two-attempt limit: hands that ran (or timed out), not ones dropped or refused before spawning. */
export function synthFailures(state: PanelState): number {
	return [...state.synths.values()].filter(s => s.end?.status === "failed" && !/^(dropped|refused|held)\b/.test(s.end.reason)).length;
}

/** `<pdir>`: `<ledger dir>/lanes/<workload>/panels/<pg>/` (CONTRACT § 2). */
export const panelDir = (ledgerPath: string, workloadId: string, pg: string) => join(dirname(ledgerPath), "lanes", workloadId, "panels", pg);

// ---- reading without following links ----------------------------------------------------------

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A regular file's bytes, opened with O_NOFOLLOW: a symlink as the last component fails, as does anything but a regular file. */
export function readNoFollow(path: string): Buffer {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** The first file under `base` whose bytes do not hash to the ledger's value (`rels` limits the check), or null. */
export function verifyFiles(base: string, hashes: Readonly<Record<string, string>>, rels: readonly string[] = Object.keys(hashes)): string | null {
	for (const rel of rels) {
		const want = hashes[rel];
		let got: string | null = null;
		try {
			got = sha256(readNoFollow(join(base, rel)));
		} catch {
			got = null;
		}
		if (want === undefined || got !== want) return rel;
	}
	return null;
}

// ---- ingest (PLAN § 3.1) -----------------------------------------------------------------------

/** Every file under `dir` relative to it ('/'-separated); a symlink or anything but a file or directory throws. */
function walk(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		const rel = prefix ? `${prefix}/${name}` : name;
		const st = lstatSync(path);
		if (st.isSymbolicLink()) throw new Error(`${rel} under the run is a symlink`);
		if (st.isDirectory()) out.push(...walk(path, rel));
		else if (st.isFile()) out.push(rel);
		else throw new Error(`${rel} under the run is not a regular file`);
	}
	return out;
}

export interface Ingested {
	/** The staging run's realpath: the group's `run`. */
	run: string;
	manifest: Manifest;
	/** What the `panel-group:` entry records: the manifest's inputs plus `manifest.json`. */
	inputs: Record<string, string>;
}

/**
 * Ingest staging run `run` into `<pdir>/in/` for a `panel:` dispatch of `sliceId` on `workloadId`:
 * the manifest and every input opened with O_NOFOLLOW (no symlink anywhere below the run, regular
 * files only, exactly the files the manifest lists), each hashed on the read that copies it and
 * compared with the manifest. The manifest must name this workload and slice. `<pdir>` must not
 * exist. Throws with the reason; on success nothing reads the staging run again.
 */
export function ingestRun(run: string, workloadId: string, sliceId: string, pdir: string): Ingested {
	let runReal: string;
	try {
		runReal = realpathSync(run);
	} catch (error) {
		throw new Error(`the staging run ${run} cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!lstatSync(runReal).isDirectory()) throw new Error(`the staging run ${runReal} is not a directory`);
	const manifestBytes = readNoFollow(join(runReal, "manifest.json"));
	const manifest = parseManifest(manifestBytes.toString("utf8"));
	if (manifest.workload !== workloadId) throw new Error(`the staging run ${runReal} belongs to workload ${manifest.workload}, not ${workloadId}`);
	if (manifest.slice !== sliceId) throw new Error(`the staging run ${runReal} was prepared for slice ${manifest.slice}, not ${sliceId}`);
	const files = walk(runReal).filter(rel => rel !== "manifest.json");
	const listed = Object.keys(manifest.inputs);
	const extra = files.filter(rel => !Object.hasOwn(manifest.inputs, rel));
	const absent = listed.filter(rel => !files.includes(rel));
	if (extra.length > 0) throw new Error(`the staging run holds files its manifest does not list: ${extra.join(", ")}`);
	if (absent.length > 0) throw new Error(`the staging run lacks files its manifest lists: ${absent.join(", ")}`);
	mkdirSync(dirname(pdir), { recursive: true });
	mkdirSync(pdir); // throws when it exists: a group's directory is new
	const inDir = join(pdir, "in");
	mkdirSync(inDir);
	for (const rel of listed.sort()) {
		const bytes = readNoFollow(join(runReal, rel)); // one read: hashed and copied
		const got = sha256(bytes);
		if (got !== manifest.inputs[rel]) throw new Error(`${rel} hashes to ${got}, not the manifest's ${manifest.inputs[rel]}`);
		mkdirSync(dirname(join(inDir, rel)), { recursive: true });
		writeFileSync(join(inDir, rel), bytes, { flag: "wx" });
	}
	writeFileSync(join(inDir, "manifest.json"), manifestBytes, { flag: "wx" });
	return { run: runReal, manifest, inputs: { ...manifest.inputs, "manifest.json": sha256(manifestBytes) } };
}

/** The ingested manifest, re-hashed against the group's ledger line; throws `hash in/manifest.json` on a mismatch. */
export function groupManifest(group: Pick<PanelGroup, "pdir" | "inputs">): Manifest {
	const path = join(group.pdir, "in", "manifest.json");
	let bytes: Buffer;
	try {
		bytes = readNoFollow(path);
	} catch {
		throw new VoidRun("hash in/manifest.json");
	}
	if (sha256(bytes) !== group.inputs["manifest.json"]) throw new VoidRun("hash in/manifest.json");
	return parseManifest(bytes.toString("utf8"));
}

/** A tamper or integrity failure: the run is void (`panel-run: <pg> void <reason>`). */
export class VoidRun extends Error {}

// ---- task text (PLAN § 3.2) --------------------------------------------------------------------

/**
 * A leg's task: the lane's text with `{packet}` set to the leg's own packet path (quorum-refute's
 * per-leg packet; everyone else's shared one), plus the panel paragraph. Byte-identical across the
 * three members except quorum-refute's packet path. No review-findings paragraph.
 */
export function memberTask(text: string, pdir: string, manifest: Manifest, lab: Lab): string {
	const inputs = manifest.legInputs[lab].map(rel => join(pdir, "in", rel));
	const packet = inputs.find(p => basename(p) === "packet.md") ?? inputs[0]!;
	const paragraph = [
		"",
		"",
		`Panel leg (agent-system 2.0 cross-model panel, mode ${manifest.mode}). Read only these files: ${inputs.join(", ")}.`,
		`Name no other file under ${pdir}, no other panel's directory, nothing under withheld/, no session file, and no agent://, history://, proc://, artifact:// or local:// URI; such a call excludes your output.${manifest.repoAccess ? "" : " This panel is packet-only: call no bash, eval, browser or web_search, and read nothing but the files above."}`,
		`Reply with one JSON object matching the output schema (${join(pdir, "in", manifest.legSchema)}): a top-level "items" array, one object per finding, attack or plan element.`,
	].join("\n");
	return `${text.replaceAll("{packet}", packet)}${paragraph}`;
}

/** The synthesis hand's task: the lane's text plus what it may read, the lab it runs on, and its output. */
export function synthTask(text: string, pdir: string, manifest: Manifest, landed: readonly Lab[], lab: Lab, builderLab: boolean): string {
	const reads = synthAllowed(pdir, manifest, landed);
	return [
		text,
		"",
		`Panel synthesis (agent-system 2.0 cross-model panel, mode ${manifest.mode}). Read only these files: ${reads.join(", ")}.`,
		`You run on lab ${lab}${builderLab ? ", a builder lab of this workload (no other lab was usable); say so in the legs line as synth: " + lab + " (builder lab)" : ""}. report.json's "synth" is {"lab":"${lab}","builderLab":${builderLab}}.`,
		`Reply with one JSON object matching the output schema (${join(pdir, "in", manifest.synthSchema)}): legs, synth, findings, dropped and markdown (the full REPORT.md text).`,
	].join("\n");
}

/** What a leg may read: its `legInputs` under `<pdir>/in/`. */
export const legAllowed = (pdir: string, manifest: Manifest, lab: Lab) => manifest.legInputs[lab].map(rel => join(pdir, "in", rel));

/** What the synthesis hand may read: `status.json`, the landed legs' outputs, the synthesis prompt, and `synthInputs`. */
export const synthAllowed = (pdir: string, manifest: Manifest, landed: readonly Lab[]) => [
	join(pdir, "out", "status.json"),
	...landed.map(lab => join(pdir, "out", "legs", `${lab}.json`)),
	join(pdir, "in", manifest.synthPrompt),
	...manifest.synthInputs.map(rel => join(pdir, "in", rel)),
];

// ---- path tokens -------------------------------------------------------------------------------

/** Every string value in `x`, depth first. */
function strings(x: unknown, out: string[] = []): string[] {
	if (typeof x === "string") out.push(x);
	else if (Array.isArray(x)) for (const v of x) strings(v, out);
	else if (isObject(x)) for (const v of Object.values(x)) strings(v, out);
	return out;
}

/** The path-like tokens of a string: split on whitespace, quotes and shell / markup punctuation; a `:range` suffix dropped. */
function pathTokens(s: string): string[] {
	return s
		.split(/[\s"'`<>|;,()[\]{}=#*?]+/)
		.filter(t => t.includes("/"))
		.map(t => normalize(t.replace(/:[^/]*$/, "")).replace(/\/+$/, "") || "/");
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** The deepest existing ancestor of `path`, resolved through symlinks, with the rest appended. */
function realish(path: string): string {
	const rest: string[] = [];
	let at = path;
	for (;;) {
		try {
			return join(realpathSync(at), ...rest.reverse());
		} catch {
			const parent = dirname(at);
			if (parent === at) return path;
			rest.push(basename(at));
			at = parent;
		}
	}
}

/**
 * The first path an editing tool's input names under `<ledger dir>/lanes/*\/panels/`, or null
 * (PLAN § 3.1: refused for every session). Literal paths and paths relative to `cwd`; a path through
 * a symlink is resolved as far as it exists.
 */
export function namesPanelsDir(input: unknown, ledgerDir: string, cwd: string): string | null {
	const lanes = join(ledgerDir, "lanes");
	const panels = (p: string) => {
		if (!under(p, lanes)) return false;
		const parts = p.slice(lanes.length + 1).split("/");
		return parts.length >= 2 && parts[1] === "panels";
	};
	for (const s of strings(input)) {
		if (s.includes(`${lanes}/`) && /\/panels(\/|$)/.test(s.slice(s.indexOf(`${lanes}/`)))) return s;
		for (const token of pathTokens(s)) {
			const abs = isAbsolute(token) ? token : resolve(cwd, token);
			if (panels(abs) || panels(realish(abs))) return token;
		}
	}
	return null;
}

// ---- the breach audit (PLAN § 3.4 rule 4) ------------------------------------------------------

export interface AuditScope {
	pdir: string;
	/** The absolute paths under `<pdir>` the hand may name. */
	allowed: readonly string[];
	repoAccess: boolean;
	/** The lane's session root (its artifacts directory) and the hand's own agent id. */
	root: string;
	agentId: string;
	/** `<ledger dir>/lanes`: every panel directory is under it. */
	lanes: string;
	/** The staging run: never read after ingest. */
	run: string;
}

const URI = /\b(?:agent|history|proc|artifact|local):\/\//;
const SHELL_TOOLS: Record<string, true> = { bash: true, eval: true, browser: true, web_search: true };
const READ_TOOLS: Record<string, true> = { read: true, grep: true, glob: true, find: true, search: true, ast_grep: true, lsp: true };
/** The reply itself: its arguments are the hand's output, which may quote paths or URIs as findings; it reads nothing. */
const REPLY_TOOLS: Record<string, true> = { yield: true, submit_result: true };
const PATH_KEYS = ["path", "paths", "file", "files", "file_path", "notebook_path", "cwd"];

/** Why one tool call is a breach for `scope`, or null. */
export function breachOf(name: string, args: unknown, scope: AuditScope): string | null {
	const allowed = new Set(scope.allowed);
	const call = (what: string) => words(`${name} ${what}`, 160);
	if (Object.hasOwn(REPLY_TOOLS, name)) return null;
	if (!scope.repoAccess && Object.hasOwn(SHELL_TOOLS, name)) return call("in a packet-only panel");
	/** Why naming `path` (absolute, normalized) is a breach, or null. */
	const named = (path: string): string | null => {
		if (allowed.has(path)) return null;
		if (under(path, scope.pdir)) return call(`names ${path} outside its inputs`);
		if (under(path, scope.lanes) || /(^|\/)panels\/pg-/.test(path)) return call(`names another panel ${path}`);
		if (/(^|\/)withheld(\/|$)/.test(path)) return call(`names withheld ${path}`);
		if (path === `${scope.root}.jsonl` || (under(path, scope.root) && !path.startsWith(`${scope.root}/${scope.agentId}.`))) return call(`names a session file ${path}`);
		if (under(path, scope.run)) return call(`names the staging run ${path}`);
		return null;
	};
	// A structured path argument is compared whole before any token split: a protected root with a space
	// in it (a session root under `…/Application Support/…`) does not survive the whitespace split below.
	const paths = isObject(args) ? PATH_KEYS.flatMap(k => strings(args[k])).flatMap(p => p.split(";")).map(p => p.trim()).filter(Boolean) : [];
	for (const p of paths) {
		const breach = named(normalize(p.replace(/:[^/]*$/, "")).replace(/\/+$/, "") || "/");
		if (breach) return breach;
	}
	for (const s of strings(args)) {
		const uri = URI.exec(s);
		if (uri) return call(`names ${uri[0]}`);
		for (const token of pathTokens(s)) {
			const breach = named(token);
			if (breach) return breach;
		}
	}
	if (!scope.repoAccess && Object.hasOwn(READ_TOOLS, name)) {
		if (paths.length === 0) return call("with no path in a packet-only panel");
		for (const p of paths) {
			// An installed skill's own docs (`skill://<name>[/<file>]`): OMP's system prompt tells every hand to read a
			// matching skill first, and a skill file is static install content, never a peer's output (smoke, sl-xmr-smoke).
			if (/^skill:\/\/[^/]/.test(p) && !/(^|\/)\.\.(\/|$)/.test(p)) continue;
			const path = normalize(p.replace(/:[^/]*$/, ""));
			if (!allowed.has(path)) return call(`reads ${path} outside its inputs in a packet-only panel`);
		}
	}
	return null;
}

/** A hand's own session file as its JSON records (a line that does not parse is skipped), or why it cannot be read. */
export function readSession(file: string): { records: unknown[] } | { unreadable: string } {
	let text: string;
	try {
		text = readNoFollow(file).toString("utf8");
	} catch (error) {
		return { unreadable: `its session file ${file} cannot be read (${error instanceof Error ? error.message : String(error)})` };
	}
	const records: unknown[] = [];
	for (const line of text.split("\n")) {
		try {
			records.push(JSON.parse(line));
		} catch {
			// not a record
		}
	}
	return { records };
}

/**
 * The first breach among the tool calls in a hand's session records (`{"type":"message","message":
 * {"role":"assistant","content":[{"type":"toolCall","name","arguments"}]}}`), or null.
 */
export function auditRecords(records: readonly unknown[], scope: AuditScope): string | null {
	for (const record of records) {
		if (!isObject(record) || record.type !== "message" || !isObject(record.message) || record.message.role !== "assistant") continue;
		const content = record.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isObject(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
			const breach = breachOf(part.name, part.arguments, scope);
			if (breach) return breach;
		}
	}
	return null;
}

/**
 * The first breach among the tool calls in a hand's session file, null when there is none, or
 * `unreadable` when the file cannot be read (the hand is then not landed: fail closed).
 */
export function auditSession(file: string, scope: AuditScope): { breach: string } | { unreadable: string } | null {
	const session = readSession(file);
	if ("unreadable" in session) return session;
	const breach = auditRecords(session.records, scope);
	return breach ? { breach } : null;
}

/** What OMP's session persistence appends to a string it cut (pi-coding-agent session/session-persistence.ts `TRUNCATION_NOTICE`). */
const PERSIST_TRUNCATED = "\n\n[Session persistence truncated large content]";

/** pi-coding-agent task/executor.ts `parseStringifiedJson`: a yielded string that holds a JSON object or array is that value. */
function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

/**
 * The text OMP wrote to a hand's result file `<agentId>.md`, re-derived from the hand's own session
 * records, or null when they hold no full record of it. OMP takes each `yield` tool result's
 * `details` (`{status, data, type?, useLastTurn?, …}`, tools/yield.ts `extractData`, persisted on the
 * session's `toolResult` record) and, for a run that ends on a plain terminal yield — status
 * `success`, no incremental section `type`, its own `data`, not the last turn's text — in the
 * default `permissive` schema mode writes `JSON.stringify(data, null, 2)` (task/executor.ts
 * `finalizeSubprocessOutput` / `finalizeRunResult`, task-yield-assembly.ts). Every other shape is
 * not re-derived here: no yield (the assistant's text), an aborted or sectioned yield, `strict` mode
 * (its validator normalizes the data), and a session string OMP cut on persisting it.
 */
export function recordedReply(records: readonly unknown[]): string | null {
	let mode: unknown = null;
	let initialized = false;
	let last: Record<string, unknown> | null = null;
	for (const record of records) {
		if (!isObject(record)) continue;
		if (record.type === "session_init") {
			initialized = true;
			mode = record.outputSchemaMode;
			continue;
		}
		if (record.type !== "message" || !isObject(record.message) || record.message.role !== "toolResult" || record.message.toolName !== "yield") continue;
		const details = record.message.details;
		if (isObject(details) && (details.status === "success" || details.status === "aborted")) last = details;
	}
	if (!initialized || mode === "strict" || !last || last.status !== "success") return null;
	if ((Array.isArray(last.type) && last.type.length > 0) || last.useLastTurn === true || last.data === undefined || last.data === null) return null;
	if (strings(last.data).some(s => s.endsWith(PERSIST_TRUNCATED))) return null;
	return JSON.stringify(parseStringifiedJson(last.data), null, 2) ?? null;
}

// ---- outputs and schemas -----------------------------------------------------------------------

/** A hand's reply as JSON: the whole text, else its last fenced `json` block; null when neither parses. */
export function parseOutput(text: string): unknown {
	try {
		return JSON.parse(text.trim());
	} catch {
		const blocks = [...text.matchAll(/```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)];
		const last = blocks[blocks.length - 1];
		if (!last) return null;
		try {
			return JSON.parse(last[1]!);
		} catch {
			return null;
		}
	}
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/**
 * `value` against a JSON Schema, the keywords prep writes (type, properties, required,
 * additionalProperties, items, enum, const, minItems, maxItems, minLength, maxLength, minimum,
 * maximum); other keywords are not checked. The first violation, or null.
 */
export function schemaProblem(value: unknown, schema: unknown, at = "$"): string | null {
	if (!isObject(schema)) return null;
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const t = typeOf(value);
		if (!types.some(want => want === t || (want === "number" && t === "integer"))) return `${at} is ${t}, not ${types.join("|")}`;
	}
	if (Array.isArray(schema.enum) && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) return `${at} is not one of the enum values`;
	if (Object.hasOwn(schema, "const") && JSON.stringify(schema.const) !== JSON.stringify(value)) return `${at} is not the const value`;
	if (typeof value === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${at} is shorter than ${schema.minLength}`;
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${at} is longer than ${schema.maxLength}`;
	}
	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) return `${at} is below ${schema.minimum}`;
		if (typeof schema.maximum === "number" && value > schema.maximum) return `${at} is above ${schema.maximum}`;
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at} has fewer than ${schema.minItems} items`;
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at} has more than ${schema.maxItems} items`;
		if (isObject(schema.items)) {
			for (let i = 0; i < value.length; i++) {
				const p = schemaProblem(value[i], schema.items, `${at}[${i}]`);
				if (p) return p;
			}
		}
	}
	if (isObject(value)) {
		const props = isObject(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === "string" && !Object.hasOwn(value, key)) return `${at}.${key} is missing`;
		for (const [key, v] of Object.entries(value)) {
			if (Object.hasOwn(props, key)) {
				const p = schemaProblem(v, props[key], `${at}.${key}`);
				if (p) return p;
			} else if (schema.additionalProperties === false) return `${at}.${key} is not allowed`;
			else if (isObject(schema.additionalProperties)) {
				const p = schemaProblem(v, schema.additionalProperties, `${at}.${key}`);
				if (p) return p;
			}
		}
	}
	return null;
}

/** CONTRACT § 1 leg shape: an object with a top-level `items` array of objects. */
export function legShapeProblem(value: unknown): string | null {
	if (!isObject(value)) return "the output is not a JSON object";
	if (!Array.isArray(value.items) || !value.items.every(isObject)) return "the output has no items array of objects";
	return null;
}

/** CONTRACT § 1 synthesis shape, its `synth` naming the lab it was pinned to (and whether that is a builder lab, when known: recovery does not know it). */
export function synthShapeProblem(value: unknown, lab: Lab, builderLab: boolean | undefined): string | null {
	if (!isObject(value)) return "the output is not a JSON object";
	if (!Array.isArray(value.legs) || value.legs.length !== LABS.length) return "legs does not name the three labs";
	for (const want of LABS) {
		const leg = value.legs.find(l => isObject(l) && l.lab === want);
		if (!isObject(leg) || !["landed", "missing", "excluded"].includes(leg.status as string)) return `legs has no ${want} line with a status`;
	}
	if (!isObject(value.synth) || value.synth.lab !== lab || typeof value.synth.builderLab !== "boolean" || (builderLab !== undefined && value.synth.builderLab !== builderLab)) {
		return `synth is not {"lab":"${lab}","builderLab":${builderLab ?? "<boolean>"}}`;
	}
	if (!Array.isArray(value.findings) || !value.findings.every(f => isObject(f) && typeof f.id === "string" && isStrings(f.supportIds) && isStrings(f.refuteIds))) {
		return "findings is not a list of {id, supportIds, refuteIds}";
	}
	if (!Array.isArray(value.dropped) || !value.dropped.every(d => isObject(d) && typeof d.id === "string" && typeof d.reason === "string")) return "dropped is not a list of {id, reason}";
	if (typeof value.markdown !== "string" || !value.markdown.trim()) return "markdown is empty";
	return null;
}

/** A leg's output with `"id": "<lab>-<n>"` on each item (n 1-based, by position), and the ids; null when it has no `items` array of objects. */
export function assignIds(output: unknown, lab: Lab): { output: Record<string, unknown>; ids: string[] } | null {
	if (!isObject(output) || !Array.isArray(output.items) || !output.items.every(isObject)) return null;
	const ids = output.items.map((_, i) => `${lab}-${i + 1}`);
	const items = output.items.map((item, i) => {
		const { id: _drop, ...rest } = item;
		return { id: ids[i], ...rest };
	});
	return { output: { ...output, items }, ids };
}

// ---- publication -------------------------------------------------------------------------------

/** Test seams of a publication: `staged` runs once its temps are written, before its transaction; `step` after each rename into place. */
export interface PublishHooks {
	staged?: () => void;
	step?: (rel: string) => void;
}

/**
 * Publish `files` under `dir` (PLAN § 3.1) as one serialized step. Each file is first written to a
 * unique temp name beside its target (`.<name>.<uuid>.tmp`, which `panel.ts check` ignores). Then,
 * in one ledger write transaction, `commit` re-reads the ledger: when the publication no longer
 * stands it returns without calling `rename`, and nothing is replaced; else it calls `rename`, which
 * moves every temp into place in order (the caller puts `status.json` / `REPORT.md` last), and
 * records the publication. The write lock is the one every instance's publication and timeout take,
 * so no other instance can record or replace anything between the recheck, the renames and the
 * record. Temps left by a refusal or a failure are removed, and once a publication lands, any temp an
 * earlier interrupted one left beside the same targets. Returns what `commit` returns.
 */
function publish<T>(ledger: PanelPort, dir: string, files: readonly { rel: string; bytes: string }[], commit: (rename: () => void) => T, hooks: PublishHooks = {}): T {
	const staged: { rel: string; target: string; tmp: string; sha: string }[] = [];
	let landed = false;
	try {
		for (const { rel, bytes } of files) {
			const target = join(dir, rel);
			mkdirSync(dirname(target), { recursive: true });
			const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
			writeFileSync(tmp, bytes, { flag: "wx" });
			staged.push({ rel, target, tmp, sha: sha256(bytes) });
		}
		hooks.staged?.();
		const result = ledger.write(() => {
			landed = false;
			return commit(() => {
				for (const f of staged) {
					// The ledger reruns a transaction whose COMMIT met SQLITE_BUSY: a temp the first run moved is its target now.
					if (existsSync(f.tmp)) renameSync(f.tmp, f.target);
					else if (sha256(readNoFollow(f.target)) !== f.sha) throw new Error(`${f.target} changed while it was being published`);
					hooks.step?.(f.rel);
				}
				landed = true;
			});
		});
		if (landed) for (const f of staged) sweepTemps(f.target);
		return result;
	} finally {
		for (const f of staged) rmSync(f.tmp, { force: true });
	}
}

/** Temps of `target` an interrupted publication left beside it (`.<name>.<uuid>.tmp`), removed once a publication of `target` lands. */
function sweepTemps(target: string): void {
	let names: string[];
	try {
		names = readdirSync(dirname(target));
	} catch {
		return;
	}
	const prefix = `.${basename(target)}.`;
	for (const name of names) if (name.startsWith(prefix) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length))) rmSync(join(dirname(target), name), { force: true });
}

type PanelPort = Pick<RoutingLedger, "entries" | "routings" | "recordEntry" | "write">;
type Stamp = { workloadId: string; by: string };

/** Write `panel-run: <pg> void <reason>` once (a transaction that checks the run is not void yet). Returns the reason in force. */
export function voidRun(ledger: PanelPort, at: Stamp, pg: string, reason: string): string {
	return ledger.write(() => {
		const state = panelGroups(ledger.entries(at.workloadId)).get(pg);
		if (state?.void) return state.void;
		ledger.recordEntry({ by: at.by, workloadId: at.workloadId, sliceId: state?.group.slice ?? null, kind: "assumption", body: panelVoidBody(pg, reason) });
		return words(reason);
	});
}

/** Write `panel-leg:` for `lab` unless the lab has one; returns the line already there (a late result), or null when this one landed. Call inside a write transaction. */
export function writeLeg(ledger: PanelPort, at: Stamp, pg: string, lab: Lab, line: LegLine): LegLine | null {
	const state = panelGroups(ledger.entries(at.workloadId)).get(pg);
	const known = state?.legs.get(lab);
	if (known) return known;
	ledger.recordEntry({ by: at.by, workloadId: at.workloadId, sliceId: state?.group.slice ?? null, kind: "assumption", body: panelLegBody(pg, lab, line) });
	return null;
}

/** Write a synthesis attempt's end unless it has one; returns the end already there, or null. Call inside a write transaction. */
export function writeSynthEnd(ledger: PanelPort, at: Stamp, pg: string, token: string, end: SynthEnd): SynthEnd | null {
	const state = panelGroups(ledger.entries(at.workloadId)).get(pg);
	const known = state?.synths.get(token)?.end;
	if (known) return known;
	ledger.recordEntry({ by: at.by, workloadId: at.workloadId, sliceId: state?.group.slice ?? null, kind: "assumption", body: panelSynthEndBody(pg, token, end) });
	// A failure never voids a group whose report is published (a late attempt cannot undo it).
	if (end.status === "failed" && state && !state.void && !state.published.report) {
		const after = panelGroups(ledger.entries(at.workloadId)).get(pg)!;
		if (synthFailures(after) >= 2) ledger.recordEntry({ by: at.by, workloadId: at.workloadId, sliceId: state.group.slice, kind: "assumption", body: panelVoidBody(pg, "synthesis failed twice") });
	}
	return null;
}

export type Finalized = "published" | "already" | "waiting" | { void: string };

/**
 * PLAN § 3.4 rule 3: when all three labs have a `panel-leg:` line, publish `out/legs/<lab>.json` for
 * each landed leg (its result file `<session root>/<agent id>.md`, read through its settled routing
 * row, refused unless its sha256 is the settle line's; validated against the leg schema; ids
 * assigned) and `out/status.json` last, with `panel-published: <pg> out`, through `publish`: the
 * renames and the line happen only while the transaction sees the group neither void nor published.
 * A mismatch or an unreadable input voids the run. Idempotent: an interrupted publication is redone
 * by the next call.
 */
export function finalizeLegs(ledger: PanelPort, at: Stamp, pg: string, hooks?: PublishHooks): Finalized {
	const entries = ledger.entries(at.workloadId);
	const state = panelGroups(entries).get(pg);
	if (!state) return "waiting";
	if (state.void) return { void: state.void };
	if (state.published.out) return "already";
	if (LABS.some(lab => !state.legs.has(lab))) return "waiting";
	const fail = (reason: string): Finalized => ({ void: voidRun(ledger, at, pg, reason) });
	let manifest: Manifest;
	let schema: unknown;
	try {
		manifest = groupManifest(state.group);
		const bad = verifyFiles(join(state.group.pdir, "in"), state.group.inputs, [manifest.legSchema]);
		if (bad) return fail(`hash in/${bad}`);
		schema = JSON.parse(readNoFollow(join(state.group.pdir, "in", manifest.legSchema)).toString("utf8"));
	} catch (error) {
		return fail(error instanceof VoidRun ? error.message : `the leg schema cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
	const settled = settledTokens(entries);
	const rows = new Map(ledger.routings(at.workloadId).map(r => [r.id, r]));
	const files: { rel: string; bytes: string }[] = [];
	const legs: Record<string, { status: LegLine["status"]; reason: string | null; model: string | null; token: string | null; findingIds: string[] }> = {};
	for (const lab of LABS) {
		const line = state.legs.get(lab)!;
		const token = state.group.members[lab];
		const row: Pick<RoutingRow, "session_root" | "agent_id" | "ran_models"> | undefined = token ? rows.get(settled.get(token) ?? "") : undefined;
		const model = ranModel(row?.ran_models ?? null);
		if (line.status !== "landed") {
			legs[lab] = { status: line.status, reason: line.reason, model, token, findingIds: [] };
			continue;
		}
		if (!row?.agent_id) return fail(`result ${lab} has no settled routing row`);
		const path = join(row.session_root, `${row.agent_id}.md`);
		let text: string;
		try {
			text = readNoFollow(path).toString("utf8");
		} catch {
			return fail(`hash ${path}`);
		}
		if (sha256(text) !== line.sha) return fail(`hash ${path}`);
		const output = parseOutput(text);
		const problem = legShapeProblem(output) ?? schemaProblem(output, schema);
		if (problem) return fail(`schema ${lab}: ${problem}`);
		const assigned = assignIds(output, lab);
		if (!assigned) return fail(`schema ${lab}: the output has no items array of objects`);
		const { output: withIds, ids } = assigned;
		files.push({ rel: `legs/${lab}.json`, bytes: `${JSON.stringify(withIds, null, 2)}\n` });
		legs[lab] = { status: "landed", reason: null, model, token, findingIds: ids };
	}
	files.push({ rel: "status.json", bytes: `${JSON.stringify({ group: pg, legs }, null, 2)}\n` });
	const hashes = Object.fromEntries(files.map(f => [`out/${f.rel}`, sha256(f.bytes)]));
	return publish(
		ledger,
		join(state.group.pdir, "out"),
		files,
		(rename): Finalized => {
			const now = panelGroups(ledger.entries(at.workloadId)).get(pg)!;
			if (now.void) return { void: now.void };
			if (now.published.out) return "already";
			rename();
			ledger.recordEntry({ by: at.by, workloadId: at.workloadId, sliceId: state.group.slice, kind: "assumption", body: panelPublishedBody(pg, "out", hashes) });
			return "published";
		},
		hooks,
	);
}

function ranModel(json: string | null): string | null {
	if (!json) return null;
	try {
		const list = JSON.parse(json);
		return Array.isArray(list) && typeof list[0] === "string" ? list[0] : null;
	} catch {
		return null;
	}
}

/** The landed labs of a published group, read from its `status.json` line's legs (the ledger-hashed copy). */
export function landedLabs(state: PanelState): Lab[] {
	return LABS.filter(lab => state.legs.get(lab)?.status === "landed");
}

/**
 * PLAN § 3.4 rule 5: the synthesis hand's reply (its result file's text): an attempt that already
 * ended (failed, a timeout included) or a group whose report is published writes no file; `out/`
 * re-hashed against `panel-published: <pg> out`, the reply validated (one plain JSON text, the
 * synthesis schema and CONTRACT § 1's shape, its `synth` the pinned lab), then `out/report.json` (the
 * reply's bytes) and `out/REPORT.md` (its markdown), REPORT.md last, with `panel-synth: … landed`
 * and `panel-published: <pg> report`, through `publish`: the transaction that renames them and
 * writes both lines first re-checks that the run is not void, this attempt has not ended (a timeout
 * another instance recorded meanwhile) and no report is published (another attempt's), so a
 * published report is never replaced. A reply that fails writes `panel-synth: … failed <reason>`; a
 * tampered `out/` voids the run.
 */
export function finishSynth(ledger: PanelPort, at: Stamp, pg: string, token: string, role: Pick<PanelRole, "lab" | "builderLab">, text: string | null, hooks?: PublishHooks): SynthEnd | { void: string } {
	const state = panelGroups(ledger.entries(at.workloadId)).get(pg);
	if (!state) return { status: "failed", reason: "no panel-group entry" };
	if (state.void) return { void: state.void };
	const late = "late the panel's report is already published";
	const failed = (reason: string): SynthEnd => {
		const known = ledger.write(() => writeSynthEnd(ledger, at, pg, token, { status: "failed", reason }));
		return known ?? { status: "failed", reason };
	};
	// Early, before any file is staged; the publication transaction checks both again.
	const ended = state.synths.get(token)?.end;
	if (ended) return ended;
	if (state.published.report) return failed(late);
	if (!state.published.out) return failed("no panel-published out");
	const bad = verifyFiles(state.group.pdir, state.published.out);
	if (bad) return { void: voidRun(ledger, at, pg, `hash ${bad}`) };
	let manifest: Manifest;
	let schema: unknown;
	try {
		manifest = groupManifest(state.group);
		const badIn = verifyFiles(join(state.group.pdir, "in"), state.group.inputs, [manifest.synthSchema, manifest.synthPrompt, ...manifest.synthInputs]);
		if (badIn) return { void: voidRun(ledger, at, pg, `hash in/${badIn}`) };
		schema = JSON.parse(readNoFollow(join(state.group.pdir, "in", manifest.synthSchema)).toString("utf8"));
	} catch (error) {
		if (error instanceof VoidRun) return { void: voidRun(ledger, at, pg, error.message) };
		return failed(`the synthesis schema cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
	if (text === null) return failed("no result file");
	// report.json is the reply's bytes, so the reply is one plain JSON text, as `panel.ts check` and
	// every consumer parse it: a fenced or wrapped reply is a failed attempt, never published.
	let output: unknown;
	try {
		output = JSON.parse(text);
	} catch {
		return failed("schema the reply is not plain JSON (out/report.json is the reply's bytes; a fenced or wrapped reply is not published)");
	}
	const problem = schemaProblem(output, schema) ?? synthShapeProblem(output, role.lab, role.builderLab);
	if (problem) return failed(`schema ${problem}`);
	const markdown = isObject(output) && typeof output.markdown === "string" ? output.markdown : "";
	const files = [
		{ rel: "report.json", bytes: text },
		{ rel: "REPORT.md", bytes: markdown },
	];
	const end: SynthEnd = { status: "landed", sha: sha256(text) };
	const hashes = Object.fromEntries(files.map(f => [`out/${f.rel}`, sha256(f.bytes)]));
	return publish(
		ledger,
		join(state.group.pdir, "out"),
		files,
		(rename): SynthEnd | { void: string } => {
			const now = panelGroups(ledger.entries(at.workloadId)).get(pg)!;
			if (now.void) return { void: now.void };
			const known = now.synths.get(token)?.end;
			if (known) return known;
			if (now.published.report) return writeSynthEnd(ledger, at, pg, token, { status: "failed", reason: late }) ?? { status: "failed", reason: late };
			rename();
			writeSynthEnd(ledger, at, pg, token, end);
			ledger.recordEntry({ by: at.by, workloadId: at.workloadId, sliceId: state.group.slice, kind: "assumption", body: panelPublishedBody(pg, "report", hashes) });
			return end;
		},
		hooks,
	);
}

// ---- the delivered output (PLAN § 3.4 rule 3) --------------------------------------------------

/** `<` of a harness tag: pi-coding-agent session/harness-tags.ts `escapeHarnessTags`, which OMP runs over a hand's output inside its `<task-result>`. */
const HARNESS_TAG = /<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi;
/** pi-coding-agent task/result-summary.ts `FULL_OUTPUT_THRESHOLD`: an output longer than this reaches the lane as a preview of its head. */
const FULL_OUTPUT_THRESHOLD = 5000;

/**
 * How `delivered` (what reached the lane for a hand: `results[].output`, the task call's text, a job
 * snapshot's result or an async-result notice) carries `text`, the hand's result file
 * `<root>/<agentId>.md`: all of it (`full`), part of it (`partial`), or why it does not. They are
 * one output in OMP's forms (pi-coding-agent task/executor.ts `finalizeRunResult` writes the file and
 * `results[].output`; task/result-summary.ts `formatTaskResultSummary` renders the envelope from that
 * output trimmed, its harness tags escaped), each compared exactly:
 * - `results[].output` is the file's text (`full`), or only its tail when the file passes OMP's
 *   output cap (`PI_TASK_MAX_OUTPUT_LINES` 5000 / `PI_TASK_MAX_OUTPUT_BYTES` 500000; `partial`).
 * - an envelope's `<output>` is the file's text trimmed, harness tags escaped (`full`). OMP's prompt
 *   renderer (pi-utils prompt.ts `format`) then trims line ends, drops blank lines and redraws table
 *   rules, none of which occur in the `JSON.stringify(…, null, 2)` text a yield leaves in the file;
 *   any other difference, inside a JSON string included, is another output.
 * - an envelope's `<preview full-output="agent://…">` (a file past 5000 characters) is the head
 *   `previewHead` cuts from that text, escaped, its cut line's end trimmed by the renderer
 *   (`partial`); past the output cap, a head of the tail, found in the file (`partial`). A preview
 *   says nothing about the rest of the file.
 */
export function deliveredForm(delivered: string, text: string): "full" | "partial" | { mismatch: string } {
	if (delivered === text) return "full";
	const capped =
		text.split("\n").length > (Number(process.env.PI_TASK_MAX_OUTPUT_LINES) || 5000) || Buffer.byteLength(text) > (Number(process.env.PI_TASK_MAX_OUTPUT_BYTES) || 500_000);
	const open = /<task-result\b[^>]*>/.exec(delivered);
	if (!open) return capped && delivered !== "" && text.endsWith(delivered) ? "partial" : { mismatch: "delivered-mismatch its result file is not the output delivered for it" };
	const after = delivered.slice(open.index + open[0].length);
	const close = after.lastIndexOf("</task-result>");
	const inner = close < 0 ? after : after.slice(0, close);
	const body = /<(output|preview full-output="[^"]*")>\n/.exec(inner);
	const end = body ? inner.lastIndexOf(body[1] === "output" ? "\n</output>" : "\n</preview>") : -1;
	if (!body || end < body.index + body[0].length) return { mismatch: "delivered-mismatch its delivered <task-result> carries no output" };
	const carried = inner.slice(body.index + body[0].length, end);
	const output = text.trim();
	if (body[1] === "output") return carried === output.replace(HARNESS_TAG, "&lt;") ? "full" : { mismatch: "delivered-mismatch its result file is not the output its <task-result> carried" };
	let head: string;
	if (capped) {
		// The head of a tail this file's text no longer pins down: it must be in the file (a cut right after a `<` left it unescaped).
		head = output.replace(HARNESS_TAG, "&lt;").includes(carried.replace(/<$/, "")) ? carried : "";
	} else {
		// result-summary.ts `previewHead`: the first 5000 characters, cut back to their last line break when that is past half.
		const slice = output.slice(0, FULL_OUTPUT_THRESHOLD);
		const lastNewline = slice.lastIndexOf("\n");
		head = (lastNewline >= FULL_OUTPUT_THRESHOLD / 2 ? slice.slice(0, lastNewline) : slice).replace(HARNESS_TAG, "&lt;").trimEnd();
	}
	return head !== "" && carried === head ? "partial" : { mismatch: "delivered-mismatch its result file does not begin with the preview its <task-result> carried" };
}

// ---- a leg's settle (PLAN § 3.4 rules 2–4) -----------------------------------------------------

/**
 * A settled leg's line, before it is written: its `legInputs` re-hashed against the group's ledger
 * line (a mismatch voids the run), its session audited for breaches, its result file read and bound,
 * shaped and validated against the leg schema, and its sha256 taken. The binding (`Binding`): when
 * the hand's own session records its reply (`recordedReply`), the file must be exactly that text;
 * when something was `delivered` for it, the file must be what was delivered (`deliveredForm`).
 * Either difference excludes the leg. `refusal`: why the hand's verdict withheld its output (no
 * model answered, off its row, it changed the work), so it is missing.
 */
export function legLine(
	state: PanelState,
	lab: Lab,
	hand: { root: string; agentId: string },
	lanes: string,
	refusal: string | null,
	delivered: string | null,
): LegLine | { void: string } {
	if (refusal) return { status: "missing", reason: refusal };
	let manifest: Manifest;
	try {
		manifest = groupManifest(state.group);
	} catch (error) {
		return { void: error instanceof Error ? error.message : String(error) };
	}
	const bad = verifyFiles(join(state.group.pdir, "in"), state.group.inputs, [...manifest.legInputs[lab], manifest.legSchema]);
	if (bad) return { void: `hash in/${bad}` };
	const session = readSession(join(hand.root, `${hand.agentId}.jsonl`));
	if ("unreadable" in session) return { status: "missing", reason: `audit-unreadable ${session.unreadable}` };
	const breach = auditRecords(session.records, {
		pdir: state.group.pdir,
		allowed: legAllowed(state.group.pdir, manifest, lab),
		repoAccess: manifest.repoAccess,
		root: hand.root,
		agentId: hand.agentId,
		lanes,
		run: state.group.run,
	});
	if (breach) return { status: "excluded", reason: `breach ${breach}` };
	let text: string;
	try {
		text = readNoFollow(join(hand.root, `${hand.agentId}.md`)).toString("utf8");
	} catch {
		return { status: "missing", reason: "no-result-file" };
	}
	const recorded = recordedReply(session.records);
	if (recorded !== null && recorded !== text) return { status: "excluded", reason: "delivered-mismatch its result file is not the reply its session recorded" };
	let bound: Binding = recorded !== null ? "session" : "file";
	// No delivered text (a recovery that saw none, a several-result call whose results carry no
	// `output`, a batched notice with no section for this hand) binds nothing more.
	if (delivered !== null) {
		const form = deliveredForm(delivered, text);
		if (typeof form === "object") return { status: "excluded", reason: form.mismatch };
		if (form === "full" && bound === "file") bound = "delivered";
	}
	const output = parseOutput(text);
	let schema: unknown;
	try {
		schema = JSON.parse(readNoFollow(join(state.group.pdir, "in", manifest.legSchema)).toString("utf8"));
	} catch {
		return { void: `hash in/${manifest.legSchema}` };
	}
	const problem = legShapeProblem(output) ?? schemaProblem(output, schema);
	if (problem) return { status: "missing", reason: `schema ${problem}` };
	// The sha256 of the result file's text, which `bound` says what authenticated.
	return { status: "landed", sha: sha256(text), bound };
}

/** The synthesis hand's audit scope and its result text (null when there is no result file); a breach or an unreadable session is a failure reason. */
export function synthReply(state: PanelState, hand: { root: string; agentId: string }, lanes: string): { text: string | null } | { failed: string } {
	let manifest: Manifest;
	try {
		manifest = groupManifest(state.group);
	} catch (error) {
		return { failed: error instanceof Error ? error.message : String(error) };
	}
	const audit = auditSession(join(hand.root, `${hand.agentId}.jsonl`), {
		pdir: state.group.pdir,
		allowed: synthAllowed(state.group.pdir, manifest, landedLabs(state)),
		repoAccess: manifest.repoAccess,
		root: hand.root,
		agentId: hand.agentId,
		lanes,
		run: state.group.run,
	});
	if (audit && "breach" in audit) return { failed: `breach ${audit.breach}` };
	if (audit) return { failed: `audit-unreadable ${audit.unreadable}` };
	try {
		return { text: readNoFollow(join(hand.root, `${hand.agentId}.md`)).toString("utf8") };
	} catch {
		return { text: null };
	}
}

// ---- timeouts and the recovery pass ------------------------------------------------------------

/**
 * Evaluate every open group of the workload at `now` (ms): a leg with no line past its timeout
 * (from its `hand-spawn:`, else the group's entry) is `missing timeout`; a group whose three labs are
 * terminal and has no `panel-published: <pg> out` is published; a synthesis attempt whose hand
 * settled (its `hand-settled:` routing row) but has no end — its settle was cut off between that
 * transaction and its publication — is finished from its recorded result file, with no model run
 * and no redelivery, as a settle would; one with no end past the default timeout is `failed
 * timeout`. A timeout is decided again inside the transaction that records it, from the ledger as it
 * is then: an attempt that has ended or whose hand has settled since this pass read the ledger (its
 * settle publishes it) is not timed out. Run at every settle, at session start and at `panel-synth:`
 * dispatch. Returns one line per thing it did.
 */
export function sweepPanels(ledger: PanelPort, at: Stamp, now: number = Date.now(), hooks?: PublishHooks): string[] {
	const done: string[] = [];
	const entries = ledger.entries(at.workloadId);
	const settled = settledTokens(entries);
	let rows: Map<string, RoutingRow> | undefined;
	const spawnTime = new Map(
		entries.flatMap(e => {
			const spawn = e.kind === "assumption" ? parseHandSpawn(e.body.trim()) : null;
			return spawn ? [[spawn.token, Date.parse(e.created_at)] as const] : [];
		}),
	);
	for (const state of panelGroups(entries).values()) {
		if (state.void) continue;
		let manifest: Manifest;
		try {
			manifest = groupManifest(state.group);
		} catch (error) {
			done.push(`${state.pg} void (${voidRun(ledger, at, state.pg, error instanceof Error ? error.message : String(error))})`);
			continue;
		}
		if (!state.published.out) {
			for (const lab of LABS) {
				if (state.legs.has(lab)) continue;
				const token = state.group.members[lab];
				const base = (token ? spawnTime.get(token) : undefined) ?? state.at;
				if (now - base <= legTimeoutMin(manifest, lab) * 60_000) continue;
				const known = ledger.write(() => writeLeg(ledger, at, state.pg, lab, { status: "missing", reason: "timeout" }));
				if (!known) done.push(`${state.pg} ${lab} missing timeout`);
			}
			const f = finalizeLegs(ledger, at, state.pg, hooks);
			if (f === "published") done.push(`${state.pg} published out`);
			else if (typeof f === "object") done.push(`${state.pg} void (${f.void})`);
		}
		for (const [token, synth] of state.synths) {
			if (synth.end) continue;
			const routing = settled.get(token);
			const row = routing === undefined ? undefined : (rows ??= new Map(ledger.routings(at.workloadId).map(r => [r.id, r]))).get(routing);
			if (row) {
				const lab = labOf(row.model ?? "");
				const withheld =
					row.outcome !== "ran" ? `withheld ${row.outcome}` : withheldTokens(entries).has(token) ? "withheld changed-work" : !row.agent_id || !lab ? "no-settled-hand" : null;
				// `<pdir>` is `<ledger dir>/lanes/<workload>/panels/<pg>` (`panelDir`): the audit's every-panel root is three up.
				const reply = withheld ? { failed: withheld } : synthReply(state, { root: row.session_root, agentId: row.agent_id! }, dirname(dirname(dirname(state.group.pdir))));
				const end =
					"failed" in reply
						? (ledger.write(() => writeSynthEnd(ledger, at, state.pg, token, { status: "failed", reason: reply.failed })) ?? { status: "failed" as const, reason: reply.failed })
						: finishSynth(ledger, at, state.pg, token, { lab: lab! }, reply.text, hooks);
				done.push(`${state.pg} synthesis ${token} ${"void" in end ? `void (${end.void})` : end.status === "landed" ? "published report" : `failed ${end.reason}`}`);
				continue;
			}
			if (now - synth.at <= manifest.legTimeoutMin.default * 60_000) continue;
			const timedOut = ledger.write(() => {
				const fresh = ledger.entries(at.workloadId);
				const routing = settledTokens(fresh).get(token);
				if (routing !== undefined && ledger.routings(at.workloadId).some(r => r.id === routing)) return false;
				return writeSynthEnd(ledger, at, state.pg, token, { status: "failed", reason: "timeout" }) === null;
			});
			if (timedOut) done.push(`${state.pg} synthesis ${token} failed timeout`);
		}
	}
	return done;
}

// ---- spawn admission (PLAN § 3.4 site table) ---------------------------------------------------

type InstructionView = Pick<InstructionRow, "id" | "author" | "body" | "created_by"> & InstructionInput;

/** The panel groups of `slice`, entry order. */
export function sliceGroups(entries: readonly Entry[], slice: string): PanelState[] {
	return [...panelGroups(entries).values()].filter(s => s.group.slice === slice);
}

/** Why a new `panel:` group of `slice` may not be dispatched (a stop, or the bound reached), or null. */
export function panelDispatchHeld(entries: readonly EntryRow[], instructions: readonly InstructionView[], stakes: Stakes, workloadId: string, slice: string): string | null {
	const stop = reviewStopOn(entries, instructions, workloadId, slice);
	if (stop) return `reviews of ${slice} are stopped by Jo's stop-reviews (instruction ${stop}, review-stop:); no panel starts there`;
	const limit = effectiveRoundLimit(entries, instructions, stakes, slice).total;
	const groups = sliceGroups(entries, slice).length;
	return groups >= limit ? `${slice} already has ${groups} panel groups, its bound (${limit}, the review round limit at ${stakes} stakes; Jo's rounds word raises it)` : null;
}

/** `legHeld`: why panel leg `token` of `pg` may not spawn now, read from the ledger, or null. */
export function legHeld(entries: readonly EntryRow[], instructions: readonly InstructionView[], stakes: Stakes, workloadId: string, pg: string, lab: Lab): string | null {
	const state = panelGroups(entries).get(pg);
	if (!state) return `panel ${pg} has no panel-group entry`;
	if (state.void) return `panel ${pg} is void (${state.void})`;
	const line = state.legs.get(lab);
	if (line) return `panel ${pg}'s ${lab} leg is already ${line.status}${line.status === "missing" ? ` (${line.reason})` : ""}`;
	const stop = reviewStopOn(entries, instructions, workloadId, state.group.slice);
	if (stop) return `reviews of ${state.group.slice} are stopped by Jo's stop-reviews (instruction ${stop}, review-stop:)`;
	const limit = effectiveRoundLimit(entries, instructions, stakes, state.group.slice).total;
	const position = sliceGroups(entries, state.group.slice).findIndex(s => s.pg === pg) + 1;
	return position > limit ? `panel ${pg} is past ${state.group.slice}'s panel bound (${limit})` : null;
}

/** `synthHeld`: why synthesis attempt `token` of `pg` may not be dispatched or spawn now, or null. */
export function synthHeld(entries: readonly EntryRow[], instructions: readonly InstructionView[], workloadId: string, pg: string, token: string | null): string | null {
	const state = panelGroups(entries).get(pg);
	if (!state) return `panel ${pg} has no panel-group entry`;
	if (state.void) return `panel ${pg} is void (${state.void}); run a new panel`;
	if (!state.published.out) return `panel ${pg} has no panel-published out yet: its legs are not all terminal`;
	if (state.published.report) return `panel ${pg}'s report is already published`;
	if (synthFailures(state) >= 2) return `panel ${pg}'s synthesis failed twice`;
	const stop = reviewStopOn(entries, instructions, workloadId, state.group.slice);
	if (stop) return `reviews of ${state.group.slice} are stopped by Jo's stop-reviews (instruction ${stop}, review-stop:)`;
	const mine = token ? state.synths.get(token) : undefined;
	if (mine?.end) return `synthesis ${token} of ${pg} already ${mine.end.status}`;
	const live = [...state.synths].find(([t, s]) => t !== token && s.end === null);
	return live ? `synthesis ${live[0]} of ${pg} is still running` : null;
}
