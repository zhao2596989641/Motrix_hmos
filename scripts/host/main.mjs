// Motrix 端侧 Node 宿主入口（构建期拷进 resfile/app/main.mjs）。
//
// 职责（只做四件事，业务全在上游 server 里）：
//   1. 把 ArkTS 侧没法算的路径/环境变量补齐，然后把 Motrix server 拉起来；
//   2. 等它真的在 loopback 上应答（/healthz 200）；
//   3. 用服务自己落盘的 operator token 做一次本地登录，拿到会话 cookie；
//   4. 把 {port, cookie, pid} 写进 host-ready.json —— 这是与 ArkTS 的唯一交接面。
//
// 为什么第 3 步要在这里做（而不是 ArkTS）：ArkTS 侧用 @ohos.net.http 打 127.0.0.1
// 会受系统代理影响而超时（参考宿主项目 实测），而 Node 自己打自己一定通。
//
// 与 ArkTS 的契约（不要单方面改）：
//   输入：MOTRIX_SANDBOX_HOME / MOTRIX_APP_ROOT / MOTRIX_DATA_DIR /
//         MOTRIX_PUBLIC_DOWNLOAD / MOTRIX_PORT / PORT（由 ArkTS 在 startHost 里给）
//   输出：<DATA_DIR>/host-ready.json  { pid, port, cookie, token, startedAt }
//         <SANDBOX_HOME>/node-output.log（stdout/stderr 由原生层重定向）

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import Module, { createRequire } from 'node:module'
import path from 'node:path'

const log = (...args) => {
  console.log('[motrix-host]', ...args)
}

// ── 全局守门：把"异步失败但没人接"的东西记下来，别让整个宿主陪葬 ──────────────
//
// 【为什么必须有】（2026-11-24 真机 + 同款 libnode 本地复现）
// `--jitless` ⇒ `WebAssembly === undefined`；而这台 libnode 24.2.0 里，
// Node 内置 undici（fetch/WebSocket 的实现）会在某些路径上**异步**去编译 llhttp 的 WASM，
// 编译失败产生一个 promise rejection。没有人 catch 它 ⇒ Node 视为未处理拒绝 ⇒ **进程直接退出**。
// 症状极具误导性：日志停在"import server…"，看起来像 server 崩了，其实是一段与业务无关的
// 惰性初始化在后台失败。
//
// 处置：把这两类未捕获事件收下来记日志、**不让它杀进程**。业务真正需要的 fetch/WebSocket
// 已由下面的纯 JS 垫片接管，这条 undici 路径根本不参与我们的功能。
process.on('unhandledRejection', (reason) => {
  const message = reason && reason.message ? reason.message : String(reason)
  console.log('[motrix-host][guard] unhandledRejection（已吞下，不退出）:', message)
})
process.on('uncaughtException', (error) => {
  const message = error && error.message ? error.message : String(error)
  console.log('[motrix-host][guard] uncaughtException（已吞下，不退出）:', message)
})


const env = process.env
const sandboxHome = env.MOTRIX_SANDBOX_HOME || ''
const appRoot = env.MOTRIX_APP_ROOT || ''
const dataDir = env.MOTRIX_DATA_DIR || (sandboxHome ? path.join(sandboxHome, 'motrix') : '')
const port = Number(env.MOTRIX_PORT || env.PORT || 21420)

if (!sandboxHome) throw new Error('缺 MOTRIX_SANDBOX_HOME（原生层没设？）')
if (!appRoot) throw new Error('缺 MOTRIX_APP_ROOT（resfile/app 的绝对路径）')
if (!dataDir) throw new Error('缺 MOTRIX_DATA_DIR')

// ── 原生库重定向：必须在**任何 .node 被 require 之前**装好 ────────────────────
//
// 【r6 真机的真正死因（node-output.log 第 23 行）】
//   fatal Error: Error loading shared library .../resfile/app/node_modules/
//   better-sqlite3/build/Release/better_sqlite3.node: No error information
// 这条报错不是"缺依赖"、也不是"没签名"（binary-sign-tool display-sign 显示 self-sign ok）。
// 鸿蒙的策略是：**运行时解包到沙箱里的原生库，dlopen 一律被拦**，报错就是那句没有 errno 的
// "No error information"；只有随 HAP 的 `libs/<abi>/` 提供的库才放行
// （参考宿主项目 真机 E18/E39 的原话与同款报错，见 `docs/70` §1.1）。
//
// hvigor 又**只打包扁平的 `libs/<abi>/*.so`**（嵌套的 `.node` 不进包，参考宿主项目 E40①），
// 所以没法按 loader 的候选路径原样摆放。做法（照抄 参考宿主项目 `installNativeRedirect`）：
//   1) 构建期：device 变体的 better_sqlite3.node → `entry/libs/arm64-v8a/libbetter_sqlite3.so`；
//   2) 运行期：同时接管 `fs.existsSync` / `Module._extensions['.node']` / `Module._resolveFilename`，
//      把"对沙箱 .node 的 require"改写成"从 libs/ 加载 libbetter_sqlite3.so"。
// 依赖闭包不用改：device 变体本来就 DT_NEEDED libnode.so.137，libnode 就在同一个 libs/ 目录里。
const NATIVE_LIBS = resolveNativeLibsDir(appRoot)
installNativeRedirect(NATIVE_LIBS)

// ── 兜底层：Node 侧的 process.exit 会杀掉**整个应用进程** ────────────────────
//
// 进程内嵌 Node 与 ArkTS 是同一个进程：上游 server 的 fatal 路径会 process.exit(1)，
// libc 的 exit() 直接终止整个应用 ⇒ 用户看到的就是"闪退"（r6 日志末尾 "fatal … shutting down"）。
// 这里把 exit 拦下来：写 host-failed.json 给 ArkTS 侧走错误页/重试，应用本身留在前台。
// 正常退出只允许一条通道：收到 host-stop-request 后由本脚本显式放行（见文件末尾）。
const realExit = process.exit.bind(process)
let exitAllowed = false
let currentStage = ''
process.exit = (code) => {
  if (exitAllowed) {
    realExit(code)
    return
  }
  const numeric = code === undefined ? 0 : Number(code)
  try {
    fs.writeFileSync(
      path.join(sandboxHome, 'host-failed.json'),
      JSON.stringify({
        code: Number.isFinite(numeric) ? numeric : 0,
        stage: currentStage,
        at: Date.now(),
        reason: 'Node 侧调用了 process.exit；已拦截（真退出会带走整个应用进程）',
      })
    )
  } catch {}
  log(`process.exit(${code}) 被拦截：Node 与 ArkTS 同进程，真退出会把整个应用带走`)
}

// 上一次运行留下的失败标记不能影响本次（同一个 dataDir 会跨版本保留）
try {
  fs.unlinkSync(path.join(sandboxHome, 'host-failed.json'))
} catch {}

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'home'), { recursive: true })

