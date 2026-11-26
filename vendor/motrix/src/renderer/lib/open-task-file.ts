import { toast } from '@renderer/components/ui/toast'
import { FnosHostRequiredError } from '@renderer/platform/fnos'
import { ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { TransportError } from '@shared/protocol/errors'
import type { TFunction } from 'i18next'
import {
  openPathWithHost,
  revealPathInHost,
  supportsHostFileActions,
} from './platform-actions'
import { transport } from './transport'

/** Shared failure presentation for the context menu and task inspector. */
export async function openTaskFile(
  taskId: string,
  t: TFunction,
  diskPath?: string
): Promise<void> {
  // HarmonyOS 移植：server 模式没有 command:openTaskFile，改由原生壳打开文件。
  // diskPath 由调用方传入（任务对象上有），拿不到就退回 IPC（其他宿主行为不变）。
  if (diskPath && supportsHostFileActions()) {
    openPathWithHost(diskPath)
    return
  }
  try {
    await transport.invoke(Commands.OpenTaskFile, { taskId })
  } catch (error) {
    toast.add({
      title: t('panel.downloads.action.openFileFailed'),
      description:
        error instanceof FnosHostRequiredError
          ? error.message
          : t(
              error instanceof TransportError &&
                error.code === ErrorCode.TaskOpenAppFailed
                ? 'panel.downloads.action.openFileAppFailed'
                : 'panel.downloads.action.openFileFailedHint'
            ),
      type: 'error',
    })
  }
}

export async function revealTaskFolder(
  task: { id: string; name: string; diskPath?: string },
  t: TFunction
): Promise<void> {
  // HarmonyOS 移植：同上，交给原生壳
  if (task.diskPath && supportsHostFileActions()) {
    revealPathInHost(task.diskPath)
    return
  }
  try {
    await transport.invoke(Commands.RevealInFolder, { taskId: task.id })
  } catch (error) {
    toast.add({
      title: t('panel.downloads.action.singleTaskFailed', {
        name: task.name,
        reason: error instanceof Error ? error.message : String(error),
      }),
      type: 'error',
    })
  }
}
