import { useState, useCallback } from 'react';
import { isTauri } from '@/utils/paths';
import { loggers } from '@/utils/logger';
import { useAppStore } from '@/stores/appStore';
import { maaService } from '@/services/maaService';

export type ExportStatus = 'idle' | 'exporting' | 'success' | 'error';

export interface ExportLogsState {
  show: boolean;
  status: ExportStatus;
  zipPath?: string;
  error?: string;
}

export function useExportLogs() {
  const projectInterface = useAppStore((state) => state.projectInterface);
  const [exportModal, setExportModal] = useState<ExportLogsState>({
    show: false,
    status: 'idle',
  });

  const handleExportLogs = useCallback(async () => {
    if (!isTauri()) {
      loggers.ui.warn('仅 Tauri 环境支持导出日志');
      return;
    }

    setExportModal({ show: true, status: 'exporting' });
    try {
      await maaService.registerLogSecrets();
      const { invoke } = await import('@tauri-apps/api/core');
      const zipPath = await invoke<string>('export_logs', {
        projectName: projectInterface?.name,
        projectVersion: projectInterface?.version,
      });
      loggers.ui.info('日志已导出:', zipPath);

      setExportModal({ show: true, status: 'success', zipPath });

      // 打开所在目录并选中文件
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(zipPath);
    } catch (err) {
      loggers.ui.error('导出日志失败:', err);
      setExportModal({
        show: true,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [projectInterface?.name, projectInterface?.version]);

  const closeExportModal = useCallback(() => {
    setExportModal({ show: false, status: 'idle' });
  }, []);

  const openExportedFile = useCallback(async () => {
    if (!exportModal.zipPath) return;
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(exportModal.zipPath);
    } catch (err) {
      loggers.ui.error('打开导出文件失败:', err);
    }
  }, [exportModal.zipPath]);

  return {
    exportModal,
    handleExportLogs,
    closeExportModal,
    openExportedFile,
  };
}