// ── 把随包 ELF 物化到沙箱再 exec ──────────────────────────────────────────────
//
// 【r7 真机的第二层死因（node-output.log）】
//   fatal Error: spawn EPERM
//     at NativeFinalizeFilesystemAdapter.startChild (.../dist/server/index.mjs)
// 即 `motrix-finalize-fs` 从 resfile 路径 spawn 不起来。
// 机制（参考宿主项目 真机实测，docs/104 §3）：**HAP 里随包的 ELF** 的 MAC 标签是
// `debug_hap_data_file`，app 域 execve 被拒；而**应用沙箱（el2 filesDir）里自签名的 ELF**
// 可以 execve（PC/2in1 档，探针 10/10）。
//
// 实测（本机 = 同一台鸿蒙 PC，同一个 app 域）：把 `<appRoot>/bin/{aria2c,motrix-finalize-fs}`
// 拷到 `<filesDir>` 下 `chmod 755` 后，`./aria2c --version` 与 `./motrix-finalize-fs` 直接跑通；
// 同二进制留在 resfile 里则 spawn EPERM。所以启动时**先物化再 exec**，aria2 与 finalize-fs 同理。
//
// 幂等 & 封存态（参考宿主项目 E214）：
//   - 用源文件 sha256 做指纹，指纹 + X_OK 都命中就复用，避免每次启动重写 11MB；
//   - 需要重写时：先写临时名 → chmod → 删旧 → rename（新 inode），避免"封存态"覆盖 EPERM。
function materializeExecutable(name) {
  const source = path.join(appRoot, 'bin', name)
  const binDir = path.join(dataDir, 'bin')
  if (!fs.existsSync(source)) {
    log(`警告：随包缺 bin/${name}`)
    return ''
  }
  let destination = ''
  try {
    fs.mkdirSync(binDir, { recursive: true })
    const bytes = fs.readFileSync(source)
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    destination = path.join(binDir, name)
    const stampPath = `${destination}.sha256`
    let reusable = false
    try {
      const sameDigest = fs.readFileSync(stampPath, 'utf8').trim() === digest
      const sameSize = fs.statSync(destination).size === bytes.length
      if (sameDigest && sameSize) {
        fs.accessSync(destination, fs.constants.X_OK)
        reusable = true
      }
    } catch {}
    if (reusable) {
      log(`复用沙箱内可执行文件：${destination}`)
      return destination
    }
    const temporary = `${destination}.new-${process.pid}`
    try { fs.rmSync(temporary, { force: true }) } catch {}
    // 直接以 0755 建新文件（新 inode），再补一次 chmod；封存态覆盖一律绕开
    fs.writeFileSync(temporary, bytes, { mode: 0o755 })
    try { fs.chmodSync(temporary, 0o755) } catch {}
    try { fs.rmSync(destination, { force: true }) } catch {}
    fs.renameSync(temporary, destination)
    // 指纹也走临时名 + rename：下次升级重写时不会碰到"封存态"的写拒绝
    try {
      const stampTmp = `${stampPath}.new-${process.pid}`
      fs.writeFileSync(stampTmp, digest)
      fs.renameSync(stampTmp, stampPath)
    } catch {}
    log(`已物化可执行文件：${destination}（sha256=${digest.slice(0, 12)}…）`)
    return destination
  } catch (error) {
    log(`物化 ${name} 失败（${error.code || error.message}）`)
    // 已经写出一份可执行副本时，宁可试它，也不回退到必然被拒的 resfile 路径
    if (destination) {
      try {
        fs.accessSync(destination, fs.constants.X_OK)
        return destination
      } catch {}
    }
    return source
  }
}

// ── 可执行文件：官方 hap-bin（HAP libs/ + executableBinaryPaths）──────────────
//
// 官方文档：应用程序包集成 bin 文件（PC/2in1），API 24+。
//   构建期 bin 放 `entry/libs/{abi}/`；module.json5 用 `executableBinaryPaths` 声明
//   `libs/{abi}/<name>`，并设 `extractNativeLibs: true`。安装时系统把 libs 解压到
//   `<bundle>/libs/arm64/`，给清单里的文件执行属性（SELinux label=data_app_el1_file，
//   策略 `(allow normal_hap_attr data_app_el1_file (file (execute)))` 对普通应用放行）。
//
// 这是普通应用 exec 随包 ELF 的官方通道。HNP 安装器对 debug 普通应用的内容校验
// 过不去（9568407），已弃用；el2 数据目录的 ELF 仍被 debug_hap 域拒绝（r8 的死因）。
const existsQuiet = (candidate) => {
  try { return fs.existsSync(candidate) } catch { return false }
}
const execLibsDir = resolveNativeLibsDir(appRoot)
log(`exec libs   = ${execLibsDir}`)

/** 安装后的 bin 路径：`<bundle>/libs/arm64/`；兼容本地 repro 的 `libs/arm64-v8a/`。
 *  优先找带 `.bin` 的暂存名：hap-sign-tool 会跳过无扩展名条目（见 module.json5 注释），
 *  不带后缀的 `aria2c` 无法通过安装器的 native lib 代码签名校验。 */
function resolveBundledExecutable(name) {
  const dirs = [
    execLibsDir,
    path.join(execLibsDir, '..', 'arm64-v8a'),
    path.join(execLibsDir, '..', 'arm64'),
  ]
  for (const dir of dirs) {
    for (const file of [`${name}.bin`, name]) {
      const candidate = path.join(dir, file)
      if (existsQuiet(candidate)) return candidate
    }
  }
  return ''
}
const libsAria2 = resolveBundledExecutable('aria2c')
const libsFinalize = resolveBundledExecutable('motrix-finalize-fs')
if (libsAria2) log(`libs 可执行：aria2c     = ${libsAria2}`)
if (libsFinalize) log(`libs 可执行：finalize-fs = ${libsFinalize}`)

// 显式覆盖优先（本地 repro 会传）；其次是 HAP libs/；最后才是沙箱物化兜底
const explicitAria2 = env.MOTRIX_ARIA2_BIN && existsQuiet(env.MOTRIX_ARIA2_BIN) ? env.MOTRIX_ARIA2_BIN : ''
const explicitFinalize = env.MOTRIX_FINALIZE_FS_BIN && existsQuiet(env.MOTRIX_FINALIZE_FS_BIN) ? env.MOTRIX_FINALIZE_FS_BIN : ''
const aria2Binary = explicitAria2 || libsAria2 || materializeExecutable('aria2c')
const finalizeFsBinary = explicitFinalize || libsFinalize || materializeExecutable('motrix-finalize-fs')

