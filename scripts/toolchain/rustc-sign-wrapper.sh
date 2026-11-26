#!/bin/sh
# RUSTC_WRAPPER：在 rustc 产出**要立刻被执行/加载**的原生件之后，就地给它们打自签名。
#
# 为什么需要：HarmonyOS 判"能不能 exec / dlopen"的依据是**代码签名**，不是权限位。
# cargo 交叉编译时会先编出两类要当场用的 ELF：
#   · build-script（`build_script_build`）——编译后立刻被 cargo 执行；
#   · proc-macro（`libserde_derive-<hash>.so`）——编译后立刻被 rustc dlopen。
# 两者一出炉都是未签名的 ⇒ `Operation not permitted` / `dlopen ... Permission denied`。
#
# 为什么不能只认 `-o`：cargo 对部分 crate 用 `--out-dir <dir>` 输出，产物名带哈希、
# 事先不可知。所以做法是：
#   1) 跑 rustc 前在 out-dir 里留一个时间戳标记；
#   2) rustc 成功后，把该目录里**比标记新**的、看起来像"要执行/加载"的 ELF 全部签名。
# 判据仍然保守：跳过 .o/.rlib/.rmeta/.d（relocatable/归档，签了会毁链接）。
#
# 另：OHOS clang 链接时会留一个**占位的** `.codesign` 段（不被系统认可，照样 EPERM），
# 而 binary-sign-tool 见到该段会拒绝签名 ⇒ 必须先剥段。见 sign-elf.sh 的同一说明。
#
# 用法：RUSTC_WRAPPER=<本脚本> cargo build …
set -u
. "$(dirname "$0")/../hmos-env.sh" 2>/dev/null || . "$(dirname "$0")/hmos-env.sh"

REAL_RUSTC="$1"
shift

# ── 先从参数里解析输出位置 ───────────────────────────────────────────────────
out=""
out_dir=""
prev=""
for a in "$@"; do
  case "$a" in
    --out-dir=*) out_dir="${a#--out-dir=}" ;;
    -o=*) out="${a#-o=}" ;;
  esac
  if [ "$prev" = "-o" ]; then out="$a"; fi
  if [ "$prev" = "--out-dir" ]; then out_dir="$a"; fi
  prev="$a"
done

STAMP=""
if [ -n "$out_dir" ] && [ -d "$out_dir" ]; then
  STAMP="$out_dir/.motrix-rustc-stamp"
  : > "$STAMP"
fi

"$REAL_RUSTC" "$@"
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

sign_one() {
  f=$1
  [ -f "$f" ] || return 0
  case "$f" in
    *.o|*.rlib|*.rmeta|*.d|*.a|*.json|*.stamp) return 0 ;;
    *.so) ;;                                  # proc-macro / dylib：dlopen 的对象
    *) [ -x "$f" ] || return 0 ;;             # build-script：必须是可执行文件
  esac
  [ "$(head -c 4 "$f" 2>/dev/null | od -An -c 2>/dev/null | tr -d ' \n')" = '177ELF' ] || return 0
  if "$OHOS_TOOLBIN/llvm-readelf" -S "$f" 2>/dev/null | grep -q '\.codesign'; then
    "$OHOS_TOOLBIN/llvm-objcopy" --remove-section .codesign "$f" "$f.nosig" 2>/dev/null && mv "$f.nosig" "$f"
  fi
  "$SIGN_TOOL" sign -selfSign 1 -inFile "$f" -outFile "$f.s" -signAlg SHA256withECDSA >/dev/null 2>&1 \
    && [ -s "$f.s" ] && { chmod 755 "$f.s" 2>/dev/null; mv "$f.s" "$f"; }
  rm -f "$f.s" "$f.nosig" 2>/dev/null
}

# 1) 明确的 -o 产物
[ -n "$out" ] && sign_one "$out"

# 2) out-dir 里比标记新的产物
if [ -n "$STAMP" ] && [ -f "$STAMP" ]; then
  for f in $(find "$out_dir" -maxdepth 2 -type f -newer "$STAMP" 2>/dev/null); do
    sign_one "$f"
  done
  rm -f "$STAMP"
fi
exit 0