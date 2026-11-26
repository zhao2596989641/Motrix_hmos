/**
 * jitless 垫片：把 Node 内置 undici 提供的那几个全局换成"不碰 WASM"的实现。
 *
 * 【为什么必须有它】
 * `--jitless` 隐含 `--no-expose-wasm` ⇒ `WebAssembly === undefined`。
 * Node 24 内置的 undici 用 **WASM 版 llhttp** 解析 HTTP 响应，一旦它的 client 链被初始化就抛
 *   `ReferenceError: WebAssembly is not defined at lazyllhttp (node:internal/deps/undici/undici)`
 * —— 真机实测：Motrix server 在 `import` 阶段就撞上，进程直接退出（`node-output.log` 有完整堆栈）。
 *
 * 处置（与 参考宿主项目 同口径，见其 `hostcore/app/fetch-shim.js`）：
 *   · `fetch` 改由本文件实现（纯 JS，走 `node:http` / `node:https`，它们用**原生** llhttp，与 WASM 无关）；
 *   · `WebSocket` 改用 bundle 里已有的 `ws` 包（纯 JS）；
 *   · 两者都在 **import server 之前** 覆盖全局，于是内置 undici 永远不会被拉起来。
 *
 * 【不许省略这一步】把垫片挪到 server 之后 import 就没用了：那时已经炸了。
 *
 * 【已知取舍】
 *   · fetch 只实现 Motrix 用到的那一面：字符串/Buffer/TypedArray 请求体、自定义 headers、
 *     AbortSignal 中止、最多 5 次重定向、response.{ok,status,statusText,headers,text,json,arrayBuffer,body}；
 *   · 不实现 `Response.redirect()` 之类的构造侧 API（用不到）。
 */

import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { ReadableStream } from 'node:stream/web'
import { createRequire } from 'node:module'

const JITLESS = typeof WebAssembly === 'undefined'

// ── Headers ──────────────────────────────────────────────────────────────────
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
  set(name, value) {
    this._map.set(String(name).toLowerCase(), String(value))
  }
  get(name) {
    const value = this._map.get(String(name).toLowerCase())
    return value === undefined ? null : value
  }
  has(name) {
    return this._map.has(String(name).toLowerCase())
  }
  delete(name) {
    this._map.delete(String(name).toLowerCase())
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this._map) callback.call(thisArg, value, key, this)
  }
  entries() {
    return this._map.entries()
  }
  keys() {
    return this._map.keys()
  }
  values() {
    return this._map.values()
  }
  [Symbol.iterator]() {
    return this._map.entries()
  }
}

// ── 请求体编码 ───────────────────────────────────────────────────────────────
function encodeBody(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') return Buffer.from(body)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  // URLSearchParams 之类：按字符串处理（Motrix 不传复杂流式体）
  return Buffer.from(String(body))
}

// ── Response ────────────────────────────────────────────────────────────────
class ShimResponse {
  constructor(res, url) {
    this._res = res
    this.url = url
    this.status = res.statusCode ?? 0
    this.statusText = res.statusMessage ?? ''
    this.ok = this.status >= 200 && this.status < 300
    this.headers = new ShimHeaders(res.headers)
    this.redirected = false
  }
  async arrayBuffer() {
    const chunks = []
    for await (const chunk of this._res) chunks.push(chunk)
    const buffer = Buffer.concat(chunks)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
  async text() {
    return Buffer.from(await this.arrayBuffer()).toString('utf8')
  }
  async json() {
    return JSON.parse(await this.text())
  }
  get body() {
    return ReadableStream.from
      ? ReadableStream.from(this._res)
      : null
  }
}

// ── fetch ───────────────────────────────────────────────────────────────────
function shimFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input)
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new ShimHeaders(init.headers)
  const body = encodeBody(init.body)
  if (body !== null && !headers.has('content-length')) {
    headers.set('content-length', String(body.length))
  }
  const signal = init.signal
  const redirect = init.redirect ?? 'follow'

  const doOnce = (targetUrl, hops) =>
    new Promise((resolve, reject) => {
      let parsed
      try {
        parsed = new URL(targetUrl)
      } catch (error) {
        reject(new TypeError(`Invalid URL: ${targetUrl}`))
        return
      }
      const transport = parsed.protocol === 'https:' ? https : http
      const options = {
        method,
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        headers: Object.fromEntries(headers.entries()),
      }
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      const req = transport.request(options, (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        // 重定向：最多 5 跳，303 改成 GET（与 undici 一致的最小面）
        if (redirect === 'follow' && location && status >= 300 && status < 400) {
          res.resume()
          if (hops >= 5) {
            reject(new TypeError('redirect count exceeded'))
            return
          }
          const nextUrl = new URL(location, targetUrl).href
          const nextMethod = status === 303 ? 'GET' : method
          if (nextMethod !== method) {
            // 简单起见：303 → GET 且丢掉 body
            shimFetch(nextUrl, { ...init, method: 'GET', body: undefined, headers: init.headers })
              .then(resolve, reject)
            return
          }
          doOnce(nextUrl, hops + 1).then(resolve, reject)
          return
        }
        resolve(new ShimResponse(res, targetUrl))
      })
      const onAbort = () => req.destroy(new Error('aborted'))
      signal?.addEventListener?.('abort', onAbort, { once: true })
      req.on('error', (error) => {
        signal?.removeEventListener?.('abort', onAbort)
        reject(error)
      })
      req.on('close', () => signal?.removeEventListener?.('abort', onAbort))
      if (body !== null) req.write(body)
      req.end()
    })

  return doOnce(url, 0)
}

/**
 * 安装垫片。
 *
 * 只有在 jitless（WASM 不可用）时才接管：带 JIT 的调试形态保持 Node 原生实现，
 * 免得把"本机能跑"与"端侧能跑"的差异掩盖掉。
 */
export function installJitlessShims({ log = () => {} } = {}) {
  if (!JITLESS) {
    log('WASM 可用，跳过 jitless 垫片（保持 Node 原生 fetch/WebSocket）')
    return { installed: false, reason: 'wasm-available' }
  }

  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: shimFetch,
  })
  Object.defineProperty(globalThis, 'Headers', {
    configurable: true,
    writable: true,
    value: ShimHeaders,
  })
  log('已接管 globalThis.fetch / Headers（纯 JS，不依赖 WASM）')

  // WebSocket：用 bundle 里的 ws（纯 JS）。没有它就用不到，留原始实现即可。
  let wsInstalled = false
  try {
    // ws 是 CJS 包，在 ESM 里用 createRequire 拿
    const requireCjs = createRequire(import.meta.url)
    const ws = requireCjs('ws')
    if (ws && typeof ws.WebSocket === 'function') {
      Object.defineProperty(globalThis, 'WebSocket', {
        configurable: true,
        writable: true,
        value: ws.WebSocket,
      })
      wsInstalled = true
      log('已接管 globalThis.WebSocket ← ws')
    }
  } catch (error) {
    log(`WebSocket 垫片安装失败（${error.message}）—— 若后续出现 undici WASM 报错，这里是根因`)
  }

  return { installed: true, wsInstalled }
}