// ── 补齐 server 需要的环境变量 ────────────────────────────────────────────────
// 这些都是"运行期才知道的绝对路径"：上游默认按 Linux 系统布局算，在 HAP 沙箱里全是错路径。
const defaults = {
  MOTRIX_DATA_DIR: dataDir,
  MOTRIX_TEMP_DIR: path.join(dataDir, 'tmp'),
  MOTRIX_RENDERER_DIR: path.join(appRoot, 'dist', 'renderer-web'),
  MOTRIX_ARIA2_BIN: aria2Binary || path.join(appRoot, 'bin', 'aria2c'),
  MOTRIX_FINALIZE_FS_BIN: finalizeFsBinary || path.join(appRoot, 'bin', 'motrix-finalize-fs'),
  MOTRIX_EXTRA_DIR: path.join(appRoot, 'extra'),
  MOTRIX_PLUGIN_DIR: path.join(dataDir, 'plugins'),
  MOTRIX_BUILTIN_PLUGIN_DIR: path.join(appRoot, 'builtin-plugins'),
  // 浏览器扩展配对通道端侧用不上；置 0 关掉固定端口，少一处监听面
  MOTRIX_MDXP_PORT: '0',
  // 应用内 HOME 指向数据目录：插件/工具链拿到的都是可写目录
  HOME: path.join(dataDir, 'home'),
  TMPDIR: path.join(dataDir, 'tmp'),
  // aria2 的 HTTPS 靠这个 CA 包（随包带；鸿蒙上没有 /etc/ssl/certs 全集）
  SSL_CERT_FILE: path.join(appRoot, 'cacert.pem'),
  PORT: String(port),
  NODE_ENV: 'production',
  LOG_LEVEL: env.LOG_LEVEL || 'info',
}
for (const [k, v] of Object.entries(defaults)) {
  if (env[k] === undefined || env[k] === '') env[k] = v
}
// ── 下载目录：**必须能写**，不能写就退回沙箱 ─────────────────────────────────
// 应用进程没有在公共 Download 根下 mkdir 的权限（真机实测 EPERM），
// 所以公共目录只能由 ArkTS 侧的 DOWNLOAD 模式 picker 建立归属后传进来；
// 这里只做"探写 → 失败就退"两件事，绝不因目录问题让整个应用起不来。
function ensureWritableDir(candidate, fallback) {
  try {
    fs.mkdirSync(candidate, { recursive: true })
  } catch (error) {
    log(`mkdir ${candidate} 失败（${error.code || error.message}），试兜底目录`)
  }
  try {
    const probe = path.join(candidate, '.motrix-write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return candidate
  } catch (error) {
    if (fallback && fallback !== candidate) {
      log(`${candidate} 不可写（${error.code || error.message}），退回 ${fallback}`)
      fs.mkdirSync(fallback, { recursive: true })
      return fallback
    }
    throw new Error(`没有可写的下载目录：${candidate}（${error.code || error.message}）`)
  }
}

const sandboxDownloads = path.join(dataDir, 'Downloads')
const wantedSaveDir = env.MOTRIX_DEFAULT_SAVE_DIR || env.MOTRIX_PUBLIC_DOWNLOAD || sandboxDownloads
delete env.MOTRIX_DEFAULT_SAVE_DIR
env.MOTRIX_DEFAULT_SAVE_DIR = ensureWritableDir(wantedSaveDir, sandboxDownloads)
// 白名单跟着实际目录走：空列表会让 server 认为"只允许默认目录"，是安全的默认
env.MOTRIX_ALLOWED_SAVE_DIRS = env.MOTRIX_DEFAULT_SAVE_DIR
process.chdir(dataDir)

log('sandboxHome =', sandboxHome)
log('appRoot     =', appRoot)
log('dataDir     =', dataDir)
log('port        =', port)
log('saveDir     =', env.MOTRIX_DEFAULT_SAVE_DIR)
log('aria2 bin   =', env.MOTRIX_ARIA2_BIN)
log('finalize-fs =', env.MOTRIX_FINALIZE_FS_BIN)

// ── 工具：一次 HTTP 请求 ─────────────────────────────────────────────────────
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      }
    )
    req.on('error', reject)
    req.setTimeout(5000, () => req.destroy(new Error('timeout')))
    if (payload) req.write(payload)
    req.end()
  })
}


// ── 纯 JS fetch（不依赖 WASM 的最小实现） ────────────────────────────────────
// 只实现 Motrix 用到的那一面：字符串/Buffer 请求体、自定义 headers、AbortSignal、
// 最多 5 次重定向、response.{ok,status,statusText,headers,text,json,arrayBuffer}。
class ShimHeaders {
  constructor(init) {
    this._map = new Map()
    if (init === undefined || init === null) return
    if (init instanceof ShimHeaders || typeof init.forEach === 'function') {
      init.forEach((value, name) => this.append(name, value))
    } else if (Array.isArray(init)) {
      for (const pair of init) {
        if (Array.isArray(pair) && pair.length >= 2) this.append(pair[0], pair[1])
      }
    } else if (typeof init === 'object') {
      for (const key of Object.keys(init)) this.append(key, init[key])
    }
  }
  append(name, value) {
    const key = String(name).toLowerCase()
    const prev = this._map.get(key)
    this._map.set(key, prev === undefined ? String(value) : `${prev}, ${value}`)
  }
  set(name, value) { this._map.set(String(name).toLowerCase(), String(value)) }
  get(name) {
    const value = this._map.get(String(name).toLowerCase())
    return value === undefined ? null : value
  }
  has(name) { return this._map.has(String(name).toLowerCase()) }
  delete(name) { this._map.delete(String(name).toLowerCase()) }
  forEach(callback, thisArg) {
    for (const [key, value] of this._map) callback.call(thisArg, value, key, this)
  }
  entries() { return this._map.entries() }
  [Symbol.iterator]() { return this._map.entries() }
}

class ShimResponse {
  constructor(res, url) {
    this._res = res
    this.url = url
    this.status = res.statusCode ?? 0
    this.statusText = res.statusMessage ?? ''
    this.ok = this.status >= 200 && this.status < 300
    this.headers = new ShimHeaders(res.headers)
  }
  async arrayBuffer() {
    const chunks = []
    for await (const chunk of this._res) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  async text() { return Buffer.from(await this.arrayBuffer()).toString('utf8') }
  async json() { return JSON.parse(await this.text()) }
}

function encodeShimBody(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  return Buffer.from(String(body))
}

function buildShimFetch() {
  return function shimFetch(input, init) {
    const options = init || {}
    const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
    const method = (options.method || 'GET').toUpperCase()
    const headers = new ShimHeaders(options.headers)
    const body = encodeShimBody(options.body)
    if (body !== null && !headers.has('content-length')) headers.set('content-length', String(body.length))

    const once = (targetUrl, hops) => new Promise((resolve, reject) => {
      let parsed
      try { parsed = new URL(targetUrl) } catch (error) { reject(new TypeError('Invalid URL: ' + targetUrl)); return }
      const transport = parsed.protocol === 'https:' ? https : http
      const req = transport.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers: Object.fromEntries(headers.entries()),
      }, (res) => {
        const status = res.statusCode || 0
        const location = res.headers.location
        if (location && status >= 300 && status < 400) {
          res.resume()
          if (hops >= 5) { reject(new TypeError('redirect count exceeded')); return }
          const nextUrl = new URL(location, targetUrl).href
          if (status === 303) {
            const nextOptions = { ...options, method: 'GET', body: undefined }
            const nextHeaders = new ShimHeaders(nextOptions.headers)
            onceWith(nextUrl, hops + 1, 'GET', nextHeaders, null, options.signal).then(resolve, reject)
            return
          }
          onceWith(nextUrl, hops + 1, method, headers, body, options.signal).then(resolve, reject)
          return
        }
        resolve(new ShimResponse(res, targetUrl))
      })
      const signal = options.signal
      if (signal && signal.aborted) { req.destroy(new Error('aborted')); reject(new Error('aborted')); return }
      const onAbort = () => req.destroy(new Error('aborted'))
      if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
      req.on('error', reject)
      if (body !== null) req.write(body)
      req.end()
    })

    function onceWith(targetUrl, hops, useMethod, useHeaders, useBody, signal) {
      return new Promise((resolve, reject) => {
        let parsed
        try { parsed = new URL(targetUrl) } catch (error) { reject(new TypeError('Invalid URL: ' + targetUrl)); return }
        const transport = parsed.protocol === 'https:' ? https : http
        const req = transport.request({
          method: useMethod,
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          headers: Object.fromEntries(useHeaders.entries()),
        }, (res) => {
          const status = res.statusCode || 0
          const location = res.headers.location
          if (location && status >= 300 && status < 400) {
            res.resume()
            if (hops >= 5) { reject(new TypeError('redirect count exceeded')); return }
            const nextUrl = new URL(location, targetUrl).href
            const nextMethod = status === 303 ? 'GET' : useMethod
            onceWith(nextUrl, hops + 1, nextMethod, useHeaders, nextMethod === 'GET' ? null : useBody, signal)
              .then(resolve, reject)
            return
          }
          resolve(new ShimResponse(res, targetUrl))
        })
        if (signal && signal.aborted) { req.destroy(new Error('aborted')); reject(new Error('aborted')); return }
        const onAbort = () => req.destroy(new Error('aborted'))
        if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true })
        req.on('error', reject)
        if (useBody !== null) req.write(useBody)
        req.end()
      })
    }

    return once(url, 0)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等 loopback 上的 HTTP 入口应答 —— **不要求引擎已就绪**（r48 冷启动优化）。
 *
 * 上游 `/healthz` 只有在 `accepting && engine.state === Ready` 时才回 200；而引擎启动是
 * startServer() 主流程的一环、在 app.listen() 之前。旧实现为了一个 200 把引擎启动也
 * 算进宿主关键路径。实际上只要 HTTP 通了（200 或 503），Web UI 就能加载、查询、并通过
 * 事件流拿到引擎状态变化 —— 界面里显示「引擎启动中 → 就绪」本来就是既有行为
 * （r45 起引擎状态已是单例 store，事件驱动）。所以这里只等"端口应答"。
 *
 * 返回 { status, waitedMs }：status=200 表示引擎也已就绪，503 表示 HTTP 通了但引擎还在起。
 */
