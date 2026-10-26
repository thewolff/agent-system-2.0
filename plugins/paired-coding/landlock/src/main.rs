//! pair-landlock: paired-coding's Linux write fence.
//!
//! Reads one JSON ruleset from the first line of stdin, turns it into a Landlock ruleset that
//! handles every file-system write right the running kernel supports, and runs
//! `/bin/sh -c <command>` under it in a child that sets no_new_privs and restricts itself.
//! Below Landlock ABI 9, which cannot refuse a connect to a pathname Unix socket, the child
//! also installs a seccomp filter that makes `socket(AF_UNIX, ...)` fail with EPERM. The helper
//! itself stays outside the sandbox as a child subreaper: when the command exits, or the helper
//! gets SIGTERM, SIGINT or SIGHUP, it kills and reaps every process the command left behind,
//! including ones that left its process group. Everything on stdin after the first newline is
//! left unread for the command. See README.md beside this crate for the contract.

use std::collections::HashMap;
use serde::Deserialize;
use std::ffi::CString;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

/// Landlock is missing, disabled, or its ABI is below 3. The caller falls back to bwrap.
const EXIT_UNSUPPORTED: i32 = 120;
/// The ruleset on stdin, or the command line, is not acceptable. Nothing ran.
const EXIT_INPUT: i32 = 121;
/// A Landlock or prctl call failed while building or enforcing the ruleset. Nothing ran.
const EXIT_SANDBOX: i32 = 122;
/// The ruleset was enforced but /bin/sh could not be executed.
const EXIT_EXEC: i32 = 123;

/// The lowest ABI the fence accepts: ABI 3 is the first that can deny truncate(2).
const MIN_ABI: i64 = 3;
/// The largest ruleset line accepted on stdin.
const MAX_RULESET_BYTES: usize = 16 << 20;

// include/uapi/linux/landlock.h
const CREATE_RULESET_VERSION: u32 = 1 << 0;
const RULE_PATH_BENEATH: u32 = 1;
const WRITE_FILE: u64 = 1 << 1;
const REMOVE_DIR: u64 = 1 << 4;
const REMOVE_FILE: u64 = 1 << 5;
const MAKE_CHAR: u64 = 1 << 6;
const MAKE_DIR: u64 = 1 << 7;
const MAKE_REG: u64 = 1 << 8;
const MAKE_SOCK: u64 = 1 << 9;
const MAKE_FIFO: u64 = 1 << 10;
const MAKE_BLOCK: u64 = 1 << 11;
const MAKE_SYM: u64 = 1 << 12;
const REFER: u64 = 1 << 13;
const TRUNCATE: u64 = 1 << 14;
const IOCTL_DEV: u64 = 1 << 15;
const RESOLVE_UNIX: u64 = 1 << 16;
const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
const SCOPE_SIGNAL: u64 = 1 << 1;

/// Rights on a listed file: rewrite it and truncate it.
const FILE_RIGHTS: u64 = WRITE_FILE | TRUNCATE;
/// Rights on a `dirs` tree: create regular files and write them. Landlock checks WRITE_FILE
/// when the new file is opened, against the new file's path, so creating without writing is
/// all MAKE_REG alone allows; WRITE_FILE and TRUNCATE therefore reach every existing file in
/// the tree as well.
const DIR_RIGHTS: u64 = MAKE_REG | WRITE_FILE | TRUNCATE;
/// Extra rights on a `dirs` entry marked `remove`: delete files under it and rename them within
/// it. Landlock needs REFER on both ends of a rename or link that crosses directories, and
/// MAKE_REG at the destination, so a file under a `remove` entry cannot be moved anywhere
/// that is not granted the same way.
const REMOVE_RIGHTS: u64 = REMOVE_FILE | REFER;

/// The first ABI whose RESOLVE_UNIX right covers connecting to a pathname Unix socket. Below
/// it the seccomp filter refuses every new Unix socket instead.
const RESOLVE_UNIX_ABI: i64 = 9;

/// Per-architecture numbers for the seccomp filter, the same table as lib/bwrap.mjs's
/// SECCOMP_ARCHES: the audit architecture (include/uapi/linux/audit.h) and the syscall numbers
/// (arch/x86/entry/syscalls/syscall_64.tbl; scripts/syscall.tbl, which arm64 uses). x86_64
/// also accepts x32 calls under the same audit architecture, with bit 30 set.
struct SeccompArch {
    audit: u32,
    socket: u32,
    io_uring_setup: u32,
    x32_bit: u32,
}

