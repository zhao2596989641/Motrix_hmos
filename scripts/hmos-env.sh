#!/bin/sh
# MotrixOS 构建环境公共变量（本机 = HarmonyOS PC / aarch64）
# 用法：. scripts/hmos-env.sh
CLT=${CLT:-/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0}
export CLT
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$CLT/sdk}"
export NODE_HOME="${NODE_HOME:-$CLT/node}"
export OHOS_NDK="$CLT/sdk/default/openharmony/native"
export OHOS_SYSROOT="$OHOS_NDK/sysroot"
export OHOS_TOOLBIN="$OHOS_NDK/llvm/bin"
export SIGN_TOOL="$CLT/sdk/default/openharmony/toolchains/lib/binary-sign-tool"
export PATH="$CLT/node/bin:/storage/Users/currentUser/.harmonybrew/bin:$PATH"

# 本机 hvigor 需要的 node（v24.18.1）；构建脚本统一用它，避免用 brew node 26 编端侧产物
HVIGOR_NODE="$CLT/node/bin/node"
HVIGOR="$CLT/hvigor/bin/hvigorw.js"
