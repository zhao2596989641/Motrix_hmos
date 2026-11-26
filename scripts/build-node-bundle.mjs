#!/usr/bin/env node
// 把 Motrix 的 server 运行时组装进 HAP 的 resfile/app（端侧只读根）。
//
// 产物树（= `MOTRIX_APP_ROOT`）：
//   resfile/app/
//   ├── main.mjs                  # 端侧宿主入口（仓库内维护，entry/src/main/resources/resfile/app/main.mjs）
//   ├── dist/
//   │   ├── server/{index.mjs, motrix-admin.mjs, chunks/*}
//   │   ├── core/plugin/host/quick-js-worker.cjs
//   │   └── renderer-web/{index.html, assets/*}
//   ├── node_modules/             # 只带 server-runtime-dependencies.json 的 26 个运行时根 + 传递依赖
//   ├── extra/aria2.conf
//   ├── bin/{aria2c, motrix-finalize-fs}
//   ├── builtin-plugins/
//   └── cacert.pem
//
// 用法：node scripts/build-node-bundle.mjs
//
// 为什么要单独裁剪 node_modules：整个 node_modules 是 557MB（含 electron/react/vite），
// 而运行时只需要 26 个根 + 其传递依赖。HAP 里塞 557MB 是没必要的。

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const UPSTREAM = path.join(ROOT, 'vendor', 'motrix')
const OUT = path.join(ROOT, 'entry', 'src', 'main', 'resources', 'resfile', 'app')
const NATIVE = path.join(ROOT, 'build', 'native', 'device')
const PREFERRED_BIN = path.join(ROOT, 'build', 'bin')

