#!/bin/sh
# 交叉编译 packages/finalize-fs（Rust sidecar）到 HarmonyOS aarch64。
#
# 为什么不用 `--target aarch64-unknown-linux-musl`：brew 的 rust 自带
# `aarch64-unknown-linux-ohos` 目标（1.100.0 实测），直接用它与系统 libc 对齐。
#
# 三个必须的特殊处理（都是本机实测踩出来的，别删）：
#   1. **linker 必须用 CLT 的 clang**：brew 那份 ohos-sdk 的 lld 缺 libxml2.so.16，
#      一链接就 "Error loading shared library libxml2.so.16"。
#      于是写了个 `toolchain/ohos-cc` 垫片：只把 CLT 的 llvm/bin 放进 PATH 再 exec clang
#      （clang 按 PATH 找 ld.lld，PATH 顺序决定用谁的）。
#   2. **linker 名字要以 cc 结尾**：rustc 靠 linker 文件名判断 flavor；名字不像 cc/clang
#      时会按裸 ld 传参（`--as-needed` 直接给 clang，报 unsupported option）。
#   3. **RUSTC_WRAPPER 给每个产物自签名**：cargo 会编出 build-script / proc-macro 这类
#      要当场执行的 ELF，未签名在鸿蒙上 exec 会 EPERM（Operation not permitted）。
#      另外 OHOS clang 会留一个**占位** .codesign 段，签名工具见到会拒绝 ⇒ 先剥段再签。
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/hmos-env.sh"
export PATH="/storage/Users/currentUser/.harmonybrew/bin:$PATH"

export CARGO_HOME="${CARGO_HOME:-/data/storage/el2/base/haps/entry/files/cargo-home}"
mkdir -p "$CARGO_HOME"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_OHOS_LINKER="$HERE/toolchain/ohos-cc"
export RUSTC_WRAPPER="$HERE/toolchain/rustc-sign-wrapper.sh"

cd "$ROOT/vendor/motrix/packages/finalize-fs"
cargo build --release --target aarch64-unknown-linux-ohos

OUT="$ROOT/vendor/motrix/packages/finalize-fs/target/aarch64-unknown-linux-ohos/release/motrix-finalize-fs"
[ -f "$OUT" ] || { echo "编完却没产物：$OUT" >&2; exit 1; }
mkdir -p "$ROOT/build/bin"
# 目标文件可能已被 sign-elf 用 mv 覆盖过（封存态）⇒ 先删后铺
rm -f "$ROOT/build/bin/motrix-finalize-fs"
cp "$OUT" "$ROOT/build/bin/motrix-finalize-fs.new"
mv "$ROOT/build/bin/motrix-finalize-fs.new" "$ROOT/build/bin/motrix-finalize-fs"
echo "[finalize-fs] 产物: $ROOT/build/bin/motrix-finalize-fs"
"$OHOS_TOOLBIN/llvm-readelf" -d "$ROOT/build/bin/motrix-finalize-fs" 2>/dev/null | grep -i needed || true
ls -l "$ROOT/build/bin/motrix-finalize-fs"