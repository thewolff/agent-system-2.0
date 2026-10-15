// Backfill of authored pending descriptions (PLAN wl-mv7gidggnlkem8 § Backfill and deployment): the
// orchestrator's `orchestrator_describe_pending` tool, which fills missing work names and asks from a
// reviewed manifest file, and the coverage reader it shares with the read-only CLI
// (surface/scripts/pending-descriptions.ts).
//
// The tool takes a path and the SHA-256 of the file's bytes, never the values themselves: what is
// applied is exactly the file a cross-lab review read, and editing one byte needs a new reviewed
// digest. The values go through the core's missing-only import (surface/src/pending-details.ts
// importPendingDescriptions): every submitted live target is checked first and one transaction writes
// them all or nothing; existing metadata is never replaced, closed or gone targets are skipped, and a
// live target whose source changed since the manifest refuses the whole set.
//
// Coverage is what pending itself reports missing, read from the renderer's own items
// (surface/src/pending.ts pendingItems, each row's `missing` gaps), never from a second copy of its
// rules: a machine question whose fixed phrase map covers every option it offers is asked by that
// phrase and has no ask gap; one offering any other option, or a lookalike with no source entry, has
// one. Every open nonstanding workload needs a name, shown on a row or not. An open orchestrator
// question about a workload closed since it was asked still shows that workload's name, but the import
// fills open workloads only: such a gap is `unfillable` and clears when the question is answered or
// withdrawn. The standing workload's name is fixed. Reserved requests and prompt waits are named by
// their workload, so its name covers them.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Ledger } from "../../ledger/src/index";
import { waitingReserved } from "../src/errors";
import { controlEntries, doneLine, holdersOf } from "../src/launch";
import { questionSubject } from "../src/orchestrator-question";
import { type PendingItem, pendingItems } from "../src/pending";
import { askProblem, importPendingDescriptions, nameProblem, type PendingImport, questionDetails, questionSourceHash, workName, workSourceHash } from "../src/pending-details";
import { surfaceSession } from "../src/session";
import { openPromptWaits } from "../src/signals";
import { DESCRIBE_PENDING_TOOL, STANDING_WORKLOAD_ID, SURFACE_BY, type SurfaceAPI, type ToolResult } from "../src/types";

// ---- the reviewed manifest ----------------------------------------------------------------------

/** A manifest file larger than this is refused unread. */
export const MANIFEST_MAX_BYTES = 1024 * 1024;
/** At most this many entries in each of the manifest's two arrays. */
export const MANIFEST_MAX_ENTRIES = 1000;

/** The manifest's values, exactly the core import's input less its `by`. */
export type PendingManifest = Omit<PendingImport, "by">;

const SHA256 = /^[0-9a-f]{64}$/;
const WORKLOAD_KEYS = ["id", "sourceHash", "name"];
const QUESTION_KEYS = ["id", "sourceHash", "ask", "name"];

