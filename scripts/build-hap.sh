#!/bin/sh
# 一键构建 Motrix 的 HarmonyOS 安装包（命令行，不需要打开 DevEco）。
#
# 前置（一次性，见 docs/BUILD.md）：
#   · 签名：维护者在 DevEco Studio 里对本工程做过一次"自动签名"，
#     于是 build-profile.json5 的 signingConfigs 里有了 material 四路径 + 两个加密口令。
#     （`.p7b` 绑 bundleName 和本机 UDID，不能从别的工程复用。）
#
# 用法：
#   sh scripts/build-hap.sh            # debug
#   sh scripts/build-hap.sh release    # release
#
# 它做的事（顺序不能乱）：
#   1) 交叉编译 better-sqlite3（device 变体）
#   2) 交叉编译 motrix-finalize-fs（Rust sidecar）
#   3) 组装 resfile/app（server + 前端 + 运行期 node_modules + 二进制 + CA）
#   4) 签名 resfile 里的原生二进制（**必须在打包前**，打包后再改字节会破坏 HAP 签名）
#   5) hvigorw assembleHap
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/hmos-env.sh"

MODE=${1:-debug}
export PATH="/storage/Users/currentUser/.harmonybrew/bin:$PATH"

say() { echo ""; echo "==== $* ===="; }

# ── 1. better-sqlite3 ────────────────────────────────────────────────────────
say "1/5 交叉编译 better-sqlite3"
if [ ! -f "$ROOT/build/native/device/better_sqlite3.node" ] || [ "${FORCE_NATIVE:-0}" = "1" ]; then
  sh "$HERE/build-better-sqlite3.sh" --variant=device
else
  echo "已存在，跳过（FORCE_NATIVE=1 可强制重编）"
fi

# ── 2. finalize-fs ──────────────────────────────────────────────────────────
say "2/5 交叉编译 motrix-finalize-fs"
FFS_TARGET="$ROOT/vendor/motrix/packages/finalize-fs/target/aarch64-unknown-linux-ohos/release/motrix-finalize-fs"
if [ ! -f "$FFS_TARGET" ] || [ "${FORCE_RUST:-0}" = "1" ]; then
  sh "$HERE/build-finalize-fs.sh"
else
  echo "已存在，跳过（FORCE_RUST=1 可强制重编）"
fi
if [ -f "$FFS_TARGET" ]; then
  # 注意：这类目标文件被 sign-elf 用 mv 覆盖过之后会进入"封存态"，
  # 直接 cp 到它上面会 EPERM ⇒ 一律 先删后铺（cp 到临时名再 mv）。
  rm -f "$ROOT/build/bin/motrix-finalize-fs"
  cp "$FFS_TARGET" "$ROOT/build/bin/motrix-finalize-fs.new"
  mv "$ROOT/build/bin/motrix-finalize-fs.new" "$ROOT/build/bin/motrix-finalize-fs"
  chmod 755 "$ROOT/build/bin/motrix-finalize-fs"
fi

# ── 3. 组装 resfile/app ─────────────────────────────────────────────────────
say "3/5 组装 resfile/app"
# 构建脚本本身跑在宿主机 node 上，需要伪造 linux 平台（rolldown/lightningcss 的
# 原生件按 process.platform 选包，而本机报 openharmony）
FAKE_PLATFORM=/tmp/motrix-fakeplat.cjs
cat > "$FAKE_PLATFORM" <<'EOF'
try { Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: true }); } catch (e) {}
try { Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true, writable: true }); } catch (e) {}
EOF
node --require "$FAKE_PLATFORM" "$HERE/build-node-bundle.mjs"

