/**
 * libmotrixhost.so —— 端侧 Node 运行时引导模块。
 *
 * 语义要点（实现见 motrixhost.cc）：
 *  · startHost 只在**首次**调用时真的启动；同一进程只允许一个 Node 实例；
 *  · envPairs 必须在 Node 启动前给出（Node 一起来就读 process.env，之后再设无效）；
 *  · stopHost 如实返回 ok:false —— 进程内 Node 无法从外部线程停止。
 */
export interface StartHostResult {
  /** Node 线程是否已启动（false = 拒绝启动，原因在 note） */
  started: boolean;
  /** 成功应用的环境变量条数 */
  envApplied?: number;
  /** 人类可读说明（拒绝原因 / 被忽略的 env 条数） */
  note: string;
}

export interface StopHostResult {
  ok: boolean;
  note: string;
}

/** 编译进 libnode.so 的 Node 版本（返回非空 = 模块与 libnode 链上了） */
export const runtimeVersion: string;

/**
 * 启动进程内 Node。
 * @param argv 不含 argv[0] 的参数表（本函数会补 "node"）；建议以 `--jitless` 开头。
 * @param envPairs "KEY=VALUE" 形式的环境变量。
 */
export const startHost: (argv: string[], envPairs: string[]) => StartHostResult;

/** Node 线程是否还活着（进程级事实） */
export const isHostRunning: () => boolean;

/** 停止（当前恒为 ok:false，见上） */
export const stopHost: () => StopHostResult;

/**
 * 同步探针：本进程能否申请**可执行匿名内存**（V8 JIT / WebAssembly）。
 *
 * HarmonyOS 内核对匿名内存可执行有强制管控（应用域返回 EINVAL）；
 * 只有拿到受限 ACL `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` 才为 true。
 * `startHost` 之前调用；ArkTS 据此决定 Node 是否带 `--jitless`（r49）。
 */
export const probeExecMemory: () => ExecMemoryProbeResult;

export interface ExecMemoryProbeResult {
  /** true = 可以申请可执行内存（JIT/WASM 可用） */
  execmemAllowed: boolean;
  /** mprotect(PROT_EXEC) 的 errno（0 = 成功） */
  mprotectRxErrno: number;
  /** mmap(PROT_READ|WRITE|EXEC) 的 errno（0 = 成功） */
  mmapRwxErrno: number;
  pageSize: number;
}
