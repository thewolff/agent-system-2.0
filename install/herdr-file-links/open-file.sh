#!/bin/sh
# Herdr supplies the clicked URL in HERDR_PLUGIN_CLICKED_URL (plugins reference, Link handlers).
# Decode in Bun, already required by as2, so no URL bytes ever become shell source or undergo
# command substitution. Keep the decoded path in argv, including spaces and literal newlines.
exec bun -e '
import { closeSync, existsSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const refuse = (message) => { console.error(`file-links: ${message}`); process.exit(1); };
const clicked = process.env.HERDR_PLUGIN_CLICKED_URL ?? "";
if (!clicked.startsWith("file://")) refuse("expected a file:// URL");
let path;
try {
	// Validate percent escapes before the permissive decoder and parent fallback.
	decodeURIComponent(clicked);
	// fileURLToPath decodes escaped spaces, #, ?, %, Unicode, and parentheses exactly once.
	// https://nodejs.org/api/url.html#urlfileurltopathurl-options
	path = fileURLToPath(clicked);
	if (path.includes("\0")) refuse("invalid file URL");
} catch {
	refuse("invalid local file URL");
}
// Never dispatch a file to its default handler. Only non-executable, non-symlinked text
// documents may use -t (the default text editor). Everything else navigable is reveal-only:
// -R shows its Finder entry without opening it, including unknown package types and scripts.
// App/bundle paths and descendants are refused entirely, including missing-file parents.
const bundleName = /\.(app|bundle|framework|plugin|kext|appex|xpc|prefpane|qlgenerator|mdimporter|saver|workflow|scptd|service|action|wdgt|osax)$/i;
function inspectAncestors(target) {
	let symlink = false;
	for (let part = target; ; part = dirname(part)) {
		if (bundleName.test(basename(part))) refuse("app or bundle paths are not opened");
		const info = lstatSync(part);
		symlink ||= info.isSymbolicLink();
		if (info.isDirectory() && (
			existsSync(join(part, "Contents", "Info.plist")) ||
			existsSync(join(part, "Contents", "MacOS"))
		)) refuse("app or bundle paths are not opened");
		if (dirname(part) === part) break;
	}
	return symlink;
}

let target = path;
let info;
try {
	info = lstatSync(target);
} catch (error) {
	if (error.code !== "ENOENT") refuse("could not inspect the file");
	target = dirname(path);
	try {
		info = lstatSync(target);
		// A directory symlink is checked canonically below, and will only ever be revealed.
		if (!lstatSync(realpathSync(target)).isDirectory()) throw new Error();
	} catch {
		refuse("neither the file nor its parent directory exists");
	}
}
let symlink;
try {
	// Check both spellings: aliases cannot hide a bundle, and bundle-named aliases cannot
	// escape the policy by pointing to an ordinary directory. Do not short-circuit either scan.
	symlink = inspectAncestors(target);
	inspectAncestors(realpathSync(target));
} catch {
	refuse("could not safely resolve the file");
}
if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) refuse("unsupported file type");

const textExtensions = new Set([
	".md", ".markdown", ".txt", ".log", ".rst", ".adoc", ".tex", ".json", ".jsonl",
	".yaml", ".yml", ".toml", ".xml", ".csv", ".tsv", ".ini", ".conf", ".cfg",
	".properties", ".env", ".diff", ".patch", ".ts", ".tsx", ".css", ".scss",
	".html", ".sql", ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".java", ".swift",
]);
const textName = /^(readme|license|licence|copying|changelog|authors|notice)(\.(md|txt))?$/i;
let flag = "-R";
if (!symlink && info.isFile() && !(info.mode & 0o111) &&
	(textExtensions.has(extname(target).toLowerCase()) || textName.test(basename(target)))) {
	let fd;
	try {
		// The extension alone is not evidence of text: reject disguised scripts and binary
		// headers before asking the editor to open the document. Bound the inspection work.
		fd = openSync(target, "r");
		const header = Buffer.alloc(4096);
		const count = readSync(fd, header, 0, header.length, 0);
		const bytes = header.subarray(0, count);
		const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
		if (!text.startsWith("#!") && !bytes.some((byte) =>
			byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13
		)) flag = "-t";
	} catch {
		refuse("could not inspect the document");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
try {
	const result = Bun.spawnSync([process.env.AS2_OPEN_BIN || "/usr/bin/open", flag, "--", target], {
		stdin: "ignore", stdout: "inherit", stderr: "inherit",
	});
	process.exit(result.exitCode ?? 1);
} catch {
	refuse("could not launch the file opener");
}
'