const log = (...a) => console.log('[bundle]', ...a)

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true })
}
function copy(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`缺来源：${src}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: true })
}
function exists(p) {
  return fs.existsSync(p)
}

// ── 1. 清空目标 ──────────────────────────────────────────────────────────────
rmrf(OUT)
fs.mkdirSync(OUT, { recursive: true })

// ── 2. 前端与服务端产物 ──────────────────────────────────────────────────────
copy(path.join(UPSTREAM, 'dist', 'server'), path.join(OUT, 'dist', 'server'))
copy(path.join(UPSTREAM, 'dist', 'renderer-web'), path.join(OUT, 'dist', 'renderer-web'))
copy(
  path.join(UPSTREAM, 'dist', 'core', 'plugin', 'host'),
  path.join(OUT, 'dist', 'core', 'plugin', 'host')
)
log('dist/ 已拷入')

// ── 3. 端侧宿主入口 ──────────────────────────────────────────────────────────
copy(path.join(ROOT, 'scripts', 'host', 'main.mjs'), path.join(OUT, 'main.mjs'))
copy(path.join(ROOT, 'scripts', 'host', 'jitless-shim.mjs'), path.join(OUT, 'jitless-shim.mjs'))
log('main.mjs 已拷入')

// ── 4. extra/（aria2.conf 模板） ─────────────────────────────────────────────
copy(path.join(UPSTREAM, 'extra'), path.join(OUT, 'extra'))
log('extra/ 已拷入')

// ── 5. 原生二进制 ────────────────────────────────────────────────────────────
//
// 【默认不拷进 resfile】端侧真正执行的副本在 entry/libs/arm64-v8a/*.bin（见 build-hap.sh 4b），
// resfile 里再放一份纯属重复：白白多 11.5MB，还多一处"两份会不会不一致"的隐患。
// 端侧宿主解析顺序是 libs/ 优先，resfile/app/bin 只是历史兜底（本地 repro 用 build/native），
// 所以这里默认跳过。需要旧行为时设环境变量 MOTRIX_RESFILE_BIN=1。
const includeResfileBin = process.env.MOTRIX_RESFILE_BIN === '1'
if (includeResfileBin) {
  fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true })
  const binaries = ['aria2c', 'motrix-finalize-fs']
  for (const name of binaries) {
    const candidates = [
      path.join(PREFERRED_BIN, name),
      path.join(NATIVE, name),
      path.join(ROOT, 'build', 'native', 'host', name),
    ]
    const found = candidates.find((p) => exists(p))
    if (!found) {
      log(`警告：找不到 ${name}（候选：${candidates.join(', ')}）—— 端侧对应功能不可用`)
      continue
    }
    fs.copyFileSync(found, path.join(OUT, 'bin', name))
    fs.chmodSync(path.join(OUT, 'bin', name), 0o755)
    log(`bin/${name} ← ${found}`)
  }
} else {
  // 上一次构建可能留下旧目录，必须清掉，否则旧字节还会被一起打进 HAP
  fs.rmSync(path.join(OUT, 'bin'), { recursive: true, force: true })
  log('跳过 resfile/app/bin（可执行文件随 entry/libs/arm64-v8a/*.bin 提供，省约 11.5MB）')
}

// ── 6. CA 证书束（aria2 的 HTTPS 靠它；鸿蒙上没有 /etc/ssl/certs 全集） ──────
const cacertCandidates = [
  path.join(ROOT, 'build', 'cacert.pem'),
  '/storage/Users/currentUser/.harmonybrew/opt/ca-certificates/share/ca-certificates/cacert.pem',
]
const cacert = cacertCandidates.find((p) => exists(p))
if (cacert) {
  fs.copyFileSync(cacert, path.join(OUT, 'cacert.pem'))
  log(`cacert.pem ← ${cacert}`)
} else {
  log('警告：找不到 cacert.pem —— aria2 的 HTTPS 下载会因证书链失败')
}

// ── 7. 内置插件（可选：拿不到就建空目录，server 会当成"没有内置插件"） ──────
fs.mkdirSync(path.join(OUT, 'builtin-plugins'), { recursive: true })
if (exists(path.join(UPSTREAM, 'dist', 'builtin-plugins'))) {
  copy(path.join(UPSTREAM, 'dist', 'builtin-plugins'), path.join(OUT, 'builtin-plugins'))
  log('builtin-plugins/ 已拷入')
} else {
  log('builtin-plugins/ 为空（未跑 fetch-builtins）')
}

// ── 8. node_modules：只带运行时根 + 传递依赖 ─────────────────────────────────
const depsSpec = JSON.parse(
  fs.readFileSync(path.join(UPSTREAM, 'scripts', 'server-runtime-dependencies.json'), 'utf8')
)
const roots = depsSpec.runtimeRoots
const upstreamModules = path.join(UPSTREAM, 'node_modules')
const outModules = path.join(OUT, 'node_modules')
fs.mkdirSync(outModules, { recursive: true })

const copied = new Set()
const queue = [...roots]
while (queue.length > 0) {
  const name = queue.shift()
  if (copied.has(name)) continue
  copied.add(name)
  const src = path.join(upstreamModules, name)
  if (!exists(src)) {
    log(`警告：依赖缺失 ${name}`)
    continue
  }
  const dest = path.join(outModules, name)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, dereference: true })
  // 传递依赖：读该包的 package.json 的 dependencies
  const pkgPath = path.join(src, 'package.json')
  if (exists(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!copied.has(dep)) queue.push(dep)
    }
    // optionalDependencies 里的原生加速包按平台挑；端侧不需要，跳过
  }
}
log(`node_modules: ${copied.size} 个包`)

// better-sqlite3：用我们交叉编译的那份，并剔掉别的平台的 prebuild
//
// ★★ 真机 dlopen 只能从 HAP 的 `libs/<abi>/` 走 ★★
//   r6 的闪退根因（node-output.log）：
//     fatal Error: Error loading shared library .../resfile/.../better_sqlite3.node: No error information
//   鸿蒙把"运行时解包到沙箱里的原生库"的 dlopen 一律拦掉（参考宿主项目 真机 E39 同款报错），
//   只有随 HAP `libs/` 提供的库才放行。而 hvigor 只打包扁平的 `libs/<abi>/*.so`（E40①）。
//   所以：device 变体 → entry/libs/arm64-v8a/libbetter_sqlite3.so，
//   运行期由 scripts/host/main.mjs 的 installNativeRedirect() 把沙箱 .node 请求改写过去。
//   注意：resfile 里**不要再放**这个 .node（放了也 load 不了，还多 1.7MB）。
const bsql = path.join(outModules, 'better-sqlite3')
if (exists(bsql)) {
  rmrf(path.join(bsql, 'prebuilds'))
  rmrf(path.join(bsql, 'deps'))
  rmrf(path.join(bsql, 'src'))
  rmrf(path.join(bsql, 'build'))
  fs.rmSync(path.join(bsql, 'binding.gyp'), { force: true })
  const deviceNode = path.join(NATIVE, 'better_sqlite3.node')
  if (exists(deviceNode)) {
    const flat = path.join(ROOT, 'entry', 'libs', 'arm64-v8a', 'libbetter_sqlite3.so')
    fs.mkdirSync(path.dirname(flat), { recursive: true })
    // 端侧"封存态"：被 mv 覆盖过的目标再 cp 上去会 EPERM ⇒ 先删，再 cp 到临时名后 mv
    fs.rmSync(flat, { force: true })
    fs.copyFileSync(deviceNode, `${flat}.tmp`)
    fs.renameSync(`${flat}.tmp`, flat)
    fs.chmodSync(flat, 0o755)
    log(`better-sqlite3 ← device 变体 → ${path.relative(ROOT, flat)}（resfile 只留 JS）`)
  } else {
    log('警告：缺 device 变体的 better_sqlite3.node（先跑 scripts/build-better-sqlite3.sh --variant=device）')
  }
}

// ── 9. 体积账 ────────────────────────────────────────────────────────────────
function du(p) {
  let total = 0
  const stack = [p]
  while (stack.length) {
    const cur = stack.pop()
    let st
    try {
      st = fs.lstatSync(cur)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e))
    } else {
      total += st.size
    }
  }
  return total
}
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`
log('── 体积 ──')
for (const sub of ['dist', 'node_modules', 'bin', 'extra']) {
  const p = path.join(OUT, sub)
  if (exists(p)) log(`  ${sub.padEnd(14)} ${mb(du(p))}`)
}
log(`  合计           ${mb(du(OUT))}`)
log('完成：', OUT)