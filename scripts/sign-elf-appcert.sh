#!/bin/sh
# 用应用自己的调试证书签随包 ELF（hap-bin 要求；自签会被 9568393 拒）。
# 用法：sh scripts/sign-elf-appcert.sh <elf> [<elf>...]
#
# 密码由 sign-elf-appcert.mjs 从 build-profile.json5 的密文 + ~/.ohos/config/material 解出，
# 不落盘、不打印。本地 repro 仍可用 scripts/sign-elf.sh（自签），两者不要混用。
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/hmos-env.sh"
exec "$HVIGOR_NODE" "$HERE/sign-elf-appcert.mjs" "$@"