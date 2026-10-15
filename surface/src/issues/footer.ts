// The machinery's `Closes #N` footer on a PR body (PLAN wl-mv66ylim0gahog § 5). The issues tick
// (and publishEntry's create) are its only writers; the model never writes it. The marker line lets
// the scan tell its own footer from a closing keyword a person typed.

/** `\n\n<!-- as2 -->\nCloses #<n>`, appended to a PR body. */
export function closesFooter(n: number): string {
	return `\n\n<!-- as2 -->\nCloses #${n}`;
}

/** Whether `body` already carries the footer for issue `n` (GitHub may store the line break as CRLF). */
export function hasFooter(body: string, n: number): boolean {
	return new RegExp(`<!-- as2 -->\\r?\\nCloses #${n}(?!\\d)`).test(body);
}

/**
 * `body` minus the machinery's own footer for issue `n` when it is exactly the body's suffix (LF, or
 * the same bytes with CRLF line breaks as GitHub may store them); null when it is not the suffix, so
 * a body where the footer sits anywhere else, or was edited, is left alone (§ 13.2 move).
 */
export function stripFooter(body: string, n: number): string | null {
	const lf = closesFooter(n);
	for (const suffix of [lf, lf.replaceAll("\n", "\r\n")]) if (body.endsWith(suffix)) return body.slice(0, -suffix.length);
	return null;
}
