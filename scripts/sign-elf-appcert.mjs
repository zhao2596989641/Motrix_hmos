#!/usr/bin/env node
// 用**应用自己的调试证书**给随包 ELF 签名（hap-bin / executableBinaryPaths 要求）。
//
// 为什么不能自签（2026-11-24 r12 真机）：
//   把 binary-sign-tool -selfSign 1 签过的 aria2c / motrix-finalize-fs 放进 HAP libs/ 后，
//   hdc install 报 `9568393 verify code signature failed`。
//   HAP 自身的 hap-sign-tool verify-app 是通过的 ⇒ 安装器校验的是 bin 的 .codesign：
//   自签名证书与 HAP/应用证书不匹配。改用 build-profile.json5 里同一套
//   signingConfigs（p12 + cer + p7b）签，证书链一致。
//
// 密码不落盘：从 build-profile.json5 读密文，按 hvigor 的 DecipherUtil 算法
//   （~/.ohos/config/material 下的 fd/ac/ce + 硬编码 component）解密，只在内存/argv 中用。
//
// 用法：node scripts/sign-elf-appcert.mjs <elf> [<elf>...]
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLT = process.env.CLT || '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0'
const TOOLBIN = process.env.OHOS_TOOLBIN || path.join(CLT, 'sdk/default/openharmony/native/llvm/bin')
const SIGN_TOOL = process.env.SIGN_TOOL || path.join(CLT, 'sdk/default/openharmony/toolchains/lib/binary-sign-tool')
const READELF = path.join(TOOLBIN, 'llvm-readelf')
const OBJCOPY = path.join(TOOLBIN, 'llvm-objcopy')

const log = (...args) => console.log('[appcert]', ...args)

/** build-profile.json5 是 JSON5（// 与 /* *\/ 注释）；这些配置文件不需要完整 JSON5 解析 */
function parseJson5Loose(text) {
  let out = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'))
}

function decryptPwd(materialDir, encryptedPwd) {
  if (!encryptedPwd || encryptedPwd.length < 32 || encryptedPwd.length % 2 !== 0) {
    throw new Error(`签名字段不是 hvigor 加密格式（长度 ${encryptedPwd ? encryptedPwd.length : 0}）`)
  }
  const component = new Int8Array([49, 243, 9, 115, 214, 175, 91, 184, 211, 190, 177, 88, 101, 131, 192, 119])
  const material = path.resolve(materialDir, 'material')
  const readDirBytes = (dir) => {
    const entries = fs.readdirSync(dir).filter((name) => name !== '.DS_Store')
    if (entries.length !== 1) throw new Error(`${dir} 应有 1 个文件，实际 ${entries.length}`)
    return new Int8Array(fs.readFileSync(path.join(dir, entries[0])))
  }
  const readFd = () => {
    const root = path.join(material, 'fd')
    const entries = fs.readdirSync(root).filter((name) => name !== '.DS_Store')
    if (entries.length !== 3) throw new Error(`${root} 应有 3 个目录，实际 ${entries.length}`)
    return entries.map((name) => readDirBytes(path.join(root, name)))
  }
  const xor = (a, b) => {
    if (a.byteLength !== b.byteLength) throw new Error('material 分量长度不一致')
    const out = new Int8Array(a.byteLength)
    for (let i = 0; i < a.byteLength; i++) out[i] = a[i] ^ b[i]
    return out
  }
  const xorComponents = (components) => {
    for (const part of components) {
      if (part.length !== 16) throw new Error('material 分量不是 16 字节')
    }
    let acc = xor(components[0], components[1])
    for (let i = 2; i < components.length; i++) acc = xor(acc, components[i])
    return Buffer.from(acc)
  }
  const decrypt = (key, message) => {
    const contentLength =
      ((message[0] & 0xff) << 24) |
      ((message[1] & 0xff) << 16) |
      ((message[2] & 0xff) << 8) |
      (message[3] & 0xff)
    const ivLength = message.length - 4 - contentLength
    const iv = message.slice(4, 4 + ivLength)
    const tag = message.slice(message.length - 16)
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(message.subarray(4 + ivLength, message.length - 16)), decipher.final()])
  }
  const fd = readFd()
  const salt = readDirBytes(path.join(material, 'ac'))
  const rootKey = crypto.pbkdf2Sync(
    xorComponents([...fd, new Int8Array(component)]).toString(),
    salt,
    10000,
    16,
    'sha256'
  )
  const work = readDirBytes(path.join(material, 'ce'))
  const key = new Int8Array(decrypt(new Int8Array(rootKey), work))
  return decrypt(key, new Int8Array(Buffer.from(encryptedPwd, 'hex'))).toString('utf8')
}