#[allow(dead_code)]
const ARCH_X86_64: SeccompArch = SeccompArch { audit: 0xc000_003e, socket: 41, io_uring_setup: 425, x32_bit: 0x4000_0000 };
#[allow(dead_code)]
const ARCH_AARCH64: SeccompArch = SeccompArch { audit: 0xc000_00b7, socket: 198, io_uring_setup: 425, x32_bit: 0 };
#[cfg(target_arch = "x86_64")]
const HOST_ARCH: &SeccompArch = &ARCH_X86_64;
#[cfg(target_arch = "aarch64")]
const HOST_ARCH: &SeccompArch = &ARCH_AARCH64;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_JMP_JGE_K: u16 = 0x35;
const BPF_RET_K: u16 = 0x06;
const RET_ALLOW: u32 = 0x7fff_0000;
const RET_EPERM: u32 = 0x0005_0000 | 1;
const AF_UNIX: u32 = 1;
// struct seccomp_data: int nr at 0, __u32 arch at 4, __u64 instruction_pointer at 8, __u64 args[6] at 16.
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0_LOW: u32 = 16;

/// The seccomp program, instruction for instruction the one lib/bwrap.mjs's seccompFilter
/// builds: a syscall from another architecture, an x32 syscall, io_uring_setup (an io_uring
/// can create a socket without the socket syscall) and socket() with domain AF_UNIX return
/// EPERM; everything else is allowed. socketpair stays allowed: it reaches no one outside.
fn socket_filter(a: &SeccompArch) -> Vec<(u16, u8, u8, u32)> {
    let mut prog = vec![
        (BPF_LD_W_ABS, 0, 0, OFF_ARCH),
        (BPF_JMP_JEQ_K, 1, 0, a.audit),
        (BPF_RET_K, 0, 0, RET_EPERM),
        (BPF_LD_W_ABS, 0, 0, OFF_NR),
    ];
    if a.x32_bit != 0 {
        prog.push((BPF_JMP_JGE_K, 0, 1, a.x32_bit));
        prog.push((BPF_RET_K, 0, 0, RET_EPERM));
    }
    prog.extend([
        (BPF_JMP_JEQ_K, 0, 1, a.io_uring_setup),
        (BPF_RET_K, 0, 0, RET_EPERM),
        (BPF_JMP_JEQ_K, 0, 3, a.socket),
        (BPF_LD_W_ABS, 0, 0, OFF_ARG0_LOW),
        (BPF_JMP_JEQ_K, 0, 1, AF_UNIX),
        (BPF_RET_K, 0, 0, RET_EPERM),
        (BPF_RET_K, 0, 0, RET_ALLOW),
    ]);
    prog
}

