// Links clickable at display only (PLAN wl-mv66q5b148uznk § Display: links first, clickable). The surface's
// displayed custom messages — `surface-needs-you`, `surface-wake`, `surface-notices` and #112's
// `surface-plan-path` — get a message renderer: each link line (`plan: <path>`, `review: <path>`,
// `review (sl-…, round n): <path>`, `pr: <url>`, #112's `plan for <ref>: <path>`, and the bare plan path
// on the line beneath a plan question's q- id) is drawn as a pi-tui `Text` row whose target is wrapped by
// OMP's own `fileHyperlink(path, path)` / `uriHyperlink(url, url)`: no Markdown lexing, so no path
// character is lost, and the visible text is the target once. OMP's hyperlink policy decides on or off
// (pi-tui terminal-capabilities.ts: on inside HerdR, off with PI_NO_HYPERLINKS=1 or `tui.hyperlinks off`);
// off, the helpers return the text. Every other run renders through OMP's Markdown as OMP's own card
// does (pi-tui chrome/message-frame.ts), inside the same bordered box with the type tag as its head. A
// message with no link line returns undefined, so OMP draws its own card unchanged.
//
// Display only: the message content the model reads (and P-11 row 1 checks) and every ledger body stay
// plain text with no escape byte. pi-tui reaches this row through `tui` (surface/index.ts imports it,
// the loader rule in gates/src/host.ts); without it, or on a host without `registerMessageRenderer`,
// nothing is registered and OMP's default rendering stands.
import type { MessageRenderer, SurfaceAPI, SurfaceTui, TuiComponent, TuiTheme } from "../src/types";
import { PLAN_PATH_TYPE } from "./plan-path";

/** The surface's displayed custom types the link renderer draws. */
export const LINKED_DISPLAY_TYPES = ["surface-needs-you", "surface-wake", "surface-notices", PLAN_PATH_TYPE] as const;

/** One run of a message: Markdown text, or one link line (its visible prefix and the target it links). */
export type DisplayRun = { kind: "text"; text: string } | { kind: "link"; prefix: string; target: string };

/** A labelled link line: `plan:`, `review:`, `review (…):`, `pr:` or `plan for <ref>:`, then the rest of the line. */
const LABELLED = /^(\s*(?:(?:plan|review|pr)(?: \([^)\n]*\))?|plan for [^\s:]+): )(.+)$/;
/** A link target: an absolute path (spaces allowed, to the end of the line) or an http(s) URL with no space. */
const TARGET = /^(?:\/\S(?:.*\S)?|\/|https?:\/\/\S+)$/;
/** The line naming a question whose next line is its bare plan path (errors.ts, render.ts: `… (q-…, slice …):`, `- q-… on sl-…:`). */
const NAMES_QUESTION = /\bq-[a-z0-9]+\b.*:$/;
/** The bare plan path beneath it: indented, absolute, and alone on its line (no ` — answer…` tail). */
const BARE_PATH = /^(\s+)(\/\S(?:.*\S)?)$/;

/** #112's `surface-plan-path` lines escape Markdown specials in the path (plan-path.ts markdownEscape); a Text row shows the path as written. */
const markdownUnescape = (text: string): string => text.replace(/\\([\\`*_[<>~&$])/g, "$1");

/**
 * `content` split into Markdown runs and link lines, in order. `escaped` is a `surface-plan-path`
 * message, whose paths carry Markdown escapes. A labelled line whose rest is not a path or URL
 * (`plan: none — …`, `pr: unverified — …`) stays Markdown.
 */
export function displayRuns(content: string, escaped = false): DisplayRun[] {
	const runs: DisplayRun[] = [];
	let text: string[] = [];
	const flush = () => {
		if (text.length > 0) runs.push({ kind: "text", text: text.join("\n") });
		text = [];
	};
	const lines = content.split("\n");
	lines.forEach((line, i) => {
		const labelled = LABELLED.exec(line);
		const target = labelled ? (escaped ? markdownUnescape(labelled[2]!) : labelled[2]!) : null;
		if (labelled && target !== null && TARGET.test(target)) {
			flush();
			runs.push({ kind: "link", prefix: labelled[1]!, target });
			return;
		}
		const bare = i > 0 && NAMES_QUESTION.test(lines[i - 1]!) ? BARE_PATH.exec(line) : null;
		if (bare && !bare[2]!.includes(" — ")) {
			flush();
			runs.push({ kind: "link", prefix: bare[1]!, target: bare[2]! });
			return;
		}
		text.push(line);
	});
	flush();
	return runs;
}

/** The renderer OMP calls for a surface message: OMP's card (box, tag, Markdown) with each link line as a hyperlinked Text row. */
export function linkRenderer(tui: SurfaceTui): MessageRenderer {
	return (message, _options, theme: TuiTheme) => {
		const content = typeof message.content === "string" ? message.content : message.content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
		const runs = displayRuns(content, message.customType === PLAN_PATH_TYPE);
		if (!runs.some((r) => r.kind === "link")) return undefined;
		const box = new tui.Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.setIgnoreTight?.(true);
		box.setBorder({ chars: theme.boxRound, color: (t) => theme.fg("borderMuted", t) });
		box.addChild(new tui.Text(theme.fg("customMessageLabel", theme.bold(message.customType)), 0, 0));
		box.addChild(new tui.Spacer(1));
		const color = (t: string) => theme.fg("customMessageText", t);
		for (const run of runs) {
			let row: TuiComponent;
			if (run.kind === "text") row = new tui.Markdown(run.text, 0, 0, tui.getMarkdownTheme(), { color });
			else {
				const link = run.target.startsWith("/") ? tui.fileHyperlink(run.target, run.target) : tui.uriHyperlink(run.target, run.target);
				row = new tui.Text(color(run.prefix) + color(link), 0, 0);
			}
			box.addChild(row);
		}
		return box;
	};
}

/**
 * Register the link renderer for every displayed surface type, when the host can take one and pi-tui was
 * handed over. A loader (the entry's lazy import) is started here; until it resolves the renderer returns
 * undefined (OMP's own card), and a failed load leaves it so, with one stderr line.
 */
export default function displayRow(pi: SurfaceAPI, tui: SurfaceTui | (() => Promise<SurfaceTui>) | undefined): void {
	if (!tui || !pi.registerMessageRenderer) return;
	let draw: MessageRenderer | null = null;
	if (typeof tui === "function") {
		tui().then(
			(modules) => {
				draw = linkRenderer(modules);
			},
			(err: unknown) => process.stderr.write(`surface: pi-tui could not be loaded, so links show as plain text: ${String(err)}\n`),
		);
	} else draw = linkRenderer(tui);
	const renderer: MessageRenderer = (message, options, theme) => draw?.(message, options, theme);
	for (const customType of LINKED_DISPLAY_TYPES) pi.registerMessageRenderer(customType, renderer);
}
