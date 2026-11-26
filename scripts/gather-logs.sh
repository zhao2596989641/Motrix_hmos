#!/bin/sh
# 从真机把 Motrix 的诊断日志拉到本机（在**用户自己的系统终端**里跑；沙箱内 hdc 连不上设备，
# 会报 usb/uds 相关错误——hdc 服务必须跑在用户域）。
#
# 用法（cd 到本仓库 codes/MotrixOHOS）：
#   hdc 已在 PATH 上时：
#     sh scripts/gather-logs.sh /storage/Users/currentUser/Documents/codes/Motrix/logs
#   或显式指定 hdc（CLT 里那份）：
#     HDC=/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/toolchains/hdc \
#       sh scripts/gather-logs.sh /storage/Users/currentUser/Documents/codes/Motrix/logs
#   输出目录省略时默认 ./logs。
set -eu
OUT=${1:-./logs}
# 没显式给就用 PATH 里的 hdc（本机 harmonybrew 也装了一份）
HDC=${HDC:-$(command -v hdc || true)}
if [ -z "$HDC" ] || [ ! -x "$HDC" ]; then
  echo "!! 找不到 hdc：请导出 HDC=<命令行工具>/sdk/default/openharmony/toolchains/hdc" >&2
  exit 2
fi

FILES=/data/app/el2/100/base/com.lyldeer.motrix/haps/entry/files
DATA="$FILES/motrix"   # 宿主/原生侧数据目录（MOTRIX_DATA_DIR）
mkdir -p "$OUT"

# 「设备上的相对路径 : 本机文件名」——左边相对 FILES/$DATA 二选一
pull() {
  remote="$1"
  local_name="$2"
  if "$HDC" file recv "$remote" "$OUT/$local_name" >/dev/null 2>&1 && [ -s "$OUT/$local_name" ]; then
    echo "[ok]   $local_name"
    return 0
  fi
  # 有的文件权限/不存在会失败：退化成 shell cat 再落盘
  if "$HDC" shell "cat $remote" > "$OUT/$local_name" 2>/dev/null && [ -s "$OUT/$local_name" ]; then
    echo "[cat]  $local_name"
    return 0
  fi
  rm -f "$OUT/$local_name"
  echo "[skip] $local_name"
  return 1
}

# 沙箱根（ArkTS / 宿主写在这里）
for name in ability-diag.log arkts-diag.log node-output.log boot-stage.json \
            spawn-probe.json host-ready.dev.json window-geometry.json; do
  pull "$FILES/$name" "$name" || true
done

# 数据目录（原生探针 / 宿主状态）
pull "$DATA/wx-probe.json" "wx-probe.json" || true
pull "$DATA/tray-state.json" "tray-state.json" || true
pull "$DATA/host-failed.json" "host-failed.json" || true

echo "日志已保存到 $OUT/"
if [ -f "$OUT/wx-probe.json" ]; then
  echo "wx-probe.json: $(cat "$OUT/wx-probe.json")"
else
  echo "!! 没有 wx-probe.json —— 装的是 r47 及之后的包吗？（r47 起才会写这个探针）" >&2
fi
