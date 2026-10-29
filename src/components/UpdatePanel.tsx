import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  X,
  Download,
  ChevronRight,
  Maximize2,
  AlertCircle,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { useAppStore, type DownloadProgress } from '@/stores/appStore';
import { simpleMarkdownToHtml } from '@/services/contentResolver';
import {
  downloadUpdate,
  getUpdateSavePath,
  MIRRORCHYAN_ERROR_CODES,
  savePendingUpdateInfo,
} from '@/services/updateService';
import { proxySettingsForUpdateDownload } from '@/services/proxyService';
import { DownloadProgressBar, useOpenUpdateSettings } from './UpdateInfoCard';
import clsx from 'clsx';
import { loggers } from '@/utils/logger';

interface UpdatePanelProps {
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

export function UpdatePanel({ onClose, anchorRef }: UpdatePanelProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });

  const {
    updateInfo,
    proxySettings,
    mirrorChyanSettings,
    downloadStatus,
    downloadProgress,
    setDownloadStatus,
    setDownloadProgress,
    setDownloadSavePath,
    resetDownloadState,
    setShowInstallConfirmModal,
  } = useAppStore();

  // 开始下载
  const startDownload = useCallback(async () => {
    if (!updateInfo?.downloadUrl) return;

    setDownloadStatus('downloading');
    setDownloadProgress({
      downloadedSize: 0,
      totalSize: updateInfo.fileSize || 0,
      speed: 0,
      progress: 0,
    });

    try {
      const savePath = await getUpdateSavePath(updateInfo.filename);
      setDownloadSavePath(savePath);

      const proxyForDownload = proxySettingsForUpdateDownload(
        updateInfo.downloadSource,
        proxySettings,
        mirrorChyanSettings.cdk,
      );

      const result = await downloadUpdate({
        url: updateInfo.downloadUrl,
        savePath,
        totalSize: updateInfo.fileSize,
        proxySettings: proxyForDownload,
        onProgress: (progress: DownloadProgress) => {
          setDownloadProgress(progress);
        },
      });

      if (result.success) {
        // 使用实际保存路径（可能与请求路径不同，如果从 302 重定向检测到正确文件名）
        setDownloadSavePath(result.actualSavePath);
        // 保存待安装更新信息，以便下次启动时自动安装
        savePendingUpdateInfo({
          versionName: updateInfo.versionName,
          releaseNote: updateInfo.releaseNote,
          channel: updateInfo.channel,
          downloadSavePath: result.actualSavePath,
          fileSize: updateInfo.fileSize,
          updateType: updateInfo.updateType,
          downloadSource: updateInfo.downloadSource,
          timestamp: Date.now(),
        });
        setDownloadStatus('completed');
      } else {
        setDownloadStatus('failed');
      }
    } catch (error) {
      loggers.ui.error('下载失败:', error);
      setDownloadStatus('failed');
    }
  }, [
    updateInfo,
    proxySettings,
    mirrorChyanSettings.cdk,
    setDownloadStatus,
    setDownloadProgress,
    setDownloadSavePath,
  ]);

  // 自动下载已由 App.tsx 在检查更新后立即触发，此处不再重复处理

  // 打开更新详情/安装弹窗
  const handleOpenModal = useCallback(() => {
    setShowInstallConfirmModal(true);
    onClose(); // 关闭气泡
  }, [setShowInstallConfirmModal, onClose]);

  // 打开模态框并自动开始安装
  const handleInstallNow = useCallback(() => {
    setShowInstallConfirmModal(true);
    onClose(); // 关闭气泡
    // 设置一个标志让模态框自动开始安装
    useAppStore.getState().setInstallStatus('installing');
  }, [setShowInstallConfirmModal, onClose]);

  // 跳转到设置页的更新分区去配置 CDK
  const openUpdateSettings = useOpenUpdateSettings();
  const handleOpenUpdateSettings = useCallback(() => {
    openUpdateSettings();
    onClose(); // 关闭气泡
  }, [openUpdateSettings, onClose]);

  // 计算面板位置
  useEffect(() => {
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPosition({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    }
  }, [anchorRef]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, anchorRef]);

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // 获取错误码对应的翻译文本
  const errorText = useMemo(() => {
    if (!updateInfo?.errorCode) return null;
    const code = updateInfo.errorCode;

    // code < 0 表示严重服务器错误
    if (code < 0) {
      return t('mirrorChyan.errors.negative');
    }

    // 尝试获取已知错误码的翻译
    const knownCodes = [1001, 7001, 7002, 7003, 7004, 7005, 8001, 8002, 8003, 8004, 1];
    if (knownCodes.includes(code)) {
      return t(`mirrorChyan.errors.${code}`);
    }

    // 未知错误码
    return t('mirrorChyan.errors.unknown', {
      code,
      message: updateInfo.errorMessage || '',
    });
  }, [updateInfo?.errorCode, updateInfo?.errorMessage, t]);

  // 判断是否为 CDK 相关错误（需要提示用户检查 CDK）
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

  // 如果没有更新且没有错误，不显示面板
  if (!updateInfo?.hasUpdate && !updateInfo?.errorCode) return null;

  // 如果只有错误信息（没有更新），显示错误面板
  if (!updateInfo?.hasUpdate && updateInfo?.errorCode) {
    return (
      <div
        ref={panelRef}
        className="mxu-overlay-surface fixed z-50 w-80 bg-bg-secondary rounded-xl shadow-lg border border-border overflow-hidden animate-in"
        style={{
          top: position.top,
          right: position.right,
        }}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 bg-bg-tertiary border-b border-border">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <span className="text-sm font-medium text-text-primary">
              {t('mirrorChyan.checkFailed')}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover transition-colors">
            <X className="w-4 h-4 text-text-muted" />
          </button>
        </div>

        {/* 错误信息 */}
        <div className="p-4 space-y-3">
          <div
            className={clsx(
              'flex items-start gap-2 p-3 rounded-lg border',
              isCdkError ? 'bg-warning/10 border-warning/30' : 'bg-error/10 border-error/30',
            )}
          >
            <AlertCircle
              className={clsx(
                'w-4 h-4 mt-0.5 shrink-0',
                isCdkError ? 'text-warning' : 'text-error',
              )}
            />
            <div className="space-y-1 min-w-0">
              <p className={clsx('text-sm', isCdkError ? 'text-warning' : 'text-error')}>
                {errorText}
              </p>
              {isCdkError && <p className="text-xs text-text-muted">{t('mirrorChyan.cdkHint')}</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 气泡模式 - 紧凑的弹出面板
  return (
    <div
      ref={panelRef}
      className="mxu-overlay-surface fixed z-50 w-80 bg-bg-secondary rounded-xl shadow-lg border border-border overflow-hidden animate-in"
      style={{
        top: position.top,
        right: position.right,
      }}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 bg-bg-tertiary border-b border-border">
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
        <button onClick={onClose} className="p-1 rounded-md hover:bg-bg-hover transition-colors">
          <X className="w-4 h-4 text-text-muted" />
        </button>
      </div>

      {/* 内容区 */}
      <div className="p-4 space-y-4">
        {/* 更新日志 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1 text-sm font-medium text-text-primary">
              <ChevronRight className="w-3 h-3" />
              <span>{t('mirrorChyan.releaseNotes')}</span>
            </div>
            {updateInfo.releaseNote && (
              <button
                onClick={handleOpenModal}
                className="flex items-center gap-1 px-2 py-1 text-xs text-accent hover:bg-accent/10 rounded-md transition-colors"
                title={t('mirrorChyan.viewDetails')}
              >
                <Maximize2 className="w-3 h-3" />
                <span>{t('mirrorChyan.viewDetails')}</span>
              </button>
            )}
          </div>
          <div className="max-h-32 overflow-y-auto bg-bg-tertiary rounded-lg p-3 border border-border">
            {updateInfo.releaseNote ? (
              <div
                className="text-xs text-text-secondary prose prose-sm max-w-none leading-relaxed"
                dangerouslySetInnerHTML={{ __html: simpleMarkdownToHtml(updateInfo.releaseNote) }}
              />
            ) : (
              <p className="text-xs text-text-muted italic">{t('mirrorChyan.noReleaseNotes')}</p>
            )}
          </div>
        </div>

        {/* 下载状态 */}
        <div className="space-y-2 pt-2 border-t border-border">
          {/* API 错误提示（如 CDK 问题导致无法获取下载链接） */}
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

          {/* 没有下载链接的提示（仅当没有 API 错误时显示通用提示） */}
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
              onSlowDownloadHintClick={handleOpenUpdateSettings}
            />
          )}

          {/* 等待下载（有链接但未开始） */}
          {updateInfo.downloadUrl && downloadStatus === 'idle' && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>{t('mirrorChyan.preparingDownload')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