/// Installs the socket filter for this process and everything it starts. no_new_privs must
/// already be set.
fn install_socket_filter() -> Result<(), Fail> {
    let mut filter: Vec<libc::sock_filter> = socket_filter(HOST_ARCH)
        .into_iter()
        .map(|(code, jt, jf, k)| libc::sock_filter { code, jt, jf, k })
        .collect();
    let prog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
    // SAFETY: prog points at a valid filter array that outlives the call; the kernel copies it.
    if unsafe { libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &prog as *const libc::sock_fprog) } < 0 {
        return fail(EXIT_SANDBOX, format!("prctl(PR_SET_SECCOMP): {}", os_err(errno())));
    }
    Ok(())
}

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
    handled_access_net: u64,
    scoped: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct Ruleset {
    #[serde(default)]
    files: Vec<String>,
    #[serde(default)]
    dirs: Vec<DirEntry>,
    #[serde(default)]
    rw_trees: Vec<String>,
    command: String,
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct DirEntry {
    path: String,
    #[serde(default)]
    make_dir: bool,
    #[serde(default)]
    remove: bool,
}

struct Fail(i32, String);

fn fail<T>(code: i32, msg: impl Into<String>) -> Result<T, Fail> {
    Err(Fail(code, msg.into()))
}

/// Every write right the ABI handles, ioctl on devices from ABI 5 (never granted, so a run
/// cannot drive a device it opens), plus pathname Unix-socket connects from ABI 9.
/// Reading and executing stay unhandled, so they stay allowed.
fn handled_fs(abi: i64) -> u64 {
    let mut h = WRITE_FILE
        | REMOVE_DIR
        | REMOVE_FILE
        | MAKE_CHAR
        | MAKE_DIR
        | MAKE_REG
        | MAKE_SOCK
        | MAKE_FIFO
        | MAKE_BLOCK
        | MAKE_SYM;
    if abi >= 2 {
        h |= REFER;
    }
    if abi >= 3 {
        h |= TRUNCATE;
    }
    if abi >= 5 {
        h |= IOCTL_DEV;
    }
    if abi >= 9 {
        h |= RESOLVE_UNIX;
    }
    h
}

/// From ABI 6: abstract Unix sockets outside the sandbox are unreachable, and so is every
/// process outside it by signal, the helper's own supervising process included.
fn scoped(abi: i64) -> u64 {
    if abi >= 6 {
        SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
    } else {
        0
    }
}

/// A temp tree gets every handled right except REFER and IOCTL_DEV (never granted) and
/// RESOLVE_UNIX (a socket a process outside the sandbox made under /tmp stays unreachable).
fn rw_tree_rights(handled: u64) -> u64 {
    handled & !(REFER | IOCTL_DEV | RESOLVE_UNIX)
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn os_err(e: i32) -> String {
    io::Error::from_raw_os_error(e).to_string()
}

/// The running Landlock ABI, or the errno that says why there is none.
fn running_abi() -> Result<i64, i32> {
    // SAFETY: a NULL attr with size 0 and the VERSION flag only queries the ABI.
    let r = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<RulesetAttr>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if r < 0 {
        Err(errno())
    } else {
        Ok(r as i64)
    }
}

/// The ABI the fence runs on, or EXIT_UNSUPPORTED when there is none or it is below 3.
fn classify(abi: Result<i64, i32>) -> Result<i64, Fail> {
    match abi {
        Err(e) => fail(EXIT_UNSUPPORTED, format!("Landlock is unavailable on this kernel ({})", os_err(e))),
        Ok(abi) if abi < MIN_ABI => fail(
            EXIT_UNSUPPORTED,
            format!("Landlock ABI {abi} is below {MIN_ABI}, so truncation cannot be denied"),
        ),
        Ok(abi) => Ok(abi),
    }
}

/// The first line of stdin, read one byte at a time so nothing after the newline is consumed.
fn read_ruleset_line() -> Result<Vec<u8>, Fail> {
    let mut line = Vec::new();
    let mut byte = 0u8;
    loop {
        // SAFETY: reads at most one byte into a valid one-byte buffer.
        let n = unsafe { libc::read(0, (&mut byte as *mut u8).cast(), 1) };
        if n < 0 {
            let e = errno();
            if e == libc::EINTR {
                continue;
            }
            return fail(EXIT_INPUT, format!("reading the ruleset from stdin: {}", os_err(e)));
        }
        if n == 0 || byte == b'\n' {
            return Ok(line);
        }
        if line.len() == MAX_RULESET_BYTES {
            return fail(EXIT_INPUT, format!("the ruleset line is longer than {MAX_RULESET_BYTES} bytes"));
        }
        line.push(byte);
    }
}

fn parse(line: &[u8]) -> Result<Ruleset, Fail> {
    let rs: Ruleset = match serde_json::from_slice(line) {
        Ok(rs) => rs,
        Err(e) => return fail(EXIT_INPUT, format!("the ruleset is not valid: {e}")),
    };
    if rs.command.is_empty() {
        return fail(EXIT_INPUT, "the ruleset has an empty command");
    }
    Ok(rs)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    File,
    Dir,
}

/// Opens `path` with O_PATH for a rule. The path must be absolute and canonical (no symlink
/// anywhere in it, no `.` or `..`), so the rule lands on the object the caller named. A file
/// must be a regular file with one link, or a character device; a directory must be one.
fn open_for_rule(path: &str, kind: Kind) -> Result<i32, Fail> {
    if !path.starts_with('/') {
        return fail(EXIT_INPUT, format!("{path:?} is not an absolute path"));
    }
    let canon = match std::fs::canonicalize(path) {
        Ok(c) => c,
        Err(e) => return fail(EXIT_INPUT, format!("{path:?}: {e}")),
    };
    // Byte comparison: Path equality would treat "/a/./b" and "/a//b" as "/a/b".
    if canon.as_os_str().as_bytes() != path.as_bytes() {
        return fail(
            EXIT_INPUT,
            format!("{path:?} is not canonical (it resolves to {:?}); pass the resolved path", canon),
        );
    }
    let c = match CString::new(Path::new(path).as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(_) => return fail(EXIT_INPUT, format!("{path:?} contains a NUL byte")),
    };
    // SAFETY: c is a valid NUL-terminated path.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 {
        return fail(EXIT_INPUT, format!("{path:?}: {}", os_err(errno())));
    }
    // SAFETY: fd is open; st is a plain struct the kernel fills.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } < 0 {
        let e = errno();
        unsafe { libc::close(fd) };
        return fail(EXIT_INPUT, format!("{path:?}: {}", os_err(e)));
    }
    let fmt = st.st_mode & libc::S_IFMT;
    let problem = match kind {
        Kind::Dir if fmt != libc::S_IFDIR => Some("is not a directory".to_string()),
        Kind::File if fmt == libc::S_IFDIR => {
            Some("is a directory; list it under dirs or rw_trees, not files".to_string())
        }
        Kind::File if fmt == libc::S_IFREG && st.st_nlink != 1 => Some(format!(
            "has {} hard links; a write right on it would reach every other name for the same file",
            st.st_nlink
        )),
        Kind::File if fmt != libc::S_IFREG && fmt != libc::S_IFCHR => {
            Some("is not a regular file or a character device".to_string())
        }
        _ => None,
    };
    if let Some(p) = problem {
        unsafe { libc::close(fd) };
        return fail(EXIT_INPUT, format!("{path:?} {p}"));
    }
    Ok(fd)
}

