import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  Key,
  ExternalLink,
  Eye,
  EyeOff,
  AlertCircle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  PackageCheck,
  Bug,
  Network,
  Clock,
} from 'lucide-react';
import clsx from 'clsx';

import { useAppStore } from '@/stores/appStore';
import {
  checkAndPrepareDownload,
  openMirrorChyanWebsite,
  downloadUpdate,
  getUpdateSavePath,
  cancelDownload,
  MIRRORCHYAN_ERROR_CODES,
  isDebugVersion,
} from '@/services/updateService';
import { createProxySettings, proxySettingsForUpdateDownload } from '@/services/proxyService';
import { resolveI18nText } from '@/services/contentResolver';
import { getInterfaceLangKey } from '@/i18n';
import { loggers } from '@/utils/logger';
import { SwitchButton, TimeInput } from '../FormControls';
import { ReleaseNotes, DownloadProgressBar } from '../UpdateInfoCard';

export function UpdateSection() {
  const { t } = useTranslation();
  const {
    projectInterface,
    interfaceTranslations,
    dataPath,
    language,
    mirrorChyanSettings,
    setMirrorChyanCdk,
    setMirrorChyanChannel,
    scheduledUpdateCheckEnabled,
    scheduledUpdateCheckTime,
    setScheduledUpdateCheckEnabled,
    setScheduledUpdateCheckTime,
    proxySettings,
    setProxySettings,
    updateInfo,
    updateCheckLoading,
    setUpdateInfo,
    setUpdateCheckLoading,
    setShowUpdateDialog,
    downloadStatus,
    downloadProgress,
    setDownloadStatus,
    setDownloadProgress,
    setDownloadSavePath,
    resetDownloadState,
    installStatus,
    setInstallStatus,
    setShowInstallConfirmModal,
  } = useAppStore();

  const [showCdk, setShowCdk] = useState(false);
  const cdkInputRef = useRef<HTMLInputElement>(null);
  const [proxyInput, setProxyInput] = useState(proxySettings?.url || '');
  const [proxyError, setProxyError] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [, setDebugLog] = useState<string[]>([]);

  const addDebugLog = useCallback((msg: string) => {
    setDebugLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  const projectName =
    resolveI18nText(projectInterface?.label, translations) || projectInterface?.name || 'MXU';

  // 检查是否禁用代理（填写了 MirrorChyan CDK）
  const isProxyDisabled = useMemo(() => {
    return mirrorChyanSettings.cdk && mirrorChyanSettings.cdk.trim() !== '';
  }, [mirrorChyanSettings.cdk]);

  // 判断是否为调试版本（interface 调试版本，或 MXU 自身开发模式）
  const isDebugMode = useMemo(() => {
    return import.meta.env.DEV || isDebugVersion(projectInterface?.version);
  }, [projectInterface?.version]);

  // 处理代理输入框失焦事件
  const handleProxyBlur = useCallback(() => {
    const trimmed = proxyInput.trim();

    if (trimmed === '') {
      setProxySettings(undefined);
      setProxyError(false);
      return;
    }

    const settings = createProxySettings(trimmed);

    if (settings) {
      setProxySettings(settings);
      setProxyInput(settings.url);
      setProxyError(false);
    } else {
      setProxyError(true);
    }
  }, [proxyInput, setProxySettings]);

  // 同步 proxySettings 到 proxyInput
  useEffect(() => {
    if (proxySettings?.url && proxySettings.url !== proxyInput) {
      setProxyInput(proxySettings.url);
    }
  }, [proxySettings]);

  // 开始下载
  const startDownload = useCallback(
    async (targetUpdateInfo?: typeof updateInfo) => {
      const info = targetUpdateInfo || updateInfo;
      if (!info?.downloadUrl) return;

      setDownloadStatus('downloading');
      setDownloadProgress({
        downloadedSize: 0,
        totalSize: info.fileSize || 0,
        speed: 0,
        progress: 0,
      });

      try {
        const savePath = await getUpdateSavePath(info.filename);
        setDownloadSavePath(savePath);

        const proxyForDownload = proxySettingsForUpdateDownload(
          info.downloadSource,
          proxySettings,
          mirrorChyanSettings.cdk,
        );

        const result = await downloadUpdate({
          url: info.downloadUrl,
          savePath,
          totalSize: info.fileSize,
          proxySettings: proxyForDownload,
          onProgress: (progress) => {
            setDownloadProgress(progress);
          },
        });

        if (result.success) {
          // 使用实际保存路径（可能与请求路径不同，如果从 302 重定向检测到正确文件名）
          setDownloadSavePath(result.actualSavePath);
          setDownloadStatus('completed');
        } else {
          setDownloadStatus('failed');
        }
      } catch (error) {
        loggers.ui.error('下载失败:', error);
        setDownloadStatus('failed');
      }
    },
    [
      updateInfo,
      dataPath,
      setDownloadStatus,
      setDownloadProgress,
      setDownloadSavePath,
      proxySettings,
      mirrorChyanSettings.cdk,
    ],
  );

  // 处理 CDK 变化
  const handleCdkChange = useCallback(
    async (newCdk: string) => {
      const previousCdk = mirrorChyanSettings.cdk;
      setMirrorChyanCdk(newCdk);

      const isEnteringCdk = !previousCdk && newCdk.trim().length > 0;

      const isDownloadingFromGitHub =
        downloadStatus === 'downloading' && updateInfo?.downloadSource === 'github';
      const isDownloadFailed = downloadStatus === 'failed';
      const hasUpdateButNoUrl = updateInfo?.hasUpdate && !updateInfo?.downloadUrl;
      const isPendingGitHubDownload =
        downloadStatus === 'idle' &&
        updateInfo?.hasUpdate &&
        updateInfo?.downloadUrl &&
        updateInfo?.downloadSource === 'github';
      const noUpdateInfoYet = !updateInfo && downloadStatus === 'idle';

      const shouldTryMirrorChyan =
        isEnteringCdk &&
        projectInterface?.mirrorchyan_rid &&
        (isDownloadingFromGitHub ||
          isDownloadFailed ||
          hasUpdateButNoUrl ||
          isPendingGitHubDownload ||
          noUpdateInfoYet);

      if (shouldTryMirrorChyan) {
        if (isDownloadingFromGitHub) {
          addDebugLog('检测到填入 CDK，正在停止 GitHub 下载并切换到 Mirror酱...');
          await cancelDownload();
        } else if (isDownloadFailed) {
          addDebugLog('检测到填入 CDK，下载之前失败，尝试使用 Mirror酱 重新下载...');
        } else if (isPendingGitHubDownload) {
          addDebugLog('检测到填入 CDK，GitHub 下载等待中，切换到 Mirror酱...');
        } else if (noUpdateInfoYet) {
          addDebugLog('检测到填入 CDK，尚未获取到更新信息，使用 Mirror酱 检查更新...');
        } else {
          addDebugLog('检测到填入 CDK，尝试获取 Mirror酱 下载链接...');
        }

        resetDownloadState();

        setUpdateCheckLoading(true);
        try {
          const result = await checkAndPrepareDownload({
            resourceId: projectInterface!.mirrorchyan_rid!,
            currentVersion: projectInterface!.version || '',
            cdk: newCdk,
            channel: mirrorChyanSettings.channel,
            userAgent: 'MXU',
            githubUrl: projectInterface!.github,
            projectName: projectInterface!.name,
          });

          if (result) {
            setUpdateInfo(result);
            if (result.hasUpdate && result.downloadUrl && result.downloadSource === 'mirrorchyan') {
              addDebugLog(`已切换到 Mirror酱 下载: ${result.versionName}`);
              await startDownload(result);
            } else if (result.hasUpdate && result.downloadUrl) {
              addDebugLog(`CDK 无效或不匹配，继续使用 ${result.downloadSource} 下载`);
              await startDownload(result);
            } else {
              addDebugLog('无法获取 Mirror酱 下载链接，请检查 CDK');
            }
          }
        } catch (err) {
          addDebugLog(`切换下载源失败: ${err}`);
        } finally {
          setUpdateCheckLoading(false);
        }
      }
    },
    [
      mirrorChyanSettings.cdk,
      mirrorChyanSettings.channel,
      setMirrorChyanCdk,
      downloadStatus,
      updateInfo,
      projectInterface,
      dataPath,
      resetDownloadState,
      setUpdateCheckLoading,
      setUpdateInfo,
      startDownload,
      addDebugLog,
    ],
  );

  // 打开模态框并自动开始安装
  const handleInstallNow = useCallback(() => {
    setShowInstallConfirmModal(true);
    setInstallStatus('installing');
  }, [setShowInstallConfirmModal, setInstallStatus]);

  // 慢速下载引导：本身已在更新分区内，把 CDK 输入框滚进视野即可，不抢焦点
  const handleScrollToCdkInput = useCallback(() => {
    cdkInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  // 获取错误码对应的翻译文本
  const errorText = useMemo(() => {
    if (!updateInfo?.errorCode) return null;
    const code = updateInfo.errorCode;

    if (code < 0) {
      return t('mirrorChyan.errors.negative');
    }

    const knownCodes = [1001, 7001, 7002, 7003, 7004, 7005, 8001, 8002, 8003, 8004, 1];
    if (knownCodes.includes(code)) {
      return t(`mirrorChyan.errors.${code}`);
    }

    return t('mirrorChyan.errors.unknown', {
      code,
      message: updateInfo.errorMessage || '',
    });
  }, [updateInfo?.errorCode, updateInfo?.errorMessage, t]);

  // 判断是否为 CDK 相关错误
  const isCdkError = useMemo(() => {
    if (!updateInfo?.errorCode) return false;
    const cdkErrorCodes: number[] = [
      MIRRORCHYAN_ERROR_CODES.KEY_EXPIRED,
      MIRRORCHYAN_ERROR_CODES.KEY_INVALID,
      MIRRORCHYAN_ERROR_CODES.RESOURCE_QUOTA_EXHAUSTED,
      MIRRORCHYAN_ERROR_CODES.KEY_MISMATCHED,
      MIRRORCHYAN_ERROR_CODES.KEY_BLOCKED,
    ];
    return cdkErrorCodes.includes(updateInfo.errorCode);
  }, [updateInfo?.errorCode]);

  // 检查更新
  const handleCheckUpdate = async () => {
    if (!projectInterface?.mirrorchyan_rid || !projectInterface?.version) {
      addDebugLog('未配置 mirrorchyan_rid 或 version，无法检查更新');
      return;
    }

    if (import.meta.env.DEV) {
      addDebugLog('MXU 开发模式，跳过检查更新');
      return;
    }

    setCheckFailed(false);
    setUpdateCheckLoading(true);
    addDebugLog(`开始检查更新... (频道: ${mirrorChyanSettings.channel})`);

    try {
      const result = await checkAndPrepareDownload({
        resourceId: projectInterface.mirrorchyan_rid,
        currentVersion: projectInterface.version,
        cdk: mirrorChyanSettings.cdk || undefined,
        channel: mirrorChyanSettings.channel,
        userAgent: 'MXU',
        githubUrl: projectInterface.github,
        proxyUrl: proxySettings?.url,
        projectName: projectInterface.name,
      });

      if (result) {
        setUpdateInfo(result);
        if (result.hasUpdate) {
          addDebugLog(`发现新版本: ${result.versionName}`);
          if (result.downloadUrl) {
            addDebugLog(
              `下载来源: ${result.downloadSource === 'github' ? 'GitHub' : 'Mirror酱 CDN'}`,
            );
            startDownload(result);
          } else {
            addDebugLog('无可用下载链接');
          }
          setShowUpdateDialog(true);
        } else {
          addDebugLog(`当前已是最新版本: ${result.versionName}`);
        }
      } else {
        addDebugLog('检查更新失败');
        setCheckFailed(true);
      }
    } catch (err) {
      addDebugLog(`检查更新出错: ${err}`);
      setCheckFailed(true);
    } finally {
      setUpdateCheckLoading(false);
    }
  };

  if (!projectInterface?.mirrorchyan_rid) {
    return null;
  }

  return (
    <section id="section-update" className="space-y-4 scroll-mt-4">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider flex items-center gap-2">
        <Download className="w-4 h-4" />
        {t('mirrorChyan.title')}
      </h2>

      <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-5">
        {/* 调试模式提示 */}
        {isDebugMode ? (
          <div className="flex items-center gap-3 py-2 text-text-muted">
            <Bug className="w-5 h-5 text-warning" />
            <span className="text-sm">{t('mirrorChyan.debugModeNotice')}</span>
          </div>
        ) : (
          <>
            {/* 更新频道 */}
            <div>
              <div className="flex items-center gap-3 mb-3">
                <Download className="w-5 h-5 text-accent" />
                <span className="font-medium text-text-primary">{t('mirrorChyan.channel')}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setMirrorChyanChannel('stable')}
                  className={clsx(
                    'flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    mirrorChyanSettings.channel === 'stable'
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {t('mirrorChyan.channelStable')}
                </button>
                <button
                  onClick={() => setMirrorChyanChannel('beta')}
                  className={clsx(
                    'flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    mirrorChyanSettings.channel === 'beta'
                      ? 'bg-accent text-white'
                      : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {t('mirrorChyan.channelBeta')}
                </button>
              </div>
            </div>

            {/* 定时检查更新 */}
            <div className="pt-4 border-t border-border space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Clock className="w-5 h-5 text-accent" />
                  <span className="font-medium text-text-primary">
                    {t('settings.scheduledUpdateCheck')}
                  </span>
                </div>
                <SwitchButton
                  value={scheduledUpdateCheckEnabled}
                  onChange={setScheduledUpdateCheckEnabled}
                />
              </div>
              {scheduledUpdateCheckEnabled && (
                <label className="flex items-center justify-between gap-3">
                  <span className="text-sm text-text-secondary">
                    {t('settings.scheduledUpdateCheckTime')}
                  </span>
                  <TimeInput
                    value={scheduledUpdateCheckTime}
                    onChange={setScheduledUpdateCheckTime}
                  />
                </label>
              )}
            </div>

            {/* CDK 输入 */}
            <div className="pt-4 border-t border-border">
              <div className="flex items-center gap-3 mb-3">
                <Key className="w-5 h-5 text-accent" />
                <span className="font-medium text-text-primary">{t('mirrorChyan.cdk')}</span>
                <button
                  onClick={() => openMirrorChyanWebsite('mxu_settings')}
                  className="ml-auto text-xs text-accent hover:underline flex items-center gap-1"
                >
                  {t('mirrorChyan.getCdk')}
                  <ExternalLink className="w-3 h-3" />
                </button>
              </div>
              <div className="relative">
                <input
                  ref={cdkInputRef}
                  type={showCdk ? 'text' : 'password'}
                  value={mirrorChyanSettings.cdk}
                  onChange={(e) => handleCdkChange(e.target.value)}
                  placeholder={t('mirrorChyan.cdkPlaceholder')}
                  className="w-full px-3 py-2.5 pr-10 rounded-lg bg-bg-tertiary border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
                />
                <button
                  onClick={() => setShowCdk(!showCdk)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-text-muted hover:text-text-secondary transition-colors"
                >
                  {showCdk ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="mt-3 text-xs text-text-muted leading-relaxed">
                <p>
                  <button
                    onClick={() => openMirrorChyanWebsite('mxu_settings_hint')}
                    className="text-accent hover:underline"
                  >
                    {t('mirrorChyan.serviceName')}
                  </button>
                  {t('mirrorChyan.cdkHintAfterLink', { projectName })}
                </p>
              </div>
            </div>

            {/* 代理设置 */}
            {!isProxyDisabled && (
              <div className="pt-4 border-t border-border">
                <div className="flex items-center gap-3 mb-3">
                  <Network className="w-5 h-5 text-accent" />
                  <span className="font-medium text-text-primary">{t('proxy.title')}</span>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={proxyInput}
                    onChange={(e) => {
                      setProxyInput(e.target.value);
                      setProxyError(false);
                    }}
                    onBlur={handleProxyBlur}
                    placeholder={t('proxy.urlPlaceholder')}
                    className={clsx(
                      'w-full px-3 py-2.5 rounded-lg bg-bg-tertiary border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50',
                      proxyError ? 'border-error' : 'border-border',
                    )}
                  />
                </div>
                {proxyError && (
                  <p className="mt-2 text-xs text-error flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    {t('proxy.invalid')}
                  </p>
                )}
                <div className="mt-3 text-xs text-text-muted leading-relaxed space-y-1">
                  <p>{t('proxy.urlHint')}</p>
                </div>
              </div>
            )}

            {/* 检查更新按钮 */}
            <div className="pt-4 border-t border-border space-y-4">
              {downloadStatus === 'downloading' ? (
                <div className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-bg-tertiary text-text-muted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('mirrorChyan.downloading')}
                </div>
              ) : downloadStatus === 'completed' && installStatus === 'idle' ? (
                <button
                  onClick={handleInstallNow}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover transition-colors"
                >
                  <PackageCheck className="w-4 h-4" />
                  {t('mirrorChyan.installNow')}
                </button>
              ) : (
                <button
                  onClick={handleCheckUpdate}
                  disabled={updateCheckLoading}
                  className={clsx(
                    'w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    updateCheckLoading
                      ? 'bg-bg-tertiary text-text-muted cursor-not-allowed'
                      : 'bg-accent text-white hover:bg-accent-hover',
                  )}
                >
                  {updateCheckLoading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('mirrorChyan.checking')}
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4" />
                      {t('mirrorChyan.checkUpdate')}
                    </>
                  )}
                </button>
              )}

              {/* 更新状态显示 */}
              {updateInfo && !updateInfo.hasUpdate && !updateInfo.errorCode && (
                <p className="text-xs text-center text-text-muted">
                  {t('mirrorChyan.upToDate', { version: updateInfo.versionName })}
                </p>
              )}

              {/* 网络异常导致检查失败 */}
              {checkFailed && !updateCheckLoading && (
                <div className="flex items-start gap-2 p-3 rounded-lg text-sm bg-error/10 text-error border border-error/30">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p>{t('mirrorChyan.checkFailed')}</p>
                    <p className="text-xs opacity-80">{t('mirrorChyan.checkFailedHint')}</p>
                  </div>
                </div>
              )}

              {/* 有更新时显示更新内容和下载进度 */}
              {updateInfo?.hasUpdate && (
                <div className="space-y-4 p-4 bg-bg-tertiary rounded-lg border border-border">
                  {/* 新版本标题 */}
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-accent" />
                    <span className="text-sm font-medium text-text-primary">
                      {t('mirrorChyan.newVersion')}
                    </span>
                    <span className="font-mono text-sm text-accent font-semibold">
                      {updateInfo.versionName}
                    </span>
                    {updateInfo.channel && updateInfo.channel !== 'stable' && (
                      <span className="px-1.5 py-0.5 bg-warning/20 text-warning text-xs rounded font-medium">
                        {updateInfo.channel}
                      </span>
                    )}
                  </div>

                  {/* 更新日志 */}
                  {updateInfo.releaseNote && (
                    <ReleaseNotes
                      releaseNote={updateInfo.releaseNote}
                      collapsibleTitle
                      maxHeightClass="max-h-32"
                      bgClass="bg-bg-secondary"
                      textSizeClass="text-xs"
                    />
                  )}

                  {/* API 错误提示 */}
                  {updateInfo.errorCode && errorText && (
                    <div
                      className={clsx(
                        'flex items-start gap-2 p-2 rounded-lg text-xs',
                        isCdkError ? 'bg-warning/10 text-warning' : 'bg-error/10 text-error',
                      )}
                    >
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{errorText}</span>
                    </div>
                  )}

                  {/* 没有下载链接的提示 */}
                  {!updateInfo.downloadUrl && !updateInfo.errorCode && (
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <AlertCircle className="w-3.5 h-3.5 text-warning" />
                      <span>{t('mirrorChyan.noDownloadUrl')}</span>
                    </div>
                  )}

                  {/* 下载进度 */}
                  {updateInfo.downloadUrl && downloadStatus !== 'idle' && (
                    <DownloadProgressBar
                      downloadStatus={downloadStatus}
                      downloadProgress={downloadProgress}
                      fileSize={updateInfo.fileSize}
                      downloadSource={updateInfo.downloadSource}
                      onInstallClick={handleInstallNow}
                      onRetryClick={() => {
                        resetDownloadState();
                        startDownload();
                      }}
                      progressBgClass="bg-bg-secondary"
                      onSlowDownloadHintClick={handleScrollToCdkInput}
                    />
                  )}

                  {/* 等待下载 */}
                  {updateInfo.downloadUrl && downloadStatus === 'idle' && (
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>{t('mirrorChyan.preparingDownload')}</span>
                    </div>
                  )}
                </div>
              )}

              {/* 只有错误没有更新时显示错误 */}
              {updateInfo && !updateInfo.hasUpdate && updateInfo.errorCode && errorText && (
                <div
                  className={clsx(
                    'flex items-start gap-2 p-3 rounded-lg text-sm',
                    isCdkError
                      ? 'bg-warning/10 text-warning border border-warning/30'
                      : 'bg-error/10 text-error border border-error/30',
                  )}
                >
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="space-y-1">
                    <p>{errorText}</p>
                    {isCdkError && <p className="text-xs opacity-80">{t('mirrorChyan.cdkHint')}</p>}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
