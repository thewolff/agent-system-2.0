// bwrap.mjs — the Linux half of the sandbox: what bubblewrap needs beyond the options the gate
// core builds (core/gate.mjs bwrapArgsFor, pairWriteBwrap).
//
// WHAT IT PROVIDES
//   - bwrapProblem: whether bubblewrap can fence pair_run on this machine, from a one-time probe,
//     and bwrapProc: the /proc mode that probe settled on ("fresh", or "ro-bind" in a container
//     that masks /proc).
//   - seccompFilter: the classic-BPF program that makes socket(AF_UNIX, ...) and io_uring_setup
//     fail with EPERM, matching the Seatbelt profile's Unix-socket deny.
//   - bwrapCommand: the full bwrap argv for a plan, with every read-write bind pinned to a file
//     descriptor opened without following a final symlink and checked against its path, so a
//     path swapped for a symlink cannot carry a bind outside the worktree.
//   - bwrapIo: the filesystem facts the core's builders take.
//
// RULES IT KEEPS
//   - Node built-ins only and no top-level await (host-io.mjs imports it everywhere).

import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch as osArch, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { bwrapBase } from "../core/gate.mjs";

// ─── seccomp ────────────────────────────────────────────────────────────────────────────

/**
 * Per-architecture numbers, from the kernel's uapi headers: the audit architecture
 * (include/uapi/linux/audit.h, AUDIT_ARCH_X86_64 = EM_X86_64 | 64BIT | LE, AUDIT_ARCH_AARCH64 =
 * EM_AARCH64 | 64BIT | LE), and the syscall numbers (arch/x86/entry/syscalls/syscall_64.tbl;
 * scripts/syscall.tbl, which arm64 uses). x86_64 also accepts x32 calls under the same audit
 * architecture, with bit 30 set (arch/x86/include/uapi/asm/unistd.h, __X32_SYSCALL_BIT).
 */
export const SECCOMP_ARCHES = Object.freeze({
  x64: Object.freeze({ audit: 0xc000003e, socket: 41, ioUringSetup: 425, x32Bit: 0x40000000 }),
  arm64: Object.freeze({ audit: 0xc00000b7, socket: 198, ioUringSetup: 425, x32Bit: 0 }),
});

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const RET_ALLOW = 0x7fff0000;
const RET_EPERM = 0x00050000 | 1;
const AF_UNIX = 1;
// struct seccomp_data: int nr at 0, __u32 arch at 4, __u64 instruction_pointer at 8, __u64 args[6] at 16.
const OFF_NR = 0;
const OFF_ARCH = 4;
const OFF_ARG0_LOW = 16;

/**
 * The seccomp program, as the bytes of a struct sock_filter array (u16 code, u8 jt, u8 jf, u32
 * k, little-endian): a syscall from another architecture, an x32 syscall, io_uring_setup (an
 * io_uring can create a socket without the socket syscall) and socket() with domain AF_UNIX
 * return EPERM; everything else is allowed. socketpair stays allowed: it reaches no one outside.
 * Null for an architecture with no table here.
 * @param {string} [arch]  as os.arch() names it
 * @returns {Buffer | null}
 */
