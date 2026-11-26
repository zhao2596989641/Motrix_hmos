#!/bin/sh
# 从真机把 Motrix 的诊断日志拉到本机（在**用户自己的系统终端**里跑；沙箱内 hdc 连不上设备）。
#
# 用法：
#   HDC=<命令行工具>/sdk/default/openharmony/toolchains/hdc sh scripts/gather-logs.sh [输出目录]
#   输出目录默认 ./logs（不存在会创建）
set -eu
HDC=${HDC:?请先导出 HDC=…/hdc（HarmonyOS 命令行工具里的 hdc 路径）}
OUT=${1:-./logs}
DIR=/data/app/el2/100/base/com.lyldeer.motrix/haps/entry/files
mkdir -p "$OUT"
for name in ability-diag.log arkts-diag.log node-output.log boot-stage.json spawn-probe.json host-ready.dev.json; do
  if "$HDC" file recv "$DIR/$name" "$OUT/$name" >/dev/null 2>&1; then
    echo "[ok]   $name"
  else
    # 有的文件权限/不存在会失败：退化成 shell cat 再落盘
    if "$HDC" shell "cat $DIR/$name" > "$OUT/$name" 2>/dev/null && [ -s "$OUT/$name" ]; then
      echo "[cat]  $name"
    else
      rm -f "$OUT/$name"
      echo "[skip] $name"
    fi
  fi
done
echo "日志已保存到 $OUT/"