/** Shape and value problems of a parsed manifest: exact keys, string values, bounded arrays, valid names/asks, hex hashes, no id twice. */
function manifestProblems(v: unknown): string[] {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return ["the manifest is one JSON object {\"workloads\": [...], \"questions\": [...]}"];
	const top = v as { workloads?: unknown; questions?: unknown };
	const extra = Object.keys(v).filter((k) => k !== "workloads" && k !== "questions");
	if (extra.length > 0) return [`the manifest has keys other than workloads and questions: ${extra.join(", ")}`];
	if (!Array.isArray(top.workloads) || !Array.isArray(top.questions)) return ["workloads and questions are both arrays"];
	const workloads: unknown[] = top.workloads;
	const questions: unknown[] = top.questions;
	const problems: string[] = [];
	for (const [what, list] of [["workloads", workloads], ["questions", questions]] as const) {
		if (list.length > MANIFEST_MAX_ENTRIES) problems.push(`${what} has ${list.length} entries, more than ${MANIFEST_MAX_ENTRIES}`);
	}
	if (problems.length > 0) return problems;
	const seen = new Set<string>();
	const entry = (raw: unknown, n: number, what: string, keys: readonly string[], required: readonly string[]): Record<string, unknown> | null => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			problems.push(`${what}[${n}] is not an object`);
			return null;
		}
		const e = raw as Record<string, unknown>;
		const at = typeof e.id === "string" && e.id !== "" ? e.id : `${what}[${n}]`;
		if (e.id === "") problems.push(`${at} has an empty id`);
		const unknown = Object.keys(e).filter((k) => !keys.includes(k));
		if (unknown.length > 0) problems.push(`${at}: unknown keys ${unknown.join(", ")}`);
		for (const k of required) if (typeof e[k] !== "string") problems.push(`${at}: ${k} is a string`);
		if (!required.includes("name") && e.name !== undefined && typeof e.name !== "string") problems.push(`${at}: name is a string`);
		if (typeof e.id === "string") {
			if (seen.has(e.id)) problems.push(`${e.id} is listed twice`);
			seen.add(e.id);
		}
		if (typeof e.sourceHash === "string" && !SHA256.test(e.sourceHash)) problems.push(`${at}: sourceHash is not a lowercase SHA-256 hex digest`);
		return e;
	};
	workloads.forEach((w, n) => {
		const e = entry(w, n, "workloads", WORKLOAD_KEYS, WORKLOAD_KEYS);
		if (e && typeof e.name === "string") {
			const p = nameProblem(e.name);
			if (p !== null) problems.push(`${String(e.id)}: ${p}`);
		}
		if (e && e.id === STANDING_WORKLOAD_ID) problems.push(`${STANDING_WORKLOAD_ID} has a fixed name and takes none`);
	});
	questions.forEach((q, n) => {
		const e = entry(q, n, "questions", QUESTION_KEYS, ["id", "sourceHash", "ask"]);
		if (!e) return;
		const p = (typeof e.ask === "string" ? askProblem(e.ask) : null) ?? (typeof e.name === "string" ? nameProblem(e.name) : null);
		if (p !== null) problems.push(`${String(e.id)}: ${p}`);
	});
	return problems;
}

/**
 * The reviewed manifest at `path`, read once as bytes: refused unless the path is absolute, the file is
 * at most MANIFEST_MAX_BYTES, the SHA-256 of those exact bytes is `sha256`, they are valid UTF-8 JSON,
 * and the JSON has exactly the manifest's shape with valid values. Reads only.
 */