/// Every (path, kind, rights) the ruleset grants, the rights masked to what this ABI handles.
fn wanted(rs: &Ruleset, handled: u64) -> Vec<(&str, Kind, u64)> {
    let mut out: Vec<(&str, Kind, u64)> = Vec::new();
    for f in &rs.files {
        out.push((f, Kind::File, FILE_RIGHTS & handled));
    }
    for d in &rs.dirs {
        let mut rights = DIR_RIGHTS;
        if d.make_dir {
            rights |= MAKE_DIR;
        }
        if d.remove {
            rights |= REMOVE_RIGHTS;
        }
        out.push((&d.path, Kind::Dir, rights & handled));
    }
    for t in &rs.rw_trees {
        out.push((t, Kind::Dir, rw_tree_rights(handled) & handled));
    }
    out
}

/// Builds the ruleset before anything is enforced. Each rule path is opened with O_PATH, added
/// and closed again at once, as the kernel's own example closes `parent_fd` right after
/// `landlock_add_rule`: the rule holds the object, not the descriptor. So the helper holds two
/// descriptors here however many rules there are. Returns the ruleset descriptor.
fn ruleset_for(rs: &Ruleset, abi: i64) -> Result<i32, Fail> {
    let handled = handled_fs(abi);
    let attr = RulesetAttr { handled_access_fs: handled, handled_access_net: 0, scoped: scoped(abi) };
    // SAFETY: attr is a valid landlock_ruleset_attr prefix of the size passed.
    let ruleset = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0u32,
        )
    };
    if ruleset < 0 {
        return fail(EXIT_SANDBOX, format!("landlock_create_ruleset: {}", os_err(errno())));
    }
    let ruleset = ruleset as i32;
    let add = |path: &str, kind: Kind, rights: u64| -> Result<(), Fail> {
        let fd = open_for_rule(path, kind)?;
        let mut err = None;
        if rights != 0 {
            let rule = PathBeneathAttr { allowed_access: rights, parent_fd: fd };
            // SAFETY: rule is a valid packed landlock_path_beneath_attr.
            let r = unsafe {
                libc::syscall(
                    libc::SYS_landlock_add_rule,
                    ruleset,
                    RULE_PATH_BENEATH,
                    &rule as *const PathBeneathAttr,
                    0u32,
                )
            };
            if r < 0 {
                err = Some(errno());
            }
        }
        // SAFETY: fd is the O_PATH descriptor open_for_rule returned; nothing else holds it.
        unsafe { libc::close(fd) };
        match err {
            Some(e) => fail(EXIT_SANDBOX, format!("landlock_add_rule {path:?}: {}", os_err(e))),
            None => Ok(()),
        }
    };
    for (path, kind, rights) in wanted(rs, handled) {
        if let Err(e) = add(path, kind, rights) {
            // SAFETY: ruleset is the descriptor landlock_create_ruleset returned.
            unsafe { libc::close(ruleset) };
            return Err(e);
        }
    }
    Ok(ruleset)
}

fn enforce(abi: i64, ruleset: i32) -> Result<(), Fail> {
    // SAFETY: plain prctl and syscall with integer arguments.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } < 0 {
        return fail(EXIT_SANDBOX, format!("prctl(PR_SET_NO_NEW_PRIVS): {}", os_err(errno())));
    }
    if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32) } < 0 {
        return fail(EXIT_SANDBOX, format!("landlock_restrict_self: {}", os_err(errno())));
    }
    unsafe { libc::close(ruleset) };
    if abi < RESOLVE_UNIX_ABI {
        install_socket_filter()?;
    }
    Ok(())
}

