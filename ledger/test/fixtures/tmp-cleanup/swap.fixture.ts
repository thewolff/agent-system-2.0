// tmp-cleanup fixture (T13, new tree only): during its test the run renames its own run root to a sibling,
// `<root>-moved`, and puts something else at the root path. FIX_SWAP=link: a symlink to FIX_OUTSIDE, a dir
// outside D. FIX_SWAP=dir: a fresh foreign dir F holding f.txt. Either replacement also gets a dir named like
// the run's registered tmpDir() dir and one named like the run's temp HOME, each holding keep.txt.
// FIX_BLOCK: then wait for stdin to close.
import { test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { tmpDir } from "../../tmp";
import { block, ready } from "./io";

test("tmp-cleanup fixture: the run root is replaced", async () => {
	const root = tmpdir();
	const made = tmpDir("fixture-swap-");
	writeFileSync(join(made, "data.txt"), "fixture data\n");
	const moved = `${root}-moved`;
	renameSync(root, moved);
	const swap = process.env.FIX_SWAP;
	let replacement: string;
	if (swap === "link" && process.env.FIX_OUTSIDE) {
		replacement = process.env.FIX_OUTSIDE;
		symlinkSync(replacement, root);
	} else if (swap === "dir") {
		replacement = root;
		mkdirSync(root);
		writeFileSync(join(root, "f.txt"), "foreign\n");
	} else {
		throw new Error(`FIX_SWAP=${swap} needs link (with FIX_OUTSIDE) or dir`);
	}
	for (const name of [basename(made), basename(process.env.HOME!)]) {
		mkdirSync(join(replacement, name));
		writeFileSync(join(replacement, name, "keep.txt"), `${swap}\n`);
	}
	ready({ made, moved, home: process.env.HOME! });
	await block();
}, 120_000);
