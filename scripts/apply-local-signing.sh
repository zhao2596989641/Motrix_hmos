#!/bin/sh
# 构建前把本机的真实签名物料覆盖进 build-profile.json5（仓库里那份是占位符）。
#
# 为什么分开：仓库不能存签名口令/路径；本机那份（build-profile.local.json5）已在 .gitignore。
# 用法：
#   sh scripts/apply-local-signing.sh              # 应用本地配置
#   git checkout -- build-profile.json5            # 提交前还原成占位符
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SRC="$ROOT/build-profile.local.json5"
DST="$ROOT/build-profile.json5"
if [ ! -f "$SRC" ]; then
  echo "!! 缺 $SRC —— 先把真实的 build-profile.json5 存成这个文件名（含 signingConfigs.material）" >&2
  exit 1
fi
cp "$SRC" "$DST"
echo "已应用本地签名配置到 build-profile.json5（提交前记得 git checkout -- build-profile.json5）"
