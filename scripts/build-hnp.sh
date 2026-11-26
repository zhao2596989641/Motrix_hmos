#!/bin/sh
# 打 HNP 包：把 aria2c / motrix-finalize-fs 交给系统安装成"可执行的原生包"。
#
# 为什么必须 HNP（r8 真机读数 + SELinux 策略）：
#   · 应用沙箱（el2，label=debug_hap_data_file）**不允许 debug_hap 域 execve**
#     —— 策略里只有 `(allow develop_tools_debug_hap debug_hap_data_file ... execute)`
#     （参考宿主项目 恰好是 develop_tools 域，所以它的本地复现能跑；我们不能拿它当判据）。
#   · HNP 装到 `/data/app/el1/bundle/<uid>/hnppublic/...`（label=hnp_file），
#     策略里 `(allow normal_hap_attr hnp_file (file (execute)))`、且 debug_hap 在
#     normal_hap_attr 里 ⇒ **应用可以 exec HNP 里的文件**。
#   · HNP 的链接落在 `/data/service/hnp/bin/<target>`，路径稳定，不依赖 uid/版本目录。
#
# 产物：entry/hnp/motrix.hnp（z 内含 motrix-hnp/{hnp.json,aria2c,motrix-finalize-fs}），
# 由 entry/hvigorfile.ts 的 RepackHapWithHnp 任务塞进 HAP 的 hnp/ 目录后再签名。
set -eu
umask 022
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/hmos-env.sh"

NAME=motrix
VERSION=${HNP_VERSION:-2.4.5}
# /tmp 才能设置出 0755/0644（用户文档目录有 750/640 的存取限制，chmod 会被吞掉）
STAGE_ROOT="${HNP_STAGE_ROOT:-/tmp/motrix-hnp-build}"
STAGE="$STAGE_ROOT/$NAME-hnp"
OUT_DIR="$ROOT/entry/hnp/arm64-v8a"
OUT="$OUT_DIR/$NAME.hnp"

ARIA2="$ROOT/build/bin/aria2c"
FIN="$ROOT/build/bin/motrix-finalize-fs"

ZIP=${ZIP:-/usr/bin/zip}
[ -x "$ZIP" ] || ZIP=$(command -v zip || true)
[ -n "$ZIP" ] || { echo "缺 zip（/usr/bin/zip）" >&2; exit 1; }

for f in "$ARIA2" "$FIN"; do
  [ -f "$f" ] || { echo "缺 $f（先跑 build-hap.sh 的第 1/2 步）" >&2; exit 1; }
done

rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT_DIR"
# 目录/文件模式必须规范（zip 会把 setgid/group-write 一起存进去；安装器对此很敏感）
mkdir -p "$STAGE/bin"
chmod 755 "$STAGE_ROOT" "$STAGE" "$STAGE/bin" "$OUT_DIR" 2>/dev/null || true
# harmonybrew 的 GNU chmod 对目录默认保留 setgid；HNP 目录必须是干净的 0755
chmod g-s "$STAGE_ROOT" "$STAGE" "$STAGE/bin" "$OUT_DIR" 2>/dev/null || true

# 布局对齐能装上的 claude.hnp：可执行文件在 bin/ 下，hnp.json links 指向 ./bin/...
cp "$ARIA2" "$STAGE/bin/aria2c"
cp "$FIN" "$STAGE/bin/motrix-finalize-fs"
# HNP 内**不要**给执行位：已装可用的 aria2.hnp/claude.hnp 都是 0644；
# 带 x 位会让安装器走 fs-verity/code-sign 流程（unsigned ELF 会 9568407）
chmod 644 "$STAGE/bin/aria2c" "$STAGE/bin/motrix-finalize-fs"

# HNP 里的 ELF 保持**未签名**：已装可用的 aria2.hnp 就是 unsigned；
# 自签名的 ownerid 反而可能被 xpm（exec 许可模型）判成不允许的 debug owner。
for f in "$STAGE/bin/aria2c" "$STAGE/bin/motrix-finalize-fs"; do
  if "$OHOS_TOOLBIN/llvm-readelf" -S "$f" 2>/dev/null | grep -q '\.codesign'; then
    "$OHOS_TOOLBIN/llvm-objcopy" --remove-section .codesign "$f" "$f.nosig"
    mv "$f.nosig" "$f"
    chmod 644 "$f"
    echo "[hnp] strip .codesign: $(basename "$f")"
  fi
done

# 链接名刻意带 motrix- 前缀：公共同名包（例如 OHtrix 装的 aria2.hnp）不会被覆盖
cat > "$STAGE/hnp.json" <<EOF
{
  "type": "hnp-config",
  "name": "$NAME",
  "version": "$VERSION",
  "install": {
    "links": [
      { "source": "./bin/aria2c", "target": "motrix-aria2c" },
      { "source": "./bin/motrix-finalize-fs", "target": "motrix-finalize-fs" }
    ]
  }
}
EOF
chmod 644 "$STAGE/hnp.json"

rm -f "$OUT"
# -X 去掉 extra 字段，-r 保留顶层 motrix-hnp/ 目录（与已装 aria2.hnp 的结构一致）
( cd "$STAGE_ROOT" && "$ZIP" -q -r -X "$OUT" "$NAME-hnp" )
chmod 644 "$OUT" 2>/dev/null || true

# 另存一份到 /tmp（0644）：HAP 打包用这份，避免 HAP 内的 HNP 条目带上 640
PACK_ROOT="${HNP_PACK_ROOT:-/tmp/motrix-hnp-pack}"
rm -rf "$PACK_ROOT"
mkdir -p "$PACK_ROOT/arm64-v8a"
chmod 755 "$PACK_ROOT" "$PACK_ROOT/arm64-v8a" 2>/dev/null || true
chmod g-s "$PACK_ROOT" "$PACK_ROOT/arm64-v8a" 2>/dev/null || true
cp "$OUT" "$PACK_ROOT/arm64-v8a/motrix.hnp"
chmod 644 "$PACK_ROOT/arm64-v8a/motrix.hnp"

echo "[hnp] 产物: $OUT ($(du -h "$OUT" | cut -f1))"
echo "[hnp] 目录:"
unzip -l "$OUT" 2>/dev/null | sed -n '2,10p' || true