/**
 * HarmonyOS 端侧的 `@motrix/cli` 检测（r61）。
 *
 * 为什么需要自己实现：上游在 server 模式恒返回 `manual-only/unsupported-web`，
 * 集成卡片因此永远显示"无法安装"。而在鸿蒙上我们已经确认（r59/r60 真机探针）：
 *
 *   · 能**读**用户目录里的真实文件（`READ_WRITE_USER_FILE` 已获批）；
 *   · 但**不能跟随符号链接**（`~/.harmonybrew/bin/*` 全是 symlink，lstat/open → EACCES），
 *     所以检测必须走 `Cellar/**`、`lib/node_modules/**` 这类真实路径；
 *   · **不能 exec** 用户的 `node`/`brew`（自签 ELF → EPERM），也不能 chdir 到 zsh 脚本，
 *     所以"应用内直接 npm install"不可行 —— 只能检测 + 给出让用户自己执行的命令。
 *
 * 本模块只做只读检测，不写文件、不执行进程。
 */

import fs from 'node:fs'
import path from 'node:path'

/** CLI 包名（与上游 `@motrix/cli` 一致） */
const CLI_PACKAGE = '@motrix/cli'

export interface CliDetectionPaths {
  /** Harmonybrew 前缀，例如 /storage/Users/currentUser/.harmonybrew */
  brewPrefix: string
  /** 传统 npm 前缀，例如 /storage/Users/currentUser/npm */
  npmPrefix: string
}

export interface CliDetectionResult {
  installed: boolean
  version: string | null
  /** npm 包的入口脚本绝对路径（真实路径，不含 symlink） */
  entryPath: string | null
  /** 用户应在终端执行的命令 */
  installCommand: string
  /** 检测过程中的关键路径（写进 detail，便于真机排查） */
  detail: string
  /** 已安装的 brew formula 数量 / 全局 npm 包数量（用于"环境概览"） */
  counts: { formulae: number; npmGlobals: number }
}

function readDirSafe(target: string): string[] {
  try {
    return fs.readdirSync(target)
  } catch {
    return []
  }
}

function readJsonSafe(target: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    return null
  }
}

/** 在 `<prefix>/lib/node_modules/@motrix/cli/package.json` 里找版本与入口 */
function probeNpmPrefix(prefix: string): {
  version: string | null
  entryPath: string | null
} {
  const packageDir = path.join(prefix, 'lib', 'node_modules', ...CLI_PACKAGE.split('/'))
  const manifest = readJsonSafe(path.join(packageDir, 'package.json')) as
    | { version?: unknown; bin?: unknown; main?: unknown }
    | null
  if (manifest === null || typeof manifest.version !== 'string') {
    return { version: null, entryPath: null }
  }
  // bin 可能是字符串或 {name: path}；优先取 `motrix` 那条
  let binPath: string | null = null
  if (typeof manifest.bin === 'string') {
    binPath = manifest.bin
  } else if (manifest.bin !== null && typeof manifest.bin === 'object') {
    const bin = manifest.bin as Record<string, unknown>
    const candidate = bin.motrix ?? Object.values(bin)[0]
    if (typeof candidate === 'string') binPath = candidate
  }
  const entryPath =
    binPath !== null
      ? path.resolve(packageDir, binPath)
      : typeof manifest.main === 'string'
        ? path.resolve(packageDir, manifest.main)
        : packageDir
  return { version: manifest.version, entryPath }
}

/**
 * 只在设置了 `MOTRIX_CLI_NPM_PREFIX`（宿主注入）时启用；
 * 其它运行形态（普通浏览器 / 上游 Electron）保持原行为。
 */
export function cliDetectionEnabled(): boolean {
  const prefix = process.env.MOTRIX_CLI_NPM_PREFIX?.trim()
  return Boolean(prefix)
}

export function detectCliTool(paths: CliDetectionPaths): CliDetectionResult {
  const prefixes = [paths.brewPrefix, paths.npmPrefix]
  let version: string | null = null
  let entryPath: string | null = null
  let foundIn = ''
  for (const prefix of prefixes) {
    const probe = probeNpmPrefix(prefix)
    if (probe.version !== null) {
      version = probe.version
      entryPath = probe.entryPath
      foundIn = path.join(prefix, 'lib', 'node_modules', ...CLI_PACKAGE.split('/'))
      break
    }
  }

  const formulae = readDirSafe(path.join(paths.brewPrefix, 'Cellar')).length
  const npmGlobals = readDirSafe(
    path.join(paths.brewPrefix, 'lib', 'node_modules')
  ).length

  const installCommand = `npm install -g ${CLI_PACKAGE}@latest`
  const detailLines = [
    `brewPrefix: ${paths.brewPrefix}`,
    `npmPrefix:  ${paths.npmPrefix}`,
    `包目录:     ${foundIn || '（未找到 ' + CLI_PACKAGE + '）'}`,
    `入口:       ${entryPath ?? '—'}`,
    `Cellar 已安装 formula: ${formulae}`,
    `全局 npm 包: ${npmGlobals}`,
    '',
    '鸿蒙端侧限制（r59/r60 真机探针结论）：',
    '  · 可读用户目录真实文件，但不可跟随符号链接（~/.harmonybrew/bin/* 是 symlink）',
    '  · 不可执行用户的 node/brew（自签 ELF → EPERM），因此应用内不能代跑 npm install',
    '  · 请在系统终端里手动执行上面的安装命令（终端里有 zsh / node / npm）',
  ]

  return {
    installed: version !== null,
    version,
    entryPath,
    installCommand,
    detail: detailLines.join('\n'),
    counts: { formulae, npmGlobals },
  }
}