# ── 4. 签名原生二进制 ───────────────────────────────────────────────────────
# 注意：better_sqlite3 **不在这里签名**。它以 flat `libbetter_sqlite3.so` 放进
# entry/libs/arm64-v8a/（第 3 步的 build-node-bundle.mjs 负责），HAP 的 libs/ 本身受信，
# 不需要自签名；留在 resfile 里的 .node 反而会被系统拦掉 dlopen（"No error information"）。
say "4/5 签名将随 libs/ 打包的原生件"
BUNDLE_APP="$ROOT/entry/src/main/resources/resfile/app"
# 签的是 build/bin 里的"源"，不是 resfile 副本：resfile 里已经不放 bin 了（省约 11.5MB），
# 端侧执行的是 4b 拷进 entry/libs 的同一个签名后字节。
sh "$HERE/sign-elf-appcert.sh" \
  "$ROOT/build/bin/aria2c" \
  "$ROOT/build/bin/motrix-finalize-fs"
echo "（缺哪个会显示 skip，不影响其余）"

FLAT_SQLITE="$ROOT/entry/libs/arm64-v8a/libbetter_sqlite3.so"
if [ -f "$FLAT_SQLITE" ]; then
  echo "[flat] better_sqlite3 → entry/libs/arm64-v8a/libbetter_sqlite3.so（HAP libs/，无需自签）"
else
  echo "!! 警告：缺 $FLAT_SQLITE —— 端侧会再次出现 ERR_DLOPEN_FAILED" >&2
fi

# ── 4b. 随包可执行 ELF → entry/libs/arm64-v8a ───────────────────────────────
# 官方 hap-bin（PC/2in1 + API 24+）：bin 必须放 libs/{abi}/，由 module.json5 的
# executableBinaryPaths 声明，安装时系统解压到 <bundle>/libs/arm64/ 并授予执行属性。
# resfile 里的 bin 用应用证书保留 .codesign（遵循官方文档；实测 9568393 与它无关，
# 失败点是 HAP 签名块 NativeLibSignInfo 漏了无后缀条目）。strip 已由 debugSymbol.strip=false 关掉。
say "4b/5 放置可执行 ELF 到 entry/libs/arm64-v8a"
LIBS_ABI="$ROOT/entry/libs/arm64-v8a"
mkdir -p "$LIBS_ABI"
# 目标文件名必须带 "."：
#   hap-sign-tool（C++）的 IsNativeFile 对无扩展名条目直接返回 false，
#   这些文件不会进入 HAP 签名块的 NativeLibSignInfo；而 installd 的
#   GetNativeLibraryFileNames 会枚举 libs/{abi}/ 下全部文件 ⇒ 签名映射数量
#   对不上，安装时报 9568393。带 .bin 后缀后两边一致（实测见 share/ 报告）。
for pair in "aria2c:aria2c.bin" "motrix-finalize-fs:motrix-finalize-fs.bin"; do
  name=${pair%%:*}
  staged=${pair#*:}
  src="$ROOT/build/bin/$name"
  [ -f "$src" ] || { echo "!! 缺 $src" >&2; exit 1; }
  # 先删后铺：目标可能是上一次构建留下的 inode，避免覆盖时踩到封存态
  rm -f "$LIBS_ABI/$staged.new"
  cp "$src" "$LIBS_ABI/$staged.new"
  chmod 755 "$LIBS_ABI/$staged.new"
  rm -f "$LIBS_ABI/$staged"
  mv "$LIBS_ABI/$staged.new" "$LIBS_ABI/$staged"
  # 清掉旧的无后缀副本，否则它也会被 collectAllLibs 收进包并再次触发 9568393
  rm -f "$LIBS_ABI/$name"
  echo "[bin] $name → $LIBS_ABI/$staged"
done

# ── 5. hvigor ───────────────────────────────────────────────────────────────
say "5/5 hvigor assembleHap（$MODE）"
export NODE_HOME="$CLT/node"
export DEVECO_SDK_HOME="$CLT/sdk"
cd "$ROOT"
"$HVIGOR_NODE" "$HVIGOR" assembleHap \
  --mode module -p module=entry@default -p product=default -p buildMode="$MODE" --no-daemon

echo ""
echo "产物："
ls -lh "$ROOT/entry/build/default/outputs/default/"*.hap 2>/dev/null || true