async function waitListening(deadlineMs) {
  const started = Date.now()
  let lastErr = ''
  let lastStatus = 0
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await request('GET', '/healthz')
      lastStatus = res.status
      // 两个都算"HTTP 入口已在应答"：200 全就绪；503 = degraded（引擎没 Ready）。
      if (res.status === 200 || res.status === 503) {
        return { status: res.status, waitedMs: Date.now() - started }
      }
      lastErr = `status ${res.status}`
    } catch (error) {
      lastErr = error.message
    }
    await sleep(60)
  }
  throw new Error(
    `server HTTP 未在 ${deadlineMs}ms 内应答（最后一次：${lastErr || 'status ' + lastStatus}）`
  )
}

// ── 原生库重定向的实现（调用点在文件上面的 env 段） ───────────────────────────
//
// 推导 HAP 的扁平原生库目录：入口在 `<bundle>/entry/resources/resfile/app/main.mjs`，
// 原生库在 `<bundle>/libs/arm64/`（真机崩溃日志里的 libnode.so.137 路径可证）。
// 用 appRoot 往上四级拿 <bundle>，不依赖 ArkTS 再传一个 env（少一个漂移点）；
// MOTRIX_NATIVE_LIBS 只作为显式覆盖（本地复现 / 诊断用）。
function resolveNativeLibsDir(root) {
  const override = env.MOTRIX_NATIVE_LIBS || ''
  if (override.length > 0) return override
  let bundleRoot = ''
  try {
    bundleRoot = path.resolve(root, '../../../..')
  } catch {
    return ''
  }
  const candidates = [
    path.join(bundleRoot, 'libs', 'arm64'), // 真机（ABI 目录名 arm64）
    path.join(bundleRoot, 'libs', 'arm64-v8a'), // 兜底：本地 repro / 其它打包口径
  ]
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {}
  }
  return candidates[0]
}

/** 沙箱内的 .node 路径 → libs/ 下的平铺文件名。约定：`lib<去掉扩展名的包名>.so` */
function flatNativeName(basename) {
  const stem = String(basename).replace(/\.node$/, '')
  return `lib${stem}.so`
}

/**
 * 把"沙箱里的 .node"重定向到 HAP `libs/` 下加载（参考宿主项目 真机 E39 的原样做法）。
 *
 * 三层接管缺一不可：
 *   - `fs.existsSync`：原生包的 loader（better-sqlite3 的 binding.js 就是）先探测候选路径，
 *     探测失败就走"prebuild / 直接抛错"的旁路，根本走不到 require；
 *   - `Module._resolveFilename`：`require('/abs/.../better_sqlite3.node')` 在文件不存在时
 *     会在解析阶段就 MODULE_NOT_FOUND，走不到扩展加载器；
 *   - `Module._extensions['.node']` / `.so`：真正落到 process.dlopen 的那一步，把路径换成平铺 .so。
 */
function installNativeRedirect(libsDir) {
  try {
    if (!libsDir || !fs.existsSync(libsDir)) {
      log(`原生库重定向未启用（libsDir=${libsDir || '(空)'}）`)
      return false
    }
    const realExists = fs.existsSync.bind(fs)
    const logged = new Set()
    const redirect = (p) => {
      try {
        if (typeof p !== 'string' || !p.endsWith('.node')) return null
        const flat = path.join(libsDir, flatNativeName(path.basename(p)))
        if (!realExists(flat)) return null
        if (!logged.has(flat)) {
          logged.add(flat)
          log(`原生库重定向：${p} → ${flat}`)
        }
        return flat
      } catch {
        return null
      }
    }
    fs.existsSync = function (p) {
      return redirect(p) !== null ? true : realExists(p)
    }
    const nodeLoader = Module._extensions['.node']
    Module._extensions['.node'] = function (mod, filename) {
      const flat = redirect(filename)
      return nodeLoader.call(this, mod, flat !== null ? flat : filename)
    }
    const realResolve = Module._resolveFilename
    Module._resolveFilename = function (request, parent, isMain, options) {
      try {
        if (typeof request === 'string' && request.endsWith('.node')) {
          const flat = redirect(request)
          if (flat !== null) return flat
        }
      } catch {}
      return realResolve.call(this, request, parent, isMain, options)
    }
    // 重定向后解析出来的是 `.so`；Node 没有这个后缀的处理器会 fallback 到 `.js`
    // 把 ELF 当源码读 —— 补一个，等价于原 `.node` 加载器。
    if (!Module._extensions['.so']) {
      Module._extensions['.so'] = function (mod, filename) {
        return nodeLoader.call(this, mod, filename)
      }
    }
    log(`原生库重定向已启用：libs=${libsDir}`)
    return true
  } catch (error) {
    log(`原生库重定向安装失败：${error && error.message ? error.message : String(error)}`)
    return false
  }
}

// 顶层异常也要留下痕迹：设备上没有 DevEco 时，node-output.log 是唯一线索
const stageHistory = []
const bootStartedAt = Date.now()

function writeStage(stage, detail) {
  currentStage = stage
  const at = Date.now()
  stageHistory.push({ stage, at, deltaMs: at - bootStartedAt })
  try {
    const stagePath = path.join(sandboxHome, 'boot-stage.json')
    // 记录完整阶段时间线（stages[]）：冷启动优化时直接看每步耗时
    fs.writeFileSync(
      stagePath,
      JSON.stringify({ stage, detail, at, startedAt: bootStartedAt, stages: stageHistory })
    )
  } catch {}
}
writeStage('env_ready', { appRoot, dataDir, saveDir: env.MOTRIX_DEFAULT_SAVE_DIR })

