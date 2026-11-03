# agent-system 2.0 (wl-mv65t5d34lts00 PLAN.md § 8.3): print one process's physical footprint in KiB, the figure
# install/phoenix-run.sh's memory cap compares, read with proc_pid_rusage(RUSAGE_INFO_V2) from libSystem.
#
# Why the footprint and not `ps -o rss=`: RSS counts only the pages resident right now, and macOS moves a
# process's pages into the memory compressor or swap under pressure. On Jo's machine (2026-10-14) a process
# holding 768 MiB of random bytes showed 124 MiB resident and a footprint of 792560 KiB, and a fake Phoenix
# holding 3 GiB never had an RSS sample above 326 MiB, so an RSS cap never fired. The footprint counts what the
# process holds wherever the kernel keeps it (the figure Activity Monitor's Memory column shows).
#
# Usage: <python> -I -S phoenix-footprint.py <pid>
# Out:   the footprint in KiB on stdout, exit 0; or one line on stderr and exit 1 (the call failed: no such
#        process, not permitted) or 2 (usage). phoenix-run.sh runs it with Phoenix's own Python once per second.
import ctypes
import os
import sys

RUSAGE_INFO_V2 = 2
# struct rusage_info_v2 (<sys/resource.h>) as 64-bit words: ri_uuid takes words 0-1, then ri_user_time,
# ri_system_time, ri_pkg_idle_wkups, ri_interrupt_wkups, ri_pageins, ri_wired_size, ri_resident_size (2-8),
# so ri_phys_footprint is word 9. The struct is 20 words; the buffer is larger so no version can overrun it.
PHYS_FOOTPRINT_WORD = 9


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not argv[1].isdigit():
        print("usage: phoenix-footprint.py <pid>", file=sys.stderr)
        return 2
    pid = int(argv[1])
    words = (ctypes.c_uint64 * 32)()
    libsystem = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    if libsystem.proc_pid_rusage(pid, RUSAGE_INFO_V2, words) != 0:
        err = ctypes.get_errno()
        print(f"proc_pid_rusage({pid}) failed: errno {err} ({os.strerror(err)})", file=sys.stderr)
        return 1
    print(words[PHYS_FOOTPRINT_WORD] >> 10)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
