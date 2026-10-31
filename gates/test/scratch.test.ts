// The scratch contract (PLAN wl-mv5oikd5jtquww § 1.1, § 1.2): the root's location, which root a bound
// session owns, the physical containment check, and the textual spelling check. Real temp HOMEs: on
// macOS tmpdir() sits behind the /var → /private/var symlink, so the lexical and physical forms differ.
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	insideRoot,
	ownScratchRoot,
	SCRATCH_CAP_DEFAULT_MB,
	SCRATCH_CAP_ENV,
	SCRATCH_ENTRY,
	SCRATCH_ENV,
	SCRATCH_TOTAL_DEFAULT_MB,
	SCRATCH_TOTAL_ENV,
	scratchBase,
	scratchRootFor,
	scratchSpelling,
} from "../src/scratch";
import { WORKLOAD_ENV } from "../src/types";
import { tmp } from "./helpers";

const ID = "wl-abc123";
const OTHER = "wl-zzz9";

/** A temp HOME with the base made and the roots of `ids` created as real directories. */
function home(...ids: string[]): string {
	const h = tmp("scratch");
	mkdirSync(scratchBase(h), { recursive: true });
	for (const id of ids) mkdirSync(scratchRootFor(h, id));
	return h;
}

const bound = (h: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
	HOME: h,
	[WORKLOAD_ENV]: ID,
	...extra,
});

describe("constants and location", () => {
	test("exported names and defaults", () => {
		expect(SCRATCH_ENV).toBe("AS2_SCRATCH");
		expect(SCRATCH_CAP_ENV).toBe("AGENT_SYSTEM_SCRATCH_CAP_MB");
		expect(SCRATCH_CAP_DEFAULT_MB).toBe(2048);
		expect(SCRATCH_TOTAL_ENV).toBe("AGENT_SYSTEM_SCRATCH_TOTAL_MB");
		expect(SCRATCH_TOTAL_DEFAULT_MB).toBe(10240);
		expect(SCRATCH_ENTRY).toEqual({
			overCap: "scratch-over-cap:",
			underCap: "scratch-under-cap:",
			disk: "scratch-disk:",
			diskOk: "scratch-disk-ok:",
			removed: "scratch-removed:",
			removeFailed: "scratch-remove-failed:",
			archived: "scratch-archived:",
			archiveExpired: "scratch-archive-expired:",
		});
	});

	test("base and root are HOME-derived", () => {
		expect(scratchBase("/h")).toBe("/h/agent-scratch/agent-system-2.0/scratch");
		expect(scratchRootFor("/h", ID)).toBe(`/h/agent-scratch/agent-system-2.0/scratch/${ID}`);
	});

	test("an id that is not a workload id throws; chaos's hyphenated ids are workload ids", () => {
		for (const bad of ["", "wl-", "wl--a", "wl-a-", "WL-abc", "wl-ABC", "wl-a/b", "wl-a.b", "../wl-a", "wl-a\n", "x-abc"]) {
			expect(() => scratchRootFor("/h", bad)).toThrow();
		}
		expect(scratchRootFor("/h", "wl-chaos-mv5abc0001")).toBe("/h/agent-scratch/agent-system-2.0/scratch/wl-chaos-mv5abc0001");
	});
});

