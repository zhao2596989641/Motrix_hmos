// 独立的"node 壳"：dlopen libnode.so.137 并跑 node::Start。
//
// 为什么需要它：设备上 Node 是**同进程内**由 libmotrixhost.so 起来的，
// 本机没有独立的 node 可执行文件，就没法复现"设备上 libnode 24.2.0 + --jitless"的行为。
// 这个壳让本机能用**同一个 libnode**、同样的 argv 跑我们的入口脚本，
// 于是设备上那些只在 libnode 上出现的失败可以本地迭代（省掉每次十几分钟的真机往返）。
//
// 用法：./node-launcher [node 参数…] <脚本>
//   libnode 与 libc++_shared 需在同一目录（或设 MOTRIX_LIBNODE 指绝对路径）。
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef int (*NodeStartFn)(int, char**);

int main(int argc, char** argv) {
  const char* candidates[] = {"libnode.so.137", "libnode.so.127", "libnode.so", NULL};
  void* handle = NULL;
  char buf[4096];
  const char* env = getenv("MOTRIX_LIBNODE");
  if (env != NULL && env[0] != '\0') {
    handle = dlopen(env, RTLD_NOW | RTLD_GLOBAL);
    if (handle == NULL) { fprintf(stderr, "dlopen(%s) failed: %s\n", env, dlerror()); return 2; }
  } else {
    // 先试脚本自身所在目录
    ssize_t n = readlink("/proc/self/exe", buf, sizeof(buf) - 1);
    if (n > 0) {
      buf[n] = '\0';
      char* slash = strrchr(buf, '/');
      if (slash != NULL) {
        *slash = '\0';
        for (int i = 0; candidates[i] != NULL; i++) {
          char path[4096];
          snprintf(path, sizeof(path), "%s/%s", buf, candidates[i]);
          handle = dlopen(path, RTLD_NOW | RTLD_GLOBAL);
          if (handle != NULL) break;
        }
      }
    }
    if (handle == NULL) {
      for (int i = 0; candidates[i] != NULL; i++) {
        handle = dlopen(candidates[i], RTLD_NOW | RTLD_GLOBAL);
        if (handle != NULL) break;
      }
    }
  }
  if (handle == NULL) { fprintf(stderr, "libnode not found: %s\n", dlerror()); return 2; }

  NodeStartFn start = (NodeStartFn)dlsym(handle, "_ZN4node5StartEiPPc");
  if (start == NULL) { fprintf(stderr, "node::Start not found\n"); return 3; }

  // node::Start 要求 argv[0] 是程序名
  char** nodeArgv = (char**)calloc((size_t)argc + 2, sizeof(char*));
  if (nodeArgv == NULL) return 4;
  int out = 0;
  nodeArgv[out++] = (char*)"node";
  for (int i = 1; i < argc; i++) nodeArgv[out++] = argv[i];
  nodeArgv[out] = NULL;

  int rc = start(out, nodeArgv);
  fprintf(stderr, "node::Start returned %d\n", rc);
  return rc;
}
