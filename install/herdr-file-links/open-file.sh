#!/bin/sh
# Herdr supplies the clicked URL in HERDR_PLUGIN_CLICKED_URL (plugins reference, Link handlers).
# Decode in Bun, already required by as2, so no URL bytes ever become shell source or undergo
# command substitution. Keep the decoded path in argv, including spaces and literal newlines.
exec bun -e '
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
let target = path;
if (!existsSync(target)) {
	target = dirname(path);
	try {
		if (!statSync(target).isDirectory()) refuse("neither the file nor its parent directory exists");
	} catch {
		refuse("neither the file nor its parent directory exists");
	}
}
try {
	const result = Bun.spawnSync([process.env.AS2_OPEN_BIN || "/usr/bin/open", "--", target], {
		stdin: "ignore", stdout: "inherit", stderr: "inherit",
	});
	process.exit(result.exitCode ?? 1);
} catch {
	refuse("could not launch the file opener");
}
'