describe("ownScratchRoot", () => {
	test("a bound session with its root made gets the physical root", () => {
		const h = home(ID);
		const want = `${realpathSync(scratchBase(h))}/${ID}`;
		expect(ownScratchRoot(bound(h))).toBe(want);
	});

	test("unbound env: no workload id, no HOME, a relative HOME, or an invalid id", () => {
		const h = home(ID);
		expect(ownScratchRoot({ HOME: h })).toBeNull();
		expect(ownScratchRoot({ [WORKLOAD_ENV]: ID })).toBeNull();
		expect(ownScratchRoot({})).toBeNull();
		expect(ownScratchRoot({ HOME: "relative/home", [WORKLOAD_ENV]: ID })).toBeNull();
		expect(ownScratchRoot({ HOME: h, [WORKLOAD_ENV]: "wl-../x" })).toBeNull();
		expect(ownScratchRoot({ HOME: h, [WORKLOAD_ENV]: "" })).toBeNull();
	});

	test("missing root (and missing base) is null", () => {
		expect(ownScratchRoot(bound(home()))).toBeNull();
		expect(ownScratchRoot(bound(tmp("scratch-nobase")))).toBeNull();
	});

	test("a root that is a file is null", () => {
		const h = home();
		writeFileSync(scratchRootFor(h, ID), "x");
		expect(ownScratchRoot(bound(h))).toBeNull();
	});

	test("a base child that is a symlink (even to a real directory) is null", () => {
		const h = home();
		const elsewhere = tmp("scratch-elsewhere");
		symlinkSync(elsewhere, scratchRootFor(h, ID));
		expect(ownScratchRoot(bound(h))).toBeNull();
	});

	test("AS2_SCRATCH naming the root, lexically or physically, with or without a trailing slash", () => {
		const h = home(ID);
		const want = `${realpathSync(scratchBase(h))}/${ID}`;
		for (const named of [scratchRootFor(h, ID), `${scratchRootFor(h, ID)}/`, want, `${want}/`]) {
			expect(ownScratchRoot(bound(h, { [SCRATCH_ENV]: named }))).toBe(want);
		}
	});

	test("AS2_SCRATCH mismatch is null: another workload's root, the base, an empty value, elsewhere", () => {
		const h = home(ID, OTHER);
		for (const named of [scratchRootFor(h, OTHER), scratchBase(h), "", "/tmp", `${scratchRootFor(h, ID)}/sub`, scratchRootFor(h, ID).slice(0, -1)]) {
			expect(ownScratchRoot(bound(h, { [SCRATCH_ENV]: named }))).toBeNull();
		}
	});
});

describe("insideRoot", () => {
	const rig = () => {
		const h = home(ID, OTHER);
		const root = ownScratchRoot(bound(h));
		if (root === null) throw new Error("rig: no root");
		return { h, root };
	};

	test("existing and not-yet-existing paths strictly below the root", () => {
		const { h, root } = rig();
		mkdirSync(join(root, "repo"));
		writeFileSync(join(root, "repo", "f"), "x");
		expect(insideRoot(root, join(root, "repo"))).toBe(true);
		expect(insideRoot(root, join(root, "repo", "f"))).toBe(true);
		expect(insideRoot(root, join(root, "new", "deeper", "x"))).toBe(true);
		expect(insideRoot(root, `${root}/./repo//f`)).toBe(true);
		// the lexical HOME-derived spelling (through /var on macOS) is physically inside too
		expect(insideRoot(root, join(scratchRootFor(h, ID), "repo"))).toBe(true);
	});

	test("the root itself is not inside", () => {
		const { h, root } = rig();
		for (const p of [root, `${root}/`, `${root}/.`, `${root}//./`, scratchRootFor(h, ID)]) expect(insideRoot(root, p)).toBe(false);
	});

	test("another workload's root, the base, and a sibling sharing the prefix are not inside", () => {
		const { h, root } = rig();
		expect(insideRoot(root, join(scratchRootFor(h, OTHER), "x"))).toBe(false);
		expect(insideRoot(root, join(scratchBase(h), "x"))).toBe(false);
		mkdirSync(`${root}9`);
		expect(insideRoot(root, `${root}9/x`)).toBe(false);
		expect(insideRoot(root, "/tmp/x")).toBe(false);
	});

	test("a `..` component is never inside, even one that stays below the root", () => {
		const { root } = rig();
		mkdirSync(join(root, "a"));
		expect(insideRoot(root, `${root}/a/../b`)).toBe(false);
		expect(insideRoot(root, `${root}/a/..`)).toBe(false);
		expect(insideRoot(root, `${root}/../${OTHER}/x`)).toBe(false);
	});

	test("a `%` anywhere is never inside", () => {
		const { root } = rig();
		expect(insideRoot(root, `${root}/a%2e`)).toBe(false);
		expect(insideRoot(root, `${root}/%`)).toBe(false);
	});

	test("relative paths and a relative or bare-slash root are never inside", () => {
		const { root } = rig();
		expect(insideRoot(root, "repo/f")).toBe(false);
		expect(insideRoot(root, "")).toBe(false);
		expect(insideRoot("/", "/etc/passwd")).toBe(false);
		expect(insideRoot("rel", "/rel/x")).toBe(false);
	});

	test("an existing symlink inside the root pointing outside is not inside, nor anything through it", () => {
		const { root } = rig();
		const outside = tmp("scratch-outside");
		writeFileSync(join(outside, "f"), "x");
		symlinkSync(outside, join(root, "out"));
		symlinkSync(join(outside, "f"), join(root, "outfile"));
		expect(insideRoot(root, join(root, "out"))).toBe(false);
		expect(insideRoot(root, join(root, "out", "f"))).toBe(false);
		expect(insideRoot(root, join(root, "out", "new", "x"))).toBe(false);
		expect(insideRoot(root, join(root, "outfile"))).toBe(false);
	});

	test("a symlink to the root itself or to another workload's root is not inside", () => {
		const { h, root } = rig();
		symlinkSync(root, join(root, "self"));
		symlinkSync(scratchRootFor(h, OTHER), join(root, "other"));
		expect(insideRoot(root, join(root, "self"))).toBe(false);
		expect(insideRoot(root, join(root, "other", "x"))).toBe(false);
	});

	test("a dangling symlink inside the root is not inside (its target is unknown)", () => {
		const { root } = rig();
		symlinkSync("/nonexistent-scratch-target/x", join(root, "dangling"));
		expect(insideRoot(root, join(root, "dangling"))).toBe(false);
		expect(insideRoot(root, join(root, "dangling", "y"))).toBe(false);
	});

	test("a symlink inside the root pointing inside it is inside", () => {
		const { root } = rig();
		mkdirSync(join(root, "real"));
		symlinkSync(join(root, "real"), join(root, "alias"));
		expect(insideRoot(root, join(root, "alias"))).toBe(true);
		expect(insideRoot(root, join(root, "alias", "x"))).toBe(true);
	});
});

