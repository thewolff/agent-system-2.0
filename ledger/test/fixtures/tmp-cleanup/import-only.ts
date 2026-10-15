// tmp-cleanup fixture (T14): a plain `bun` process, not `bun test`, that imports the temp-dir module
// the way a fake binary does through a test helper. It handles its own SIGTERM, signals itself, and
// prints what it saw: its handler ran, it is still running, and TMPDIR is the one it was given.
import { tmpdir } from "node:os";
import "../../tmp";

let handled = false;
process.on("SIGTERM", () => {
	handled = true;
});
process.kill(process.pid, "SIGTERM");
for (let i = 0; i < 250 && !handled; i++) await Bun.sleep(20);
console.log(JSON.stringify({ handled, tmpdir: tmpdir() }));
