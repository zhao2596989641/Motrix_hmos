// motrixhost —— 把 libnode 在**同一进程内**跑起来的 NAPI 引导模块。
//
// 角色：ArkTS 侧调用 `startHost(argv, envPairs)`，本模块在独立线程里执行
// `node::Start(argc, argv)`，Node 起来后由端侧脚本（resfile/app/main.mjs）在
// loopback 上把 Motrix 的 server 拉起来。ArkTS 只认"端口通了"这一个事实。
//
// 为什么同进程而不是 fork/exec 一个 node 可执行文件：
//   1. HAP 里只带了 libnode.so（没有独立的 node 可执行文件）；
//   2. 同进程是 参考宿主项目 已在真机跑通的形态（hostruntime/src/main/cpp/dshhost.cc），
//      坑点已知（见下面每一条注释）。
//
// 已知边界（照抄 参考宿主项目 的实测结论，别当成已解决）：
//   1. **无法从外部线程安全停止进程内 Node**：node::Start 阻塞，正路是在 Node 线程内
//      持 uv_async + node::Stop(env)。因此 stopHost() 如实返回 ok:false，
//      真正的停止走"写文件信号 → 端侧脚本自己 process.exit()"。
//   2. argv 必须带 `--jitless`（不申请可写可执行内存），代价是 WebAssembly === undefined。
//   3. 环境变量必须在 node::Start **之前** setenv —— ArkTS 侧没有别的办法设置原生环境变量。
//
// 编译口径见同目录 CMakeLists.txt。

#include <node_api.h>
// 【为什么不 include <node.h>】它会拉进 v8 全套头文件（Node 26 的 v8.h 依赖 C++20 的
// <source_location>，OHOS SDK 的 libc++ 不提供）⇒ 编不过。本文件只通过 dlsym 取
// `node::Start` 的 mangled 名，不引用任何 node::/v8:: 类型。
#include <node_version.h>
#include <hilog/log.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dlfcn.h>
#include <string>
#include <sys/mman.h>
#include <thread>
#include <unistd.h>
#include <vector>

// 兜底符号：某些 .node 会引用 napi_fatal_error，而提供者是 libnode（全局作用域）。
// 若作用域没建立起来，加载方会报 "symbol not found"。我们自己提供一份，语义与 Node 一致。
extern "C" __attribute__((visibility("default"))) void napi_fatal_error(
    const char* location, size_t location_len, const char* message, size_t message_len) {
  (void)location_len;
  (void)message_len;
  OH_LOG_Print(LOG_APP, LOG_FATAL, 0x0000, "MOTRIX-SHIM",
               "napi_fatal_error: %{public}s | %{public}s",
               location != nullptr ? location : "(null)",
               message != nullptr ? message : "(null)");
  ::abort();
}

namespace {

std::thread g_nodeThread;
std::atomic<bool> g_running{false};
std::atomic<bool> g_started{false};
std::vector<std::string> g_argStore;
std::vector<char*> g_argv;

// libnode 句柄与 node::Start 函数指针。
//
// 【为什么不把 libnode 写进 DT_NEEDED】写进去，加载器会先以 RTLD_LOCAL 把它载入，
// 之后 dlopen 的 .node（better-sqlite3 这类）就解析不到 napi_* 符号（musl 下事后
// RTLD_GLOBAL 提升无效）。所以链接期故意不校验 libnode，改为构造器里首载 + RTLD_GLOBAL。
void* g_libnode = nullptr;
using NodeStartFn = int (*)(int, char*[]);
NodeStartFn g_nodeStart = nullptr;

void SetString(napi_env env, napi_value obj, const char* key, const std::string& value) {
  napi_value v = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.length(), &v);
  napi_set_named_property(env, obj, key, v);
}

void SetBool(napi_env env, napi_value obj, const char* key, bool value) {
  napi_value v = nullptr;
  napi_get_boolean(env, value, &v);
  napi_set_named_property(env, obj, key, v);
}

// runtimeVersion()：返回编译进 libnode 的 Node 版本。
// 它返回非空字符串 = "模块加载成功且与 libnode 链上了"的第一条可观测证据。
napi_value RuntimeVersion(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out = nullptr;
  napi_create_string_utf8(env, NODE_VERSION_STRING, NAPI_AUTO_LENGTH, &out);
  return out;
}

std::thread g_tailThread;
std::atomic<bool> g_tailStop{false};