export function readReviewedManifest(path: string, sha256: string): { manifest: PendingManifest; sha256: string } | { refused: string } {
	const want = sha256.trim().toLowerCase();
	if (!isAbsolute(path)) return { refused: `manifestPath must be absolute; ${JSON.stringify(path)} is not` };
	if (!SHA256.test(want)) return { refused: "sha256 must be the 64-hex-digit SHA-256 of the manifest file (`shasum -a 256 <file>`)" };
	let bytes: Buffer;
	try {
		const st = statSync(path);
		if (!st.isFile()) return { refused: `${path} is not a file` };
		if (st.size > MANIFEST_MAX_BYTES) return { refused: `${path} is ${st.size} bytes, more than ${MANIFEST_MAX_BYTES}` };
		bytes = readFileSync(path);
	} catch (e) {
		return { refused: `${path} could not be read (${e instanceof Error ? e.message : String(e)})` };
	}
	if (bytes.length > MANIFEST_MAX_BYTES) return { refused: `${path} is ${bytes.length} bytes, more than ${MANIFEST_MAX_BYTES}` };
	const got = createHash("sha256").update(bytes).digest("hex");
	if (got !== want) return { refused: `${path} has SHA-256 ${got}, not the reviewed ${want}: its bytes are not the reviewed manifest` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (e) {
		return { refused: `${path} is not UTF-8 JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	const problems = manifestProblems(parsed);
	if (problems.length > 0) return { refused: `${path}: ${problems.join("; ")}` };
	const m = parsed as { workloads: Record<string, string>[]; questions: Record<string, string>[] };
	return {
		sha256: got,
		manifest: {
			workloads: m.workloads.map((w) => ({ id: w.id!, sourceHash: w.sourceHash!, name: w.name! })),
			questions: m.questions.map((q) => (q.name === undefined ? { id: q.id!, sourceHash: q.sourceHash!, ask: q.ask! } : { id: q.id!, sourceHash: q.sourceHash!, ask: q.ask!, name: q.name })),
		},
	};
}

// ---- coverage -----------------------------------------------------------------------------------

export interface WorkTarget {
	id: string;
	status: string;
	sourceHash: string;
	brief: string;
	/** The newest `done:` line, or null. */
	done: string | null;
	/** The stored name, or null. */
	name: string | null;
	needsName: boolean;
	/** The pending rows that show this workload's name: `en-…` reserved requests, `q-…` questions, `wait <lane> <tool>` prompt waits. */
	shownBy: string[];
}

export interface QuestionTarget {
	id: string;
	workloadId: string;
	sliceId: string;
	createdBy: string;
	body: string;
	options: string[];
	/** A standing question's `question-about:` subject, else null. */
	subject: string | null;
	/** The workload whose name the row shows, or null for an unbound orchestrator question. */
	boundWorkload: string | null;
	/** The ask pending shows now (surface/src/pending.ts): the authored ask, or a machine question's fixed phrase for the options it offers; null is a gap. */
	shownAsk: string | null;
	sourceHash: string;
	ask: string | null;
	name: string | null;
	needsAsk: boolean;
	needsName: boolean;
}

export interface PendingCoverage {
	workloads: WorkTarget[];
	questions: QuestionTarget[];
	reserved: { id: string; workloadId: string; body: string; created_at: string }[];
	waits: { workloadId: string; lane: string; toolName: string; reason: string; created_at: string }[];
	/** Every open target pending still needs an authored name or ask for, workloads before their questions, in in-flight order: what a manifest fills. */
	missing: string[];
	/** Closed workloads still named by an open orchestrator question and lacking a name: no import fills them; answering or withdrawing the question clears them. */
	unfillable: string[];
}

function controlOf(ledger: Ledger, workloadId: string, holder: string | null) {
	const entries = ledger.entries(workloadId);
	return controlEntries(entries, holdersOf(entries, holder, ledger.holders(workloadId)));
}

/**
 * What pending shows and which of it still needs an authored name or ask. A question's gaps are the
 * ones pending's own rows report (`pendingItems`, each row's `missing`), so coverage cannot disagree
 * with what Jo sees; workloads, reserved requests and prompt waits come from the readers pending uses
 * (`inFlight`, `waitingReserved`, `openPromptWaits`, `questionSubject`). Reads only; a read-only
 * ledger serves.
 */
export function pendingCoverage(ledger: Ledger): PendingCoverage {
	const works = new Map<string, WorkTarget>();
	const questions: QuestionTarget[] = [];
	const reserved: PendingCoverage["reserved"] = [];
	const waits: PendingCoverage["waits"] = [];
	const missing: string[] = [];
	const unfillable: string[] = [];
	const work = (id: string, by: string | null): WorkTarget | null => {
		if (id === STANDING_WORKLOAD_ID) return null;
		let t = works.get(id);
		if (!t) {
			const w = ledger.workload(id);
			if (!w) return null;
			const name = workName(ledger, id);
			t = { id, status: w.status, sourceHash: workSourceHash(w), brief: w.brief, done: doneLine(controlOf(ledger, id, w.holder)), name: name?.name ?? null, needsName: name === null, shownBy: [] };
			works.set(id, t);
			if (t.needsName) (w.status === "open" ? missing : unfillable).push(id);
		}
		if (by !== null) t.shownBy.push(by);
		return t;
	};
	const asked = new Map<string, PendingItem[]>();
	for (const item of pendingItems(ledger)) {
		if (item.kind !== "question") continue;
		const list = asked.get(item.workloadId);
		if (list) list.push(item);
		else asked.set(item.workloadId, [item]);
	}
	for (const { workload } of ledger.inFlight()) {
		const wl = workload.id;
		work(wl, null);
		for (const r of waitingReserved(ledger, wl)) {
			reserved.push({ id: r.id, workloadId: wl, body: r.body, created_at: r.created_at });
			work(wl, r.id);
		}
		for (const item of asked.get(wl) ?? []) {
			const q = ledger.question(item.id);
			if (!q) continue;
			const subject = questionSubject(ledger, q.id);
			const bound = wl === STANDING_WORKLOAD_ID ? subject : wl;
			if (bound !== null) work(bound, q.id);
			const details = questionDetails(ledger, q.id);
			const gaps = item.missing.filter((g) => g.id === q.id).map((g) => g.field);
			const t: QuestionTarget = {
				id: q.id, workloadId: wl, sliceId: q.slice_id, createdBy: q.created_by, body: q.body, options: [...item.options], subject, boundWorkload: bound,
				shownAsk: item.ask, sourceHash: questionSourceHash(q, subject), ask: details?.ask ?? null, name: details?.name ?? null,
				needsAsk: gaps.includes("ask"), needsName: gaps.includes("name"),
			};
			questions.push(t);
			if (t.needsAsk || t.needsName) missing.push(q.id);
		}
		for (const w of openPromptWaits(ledger, wl)) {
			waits.push({ workloadId: wl, lane: w.lane, toolName: w.toolName, reason: w.reason, created_at: w.created_at });
			work(wl, `wait ${w.lane} ${w.toolName}`);
		}
	}
	return { workloads: [...works.values()], questions, reserved, waits, missing, unfillable };
}

/** The manifest skeleton for exactly the current gaps: values empty for the author to fill, `name` only on an unbound question. */
export function exportSkeleton(c: PendingCoverage): { workloads: { id: string; sourceHash: string; name: string }[]; questions: { id: string; sourceHash: string; ask: string; name?: string }[] } {
	return {
		workloads: c.workloads.filter((w) => w.needsName && w.status === "open").map((w) => ({ id: w.id, sourceHash: w.sourceHash, name: "" })),
		questions: c.questions.filter((q) => q.needsAsk || q.needsName).map((q) => (q.boundWorkload === null ? { id: q.id, sourceHash: q.sourceHash, ask: "", name: "" } : { id: q.id, sourceHash: q.sourceHash, ask: "" })),
	};
}

export interface ManifestCheck {
	sha256: string;
	/** Live targets whose stored value is the reviewed value. */
	equal: string[];
	/** Live targets whose stored value differs from the reviewed one (never relabelled by an import). */
	differ: { id: string; reviewed: { name?: string; ask?: string }; stored: { name?: string; ask?: string } }[];
	/** Live targets at the reviewed source hash with nothing stored yet. */
	unapplied: string[];
	/** Live targets whose source changed since the manifest: a new reviewed entry is needed. */
	stale: string[];
	/** Targets closed, resolved or gone: nothing to do. */
	closed: string[];
	/** Current gaps the manifest does not list: the delta to author and review next. */
	unsubmitted: string[];
}

/** The reviewed manifest against the ledger now: value equality per entry, and the gaps it does not cover. Reads only. */
export function checkManifest(ledger: Ledger, manifest: PendingManifest, sha256: string, coverage: PendingCoverage): ManifestCheck {
	const out: ManifestCheck = { sha256, equal: [], differ: [], unapplied: [], stale: [], closed: [], unsubmitted: [] };
	for (const m of manifest.workloads) {
		const w = ledger.workload(m.id);
		if (!w || w.status !== "open") {
			out.closed.push(m.id);
			continue;
		}
		if (workSourceHash(w) !== m.sourceHash) {
			out.stale.push(m.id);
			continue;
		}
		const stored = workName(ledger, m.id);
		if (stored === null) out.unapplied.push(m.id);
		else if (stored.name === m.name) out.equal.push(m.id);
		else out.differ.push({ id: m.id, reviewed: { name: m.name }, stored: { name: stored.name } });
	}
	for (const m of manifest.questions) {
		const q = ledger.question(m.id);
		if (!q || q.state !== "open") {
			out.closed.push(m.id);
			continue;
		}
		if (questionSourceHash(q, questionSubject(ledger, q.id)) !== m.sourceHash) {
			out.stale.push(m.id);
			continue;
		}
		const stored = questionDetails(ledger, m.id);
		const pick = (v: { ask: string; name?: string }) => (v.name === undefined ? { ask: v.ask } : { ask: v.ask, name: v.name });
		if (stored === null) out.unapplied.push(m.id);
		else if (stored.ask === m.ask && stored.name === m.name) out.equal.push(m.id);
		else out.differ.push({ id: m.id, reviewed: pick(m), stored: pick(stored) });
	}
	const listed = new Set([...manifest.workloads.map((w) => w.id), ...manifest.questions.map((q) => q.id)]);
	out.unsubmitted = coverage.missing.filter((id) => !listed.has(id));
	return out;
}

// ---- the tool -----------------------------------------------------------------------------------

const text = (t: string, details?: unknown): ToolResult => ({ content: [{ type: "text", text: t }], details });
const inactive = text("This session is not the orchestrator surface; nothing was written.");
const ids = (xs: readonly string[]): string => (xs.length === 0 ? "none" : xs.join(", "));

export default function pendingDescriptionsRow(pi: SurfaceAPI, env: Record<string, string | undefined> = process.env): void {
	const z = pi.zod;
	pi.registerTool({
		name: DESCRIBE_PENDING_TOOL,
		loadMode: "essential",
		label: "Describe Pending",
		description:
			"Fill missing work names and asks on pending rows from a reviewed manifest file: pass its absolute path and the SHA-256 of its exact bytes, never the values. " +
			"Missing-only: existing names and asks are never replaced, closed targets are skipped, and a live target whose source changed since the manifest refuses the whole file, writing nothing. " +
			"Reports what was filled, what was skipped, and what pending still needs described (the next manifest's delta).",
		parameters: z.object({
			manifestPath: z.string().describe("Absolute path of the reviewed manifest JSON file {workloads:[{id,sourceHash,name}],questions:[{id,sourceHash,ask,name?}]}."),
			sha256: z.string().describe("The reviewed SHA-256 of the manifest file's bytes (`shasum -a 256 <file>`); any other bytes are refused."),
		}),
		approval: "write",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const s = surfaceSession(ctx, env);
			if (!s.active) return inactive;
			const owed = s.check(DESCRIBE_PENDING_TOOL);
			if (owed) return text(`${owed.reason} Nothing was written.`);
			const read = readReviewedManifest(String(params.manifestPath ?? "").trim(), String(params.sha256 ?? ""));
			if ("refused" in read) return text(`Refused: ${read.refused}. Nothing was written.`);
			const ledger = s.ledger();
			let result: { filled: string[]; skipped: string[] };
			try {
				result = importPendingDescriptions(ledger, { by: SURFACE_BY, ...read.manifest });
			} catch (e) {
				return text(e instanceof Error ? e.message : String(e));
			}
			const { missing, unfillable } = pendingCoverage(ledger);
			pi.appendEntry("surface-describe-pending", { sha256: read.sha256, filled: result.filled, skipped: result.skipped, missing, unfillable });
			return text(
				`Applied reviewed manifest ${read.sha256}: filled ${result.filled.length} (${ids(result.filled)}); skipped ${result.skipped.length} as closed, gone or already described, never relabelled (${ids(result.skipped)}). ` +
					(missing.length === 0
						? "Pending needs no more descriptions a manifest can fill."
						: `Pending still needs ${missing.length} described, not in this manifest (${ids(missing)}): export them, author and review a new manifest.`) +
					(unfillable.length === 0 ? "" : ` ${unfillable.length} closed workload(s) still named by an open question have no name and take no import (${ids(unfillable)}): answer or withdraw those questions.`),
				{ sha256: read.sha256, filled: result.filled, skipped: result.skipped, missing, unfillable },
			);
		},
	});
}