// ── 启动期自检：SELinux 域 + 各候选二进制的 spawn 结果 ─────────────────────────
//
// 真机没有 DevEco 时，这份 `<SANDBOX_HOME>/spawn-probe.json` 就是判据：
//   · domain 决定"允许 exec 哪类文件"（debug_hap ≠ develop_tools_debug_hap）；
//   · 哪一条 ok、哪一条 EPERM/EACCES，一眼就能区分"路径域 / HNP 没装 / 文件模式"。
function spawnProbe(label, command, args) {
  const started = Date.now()
  try {
    const result = spawnSync(command, args, {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return {
      label,
      command,
      ok: result.error === undefined && result.status === 0,
      status: result.status,
      signal: result.signal,
      error: result.error ? (result.error.code || result.error.message) : '',
      stdout: typeof result.stdout === 'string' ? result.stdout.trim().slice(0, 160) : '',
      stderr: typeof result.stderr === 'string' ? result.stderr.trim().slice(0, 160) : '',
      ms: Date.now() - started,
    }
  } catch (error) {
    return { label, command, ok: false, error: error.code || error.message }
  }
}

function runSpawnDiagnostics() {
  let domain = ''
  try { domain = fs.readFileSync('/proc/self/attr/current', 'utf8').trim() } catch {}
  const sandboxBin = path.join(dataDir, 'bin')
  const probes = [
    spawnProbe('system-toybox', '/system/bin/toybox', []),
    spawnProbe('libs-aria2c', libsAria2 || path.join(execLibsDir, 'aria2c.bin'), ['--version']),
    spawnProbe('libs-finalize-fs', libsFinalize || path.join(execLibsDir, 'motrix-finalize-fs.bin'), []),
    spawnProbe('el2-aria2c', path.join(sandboxBin, 'aria2c'), ['--version']),
    spawnProbe('el2-finalize-fs', path.join(sandboxBin, 'motrix-finalize-fs'), []),
    // resfile/app/bin 默认不再随包（见 build-node-bundle.mjs 第 5 步）：文件不在就不探，
    // 免得 spawn-probe.json 里永远挂着一条无意义的 ENOENT。
    ...(existsQuiet(path.join(appRoot, 'bin', 'motrix-finalize-fs'))
      ? [spawnProbe('resfile-finalize-fs', path.join(appRoot, 'bin', 'motrix-finalize-fs'), [])]
      : []),
  ]
  for (const probe of probes) {
    log(`spawn-probe ${probe.label}: ${probe.ok ? 'ok' : 'FAIL'}${probe.ok ? '' : ` (${probe.error || 'status=' + probe.status || 'signal=' + probe.signal})`}`)
  }
  log(`spawn-probe domain = ${domain || '(读不到 /proc/self/attr/current)'}`)
  try {
    fs.writeFileSync(
      path.join(sandboxHome, 'spawn-probe.json'),
      JSON.stringify({
        domain,
        uid: typeof process.getuid === 'function' ? process.getuid() : -1,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        aria2Bin: env.MOTRIX_ARIA2_BIN,
        finalizeFsBin: env.MOTRIX_FINALIZE_FS_BIN,
        execLibsDir,
        libsResolved: { aria2c: libsAria2, finalizeFs: libsFinalize },
        probes,
      }, null, 2)
    )
  } catch {}
}
// 【r48 冷启动】启动期自检（spawn-probe.json）纯诊断、不参与任何判据，
// 而且里面 5 个 spawnSync 每个 ~60ms —— 以前它挡在 import server 之前，白吃 200ms+。
// 现在推迟到 ready 之后（此时 UI 已在加载），只在真机排查时才需要这份数据。
setTimeout(() => {
  try {
    runSpawnDiagnostics()
  } catch (error) {
    log('spawn diagnostics failed:', error && error.message)
  }
}, 20_000)

// ── 启动前清理自家孤儿子进程（aria2c / motrix-finalize-fs）───────────────────
//
// 【为什么需要】应用被强杀时 aria2 的 `--stop-with-process` 来不及收尾，子进程会变成
// 孤儿继续占着 RPC 端口；下次启动引擎要么起不来、要么被迫顺延端口（r27 起会顺延）。
// 顺延能跑，但旧进程还在后台偷偷下载/占端口，重启引擎时日志里会看到两个 aria2。
//
// 【为什么在宿主启动时扫 /proc 而不是用上游 inspector】上游 `Aria2ProcessInspector`
// 只能"端口 → 进程"反查，且要 `--rpc-secret` 指纹匹配（那是启动参数，得先 buildArgs）。
// 宿主启动这一刻本应用**还没有任何引擎进程**，命中的只可能是上次残留，
// 按"命令行里带随包可执行名"判定就足够准确，也不必知道 secret。
//
// 只杀同 uid 进程（/proc 里本来也只看得到自己的）；杀完等端口释放再进预检。
function killOrphanChildren() {
  const markers = ['aria2c.bin', 'motrix-finalize-fs.bin', '/aria2c ', '/motrix-finalize-fs ']
  let entries = []
  try {
    entries = fs.readdirSync('/proc')
  } catch (error) {
    log(`孤儿清理：读 /proc 失败（${error.message}），跳过`)
    return
  }
  const killed = []
  const failures = []
  let scanned = 0
  const selfPid = process.pid
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    if (pid === selfPid) continue
    let cmdline = ''
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\u0000/g, ' ').trim()
    } catch {
      continue
    }
    if (cmdline.length === 0) continue
    scanned += 1
    if (!markers.some((marker) => cmdline.includes(marker))) continue
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(`${pid}: ${cmdline.slice(0, 120)}`)
    } catch (error) {
      failures.push(`${pid}: ${error.code || error.message}`)
    }
  }
  if (killed.length > 0) {
    log(`孤儿清理：已强杀 ${killed.length} 个残留进程`)
    for (const line of killed) log(`  孤儿清理 kill ${line}`)
  } else {
    log(`孤儿清理：没发现残留（扫了 ${scanned} 个进程）`)
  }
  if (failures.length > 0) log(`孤儿清理：${failures.length} 个杀不掉（${failures.join('; ')}）`)
}

async function waitOrphansGone(timeoutMs) {
  const markers = ['aria2c.bin', 'motrix-finalize-fs.bin']
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let alive = false
    try {
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        let cmdline = ''
        try {
          cmdline = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8')
        } catch {
          continue
        }
        if (markers.some((marker) => cmdline.includes(marker))) {
          alive = true
          break
        }
      }
    } catch {
      break
    }
    if (!alive) return true
    await sleep(100)
  }
  return false
}

killOrphanChildren()
await waitOrphansGone(2_000)

// ── 预检：aria2 的 RPC 端口被占就换一个（并写回 settings.json） ──────────────
//
// 为什么需要：上游 `EngineSupervisor` 发现 RPC 端口被占时是**直接 fatal 退出**的
// （`RPC port 16800 is already in use` → `ENGINE_START_FAILED`），没有任何重试。
// 而端侧"上次崩了、aria2 子进程还赖在端口上"是很容易发生的：
// 应用被强杀时 `--stop-with-process` 未必来得及收尾，用户再打开就起不来，
// 且报错信息离真因（残留进程）很远。
//
// 做法：启动前探一下 settings.json 里记的 `engine.rpcPort`；连得上就说明有人占着，
// 顺延到下一个空闲端口**写回 settings.json**（上游启动时读这份配置），并记日志。
function portFree(port) {
  return new Promise((resolve) => {
    const srv = http.createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
  })
}