// 把 Node 抓取文件里新增的内容实时转发到 hilog。
// 没有它，Node 一直跑着的时候我们完全看不见它的输出（不知道卡在哪一步）。
void TailNodeOutput(std::string path) {
  long offset = 0;
  while (!g_tailStop.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(300));
    FILE* f = ::fopen(path.c_str(), "r");
    if (f == nullptr) continue;
    if (::fseek(f, offset, SEEK_SET) != 0) {
      ::fclose(f);
      continue;
    }
    char buf[3000];
    size_t n = ::fread(buf, 1, sizeof(buf) - 1, f);
    ::fclose(f);
    if (n == 0) continue;
    offset += static_cast<long>(n);
    buf[n] = '\0';
    std::string all(buf);
    size_t pos = 0;
    while (pos < all.size()) {
      size_t nl = all.find('\n', pos);
      std::string line = all.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
      if (!line.empty()) {
        OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "MOTRIX-NODELIVE", "%{public}s", line.c_str());
      }
      if (nl == std::string::npos) break;
      pos = nl + 1;
    }
  }
}

// ── W^X 探针（r47）────────────────────────────────────────────────────────────
//
// 背景：端侧 Node 以 `--jitless` 启动（V8 不申请可写可执行内存），代价是
// `WebAssembly === undefined`，于是上游 QuickJS 插件沙箱起不来。
//
// 要不要放开 JIT，取决于**本进程的 SELinux 域**允不允许 execmem（W^X）。
// 这里在 app 进程自己身上试两种分配路径，把结论落成 <dataDir>/wx-probe.json：
//   · mmap(RW) + mprotect(RX)：V8 JIT 的常规路径（W^X 友好）→ mprotectRxErrno == 0 即通过
//   · mmap(RWX)：一步到位（不少内核/域策略直接拒）
// 这是纯试探，不执行任何机器码，失败也只是返回 errno，不影响后续启动。
namespace {

struct WxProbeResult {
  long pageSize = 0;
  int rwMmapErrno = 0;
  int mprotectRxErrno = 0;
  int mmapRwxErrno = 0;
};

WxProbeResult ProbeExecMemory() {
  WxProbeResult result;
  const long page = ::sysconf(_SC_PAGESIZE);
  result.pageSize = page > 0 ? page : 4096;
  const size_t len = static_cast<size_t>(result.pageSize);

  void* rw = ::mmap(nullptr, len, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (rw == MAP_FAILED) {
    result.rwMmapErrno = errno;
    result.mprotectRxErrno = -1;  // 未走到 mprotect
  } else {
    if (::mprotect(rw, len, PROT_READ | PROT_EXEC) != 0) {
      result.mprotectRxErrno = errno;
    }
    ::munmap(rw, len);
  }

  void* rwx = ::mmap(nullptr, len, PROT_READ | PROT_WRITE | PROT_EXEC,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (rwx == MAP_FAILED) {
    result.mmapRwxErrno = errno;
  } else {
    ::munmap(rwx, len);
  }
  return result;
}

// 必须在 ArkTS 传下来的 env 生效之后调用（要读 MOTRIX_DATA_DIR）。
void WriteWxProbe() {
  const WxProbeResult probe = ProbeExecMemory();
  const bool execmemAllowed =
      probe.mprotectRxErrno == 0 || probe.mmapRwxErrno == 0;
  char json[640];
  std::snprintf(
      json, sizeof(json),
      "{\"version\":1,\"pageSize\":%ld,\"rwMmapErrno\":%d,"
      "\"mprotectRxErrno\":%d,\"mmapRwxErrno\":%d,\"execmemAllowed\":%s,"
      "\"probedAt\":%lld}",
      probe.pageSize, probe.rwMmapErrno, probe.mprotectRxErrno,
      probe.mmapRwxErrno, execmemAllowed ? "true" : "false",
      static_cast<long long>(::time(nullptr)));
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "MOTRIX-WX", "wx-probe %{public}s", json);
  const char* dataDir = ::getenv("MOTRIX_DATA_DIR");
  if (dataDir == nullptr || dataDir[0] == '\0') {
    return;
  }
  const std::string path = std::string(dataDir) + "/wx-probe.json";
  if (FILE* f = ::fopen(path.c_str(), "w")) {
    ::fputs(json, f);
    ::fclose(f);
  }
}

}  // namespace

// startHost(argv: string[], envPairs: string[]): { started, envApplied, note }
//   argv 不含 argv[0]（本函数会补一个 "node"）；envPairs 是 "KEY=VALUE" 数组。
//   同一进程只允许启动一次；线程退出后标记复位（否则一次失败会把此后所有启动永久拒掉）。
napi_value StartHost(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  napi_value out = nullptr;
  napi_create_object(env, &out);

  if (g_started.load()) {
    SetBool(env, out, "started", false);
    SetString(env, out, "note", "运行时已经启动过；同一进程只允许一个 Node 实例");
    return out;
  }

  g_argStore.clear();
  g_argStore.emplace_back("node");
  uint32_t len = 0;
  if (argc >= 1 && napi_get_array_length(env, args[0], &len) == napi_ok) {
    for (uint32_t i = 0; i < len; i++) {
      napi_value el = nullptr;
      if (napi_get_element(env, args[0], i, &el) != napi_ok) continue;
      size_t n = 0;
      if (napi_get_value_string_utf8(env, el, nullptr, 0, &n) != napi_ok) continue;
      std::string s(n, '\0');
      napi_get_value_string_utf8(env, el, &s[0], n + 1, &n);
      g_argStore.push_back(s);
    }
  }

  uint32_t envCount = 0;
  int envBad = 0;
  if (argc >= 2 && napi_get_array_length(env, args[1], &envCount) == napi_ok) {
    for (uint32_t i = 0; i < envCount; i++) {
      napi_value el = nullptr;
      if (napi_get_element(env, args[1], i, &el) != napi_ok) continue;
      size_t n = 0;
      if (napi_get_value_string_utf8(env, el, nullptr, 0, &n) != napi_ok) continue;
      std::string pair(n, '\0');
      napi_get_value_string_utf8(env, el, &pair[0], n + 1, &n);
      const size_t eq = pair.find('=');
      if (eq == std::string::npos || eq == 0) {
        envBad++;
        continue;
      }
      // 必须在 node::Start 之前生效：Node 启动时就会读 process.env。
      setenv(pair.substr(0, eq).c_str(), pair.substr(eq + 1).c_str(), 1);
    }
  }

  g_argv.clear();
  for (std::string& s : g_argStore) {
    g_argv.push_back(&s[0]);
  }

  // r47：JIT/WASM 可行性探针（写在 env 生效之后、起 Node 之前；纯试探不影响启动）。
  WriteWxProbe();

  g_started.store(true);
  g_running.store(true);

  std::string logPath;
  const char* homeEnv = ::getenv("MOTRIX_SANDBOX_HOME");
  if (homeEnv != nullptr && homeEnv[0] != '\0') {
    logPath = std::string(homeEnv) + "/node-output.log";
  }

  g_nodeThread = std::thread([logPath]() {
    // 把 Node 的 stdout/stderr 抓进文件：应用进程的 stdout 在设备上看不见，
    // 而 node::Start 的失败原因（入口脚本抛错、配置缺失）全打在 stdout/stderr 上。
    std::string capturePath = logPath;
    if (!capturePath.empty()) {
      if (FILE* f = ::freopen(capturePath.c_str(), "w", stdout)) {
        ::setvbuf(f, nullptr, _IOLBF, 0);
        ::dup2(::fileno(f), 2);
      }
    }
    if (g_nodeStart == nullptr) {
      OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "MOTRIX-SHIM",
                   "node::Start 未解析到（libnode 未首载成功），无法启动 Node");
      g_running.store(false);
      g_started.store(false);
      return;
    }
    int rc = g_nodeStart(static_cast<int>(g_argv.size()), g_argv.data());
    g_running.store(false);
    // 线程退出必须复位，否则这一次失败会把此后所有启动永久拒掉。
    g_started.store(false);

    ::fflush(stdout);
    if (!capturePath.empty()) {
      FILE* f = ::fopen(capturePath.c_str(), "r");
      if (f != nullptr) {
        static char buf[262144];
        size_t n = ::fread(buf, 1, sizeof(buf) - 1, f);
        buf[n] = '\0';
        ::fclose(f);
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "MOTRIX-SHIM",
                     "node::Start returned rc=%{public}d, captured output (%{public}zu bytes):", rc, n);
        std::string all(buf);
        size_t pos = 0;
        while (pos < all.size()) {
          size_t nl = all.find('\n', pos);
          std::string line = all.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
          if (!line.empty()) {
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "MOTRIX-NODEOUT", "%{public}s", line.c_str());
          }
          if (nl == std::string::npos) break;
          pos = nl + 1;
        }
      }
    }
  });
  // 必须 detach：node::Start 永不返回，joinable 的 std::thread 析构会 std::terminate。
  g_nodeThread.detach();

  if (!logPath.empty()) {
    g_tailStop.store(false);
    g_tailThread = std::thread(TailNodeOutput, logPath);
    g_tailThread.detach();
  }

  SetBool(env, out, "started", true);
  napi_value applied = nullptr;
  napi_create_uint32(env, envCount - static_cast<uint32_t>(envBad), &applied);
  napi_set_named_property(env, out, "envApplied", applied);
  SetString(env, out, "note",
            envBad > 0
                ? ("Node 线程已启动，但有 " + std::to_string(envBad) +
                   " 条环境变量格式不合法（缺少 KEY=）已被忽略")
                : "Node 线程已启动（node::Start 阻塞运行）");
  return out;
}

