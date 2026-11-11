import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Maximize2,
  X,
  Monitor,
  ChevronDown,
  Play,
  Pause,
  RefreshCw,
  Download,
  Copy,
  Unplug,
  MousePointerClick,
} from 'lucide-react';
import clsx from 'clsx';
import { maaService } from '@/services/maaService';
import { useAppStore } from '@/stores/appStore';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { getFrameInterval } from './FrameRateSelector';
import { loggers } from '@/utils/logger';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useScreenshotStream } from '@/hooks/useScreenshotStream';

const log = loggers.ui;

// 超时
const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

const MAX_CONSECUTIVE_FAILURES = 20;
const API_TIMEOUT = 30000;

export function ScreenshotPanel() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const {
    activeInstanceId,
    instanceConnectionStatus,
    instanceResourceLoaded,
    sidePanelExpanded,
    instanceScreenshotStreaming,
    setInstanceScreenshotStreaming,
    screenshotPanelExpanded,
    setScreenshotPanelExpanded,
    screenshotFrameRate,
  } = useAppStore();

  // 在移动端单列布局中，截图面板始终可见，不受 sidePanelExpanded 影响
  const isPanelVisible = isMobile || sidePanelExpanded;

  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();
  const fullscreenImgRef = useRef<HTMLImageElement>(null);

  const connectionVersion = useRef(0);
  const instanceId = activeInstanceId || '';

  const connectionStatus = instanceConnectionStatus[instanceId];
  const connected = connectionStatus === 'Connected';

  // 从 store 获取当前实例的截图流状态
  const isStreaming = instanceId ? (instanceScreenshotStreaming[instanceId] ?? false) : false;

  // 更新截图流状态
  const setIsStreaming = useCallback(
    (streaming: boolean) => {
      if (instanceId) {
        setInstanceScreenshotStreaming(instanceId, streaming);
      }
    },
    [instanceId, setInstanceScreenshotStreaming],
  );

  // 获取最新缓存截图（后端截图循环负责更新缓存，前端无需主动触发 postScreencap）
  const captureFrame = useCallback(async (): Promise<string | null> => {
    if (!instanceId || !connected) return null;
    const version = connectionVersion.current;
    try {
      const imageData = await withTimeout(maaService.getCachedImage(instanceId), API_TIMEOUT);
      return version === connectionVersion.current ? imageData || null : null;
    } catch (err) {
      if (version !== connectionVersion.current) return null;
      log.warn('获取截图失败:', err);
      throw err;
    }
  }, [instanceId, connected]);

  // 全屏模式切换
  const toggleFullscreen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsFullscreen(!isFullscreen);
  };

  // ESC 键退出全屏
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    if (isFullscreen) {
      document.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFullscreen]);

  const displayFrame = useCallback((frame: string) => {
    setScreenshotUrl(frame);
    setCaptureFailed(false);
  }, []);

  const handleFrameError = useCallback(
    (error: unknown, failures: number) => {
      log.warn(`截图失败 (${failures}/${MAX_CONSECUTIVE_FAILURES}):`, error);
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        setCaptureFailed(true);
        setIsStreaming(false);
      }
    },
    [setIsStreaming],
  );

  useScreenshotStream(
    instanceId,
    connected && isStreaming && screenshotPanelExpanded && isPanelVisible,
    getFrameInterval(screenshotFrameRate),
    captureFrame,
    displayFrame,
    handleFrameError,
  );

  const toggleStreaming = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      if (!instanceId || !connected) return;
      if (!isStreaming) {
        if (!screenshotPanelExpanded) setScreenshotPanelExpanded(true);
        setCaptureFailed(false);
      }
      setIsStreaming(!isStreaming);
    },
    [
      instanceId,
      connected,
      isStreaming,
      screenshotPanelExpanded,
      setScreenshotPanelExpanded,
      setIsStreaming,
    ],
  );

  useEffect(() => {
    setScreenshotUrl(null);
    setCaptureFailed(false);
    return () => {
      connectionVersion.current++;
    };
  }, [instanceId, connected]);

  const isResourceLoaded = instanceResourceLoaded[instanceId];
  // 当设备已连接且资源已加载时自动折叠（与连接设置面板行为一致）
  useEffect(() => {
    if (connectionStatus === 'Connected' && isResourceLoaded) {
      setScreenshotPanelExpanded(false);
    }
  }, [connectionStatus, isResourceLoaded, setScreenshotPanelExpanded]);

  // Opening the panel or reconnecting resumes it; switching tabs preserves
  // an explicit pause on the destination instance.
  const previousInstance = useRef(instanceId);
  useEffect(() => {
    const switched = previousInstance.current !== instanceId;
    previousInstance.current = instanceId;
    const saved = useAppStore.getState().instanceScreenshotStreaming[instanceId];
    const resume =
      connected && screenshotPanelExpanded && isPanelVisible && (!switched || saved !== false);
    setIsStreaming(resume);
    if (resume) setCaptureFailed(false);
  }, [instanceId, connected, screenshotPanelExpanded, isPanelVisible, setIsStreaming]);

  // 保存截图
  const saveScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;

    try {
      // 创建下载链接
      const link = document.createElement('a');
      link.href = screenshotUrl;
      link.download = `screenshot_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      log.warn('保存截图失败:', err);
    }
  }, [screenshotUrl]);

  // 复制截图到剪贴板
  const copyScreenshot = useCallback(async () => {
    if (!screenshotUrl) return;

    try {
      const response = await fetch(screenshotUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (err) {
      log.warn('复制截图失败:', err);
    }
  }, [screenshotUrl]);

  // 强制刷新截图
  const forceRefresh = useCallback(async () => {
    if (!instanceId) return;

    try {
      const imageData = await captureFrame();
      if (imageData) {
        setScreenshotUrl(imageData);
        setCaptureFailed(false);
      }
    } catch (err) {
      log.warn('强制刷新失败:', err);
    }
  }, [instanceId, captureFrame]);

  // 断开连接（销毁实例）
  const disconnect = useCallback(async () => {
    if (!instanceId) return;

    try {
      await maaService.destroyInstance(instanceId);
      useAppStore.getState().setInstanceConnectionStatus(instanceId, 'Disconnected');
      useAppStore.getState().setInstanceResourceLoaded(instanceId, false);
      setScreenshotUrl(null);
      setIsStreaming(false);
    } catch (err) {
      log.warn('断开连接失败:', err);
    }
  }, [instanceId, setIsStreaming]);

  // 全屏模态框中点击图片 → 向设备发送点击
  const handleFullscreenClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (!instanceId || connectionStatus !== 'Connected') return;

      const img = fullscreenImgRef.current;
      if (!img) return;

      const rect = img.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      if (naturalW === 0 || naturalH === 0) return;

      const x = Math.round((clickX / rect.width) * naturalW);
      const y = Math.round((clickY / rect.height) * naturalH);

      maaService.postClick(instanceId, x, y).catch((err) => {
        log.warn('点击失败:', err);
      });
    },
    [instanceId, connectionStatus],
  );

  // 右键菜单处理
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const isConnected = connectionStatus === 'Connected';

      const menuItems: MenuItem[] = [
        {
          id: 'stream',
          label: isStreaming ? t('contextMenu.stopStream') : t('contextMenu.startStream'),
          icon: isStreaming ? Pause : Play,
          disabled: !instanceId || !isConnected,
          onClick: () => toggleStreaming(),
        },
        {
          id: 'refresh',
          label: t('contextMenu.forceRefresh'),
          icon: RefreshCw,
          disabled: !instanceId || !isConnected,
          onClick: forceRefresh,
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'fullscreen',
          label: t('contextMenu.fullscreen'),
          icon: Maximize2,
          disabled: !screenshotUrl,
          onClick: () => setIsFullscreen(true),
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'save',
          label: t('contextMenu.saveScreenshot'),
          icon: Download,
          disabled: !screenshotUrl,
          onClick: saveScreenshot,
        },
        {
          id: 'copy',
          label: t('contextMenu.copyScreenshot'),
          icon: Copy,
          disabled: !screenshotUrl,
          onClick: copyScreenshot,
        },
        { id: 'divider-3', label: '', divider: true },
        {
          id: 'disconnect',
          label: t('contextMenu.disconnect'),
          icon: Unplug,
          disabled: !isConnected,
          danger: true,
          onClick: disconnect,
        },
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      instanceId,
      connectionStatus,
      isStreaming,
      screenshotUrl,
      toggleStreaming,
      forceRefresh,
      saveScreenshot,
      copyScreenshot,
      disconnect,
      showMenu,
    ],
  );

  return (
    <div className="bg-bg-secondary rounded-lg ring-1 ring-inset ring-border overflow-hidden">
      {/* 标题栏（可点击折叠） */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setScreenshotPanelExpanded(!screenshotPanelExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            (e.currentTarget as HTMLElement).click();
          }
        }}
        className={clsx(
          'w-full flex items-center justify-between px-3 py-2 hover:bg-bg-hover cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 outline-none',
          screenshotPanelExpanded ? 'rounded-t-lg' : 'rounded-lg',
        )}
        style={{
          transition: `background-color 150ms, border-radius 0s${screenshotPanelExpanded ? '' : ' 150ms'}`,
        }}
      >
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-text-secondary" />
          <span className="text-sm font-medium text-text-primary">{t('screenshot.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          {/* 流模式开关按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleStreaming();
            }}
            disabled={!instanceId || !connected}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !instanceId || !connected
                ? 'text-text-muted cursor-not-allowed'
                : isStreaming
                  ? 'text-success hover:bg-bg-tertiary'
                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={isStreaming ? t('screenshot.stopStream') : t('screenshot.startStream')}
          >
            {isStreaming ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>

          {/* 全屏按钮 */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            disabled={!screenshotUrl}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !screenshotUrl
                ? 'text-text-muted cursor-not-allowed'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={t('screenshot.fullscreen')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <ChevronDown
            className={clsx(
              'w-4 h-4 text-text-muted transition-transform duration-150 ease-out',
              screenshotPanelExpanded && 'rotate-180',
            )}
          />
        </div>
      </div>

      {/* 可折叠内容 - 使用 grid 动画实现平滑展开/折叠 */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: screenshotPanelExpanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden min-h-0">
          {/* 分隔线放在 overflow-hidden 内部，避免展开瞬间闪烁 */}
          <div className="border-t border-border" />
          <div className="p-3">
            {/* 截图区域 */}
            <div
              className="aspect-video bg-bg-tertiary rounded-md flex items-center justify-center overflow-hidden relative"
              onContextMenu={handleContextMenu}
            >
              {screenshotUrl ? (
                <>
                  <img
                    src={screenshotUrl}
                    alt="Screenshot"
                    className="w-full h-full object-contain rounded-md"
                  />
                  {/* 流模式指示器 */}
                  {isStreaming && (
                    <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-success/80 rounded text-white text-xs">
                      <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                      LIVE
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center gap-2 text-text-muted">
                  <Monitor className="w-10 h-10 opacity-30" />
                  {captureFailed ? (
                    <span className="text-xs text-error">{t('screenshot.streamFailed')}</span>
                  ) : (
                    <>
                      <span className="text-xs">{t('screenshot.noScreenshot')}</span>
                      <span className="text-xs text-text-muted">
                        {t('screenshot.connectFirst')}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 全屏模态框 */}
      {isFullscreen && screenshotUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-8"
          onClick={toggleFullscreen}
        >
          {/* 卡片容器 */}
          <div
            className="mxu-overlay-surface relative bg-bg-secondary rounded-xl border border-border shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onContextMenu={handleContextMenu}
          >
            {/* 卡片标题栏 */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-tertiary/50">
              <div className="flex items-center gap-2">
                <Monitor className="w-4 h-4 text-text-secondary" />
                <span className="text-sm font-medium text-text-primary">
                  {t('screenshot.title')}
                </span>
                {/* 流模式指示器 */}
                {isStreaming && (
                  <div className="flex items-center gap-1 px-2 py-0.5 bg-success/90 rounded text-white text-xs ml-2">
                    <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                    LIVE
                  </div>
                )}
              </div>
              <button
                onClick={toggleFullscreen}
                className="p-1.5 rounded-md hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
                title={t('screenshot.exitFullscreen')}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 图片内容区 */}
            <div className="p-4 pb-2 bg-bg-primary flex flex-col items-center justify-center overflow-auto">
              <img
                ref={fullscreenImgRef}
                src={screenshotUrl}
                alt="Screenshot"
                className="max-w-full max-h-[calc(90vh-100px)] object-contain rounded-md cursor-crosshair"
                onClick={handleFullscreenClick}
              />
              {connectionStatus === 'Connected' && (
                <div className="flex items-center gap-1 mt-2 text-xs text-text-muted select-none">
                  <MousePointerClick className="w-3 h-3" />
                  <span>{t('screenshot.clickHint')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}
    </div>
  );
}