async function ensureAria2RpcPort() {
  const settingsPath = path.join(dataDir, 'settings.json')
  let settings = {}
  try {
    if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (error) {
    log(`读 settings.json 失败（${error.message}），按首次启动处理`)
    settings = {}
  }
  const engine = settings.engine && typeof settings.engine === 'object' ? settings.engine : {}
  const configured = Number(engine.rpcPort)
  let port = Number.isInteger(configured) && configured > 0 && configured < 65535 ? configured : 16800
  const start = port
  for (let i = 0; i < 20; i++) {
    if (await portFree(port)) {
      if (port !== start) {
        engine.rpcPort = port
        settings.engine = engine
        try {
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
          log(`aria2 RPC 端口 ${start} 被占，已顺延到 ${port} 并写回 settings.json`)
        } catch (error) {
          log(`写回 settings.json 失败：${error.message}`)
        }
      }
      return port
    }
    port += 1
  }
  log('警告：找不到空闲的 aria2 RPC 端口，仍沿用原值（可能启动失败）')
  return start
}
writeStage('preflight', {})
await ensureAria2RpcPort()

// ── jitless 垫片：必须在 import server **之前**装 ────────────────────────────
//
// 背景：`--jitless` ⇒ WebAssembly === undefined。这台 libnode（24.2.0）把 undici 打成
// 一个惰性模块，**只要碰一下内置 web 全局（fetch/WebSocket）就会加载它**，
// 而它在模块求值阶段就去 WebAssembly.compile(llhttp) ⇒ `WebAssembly is not defined`。
//
// 所以这里既做接管，也做**逐步定位**：每一步都打日志，真机上一跑就知道死在哪一行。
function probeStep(name, fn) {
  try {
    const value = fn()
    log(`probe ${name}: ok${value === undefined ? '' : ' = ' + String(value)}`)
    return value
  } catch (error) {
    log(`probe ${name}: THREW ${error && error.name}: ${error && error.message}`)
    return undefined
  }
}

log('probe-01: enter shim section')
probeStep('02 typeof WebAssembly', () => typeof WebAssembly)
probeStep('03 own fetch?', () => Object.prototype.hasOwnProperty.call(globalThis, 'fetch'))
probeStep('04 desc fetch', () => {
  const d = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  if (!d) return 'absent'
  return d.get ? 'accessor' : `value:${typeof d.value}`
})
probeStep('05 typeof globalThis.fetch', () => typeof globalThis.fetch)
probeStep('06 desc WebSocket', () => {
  const d = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket')
  if (!d) return 'absent'
  return d.get ? 'accessor' : `value:${typeof d.value}`
})

// ★ r51：垫片只在 **jitless（无 WebAssembly）** 时安装。
//
// 为什么：这套 shim 是为了绕开"undici 的 llhttp WASM 在 jitless 下加载即炸"。
// 拿到 JIT/ACL 后 WebAssembly 可用，**undici 原生就能跑** —— 此时再覆盖全局
// fetch/Headers/WebSocket 反而有害：
//   · 服务端 `plugin-http-client.ts` 明确 `import { fetch, Agent, ProxyAgent } from 'undici'`，
//     但它构造请求头用的是全局 `Headers`；全局被换成我们的 shim 后，交给 undici 的
//     Headers 实例语义不完全一致 ⇒ 插件市场/插件下载这类网络请求容易出奇怪失败；
//   · 原生 undici/fetch 还支持 `NODE_USE_ENV_PROXY` 等代理路径，shim 不支持。
// 所以：JIT 在线 ⇒ 一个 shim 都不装，让 Node 用原生实现；jitless ⇒ 照旧装。
const needsJitlessShims = typeof WebAssembly === 'undefined'
if (needsJitlessShims) {
  // fetch：纯 JS 实现（node:http/https 用原生 llhttp，不碰 WASM）
  const shimFetch = buildShimFetch()
  probeStep('07 defineProperty fetch', () => {
    Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: shimFetch })
    return 'done'
  })
  probeStep('08 defineProperty Headers', () => {
    Object.defineProperty(globalThis, 'Headers', { configurable: true, writable: true, value: ShimHeaders })
    return 'done'
  })
  probeStep('09 require ws', () => {
    const req = createRequire(import.meta.url)
    const ws = req('ws')
    globalThis.__motrixWs = ws
    return `ws.WebSocket=${typeof ws.WebSocket}`
  })
  probeStep('10 defineProperty WebSocket', () => {
    const ws = globalThis.__motrixWs
    if (!ws || typeof ws.WebSocket !== 'function') return 'skipped(no ws)'
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: ws.WebSocket })
    return 'done'
  })
  delete globalThis.__motrixWs
} else {
  log('jitless 垫片跳过：WebAssembly 可用，直接用 Node 原生 fetch/Headers/WebSocket（undici）')
}
log('probe-11: shim section done')
writeStage('shims_ready', {
  wasm: typeof WebAssembly,
  shims: needsJitlessShims ? 'jitless-shim' : 'native',
  // HarmonyOS 移植：无 WebAssembly ⇒ 上游 QuickJS 插件沙箱不可用。
  // server 侧据此跳过插件激活，并把 hook 失败降级为 fail-open（见 vendor 补丁）。
  pluginRuntime: typeof WebAssembly === 'undefined' ? 'unavailable' : 'ready',
})

// ── 启动 server ──────────────────────────────────────────────────────────────
log('import server…')
await import(path.join(appRoot, 'dist', 'server', 'index.mjs'))
log('server module imported; waiting for HTTP ingress…')
writeStage('server_imported', {})
const listening = await waitListening(120_000)
log(
  `server listening (healthz=${listening.status}, waited ${listening.waitedMs}ms)` +
    (listening.status === 503 ? '（引擎尚未 Ready，UI 会先显示"启动中"）' : '')
)
writeStage('http_listening', {
  healthz: listening.status,
  waitedMs: listening.waitedMs,
})

// ── 本地登录，拿会话 cookie ──────────────────────────────────────────────────
let operatorToken = env.MOTRIX_OPERATOR_TOKEN || ''
if (!operatorToken) {
  const tokenPath = path.join(dataDir, 'operator-token')
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(tokenPath)) {
      operatorToken = fs.readFileSync(tokenPath, 'utf8').trim()
      if (operatorToken) break
    }
    await sleep(100)
  }
}
writeStage('operator_token', { hasToken: Boolean(operatorToken) })
let cookie = ''
if (operatorToken) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request('POST', '/rpc/auth/login', { token: operatorToken })
    if (res.status === 200) {
      const setCookie = res.headers['set-cookie']
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
      if (raw) cookie = raw.split(';')[0]
      break
    }
    await sleep(200)
  }
}
if (!cookie) log('警告：未能拿到会话 cookie（Web UI 会先看到"输入访问令牌"页）')
writeStage('session_cookie', { hasCookie: Boolean(cookie) })

// ── 平台适配：撤销早期"写死设置"的临时方案 ─────────────────────────────────
//
// 【历史】前一版（r18）为了绕开 ArkWeb 不可靠的 prefers-color-scheme / navigator.language，
// 直接把 settings 里的 theme/language 写成了固定值（dark / zh-CN），并把 reduceMotion 打开。
// 副作用：设置页显示的不再是"跟随系统"，而且 reduceMotion 连 UI 过渡动画一起关掉了。
//
// 【现在的做法】渲染层（我们 rebuild 过的 dist/renderer-web）已经会读 ArkTS 注入的
// `window.__MOTRIX_PLATFORM__`，`matchMedia('(prefers-color-scheme: …)')` 也被补丁接管；
// 呼吸动画搬进了 WebGL 着色器。所以这里**不再写任何设置**，只做一次性的"回滚"：
// 如果上一版留下的值还在（用户没手动改过），恢复成 system / 默认值。
const LEGACY_PLATFORM_MARKER = path.join(dataDir, '.port-platform-defaults')

async function rpcWithCookie(command, payload) {
  const body = JSON.stringify({ args: [payload] })
  const pathName = command.startsWith('command:')
    ? `/rpc/command/${command}`
    : `/rpc/query/${command}`
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathName,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Cookie: cookie,
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(data)
          } catch {}
          resolve({ status: res.statusCode, body: parsed })
        })
      }
    )
    req.on('error', () => resolve({ status: 0, body: null }))
    req.setTimeout(8000, () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
}

async function restoreLegacyPlatformOverrides() {
  if (!cookie) return
  if (!fs.existsSync(LEGACY_PLATFORM_MARKER)) return
  let applied = {}
  try {
    applied = JSON.parse(fs.readFileSync(LEGACY_PLATFORM_MARKER, 'utf8')).applied || {}
  } catch {
    applied = {}
  }
  const current = await rpcWithCookie('query:getSettings', {})
  const app = current && current.body && current.body.app ? current.body.app : null
  if (!app) return

  const patchApp = {}
  // 只有"当前值仍然等于我们当初写进去的值"才回滚，避免踩掉用户手改的设置
  if (applied.theme && app.theme === applied.theme) patchApp.theme = 'system'
  if (applied.language && app.language === applied.language) patchApp.language = 'system'
  if (applied.reduceMotion === true && app.reduceMotion === true) patchApp.reduceMotion = false

  if (Object.keys(patchApp).length > 0) {
    const result = await rpcWithCookie('command:updateSettings', { app: patchApp })
    log('回滚早期平台覆盖：', JSON.stringify(patchApp), '→', JSON.stringify(result.body))
  }
  try {
    fs.unlinkSync(LEGACY_PLATFORM_MARKER)
  } catch {}
}

try {
  await restoreLegacyPlatformOverrides()
} catch (error) {
  log('回滚早期平台覆盖失败（不阻断启动）：', error && error.message)
}
writeStage('platform_restore', {})

