// The projection's render (PLAN wl-mv66ylim0gahog § 2): pure, from a workload row, its slice
// counts, its open questions and its PR set to the issue's title, machine block, labels and state.
// Labels and state come from the ledger and the PR set only. State follows Jo's § 8 Q2 with first
// merge wins: open while the workload is open, or while it is closed with no PR in the set merged
// and one still open; closed otherwise. Jo's text outside the as2 markers is never touched.
import { createHash } from "node:crypto";

export const BLOCK_BEGIN = "<!-- as2:begin -->";
export const BLOCK_END = "<!-- as2:end -->";
const TITLE_BRIEF_MAX = 80;

/** Every label the projection sets (§ 3 Labels); `intake` is the intake row's and the binding removes it. */
export const LABEL = { as2: "as2", running: "running", waiting: "waiting", question: "question", awaitingMerge: "awaiting-merge", unmerged: "unmerged", intake: "intake" } as const;
export const PROJECTION_LABELS: readonly string[] = Object.values(LABEL);

export type PrState = "OPEN" | "MERGED" | "CLOSED";
/** One PR of the set (surface/src/issues/prs.ts) as the render reads it. */
export interface PrFact {
	number: number;
	url: string;
	state: PrState;
	base: string;
}

export interface RenderInput {
	workload: { id: string; brief: string; stakes: string; mode: string; status: "open" | "closed"; holder: string | null };
	/** One line: the ceiling in force and what was spent against it. */
	ceiling: string;
	slices: { open: number; paused: number; done: number; cancelled: number };
	questions: readonly { id: string; body: string }[];
	/** The known PR set (an unknown set renders nothing: the caller skips the link). */
	prs: readonly PrFact[];
	/** The newest provenance seq ingested for the workload. */
	lastSeq: number;
}

export type CloseReason = "completed" | "not planned";
export interface Rendered {
	title: string;
	block: string;
	/** Sorted. */
	labels: string[];
	state: "open" | "closed";
	/** Null exactly when open. */
	reason: CloseReason | null;
}

const firstLine = (s: string): string => s.trim().split("\n")[0]!.trim();

/** `wl-<id> — <first line of brief, 80 chars>`: the prefix the lost-create search matches is `<id> —`. */
export function issueTitle(id: string, brief: string): string {
	const line = firstLine(brief);
	return `${id} — ${line.length > TITLE_BRIEF_MAX ? `${line.slice(0, TITLE_BRIEF_MAX - 1)}…` : line}`;
}

/** The issue's state and close reason from the workload status, the PR set and the slice counts (first merge wins). */
export function issueState(status: "open" | "closed", prs: readonly PrFact[], slices: RenderInput["slices"]): { state: "open" | "closed"; reason: CloseReason | null } {
	if (status === "open") return { state: "open", reason: null };
	if (prs.some((p) => p.state === "MERGED")) return { state: "closed", reason: "completed" };
	if (prs.some((p) => p.state === "OPEN")) return { state: "open", reason: null };
	if (prs.length > 0) return { state: "closed", reason: "not planned" };
	// No PR at all: "not planned" only when slices were cut, every one cancelled and none done.
	const cut = slices.open + slices.paused + slices.done + slices.cancelled;
	return { state: "closed", reason: cut > 0 && slices.cancelled === cut ? "not planned" : "completed" };
}

export function render(i: RenderInput): Rendered {
	const w = i.workload;
	const { state, reason } = issueState(w.status, i.prs, i.slices);
	const labels: string[] = [LABEL.as2];
	if (w.status === "open") labels.push(w.holder ? LABEL.running : LABEL.waiting);
	if (i.questions.length > 0) labels.push(LABEL.question);
	if (w.status === "closed" && state === "open") labels.push(LABEL.awaitingMerge);
	if (w.status === "closed" && i.prs.length > 0 && i.prs.every((p) => p.state === "CLOSED")) labels.push(LABEL.unmerged);
	const s = i.slices;
	const lines = [
		BLOCK_BEGIN,
		`**${w.id}** · ${w.status} · stakes ${w.stakes} · mode ${w.mode}`,
		`holder: ${w.holder ?? "nobody — waiting"}`,
		`ceiling: ${i.ceiling}`,
		`slices: ${s.open} open · ${s.paused} paused · ${s.done} done · ${s.cancelled} cancelled`,
		...(i.questions.length === 0 ? ["open questions: none"] : ["open questions:", ...i.questions.map((q) => `- ${q.id}: ${firstLine(q.body)}`)]),
		...(i.prs.length === 0 ? ["PRs: none"] : ["PRs:", ...[...i.prs].sort((a, b) => a.number - b.number).map((p) => `- ${p.url} ${p.state.toLowerCase()}`)]),
		`ledger seq: ${i.lastSeq}`,
		BLOCK_END,
	];
	return { title: issueTitle(w.id, w.brief), block: lines.join("\n"), labels: labels.sort(), state, reason };
}

/** The pushed-state column's value: `open`, `closed completed`, `closed not planned`. */
export function stateText(r: Pick<Rendered, "state" | "reason">): string {
	return r.state === "open" ? "open" : `closed ${r.reason}`;
}

/** The hash a link compares against `pushed_hash`: a change in any rendered field re-pushes. */
export function renderHash(r: Rendered): string {
	return createHash("sha256").update(JSON.stringify([r.title, r.block, r.labels, r.state, r.reason])).digest("hex");
}

/**
 * The span of the body's machine block, `<!-- as2:begin -->` through `<!-- as2:end -->`, or null
 * when it has no complete block. Markers are found anywhere on a line: Linear indents the end
 * marker (a list's lazy continuation), and the indent falls inside the span.
 */
function blockSpan(body: string): { begin: number; end: number } | null {
	const begin = body.indexOf(BLOCK_BEGIN);
	const end = begin < 0 ? -1 : body.indexOf(BLOCK_END, begin);
	return begin < 0 || end < 0 ? null : { begin, end: end + BLOCK_END.length };
}

/** The body's machine block, markers included, as the tracker holds it; null when it has no complete block. */
export function machineBlock(body: string): string | null {
	const span = blockSpan(body);
	return span === null ? null : body.slice(span.begin, span.end);
}

/**
 * sha256 of the body's machine block (`machineBlock`), or null when it has none: a link's
 * `remote_hash`, the block as Linear returned it after the push that wrote it (Linear normalises
 * Markdown, so it is not the render's bytes).
 */
export function blockHash(body: string): string | null {
	const block = machineBlock(body);
	return block === null ? null : createHash("sha256").update(block).digest("hex");
}

/**
 * The issue body with `block` in place of the remote's machine block and every byte outside the
 * markers kept. A remote body with no complete block (Jo deleted a marker) gets the block on top and
 * its whole text below it.
 */
export function mergeBody(remote: string, block: string): string {
	const span = blockSpan(remote);
	if (span !== null) return remote.slice(0, span.begin) + block + remote.slice(span.end);
	return remote.trim() === "" ? block : `${block}\n\n${remote}`;
}