napi_value IsHostRunning(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out = nullptr;
  napi_get_boolean(env, g_running.load(), &out);
  return out;
}

// stopHost(): { ok, note } —— 如实返回做不到（见文件头边界 1）。
napi_value StopHost(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out = nullptr;
  napi_create_object(env, &out);
  SetBool(env, out, "ok", false);
  SetString(env, out, "note",
            "进程内 Node 暂不支持从外部线程停止；当前只能随应用退出而结束。"
            "要让它自己退出，用文件信号让端侧脚本 process.exit()。");
  return out;
}

// 同步探针：供 ArkTS 在**起 Node 之前**决定要不要带 --jitless（r49）。
// 给可执行匿名内存 ⇒ V8 JIT/WASM 可用（需要 ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY
// 的 ACL）；不给（含"坚盾守护模式"）⇒ 回退 --jitless，功能不受影响。
napi_value ProbeExecMemoryNative(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value out = nullptr;
  napi_create_object(env, &out);
  const WxProbeResult probe = ProbeExecMemory();
  const bool allowed = probe.mprotectRxErrno == 0 || probe.mmapRwxErrno == 0;
  napi_value value = nullptr;
  napi_get_boolean(env, allowed, &value);
  napi_set_named_property(env, out, "execmemAllowed", value);
  napi_create_int32(env, probe.mprotectRxErrno, &value);
  napi_set_named_property(env, out, "mprotectRxErrno", value);
  napi_create_int32(env, probe.mmapRwxErrno, &value);
  napi_set_named_property(env, out, "mmapRwxErrno", value);
  napi_create_int32(env, static_cast<int32_t>(probe.pageSize), &value);
  napi_set_named_property(env, out, "pageSize", value);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "MOTRIX-SHIM", "Init called: creating exports object");
  napi_property_descriptor desc[] = {
      {"runtimeVersion", nullptr, RuntimeVersion, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startHost", nullptr, StartHost, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"probeExecMemory", nullptr, ProbeExecMemoryNative, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isHostRunning", nullptr, IsHostRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stopHost", nullptr, StopHost, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

napi_module g_motrixHostModule = {
    1,
    0,
    __FILE__,
    Init,
    "motrixhost",
    nullptr,
    {nullptr},
};
napi_module g_motrixHostModuleFull = {
    1,
    0,
    __FILE__,
    Init,
    "libmotrixhost.so",
    nullptr,
    {nullptr},
};
napi_module g_motrixHostModuleNoExt = {
    1,
    0,
    __FILE__,
    Init,
    "libmotrixhost",
    nullptr,
    {nullptr},
};
napi_module g_motrixHostModuleBareDotSo = {
    1,
    0,
    __FILE__,
    Init,
    "motrixhost.so",
    nullptr,
    {nullptr},
};

}  // namespace

// 构造器：首载 libnode（RTLD_GLOBAL）+ 注册模块（四种名字口径都注册）。
extern "C" __attribute__((constructor)) void RegisterMotrixHostModule() {
  static const char* kLibnodeCandidates[] = {
      "libnode.so.137",  // Node 24.x/26.x ABI 137（当前资产，参考宿主项目 真机已验证）
      "libnode.so.127",  // Node 22/24 历史基线
      "libnode.so",
  };
  std::string libsDir;
  Dl_info selfInfo;
  if (::dladdr(reinterpret_cast<void*>(&RegisterMotrixHostModule), &selfInfo) != 0 &&
      selfInfo.dli_fname != nullptr) {
    std::string selfPath(selfInfo.dli_fname);
    const size_t slash = selfPath.find_last_of('/');
    if (slash != std::string::npos) libsDir = selfPath.substr(0, slash + 1);
  }
  void* handle = nullptr;
  std::string libnodePath;
  // 必须用绝对路径首载：裸 soname 会按搜索路径找，bundle 的 libs 目录未必在里面，
  // 症状是"应用一条日志都打不出来"。
  for (const char* candidate : kLibnodeCandidates) {
    const std::string p = libsDir + candidate;
    void* h = ::dlopen(p.c_str(), RTLD_NOW | RTLD_GLOBAL);
    if (h != nullptr) {
      handle = h;
      libnodePath = p;
      break;
    }
  }
  if (handle != nullptr) {
    g_libnode = handle;
    g_nodeStart = reinterpret_cast<NodeStartFn>(::dlsym(handle, "_ZN4node5StartEiPPc"));
  }
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "MOTRIX-SHIM",
               "first-load %{public}s (RTLD_GLOBAL): handle=%{public}s node::Start=%{public}s",
               libnodePath.c_str(), handle != nullptr ? "ok" : "failed",
               g_nodeStart != nullptr ? "ok" : "missing");
  napi_module_register(&g_motrixHostModule);
  napi_module_register(&g_motrixHostModuleFull);
  napi_module_register(&g_motrixHostModuleNoExt);
  napi_module_register(&g_motrixHostModuleBareDotSo);
  OH_LOG_Print(LOG_APP, LOG_INFO, 0x0000, "MOTRIX-SHIM", "registration calls returned");
}