// ── 交接给 ArkTS ─────────────────────────────────────────────────────────────
const readyPath = path.join(dataDir, 'host-ready.json')
const payload = { pid: process.pid, port, cookie, token: operatorToken, startedAt: Date.now() }
const tmp = `${readyPath}.tmp`
fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })
fs.renameSync(tmp, readyPath)
writeStage('ready', { port })
log('host-ready.json written:', JSON.stringify({ ...payload, cookie: cookie ? '<set>' : '', token: '<set>' }))

// ── 调试凭据导出（仅 debug 包）────────────────────────────────────────────
// host-ready.json 是 0600，hdc shell 读不到；真机自动化验收要直连端侧 API，
// 所以在**调试包**里额外落一份 0666 的副本到 filesDir（shell 可读）。
// 发布包 MOTRIX_DEV_DUMP=0，不会产生这个文件。
if (env.MOTRIX_DEV_DUMP === '1') {
  try {
    const devPath = path.join(sandboxHome, 'host-ready.dev.json')
    fs.writeFileSync(devPath, JSON.stringify(payload), { mode: 0o666 })
    fs.chmodSync(devPath, 0o666)
    log('dev 凭据已导出（仅 debug）：host-ready.dev.json')
  } catch (error) {
    log('dev 凭据导出失败：', error && error.message)
  }
}

// ── 托盘 / Dock 桥（文件队列 + 状态快照）────────────────────────────────────
//
// 【为什么是文件】ArkTS 侧有两个消费方：
//   1) 托盘左键面板（`StatusBarViewExtensionAbility`，**独立扩展进程**）；
//   2) Dock/任务栏图标进度条（`quickBarManager`，主进程 ArkTS）。
// 它们与宿主 Node 不在同一线程/进程，但**共用同一个应用沙箱目录**（filesDir/motrix），
// 所以沿用 notify-queue 那套"文件即 IPC"的做法，最简单也最稳。
//
// 方向 1（状态）：这里每秒把任务/引擎状态落成 `tray-state.json`（原子 rename）；
// 方向 2（控制）：面板/主进程把命令追加到 `tray-cmd.jsonl`，这里轮询后**用宿主自己的
//   operator cookie** 发 RPC —— 好处是凭据不出宿主，面板不需要知道 token。
const trayStatePath = path.join(dataDir, 'tray-state.json')
const trayCmdPath = path.join(dataDir, 'tray-cmd.jsonl')
// 深链命令队列：**启动时不清空**（冷启动的磁力链/种子文件在宿主起来之前就已经入队了）
const deeplinkCmdPath = path.join(dataDir, 'deeplink-cmd.jsonl')
const TORRENT_MAX_BYTES = 8 * 1024 * 1024

// 这些状态算"正在干活"：用于整体进度与 NORMAL 判定
const ACTIVE_STATES = new Set([
  'queued',
  'fetching_metadata',
  'metadata_ready',
  'downloading',
  'finalizing',
])