export function seccompFilter(arch = osArch()) {
  const a = SECCOMP_ARCHES[arch];
  if (!a) return null;
  const prog = [
    [BPF_LD_W_ABS, 0, 0, OFF_ARCH],
    [BPF_JMP_JEQ_K, 1, 0, a.audit],
    [BPF_RET_K, 0, 0, RET_EPERM],
    [BPF_LD_W_ABS, 0, 0, OFF_NR],
    ...(a.x32Bit ? [[BPF_JMP_JGE_K, 0, 1, a.x32Bit], [BPF_RET_K, 0, 0, RET_EPERM]] : []),
    [BPF_JMP_JEQ_K, 0, 1, a.ioUringSetup],
    [BPF_RET_K, 0, 0, RET_EPERM],
    [BPF_JMP_JEQ_K, 0, 3, a.socket],
    [BPF_LD_W_ABS, 0, 0, OFF_ARG0_LOW],
    [BPF_JMP_JEQ_K, 0, 1, AF_UNIX],
    [BPF_RET_K, 0, 0, RET_EPERM],
    [BPF_RET_K, 0, 0, RET_ALLOW],
  ];
  const out = Buffer.alloc(prog.length * 8);
  prog.forEach(([code, jt, jf, k], i) => {
    out.writeUInt16LE(code, i * 8);
    out.writeUInt8(jt, i * 8 + 2);
    out.writeUInt8(jf, i * 8 + 3);
    out.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return out;
}

/** A read-only descriptor holding the filter, whose file is already gone. */
function filterFd() {
  const filter = seccompFilter();
  if (!filter) throw new Error(`no seccomp filter for ${osArch()}`);
  const dir = mkdtempSync(join(tmpdir(), "pc-seccomp-"));
  try {
    const file = join(dir, "filter.bpf");
    writeFileSync(file, filter, { mode: 0o600 });
    return openSync(file, "r");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── finding and probing bwrap ──────────────────────────────────────────────────────────

/** The bwrap executable on PATH, or null. */
function findBwrap(env = process.env) {
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (!dir.startsWith("/")) continue;
    const p = join(dir, "bwrap");
    try {
      if (statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}

let probed = null;

const USERNS_FIX = "unprivileged user namespaces look switched off. Ubuntu 23.10 and later: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0 (lasting: put that setting in /etc/sysctl.d/), or load the bwrap-userns-restrict AppArmor profile from apparmor-profiles; Debian: sudo sysctl kernel.unprivileged_userns_clone=1; in a Docker container, unconfined seccomp, and unconfined AppArmor where the host runs it (docker run --security-opt seccomp=unconfined --security-opt apparmor=unconfined; add --security-opt systempaths=unconfined for a fresh /proc)";

/** What bwrap prints when the kernel will not mount it a fresh procfs. */
const FRESH_PROC_REFUSED = /Can't mount proc on /;

/**
 * Which /proc mode the probe settles on, from `attempt`, which runs the probe sandbox with a
 * given mode (core/gate.mjs BWRAP_PROC_ARGS). A fresh procfs first. Only when that failed on the
 * procfs mount itself, as under Docker's /proc masks, the host's /proc bound read-only, and only
 * if the sandbox then works with it. Any other failure (no user namespaces, a bwrap without
 * --bind-fd) is that failure, with no second attempt.
 * @param {(proc: "fresh" | "ro-bind") => { ok: boolean, err: string }} attempt
 * @returns {{ proc: "fresh" | "ro-bind" } | { err: string, freshProcRefused: boolean }}
 *   `freshProcRefused`: the fresh procfs was refused, and `err` is why the read-only bind failed too
 */
export function chooseProc(attempt) {
  const fresh = attempt("fresh");
  if (fresh.ok) return { proc: "fresh" };
  if (!FRESH_PROC_REFUSED.test(fresh.err)) return { err: fresh.err, freshProcRefused: false };
  const bound = attempt("ro-bind");
  return bound.ok ? { proc: "ro-bind" } : { err: bound.err, freshProcRefused: true };
}

/**
 * Why bubblewrap cannot fence pair_run here, or null. Probes once per process: the probe runs
 * /bin/true with the options every run uses (a pinned bind, the seccomp filter, every namespace
 * unshared), so a missing bwrap, user namespaces switched off, a bwrap without --bind-fd and a
 * filter for the wrong architecture are all refused before pairing starts. A kernel that refuses
 * a fresh /proc under an otherwise working sandbox gets the host's /proc bound read-only instead
 * (chooseProc). Only success is remembered, with its /proc mode (bwrapProc).
 */
export function bwrapProblem() {
  if (probed) return null;
  if (!seccompFilter()) return `pair_run on Linux needs x86_64 or aarch64 for its seccomp filter; this is ${osArch()}`;
  const bwrap = findBwrap();
  if (!bwrap) return "pair_run on Linux needs bubblewrap (bwrap) on PATH; install the bubblewrap package";
  let dirFd;
  let secFd;
  try {
    dirFd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
    secFd = filterFd();
    const attempt = (proc) => {
      const res = spawnSync(bwrap, [...bwrapBase(proc), "--share-net", "--bind-fd", "3", "/tmp", "--seccomp", "4", "--", "/bin/true"], { stdio: ["ignore", "ignore", "pipe", dirFd, secFd], encoding: "utf8", timeout: 10_000 });
      return { ok: res.status === 0, err: String(res.stderr ?? res.error ?? "").trim() || `exit ${res.status}` };
    };
    const got = chooseProc(attempt);
    if ("proc" in got) {
      probed = { bwrap, proc: got.proc };
      return null;
    }
    if (/bind-fd/.test(got.err)) return `bubblewrap at ${bwrap} is too old: it has no --bind-fd (bubblewrap 0.10.0 or later, or a distribution build carrying the CVE-2024-42472 fix). It said: ${got.err}`;
    if (got.freshProcRefused) return `bubblewrap at ${bwrap} cannot mount a fresh /proc here, as in a container that masks parts of /proc, and the sandbox fails with the container's /proc bound read-only too (${got.err}); run the container with --security-opt systempaths=unconfined`;
    return `bubblewrap at ${bwrap} cannot make its sandbox here (${got.err}); ${USERNS_FIX}`;
  } catch (err) {
    return `could not probe bubblewrap: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    if (dirFd !== undefined) closeSync(dirFd);
    if (secFd !== undefined) closeSync(secFd);
  }
}

/** The /proc mode the probe settled on ("fresh" or "ro-bind"); null until bwrapProblem succeeds. */
export function bwrapProc() {
  return probed ? probed.proc : null;
}

// ─── running a plan ─────────────────────────────────────────────────────────────────────

/** The filesystem facts core/gate.mjs's bubblewrap builders take. */
export const bwrapIo = Object.freeze({
  kind(abs) {
    try {
      const st = statSync(abs);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    } catch {
      return null;
    }
  },
  gitEntries(dir, recursive) {
    const out = [];
    const walk = (d) => {
      let names;
      try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const abs = join(d, e.name);
        if (e.name.toLowerCase() === ".git") {
          // A dangling symlink has nothing to bind; replacing it shows in the link check.
          try { statSync(abs); out.push(abs); } catch { /* dangling */ }
        } else if (recursive && e.isDirectory()) {
          walk(abs);
        }
      }
    };
    walk(dir);
    return out;
  },
});

const PIN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Open `path` without following a final symlink and check the open file is `path` itself, so no
 * symlink anywhere along it redirected the open. The descriptor then names that file for good,
 * whatever later happens to the path.
 */
function pin(path) {
  let fd;
  try {
    fd = openSync(path, PIN_FLAGS | constants.O_DIRECTORY);
  } catch (err) {
    if (err?.code !== "ENOTDIR") throw new Error(`cannot open ${path} to bind it: ${err?.code ?? err}`);
    try {
      fd = openSync(path, PIN_FLAGS);
    } catch (err2) {
      throw new Error(`cannot open ${path} to bind it: ${err2?.code ?? err2}`);
    }
  }
  const real = readlinkSync(`/proc/self/fd/${fd}`);
  if (real !== path) {
    closeSync(fd);
    throw new Error(`${path} resolves through a symlink to ${real}; pair_run binds only paths that are what they name`);
  }
  return fd;
}

/**
 * The bwrap argv for `plan` with `command` run by /bin/sh in `cwd`: every `--bind SRC DEST` of
 * the plan becomes `--bind-fd N DEST` on a pinned descriptor, and the seccomp filter goes last.
 * `fds` are the descriptors for stdio slots 3 and up, in order; the caller closes them with
 * `close` once the child has started.
 * @param {{ args: string[] }} plan
 * @param {{ argv: string[], cwd?: string }} run  what bwrap runs inside the sandbox
 * @returns {{ file: string, args: string[], fds: number[], close: () => void }}
 */
export function bwrapCommand(plan, run) {
  if (!probed) throw new Error("bubblewrap was not probed; call bwrapProblem first");
  const fds = [];
  const close = () => { for (const fd of fds.splice(0)) { try { closeSync(fd); } catch { /* already closed */ } } };
  try {
    const args = [];
    for (let i = 0; i < plan.args.length; i++) {
      const a = plan.args[i];
      if (a === "--bind") {
        const src = plan.args[i + 1];
        const dest = plan.args[i + 2];
        if (src !== dest) throw new Error("a bind's source and destination differ");
        fds.push(pin(src));
        args.push("--bind-fd", String(2 + fds.length), dest);
        i += 2;
      } else {
        args.push(a);
      }
    }
    fds.push(filterFd());
    args.push("--seccomp", String(2 + fds.length));
    if (run.cwd) args.push("--chdir", run.cwd);
    args.push("--", ...run.argv);
    return { file: probed.bwrap, args, fds, close };
  } catch (err) {
    close();
    throw err;
  }
}
