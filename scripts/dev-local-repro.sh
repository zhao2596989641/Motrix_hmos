#!/bin/sh
# 本机用**真实 libnode** 跑端侧宿主 —— 设备调试的替代品。
#
# 为什么需要它：设备上 Node 是 HAP 内同进程起来的（libnode.so.137 + --jitless），
# 而本机的 brew node / CLT node 是**另一种** Node 构建，很多"只在 libnode 上出现"的
# 问题在它们上面**复现不了**（本次 W^X/undici 崩溃就是典型：brew node 全正常，
# libnode 上一 import server 就死）。
#
# 做法：编一个 40KB 的 C 壳 `node-launcher`（dlopen libnode → dlsym node::Start），
# 于是本机能用**同一个** libnode、同样的 argv 跑端侧入口脚本。
#
# 用法：
#   sh scripts/dev-local-repro.sh                # 用 resfile/app 当前内容跑一次
#   sh scripts/dev-local-repro.sh --shell        # 起一个交互式 node（跑小实验）
#
# 产物与日志：build/local-repro/{run.log,motrix/}
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/hmos-env.sh"
export PATH="/storage/Users/currentUser/.harmonybrew/bin:$PATH"

L="$ROOT/build/native/launcher"
APP="$ROOT/entry/src/main/resources/resfile/app"
WORK="$ROOT/build/local-repro"

mkdir -p "$L" "$WORK"
# libnode + libc++_shared 必须与壳同目录（壳按 $ORIGIN 找），且**必须自签名**
# （从用户盘 dlopen 未签名 .so = Permission denied，与设备上 el1 bundle 的规矩不同）
# libnode 是自包含的（libc++ 已静态并入），所以只拷它；libc++_shared 若存在也一并放（可选）
if [ ! -f "$L/libnode.so.137" ]; then
  cp "$ROOT/entry/libs/arm64-v8a/libnode.so.137" "$L/libnode.so.137"
fi
if [ ! -f "$L/libc++_shared.so" ] && [ -f "$ROOT/entry/libs/arm64-v8a/libc++_shared.so" ]; then
  cp "$ROOT/entry/libs/arm64-v8a/libc++_shared.so" "$L/libc++_shared.so"
  sh "$HERE/sign-elf.sh" "$L/libc++_shared.so" >/dev/null 2>&1 || true
fi

# 编壳（幂等）
if [ ! -f "$L/node-launcher" ] || [ "${FORCE_LAUNCHER:-0}" = "1" ]; then
  "$OHOS_TOOLBIN/clang" --target=aarch64-linux-ohos -O2 -fno-emulated-tls -D__MUSL__ \
    -o "$L/node-launcher" "$HERE/toolchain/node-launcher.c" -ldl -Wl,-rpath,'$ORIGIN'
  sh "$HERE/sign-elf.sh" "$L/node-launcher" >/dev/null
fi
# libnode 首次要签（126MB，签一次要十几秒；已签则跳过）
if ! "$OHOS_TOOLBIN/llvm-readelf" -S "$L/libnode.so.137" 2>/dev/null | grep -q '\.codesign'; then
  echo "[repro] 首次签名 libnode（约 10–20s）…"
  sh "$HERE/sign-elf.sh" "$L/libnode.so.137"
fi

export MOTRIX_LIBNODE="$L/libnode.so.137"

# 交互模式：直接开一个 node，方便跑小实验
if [ "${1:-}" = "--shell" ]; then
  cd "$L"
  shift
  exec ./node-launcher --jitless --experimental-sqlite "$@"
fi

# 正常模式：跑端侧入口
# better-sqlite3 必须用 **device 变体**（带 DT_NEEDED libnode.so.137）：
# host 变体在 libnode 里 dlopen 会报 `Error relocating … napi_*: symbol not found`。
#
# ★ 放进 entry/libs/arm64-v8a/libbetter_sqlite3.so 并设 MOTRIX_NATIVE_LIBS，
#   模拟真机的"沙箱 dlopen 被拦"：即使 resfile 里没有 .node，重定向也能把它从 libs/ 加载。
DEV_NODE="$ROOT/build/native/device/better_sqlite3.node"
FLAT_LIB="$ROOT/entry/libs/arm64-v8a/libbetter_sqlite3.so"
if [ -f "$DEV_NODE" ]; then
  rm -f "$FLAT_LIB" "$FLAT_LIB.tmp"
  cp "$DEV_NODE" "$FLAT_LIB.tmp"
  mv "$FLAT_LIB.tmp" "$FLAT_LIB"
  chmod 755 "$FLAT_LIB"
  # 沙箱里不留真 .node：真机路径本来就是 load 不了的，这里也按同样的约束跑
  rm -f "$APP/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
else
  echo "[repro] 警告：缺 device 变体 better_sqlite3.node，先跑 sh scripts/build-better-sqlite3.sh --variant=device"
fi

# ── 本地可执行 bin：**必须自签**，不能直接跑 entry/libs 里那份 ────────────────
#
# `entry/libs/arm64-v8a/{aria2c.bin,motrix-finalize-fs.bin}` 是用**应用自己的证书**
# 签的（真机 hap-bin 要求；见 docs/RUNTIME.md）。但本地 repro 跑在 参考宿主项目 的
# `develop_tools_debug_hap` 域，XPM 会核对 owner：
#   · 自签（binary-sign-tool -selfSign 1）→ 可以 exec；
#   · 别的应用证书签 → execve EPERM；
#   · 完全没签 → execve EACCES。
# 所以这里复制一份到 build/local-repro/bin 再自签，并通过 MOTRIX_*_BIN 指过去；
# entry/libs 里那份保持应用证书签名，给真机 HAP 用，两边互不污染。
REPRO_BIN="$WORK/bin"
mkdir -p "$REPRO_BIN"
for pair in "aria2c:aria2c.bin" "motrix-finalize-fs:motrix-finalize-fs.bin"; do
  plain_name=${pair%%:*}
  lib_name=${pair#*:}
  dst="$REPRO_BIN/$plain_name"
  src="$ROOT/entry/libs/arm64-v8a/$lib_name"
  if [ -f "$src" ]; then
    if ! "$OHOS_TOOLBIN/llvm-readelf" -S "$dst" 2>/dev/null | grep -q '\.codesign'; then
      rm -f "$dst" "$dst.tmp"
      cp "$src" "$dst.tmp"
      chmod 755 "$dst.tmp"
      mv "$dst.tmp" "$dst"
      # sign-elf.sh 会先剥 .codesign/.permission 再自签
      sh "$HERE/sign-elf.sh" "$dst" >/dev/null
    fi
  else
    echo "[repro] 警告：缺 $src（先跑 sh scripts/build-hap.sh）"
  fi
done
REPRO_ARIA2="$REPRO_BIN/aria2c"
REPRO_FINALIZE="$REPRO_BIN/motrix-finalize-fs"

rm -rf "$WORK/motrix"
cd "$WORK"
MOTRIX_SANDBOX_HOME="$WORK" \
MOTRIX_APP_ROOT="$APP" \
MOTRIX_DATA_DIR="$WORK/motrix" \
MOTRIX_NATIVE_LIBS="$ROOT/entry/libs/arm64-v8a" \
MOTRIX_ARIA2_BIN="$REPRO_ARIA2" \
MOTRIX_FINALIZE_FS_BIN="$REPRO_FINALIZE" \
MOTRIX_PORT="${MOTRIX_PORT:-21660}" \
PORT="${MOTRIX_PORT:-21660}" \
  exec "$L/node-launcher" --jitless --experimental-sqlite "$APP/main.mjs"