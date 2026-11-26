cmake_minimum_required(VERSION 3.5.0)
project(motrixnative)

# Node 26.x 的头文件用了 C++20 的 concepts/requires，用 C++17 编不过。
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(NATIVE_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
set(ENTRY_LIBS ${NATIVE_ROOT}/../../../libs)

# libmotrixhost.so：把 libnode 在同进程内跑起来的 NAPI 引导模块。
#
# 两条口径与 libnode 的交叉编译完全一致（否则与 libnode 交互会出现难定位的问题）：
#   -fno-emulated-tls / -D__MUSL__
#
# 【为什么不链接 libnode】见 motrixhost.cc 文件头：写进 DT_NEEDED 会让加载器先以
# RTLD_LOCAL 载入 libnode，之后 dlopen 的 .node（better-sqlite3）解析不到 napi_* 符号。
# 代价是链接期不再校验 libnode —— 有意的取舍。
add_library(motrixhost SHARED motrixhost.cc)

target_include_directories(motrixhost PRIVATE
    ${NATIVE_ROOT}/node-headers/src)

target_compile_options(motrixhost PRIVATE -fno-emulated-tls -D__MUSL__)
set_target_properties(motrixhost PROPERTIES LINK_FLAGS "-fno-emulated-tls")

# libace_napi.z.so：ArkTS 侧原生模块运行时；hilog_ndk.z：诊断日志。
# 应用进程的 stdout 在设备上看不见，所有诊断只能走 hilog。
target_link_libraries(motrixhost PUBLIC libace_napi.z.so hilog_ndk.z)
