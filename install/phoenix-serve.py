# agent-system 2.0: Phoenix on loopback only (wl-mv65t5d34lts00, PLAN.md § 3 "The Phoenix LaunchAgent").
#
# Runs Phoenix's own CLI entry point (`phoenix serve`) with two changes and nothing else edited:
#  - PHOENIX_HOST is forced to 127.0.0.1 (Phoenix's default is 0.0.0.0, phoenix/config.py).
#  - grpc.aio.server is wrapped so the server it returns rewrites a "[::]:N" or "0.0.0.0:N" address
#    passed to add_insecure_port or add_secure_port to "127.0.0.1:N". Phoenix 20.3.0 binds its OTLP
#    gRPC receiver at "[::]:<PHOENIX_GRPC_PORT>" whatever PHOENIX_HOST says
#    (phoenix/server/grpc_server.py, the two server.add_*_port calls after grpc.aio.server(...)).
# It refuses to start (exit 78, EX_CONFIG) unless the installed Phoenix is the version this shim was
# checked against, so an upgrade fails closed rather than open. install/phoenix-run.sh runs it with
# the arize-phoenix uv tool's Python and checks the listeners for the process's whole life.
#
# Usage: <arize-phoenix python> phoenix-serve.py [extra `phoenix serve` arguments]
import os
import sys

CHECKED_VERSION = "20.3.0"
EX_CONFIG = 78
LOOPBACK = "127.0.0.1"


def log(message: str) -> None:
    print(f"phoenix-serve: {message}", file=sys.stderr, flush=True)


def loopback(address: str) -> str:
    for wildcard in ("[::]:", "0.0.0.0:"):
        if address.startswith(wildcard):
            return LOOPBACK + ":" + address[len(wildcard):]
    return address


def main() -> None:
    from importlib.metadata import PackageNotFoundError, version

    try:
        found = version("arize-phoenix")
    except PackageNotFoundError:
        log("arize-phoenix is not installed in this Python; refusing to start")
        sys.exit(EX_CONFIG)
    if found != CHECKED_VERSION:
        log(f"arize-phoenix is {found}; this shim was checked against {CHECKED_VERSION} only; refusing to start")
        sys.exit(EX_CONFIG)

    # Before Phoenix reads its config.
    os.environ["PHOENIX_HOST"] = LOOPBACK

    import grpc.aio

    real_server = grpc.aio.server

    def loopback_server(*args, **kwargs):
        server = real_server(*args, **kwargs)
        insecure, secure = server.add_insecure_port, server.add_secure_port

        def add_insecure_port(address, *rest, **kw):
            bound = loopback(address)
            log(f"gRPC add_insecure_port {address} -> {bound}")
            return insecure(bound, *rest, **kw)

        def add_secure_port(address, *rest, **kw):
            bound = loopback(address)
            log(f"gRPC add_secure_port {address} -> {bound}")
            return secure(bound, *rest, **kw)

        server.add_insecure_port = add_insecure_port
        server.add_secure_port = add_secure_port
        return server

    grpc.aio.server = loopback_server

    from phoenix.server.main import main as phoenix_main

    sys.argv = ["phoenix", "serve", *sys.argv[1:]]
    phoenix_main()


if __name__ == "__main__":
    main()