function writeTrayState(state) {
  try {
    const tmp = `${trayStatePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, trayStatePath)
    try {
      fs.chmodSync(trayStatePath, 0o666)
    } catch {}
  } catch (error) {
    log('写 tray-state.json 失败：', error && error.message)
  }
}

function readTrayCommands() {
  let raw = ''
  try {
    if (!fs.existsSync(trayCmdPath)) return []
    raw = fs.readFileSync(trayCmdPath, 'utf8')
  } catch {
    return []
  }
  if (raw.trim().length === 0) return []
  // 先清空再执行：命令只是"一次性意图"，重复执行暂停/继续是幂等的，
  // 但避免读-执行之间面板又追加导致重复处理同一行。
  try {
    fs.writeFileSync(trayCmdPath, '')
  } catch {}
  const commands = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.cmd === 'string') {
        commands.push({
          cmd: parsed.cmd,
          taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
          uri: typeof parsed.uri === 'string' ? parsed.uri : '',
          path: typeof parsed.path === 'string' ? parsed.path : '',
        })
      }
    } catch {
      // 也接受裸字符串命令（如 "pauseAll"）
      commands.push({ cmd: text, taskId: '' })
    }
  }
  return commands
}

async function runTrayCommand(command) {
  const cmd = command.cmd
  const taskId = command.taskId
  // 批量命令：payload 空对象；单任务命令：payload 就是 taskId 字符串（见上游 command handlers）
  if (cmd === 'pauseAll' || cmd === 'resumeAll') {
    const rpcName = cmd === 'pauseAll' ? 'command:pauseAllTasks' : 'command:resumeAllTasks'
    const result = await rpcWithCookie(rpcName, {})
    log(`托盘命令 ${cmd} -> status=${result.status}`)
    return
  }
  if (cmd === 'pauseTask' || cmd === 'resumeTask') {
    if (taskId.length === 0) {
      log(`托盘命令忽略（缺 taskId）：${cmd}`)
      return
    }
    const rpcName = cmd === 'pauseTask' ? 'command:pauseTask' : 'command:resumeTask'
    const result = await rpcWithCookie(rpcName, taskId)
    log(`托盘命令 ${cmd} task=${taskId.slice(0, 8)} -> status=${result.status}`)
    return
  }
  if (cmd === 'addMagnet') {
    if (command.uri.length === 0) {
      log('深链命令忽略（磁力链为空）')
      return
    }
    const result = await rpcWithCookie('command:addMagnetTask', {
      uri: command.uri,
      selectedFiles: [],
      saveDir: '',
    })
    log(`深链磁力链 -> status=${result.status}`)
    return
  }
  if (cmd === 'addTorrent') {
    const torrentPath = command.path
    if (torrentPath.length === 0 || !fs.existsSync(torrentPath)) {
      log(`深链命令忽略（种子文件不存在）：${torrentPath}`)
      return
    }
    let bytes = null
    try {
      const stat = fs.statSync(torrentPath)
      if (stat.size <= 0 || stat.size > TORRENT_MAX_BYTES) {
        log(`深链种子文件大小异常（${stat.size} B），忽略`)
        return
      }
      bytes = fs.readFileSync(torrentPath)
    } catch (error) {
      log('读种子文件失败：', error && error.message)
      return
    }
    const result = await rpcWithCookie('command:addTorrentTask', {
      base64: bytes.toString('base64'),
      selectedFiles: [],
      saveDir: '',
    })
    log(`深链种子文件 -> status=${result.status} bytes=${bytes.length}`)
    // 导入副本用完即删（原文件是用户的，不动）
    try {
      fs.unlinkSync(torrentPath)
    } catch {}
    return
  }
  if (cmd === 'retryTask') {
    if (taskId.length === 0) {
      log(`托盘命令忽略（缺 taskId）：${cmd}`)
      return
    }
    // 上游重试走批量接口，payload 是 taskIds 数组
    const result = await rpcWithCookie('command:retryTasks', [taskId])
    log(`托盘命令 retryTask task=${taskId.slice(0, 8)} -> status=${result.status}`)
    return
  }
  if (cmd === 'removeTask') {
    if (taskId.length === 0) {
      log(`托盘命令忽略（缺 taskId）：${cmd}`)
      return
    }
    // 面板上的叉号 = 取消下载并移除任务，**保留已下载到磁盘的文件**（删文件是主界面的显式选项）
    const result = await rpcWithCookie('command:removeTask', {
      taskId: taskId,
      deleteWithFiles: false,
    })
    log(`托盘命令 removeTask task=${taskId.slice(0, 8)} -> status=${result.status}`)
    return
  }
  log(`托盘命令忽略（未知）：${cmd}`)
}

// 面板列表的排序权重：干活中的在最上面，完成的沉底（和主界面"活跃优先"一致）
const STATUS_RANK = {
  downloading: 0,
  fetching_metadata: 0,
  metadata_ready: 0,
  finalizing: 0,
  queued: 1,
  paused: 2,
  error: 3,
  completed: 4,
  seeding: 5,
}
const TRAY_TASK_LIMIT = 60

function summarizeTasks(tasks) {
  const summary = {
    active: 0,
    waiting: 0,
    paused: 0,
    completed: 0,
    error: 0,
    speedDown: 0,
    speedUp: 0,
    completedBytes: 0,
    totalBytes: 0,
    totalDown: 0,
    totalUp: 0,
    rows: [],
  }
  for (const task of tasks) {
    if (!task || typeof task.status !== 'string') continue
    const status = task.status
    const taskDown = Number(task.downloadedBytes) || 0
    const taskUp = Number(task.uploadedBytes) || 0
    summary.totalDown += taskDown
    summary.totalUp += taskUp
    if (ACTIVE_STATES.has(status)) {
      summary.active += 1
      summary.speedDown += Number(task.downloadSpeed) || 0
      summary.speedUp += Number(task.uploadSpeed) || 0
    } else if (status === 'paused') {
      summary.paused += 1
    } else if (status === 'completed' || status === 'seeding') {
      summary.completed += 1
    } else if (status === 'error') {
      summary.error += 1
    } else {
      summary.waiting += 1
    }
    // 进度只统计"未完成"的任务：完成/出错的任务算进来会让进度条瞬间满格
    if (status !== 'completed' && status !== 'error' && status !== 'seeding') {
      const total = Number(task.totalBytes) || 0
      const done = Number(task.downloadedBytes) || 0
      if (total > 0) {
        summary.totalBytes += total
        summary.completedBytes += Math.min(done, total)
      }
    }
    summary.rows.push({
      id: typeof task.id === 'string' ? task.id : '',
      name: typeof task.name === 'string' && task.name.length > 0
        ? task.name.slice(0, 160)
        : (typeof task.filename === 'string' ? task.filename : '').slice(0, 160),
      status,
      // 上游 progress 是 0..1 的比例（渲染层用 formatProgressPercent ×100 显示），
      // 这里统一换算成 0..100 的百分数，面板只负责 toFixed(1) 显示
      progress: Math.max(0, Math.min(100, (Number(task.progress) || 0) * 100)),
      done: taskDown,
      total: Number(task.totalBytes) || 0,
      speed: Number(task.downloadSpeed) || 0,
      up: Number(task.uploadSpeed) || 0,
      eta: Number(task.etaSeconds) || 0,
      error: typeof task.errorMessage === 'string' ? task.errorMessage.slice(0, 120) : '',
      updatedAt: Number(task.updatedAt) || 0,
      createdAt: Number(task.createdAt) || Number(task.updatedAt) || 0,
      rank: STATUS_RANK[status] === undefined ? 6 : STATUS_RANK[status],
    })
  }
  // 面板列表固定按「添加时间倒序」排（新的在上，和主界面默认 sort 的 createdAt:desc 一致）。
  // 之前按状态分组排，结果任务一暂停/开始就跳位置 —— 维护者明确要求"顺序不要变"。
  summary.rows.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)
  })
  if (summary.rows.length > TRAY_TASK_LIMIT) {
    summary.rows = summary.rows.slice(0, TRAY_TASK_LIMIT)
  }
  return summary
}

/** 读深链命令：与托盘命令同样的"先读后清"，但**启动时不清文件**（见路径常量处注释） */
function readDeepLinkCommands() {
  let raw = ''
  try {
    if (!fs.existsSync(deeplinkCmdPath)) return []
    raw = fs.readFileSync(deeplinkCmdPath, 'utf8')
  } catch {
    return []
  }
  if (raw.trim().length === 0) return []
  try {
    fs.writeFileSync(deeplinkCmdPath, '')
  } catch {}
  const commands = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.cmd === 'string') {
        commands.push({
          cmd: parsed.cmd,
          taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
          uri: typeof parsed.uri === 'string' ? parsed.uri : '',
          path: typeof parsed.path === 'string' ? parsed.path : '',
        })
      }
    } catch {
      // 忽略无法解析的行
    }
  }
  return commands
}

async function trayTick() {
  if (trayBusy) return
  trayBusy = true
  try {
    for (const command of readDeepLinkCommands()) {
      try {
        await runTrayCommand(command)
      } catch (error) {
        log(`深链命令 ${command.cmd} 失败：`, error && error.message)
      }
    }
    for (const cmd of readTrayCommands()) {
      try {
        await runTrayCommand(cmd)
      } catch (error) {
        log(`托盘命令 ${cmd} 失败：`, error && error.message)
      }
    }
    const [tasksResult, engineResult, historyResult] = await Promise.all([
      rpcWithCookie('query:listTasks', {}),
      rpcWithCookie('query:getEngineStatus', {}),
      rpcWithCookie('query:getSpeedHistory', { limit: 60 }),
    ])
    const tasks = Array.isArray(tasksResult.body) ? tasksResult.body : []
    // 面板折线图直接用服务端给仪表板那条历史（同一数据源，观感和主界面一致）
    const history = Array.isArray(historyResult.body) ? historyResult.body : []
    const engineState = engineResult.body && typeof engineResult.body.state === 'string'
      ? engineResult.body.state
      : 'unknown'
    const summary = summarizeTasks(tasks)
    const total = summary.totalBytes
    const done = summary.completedBytes
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : 0
    let state = 'idle'
    if (summary.active > 0) state = 'normal'
    else if (summary.paused > 0) state = 'paused'
    else if (summary.error > 0) state = 'error'
    // 引擎没就绪时，进度条没有意义：清掉
    if (engineState !== 'ready' && summary.active === 0) state = 'idle'
    writeTrayState({
      at: Date.now(),
      engine: engineState,
      pid: process.pid,
      active: summary.active,
      waiting: summary.waiting,
      paused: summary.paused,
      completed: summary.completed,
      error: summary.error,
      speedDown: summary.speedDown,
      speedUp: summary.speedUp,
      totalDown: summary.totalDown,
      totalUp: summary.totalUp,
      hasProgress: total > 0,
      percent,
      completedBytes: done,
      totalBytes: total,
      state,
      tasks: summary.rows,
      history: history.map((point) => ({
        t: Number(point && point.t) || 0,
        down: Number(point && point.down) || 0,
        up: Number(point && point.up) || 0,
      })),
    })
  } catch (error) {
    log('托盘状态刷新失败：', error && error.message)
  } finally {
    trayBusy = false
  }
}

let trayBusy = false
// 清掉上一轮可能残留的命令文件，避免启动就执行旧命令
try {
  fs.writeFileSync(trayCmdPath, '')
} catch {}
await trayTick()
const trayTimer = setInterval(() => {
  void trayTick()
}, 1000)
trayTimer.unref?.()
log('托盘桥已启动：tray-state.json / tray-cmd.jsonl')

// ── 停止通道：文件信号（同进程 Node 无法从外部线程停，只能自己退） ───────────
const stopPath = path.join(sandboxHome, 'host-stop-request')
const stopTimer = setInterval(() => {
  if (!fs.existsSync(stopPath)) return
  try {
    fs.unlinkSync(stopPath)
  } catch {}
  log('收到 host-stop-request，退出')
  // 退出前把托盘状态清掉：否则面板/进度条会拿着上一轮的旧数据（应用已经死了）
  try {
    clearInterval(trayTimer)
    fs.writeFileSync(trayStatePath, JSON.stringify({ at: Date.now(), engine: 'stopped', state: 'idle', hasProgress: false, percent: 0 }))
  } catch {}
  // 唯一允许真退出的通道：先复位拦截器，否则 process.exit 只会写失败标记
  exitAllowed = true
  setTimeout(() => realExit(0), 200)
}, 1500)
stopTimer.unref?.()
