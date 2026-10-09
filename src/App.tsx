import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import {
  useAppStore,
  flushConfig,
  flushSaveConfig,
  type DownloadProgress,
} from '@/stores/appStore';
import {
  TitleBar,
  TabBar,
  TaskList,
  AddTaskPanel,
  Toolbar,
  ScreenshotPanel,
  LogsPanel,
  ConnectionPanel,
} from '@/components';
import { BackgroundOverlay } from '@/components/BackgroundOverlay';
import { isAllowedSettingsHotkey } from '@/components/FormControls';
import type { BadPathType } from '@/components';
import {
  autoLoadInterface,
  loadConfig,
  loadConfigFromStorage,
  consumeSelfSave,
  consumeConfigRecoveryNotice,
  markSelfSave,
  resolveI18nText,
  checkAndPrepareDownload,
  maaService,
  proxySettingsForUpdateDownload,
  stopInstanceTasksAndExitApp,
} from '@/services';
import type { ConfigRecoveryNotice } from '@/services';
import { clearIconDataUrlCache, loadIconAsDataUrl } from '@/services/contentResolver';
import * as wsService from '@/services/wsService';
import {
  downloadUpdate,
  getUpdateSavePath,
  consumeUpdateCompleteInfo,
  savePendingUpdateInfo,
  getPendingUpdateInfo,
  clearPendingUpdateInfo,
  isDebugVersion,
} from '@/services/updateService';
import { initTelemetry, isTelemetryBlockedByBuild } from '@/services/telemetryService';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { useShallow } from 'zustand/react/shallow';
// register/unregisterAll 在 useEffect 内动态导入，此处仅声明类型引用
// （动态导入可避免浏览器环境加载失败）
let _globalShortcutModule: typeof import('@tauri-apps/plugin-global-shortcut') | null = null;
async function getGlobalShortcut() {
  if (!_globalShortcutModule) {
    _globalShortcutModule = await import('@tauri-apps/plugin-global-shortcut');
  }
  return _globalShortcutModule;
}
import { loggers } from '@/utils/logger';
import { setBackendPort, getApiBase, apiGet } from '@/utils/backendApi';
import { getAllLogsFromBackend } from '@/utils/logStdout';
import { useMaaCallbackLogger, useMaaAgentLogger } from '@/utils/useMaaCallbackLogger';
import { getInterfaceLangKey } from '@/i18n';
import { applyTheme, resolveThemeMode, registerCustomAccent, clearCustomAccents } from '@/themes';
import { Toaster, toast } from 'sonner';
import { loadWebUIAppearance, loadWebUILayout } from '@/services/appearanceStorage';
import {
  clearPersistedRuntimeLogs,
  loadPersistedRuntimeLogs,
  mergeRuntimeLogs,
  persistRuntimeLogs,
} from '@/utils/runtimeLogPersistence';
import { getCurrentLogFileName } from '@/utils/logger';
import {
  isTauri,
  isValidWindowSize,
  setWindowTitle,
  setWindowSize,
  setWindowPosition,
  getWindowSize,
  getWindowPosition,
  focusWindow,
  showWindow,
  MIN_LEFT_PANEL_WIDTH,
} from '@/utils/windowUtils';
import { LoadingScreen } from './components/app';
import { ConnectionLostOverlay } from './components/app/ConnectionLostOverlay';
import { WebUIBetaBanner } from './components/app/WebUIBetaBanner';
import { startGlobalCallbackListener } from './components/connection/callbackCache';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ScrollText } from 'lucide-react';
import { defaultConfig, defaultWindowSize, isValidMxuConfig } from '@/types/config';

const log = loggers.app;

type LoadingState = 'loading' | 'success' | 'error';

// 页面过渡动画时长（ms）
const PAGE_TRANSITION_DURATION = 120;

const LazySettingsPage = lazy(async () => {
  const module = await import('@/components/SettingsPage');
  return { default: module.SettingsPage };
});

const LazyAutoWelcomeDialog = lazy(async () => {
  const module = await import('@/components/WelcomeDialog');
  return { default: module.AutoWelcomeDialog };
});

const LazyDashboardView = lazy(async () => {
  const module = await import('@/components/DashboardView');
  return { default: module.DashboardView };
});

const LazyInstallConfirmModal = lazy(async () => {
  const module = await import('@/components/InstallConfirmModal');
  return { default: module.InstallConfirmModal };
});

const LazyVCRedistModal = lazy(async () => {
  const module = await import('@/components/VCRedistModal');
  return { default: module.VCRedistModal };
});

const LazyOnboardingOverlay = lazy(async () => {
  const module = await import('@/components/OnboardingOverlay');
  return { default: module.OnboardingOverlay };
});

const LazyBadPathModal = lazy(async () => {
  const module = await import('@/components/BadPathModal');
  return { default: module.BadPathModal };
});

const LazyVersionWarningModal = lazy(async () => {
  const module = await import('./components/app/VersionWarningModal');
  return { default: module.VersionWarningModal };
});