describe("scratchSpelling", () => {
	const R = "/s/scratch/wl-abc123";

	test("an absolute literal path, bare or quoted", () => {
		expect(scratchSpelling("/s/scratch/wl-abc123/x", R)).toBe("/s/scratch/wl-abc123/x");
		expect(scratchSpelling('"/a b/c"', R)).toBe("/a b/c");
		expect(scratchSpelling("'/a/c'", R)).toBe("/a/c");
		expect(scratchSpelling("/etc/passwd", R)).toBe("/etc/passwd");
	});

	test("the variable forms expand to the root", () => {
		expect(scratchSpelling("$AS2_SCRATCH/x/y", R)).toBe(`${R}/x/y`);
		expect(scratchSpelling("${AS2_SCRATCH}/x", R)).toBe(`${R}/x`);
		expect(scratchSpelling('"$AS2_SCRATCH/x y"', R)).toBe(`${R}/x y`);
		expect(scratchSpelling('"${AS2_SCRATCH}/x"', R)).toBe(`${R}/x`);
		expect(scratchSpelling('"$AS2_SCRATCH"/x', R)).toBe(`${R}/x`);
		expect(scratchSpelling('"${AS2_SCRATCH}"/x', R)).toBe(`${R}/x`);
	});

	test("the variable alone means the root itself", () => {
		for (const t of ["$AS2_SCRATCH", "${AS2_SCRATCH}", '"$AS2_SCRATCH"', '"${AS2_SCRATCH}"']) expect(scratchSpelling(t, R)).toBe(R);
	});

	test("single quotes do not expand the variable", () => {
		expect(scratchSpelling("'$AS2_SCRATCH/x'", R)).toBeNull();
		expect(scratchSpelling("'${AS2_SCRATCH}'", R)).toBeNull();
	});

	test("other variables, a longer name, substitutions, globs, ~, % and escapes are null", () => {
		for (const t of [
			"$HOME/x",
			"$AS2_SCRATCHX/x",
			"${AS2_SCRATCH_2}/x",
			"$AS2_SCRATCH/$x",
			"$AS2_SCRATCH/$(id)",
			"$AS2_SCRATCH/`id`",
			"/a/$(mktemp -d)",
			"$(mktemp -d)",
			"/a/`id`",
			"/a/*",
			"$AS2_SCRATCH/*",
			"/a/b?",
			"/a/[bc]",
			"~/x",
			"/a/~b",
			"$AS2_SCRATCH/a%2e",
			"/a%2e",
			"/a/{b,c}",
			"/a\\ b",
			'"$AS2_SCRATCH"/"x"',
			'"/a"/b',
		]) {
			expect(scratchSpelling(t, R)).toBeNull();
		}
	});

	test("relative text, URLs and file:// are null", () => {
		for (const t of ["x/y", "./x", "file:///s/x", "https://example.com/x", "", '""', "''"]) expect(scratchSpelling(t, R)).toBeNull();
	});

	test("textual only: `..` is left for insideRoot", () => {
		expect(scratchSpelling("$AS2_SCRATCH/../x", R)).toBe(`${R}/../x`);
	});
});
