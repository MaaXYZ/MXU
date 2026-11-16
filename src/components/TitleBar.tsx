import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Square, X, Copy, Box } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getInterfaceLangKey } from '@/i18n';
import { loadIconAsDataUrl } from '@/services/contentResolver';
import { loggers } from '@/utils/logger';
import { isTauri } from '@/utils/paths';

// 平台类型
type Platform = 'windows' | 'macos' | 'linux' | 'unknown';

export function TitleBar() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);
  const [platform, setPlatform] = useState<Platform>('unknown');
  const [iconUrl, setIconUrl] = useState<string | undefined>(undefined);

  const { projectInterface, language, resolveI18nText, basePath, interfaceTranslations } =
    useAppStore();

  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  // 检测平台（通过 userAgent）
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('win')) setPlatform('windows');
    else if (ua.includes('mac')) setPlatform('macos');
    else if (ua.includes('linux')) setPlatform('linux');
  }, []);

  // 异步加载图标（Tauri 环境下需要转换为 data URL）
  useEffect(() => {
    if (!projectInterface?.icon) {
      setIconUrl(undefined);
      return;
    }
    loadIconAsDataUrl(projectInterface.icon, basePath, translations).then(setIconUrl);
  }, [projectInterface?.icon, basePath, translations]);

  // 监听窗口最大化状态变化（仅 Windows，用于切换最大化/还原按钮图标）
  useEffect(() => {
    if (!isTauri() || platform !== 'windows') return;

    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const appWindow = getCurrentWindow();

        // 获取初始状态
        setIsMaximized(await appWindow.isMaximized());

        // 监听窗口状态变化
        unlisten = await appWindow.onResized(async () => {
          setIsMaximized(await appWindow.isMaximized());
        });
      } catch (err) {
        loggers.ui.warn('Failed to setup window state listener:', err);
      }
    };

    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, [platform]);

  const handleMinimize = async () => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch (err) {
      loggers.ui.warn('Failed to minimize window:', err);
    }
  };

  const handleToggleMaximize = async () => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      loggers.ui.warn('Failed to toggle maximize:', err);
    }
  };

  const handleClose = async () => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch (err) {
      loggers.ui.warn('Failed to close window:', err);
    }
  };

  // 计算窗口标题
  const getWindowTitle = () => {
    if (!projectInterface) return 'MXU';

    // 优先使用 title 字段（支持国际化），否则使用 name + version
    if (projectInterface.title) {
      return resolveI18nText(projectInterface.title, langKey);
    }

    const version = projectInterface.version;
    return version ? `${projectInterface.name} ${version}` : projectInterface.name;
  };

  // 浏览器环境不渲染自定义标题栏（标题栏仅用于 Tauri 窗口控制按钮）
  // macOS/Linux 使用原生标题栏，也不渲染
  if (!isTauri() || platform === 'macos' || platform === 'linux') {
    return null;
  }

  return (
    <div
      data-skin-slot="titlebar"
      data-tauri-drag-region
      className="h-8 flex items-center justify-between bg-bg-secondary border-b border-border select-none shrink-0"
    >
      {/* 左侧：窗口图标和标题 */}
      <div className="flex items-center h-full" data-tauri-drag-region>
        {/* 窗口图标 */}
        <div className="w-8 h-8 flex items-center justify-center">
          {iconUrl ? (
            <img src={iconUrl} alt="icon" className="w-4 h-4" />
          ) : (
            // 默认图标（无 icon 配置或加载中）
            <Box className="w-4 h-4 text-text-secondary" />
          )}
        </div>
        <span className="text-xs text-text-secondary px-2 truncate max-w-lg" data-tauri-drag-region>
          {getWindowTitle()}
        </span>
      </div>

      {/* 右侧：窗口控制按钮（仅 Windows/Linux 显示） */}
      {isTauri() && (
        <div className="flex h-full">
          <button
            onClick={handleMinimize}
            className="w-12 h-full flex items-center justify-center text-text-secondary hover:bg-bg-hover transition-colors"
            title={t('windowControls.minimize')}
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            onClick={handleToggleMaximize}
            className="w-12 h-full flex items-center justify-center text-text-secondary hover:bg-bg-hover transition-colors"
            title={isMaximized ? t('windowControls.restore') : t('windowControls.maximize')}
          >
            {isMaximized ? (
              <Copy className="w-3.5 h-3.5 rotate-180" />
            ) : (
              <Square className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={handleClose}
            className="w-12 h-full flex items-center justify-center text-text-secondary hover:bg-red-500 hover:text-white transition-colors"
            title={t('windowControls.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