fn run() -> Result<(), Fail> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [] => {}
        [a] if a == "--abi" => {
            let abi = running_abi();
            println!("{}", abi.unwrap_or(0));
            let _ = io::stdout().flush();
            return classify(abi).map(|_| ());
        }
        _ => return fail(EXIT_INPUT, "usage: pair-landlock [--abi]  (ruleset JSON on the first line of stdin)"),
    }
    let abi = classify(running_abi())?;
    let rs = parse(&read_ruleset_line()?)?;
    let ruleset = ruleset_for(&rs, abi)?;
    // Block the signals the supervisor waits for before the child exists, so none is lost and
    // none kills the supervisor before it can end what the command started.
    let (wait_set, old_mask) = block_supervisor_signals();
    // SAFETY: plain prctl with integer arguments.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } < 0 {
        return fail(EXIT_SANDBOX, format!("prctl(PR_SET_CHILD_SUBREAPER): {}", os_err(errno())));
    }
    // SAFETY: the helper is single-threaded here, so the child may run any code before exec.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return fail(EXIT_SANDBOX, format!("fork: {}", os_err(errno())));
    }
    if child == 0 {
        // The subreaper attribute is not inherited across fork; the mask is, so restore it.
        // SAFETY: old_mask is the mask sigprocmask returned.
        unsafe { libc::sigprocmask(libc::SIG_SETMASK, &old_mask, std::ptr::null_mut()) };
        enforce(abi, ruleset)?;
        let err = Command::new("/bin/sh").arg("-c").arg(&rs.command).exec();
        return fail(EXIT_EXEC, format!("exec /bin/sh: {err}"));
    }
    // SAFETY: closes the supervisor's copy of the ruleset descriptor.
    unsafe { libc::close(ruleset) };
    // stdin belongs to the command alone: a writer sees EPIPE once the command stops reading.
    // SAFETY: closing fd 0 affects nothing else in this process.
    unsafe { libc::close(0) };
    let ended = supervise(child, &wait_set);
    end_descendants();
    exit_like(ended)
}

/// The signals that end a run early. The supervisor also waits for SIGCHLD.
const STOP_SIGNALS: [i32; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

/// Blocks SIGCHLD and STOP_SIGNALS; returns that set and the mask before it.
fn block_supervisor_signals() -> (libc::sigset_t, libc::sigset_t) {
    // SAFETY: sigset_t is a plain bit set that sigemptyset initialises.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        let mut old: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGCHLD);
        for s in STOP_SIGNALS {
            libc::sigaddset(&mut set, s);
        }
        libc::sigprocmask(libc::SIG_BLOCK, &set, &mut old);
        (set, old)
    }
}

/// How the run ended: the command's wait status, or a stop signal that reached the supervisor
/// while the command was still running.
enum Ended {
    Status(i32),
    Stopped(i32),
}

/// Waits until the command exits or a stop signal arrives, reaping every child on the way:
/// orphans that left the process group are reparented to this subreaper and end here too.
fn supervise(main: libc::pid_t, wait_set: &libc::sigset_t) -> Ended {
    loop {
        loop {
            let mut st = 0;
            // SAFETY: waitpid with a valid status pointer.
            let r = unsafe { libc::waitpid(-1, &mut st, libc::WNOHANG) };
            if r == main {
                return Ended::Status(st);
            }
            if r <= 0 {
                break;
            }
        }
        // SAFETY: wait_set holds signals this thread has blocked.
        let sig = unsafe { libc::sigwaitinfo(wait_set, std::ptr::null_mut()) };
        if STOP_SIGNALS.contains(&sig) {
            return Ended::Stopped(sig);
        }
    }
}

/// The parent pid and state from the text of /proc/<pid>/stat. The command name in field 2 may
/// itself hold spaces and parentheses, so parsing starts after its last `)`.
fn stat_ppid(stat: &[u8]) -> Option<libc::pid_t> {
    let close = stat.iter().rposition(|&b| b == b')')?;
    let rest = std::str::from_utf8(&stat[close + 1..]).ok()?;
    let mut fields = rest.split_ascii_whitespace();
    fields.next()?;
    fields.next()?.parse().ok()
}

