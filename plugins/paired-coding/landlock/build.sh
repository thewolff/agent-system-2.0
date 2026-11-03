#!/bin/sh
# Rebuild the two static pair-landlock binaries from source in the pinned official Rust image,
# then write SHA256SUMS. Both targets link with rust-lld against Rust's bundled musl. The build
# always runs on linux/amd64 (emulated on an arm64 machine): the same source built by the
# arm64 toolchain gives different bytes, and CI's rebuild on an x86_64 runner must match the
# committed SHA256SUMS exactly.
#
#   sh build.sh            rebuild bin/ and SHA256SUMS in place
#   sh build.sh <outdir>   build into <outdir> (bin/ and SHA256SUMS there), leave these alone
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here}
mkdir -p "$out/bin"
out=$(cd "$out" && pwd)
image="rust:1.99.0-bookworm@sha256:114c7a4425406451c2866b6aafe69fe29b1b298832db1277d411ac73c82d04d6"

docker run --rm --platform linux/amd64 \
  -v "$here":/src:ro \
  -v "$out":/out \
  -e CARGO_TARGET_DIR=/tmp/target \
  -w /src \
  "$image" sh -euc '
    rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl >/dev/null 2>&1
    export RUSTFLAGS="-C linker=rust-lld -C target-feature=+crt-static --remap-path-prefix=/src=pair-landlock --remap-path-prefix=$CARGO_HOME=cargo"
    export SOURCE_DATE_EPOCH=0
    for arch in x86_64 aarch64; do
      cargo build --locked --release --target "$arch-unknown-linux-musl"
      cp "/tmp/target/$arch-unknown-linux-musl/release/pair-landlock" "/out/bin/pair-landlock-$arch-linux"
    done
    cd /out && sha256sum bin/pair-landlock-x86_64-linux bin/pair-landlock-aarch64-linux > SHA256SUMS
  '
cat "$out/SHA256SUMS"
