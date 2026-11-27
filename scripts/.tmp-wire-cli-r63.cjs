const fs = require('fs')

// ---------- queries.ts：用 CliToolService 取代 r61 的只读检测 ----------
const q = 'src/server/ipc/queries.ts'
let t = fs.readFileSync(q, 'utf8')

const oldImport = "import {\n  cliDetectionEnabled,\n  detectCliTool,\n} from '../cli-tool-detect'\n"
if (!t.includes(oldImport)) {
  console.error('queries import anchor missing')
  process.exit(1)
}
t = t.replace(
  oldImport,
  "import { cliToolRuntimeEnabled, getCliToolService } from '../cli-tool-runtime'\n"
)

const startMarker = '    [Queries.GetCliToolStatus]: async (): Promise<CliToolStatus> => {'
const endMarker = '    // Same slim projection as the TaskUpdated broadcast so hydration and'
const start = t.indexOf(startMarker)
const end = t.indexOf(endMarker)
if (start < 0 || end < 0 || end <= start) {
  console.error('queries handler bounds missing')
  process.exit(1)
}
const handler = [
  '    [Queries.GetCliToolStatus]: async (): Promise<CliToolStatus> => {',
  '      // r63：CUSTOM_SANDBOX 把应用换到 develop_tools_debug_hap 域后可以 exec 用户',
  '      // 的 brew/node，因此这里直接复用 core 那套 CliToolService（发现包管理器 + 探测版本）。',
  '      if (cliToolRuntimeEnabled()) {',
  '        return getCliToolService().getStatus()',
  '      }',
  '      return UNSUPPORTED_WEB_CLI_STATUS',
  '    },',
  '',
  '',
].join('\n')
t = t.slice(0, start) + handler + t.slice(end)
fs.writeFileSync(q, t)
console.log('queries.ts: GetCliToolStatus -> CliToolService')

// ---------- commands.ts：注册 InstallCliTool ----------
const c = 'src/server/ipc/commands.ts'
let cmd = fs.readFileSync(c, 'utf8')

const ffmpegAnchor = '    [Commands.InstallFfmpeg]: async (payload: unknown) => {'
if (!cmd.includes(ffmpegAnchor)) {
  console.error('commands anchor missing')
  process.exit(1)
}
const installHandler = [
  '    [Commands.InstallCliTool]: async (payload: unknown) => {',
  '      // r63：端侧可以 exec 用户的 node/brew，直接走真实安装（与 Electron 同一套服务）。',
  '      if (!cliToolRuntimeEnabled()) {',
  '        throw new AppError(',
  '          ErrorCode.FeatureUnavailable,',
  '          \'settings.integration.cli.tool.reason.unsupported-web\'',
  '        )',
  '      }',
  '      const request = cliInstallRequestSchema.parse(payload) as CliInstallRequest',
  '      const service = getCliToolService()',
  '      const operation = () => service.install(request)',
  '      return ctx.trackAsyncWork ? ctx.trackAsyncWork(operation) : operation()',
  '    },',
  '',
].join('\n')
cmd = cmd.replace(ffmpegAnchor, installHandler + ffmpegAnchor)

// imports
const importAnchor = "import type { TaskActionDeps, TaskTransitionRecordInput } from '@core/task/actions/shared'"
if (!cmd.includes(importAnchor)) {
  console.error('commands import anchor missing')
  process.exit(1)
}
cmd = cmd.replace(
  importAnchor,
  importAnchor +
    "\nimport { cliToolRuntimeEnabled, getCliToolService } from '../cli-tool-runtime'" +
    "\nimport {\n  type CliInstallRequest,\n  cliInstallRequestSchema,\n} from '@shared/types/cli-tool'"
)
fs.writeFileSync(c, cmd)
console.log('commands.ts: InstallCliTool registered')
console.log('done')