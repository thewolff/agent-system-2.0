// Property test for printfOutput (M4 fix round 4, S7): over random ASCII formats and arguments drawn
// from the conversions the gate evaluates, whatever the gate computes is byte-for-byte what real
// bash's printf writes. A null from the gate (a form it does not evaluate) is the fail-closed answer
// and is not compared. The generator is seeded, so a failure reproduces.
import { expect, test } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { printfOutput } from "../src/exec";

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const CONVERSIONS = ["s", "b", "c", "d", "i", "o", "u", "x", "X", "%"];
// `\c` in a format is refused (bash 3.2 prints it literally), so it is exercised only inside `%b` args.
const LITERALS = ["a", "Z", " ", "-", "=", "\\n", "\\t", "\\\\", "\\101", "\\x41", "\\147", "\\0147", "\\7", "\\08"];
// Octal escapes with and without a leading zero, past 255, and followed by digits (astra-5 R5-B1:
// `%b` decodes `\147` as `g`, which a leading-zero-only decoder missed).
const OCTALS = ["\\147it", "\\0147it", "\\1471", "\\01471", "\\400", "\\0400", "\\7", "\\08", "\\8", "\\0", "\\377x", "\\12a"];
const ARGS = ["", "word", "two words", "0", "7", "42", "-3", "'a", "\\n", "\\c", "x\\ty", "255", "abc", ...OCTALS];

function pick<T>(r: () => number, xs: readonly T[]): T {
	return xs[Math.floor(r() * xs.length)]!;
}

function format(r: () => number): string {
	let f = "";
	const parts = 1 + Math.floor(r() * 5);
	for (let p = 0; p < parts; p++) {
		if (r() < 0.4) {
			f += pick(r, LITERALS);
			continue;
		}
		const conv = pick(r, CONVERSIONS);
		let spec = "%";
		if (conv !== "%") {
			if (r() < 0.3) spec += pick(r, ["-", "0", "-0"]);
			if (r() < 0.4) spec += r() < 0.2 ? "*" : String(Math.floor(r() * 6));
			if ((conv === "s" || conv === "b") && r() < 0.3) spec += `.${Math.floor(r() * 4)}`;
		}
		f += spec + conv;
	}
	return f;
}

// The test seam: the part of spawnSync bashPrintf uses, so a test can drive it without a process.
type SpawnResult = Pick<SpawnSyncReturns<Buffer>, "error" | "status" | "signal" | "stdout" | "stderr">;
type Spawn = (command: string, args: string[]) => SpawnResult;

const BASH_ATTEMPTS = 3;

// Real bash's printf output for args. A spawn that errors, is killed by a signal or exits non-zero
// (EAGAIN or a kill under full-suite load) is not a printf answer: it is retried at once, up to
// BASH_ATTEMPTS, and past that it throws naming every attempt's failure. Its stdout is never returned.
function bashPrintf(args: string[], spawn: Spawn = spawnSync): string {
	const failures: string[] = [];
	for (let attempt = 1; attempt <= BASH_ATTEMPTS; attempt++) {
		const r = spawn("bash", ["-c", 'printf "$@"', "_", ...args]);
		if (!r.error && r.signal === null && r.status === 0) return r.stdout.toString("latin1");
		failures.push(
			`attempt ${attempt}: error ${r.error ? r.error.message : "none"}, status ${r.status}, signal ${r.signal}, stderr ${JSON.stringify((r.stderr?.toString("latin1") ?? "").slice(0, 200))}`,
		);
	}
	throw new Error(`bash printf ${JSON.stringify(args)} failed all ${BASH_ATTEMPTS} attempts (a spawn failure, not a gate mismatch): ${failures.join("; ")}`);
}

function bashMismatches(cases: string[][], spawn: Spawn = spawnSync): { compared: number; mismatches: string[] } {
	let compared = 0;
	const mismatches: string[] = [];
	for (const args of cases) {
		const gate = printfOutput(args);
		if (gate === null) continue;
		compared++;
		const bash = bashPrintf(args, spawn);
		if (gate !== bash) mismatches.push(`${JSON.stringify(args)} gate=${JSON.stringify(gate)} bash=${JSON.stringify(bash)}`);
	}
	return { compared, mismatches };
}

