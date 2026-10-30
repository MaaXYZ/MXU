import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Download,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Loader2,
  PartyPopper,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  installUpdate,
  restartApp,
  saveUpdateCompleteInfo,
  clearPendingUpdateInfo,
  ensureCurrentExeExists,
  isExecutableInstaller,
  UpdateInstallError,
} from '@/services/updateService';
import type { TFunction } from 'i18next';
import { ReleaseNotes, DownloadProgressBar, useOpenUpdateSettings } from './UpdateInfoCard';
import { loggers } from '@/utils/logger';

// 将安装/重启错误转换为界面显示的文案（兜底更新的提示直接使用其 message）
function formatInstallError(error: unknown, t: TFunction): string {
  if (error instanceof UpdateInstallError) {
    return t(`mirrorChyan.installErrors.${error.code}`, { detail: error.detail });
  }
  return error instanceof Error ? error.message : String(error);
}

export function InstallConfirmModal() {
  const { t } = useTranslation();
  const [installStage, setInstallStage] = useState<string>('');
  // 重启失败（安装已完成）时不提供重试：更新包已移走，重新安装没有意义
  const [restartFailed, setRestartFailed] = useState(false);

  const {
    updateInfo,
    projectInterface,
    basePath,
    downloadSavePath,
    showInstallConfirmModal,
    installStatus,
    installError,
    downloadStatus,
    downloadProgress,
    justUpdatedInfo,
    setShowInstallConfirmModal,
    setInstallStatus,
    setInstallError,
    setJustUpdatedInfo,
    resetInstallState,
    autoInstallPending,
    setAutoInstallPending,
  } = useAppStore();

  const currentVersion = projectInterface?.version || '';
  const projectName = projectInterface?.name;

  // 判断是否为"刚更新完成"模式
  const isJustUpdatedMode = !!justUpdatedInfo;

  // 开始安装
  const handleInstall = useCallback(async () => {
    if (!downloadSavePath || !basePath || !updateInfo) return;

    setInstallStatus('installing');
    setInstallError(null);
    setInstallStage('');
    setRestartFailed(false);

    try {
      const success = await installUpdate({
        zipPath: downloadSavePath,
        targetDir: basePath,
        newVersion: updateInfo.versionName,
        projectName,
        onProgress: (stage, detail) => {
          const stageText = t(`mirrorChyan.installStages.${stage}`, stage);
          if (detail) {
            const detailText = t(`mirrorChyan.installStages.${detail}`, detail);
            setInstallStage(`${stageText} (${detailText})`);
          } else {
            setInstallStage(stageText);
          }
        },
      });

      if (success) {
        setInstallStatus('completed');
      } else {
        setInstallStatus('failed');
        setInstallError(t('mirrorChyan.installFailed'));
      }
    } catch (error) {
      loggers.ui.error('安装失败:', error instanceof Error ? error.message : error);
      setInstallStatus('failed');
      setInstallError(formatInstallError(error, t));
    }
  }, [downloadSavePath, basePath, updateInfo, projectName, setInstallStatus, setInstallError, t]);

  // 重启应用（直接重启，不再确认）
  const handleRestart = useCallback(async () => {
    try {
      await ensureCurrentExeExists();
      // 清除待安装更新信息（安装已完成）
      clearPendingUpdateInfo();
      // 保存更新完成信息，供重启后显示
      if (updateInfo) {
        saveUpdateCompleteInfo({
          previousVersion: currentVersion,
          newVersion: updateInfo.versionName,
          releaseNote: updateInfo.releaseNote,
          channel: updateInfo.channel,
          timestamp: Date.now(),
        });
      }
      await restartApp();
    } catch (error) {
      loggers.ui.error('重启失败:', error instanceof Error ? error.message : error);
      setRestartFailed(true);
      setInstallStatus('failed');
      setInstallError(formatInstallError(error, t));
    }
  }, [updateInfo, currentVersion, setInstallStatus, setInstallError, t]);

  // 关闭模态框
  const handleClose = useCallback(() => {
    if (installStatus === 'installing') return;
    setShowInstallConfirmModal(false);
    if (installStatus === 'failed') {
      resetInstallState();
    }
    // 清除"刚更新完成"状态
    if (justUpdatedInfo) {
      setJustUpdatedInfo(null);
    }
  }, [
    installStatus,
    setShowInstallConfirmModal,
    resetInstallState,
    justUpdatedInfo,
    setJustUpdatedInfo,
  ]);

  // 跳转到设置页的更新分区去配置 CDK
  const openUpdateSettings = useOpenUpdateSettings();
  const handleOpenUpdateSettings = useCallback(() => {
    openUpdateSettings();
    setShowInstallConfirmModal(false); // 否则弹窗会盖住设置页
  }, [openUpdateSettings, setShowInstallConfirmModal]);

  // 用于追踪是否已触发自动安装，避免重复执行
  const autoInstallTriggered = useRef(false);
  // 用于追踪是否已触发自动重启，避免重复执行
  const autoRestartTriggered = useRef(false);

  // 当模态框打开且 installStatus 为 'installing' 时自动开始安装
  useEffect(() => {
    if (
      showInstallConfirmModal &&
      installStatus === 'installing' &&
      !autoInstallTriggered.current
    ) {
      autoInstallTriggered.current = true;
      // 实际执行安装逻辑
      (async () => {
        if (!downloadSavePath || !basePath || !updateInfo) {
          setInstallStatus('failed');
          setInstallError('下载路径无效');
          return;
        }

        setInstallError(null);
        setInstallStage('');

        try {
          const success = await installUpdate({
            zipPath: downloadSavePath,
            targetDir: basePath,
            newVersion: updateInfo.versionName,
            projectName,
            onProgress: (stage, detail) => {
              const stageText = t(`mirrorChyan.installStages.${stage}`, stage);
              if (detail) {
                const detailText = t(`mirrorChyan.installStages.${detail}`, detail);
                setInstallStage(`${stageText} (${detailText})`);
              } else {
                setInstallStage(stageText);
              }
            },
          });

          if (success) {
            setInstallStatus('completed');
          } else {
            setInstallStatus('failed');
            setInstallError(t('mirrorChyan.installFailed'));
          }
        } catch (error) {
          loggers.ui.error('安装失败:', error instanceof Error ? error.message : error);
          setInstallStatus('failed');
          setInstallError(formatInstallError(error, t));
        }
      })();
    }

    // 重置标志当模态框关闭时
    if (!showInstallConfirmModal) {
      autoInstallTriggered.current = false;
      autoRestartTriggered.current = false;
      setRestartFailed(false);
    }
  }, [
    showInstallConfirmModal,
    installStatus,
    downloadSavePath,
    basePath,
    updateInfo,
    projectName,
    setInstallStatus,
    setInstallError,
    t,
  ]);

  // 自动安装：由 tryAutoInstallUpdate 触发，通过 autoInstallPending 标记
  useEffect(() => {
    if (showInstallConfirmModal && autoInstallPending && installStatus === 'idle') {
      setAutoInstallPending(false);
      // 标记已触发，防止 handleInstall 设置 installStatus='installing' 后
      // 上方的 installStatus==='installing' effect 再次调用 installUpdate（竞态双发）
      autoInstallTriggered.current = true;
      handleInstall();
    }
  }, [
    showInstallConfirmModal,
    autoInstallPending,
    installStatus,
    setAutoInstallPending,
    handleInstall,
  ]);

  // 判断当前是否为可执行安装程序（exe/dmg）
  const isExeInstaller = downloadSavePath && isExecutableInstaller(downloadSavePath);

  // 安装完成后自动重启（对于可执行安装程序什么都不做，让安装程序自己处理）
  useEffect(() => {
    if (installStatus === 'completed' && !autoRestartTriggered.current && !isJustUpdatedMode) {
      autoRestartTriggered.current = true;
      // 如果是可执行安装程序（exe/dmg），保存更新完成信息（带版本验证标记），让下次启动时检测
      // 用户需要手动运行安装程序，安装完成后重新启动应用会自动检测版本变化
      if (isExeInstaller && updateInfo) {
        // 保存更新完成信息（requireVersionCheck=true 表示需要验证版本）
        saveUpdateCompleteInfo({
          previousVersion: currentVersion,
          newVersion: updateInfo.versionName,
          releaseNote: updateInfo.releaseNote,
          channel: updateInfo.channel,
          timestamp: Date.now(),
          requireVersionCheck: true,
        });
        clearPendingUpdateInfo();
        // 不关闭弹窗、不重启
        return;
      }
      handleRestart();
    }
  }, [installStatus, isJustUpdatedMode, handleRestart, isExeInstaller, updateInfo, currentVersion]);

  // 如果没有打开模态框，或者既没有更新信息也没有刚更新完成信息，则不渲染
  if (!showInstallConfirmModal || (!updateInfo && !justUpdatedInfo)) return null;

  // 获取显示用的版本信息（优先使用刚更新完成信息）
  const displayVersionName = justUpdatedInfo?.newVersion || updateInfo?.versionName || '';
  const displayReleaseNote = justUpdatedInfo?.releaseNote || updateInfo?.releaseNote || '';
  const displayChannel = justUpdatedInfo?.channel || updateInfo?.channel;

  // 判断当前状态
  const isDownloading = downloadStatus === 'downloading';
  const isDownloadComplete = downloadStatus === 'completed';
  const isInstalling = installStatus === 'installing';
  const isInstallComplete = installStatus === 'completed';
  const isInstallFailed = installStatus === 'failed';

  // 判断是否需要显示更新日志（需要大尺寸模态框）
  const showReleaseNotes =
    isJustUpdatedMode || (!isInstallComplete && !isInstallFailed && !isInstalling);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={handleClose}
    >
      <div
        className={`mxu-overlay-surface w-[50vw] min-w-[500px] bg-bg-secondary rounded-xl shadow-2xl border border-border overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col ${showReleaseNotes ? 'h-[80vh]' : 'max-h-[80vh]'}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 bg-bg-tertiary border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {isJustUpdatedMode ? (
              <PartyPopper className="w-4 h-4 text-success" />
            ) : (
              <Download className="w-4 h-4 text-accent" />
            )}
            <span className="text-sm font-medium text-text-primary">
              {isJustUpdatedMode
                ? t('mirrorChyan.updateCompleteTitle')
                : isInstallComplete
                  ? t('mirrorChyan.installComplete')
                  : t('mirrorChyan.releaseNotes')}
            </span>
            <span className="font-mono text-sm text-accent font-semibold">
              {displayVersionName}
            </span>
            {displayChannel && displayChannel !== 'stable' && (
              <span className="px-1.5 py-0.5 bg-warning/20 text-warning text-xs rounded font-medium">
                {displayChannel}
              </span>
            )}
          </div>
          {!isInstalling && (
            <button
              onClick={handleClose}
              className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors"
            >
              <X className="w-4 h-4 text-text-muted" />
            </button>
          )}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden p-4 min-h-0 flex flex-col">
          {/* 刚更新完成模式 - 显示更新成功信息和更新日志 */}
          {isJustUpdatedMode && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="flex flex-col items-center gap-3 py-4 shrink-0">
                <CheckCircle className="w-12 h-12 text-success" />
                <p className="text-sm text-text-primary font-medium">
                  {t('mirrorChyan.updateCompleteMessage')}
                </p>
              </div>

              <ReleaseNotes releaseNote={displayReleaseNote} fillHeight className="flex-1" />
            </div>
          )}

          {/* 安装完成状态（正在重启）- 对于可执行安装程序不显示 */}
          {!isJustUpdatedMode && isInstallComplete && !isExeInstaller && (
            <div className="flex flex-col items-center gap-4 py-4">
              <Loader2 className="w-12 h-12 text-accent animate-spin" />
              <p className="text-sm text-text-primary font-medium">{t('mirrorChyan.restarting')}</p>
            </div>
          )}

          {/* 可执行安装程序已打开状态 - 提示用户手动操作 */}
          {!isJustUpdatedMode && isInstallComplete && isExeInstaller && (
            <div className="flex flex-col items-center gap-4 py-4">
              <CheckCircle className="w-12 h-12 text-success" />
              <div className="text-center space-y-2">
                <p className="text-sm text-text-primary font-medium">
                  {t('mirrorChyan.installerOpened')}
                </p>
                <p className="text-xs text-text-muted">{t('mirrorChyan.installerOpenedHint')}</p>
              </div>
            </div>
          )}

          {/* 安装失败状态 */}
          {isInstallFailed && (
            <div className="flex flex-col items-center gap-4 py-4">
              <AlertCircle className="w-12 h-12 text-error" />
              <div className="text-center space-y-2">
                <p className="text-sm text-text-primary font-medium">
                  {t('mirrorChyan.installFailed')}
                </p>
                {installError && <p className="text-xs text-error">{installError}</p>}
              </div>
            </div>
          )}

          {/* 安装中状态 */}
          {isInstalling && (
            <div className="flex flex-col items-center gap-4 py-4">
              <Loader2 className="w-12 h-12 text-accent animate-spin" />
              <div className="text-center space-y-2">
                <p className="text-sm text-text-primary font-medium">
                  {t('mirrorChyan.installing')}
                </p>
                {installStage && <p className="text-xs text-text-muted">{installStage}</p>}
              </div>
            </div>
          )}

          {/* 常规状态 - 显示更新日志 */}
          {!isJustUpdatedMode &&
            !isInstallComplete &&
            !isInstallFailed &&
            !isInstalling &&
            updateInfo && (
              <div className="flex-1 flex flex-col min-h-0">
                <ReleaseNotes releaseNote={updateInfo.releaseNote} fillHeight className="flex-1" />

                {/* 下载进度 */}
                {downloadStatus !== 'idle' && (
                  <div className="pt-2 mt-4 border-t border-border shrink-0">
                    <DownloadProgressBar
                      downloadStatus={downloadStatus}
                      downloadProgress={downloadProgress}
                      fileSize={updateInfo.fileSize}
                      downloadSource={updateInfo.downloadSource}
                      showActions={false}
                      onSlowDownloadHintClick={handleOpenUpdateSettings}
                    />
                  </div>
                )}
              </div>
            )}
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 bg-bg-tertiary border-t border-border shrink-0">
          {/* 刚更新完成模式 - 只显示关闭按钮 */}
          {isJustUpdatedMode && (
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors"
            >
              {t('mirrorChyan.gotIt')}
            </button>
          )}

          {/* 关闭/取消按钮（安装失败时由下方单独处理，避免重复） */}
          {!isJustUpdatedMode && !isInstalling && !isInstallComplete && !isInstallFailed && (
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm text-text-secondary hover:bg-bg-hover rounded-lg transition-colors"
            >
              {t('common.close')}
            </button>
          )}

          {/* 正在下载 */}
          {!isJustUpdatedMode && isDownloading && (
            <button
              disabled
              className="flex items-center gap-2 px-4 py-2 text-sm bg-bg-tertiary text-text-muted rounded-lg cursor-not-allowed"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('mirrorChyan.downloading')}
            </button>
          )}

          {/* 下载完成，可以安装 */}
          {!isJustUpdatedMode && isDownloadComplete && installStatus === 'idle' && (
            <button
              onClick={handleInstall}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors"
            >
              <Download className="w-4 h-4" />
              {t('mirrorChyan.installNow')}
            </button>
          )}

          {/* 正在安装 */}
          {!isJustUpdatedMode && isInstalling && (
            <button
              disabled
              className="flex items-center gap-2 px-4 py-2 text-sm bg-bg-tertiary text-text-muted rounded-lg cursor-not-allowed"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('mirrorChyan.installing')}
            </button>
          )}

          {/* 安装失败，重试 */}
          {!isJustUpdatedMode && isInstallFailed && (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 text-sm text-text-secondary hover:bg-bg-hover rounded-lg transition-colors"
              >
                {t('common.close')}
              </button>
              {!restartFailed && (
                <button
                  onClick={() => {
                    resetInstallState();
                    handleInstall();
                  }}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-accent text-white hover:bg-accent-hover rounded-lg transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  {t('mirrorChyan.retry')}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
