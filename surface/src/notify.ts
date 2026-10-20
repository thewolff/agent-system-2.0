// Jo's machinery alarm (PLAN wl-mvfxw3c4zqfzls D4): a macOS notification with sound and a spoken line, each one
// process run by argv, no shell. The train tick shows its own alerts with `notify` and the forgery alarm with both;
// callers take them as injected seams (surface/scripts/train-tick.ts TickDeps), so a test passes stubs and never
// runs osascript or say.

/** One alarm channel: true when it ran (exit 0), false when it could not be shown or spoken. */
export type Notify = (title: string, text: string) => boolean;
export type Speak = (line: string) => boolean;

/** An AppleScript string literal: double-quoted, backslash and double quote escaped. */
function appleString(s: string): string {
	return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** `osascript -e 'display notification … with title … sound name "Glass"'`. */
export const notify: Notify = (title, text) => {
	const r = Bun.spawnSync(["osascript", "-e", `display notification ${appleString(text)} with title ${appleString(title)} sound name "Glass"`], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
	return r.exitCode === 0;
};

/** `say <line>`: the line is one argv word, read by no shell; callers' lines open with a word, never a `-`. */
export const speak: Speak = (line) => {
	const r = Bun.spawnSync(["say", line], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
	return r.exitCode === 0;
};