/// Every live descendant of `me`, from the parent links in /proc.
fn descendants(me: libc::pid_t) -> Vec<libc::pid_t> {
    let mut parent: HashMap<libc::pid_t, libc::pid_t> = HashMap::new();
    if let Ok(dir) = std::fs::read_dir("/proc") {
        for e in dir.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<libc::pid_t>().ok()) else { continue };
            if let Some(ppid) = std::fs::read(format!("/proc/{pid}/stat")).ok().as_deref().and_then(stat_ppid) {
                parent.insert(pid, ppid);
            }
        }
    }
    descendants_in(&parent, me)
}

fn descendants_in(parent: &HashMap<libc::pid_t, libc::pid_t>, me: libc::pid_t) -> Vec<libc::pid_t> {
    let mut out: Vec<libc::pid_t> = parent
        .keys()
        .copied()
        .filter(|&p| {
            let mut q = p;
            // Bounded, in case pid reuse during the scan made a cycle.
            for _ in 0..=parent.len() {
                match parent.get(&q) {
                    Some(&pp) if pp == me => return true,
                    Some(&pp) if pp > 1 => q = pp,
                    _ => return false,
                }
            }
            false
        })
        .collect();
    out.sort_unstable();
    out
}

/// Kills every remaining descendant and reaps them until this process has no child left. A
/// process killed while it had children leaves them to this subreaper, and the next scan finds
/// them, so the loop ends only when the whole tree the command started is gone.
fn end_descendants() {
    // SAFETY: getpid cannot fail.
    let me = unsafe { libc::getpid() };
    loop {
        for pid in descendants(me) {
            // SAFETY: plain kill; ESRCH for a process that already ended is harmless.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
        let mut reaped = false;
        loop {
            let mut st = 0;
            // SAFETY: waitpid with a valid status pointer.
            let r = unsafe { libc::waitpid(-1, &mut st, libc::WNOHANG) };
            if r > 0 {
                reaped = true;
                continue;
            }
            if r < 0 && errno() == libc::ECHILD {
                return;
            }
            break;
        }
        if !reaped {
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }
}

/// Exits with the command's exit code, or with 128 plus the number of the signal that ended the
/// command (or that ended the run), as a shell reports it. The helper never dies of a signal by
/// its own choice, so a caller that sees it die of one knows it was killed by a signal it does
/// not handle (SIGKILL among them) before it could end what the command left behind.
fn exit_like(ended: Ended) -> ! {
    match ended {
        Ended::Status(st) if libc::WIFEXITED(st) => std::process::exit(libc::WEXITSTATUS(st)),
        Ended::Status(st) => std::process::exit(128 + libc::WTERMSIG(st)),
        Ended::Stopped(sig) => std::process::exit(128 + sig),
    }
}

fn main() {
    if let Err(Fail(code, msg)) = run() {
        let _ = writeln!(io::stderr(), "pair-landlock: {msg}");
        std::process::exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_below_three_or_missing_is_unsupported() {
        let code = |r: Result<i64, Fail>| match r {
            Ok(abi) => abi as i32,
            Err(Fail(c, _)) => -c,
        };
        assert_eq!(code(classify(Err(libc::ENOSYS))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Err(libc::EOPNOTSUPP))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Ok(1))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Ok(2))), -EXIT_UNSUPPORTED);
        assert_eq!(code(classify(Ok(3))), 3);
        assert_eq!(code(classify(Ok(6))), 6);
    }

    #[test]
    fn handled_rights_follow_the_abi() {
        assert_eq!(handled_fs(3) & REFER, REFER);
        assert_eq!(handled_fs(3) & TRUNCATE, TRUNCATE);
        assert_eq!(handled_fs(2) & TRUNCATE, 0);
        assert_eq!(handled_fs(8) & RESOLVE_UNIX, 0);
        assert_eq!(handled_fs(9) & RESOLVE_UNIX, RESOLVE_UNIX);
        assert_eq!(handled_fs(4) & IOCTL_DEV, 0);
        assert_eq!(handled_fs(5) & IOCTL_DEV, IOCTL_DEV);
        // Reading, listing and executing are never handled, so they stay allowed.
        assert_eq!(handled_fs(99) & 0b1101, 0);
        assert_eq!(scoped(5), 0);
        assert_eq!(scoped(6), SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL);
    }

    /// A classic-BPF interpreter for the opcodes socket_filter uses, over one seccomp_data.
    fn run_filter(prog: &[(u16, u8, u8, u32)], arch: u32, nr: u32, arg0: u32) -> u32 {
        let mut acc = 0u32;
        let mut pc = 0usize;
        loop {
            let (code, jt, jf, k) = prog[pc];
            pc += 1;
            match code {
                BPF_LD_W_ABS => {
                    acc = match k {
                        OFF_NR => nr,
                        OFF_ARCH => arch,
                        OFF_ARG0_LOW => arg0,
                        _ => panic!("unexpected load offset {k}"),
                    }
                }
                BPF_JMP_JEQ_K => pc += if acc == k { jt } else { jf } as usize,
                BPF_JMP_JGE_K => pc += if acc >= k { jt } else { jf } as usize,
                BPF_RET_K => return k,
                _ => panic!("unexpected opcode {code:#x}"),
            }
        }
    }

    #[test]
    fn the_socket_filter_refuses_unix_sockets_and_io_uring_only() {
        for a in [&ARCH_X86_64, &ARCH_AARCH64] {
            let p = socket_filter(a);
            assert_eq!(run_filter(&p, a.audit, a.socket, AF_UNIX), RET_EPERM);
            assert_eq!(run_filter(&p, a.audit, a.socket, 2), RET_ALLOW, "AF_INET");
            assert_eq!(run_filter(&p, a.audit, a.socket, 10), RET_ALLOW, "AF_INET6");
            assert_eq!(run_filter(&p, a.audit, a.socket, 16), RET_ALLOW, "AF_NETLINK");
            assert_eq!(run_filter(&p, a.audit, a.io_uring_setup, 0), RET_EPERM);
            assert_eq!(run_filter(&p, a.audit, 0, AF_UNIX), RET_ALLOW, "read with a 1 in arg0");
            assert_eq!(run_filter(&p, 0x4000_0003, a.socket, 2), RET_EPERM, "i386 audit arch");
        }
        // socketpair: x86_64 53, arm64 199.
        assert_eq!(run_filter(&socket_filter(&ARCH_X86_64), ARCH_X86_64.audit, 53, AF_UNIX), RET_ALLOW);
        assert_eq!(run_filter(&socket_filter(&ARCH_AARCH64), ARCH_AARCH64.audit, 199, AF_UNIX), RET_ALLOW);
        let x = socket_filter(&ARCH_X86_64);
        assert_eq!(run_filter(&x, ARCH_X86_64.audit, 0x4000_0000 | 41, 2), RET_EPERM, "x32 socket");
        assert_eq!(run_filter(&x, ARCH_X86_64.audit, 0x4000_0000, 0), RET_EPERM, "x32 read");
    }

    #[test]
    fn the_socket_filter_matches_bwrap_mjs_instruction_for_instruction() {
        // lib/bwrap.mjs seccompFilter("x64") and seccompFilter("arm64"), as (code, jt, jf, k).
        let x86 = vec![
            (0x20, 0, 0, 4), (0x15, 1, 0, 0xc000_003e), (0x06, 0, 0, 0x0005_0001), (0x20, 0, 0, 0),
            (0x35, 0, 1, 0x4000_0000), (0x06, 0, 0, 0x0005_0001),
            (0x15, 0, 1, 425), (0x06, 0, 0, 0x0005_0001), (0x15, 0, 3, 41), (0x20, 0, 0, 16),
            (0x15, 0, 1, 1), (0x06, 0, 0, 0x0005_0001), (0x06, 0, 0, 0x7fff_0000),
        ];
        let arm = vec![
            (0x20, 0, 0, 4), (0x15, 1, 0, 0xc000_00b7), (0x06, 0, 0, 0x0005_0001), (0x20, 0, 0, 0),
            (0x15, 0, 1, 425), (0x06, 0, 0, 0x0005_0001), (0x15, 0, 3, 198), (0x20, 0, 0, 16),
            (0x15, 0, 1, 1), (0x06, 0, 0, 0x0005_0001), (0x06, 0, 0, 0x7fff_0000),
        ];
        assert_eq!(socket_filter(&ARCH_X86_64), x86);
        assert_eq!(socket_filter(&ARCH_AARCH64), arm);
    }

    #[test]
    fn refer_and_remove_come_only_with_a_remove_dirs_entry() {
        for abi in 3..=12 {
            let h = handled_fs(abi);
            assert_eq!(rw_tree_rights(h) & REFER, 0);
            assert_eq!(rw_tree_rights(h) & RESOLVE_UNIX, 0);
            // Device ioctls are handled from ABI 5 and granted by no kind of rule.
            assert_eq!((rw_tree_rights(h) | DIR_RIGHTS | MAKE_DIR | REMOVE_RIGHTS | FILE_RIGHTS) & IOCTL_DEV, 0);
            assert_eq!((DIR_RIGHTS | MAKE_DIR | FILE_RIGHTS) & (REFER | REMOVE_FILE), 0);
            assert_eq!(REMOVE_RIGHTS & h, REMOVE_FILE | REFER);
        }
        // Directories are never removable or renamable, even under a remove entry.
        assert_eq!(REMOVE_RIGHTS & (REMOVE_DIR | MAKE_SYM), 0);
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let p = base.to_str().unwrap();
        let line = format!(r#"{{"command":"true","dirs":[{{"path":"{p}"}},{{"path":"{p}","remove":true}},{{"path":"{p}","make_dir":true,"remove":true}}]}}"#);
        let rights: Vec<u64> = wanted(&parse(line.as_bytes()).ok().unwrap(), handled_fs(6)).iter().map(|r| r.2).collect();
        assert_eq!(rights, vec![DIR_RIGHTS, DIR_RIGHTS | REMOVE_RIGHTS, DIR_RIGHTS | MAKE_DIR | REMOVE_RIGHTS]);
    }

    #[test]
    fn parse_rejects_unknown_fields_and_empty_commands() {
        assert!(parse(br#"{"command":"true"}"#).is_ok());
        assert!(parse(br#"{"command":"true","dirs":[{"path":"/x","make_dir":true}]}"#).is_ok());
        assert!(parse(br#"{"command":"true","dirs":[{"path":"/x","remove":true}]}"#).is_ok());
        assert!(parse(br#"{"command":"true","refer":["/x"]}"#).is_err());
        assert!(parse(br#"{"command":"true","dirs":[{"path":"/x","refer":true}]}"#).is_err());
        assert!(parse(br#"{"command":""}"#).is_err());
        assert!(parse(br#"{"files":[]}"#).is_err());
    }

    #[test]
    fn stat_parsing_survives_odd_command_names() {
        assert_eq!(stat_ppid(b"42 (sh) S 7 42 42 0 -1"), Some(7));
        assert_eq!(stat_ppid(b"42 (a) b) (c) R 9 1 1"), Some(9));
        assert_eq!(stat_ppid(b"42 (x y) Z 1 0 0"), Some(1));
        assert_eq!(stat_ppid(b"garbage"), None);
    }

    #[test]
    fn descendants_follow_parent_links_to_any_depth() {
        // 10 is the helper; 11 its child; 12 an orphan reparented to it; 13 under 11; 20 and
        // 21 belong to someone else; 30 and 31 point at each other (pid reuse mid-scan).
        let parent: HashMap<libc::pid_t, libc::pid_t> =
            [(10, 1), (11, 10), (12, 10), (13, 11), (14, 13), (20, 1), (21, 20), (30, 31), (31, 30)].into_iter().collect();
        assert_eq!(descendants_in(&parent, 10), vec![11, 12, 13, 14]);
        assert_eq!(descendants_in(&parent, 20), vec![21]);
        assert_eq!(descendants_in(&parent, 99), Vec::<libc::pid_t>::new());
    }

    #[test]
    fn rule_paths_must_be_absolute_canonical_and_the_right_kind() {
        let base = std::env::temp_dir().join(format!("pair-landlock-test-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let base = std::fs::canonicalize(&base).unwrap();
        let file = base.join("f");
        std::fs::write(&file, b"x").unwrap();
        let link = base.join("l");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&file, &link).unwrap();
        let hard = base.join("h");
        let other = base.join("o");
        std::fs::write(&hard, b"x").unwrap();
        let _ = std::fs::remove_file(&other);
        std::fs::hard_link(&hard, &other).unwrap();
        let s = |p: &Path| p.to_str().unwrap().to_string();
        let code = |r: Result<i32, Fail>| match r {
            Ok(fd) => {
                unsafe { libc::close(fd) };
                0
            }
            Err(Fail(c, _)) => c,
        };
        assert_eq!(code(open_for_rule(&s(&file), Kind::File)), 0);
        assert_eq!(code(open_for_rule(&s(&base), Kind::Dir)), 0);
        assert_eq!(code(open_for_rule("relative/path", Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&link), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&format!("{}/./f", s(&base)), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&format!("{}//f", s(&base)), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&format!("{}/", s(&base)), Kind::Dir)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&base), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&file), Kind::Dir)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&hard), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule(&s(&base.join("missing")), Kind::File)), EXIT_INPUT);
        assert_eq!(code(open_for_rule("/dev/null", Kind::File)), 0);
        std::fs::remove_dir_all(&base).unwrap();
    }
}