function App() {
  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [versionWarning, setVersionWarning] = useState<{ current: string; minimum: string } | null>(
    null,
  );
  const [showVCRedistModal, setShowVCRedistModal] = useState(false);
  const [showBadPathModal, setShowBadPathModal] = useState(false);
  const [badPathType, setBadPathType] = useState<BadPathType>('root');
  const [backgroundImageDataUrl, setBackgroundImageDataUrl] = useState<string | undefined>(
    undefined,
  );
  const blobUrlRef = useRef<string | undefined>(undefined);

  // 页面过渡状态
  const [isSettingsExiting, setIsSettingsExiting] = useState(false);
  const [isDashboardExiting, setIsDashboardExiting] = useState(false);

  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // 启用 MAA 回调日志监听
  useMaaCallbackLogger();
  useMaaAgentLogger();

  useEffect(() => {
    void startGlobalCallbackListener().catch(() => {});
  }, []);

  const {
    setProjectInterface,
    setInterfaceTranslations,
    setBasePath,
    setDataPath,
    setBackendOS,
    setConfigPersistenceReady,
    basePath,
    importConfig,
    createInstance,
    theme,
    currentPage,
    setCurrentPage,
    projectInterface,
    interfaceTranslations,
    language,
    sidePanelExpanded,
    dashboardView,
    setDashboardView,
    setWindowSize: setWindowSizeStore,
    setWindowPosition: setWindowPositionStore,
    setUpdateInfo,
    restoreBackendStates,
    setDownloadStatus,
    setDownloadProgress,
    setDownloadSavePath,
    setJustUpdatedInfo,
    setShowInstallConfirmModal,
    showInstallConfirmModal,
    updateInfo,
    downloadStatus,
    setShowUpdateDialog,
    showAddTaskPanel,
    setShowAddTaskPanel,
    rightPanelWidth,
    rightPanelCollapsed,
    setRightPanelWidth: _setRightPanelWidth,
    setRightPanelCollapsed: _setRightPanelCollapsed,
    onboardingCompleted,
    backgroundImage,
    backgroundOpacity,
  } = useAppStore(
    useShallow((state) => ({
      setProjectInterface: state.setProjectInterface,
      setInterfaceTranslations: state.setInterfaceTranslations,
      setBasePath: state.setBasePath,
      setDataPath: state.setDataPath,
      setBackendOS: state.setBackendOS,
      setConfigPersistenceReady: state.setConfigPersistenceReady,
      basePath: state.basePath,
      importConfig: state.importConfig,
      createInstance: state.createInstance,
      theme: state.theme,
      currentPage: state.currentPage,
      setCurrentPage: state.setCurrentPage,
      projectInterface: state.projectInterface,
      interfaceTranslations: state.interfaceTranslations,
      language: state.language,
      sidePanelExpanded: state.sidePanelExpanded,
      dashboardView: state.dashboardView,
      setDashboardView: state.setDashboardView,
      setWindowSize: state.setWindowSize,
      setWindowPosition: state.setWindowPosition,
      setUpdateInfo: state.setUpdateInfo,
      restoreBackendStates: state.restoreBackendStates,
      setDownloadStatus: state.setDownloadStatus,
      setDownloadProgress: state.setDownloadProgress,
      setDownloadSavePath: state.setDownloadSavePath,
      setJustUpdatedInfo: state.setJustUpdatedInfo,
      setShowInstallConfirmModal: state.setShowInstallConfirmModal,
      showInstallConfirmModal: state.showInstallConfirmModal,
      updateInfo: state.updateInfo,
      downloadStatus: state.downloadStatus,
      setShowUpdateDialog: state.setShowUpdateDialog,
      showAddTaskPanel: state.showAddTaskPanel,
      setShowAddTaskPanel: state.setShowAddTaskPanel,
      rightPanelWidth: state.rightPanelWidth,
      rightPanelCollapsed: state.rightPanelCollapsed,
      setRightPanelWidth: state.setRightPanelWidth,
      setRightPanelCollapsed: state.setRightPanelCollapsed,
      onboardingCompleted: state.onboardingCompleted,
      backgroundImage: state.backgroundImage,
      backgroundOpacity: state.backgroundOpacity,
    })),
  );

  // 转换背景图片为 Blob URL
  useEffect(() => {
    if (!backgroundImage) {
      // 无背景图：清理旧 blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = undefined;
      }
      setBackgroundImageDataUrl(undefined);
      return;
    }

    let cancelled = false;

    const loadBackgroundImage = async () => {
      try {
        let fileData: Uint8Array;
        let ext: string;

        if (isTauri()) {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          fileData = await readFile(backgroundImage);
          ext = backgroundImage.split('.').pop()?.toLowerCase() || 'png';
        } else {
          const resp = await fetch(`${getApiBase()}/background-image`);
          if (!resp.ok) {
            setBackgroundImageDataUrl(undefined);
            return;
          }
          const buffer = await resp.arrayBuffer();
          fileData = new Uint8Array(buffer);
          const ct = resp.headers.get('content-type') || 'image/png';
          ext = ct.split('/').pop()?.split(';')[0] || 'png';
        }

        if (cancelled) return;

        const mimeMap: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          gif: 'image/gif',
        };
        const mimeType = mimeMap[ext] || 'image/png';

        const arrayBuffer = new ArrayBuffer(fileData.byteLength);
        new Uint8Array(arrayBuffer).set(fileData);
        const blob = new Blob([arrayBuffer], { type: mimeType });
        const blobUrl = URL.createObjectURL(blob);

        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = blobUrl;
        setBackgroundImageDataUrl(blobUrl);
      } catch (err) {
        if (!cancelled) {
          log.warn('Failed to load background image:', err);
          setBackgroundImageDataUrl(undefined);
        }
      }
    };

    loadBackgroundImage();

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = undefined;
      }
    };
  }, [backgroundImage]);

  // 带退出动画的设置页面关闭
  const closeSettingsWithAnimation = useCallback(() => {
    setIsSettingsExiting(true);
    setTimeout(() => {
      setCurrentPage('main');
      setIsSettingsExiting(false);
    }, PAGE_TRANSITION_DURATION);
  }, [setCurrentPage]);

  // 带退出动画的中控台关闭
  const closeDashboardWithAnimation = useCallback(() => {
    setIsDashboardExiting(true);
    setTimeout(() => {
      setDashboardView(false);
      setIsDashboardExiting(false);
    }, PAGE_TRANSITION_DURATION);
  }, [setDashboardView]);

  const isResizingRef = useRef(false);

  // 调整右侧面板宽度
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      const newWidth = document.body.clientWidth - e.clientX;
      const store = useAppStore.getState();

      if (newWidth < 160) {
        // 如果宽度小于最小宽度的一半 (160px)，折叠
        store.setRightPanelCollapsed(true);
      } else {
        // 否则展开，并更新宽度（限制在 320-最大可用宽度 之间）
        // 最大宽度 = 窗口宽度 - 左侧最小宽度 - 分隔条宽度(约4px)
        const maxWidth = Math.min(800, document.body.clientWidth - MIN_LEFT_PANEL_WIDTH - 4);
        store.setRightPanelCollapsed(false);
        const clampedWidth = Math.max(320, Math.min(maxWidth, newWidth));
        store.setRightPanelWidth(clampedWidth);
      }
    };

    const handleMouseUp = () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); // 防止选中文本
    isResizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // 允许其他组件触发同一套分隔条拖拽逻辑（例如 AddTaskPanel 顶部也可拖拽）
  useEffect(() => {
    const onExternalResizeStart = () => {
      isResizingRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    };
    document.addEventListener('mxu-resize-start', onExternalResizeStart as EventListener);
    return () =>
      document.removeEventListener('mxu-resize-start', onExternalResizeStart as EventListener);
  }, []);

  const initialized = useRef(false);
  const downloadStartedRef = useRef(false);
  const pendingAutoTasksRef = useRef(false);
  // 自动任务已分发但尚未完成启动时，也要阻止下载完成触发自动安装。
  // 否则小体积更新可能在 500ms 的任务分发延迟或连接准备期间先完成下载。
  const autoTaskLaunchPendingRef = useRef(false);
  // 尝试自动安装更新（无任务运行中时触发）
  const tryAutoInstallUpdate = useCallback(() => {
    const state = useAppStore.getState();
    if (state.downloadStatus !== 'completed') return;
    if (state.installStatus !== 'idle') return;
    if (state.autoInstallPending) return;
    if (autoTaskLaunchPendingRef.current) return;
    if (state.instances.some((i) => i.isRunning)) return;

    log.info('自动安装更新：条件满足，弹出安装');
    state.setAutoInstallPending(true);
    state.setShowInstallConfirmModal(true);
  }, []);

  // 监听任务结束 或 下载完成 后自动安装更新
  useEffect(() => {
    return useAppStore.subscribe((state, prev) => {
      const wasRunning = prev.instances.some((i) => i.isRunning);
      const nowRunning = state.instances.some((i) => i.isRunning);
      const downloadJustCompleted =
        prev.downloadStatus !== 'completed' && state.downloadStatus === 'completed';
      if ((wasRunning && !nowRunning) || downloadJustCompleted) {
        tryAutoInstallUpdate();
      }
    });
  }, [tryAutoInstallUpdate]);

  // 自动下载函数
  const startAutoDownload = useCallback(
    async (updateResult: NonNullable<Awaited<ReturnType<typeof checkAndPrepareDownload>>>) => {
      if (!updateResult.downloadUrl || downloadStartedRef.current) return;

      downloadStartedRef.current = true;
      setDownloadStatus('downloading');
      setDownloadProgress({
        downloadedSize: 0,
        totalSize: updateResult.fileSize || 0,
        speed: 0,
        progress: 0,
      });

      try {
        const savePath = await getUpdateSavePath(updateResult.filename);
        setDownloadSavePath(savePath);

        const appState = useAppStore.getState();
        const proxyForDownload = proxySettingsForUpdateDownload(
          updateResult.downloadSource,
          appState.proxySettings,
          appState.mirrorChyanSettings.cdk,
        );

        const result = await downloadUpdate({
          url: updateResult.downloadUrl,
          savePath,
          totalSize: updateResult.fileSize,
          proxySettings: proxyForDownload,
          onProgress: (progress: DownloadProgress) => {
            setDownloadProgress(progress);
          },
        });

        if (result.success) {
          // 使用实际保存路径（可能与请求路径不同，如果从 302 重定向检测到正确文件名）
          setDownloadSavePath(result.actualSavePath);
          setDownloadStatus('completed');
          log.info('更新下载完成');

          // 保存待安装更新信息，以便下次启动时自动安装
          savePendingUpdateInfo({
            versionName: updateResult.versionName,
            releaseNote: updateResult.releaseNote,
            channel: updateResult.channel,
            downloadSavePath: result.actualSavePath,
            fileSize: updateResult.fileSize,
            updateType: updateResult.updateType,
            downloadSource: updateResult.downloadSource,
            timestamp: Date.now(),
          });

          // 尝试自动安装更新
          tryAutoInstallUpdate();
        } else {
          setDownloadStatus('failed');
          // 下载失败时重置标志，允许后续重新下载（如填入 CDK 后切换下载源）
          downloadStartedRef.current = false;
          log.warn('更新下载失败');
        }
      } catch (error) {
        log.error('更新下载出错:', error);
        setDownloadStatus('failed');
        // 下载出错时也重置标志
        downloadStartedRef.current = false;
      }
    },
    [setDownloadStatus, setDownloadProgress, setDownloadSavePath, tryAutoInstallUpdate],
  );

  // 设置窗口标题（根据 ProjectInterface V2 协议）
  useEffect(() => {
    if (!projectInterface) return;

    const langKey = getInterfaceLangKey(language);
    const translations = interfaceTranslations[langKey];

    // 优先使用 title 字段（支持国际化），否则使用 name + version
    // 注意：协议规定 title 默认为 name + version，不是 label + version
    let title: string;
    if (projectInterface.title) {
      title = resolveI18nText(projectInterface.title, translations);
    } else {
      const version = projectInterface.version;
      title = version ? `${projectInterface.name} ${version}` : projectInterface.name;
    }

    setWindowTitle(title);

    // 同时更新托盘 tooltip（只显示项目名称）
    if (isTauri()) {
      invoke('update_tray_tooltip', { tooltip: projectInterface.name }).catch((err) => {
        log.warn('设置托盘 tooltip 失败:', err);
      });
    }
  }, [projectInterface, language, interfaceTranslations]);

  // 设置窗口图标（根据 ProjectInterface V2 协议）
  useEffect(() => {
    if (!projectInterface?.icon) return;

    const langKey = getInterfaceLangKey(language);
    const translations = interfaceTranslations[langKey];

    // icon 字段支持国际化
    const iconPath = resolveI18nText(projectInterface.icon, translations);
    if (!iconPath) return;

    if (isTauri()) {
      // Tauri 环境：设置窗口图标和托盘图标
      const fullIconPath = `${basePath}/${iconPath}`;

      const setIcon = async () => {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const currentWindow = getCurrentWindow();
          await currentWindow.setIcon(fullIconPath);
          log.info('窗口图标已设置:', fullIconPath);
        } catch (err) {
          log.warn('设置窗口图标失败:', err);
        }

        try {
          await invoke('update_tray_icon', { iconPath: fullIconPath });
        } catch (err) {
          log.warn('设置托盘图标失败:', err);
        }
      };

      setIcon();
    } else {
      // 浏览器环境：更新 <link rel="icon"> favicon
      loadIconAsDataUrl(projectInterface.icon, basePath, translations).then((url) => {
        if (!url) return;
        let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
        if (!link) {
          link = document.createElement('link');
          link.rel = 'icon';
          document.head.appendChild(link);
        }
        link.href = url;
      });
    }
  }, [projectInterface, language, interfaceTranslations, basePath]);

  // 加载 interface.json 和配置文件
  const loadInterface = async () => {
    // 加载期间先禁止自动持久化，避免空状态误写回配置文件
    setConfigPersistenceReady(false);
    setLoadingState('loading');
    setErrorMessage('');

    try {
      log.info('加载 interface.json...');
      const result = await autoLoadInterface();
      setProjectInterface(result.interface);
      // 资源目录可能被换掉：先失效图标 data URL 缓存，避免复用旧资源包的图标
      clearIconDataUrlCache();
      setBasePath(result.basePath);
      setDataPath(result.dataPath);
      // 缓存后端真实 OS/架构，供控制器过滤、更新资产匹配、useCmd 开关等消费
      if (result.backendOS) setBackendOS(result.backendOS, result.backendArch ?? '');

      // 设置翻译
      for (const [lang, trans] of Object.entries(result.translations)) {
        setInterfaceTranslations(lang, trans);
      }

      // 加载用户配置（mxu-{项目名}.json）- 从数据目录加载
      const projectName = result.interface.name;
      let config = await loadConfig(result.dataPath, projectName);

      // loadConfig 已保证返回结构有效，这里再兜一层，避免任何路径把非法值传到下游
      if (!isValidMxuConfig(config)) {
        log.error('配置结构异常，回退到默认配置');
        config = defaultConfig;
      }

      // 配置损坏自愈提示。Rust 侧在启动早期就会先尝试修复磁盘上的文件，
      // 前端读盘时也可能自行触发，两侧的通知都取走后只提示一次。
      const tsRecovery = consumeConfigRecoveryNotice();
      let backendRecovery: ConfigRecoveryNotice | null = null;
      if (isTauri()) {
        try {
          backendRecovery = await invoke<ConfigRecoveryNotice | null>(
            'take_config_recovery_notice',
          );
        } catch (err) {
          log.debug('获取后端配置自愈通知失败:', err);
        }
      }
      const recovery = tsRecovery ?? backendRecovery;
      if (recovery?.kind === 'restored') {
        toast.warning(t('config.recoveredFromBackup', { time: recovery.backupTime ?? '' }));
      } else if (recovery?.kind === 'reset') {
        toast.error(t('config.recoveryFailed'));
      }

      // 浏览器环境下，如果没有从 public 目录加载到配置，尝试从 localStorage 加载
      if (config.instances.length === 0) {
        const storageConfig = loadConfigFromStorage(projectName);
        if (storageConfig && storageConfig.instances.length > 0) {
          config = storageConfig;
        }
      }

      // 应用配置
      if (config.instances.length > 0) {
        importConfig(config);
      }

      // 初始化匿名遥测（仅当 interface 声明了 telemetry.sentry.dsn 且非调试 / 开发版本）
      // 即便用户当前关闭，也传入配置以便后端缓存，用户在设置中开启时无需重启
      const sentryCfg = result.interface.telemetry?.sentry;
      if (sentryCfg?.dsn && !isTelemetryBlockedByBuild(result.interface)) {
        const mxuVersion = typeof __MXU_VERSION__ !== 'undefined' ? __MXU_VERSION__ : '0.0.0';
        const appName = result.interface.name;
        const appVersion = result.interface.version ?? '0.0.0';
        const channel = config.settings.mirrorChyan?.channel ?? 'production';
        void initTelemetry({
          dsn: sentryCfg.dsn,
          enabled: config.settings.helpImproveSoftware ?? true,
          release: `MXU@${mxuVersion}+${appName}@${appVersion}`,
          environment: sentryCfg.environment ?? channel,
          tracing: sentryCfg.tracing ?? true,
          tracesSampleRate: sentryCfg.traces_sample_rate ?? 1.0,
          failureAttachmentsSampleRate: sentryCfg.failure_attachments_sample_rate ?? 1.0,
          appName,
          appVersion,
          mxuVersion,
        });
      }

      // 应用保存的窗口大小和位置
      if (config.settings.windowSize) {
        const { width, height } = config.settings.windowSize;
        if (isValidWindowSize(width, height)) {
          await setWindowSize(width, height);
        } else {
          log.warn('保存的窗口大小无效，已回退默认值:', { width, height });
          setWindowSizeStore(defaultWindowSize);
          await setWindowSize(defaultWindowSize.width, defaultWindowSize.height);
        }
      }
      if (config.settings.windowPosition && isTauri()) {
        const { x, y } = config.settings.windowPosition;
        // 先检查位置是否在可见显示器范围内
        try {
          const { getCurrentWindow, availableMonitors } = await import('@tauri-apps/api/window');
          const monitors = await availableMonitors();
          // monitor.position/size 与保存的坐标均为物理像素，直接比较
          // 允许窗口左上角稍微超出屏幕边缘（标题栏仍可见）
          const isOnScreen = monitors.some((m) => {
            const mx = m.position.x;
            const my = m.position.y;
            const mw = m.size.width;
            const mh = m.size.height;
            return x >= mx - 100 && x < mx + mw && y >= my - 50 && y < my + mh;
          });
          if (isOnScreen) {
            await setWindowPosition(x, y);
          } else {
            await getCurrentWindow().center();
            setWindowPositionStore(undefined);
          }
        } catch (err) {
          log.warn('检查窗口位置失败，居中显示:', err);
          try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().center();
          } catch {
            // 浏览器环境忽略
          }
        }
      }

      // 主题已应用、窗口已定位，检查是否为自启动；自启动时默认保持隐藏
      let isAutoStart = false;
      if (isTauri()) {
        try {
          isAutoStart = await invoke<boolean>('is_autostart');
          if (isAutoStart) {
            useAppStore.getState().setIsAutoStartMode(true);
          }
        } catch (err) {
          log.warn('检查开机自启动状态失败:', err);
        }
      }

      if (!isAutoStart) {
        showWindow();
      } else if (isTauri()) {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().hide();
          log.info('自启动模式：启动时保持主窗口隐藏');
        } catch (err) {
          log.warn('自启动时隐藏主窗口失败:', err);
        }
      }

      // 从后端恢复 MAA 运行时状态（连接状态、资源加载状态、设备缓存等）
      try {
        const backendStates = await maaService.getAllStates();
        if (backendStates) {
          restoreBackendStates(backendStates);
          log.info('已恢复后端状态:', Object.keys(backendStates.instances).length, '个实例');
        }
      } catch (err) {
        log.warn('恢复后端状态失败:', err);
      }

      // 从后端恢复运行日志（跨页面刷新持久化）
      try {
        const backendLogs = await getAllLogsFromBackend();
        const store = useAppStore.getState();
        const restoredBackendLogs: Record<string, import('@/stores/types').LogEntry[]> = {};
        for (const [instanceId, entries] of Object.entries(backendLogs || {})) {
          restoredBackendLogs[instanceId] = entries.map((e) => ({
            id: e.id,
            timestamp: new Date(e.timestamp),
            type: e.type as import('@/stores/types').LogType,
            message: e.message,
            html: e.html,
          }));
        }

        if (store.autoClearLogsOnLaunch) {
          if (isTauri()) {
            try {
              const deleted = await invoke<number>('clear_log_files', {
                excludeFileName: getCurrentLogFileName(),
              });
              log.info('Auto-cleared log files and debug artifacts on launch:', deleted);
            } catch {
              // ignore cleanup errors
            }
          }
          clearPersistedRuntimeLogs();
          log.info('Restored runtime logs: skipped (auto-clear on launch enabled)');
        } else {
          const restoredPersistentLogs = loadPersistedRuntimeLogs(store.maxLogsPerInstance);
          const mergedLogs = mergeRuntimeLogs(
            store.maxLogsPerInstance,
            store.instanceLogs,
            restoredBackendLogs,
            restoredPersistentLogs,
          );
          if (Object.keys(mergedLogs).length > 0) {
            useAppStore.setState({
              instanceLogs: mergedLogs,
            });
            persistRuntimeLogs(mergedLogs, store.maxLogsPerInstance);
            log.info('Restored runtime logs', Object.keys(mergedLogs).length, 'instances');
          }
        }
      } catch (err) {
        log.warn('恢复运行日志失败:', err);
      }

      // 检查 MaaFramework 版本兼容性
      // 注意：即使完整库加载失败（旧版本缺少某些函数），版本检查仍应工作
      try {
        // 尝试初始化，即使失败也会设置 lib_dir
        try {
          await maaService.init();
        } catch (initErr) {
          log.warn('MaaFramework 初始化失败（可能是版本过低）:', initErr);
        }

        // 版本检查使用独立的版本获取，不依赖完整库加载
        const versionCheck = await maaService.checkVersion();
        if (!versionCheck.is_compatible) {
          log.warn(
            'MaaFramework 版本过低:',
            versionCheck.current,
            '< 最低要求:',
            versionCheck.minimum,
          );
          setVersionWarning({
            current: versionCheck.current,
            minimum: versionCheck.minimum,
          });
        }
      } catch (err) {
        log.warn('版本检查失败:', err);
      }

      log.info('加载完成, 项目:', result.interface.name);
      setLoadingState('success');
      // 完成配置加载后，允许后续状态变更自动保存
      setConfigPersistenceReady(true);

      // 浏览器环境：设置后端直连端口并建立 WebSocket 连接
      if (!isTauri() && result.webServerPort) {
        setBackendPort(result.webServerPort);
        wsService.setServerPort(result.webServerPort);
        wsService.connect();
      } else if (!isTauri()) {
        wsService.connect();
      }

      // 检查是否缺少 VC++ 运行库
      checkVCRedistMissing();

      // 预设初始化：首次启动（或老用户升级）时，自动为每个预设创建一个 tab
      setTimeout(() => {
        const storeState = useAppStore.getState();
        const currentInstances = storeState.instances;
        const pi = storeState.projectInterface;
        const presets = pi?.preset;

        if (presets && presets.length > 0 && !storeState.presetInitialized) {
          // 有预设且尚未完成预设初始化 → 为每个预设创建一个 tab 并应用
          const langKey = getInterfaceLangKey(storeState.language);
          let firstInstanceId: string | null = null;
          for (const preset of presets) {
            const label = storeState.resolveI18nText(preset.label, langKey) || preset.name;
            const instanceId = storeState.createInstance(label, true);
            storeState.applyPreset(instanceId, preset.name);
            if (!firstInstanceId) firstInstanceId = instanceId;
          }
          // 创建完成后选中第一个预设 tab
          if (firstInstanceId) storeState.setActiveInstance(firstInstanceId);
          storeState.setPresetInitialized(true);
        } else if (currentInstances.length === 0) {
          // 无预设或已初始化且无实例 → 创建默认实例
          createInstance(t('instance.defaultName'));
        }
      }, 0);

      // 检查是否为开机自启动，若配置了自动执行的实例则激活并启动任务
      // 或者手动启动时，如果勾选了"手动启动时也自动执行"，也自动执行
      // 任务分发延迟到更新检查之后；仅检测到已下载待安装包时阻塞任务执行。
      // 新版本下载在后台进行，不影响本次任务启动。
      let autoStartTasksPending = false;
      let isAutoRunOnLaunchMode = false;
      if (isTauri()) {
        try {
          const isAutoStart = await invoke<boolean>('is_autostart');
          if (isAutoStart) {
            useAppStore.getState().setIsAutoStartMode(true);
          }

          // 检查 -i/--instance 命令行参数指定的实例（仅 autostart 模式生效）
          let cliInstanceId: string | undefined;
          if (isAutoStart) {
            const startInstance = await invoke<string | null>('get_start_instance');
            if (startInstance) {
              const matched = useAppStore
                .getState()
                .instances.find((i) => i.name === startInstance);
              if (matched) {
                log.info('命令行 --instance 参数：匹配实例:', startInstance);
                cliInstanceId = matched.id;
              } else {
                log.warn('命令行 --instance 参数：未找到名为', startInstance, '的实例');
              }
            }
          }

          const { autoStartInstanceId, autoRunOnLaunch } = useAppStore.getState();
          // 命令行指定的实例优先，否则使用配置中的自动执行实例
          const targetInstanceId = cliInstanceId || autoStartInstanceId;
          // 开机自启动 或 手动启动且勾选了"手动启动时也自动执行"
          const shouldAutoRun = isAutoStart || autoRunOnLaunch;
          if (shouldAutoRun && targetInstanceId) {
            const targetInstance = useAppStore
              .getState()
              .instances.find((i) => i.id === targetInstanceId);
            if (targetInstance) {
              const source = isAutoStart ? '开机自启动' : '手动启动';
              log.info(`${source}：激活配置并启动任务:`, targetInstance.name);
              if (!isAutoStart) {
                isAutoRunOnLaunchMode = true;
              }
              useAppStore.getState().setActiveInstance(targetInstanceId);

              // 检查 -q/--quit-after-run 参数：任务完成后关闭自身
              const shouldQuit = await invoke<boolean>('has_quit_after_run_flag');
              if (shouldQuit) {
                log.info('命令行 --quit-after-run 参数：任务完成后将关闭自身');
                const unsub = useAppStore.subscribe(
                  (state) => state.instances.find((i) => i.id === targetInstanceId)?.isRunning,
                  (isRunning, prevIsRunning) => {
                    if (prevIsRunning && !isRunning) {
                      log.info('自动执行任务完成，关闭自身');
                      unsub();
                      import('@tauri-apps/plugin-process').then(({ exit }) => exit(0));
                    }
                  },
                );
              }

              autoStartTasksPending = true;
            } else {
              log.warn('自动执行：目标实例不存在，跳过自动执行');
            }
          }
        } catch (err) {
          log.warn('检查开机自启动状态失败:', err);
        }
      }

      const dispatchPendingAutoStartTasks = () => {
        if (!autoStartTasksPending) return;
        autoStartTasksPending = false;
        autoTaskLaunchPendingRef.current = true;
        setTimeout(() => {
          document.dispatchEvent(
            new CustomEvent('mxu-start-tasks', {
              detail: {
                source: 'autostart',
                onSettled: () => {
                  autoTaskLaunchPendingRef.current = false;
                  // 启动失败时任务不会产生 running -> idle 状态变化，需要在这里补一次安装检查；
                  // 启动成功时仍处于运行态，本次检查会直接返回，并在任务结束后再次触发。
                  tryAutoInstallUpdate();
                },
              },
            }),
          );
        }, 500);
      };

      // 检查是否刚更新完成（重启后）
      const isAutoStartModeNow = useAppStore.getState().isAutoStartMode;
      const updateCompleteInfo = consumeUpdateCompleteInfo();
      if (updateCompleteInfo) {
        const currentVersionNow = result.interface.version || '';

        const showUpdateCompletedUI = () => {
          focusWindow();
          setJustUpdatedInfo({
            previousVersion: updateCompleteInfo.previousVersion,
            newVersion: updateCompleteInfo.newVersion,
            releaseNote: updateCompleteInfo.releaseNote,
            channel: updateCompleteInfo.channel,
          });
          setShowInstallConfirmModal(true);
        };

        // 如果需要验证版本（exe/dmg 安装场景）
        if (updateCompleteInfo.requireVersionCheck) {
          log.info(
            `检测到待验证版本更新: 目标=${updateCompleteInfo.newVersion}, 当前=${currentVersionNow}`,
          );

          // 比较版本：如果当前版本已经是目标版本，视为安装完成
          const normalizeVersion = (v: string) => v.replace(/^v/i, '').toLowerCase();
          if (
            normalizeVersion(currentVersionNow) === normalizeVersion(updateCompleteInfo.newVersion)
          ) {
            log.info('版本已更新到目标版本');
            if (isAutoStartModeNow) {
              // 无人值守：跳过弹窗，继续检查是否有更新版本
              log.info('自启动模式，跳过更新完成弹窗');
            } else {
              showUpdateCompletedUI();
              if (isAutoRunOnLaunchMode) {
                dispatchPendingAutoStartTasks();
              }
              return;
            }
          } else {
            log.info('版本未更新，继续正常流程');
          }
        } else {
          // 直接显示更新完成弹窗（zip 等自动安装场景）
          log.info('检测到刚更新完成:', updateCompleteInfo.newVersion);
          clearPendingUpdateInfo();
          if (isAutoStartModeNow) {
            log.info('自启动模式，跳过更新完成弹窗');
          } else {
            showUpdateCompletedUI();
            if (isAutoRunOnLaunchMode) {
              dispatchPendingAutoStartTasks();
            }
            return;
          }
        }
      }

      // 检查是否有待安装的更新（上次下载完成但未安装）
      // 调试版本跳过待安装更新检测
      if (!isDebugVersion(result.interface.version)) {
        const pendingUpdate = await getPendingUpdateInfo();
        if (pendingUpdate) {
          log.info('检测到待安装更新:', pendingUpdate.versionName);
          // 恢复更新状态
          setUpdateInfo({
            hasUpdate: true,
            versionName: pendingUpdate.versionName,
            releaseNote: pendingUpdate.releaseNote,
            channel: pendingUpdate.channel,
            fileSize: pendingUpdate.fileSize,
            updateType: pendingUpdate.updateType,
            downloadSource: pendingUpdate.downloadSource,
          });
          setDownloadSavePath(pendingUpdate.downloadSavePath);
          // 先设置 installStatus，再设置 downloadStatus，
          // 避免 subscribe 在 installStatus 还是 idle 时触发 tryAutoInstallUpdate 造成双发
          useAppStore.getState().setInstallStatus('installing');
          setDownloadStatus('completed');
          setShowInstallConfirmModal(true);
          // 安装后会重启，重启后任务在新版本上执行
          // autoRunOnLaunch：弹窗关闭后如果用户取消安装，也需要分发任务
          if (autoStartTasksPending) {
            autoStartTasksPending = false;
            pendingAutoTasksRef.current = true;
          }
          return;
        }
      }

      // 自动检查更新并下载（调试版本跳过，MXU 开发模式跳过）
      if (result.interface.mirrorchyan_rid && result.interface.version) {
        if (import.meta.env.DEV) {
          log.info('MXU 开发模式，跳过自动更新检查');
        } else if (isDebugVersion(result.interface.version)) {
          log.info(`非正式版本 (${result.interface.version})，跳过自动更新检查`);
        } else {
          const appState = useAppStore.getState();
          try {
            const updateResult = await checkAndPrepareDownload({
              resourceId: result.interface.mirrorchyan_rid,
              currentVersion: result.interface.version,
              cdk: appState.mirrorChyanSettings.cdk || undefined,
              channel: appState.mirrorChyanSettings.channel,
              userAgent: 'MXU',
              githubUrl: result.interface.github,
              githubPat: appState.mirrorChyanSettings.githubPat || undefined,
              proxyUrl: appState.proxySettings?.url,
              projectName: result.interface.name,
            });
            if (updateResult) {
              setUpdateInfo(updateResult);
              if (updateResult.hasUpdate) {
                log.info(`发现新版本: ${updateResult.versionName}`);
                useAppStore.getState().setShowUpdateDialog(true);
                if (updateResult.downloadUrl) {
                  startAutoDownload(updateResult);
                }
              } else if (updateResult.errorCode) {
                log.warn(`更新检查返回错误: code=${updateResult.errorCode}`);
                useAppStore.getState().setShowUpdateDialog(true);
              }
            }
          } catch (err) {
            log.warn('自动检查更新失败:', err);
          }
        }
      }

      // 更新检查完毕，分发挂起的自动任务。
      // 自动下载在后台进行，不阻塞本次任务；仅上面的待安装包分支会保留挂起状态。
      dispatchPendingAutoStartTasks();
    } catch (err) {
      log.error('加载 interface.json 失败:', err);
      setErrorMessage(err instanceof Error ? err.message : '加载失败');
      setLoadingState('error');
      // 加载失败时保持禁用自动持久化，防止错误状态覆盖用户配置
      setConfigPersistenceReady(false);
      // 加载失败也要显示窗口（展示错误界面）
      showWindow();
    }
  };

  // 初始化
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // WebUI 模式从 localStorage 加载独立的外观 & 布局偏好
    if (!isTauri()) {
      const localAppearance = loadWebUIAppearance();
      if (localAppearance) {
        clearCustomAccents();
        localAppearance.customAccents?.forEach((a) => registerCustomAccent(a));
        useAppStore.setState({
          theme: localAppearance.theme,
          accentColor: localAppearance.accentColor,
          language: localAppearance.language,
          backgroundImage: localAppearance.backgroundImage,
          backgroundOpacity: localAppearance.backgroundOpacity,
          customAccents: localAppearance.customAccents || [],
        });
      }
      const localLayout = loadWebUILayout();
      if (localLayout) {
        useAppStore.setState({
          sidePanelExpanded: localLayout.sidePanelExpanded,
          rightPanelWidth: localLayout.rightPanelWidth,
          rightPanelCollapsed: localLayout.rightPanelCollapsed,
          addTaskPanelHeight: localLayout.addTaskPanelHeight,
          connectionPanelExpanded: localLayout.connectionPanelExpanded,
          screenshotPanelExpanded: localLayout.screenshotPanelExpanded,
          showOptionPreview: localLayout.showOptionPreview,
          screenshotFrameRate: localLayout.screenshotFrameRate,
          ...(localLayout.windowSize && { windowSize: localLayout.windowSize }),
          ...(localLayout.windowPosition && { windowPosition: localLayout.windowPosition }),
        });
      }
    }
    const { theme: initialTheme, accentColor: initialAccent } = useAppStore.getState();
    const mode = resolveThemeMode(initialTheme);
    applyTheme(mode, initialAccent);

    // 先检查程序路径，有问题就弹窗不继续加载
    const initApp = async () => {
      if (isTauri()) {
        try {
          const pathIssue = await invoke<string | null>('check_exe_path');
          if (pathIssue) {
            log.warn('检测到程序路径问题:', pathIssue);
            setBadPathType(pathIssue as BadPathType);
            setShowBadPathModal(true);
            // 路径有问题就不继续加载了，但仍需显示窗口以呈现错误界面
            showWindow();
            return;
          }
        } catch (err) {
          log.warn('检查程序路径失败:', err);
        }
      }

      // 路径没问题，继续加载 interface
      loadInterface();
    };

    initApp();
  }, []);

  // beforeunload：刷新/关闭前强制保存一次配置，防止防抖窗口内的修改丢失
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isTauri()) {
        // Tauri 环境：取消防抖、立即同步触发保存
        flushSaveConfig();
      } else {
        // 浏览器环境：优先用 sendBeacon，失败时回退 keepalive fetch
        const config = flushConfig();
        if (!config) return;
        const payload = JSON.stringify(config);
        const url = `${getApiBase()}/config`;
        const blob = new Blob([payload], { type: 'application/json' });
        markSelfSave();
        const sent = navigator.sendBeacon?.(url, blob) ?? false;
        if (!sent) {
          void fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            keepalive: true,
          }).catch(() => {
            // 页面即将关闭，此处无法可靠恢复，静默忽略即可
          });
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 监听 config-changed 事件（其他客户端修改配置后重新拉取）
  // Tauri 桌面端通过 Tauri 事件接收，浏览器 WebUI 通过 WebSocket 接收
  useEffect(() => {
    let cleanup: (() => void) | undefined;

    const handleConfigChanged = async () => {
      if (consumeSelfSave()) {
        log.debug('跳过本客户端自身触发的 config-changed');
        return;
      }
      log.info('收到 config-changed（来自其他客户端），重新拉取配置...');
      try {
        if (isTauri()) {
          const pi = useAppStore.getState().projectInterface;
          const dataPath = useAppStore.getState().dataPath;
          const config = await loadConfig(dataPath, pi?.name);
          if (config) {
            useAppStore.getState().importConfig(config);
            log.info('配置已从磁盘重新同步');
          }
        } else {
          const config = await apiGet<import('@/types/config').MxuConfig>('/config');
          if (config) {
            useAppStore.getState().importConfig(config);
            log.info('配置已从后端重新同步');
          }
        }
        // importConfig 会重置 isRunning，需立即从后端刷新真实状态
        const backendStates = await maaService.getAllStates();
        if (backendStates) {
          useAppStore.getState().restoreBackendStates(backendStates);
        }
      } catch (err) {
        log.warn('重新拉取配置失败:', err);
      }
    };

    if (isTauri()) {
      let cancelled = false;
      let unlisten: (() => void) | null = null;
      void (async () => {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          const dispose = await listen('config-changed-external', handleConfigChanged);
          if (cancelled) {
            dispose();
            return;
          }
          unlisten = dispose;
        } catch (err) {
          log.warn('注册 config-changed 监听失败:', err);
        }
      })();
      cleanup = () => {
        cancelled = true;
        unlisten?.();
      };
    } else {
      const unlisten = wsService.onConfigChanged(handleConfigChanged);
      cleanup = unlisten;
    }

    return () => cleanup?.();
  }, []);

  // 监听 state-changed 事件（后端状态变更后通知刷新，包含任务进度更新）
  // Tauri 桌面端通过 Tauri 事件接收，浏览器 WebUI 通过 WebSocket 接收
  // 后端是单一真相来源，所有 kind 统一触发 getAllStates + restoreBackendStates
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    // 追踪防抖窗口内是否收到过任务相关事件（需要同步 isRunning 的事件）
    let pendingTaskKind = false;
    let cleanup: (() => void) | undefined;

    const isTaskKind = (kind: string) =>
      kind === 'task-started' ||
      kind === 'task-stopped' ||
      kind === 'task-progress' ||
      kind === 'tasks-completed';

    const handleStateChanged = (instanceId: string, kind: string) => {
      if (isTaskKind(kind)) pendingTaskKind = true;
      if (kind === 'tasks-completed') {
        useAppStore.getState().clearAllTaskRunOnce(instanceId);
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      const shouldSyncRunning = pendingTaskKind;
      debounceTimer = setTimeout(async () => {
        pendingTaskKind = false;
        try {
          const backendStates = await maaService.getAllStates();
          if (backendStates) {
            // 任务相关事件需要同步 isRunning（跨端同步 + 任务自然完成）
            // 其他事件（connected/resource-loading）跳过，避免竞态覆盖
            // 前端已设置的 isRunning（start 流程中前端先于后端设置状态）
            restoreBackendStates(backendStates, {
              skipRunningState: !shouldSyncRunning,
            });
            log.debug('收到 state-changed，已刷新运行时状态, kind:', kind);
          }
        } catch (err) {
          log.warn('state-changed 后刷新状态失败:', err);
        }
      }, 300);
    };

    if (isTauri()) {
      let cancelled = false;
      let unlisten: (() => void) | null = null;
      void (async () => {
        try {
          const { listen } = await import('@tauri-apps/api/event');
          const dispose = await listen<{ instance_id: string; kind: string }>(
            'state-changed',
            (event) => handleStateChanged(event.payload.instance_id, event.payload.kind),
          );
          if (cancelled) {
            dispose();
            return;
          }
          unlisten = dispose;
        } catch (err) {
          log.warn('注册 state-changed 监听失败:', err);
        }
      })();
      cleanup = () => {
        cancelled = true;
        unlisten?.();
      };
    } else {
      const unlisten = wsService.onStateChanged(handleStateChanged);
      cleanup = unlisten;
    }

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      cleanup?.();
    };
  }, [restoreBackendStates]);

  // 检查 VC++ 运行库缺失（在加载完成后检查）
  const checkVCRedistMissing = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const missing = await invoke<boolean>('check_vcredist_missing');
      if (missing) {
        log.warn('检测到 VC++ 运行库缺失');
        setShowVCRedistModal(true);
      }
    } catch (err) {
      log.warn('检查 VC++ 运行库缺失失败:', err);
    }
  }, []);

  // 主题变化时更新 DOM
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemThemeChange = (e: MediaQueryListEvent) => {
      if (theme === 'system') {
        const mode = e.matches ? 'dark' : 'light';
        const { accentColor } = useAppStore.getState();
        applyTheme(mode, accentColor);
      }
    };
    mediaQuery.addEventListener('change', handleSystemThemeChange);
    return () => {
      mediaQuery.removeEventListener('change', handleSystemThemeChange);
    };
  }, [theme]);

  // 回到主界面时，根据状态弹出相应的弹窗
  useEffect(() => {
    if (currentPage === 'main') {
      // 下载完成：弹出安装模态框
      if (downloadStatus === 'completed') {
        setShowInstallConfirmModal(true);
      }
      // 有更新、有错误或正在下载：弹出更新气泡
      else if (updateInfo?.hasUpdate || updateInfo?.errorCode || downloadStatus === 'downloading') {
        setShowUpdateDialog(true);
      }
    }
  }, [
    currentPage,
    updateInfo?.hasUpdate,
    updateInfo?.errorCode,
    downloadStatus,
    setShowUpdateDialog,
    setShowInstallConfirmModal,
  ]);

  // 下载完成时，强制弹出安装模态框
  useEffect(() => {
    if (downloadStatus === 'completed') {
      setShowInstallConfirmModal(true);
    }
  }, [downloadStatus, setShowInstallConfirmModal]);

  // 下载失败或取消时，如果有挂起的自动任务，立即分发
  useEffect(() => {
    if (pendingAutoTasksRef.current && (downloadStatus === 'failed' || downloadStatus === 'idle')) {
      pendingAutoTasksRef.current = false;
      log.info('下载失败或取消，分发挂起的自动任务');
      setTimeout(() => {
        document.dispatchEvent(
          new CustomEvent('mxu-start-tasks', { detail: { source: 'autostart' } }),
        );
      }, 500);
    }
  }, [downloadStatus]);

  // 弹窗关闭后，如果有挂起的自动任务（autoRunOnLaunch 场景），立即分发
  useEffect(() => {
    if (pendingAutoTasksRef.current && !showInstallConfirmModal) {
      pendingAutoTasksRef.current = false;
      log.info('弹窗关闭，分发挂起的自动任务');
      setTimeout(() => {
        document.dispatchEvent(
          new CustomEvent('mxu-start-tasks', { detail: { source: 'autostart' } }),
        );
      }, 500);
    }
  }, [showInstallConfirmModal]);

  // 监听窗口大小和位置变化
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenResize: (() => void) | null = null;
    let unlistenMove: (() => void) | null = null;
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    let moveTimeout: ReturnType<typeof setTimeout> | null = null;

    const setupListener = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        unlistenResize = await currentWindow.onResized(async () => {
          if (resizeTimeout) {
            clearTimeout(resizeTimeout);
          }
          resizeTimeout = setTimeout(async () => {
            // 最大化时不保存大小
            const isMaximized = await currentWindow.isMaximized();
            if (isMaximized) return;

            const size = await getWindowSize();
            if (size && isValidWindowSize(size.width, size.height)) {
              setWindowSizeStore(size);
            }
          }, 500);
        });

        unlistenMove = await currentWindow.onMoved(async () => {
          if (moveTimeout) {
            clearTimeout(moveTimeout);
          }
          moveTimeout = setTimeout(async () => {
            // 最大化时不保存位置
            const isMaximized = await currentWindow.isMaximized();
            if (isMaximized) return;

            const position = await getWindowPosition();
            if (position) {
              setWindowPositionStore(position);
            }
          }, 500);
        });
      } catch (err) {
        log.warn('监听窗口大小/位置变化失败:', err);
      }
    };

    setupListener();

    return () => {
      if (unlistenResize) {
        unlistenResize();
      }
      if (unlistenMove) {
        unlistenMove();
      }
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (moveTimeout) {
        clearTimeout(moveTimeout);
      }
    };
  }, [setWindowSizeStore, setWindowPositionStore]);

  // 禁用浏览器默认右键菜单（让自定义菜单生效）
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // 允许输入框和文本区域的默认右键菜单
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }
      e.preventDefault();
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  // 屏蔽浏览器默认快捷键 & 应用内快捷键
  const devMode = useAppStore((state) => state.devMode);

  // 生成统一的快捷键组合字符串，例如：Ctrl+Shift+F10、Alt+Enter、F10
  function getKeyCombo(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let key = e.key;
    // 过滤纯修饰键
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
      return parts.join('+');
    }

    // 统一大小写：Function 键保持原样，其他转大写单字母
    if (/^f\d+$/i.test(key)) {
      key = key.toUpperCase();
    } else if (key.length === 1) {
      key = key.toUpperCase();
    }

    parts.push(key);
    return parts.join('+');
  }

  useEffect(() => {
    const shouldIgnoreHotkey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return false;
      // 输入场景不触发（避免在输入框/文本编辑时误触）
      const tag = el.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (el.isContentEditable) return true;
      const role = el.getAttribute?.('role');
      if (role === 'textbox') return true;
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;

      // F5 - 刷新（生产环境下，开发模式关闭时屏蔽）
      if (e.key === 'F5' && import.meta.env.PROD && !devMode) {
        e.preventDefault();
        return;
      }

      // Ctrl/Cmd 组合键
      if (isCtrlOrMeta) {
        // Ctrl+R 刷新（生产环境下，开发模式关闭时屏蔽）
        if (e.key.toLowerCase() === 'r' && import.meta.env.PROD && !devMode) {
          e.preventDefault();
          return;
        }

        const blockedKeys = [
          'f', // 搜索
          's', // 保存
          'u', // 查看源代码
          'p', // 打印
          'g', // 查找下一个
          'j', // 下载
          'h', // 历史记录
          'd', // 书签
          'n', // 新窗口
          't', // 新标签页
          'w', // 关闭标签页
        ];

        if (blockedKeys.includes(e.key.toLowerCase())) {
          e.preventDefault();
          return;
        }

        // Ctrl+Shift 组合键
        if (e.shiftKey) {
          const blockedShiftKeys = [
            'i', // 开发者工具
            't', // 恢复标签页
            'n', // 新隐私窗口
          ];
          if (blockedShiftKeys.includes(e.key.toLowerCase())) {
            e.preventDefault();
            return;
          }
        }
      }

      // 应用内快捷键：开始/结束任务（默认 F10/F11，可在设置中自定义，支持组合键）
      // 使用自定义事件通知 Toolbar 组件，以复用现有启动/停止逻辑
      if (e.repeat) return;
      if (shouldIgnoreHotkey(e)) return;
      const combo = getKeyCombo(e);
      if (!combo) {
        return;
      }

      const { hotkeys } = useAppStore.getState();
      // 全局快捷键开启时跳过本地监听，避免重复触发
      if (hotkeys?.globalEnabled) return;

      const startKey = hotkeys?.startTasks || 'F10';
      const stopKey = hotkeys?.stopTasks || 'F11';

      if (isAllowedSettingsHotkey(startKey) && combo === startKey) {
        e.preventDefault();
        document.dispatchEvent(
          new CustomEvent('mxu-start-tasks', { detail: { source: 'hotkey', combo } }),
        );
        return;
      }

      if (isAllowedSettingsHotkey(stopKey) && combo === stopKey) {
        e.preventDefault();
        document.dispatchEvent(
          new CustomEvent('mxu-stop-tasks', { detail: { source: 'hotkey', combo } }),
        );
        return;
      }

      // F12 - 开发者工具（生产环境屏蔽）
      if (e.key === 'F12' && import.meta.env.PROD) {
        e.preventDefault();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [devMode]);

  // 全局快捷键（窗口失焦时也生效）
  const hotkeys = useAppStore((state) => state.hotkeys);
  useEffect(() => {
    const { setGlobalHotkeyError } = useAppStore.getState();
    if (!hotkeys?.globalEnabled) {
      setGlobalHotkeyError(null);
      return;
    }
    if (!isTauri()) return; // 浏览器环境不支持全局快捷键

    const startKey = hotkeys.startTasks || 'F10';
    const stopKey = hotkeys.stopTasks || 'F11';
    const startAllowed = isAllowedSettingsHotkey(startKey);
    const stopAllowed = stopKey !== startKey && isAllowedSettingsHotkey(stopKey);

    // Ctrl -> CommandOrControl
    const toTauriKey = (k: string) => k.replace(/^Ctrl\+/i, 'CommandOrControl+');

    if (!startAllowed && !stopAllowed) {
      setGlobalHotkeyError(null);
      return;
    }

    const GLOBAL_HOTKEY_THROTTLE_MS = 1000;
    let lastStartTime = 0;
    const registerKeys = async () => {
      // 记录正在注册的按键，失败时用于告知用户具体是哪个组合键
      let registeringKey = startAllowed ? startKey : stopKey;
      try {
        const { register } = await getGlobalShortcut();
        if (startAllowed) {
          registeringKey = startKey;
          await register(toTauriKey(startKey), () => {
            const now = Date.now();
            if (now - lastStartTime < GLOBAL_HOTKEY_THROTTLE_MS) return;
            lastStartTime = now;
            document.dispatchEvent(
              new CustomEvent('mxu-start-tasks', {
                detail: { source: 'global-hotkey', combo: startKey },
              }),
            );
          });
        }
        if (stopAllowed) {
          registeringKey = stopKey;
          await register(toTauriKey(stopKey), () => {
            document.dispatchEvent(
              new CustomEvent('mxu-stop-tasks', {
                detail: { source: 'global-hotkey', combo: stopKey },
              }),
            );
          });
        }
        log.info(
          '全局快捷键已注册:',
          startAllowed ? startKey : '(skipped)',
          stopAllowed ? stopKey : '(skipped)',
        );
        setGlobalHotkeyError(null);
      } catch (err) {
        log.error('注册全局快捷键失败:', err);

        const message = err instanceof Error ? err.message : String(err);
        let conflict = /already registered/i.test(message);
        if (!conflict) {
          conflict = await getGlobalShortcut()
            .then(({ isRegistered }) => isRegistered(toTauriKey(registeringKey)))
            .catch(() => false);
        }

        setGlobalHotkeyError({ combo: registeringKey, conflict, message });
      }
    };

    registerKeys();
    return () => {
      getGlobalShortcut()
        .then(({ unregisterAll }) => unregisterAll())
        .catch(() => {});
    };
  }, [hotkeys?.globalEnabled, hotkeys?.startTasks, hotkeys?.stopTasks]);

  // 监听托盘菜单事件（开始/停止任务）
  useEffect(() => {
    if (!isTauri()) return;

    let unlistenStart: (() => void) | null = null;
    let unlistenStop: (() => void) | null = null;

    const setupTrayListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlistenStart = await listen('tray-start-tasks', () => {
          log.info('收到托盘开始任务事件');
          document.dispatchEvent(
            new CustomEvent('mxu-start-tasks', { detail: { source: 'tray' } }),
          );
        });

        unlistenStop = await listen('tray-stop-tasks', () => {
          log.info('收到托盘停止任务事件');
          document.dispatchEvent(new CustomEvent('mxu-stop-tasks', { detail: { source: 'tray' } }));
        });

        log.info('托盘事件监听已注册');
      } catch (err) {
        log.warn('注册托盘事件监听失败:', err);
      }
    };

    setupTrayListeners();

    return () => {
      if (unlistenStart) unlistenStart();
      if (unlistenStop) unlistenStop();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | null = null;

    const setupSelfStopListener = async () => {
      try {
        unlisten = await maaService.onSelfStopRequested(async ({ instanceId }) => {
          log.info(`[self-stop#${instanceId}] 收到停止自身请求`);
          try {
            const stopped = await stopInstanceTasksAndExitApp(instanceId);
            if (!stopped) {
              log.warn(`[self-stop#${instanceId}] 停止超时，取消退出应用`);
            }
          } catch (error) {
            log.error(`[self-stop#${instanceId}] 停止自身流程失败:`, error);
          }
        });
      } catch (error) {
        log.warn('注册停止自身事件监听失败:', error);
      }
    };

    void setupSelfStopListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const toaster = (
    <Toaster
      theme={resolveThemeMode(theme)}
      position="bottom-center"
      toastOptions={{
        className: '!bg-bg-secondary !text-text-primary !border-border',
      }}
    />
  );

  // 设置页面
  if (currentPage === 'settings') {
    return (
      <div
        className={`h-full flex flex-col bg-bg-primary relative ${backgroundImageDataUrl ? 'has-background-image' : ''}`}
      >
        <BackgroundOverlay imageDataUrl={backgroundImageDataUrl} opacity={backgroundOpacity} />
        <div className="relative z-10 h-full flex flex-col">
          <ConnectionLostOverlay />
          <TitleBar />
          <WebUIBetaBanner />
          {/* 安装确认模态框 - 在设置页面也需要能弹出 */}
          {showInstallConfirmModal && (
            <Suspense fallback={null}>
              <LazyInstallConfirmModal />
            </Suspense>
          )}
          <div
            key="settings-page"
            className={`flex-1 min-h-0 flex flex-col ${isSettingsExiting ? 'page-slide-right-exit' : 'page-slide-right-enter'}`}
          >
            <Suspense fallback={null}>
              <LazySettingsPage onClose={closeSettingsWithAnimation} />
            </Suspense>
          </div>
          {/*
          让全局快捷键（开始/结束任务）在设置页也能触发：
          Toolbar 内部监听 mxu-start-tasks / mxu-stop-tasks 并复用既有启动/停止逻辑。
          这里不显示 Toolbar，仅用于挂载快捷键处理逻辑。
        */}
          <div className="hidden">
            <Toolbar
              showAddPanel={showAddTaskPanel}
              onToggleAddPanel={() => setShowAddTaskPanel(!showAddTaskPanel)}
            />
          </div>
        </div>
        {toaster}
      </div>
    );
  }

  // 计算显示标题（根据 ProjectInterface V2 协议）
  const getDisplayTitle = () => {
    if (!projectInterface) return { title: 'MXU', subtitle: 'MaaFramework 下一代通用 GUI' };

    const langKey = getInterfaceLangKey(language);
    const translations = interfaceTranslations[langKey];

    // 优先使用 title 字段（支持国际化），否则使用 name + version
    // 注意：协议规定 title 默认为 name + version，不是 label + version
    let title: string;
    if (projectInterface.title) {
      title = resolveI18nText(projectInterface.title, translations);
    } else {
      const version = projectInterface.version;
      title = version ? `${projectInterface.name} ${version}` : projectInterface.name;
    }

    // 副标题：使用 description（支持国际化）或默认
    const subtitle = projectInterface.description
      ? resolveI18nText(projectInterface.description, translations)
      : 'MaaFramework 下一代通用 GUI';

    return { title, subtitle };
  };

  // 加载中或错误状态
  if (loadingState !== 'success' || !projectInterface) {
    const { title: displayTitle, subtitle: displaySubtitle } = getDisplayTitle();

    return (
      <LoadingScreen
        loadingState={loadingState}
        errorMessage={errorMessage}
        showBadPathModal={showBadPathModal}
        badPathType={badPathType}
        displayTitle={displayTitle}
        displaySubtitle={displaySubtitle}
        onRetry={loadInterface}
      />
    );
  }

  // 主页面
  return (
    <div
      className={`h-full flex flex-col bg-bg-primary relative ${backgroundImageDataUrl ? 'has-background-image' : ''}`}
    >
      <BackgroundOverlay imageDataUrl={backgroundImageDataUrl} opacity={backgroundOpacity} />
      <div className="relative z-10 h-full flex flex-col">
        {/* WebUI 模式下的连接断开覆盖层 */}
        <ConnectionLostOverlay />

        {/* 自定义标题栏 */}
        <TitleBar />

        {/* WebUI 测试版提示横幅 */}
        <WebUIBetaBanner />

        {/* 欢迎弹窗 */}
        {projectInterface.welcome && (
          <Suspense
            fallback={<div className="fixed inset-0 z-50 pointer-events-none" aria-hidden />}
          >
            <LazyAutoWelcomeDialog />
          </Suspense>
        )}

        {/* 新用户引导覆盖层 - 仅在右侧面板可见时显示 */}
        {!onboardingCompleted && !rightPanelCollapsed && !dashboardView && (
          <Suspense fallback={null}>
            <LazyOnboardingOverlay />
          </Suspense>
        )}

        {/* 安装确认模态框 */}
        {showInstallConfirmModal && (
          <Suspense fallback={null}>
            <LazyInstallConfirmModal />
          </Suspense>
        )}

        {/* VC++ 运行库缺失提示模态框 */}
        {showVCRedistModal && (
          <Suspense fallback={null}>
            <LazyVCRedistModal
              show={showVCRedistModal}
              onClose={() => setShowVCRedistModal(false)}
            />
          </Suspense>
        )}

        {/* 程序路径问题提示模态框 */}
        {showBadPathModal && (
          <Suspense fallback={null}>
            <LazyBadPathModal show={showBadPathModal} type={badPathType} />
          </Suspense>
        )}

        {/* MaaFramework 版本警告弹窗 */}
        {versionWarning && (
          <Suspense fallback={null}>
            <LazyVersionWarningModal
              current={versionWarning.current}
              minimum={versionWarning.minimum}
              onClose={() => setVersionWarning(null)}
            />
          </Suspense>
        )}

        {/* 顶部标签栏 */}
        <TabBar />

        {/* 中控台视图 */}
        {dashboardView ? (
          <div
            key="dashboard-view"
            className={`flex-1 min-h-0 ${isDashboardExiting ? 'page-slide-top-exit' : 'page-slide-top-enter'}`}
          >
            <Suspense fallback={null}>
              <LazyDashboardView onClose={closeDashboardWithAnimation} />
            </Suspense>
          </div>
        ) : isMobile ? (
          /* 移动端竖屏布局：单列纵向堆叠 */
          <div key="main-view-mobile" className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* 可滚动主内容区 */}
            <div className="flex-1 overflow-y-auto">
              {/* 连接设置 */}
              <div className="p-2">
                <ConnectionPanel />
              </div>

              {/* 实时截图 */}
              <div className="p-2">
                <ScreenshotPanel />
              </div>

              {/* 任务列表 */}
              <TaskList />

              {/* 添加任务面板 */}
              <div
                className="grid transition-[grid-template-rows] duration-150 ease-out"
                style={{ gridTemplateRows: showAddTaskPanel ? '1fr' : '0fr' }}
              >
                <div className="overflow-hidden min-h-0">
                  <AddTaskPanel />
                </div>
              </div>

              {/* 工具栏（任务列表下方） */}
              <Toolbar
                showAddPanel={showAddTaskPanel}
                onToggleAddPanel={() => setShowAddTaskPanel(!showAddTaskPanel)}
              />

              {/* 运行日志 */}
              <div className="p-2">
                <LogsPanel />
              </div>
            </div>

            {/* 浮动按钮：定位到运行日志 */}
            <button
              type="button"
              onClick={() =>
                document.getElementById('logs-panel')?.scrollIntoView({ behavior: 'smooth' })
              }
              className="fixed bottom-4 right-4 z-50 p-3 rounded-full bg-accent text-white shadow-lg active:bg-accent-hover transition-colors"
              aria-label={t('logs.scrollToLogs')}
              title={t('logs.scrollToLogs')}
            >
              <ScrollText className="w-5 h-5" />
            </button>
          </div>
        ) : (
          /* 桌面端横向分栏布局 */
          <div key="main-view" className="flex-1 flex overflow-hidden">
            {/* 左侧任务列表区 */}
            <div
              className="flex-1 flex flex-col border-r border-border"
              style={{ minWidth: MIN_LEFT_PANEL_WIDTH }}
            >
              {/* 任务列表 */}
              <TaskList />

              {/* 添加任务面板 - 使用 grid 动画实现平滑展开/折叠 */}
              <div
                className="grid transition-[grid-template-rows] duration-150 ease-out"
                style={{ gridTemplateRows: showAddTaskPanel ? '1fr' : '0fr' }}
              >
                <div className="overflow-hidden min-h-0">
                  <AddTaskPanel />
                </div>
              </div>

              {/* 底部工具栏 */}
              <Toolbar
                showAddPanel={showAddTaskPanel}
                onToggleAddPanel={() => setShowAddTaskPanel(!showAddTaskPanel)}
              />
            </div>

            {/* 分隔条 Resizer */}
            <div
              className={`${rightPanelCollapsed ? 'w-4' : 'w-1'} hover:bg-accent/50 cursor-col-resize flex items-center justify-center group shrink-0 transition-all select-none bg-transparent`}
              onMouseDown={handleResizeStart}
              title={t('common.resizeOrCollapse', '拖动调整宽度，向右拖动到底可折叠')}
            >
              {/* 可视化把手 */}
              <div className="w-[2px] h-8 rounded-full transition-colors bg-border group-hover:bg-accent" />
            </div>

            {/* 右侧信息面板 */}
            {!rightPanelCollapsed && (
              <div
                className={`flex flex-col p-3 bg-bg-primary overflow-x-hidden border-l border-transparent ${sidePanelExpanded ? 'gap-3 overflow-y-auto' : 'overflow-hidden'}`}
                style={{
                  width: rightPanelWidth,
                  minWidth: 240,
                  // 允许收缩但保持最小宽度，确保窗口缩小时不被裁切
                  flexShrink: 1,
                }}
              >
                {/* 连接设置和实时截图（可折叠）- 使用 grid 动画 */}
                <div
                  className="grid transition-[grid-template-rows] duration-150 ease-out"
                  style={{ gridTemplateRows: sidePanelExpanded ? '1fr' : '0fr' }}
                >
                  <div className="overflow-hidden min-h-0 flex flex-col gap-3">
                    {/* 连接设置（设备/资源选择） */}
                    <ConnectionPanel />

                    {/* 实时截图 */}
                    <ScreenshotPanel />
                  </div>
                </div>

                {/* 运行日志 */}
                <LogsPanel />
              </div>
            )}
          </div>
        )}
      </div>
      {toaster}
    </div>
  );
}

export default App;
