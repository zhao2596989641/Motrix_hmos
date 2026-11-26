#!/bin/sh
# 给一个 ELF 打自签名（幂等）。用法：sh scripts/sign-elf.sh <elf> [<elf>...]
#
# 为什么需要：HarmonyOS 判"能不能 exec / dlopen"的依据是**代码签名**，不是权限位
# （2026-11-24 实测：未签名 → EACCES / ERR_DLOPEN_FAILED；自签后 → 正常）。
#
# 为什么先删 .codesign：OHOS clang 链接时会在产物里留一个 **占位的** .codesign 段，
# 而 binary-sign-tool 见到该段就拒绝签（".codesign section already exists"），
# 但那个占位段**不被系统认可**（照样 EACCES）。所以先 objcopy 删段，再签。
set -eu
. "$(dirname "$0")/hmos-env.sh"

strip_sign() {
  f=$1
  [ -f "$f" ] || { echo "  [skip] 不存在: $f"; return 0; }
  # 只处理 ELF
  [ "$(head -c 4 "$f" 2>/dev/null | od -An -c 2>/dev/null | tr -d ' \n')" = '177ELF' ] \
    || { echo "  [skip] 非 ELF: $f"; return 0; }
  # 已有 .codesign ⇒ 先剥离（占位段不被认可）。
  # .permission 默认也剥掉：Rust/重复签名会在里面堆多段 JSON（本次实测 6 段
  # INHERIT_PARENT_PERMISSION），不是合法 JSON ⇒ 整个 HAP 安装失败；
  # 这两个 bin 只做文件/网络操作，不需要受保护系统能力。
  # 若将来某个 bin 真要声明权限：KEEP_PERMISSION=1 跳过剥离，并在签名后
  # 用 objcopy --add-section 追加以免破坏 .codesign。
  remove_args=""
  if "$OHOS_TOOLBIN/llvm-readelf" -S "$f" 2>/dev/null | grep -q '\.codesign'; then
    remove_args="$remove_args --remove-section .codesign"
  fi
  if [ "${KEEP_PERMISSION:-0}" != "1" ] \
    && "$OHOS_TOOLBIN/llvm-readelf" -S "$f" 2>/dev/null | grep -q '\.permission'; then
    remove_args="$remove_args --remove-section .permission"
  fi
  if [ -n "$remove_args" ]; then
    # shellcheck disable=SC2086  # remove_args 需要按空格分成多个参数
    "$OHOS_TOOLBIN/llvm-objcopy" $remove_args "$f" "$f.nosig"
    mv "$f.nosig" "$f"
  fi
  "$SIGN_TOOL" sign -selfSign 1 -inFile "$f" -outFile "$f.signed" -signAlg SHA256withECDSA >/dev/null 2>&1 || {
    echo "  [FAIL] 签名失败: $f"; rm -f "$f.signed"; return 0; }
  [ -s "$f.signed" ] || { echo "  [FAIL] 签名为空: $f"; return 0; }
  chmod 755 "$f.signed" 2>/dev/null || true
  mv "$f.signed" "$f"
  echo "  [signed] $f"
}

for f in "$@"; do strip_sign "$f"; done
