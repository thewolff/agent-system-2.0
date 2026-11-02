// The jo-issues helpers (TRAIN_ALERT_REPO, label TRAIN_ALERT_LABEL) the merge train's tick (surface/scripts/train-tick.ts: its
// alerts D9 and notices D6, D7) and the move alert (surface/src/quota-move-alert.ts, PLAN wl-mvwk0v0gmp6cjc D4) share: a gh
// call that must succeed, the marker lookup over every as2-train issue, a labelled call that adopts an effect whose reply was
// lost, and a notice's lookup-or-create. Each takes the gh function its caller was given, so a test runs it on a fake.
import { TRAIN_ALERT_LABEL, TRAIN_ALERT_REPO } from "./merge-train";

/** One gh process: its exit code and output. */
export interface GhResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** One gh call. */
export type Gh = (args: string[]) => GhResult;

/** A gh call that failed or answered something unreadable; its message names the call and gh's last line. */
export class GhError extends Error {}

/**
 * Every issue the train filed, any state, read whole to find a marker: the REST issue listing (`GET /repos/{o}/{r}/issues`, the
 * as2-train label) through its last page (`--paginate --slurp`, an array of pages), not the search index, so an issue created a
 * moment ago is in it and none is beyond a bound.
 */
export const ISSUE_LIST_ARGS = [
	"api", `repos/${TRAIN_ALERT_REPO}/issues`, "--method", "GET", "--paginate", "--slurp", "-f", `labels=${TRAIN_ALERT_LABEL}`, "-f", "state=all", "-f", "per_page=100",
];

/** `json[key]` when `json` is an object, else undefined: gh's JSON is read one field at a time, each checked where it is used. */
export function field(json: unknown, key: string): unknown {
	return typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined;
}

/** A gh call that must succeed and print JSON: its parsed stdout, else a GhError naming the call. */
export function ghJsonOf(gh: Gh): (args: string[]) => unknown {
	return (args) => {
		const r = gh(args);
		if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 3).join(" ")} exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? ""}`);
		try {
			return JSON.parse(r.stdout);
		} catch {
			throw new GhError(`gh ${args.slice(0, 3).join(" ")} did not return json`);
		}
	};
}

/** The jo-issues helpers the alerts (D9) and the notices (D6, D7) share. */
export interface IssueOps {
	/** A gh call that must succeed; its stdout. */
	run: (args: string[]) => string;
	/**
	 * The url of the issue the train filed whose body carries `marker`, any state; null only when the whole listing has none. A
	 * failed or unreadable listing throws: the caller writes nothing durable and the next pass looks again.
	 */
	marked: (marker: string) => string | null;
	/**
	 * A gh call that adds labels; its stdout. A failure is retried once, and only when gh says one of `labels` is missing
	 * (`'<label>' not found`), after each label is created (one that exists already fails harmlessly). `took`, when given, is
	 * asked after every failure whether the call took effect anyway (an issue create whose reply was lost): its answer is
	 * returned and nothing is retried.
	 */
	labelled: (args: string[], labels: readonly string[], took?: () => string | null) => string;
}

export function issueOps(gh: Gh, ghJson: (args: string[]) => unknown): IssueOps {
	const failed = (args: string[], r: GhResult) =>
		new GhError(`gh ${args.slice(0, 3).join(" ")} exited ${r.code}: ${(r.stderr.trim() || r.stdout.trim()).split("\n").at(-1) ?? ""}`);
	return {
		run: (args) => {
			const r = gh(args);
			if (r.code !== 0) throw failed(args, r);
			return r.stdout;
		},
		marked: (marker) => {
			const pages = ghJson(ISSUE_LIST_ARGS);
			if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new GhError(`gh api repos/${TRAIN_ALERT_REPO}/issues returned an unexpected shape`);
			for (const i of pages.flat() as unknown[]) {
				if (typeof i !== "object" || i === null) throw new GhError(`gh api repos/${TRAIN_ALERT_REPO}/issues returned an unexpected shape`);
				const body = field(i, "body");
				if (typeof body !== "string" || !body.includes(marker)) continue;
				const url = field(i, "html_url");
				if (typeof url !== "string" || url === "") throw new GhError(`gh api repos/${TRAIN_ALERT_REPO}/issues: the issue carrying ${marker} has no html_url`);
				return url;
			}
			return null;
		},
		labelled: (args, labels, took) => {
			let r = gh(args);
			for (let retried = false; r.code !== 0; retried = true) {
				const done = took?.() ?? null;
				if (done !== null) return done;
				const text = `${r.stderr}\n${r.stdout}`;
				if (retried || !labels.some((l) => text.includes(`'${l}' not found`))) throw failed(args, r);
				for (const l of labels) gh(["label", "create", l, "-R", TRAIN_ALERT_REPO, "--description", "filed by the as2 merge train"]);
				r = gh(args);
			}
			return r.stdout;
		},
	};
}

/** The issue number of a jo-issues url. */
export function issueNumber(url: string): string {
	const m = /\/issues\/(\d+)$/.exec(url);
	if (!m) throw new GhError(`${url} is not an issue url`);
	return m[1]!;
}

/** A notice's jo-issues issue (D6, D7): the one carrying `marker` in any state, else one created with the as2-train label; its url. */
export function fileNotice(ops: IssueOps, marker: string, title: string, body: string): string {
	const found = ops.marked(marker);
	if (found !== null) return found;
	const args = ["issue", "create", "-R", TRAIN_ALERT_REPO, "--label", TRAIN_ALERT_LABEL, "--title", title, "--body", `${marker}\n${body}`];
	const url = ops.labelled(args, [TRAIN_ALERT_LABEL], () => ops.marked(marker)).trim().split("\n").filter(Boolean).at(-1) ?? "";
	issueNumber(url);
	return url;
}
