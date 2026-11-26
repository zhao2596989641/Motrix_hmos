#!/bin/sh
# 给本机 node_modules 里的原生件打自签名。
#
# 为什么必须：本机（HarmonyOS PC）对 ELF 的 execve/dlopen 判据是"代码签名"，
# 与权限位无关。npm 下发的 .node / esbuild 二进制都没有 .codesign 段 ⇒
#   · dlopen → ERR_DLOPEN_FAILED: Permission denied
#   · execve → EACCES
# 实测：binary-sign-tool -selfSign 1 之后就都能用（见 share/RESEARCH-*.md）。
#
# 幂等：已带 .codesign 段的文件直接跳过。
# 用法：sh scripts/sign-host-natives.sh <目录...>   （默认 vendor/motrix/node_modules）
set -eu
. "$(dirname "$0")/hmos-env.sh"

READELF="$OHOS_TOOLBIN/llvm-readelf"
is_signed() { "$READELF" -S "$1" 2>/dev/null | grep -q '\.codesign'; }
is_elf() { [ "$(head -c 4 "$1" 2>/dev/null | od -An -c 2>/dev/null | tr -d ' \n')" = '177ELF' ]; }

sign_one() {
  f=$1
  is_elf "$f" || return 0
  is_signed "$f" && return 0
  "$SIGN_TOOL" sign -selfSign 1 -inFile "$f" -outFile "$f.signed" -signAlg SHA256withECDSA >/dev/null 2>&1 \
    || { echo "  [skip] 签名失败: $f"; rm -f "$f.signed"; return 0; }
  [ -s "$f.signed" ] || { echo "  [skip] 产物为空: $f"; rm -f "$f.signed"; return 0; }
  chmod 755 "$f.signed" 2>/dev/null || true
  mv "$f.signed" "$f"
  # 保留可执行位（execve 需要）
  case "$f" in *.node) ;; *) chmod 755 "$f" 2>/dev/null || true ;; esac
  echo "  [signed] $f"
}

roots=${*:-}
[ -n "$roots" ] || roots=$(cd "$(dirname "$0")/.." && pwd)/vendor/motrix/node_modules
for root in $roots; do
  [ -d "$root" ] || continue
  find "$root" \( -name '*.node' -o -path '*/.bin/*' \) -type f 2>/dev/null | while read -r f; do sign_one "$f"; done
done