test("printfOutput matches bash printf on every form it evaluates", () => {
	const r = rng(20260929);
	const cases: string[][] = [];
	for (let n = 0; n < 800; n++) {
		const args = [format(r)];
		const count = Math.floor(r() * 4);
		for (let k = 0; k < count; k++) args.push(pick(r, ARGS));
		cases.push(args);
	}
	const { compared, mismatches } = bashMismatches(cases);
	expect(mismatches).toEqual([]);
	expect(compared).toBeGreaterThan(300);
});

test("printfOutput decodes %b octal escapes as bash does, with and without a leading zero", () => {
	const r = rng(7031);
	const cases: string[][] = [];
	for (let n = 0; n < 120; n++) cases.push([pick(r, ["%b", "%b|%b", "[%b]", "%s %b"]), pick(r, OCTALS), pick(r, OCTALS)]);
	expect(bashMismatches(cases).mismatches).toEqual([]);
	expect(printfOutput(["%b", "\\147it reset --hard"])).toBe("git reset --hard");
});

// Fake-spawn tests: no process runs. Each fake answers its attempts in order and repeats its last answer.
const WORD = ["%s", "word"];

function fakeSpawn(answers: SpawnResult[]): { spawn: Spawn; calls: () => number } {
	let calls = 0;
	return { spawn: () => answers[Math.min(calls++, answers.length - 1)]!, calls: () => calls };
}

const EAGAIN = { error: new Error("spawn EAGAIN"), status: null, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("") };

test("a spawn that fails once with EAGAIN is retried and its retry compared, not counted as a mismatch", () => {
	expect(printfOutput(WORD)).toBe("word");
	const fake = fakeSpawn([EAGAIN, { status: 0, signal: null, stdout: Buffer.from("word"), stderr: Buffer.from("") }]);
	expect(bashMismatches([WORD], fake.spawn)).toEqual({ compared: 1, mismatches: [] });
	expect(fake.calls()).toBe(2);
});

test("a spawn killed by SIGKILL on every attempt throws naming the signal and the attempts, never a mismatch", () => {
	const fake = fakeSpawn([{ status: null, signal: "SIGKILL", stdout: Buffer.from(""), stderr: Buffer.from("") }]);
	let result: unknown = "no result";
	expect(() => {
		result = bashMismatches([WORD], fake.spawn);
	}).toThrow(/failed all 3 attempts.*signal SIGKILL/);
	expect(result).toBe("no result");
	expect(fake.calls()).toBe(3);
});

test("a successful spawn whose output differs from the gate is still one mismatch", () => {
	const fake = fakeSpawn([{ status: 0, signal: null, stdout: Buffer.from("other"), stderr: Buffer.from("") }]);
	expect(bashMismatches([WORD], fake.spawn)).toEqual({ compared: 1, mismatches: ['["%s","word"] gate="word" bash="other"'] });
	expect(fake.calls()).toBe(1);
});

test("a spawn that exits status 1 on every attempt throws naming the status and its stderr", () => {
	const fake = fakeSpawn([{ status: 1, signal: null, stdout: Buffer.from(""), stderr: Buffer.from("bash: printf: boom") }]);
	expect(() => bashMismatches([WORD], fake.spawn)).toThrow(/status 1, signal null, stderr "bash: printf: boom"/);
	expect(fake.calls()).toBe(3);
});

test("a spawn that fails with EAGAIN on every attempt stops at BASH_ATTEMPTS and throws naming EAGAIN", () => {
	const fake = fakeSpawn([EAGAIN]);
	let result: unknown = "no result";
	expect(() => {
		result = bashMismatches([WORD], fake.spawn);
	}).toThrow(/failed all 3 attempts.*error spawn EAGAIN/);
	expect(result).toBe("no result");
	expect(fake.calls()).toBe(BASH_ATTEMPTS);
});

test("printfOutput refuses the forms whose bash output it does not compute", () => {
	for (const args of [["% d", "0"], ["%+d", "5"], ["%#x", "255"], ["%.3d", "5"], ["%x", "-1"], ["%u", "-1"], ["%c", "é"], ["%q", "a b"], ["%f", "1.5"]]) {
		expect(printfOutput(args)).toBeNull();
	}
});
