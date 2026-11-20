import {
  Fragment,
  useRef,
  useEffect,
  useCallback,
  useState,
  useMemo,
  useLayoutEffect,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, Copy, ChevronUp, ChevronDown, Archive } from 'lucide-react';
import clsx from 'clsx';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, type LogType } from '@/stores/appStore';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import { isTauri } from '@/utils/paths';
import { useExportLogs } from '@/utils/useExportLogs';
import { ExportLogsModal } from './settings/ExportLogsModal';
import { useIsMobile } from '@/hooks/useIsMobile';
import { getCurrentLogFileName } from '@/utils/logger';
import { clearPersistedRuntimeLogs } from '@/utils/runtimeLogPersistence';
import { getAllLogsFromBackend } from '@/utils/logStdout';
import { loadPersistedRuntimeLogs, mergeRuntimeLogs } from '@/utils/runtimeLogPersistence';
import type { LogEntry } from '@/stores/types';

const DEFAULT_VISIBLE_LOG_LIMIT = 500;
const EXPANDED_LOG_LIMIT = 2000;
const BOTTOM_FOLLOW_THRESHOLD_PX = 24;

function formatLogTime(date: Date, locale?: string) {
  return date.toLocaleTimeString(locale || undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function LogsPanel() {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const isFollowingTailRef = useRef(true);
  const [visibleLogLimit, setVisibleLogLimit] = useState(DEFAULT_VISIBLE_LOG_LIMIT);
  const [isAtTop, setIsAtTop] = useState(false);
  const [isExpandingLogs, setIsExpandingLogs] = useState(false);

  const {
    sidePanelExpanded,
    toggleSidePanelExpanded,
    activeInstanceId,
    instanceLogs,
    clearLogs,
    setMaxLogsPerInstance,
  } = useAppStore();
  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();
  const { exportModal, handleExportLogs, closeExportModal, openExportedFile } = useExportLogs();

  // 获取当前实例的日志
  const logs = activeInstanceId ? instanceLogs[activeInstanceId] || [] : [];
  const visibleLogs = useMemo(() => logs.slice(-visibleLogLimit), [logs, visibleLogLimit]);
  const canShowMoreLogs =
    visibleLogLimit === DEFAULT_VISIBLE_LOG_LIMIT &&
    visibleLogs.length === DEFAULT_VISIBLE_LOG_LIMIT;

  useEffect(() => {
    setVisibleLogLimit(DEFAULT_VISIBLE_LOG_LIMIT);
    setIsAtTop(false);
    isFollowingTailRef.current = true;
  }, [activeInstanceId]);

  useLayoutEffect(() => {
    if (!isFollowingTailRef.current) return;

    logsEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs.length, visibleLogLimit]);

  const handleLogsScroll = useCallback(() => {
    const el = logsContainerRef.current;
    if (!el) return;

    const top = el.scrollTop <= 4;
    const bottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_FOLLOW_THRESHOLD_PX * 2;

    setIsAtTop(top);
    isFollowingTailRef.current = bottom;
  }, []);

  const clearLogFiles = useCallback(async () => {
    if (!isTauri()) return;
    try {
      await invoke<number>('clear_log_files', {
        excludeFileName: getCurrentLogFileName(),
      });
    } catch {
      // ignore cleanup errors
    }
  }, []);

  const handleClear = useCallback(() => {
    if (activeInstanceId) {
      clearLogs(activeInstanceId);
    }
    clearPersistedRuntimeLogs();
    clearLogFiles();
  }, [activeInstanceId, clearLogFiles, clearLogs]);

  const handleCopyAll = useCallback(() => {
    const text = visibleLogs
      .map((log) => `[${log.timestamp.toLocaleTimeString()}] ${log.message}`)
      .join('\n');
    navigator.clipboard.writeText(text);
  }, [visibleLogs]);

  const handleShowMoreLogs = useCallback(() => {
    if (isExpandingLogs) return;

    const targetLimit = EXPANDED_LOG_LIMIT;
    setIsExpandingLogs(true);

    void (async () => {
      try {
        const backendLogs = await getAllLogsFromBackend();
        const restoredBackendLogs: Record<string, LogEntry[]> = {};
        for (const [instanceId, entries] of Object.entries(backendLogs || {})) {
          restoredBackendLogs[instanceId] = entries.map((entry) => ({
            id: entry.id,
            timestamp: new Date(entry.timestamp),
            type: entry.type as LogType,
            message: entry.message,
            html: entry.html,
          }));
        }

        const store = useAppStore.getState();
        const restoredPersistentLogs = loadPersistedRuntimeLogs(targetLimit);
        const mergedLogs = mergeRuntimeLogs(
          targetLimit,
          store.instanceLogs,
          restoredBackendLogs,
          restoredPersistentLogs,
        );

        useAppStore.setState({ instanceLogs: mergedLogs });
        setMaxLogsPerInstance(targetLimit);
        setVisibleLogLimit(targetLimit);
      } catch {
        // Rehydration failed; keep the 500-line window and allow retry.
      } finally {
        setIsExpandingLogs(false);
      }
    })();
  }, [isExpandingLogs, setMaxLogsPerInstance]);

  const getLogColor = (type: LogType) => {
    switch (type) {
      case 'success':
        return 'text-success'; // 跟随主题强调色
      case 'warning':
        return 'text-warning';
      case 'error':
        return 'text-error';
      case 'agent':
        return 'text-text-muted';
      case 'focus':
        return 'text-accent'; // 跟随主题强调色
      case 'info':
        return 'text-info'; // 跟随主题强调色
      default:
        return 'text-text-secondary';
    }
  };

  // 右键菜单处理
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      const menuItems: MenuItem[] = [
        {
          id: 'export-logs',
          label: t('debug.exportLogs'),
          icon: Archive,
          disabled: !isTauri(),
          onClick: handleExportLogs,
        },
        {
          id: 'copy',
          label: t('logs.copyAll'),
          icon: Copy,
          disabled: logs.length === 0,
          onClick: handleCopyAll,
        },
        {
          id: 'clear',
          label: t('logs.clear'),
          icon: Eraser,
          disabled: logs.length === 0,
          danger: true,
          onClick: handleClear,
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'toggle-panel',
          label: sidePanelExpanded ? t('logs.collapse') : t('logs.expand'),
          icon: sidePanelExpanded ? ChevronUp : ChevronDown,
          onClick: toggleSidePanelExpanded,
        },
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      logs.length,
      sidePanelExpanded,
      handleExportLogs,
      handleCopyAll,
      handleClear,
      toggleSidePanelExpanded,
      showMenu,
    ],
  );

  return (
    <div
      id="logs-panel"
      data-skin-slot="logs"
      className={clsx(
        'flex flex-col bg-bg-secondary rounded-lg ring-1 ring-inset ring-border overflow-hidden',
        // 2.5rem = TabBar h-10；若 TabBar 高度变更需同步更新
        isMobile ? 'h-[calc(100dvh-2.5rem)]' : 'flex-1 min-h-50',
      )}
    >
      {/* 标题栏（桌面端可点击展开/折叠上方面板，移动端仅显示标题） */}
      <div
        data-skin-slot="panel-header"
        role={isMobile ? undefined : 'button'}
        tabIndex={isMobile ? undefined : 0}
        onClick={isMobile ? undefined : toggleSidePanelExpanded}
        onKeyDown={
          isMobile
            ? undefined
            : (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleSidePanelExpanded();
                }
              }
        }
        className={clsx(
          'flex items-center justify-between px-3 py-2 border-b border-border transition-colors shrink-0 rounded-t-lg',
          !isMobile &&
            'hover:bg-bg-hover cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 outline-none',
        )}
      >
        <span className="text-sm font-medium text-text-primary">{t('logs.title')}</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleExportLogs();
            }}
            disabled={!isTauri() || (exportModal.show && exportModal.status === 'exporting')}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !isTauri()
                ? 'text-text-muted cursor-not-allowed'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={t('debug.exportLogs')}
          >
            <Archive className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleClear();
            }}
            disabled={!isTauri() && logs.length === 0}
            className={clsx(
              'p-1 rounded-md transition-colors',
              !isTauri() && logs.length === 0
                ? 'text-text-muted cursor-not-allowed'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
            )}
            title={t('logs.clear')}
          >
            <Eraser className="w-3.5 h-3.5" />
          </button>
          {!isMobile && (
            <span
              className={clsx(
                'p-0.5 rounded transition-colors',
                !sidePanelExpanded ? 'text-accent bg-accent-light' : 'text-text-muted',
              )}
            >
              <ChevronDown
                className={clsx(
                  'w-4 h-4 transition-transform duration-150 ease-out',
                  sidePanelExpanded && 'rotate-180',
                )}
              />
            </span>
          )}
        </div>
      </div>

      {/* 日志内容 */}
      <div
        ref={logsContainerRef}
        data-skin-slot="log-scroll"
        className="flex-1 min-h-0 overflow-y-auto p-2.5 font-mono text-[12px] leading-4 bg-bg-tertiary dark:bg-bg-secondary"
        onScroll={handleLogsScroll}
        onContextMenu={handleContextMenu}
      >
        {visibleLogs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-muted">
            {t('logs.noLogs')}
          </div>
        ) : (
          <>
            {canShowMoreLogs && isAtTop && (
              <div className="flex justify-center py-3">
                <button
                  type="button"
                  onClick={handleShowMoreLogs}
                  disabled={isExpandingLogs}
                  className={clsx(
                    'px-4 py-2 rounded-full border border-border',
                    'bg-bg-secondary text-text-primary shadow-sm',
                    'hover:bg-bg-hover hover:border-accent/50 transition-colors',
                    isExpandingLogs && 'opacity-60 cursor-not-allowed',
                  )}
                >
                  {t('logs.showMoreLogs')}
                </button>
              </div>
            )}
            {visibleLogs.map((log, index) => (
              <Fragment key={log.id}>
                {log.html ? (
                  // 富文本内容（focus 消息支持 Markdown/HTML）
                  <div
                    data-log-type={log.type}
                    className={clsx(
                      'py-1.5 px-2 rounded-md flex items-start gap-3',
                      getLogColor(log.type),
                    )}
                  >
                    <span className="text-text-muted/90 w-[64px] flex-shrink-0 tabular-nums text-[11px] leading-4">
                      {formatLogTime(log.timestamp, i18n.language)}
                    </span>
                    <span
                      className="min-w-0 flex-1 break-words leading-4 focus-content"
                      dangerouslySetInnerHTML={{ __html: log.html }}
                    />
                  </div>
                ) : (
                  <div
                    data-log-type={log.type}
                    className={clsx(
                      'py-1.5 px-2 rounded-md flex items-start gap-3',
                      getLogColor(log.type),
                    )}
                  >
                    <span className="text-text-muted/90 w-[64px] flex-shrink-0 tabular-nums text-[11px] leading-4">
                      {formatLogTime(log.timestamp, i18n.language)}
                    </span>
                    <span className="min-w-0 flex-1 break-words whitespace-pre-wrap leading-4">
                      {log.message}
                    </span>
                  </div>
                )}
                {index < visibleLogs.length - 1 && (
                  <div className="mx-4 my-1 h-px bg-border/50" aria-hidden="true" />
                )}
              </Fragment>
            ))}
            <div ref={logsEndRef} aria-hidden="true" />
          </>
        )}
      </div>

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}

      {/* 导出日志 Modal */}
      <ExportLogsModal
        show={exportModal.show}
        status={exportModal.status === 'idle' ? 'exporting' : exportModal.status}
        zipPath={exportModal.zipPath}
        error={exportModal.error}
        onClose={closeExportModal}
        onOpen={openExportedFile}
      />
    </div>
  );
}
