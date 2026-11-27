#!/bin/sh
# 构建随包的**最小 FFmpeg**（aarch64-linux-ohos，LGPL-2.1+），产物放到 build/bin/ffmpeg。
#
# 为什么不照上游那样"下载托管发布包"：上游只发 darwin/linux/win32
# （见 src/core/ffmpeg/verified-release.ts 的平台枚举），鸿蒙不在其中，
# installServerFfmpeg() 在鸿蒙恒返回 unsupported。
#
# 为什么不用 harmonybrew 的 ffmpeg：它带 15 个依赖（x264/x265/dav1d/lame/…），
# 几百 MB，且会污染用户的 brew 前缀；我们只需要"探测 + 流拷贝重封装"。
#
# 关键 trick：ffmpeg 的 configure 会编译并**当场运行**探测程序，而鸿蒙对
# 未签名 ELF 一律拒绝执行（EACCES）。所以这里生成一个 cc 包装器：
#   链接完成 → 剥掉占位 .codesign 段 → binary-sign-tool 自签 → 交给 configure 运行。
# 产物本身不随 git 提交（build/ 与 entry/libs/**/*.bin 都被忽略），
# 需要时在本机重跑本脚本即可（约 3 分钟，需网络下载源码）。
#
# 用法：sh scripts/build-ffmpeg.sh [源码目录]
#   环境变量 FFMPEG_VERSION 默认 7.1
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
. "$HERE/hmos-env.sh"

VERSION=${FFMPEG_VERSION:-7.1}
CACHE=${FFMPEG_CACHE:-/storage/Users/currentUser/Documents/codes/.buildcache/ffmpeg}
SRC=${1:-"$CACHE/ffmpeg-$VERSION"}
JOBS=$(nproc 2>/dev/null || echo 6)

mkdir -p "$CACHE"
cd "$CACHE"

if [ ! -d "ffmpeg-$VERSION" ]; then
  if [ ! -f "ffmpeg-$VERSION.tar.xz" ]; then
    echo ">> 下载 ffmpeg-$VERSION 源码"
    curl -sSL --retry 3 -o "ffmpeg-$VERSION.tar.xz" \
      "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
  fi
  xz -t "ffmpeg-$VERSION.tar.xz"
  tar xf "ffmpeg-$VERSION.tar.xz"
fi

# ── cc 包装器：链接产物立即自签，configure 才能运行它的探测程序 ──────────────
WRAP="$CACHE/cc-sign-wrapper.sh"
cat > "$WRAP" <<'WRAPPER'
#!/bin/sh
set -u
. "${MOTRIX_HMOS_ENV:?}"
out=""
prev=""
link=1
for a in "$@"; do
  case "$a" in
    -c|-S|-E|-M|-MM|-MF|-MD|-MMD) link=0 ;;
  esac
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] || [ "$link" = "1" ] || { exec "$OHOS_TOOLBIN/clang" --target=aarch64-linux-ohos --sysroot="$OHOS_SYSROOT" "$@"; }
[ -n "$out" ] || out="a.out"

"$OHOS_TOOLBIN/clang" --target=aarch64-linux-ohos --sysroot="$OHOS_SYSROOT" "$@"
status=$?
[ "$status" -eq 0 ] || exit "$status"
[ -f "$out" ] || exit 0
magic=$(head -c 4 "$out" 2>/dev/null | od -An -t x1 2>/dev/null | tr -d ' \n')
[ "$magic" = "7f454c46" ] || exit 0
chmod 755 "$out" 2>/dev/null || true
remove_args=""
for section in .codesign .permission; do
  if "$OHOS_TOOLBIN/llvm-readelf" -S "$out" 2>/dev/null | grep -q "$section"; then
    remove_args="$remove_args --remove-section $section"
  fi
done
if [ -n "$remove_args" ]; then
  # shellcheck disable=SC2086
  "$OHOS_TOOLBIN/llvm-objcopy" $remove_args "$out" "$out.nosig" 2>/dev/null && mv "$out.nosig" "$out"
fi
if "$SIGN_TOOL" sign -selfSign 1 -inFile "$out" -outFile "$out.signed" \
    -signAlg SHA256withECDSA >/dev/null 2>&1 && [ -s "$out.signed" ]; then
  chmod 755 "$out.signed" 2>/dev/null || true
  mv "$out.signed" "$out"
else
  rm -f "$out.signed"
fi
exit 0
WRAPPER
chmod 755 "$WRAP"
export MOTRIX_HMOS_ENV="$HERE/hmos-env.sh"

cd "$SRC"
if [ ! -f ffbuild/config.mak ]; then
  echo ">> configure（最小功能集）"
  ./configure \
    --target-os=linux --arch=aarch64 --cc="$WRAP" --ld="$WRAP" \
    --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
    --disable-network --disable-autodetect \
    --disable-everything \
    --enable-ffmpeg --enable-ffprobe --disable-ffplay --disable-avdevice \
    --enable-protocol=file,pipe \
    --enable-demuxer=mov,matroska,mpegts,flv,mp3,aac,wav,flac,ogg,avi,image2,hls,mpjpeg \
    --enable-muxer=mp4,matroska,mpegts,mov,ipod,mp3,adts,wav,flac,image2 \
    --enable-parser=h264,hevc,aac,mpegaudio,vp9,av1,opus,flac,mjpeg \
    --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,vp9_superframe \
    --enable-decoder=h264,hevc,aac,mp3,flac,pcm_s16le,vp9,av1,opus,vorbis,mjpeg \
    --enable-encoder=aac,flac,pcm_s16le,mjpeg \
    --enable-filter=aresample,anull,null,scale,format,copy,concat,atrim,trim \
    --enable-small --disable-debug
fi

echo ">> make -j$JOBS"
make -j"$JOBS"

# strip 会抹掉 .codesign ⇒ 打完再签一次（脚本幂等：已有 .codesign 时跳过剥段）
sh "$HERE/sign-elf.sh" "$SRC/ffmpeg"

mkdir -p "$ROOT/build/bin"
rm -f "$ROOT/build/bin/ffmpeg"
cp "$SRC/ffmpeg" "$ROOT/build/bin/ffmpeg"
chmod 755 "$ROOT/build/bin/ffmpeg"
echo "[ok] $ROOT/build/bin/ffmpeg"
"$ROOT/build/bin/ffmpeg" -version 2>&1 | head -1
echo "提示：build-hap.sh 会用**应用证书**重签 build/bin/ffmpeg 再放进 entry/libs/arm64-v8a/ffmpeg.bin"