function loadSigningConfig() {
  const profilePath = path.join(ROOT, 'build-profile.json5')
  const profile = parseJson5Loose(fs.readFileSync(profilePath, 'utf8'))
  const configs = profile?.app?.signingConfigs || []
  if (configs.length === 0) throw new Error('build-profile.json5 没有 signingConfigs')
  const config = configs.find((item) => item.name === 'default') || configs[0]
  const material = config.material || {}
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p))
  for (const key of ['storeFile', 'certpath', 'profile']) {
    if (!material[key]) throw new Error(`signingConfigs.material.${key} 为空`)
    if (!fs.existsSync(resolve(material[key]))) throw new Error(`签名材料不存在：${material[key]}`)
  }
  const storeFile = resolve(material.storeFile)
  const storePassword = decryptPwd(path.dirname(storeFile), material.storePassword)
  const keyPassword = material.keyPassword ? decryptPwd(path.dirname(storeFile), material.keyPassword) : storePassword
  return {
    keyAlias: material.keyAlias,
    keyPwd: keyPassword,
    storePwd: storePassword,
    storeFile,
    certFile: resolve(material.certpath),
    profileFile: resolve(material.profile),
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
}

function signOne(file, config) {
  if (!fs.existsSync(file)) {
    log(`skip（不存在）${file}`)
    return
  }
  const head = fs.readFileSync(file).subarray(0, 4)
  if (!head.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    log(`skip（非 ELF）${file}`)
    return
  }
  const sections = run(READELF, ['-S', file])
  const remove = []
  if (sections.includes('.codesign')) remove.push('--remove-section', '.codesign')
  if (sections.includes('.permission')) remove.push('--remove-section', '.permission')

  let input = file
  let temporary = ''
  if (remove.length > 0) {
    temporary = `${file}.unsigned-${process.pid}`
    try { fs.rmSync(temporary, { force: true }) } catch {}
    run(OBJCOPY, [...remove, file, temporary])
    input = temporary
  }

  const signed = `${file}.appcert-${process.pid}`
  try { fs.rmSync(signed, { force: true }) } catch {}
  try {
    run(SIGN_TOOL, [
      'sign',
      '-keyAlias', config.keyAlias,
      '-keyPwd', config.keyPwd,
      '-appCertFile', config.certFile,
      '-profileFile', config.profileFile,
      '-profileSigned', '1',
      '-inFile', input,
      '-signAlg', 'SHA256withECDSA',
      '-keystoreFile', config.storeFile,
      '-keystorePwd', config.storePwd,
      '-outFile', signed,
    ])
    if (!fs.existsSync(signed) || fs.statSync(signed).size === 0) {
      throw new Error(`签名产物为空：${signed}`)
    }
    fs.chmodSync(signed, 0o755)
    fs.renameSync(signed, file)
    log(`signed(app cert) ${file}`)
  } finally {
    if (temporary) {
      try { fs.rmSync(temporary, { force: true }) } catch {}
    }
    try { fs.rmSync(signed, { force: true }) } catch {}
  }
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法：node scripts/sign-elf-appcert.mjs <elf> [<elf>...]')
  process.exit(2)
}
const config = loadSigningConfig()
if (!config.keyAlias) throw new Error('signingConfigs.material.keyAlias 为空')
for (const file of files) signOne(path.resolve(file), config)