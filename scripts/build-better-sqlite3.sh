#!/bin/sh
# 交叉编译 better-sqlite3（NAPI 10 addon）到 OHOS aarch64。
#
# 为什么能一次编好同时用于本机与设备：
#   better-sqlite3 v13 用 node-addon-api（NAPI），ABI 稳定；本机 brew node 与
#   HAP 内嵌 libnode.so.137 都是 HarmonyOS/musl aarch64，NAPI 10 两头都支持。
#
# 两种产物：
#   --variant=host    不带 DT_NEEDED libnode（本机 brew node 测试用）
#   --variant=device  带 DT_NEEDED libnode.so.137（HAP 内 dlopen 依赖闭包用）
set -eu
. "$(dirname "$0")/hmos-env.sh"

VARIANT=host
for a in "$@"; do case "$a" in --variant=*) VARIANT=${a#--variant=} ;; esac; done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BSQL="$ROOT/vendor/motrix/node_modules/better-sqlite3"
OUT="$ROOT/build/native/$VARIANT"
NODE_HEADERS="${NODE_HEADERS:-/storage/Users/currentUser/Documents/codes/dshm/codes/dshm/entry/src/main/cpp/node-headers/src}"
LIBNODE="${LIBNODE:-/storage/Users/currentUser/Documents/codes/dshm/codes/dshm/entry/libs/arm64-v8a/libnode.so.137}"

[ -f "$BSQL/src/better_sqlite3.cpp" ] || { echo "缺 better-sqlite3 源码：$BSQL" >&2; exit 1; }
[ -f "$NODE_HEADERS/node_api.h" ] || { echo "缺 node_api.h：$NODE_HEADERS" >&2; exit 1; }
mkdir -p "$OUT"

DEFS="-DHAVE_INT16_T=1 -DHAVE_INT32_T=1 -DHAVE_INT8_T=1 -DHAVE_STDINT_H=1 -DHAVE_UINT16_T=1 \
-DHAVE_UINT32_T=1 -DHAVE_UINT8_T=1 -DHAVE_USLEEP=1 -DSQLITE_DEFAULT_CACHE_SIZE=-16000 \
-DSQLITE_DEFAULT_FOREIGN_KEYS=1 -DSQLITE_DEFAULT_MEMSTATUS=0 -DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1 \
-DSQLITE_DQS=0 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ENABLE_DESERIALIZE \
-DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS4 -DSQLITE_ENABLE_FTS5 \
-DSQLITE_ENABLE_GEOPOLY -DSQLITE_ENABLE_JSON1 -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_ENABLE_PERCENTILE \
-DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_STAT4 -DSQLITE_ENABLE_UPDATE_DELETE_LIMIT \
-DSQLITE_LIKE_DOESNT_MATCH_BLOBS -DSQLITE_OMIT_DEPRECATED -DSQLITE_OMIT_PROGRESS_CALLBACK \
-DSQLITE_OMIT_SHARED_CACHE -DSQLITE_OMIT_TCL_VARIABLE -DSQLITE_SOUNDEX -DSQLITE_THREADSAFE=2 \
-DSQLITE_TRACE_SIZE_LIMIT=32 -DSQLITE_USE_URI=0"

NAPI_DEFS="-DNAPI_VERSION=10 -DNAPI_DISABLE_CPP_EXCEPTIONS -DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS"

LINK_HOST="-ldl"
LINK_DEVICE="-ldl -Wl,--no-as-needed $LIBNODE"

CC_OPTS="--target=aarch64-linux-ohos -O2 -fPIC -fvisibility=hidden -fvisibility-inlines-hidden -Wno-unused-command-line-argument"
CXX_OPTS="$CC_OPTS -std=c++20"

echo "[better-sqlite3] variant=$VARIANT"
"$OHOS_TOOLBIN/clang" $CC_OPTS $DEFS -c "$BSQL/deps/sqlite3/sqlite3.c" -o "$OUT/sqlite3.o"
"$OHOS_TOOLBIN/clang++" $CXX_OPTS $DEFS $NAPI_DEFS \
  -I"$BSQL" -I"$BSQL/src" -I"$BSQL/deps/sqlite3" \
  -I"$ROOT/vendor/motrix/node_modules/node-addon-api" -I"$NODE_HEADERS" \
  -c "$BSQL/src/better_sqlite3.cpp" -o "$OUT/better_sqlite3.o"

if [ "$VARIANT" = device ]; then LINK="$LINK_DEVICE"; else LINK="$LINK_HOST"; fi
"$OHOS_TOOLBIN/clang++" --target=aarch64-linux-ohos -shared -o "$OUT/better_sqlite3.node" \
  "$OUT/better_sqlite3.o" "$OUT/sqlite3.o" \
  -Wl,-Bsymbolic -Wl,--exclude-libs,ALL $LINK

"$OHOS_TOOLBIN/llvm-strip" "$OUT/better_sqlite3.node" 2>/dev/null || true
echo "[better-sqlite3] 产物: $OUT/better_sqlite3.node"
"$OHOS_TOOLBIN/llvm-readelf" -d "$OUT/better_sqlite3.node" | grep -i needed || true
ls -l "$OUT/better_sqlite3.node"
