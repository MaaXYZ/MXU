import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  Bug,
  RefreshCw,
  FolderOpen,
  ScrollText,
  Network,
  Archive,
  Cpu,
  ChevronDown,
  Check,
} from 'lucide-react';

import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import { loggers } from '@/utils/logger';
import { isTauri, getDebugDir, getConfigDir, openDirectory } from '@/utils/paths';
import { useExportLogs } from '@/utils/useExportLogs';
import { SwitchButton } from '@/components/FormControls';
import type { InferenceDevice } from '@/types/config';
import { ExportLogsModal } from './ExportLogsModal';

const INFERENCE_DEVICE_OPTIONS: { value: InferenceDevice; labelKey: string }[] = [
  { value: 'auto', labelKey: 'debug.inferenceDeviceAuto' },
  { value: 'cpu', labelKey: 'debug.inferenceDeviceCpu' },
];

export function DebugSection() {
  const { t } = useTranslation();
  const {
    projectInterface,
    dataPath,
    devMode,
    setDevMode,
    saveDraw,
    setSaveDraw,
    tcpCompatMode,
    setTcpCompatMode,
    inferenceDevice,
    setInferenceDevice,
    backendOS,
    backendArch,
  } = useAppStore();

  const [mxuVersion, setMxuVersion] = useState<string | null>(null);
  const [maafwVersion, setMaafwVersion] = useState<string | null>(null);
  const [exeDir, setExeDir] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [webview2Dir, setWebview2Dir] = useState<{ path: string; system: boolean } | null>(null);
  const [systemInfo, setSystemInfo] = useState<{
    os: string;
    osVersion: string;
    arch: string;
    tauriVersion: string;
  } | null>(null);

  const { exportModal, handleExportLogs, closeExportModal, openExportedFile } = useExportLogs();

  const [inferenceDropdownOpen, setInferenceDropdownOpen] = useState(false);
  const inferenceDropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭推理设备下拉框
  useEffect(() => {
    if (!inferenceDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        inferenceDropdownRef.current &&
        !inferenceDropdownRef.current.contains(e.target as Node)
      ) {
        setInferenceDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [inferenceDropdownOpen]);

  const version = projectInterface?.version || '0.1.0';

  // 版本信息（用于调试展示）
  useEffect(() => {
    const loadVersions = async () => {
      // mxu 版本
      if (isTauri()) {
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          setMxuVersion(await getVersion());
        } catch {
          setMxuVersion(__MXU_VERSION__ || null);
        }
      } else {
        setMxuVersion(__MXU_VERSION__ || null);
      }

      // maafw 版本（Tauri 直接调用，浏览器走 HTTP API）
      try {
        setMaafwVersion(await maaService.getVersion());
      } catch {
        setMaafwVersion(null);
      }

      // 路径信息和系统信息（仅在 Tauri 环境有意义）
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const [exeDirResult, cwdResult, sysInfo, webview2DirResult] = await Promise.all([
            invoke<string>('get_exe_dir'),
            invoke<string>('get_cwd'),
            invoke<{ os: string; os_version: string; arch: string; tauri_version: string }>(
              'get_system_info',
            ),
            invoke<{ path: string; system: boolean }>('get_webview2_dir'),
          ]);
          setExeDir(exeDirResult);
          setCwd(cwdResult);
          setWebview2Dir(webview2DirResult);
          setSystemInfo({
            os: sysInfo.os,
            osVersion: sysInfo.os_version,
            arch: sysInfo.arch,
            tauriVersion: sysInfo.tauri_version,
          });
        } catch {
          setExeDir(null);
          setCwd(null);
          setSystemInfo(null);
        }
      } else {
        // 浏览器环境：从 store 读取后端真实 OS/架构
        if (backendOS) {
          setSystemInfo({
            os: backendOS,
            osVersion: '',
            arch: backendArch || '',
            tauriVersion: '',
          });
        }
      }
    };

    loadVersions();
  }, []);

  // 调试：打开配置目录
  const handleOpenConfigDir = async () => {
    if (!isTauri() || !dataPath) {
      loggers.ui.warn('仅 Tauri 环境支持打开目录, dataPath:', dataPath);
      return;
    }

    try {
      const configPath = await getConfigDir();
      loggers.ui.info('打开配置目录:', configPath);
      await openDirectory(configPath);
    } catch (err) {
      loggers.ui.error('打开配置目录失败:', err);
    }
  };

  // 调试：打开日志目录
  const handleOpenLogDir = async () => {
    if (!isTauri() || !dataPath) {
      loggers.ui.warn('仅 Tauri 环境支持打开目录, dataPath:', dataPath);
      return;
    }

    try {
      const logPath = await getDebugDir();
      loggers.ui.info('打开日志目录:', logPath);
      await openDirectory(logPath);
    } catch (err) {
      loggers.ui.error('打开日志目录失败:', err);
    }
  };

  return (
    <section id="section-debug" className="space-y-4 scroll-mt-4">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider flex items-center gap-2">
        <Bug className="w-4 h-4" />
        {t('debug.title')}
      </h2>

      <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-4">
        {/* 版本信息 */}
        <div className="text-sm text-text-secondary space-y-1">
          <p className="font-medium text-text-primary">{t('debug.versions')}</p>
          <p>
            {t('debug.interfaceVersion', { name: projectInterface?.name || 'interface' })}:{' '}
            <span className="font-mono text-text-primary">{version || '-'}</span>
          </p>
          <p>
            {t('debug.maafwVersion')}:{' '}
            <span className="font-mono text-text-primary">
              {maafwVersion || t('maa.notInitialized')}
            </span>
          </p>
          <p>
            {t('debug.mxuVersion')}:{' '}
            <span className="font-mono text-text-primary">{mxuVersion || '-'}</span>
          </p>
        </div>

        {/* 环境信息 */}
        <div className="text-sm text-text-secondary space-y-1">
          <p>
            {t('debug.environment')}:{' '}
            <span className="font-mono text-text-primary">
              {isTauri() ? t('debug.envTauri') : t('debug.envBrowser')}
            </span>
          </p>
        </div>

        {/* 系统信息 */}
        {systemInfo && (
          <div className="text-sm text-text-secondary space-y-1">
            <p className="font-medium text-text-primary">{t('debug.systemInfo')}</p>
            <p>
              {t('debug.operatingSystem')}:{' '}
              <span className="font-mono text-text-primary">{systemInfo.osVersion}</span>
            </p>
            <p>
              {t('debug.architecture')}:{' '}
              <span className="font-mono text-text-primary">{systemInfo.arch}</span>
            </p>
            <p>
              {t('debug.tauriVersion')}:{' '}
              <span className="font-mono text-text-primary">{systemInfo.tauriVersion}</span>
            </p>
          </div>
        )}

        {/* 路径信息（仅 Tauri 环境显示） */}
        {isTauri() && (exeDir || cwd) && (
          <div className="text-sm text-text-secondary space-y-1">
            <p className="font-medium text-text-primary">{t('debug.pathInfo')}</p>
            {cwd && (
              <p className="break-all">
                {t('debug.cwd')}: <span className="font-mono text-text-primary text-xs">{cwd}</span>
              </p>
            )}
            {exeDir && (
              <p className="break-all">
                {t('debug.exeDir')}:{' '}
                <span className="font-mono text-text-primary text-xs">{exeDir}</span>
              </p>
            )}
            <p className="break-all">
              {t('debug.webview2Dir')}:{' '}
              <span className="font-mono text-text-primary text-xs">
                {webview2Dir
                  ? webview2Dir.system
                    ? `(${t('debug.webview2System')})`
                    : webview2Dir.path
                  : '-'}
              </span>
            </p>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleOpenConfigDir}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors"
          >
            <FolderOpen className="w-4 h-4" />
            {t('debug.openConfigDir')}
          </button>
          <button
            onClick={handleOpenLogDir}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors"
          >
            <ScrollText className="w-4 h-4" />
            {t('debug.openLogDir')}
          </button>
          <button
            onClick={handleExportLogs}
            disabled={exportModal.show && exportModal.status === 'exporting'}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-bg-tertiary hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-50"
            title={t('debug.exportLogsHint')}
          >
            <Archive className="w-4 h-4" />
            {t('debug.exportLogs')}
          </button>
        </div>

        {/* 开发模式 */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-5 h-5 text-accent" />
            <div>
              <span className="font-medium text-text-primary">{t('debug.devMode')}</span>
              <p className="text-xs text-text-muted mt-0.5">{t('debug.devModeHint')}</p>
            </div>
          </div>
          <SwitchButton value={devMode} onChange={(v) => setDevMode(v)} />
        </div>

        {/* 保存调试图像 */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-3">
            <Bug className="w-5 h-5 text-accent" />
            <div>
              <span className="font-medium text-text-primary">{t('debug.saveDraw')}</span>
              <p className="text-xs text-text-muted mt-0.5">{t('debug.saveDrawHint')}</p>
            </div>
          </div>
          <SwitchButton value={saveDraw} onChange={(v) => setSaveDraw(v)} />
        </div>

        {/* 通信兼容模式 */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-3">
            <Network className="w-5 h-5 text-accent" />
            <div>
              <span className="font-medium text-text-primary">{t('debug.tcpCompatMode')}</span>
              <p className="text-xs text-text-muted mt-0.5">{t('debug.tcpCompatModeHint')}</p>
            </div>
          </div>
          <SwitchButton value={tcpCompatMode} onChange={(v) => setTcpCompatMode(v)} />
        </div>

        {/* 推理设备 */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5 text-accent" />
            <div>
              <span className="font-medium text-text-primary">{t('debug.inferenceDevice')}</span>
              <p className="text-xs text-text-muted mt-0.5">{t('debug.inferenceDeviceHint')}</p>
            </div>
          </div>
          {/* 自定义下拉框 */}
          <div className="relative shrink-0" ref={inferenceDropdownRef}>
            <button
              type="button"
              onClick={() => setInferenceDropdownOpen((prev) => !prev)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setInferenceDropdownOpen(false);
              }}
              className="min-w-[160px] px-3 py-1.5 text-sm rounded-lg border flex items-center justify-between gap-2 bg-bg-tertiary border-border text-text-primary hover:bg-bg-hover transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
              aria-haspopup="listbox"
              aria-expanded={inferenceDropdownOpen}
            >
              <span className="truncate">
                {t(
                  INFERENCE_DEVICE_OPTIONS.find((opt) => opt.value === inferenceDevice)?.labelKey ??
                    INFERENCE_DEVICE_OPTIONS[0].labelKey,
                )}
              </span>
              <ChevronDown
                className={clsx(
                  'w-4 h-4 text-text-muted shrink-0 transition-transform',
                  inferenceDropdownOpen && 'rotate-180',
                )}
              />
            </button>

            {inferenceDropdownOpen && (
              <div
                className="mxu-overlay-surface absolute right-0 z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-border bg-bg-primary shadow-lg"
                role="listbox"
              >
                {INFERENCE_DEVICE_OPTIONS.map((opt) => {
                  const isSelected = opt.value === inferenceDevice;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={clsx(
                        'w-full px-3 py-2 text-sm text-left flex items-center gap-2 transition-colors',
                        isSelected
                          ? 'bg-accent/10 text-accent font-medium'
                          : 'text-text-primary hover:bg-bg-hover',
                      )}
                      onClick={() => {
                        setInferenceDevice(opt.value);
                        setInferenceDropdownOpen(false);
                      }}
                    >
                      <Check
                        className={clsx(
                          'w-4 h-4 shrink-0',
                          isSelected ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className="truncate">{t(opt.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 导出日志 Modal */}
      <ExportLogsModal
        show={exportModal.show}
        status={exportModal.status === 'idle' ? 'exporting' : exportModal.status}
        zipPath={exportModal.zipPath}
        error={exportModal.error}
        onClose={closeExportModal}
        onOpen={openExportedFile}
      />
    </section>
  );
}
