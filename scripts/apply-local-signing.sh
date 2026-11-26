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
# r51：DevEco 重新「自动签名」会重新生成密钥库（新口令），本地旧的加密口令就对不上，
# 签 ELF/HAP 会报 KEYSTORE_PASSWORD_ERROR -115。构建前先把 DevEco 最新口令同步进来。
if [ -f "$ROOT/.hvigor/outputs/sync/output.json" ] && [ -f "$ROOT/build-profile.local.json5" ]; then
  if command -v node >/dev/null 2>&1; then
    node "$HERE/refresh-local-signing.mjs" || true
  else
    echo "[local-signing] 跳过口令同步（PATH 里没有 node）" >&2
  fi
fi

cp "$SRC" "$DST"
echo "已应用本地签名配置到 build-profile.json5（提交前记得 git checkout -- build-profile.json5）"
