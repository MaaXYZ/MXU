import type { AppState, UpdateInfo } from '@/stores/types';
import type { ProjectInterface } from '@/types/interface';
import type { CheckAndDownloadOptions } from './updateService';

type AutoUpdateCheckState = Pick<
  AppState,
  | 'projectInterface'
  | 'updateCheckLoading'
  | 'setUpdateCheckLoading'
  | 'downloadStatus'
  | 'installStatus'
  | 'mirrorChyanSettings'
  | 'proxySettings'
>;

interface AutoUpdateCheckDependencies {
  getState: () => AutoUpdateCheckState;
  checkAndPrepareDownload: (options: CheckAndDownloadOptions) => Promise<UpdateInfo | null>;
  onResult: (result: UpdateInfo) => void;
  isCancelled?: () => boolean;
}

function isUpdateBusy(state: AutoUpdateCheckState): boolean {
  return (
    state.downloadStatus === 'downloading' ||
    state.downloadStatus === 'completed' ||
    state.installStatus !== 'idle'
  );
}

// 启动检查和定时检查共用互斥状态，响应返回后再次确认检查参数仍然有效。
export async function runAutoUpdateCheck(
  project: ProjectInterface,
  { getState, checkAndPrepareDownload, onResult, isCancelled }: AutoUpdateCheckDependencies,
): Promise<void> {
  const { mirrorchyan_rid: resourceId, version: currentVersion, github, name } = project;
  if (!resourceId || !currentVersion || isCancelled?.()) return;

  const state = getState();
  if (state.updateCheckLoading || isUpdateBusy(state)) return;
  state.setUpdateCheckLoading(true);
  const { mirrorChyanSettings, proxySettings } = state;

  try {
    const result = await checkAndPrepareDownload({
      resourceId,
      currentVersion,
      cdk: mirrorChyanSettings.cdk || undefined,
      channel: mirrorChyanSettings.channel,
      userAgent: 'MXU',
      githubUrl: github,
      githubPat: mirrorChyanSettings.githubPat || undefined,
      proxyUrl: proxySettings?.url,
      projectName: name,
    });

    const current = getState();
    // 比较实际参数，避免其他客户端同步等价配置时误丢弃结果。
    if (
      isCancelled?.() ||
      isUpdateBusy(current) ||
      current.projectInterface?.mirrorchyan_rid !== resourceId ||
      current.projectInterface.version !== currentVersion ||
      current.projectInterface.github !== github ||
      current.projectInterface.name !== name ||
      current.mirrorChyanSettings.cdk !== mirrorChyanSettings.cdk ||
      current.mirrorChyanSettings.channel !== mirrorChyanSettings.channel ||
      current.mirrorChyanSettings.githubPat !== mirrorChyanSettings.githubPat ||
      current.proxySettings?.url !== proxySettings?.url
    ) {
      return;
    }

    if (result) onResult(result);
  } finally {
    state.setUpdateCheckLoading(false);
  }
}
