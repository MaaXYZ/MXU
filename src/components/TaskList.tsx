import { useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  ListTodo,
  Plus,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Loader2,
  Share2,
  ClipboardPaste,
  Copy,
  FileText,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { TaskItem } from './TaskItem';
import { ActionItem } from './ActionItem';
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu';
import type { SavedTask } from '@/types/config';
import type { PresetItem } from '@/types/interface';
import { getInterfaceLangKey } from '@/i18n';
import { useResolvedContent } from '@/services/contentResolver';
import {
  exportWithToast,
  exportFileWithToast,
  importTabConfigFromClipboard,
  importTabConfigFromFile,
  getImportErrorType,
} from '@/utils/tabExportImport';
import { generateId, initializeAllOptionValues, sanitizeOptionValues } from '@/stores/helpers';
import { decryptPasswordOptionValues } from '@/utils/passwordOptionValues';
import { isPretaskName, getPretaskItems, buildPretaskDef } from '@/types/pretasks';
import { getStartupSteps } from '@/utils/startupSteps';
import { loggers } from '@/utils/logger';
import { toast } from 'sonner';
import clsx from 'clsx';
import { getAllMxuSpecialTasks, getAllMxuSpecialTasksOptions } from '@/types/specialTasks.ts';

/** 单个预设卡片 */
function PresetCard({ preset, onApply }: { preset: PresetItem; onApply: () => void }) {
  const { resolveI18nText, language, basePath, interfaceTranslations } = useAppStore();
  const { t } = useTranslation();
  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];

  const label = resolveI18nText(preset.label, langKey) || preset.name;
  const resolvedDescription = useResolvedContent(
    preset.description ? resolveI18nText(preset.description, langKey) : undefined,
    basePath,
    translations,
  );

  const presetTasks = preset.task ?? [];
  const enabledCount = presetTasks.filter((t) => t.enabled !== false).length;
  const totalCount = presetTasks.length;

  return (
    <button
      onClick={onApply}
      className={clsx(
        'w-full text-left p-4 rounded-lg border border-border',
        'bg-bg-secondary hover:bg-bg-hover hover:border-accent',
        'transition-colors group',
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Sparkles className="w-4 h-4 text-accent flex-shrink-0" />
        <span className="text-sm font-medium text-text-primary truncate">{label}</span>
        <span className="text-xs text-text-muted ml-auto flex-shrink-0">
          {enabledCount}/{totalCount} {t('preset.taskCount')}
        </span>
      </div>
      {resolvedDescription.html ? (
        <div
          className="text-xs text-text-secondary line-clamp-2 [&_p]:my-0"
          dangerouslySetInnerHTML={{ __html: resolvedDescription.html }}
        />
      ) : resolvedDescription.loading ? (
        <div className="flex items-center gap-1 text-xs text-text-muted">
          <Loader2 className="w-3 h-3 animate-spin" />
        </div>
      ) : null}
    </button>
  );
}

/** 导入按钮 */
function useImportConfigActions(instanceId: string) {
  const {
    projectInterface,
    updateInstance,
    renameInstance,
    setSelectedController,
    setSelectedResource,
  } = useAppStore();
  const { t } = useTranslation();

  const handleImport = async (source: 'clipboard' | 'file') => {
    const projectName = projectInterface?.name;
    if (!projectName || !projectInterface || !instanceId) return;

    try {
      const result =
        source === 'file'
          ? await importTabConfigFromFile(projectName)
          : await importTabConfigFromClipboard(projectName);
      if (!result) return;

      const { tabName, payload } = result;

      const specialTaskDefs = getAllMxuSpecialTasks().map((t) => t.taskDef);
      const specialTaskOptions = getAllMxuSpecialTasksOptions();
      const mergedDefs = [
        ...getPretaskItems(projectInterface).map(buildPretaskDef),
        ...projectInterface.task,
        ...specialTaskDefs,
      ];
      const mergedOptions = { ...projectInterface.option, ...specialTaskOptions };

      const importedTasks = payload.selectedTasks
        .map((task) => {
          const taskDef = mergedDefs.find((t) => t.name === task.taskName);
          if (!taskDef) {
            loggers.config.warn(
              `导入标签页配置时，任务 "${task.taskName}" 在当前 Project Interface 中不存在，已跳过`,
            );
            return null;
          }

          const defaultValues =
            taskDef.option && mergedOptions
              ? initializeAllOptionValues(taskDef.option, mergedOptions)
              : {};
          const cleanedValues = mergedOptions
            ? decryptPasswordOptionValues(
                sanitizeOptionValues(task.optionValues, mergedOptions),
                mergedOptions,
                projectName,
              )
            : {};

          return {
            ...task,
            id: generateId(),
            optionValues: {
              ...defaultValues,
              ...cleanedValues,
            },
            expanded: true,
          };
        })
        .filter((task): task is SavedTask & { expanded: boolean } => task !== null);

      // 任务写入后 PresetSelector 自动消失，无需调用 skipPreset（避免触发 showAddTaskPanel）
      updateInstance(instanceId, {
        selectedTasks: importedTasks,
        ...(payload.controllerName !== undefined && {
          controllerName: payload.controllerName,
        }),
        ...(payload.resourceName !== undefined && {
          resourceName: payload.resourceName,
        }),
        preActions: payload.preActions,
      });

      if (payload.controllerName) {
        setSelectedController(instanceId, payload.controllerName);
      }
      if (payload.resourceName) {
        setSelectedResource(instanceId, payload.resourceName);
      }

      renameInstance(instanceId, tabName);
      toast.success(t('preset.importSuccess'));
    } catch (err) {
      const errorType = getImportErrorType(err);
      if (errorType === 'project_mismatch') {
        toast.error(t('preset.importProjectMismatch'));
      } else if (errorType === 'unsupported_version') {
        toast.error(t('preset.importVersionUnsupported', { projectName }));
      } else {
        toast.error(t('preset.importFailed'));
      }
    }
  };

  return {
    importFromClipboard: () => handleImport('clipboard'),
    importFromFile: () => handleImport('file'),
  };
}

/** 瀵煎叆鎸夐挳 */
function ImportConfigButton({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation();
  const { importFromClipboard, importFromFile } = useImportConfigActions(instanceId);

  return (
    <div className="inline-flex items-center gap-3">
      <button
        onClick={importFromClipboard}
        className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-accent transition-colors"
      >
        <ClipboardPaste className="w-3.5 h-3.5" />
        {t('preset.importConfig')}
      </button>
      <button
        onClick={importFromFile}
        className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-accent transition-colors"
      >
        <FileText className="w-3.5 h-3.5" />
        {t('preset.importConfigFromFile')}
      </button>
    </div>
  );
}

/** 预设选择器 - 任务列表为空时显示 */
function PresetSelector({ instanceId }: { instanceId: string }) {
  const { projectInterface, applyPreset, skipPreset, renameInstance, resolveI18nText, language } =
    useAppStore();
  const { t } = useTranslation();
  const langKey = getInterfaceLangKey(language);

  const presets = projectInterface?.preset;
  if (!presets || presets.length === 0) return null;

  return (
    <div className="flex flex-col items-center gap-4 p-6">
      <div className="text-center space-y-1">
        <Sparkles className="w-8 h-8 text-accent mx-auto opacity-60" />
        <p className="text-sm text-text-secondary">{t('preset.title')}</p>
        <p className="text-xs text-text-muted">{t('preset.hint')}</p>
      </div>
      <div className="w-full max-w-md space-y-2">
        {presets.map((preset) => (
          <PresetCard
            key={preset.name}
            preset={preset}
            onApply={() => {
              applyPreset(instanceId, preset.name);
              const presetDisplayName = resolveI18nText(preset.label, langKey) || preset.name;
              renameInstance(instanceId, presetDisplayName);
            }}
          />
        ))}
      </div>
      <div className="flex items-center gap-4">
        <ImportConfigButton instanceId={instanceId} />
        <span className="text-text-muted/30 text-xs">|</span>
        <button
          onClick={() => skipPreset(instanceId)}
          className="text-xs text-text-muted hover:text-accent transition-colors"
        >
          {t('preset.skipToManual')}
        </button>
      </div>
    </div>
  );
}

export function TaskList() {
  const { t } = useTranslation();
  const {
    getActiveInstance,
    reorderTasks,
    reorderStartupSteps,
    selectAllTasks,
    collapseAllTasks,
    setShowAddTaskPanel,
    showAddTaskPanel,
    lastAddedTaskId,
    clearLastAddedTaskId,
    projectInterface,
    skippedPresetInstanceIds,
  } = useAppStore();

  const instance = getActiveInstance();
  const isInstanceRunning = instance?.isRunning || false;
  const { state: menuState, showAt: showMenuAt, hide: hideMenu } = useContextMenu();
  const { importFromClipboard, importFromFile } = useImportConfigActions(instance?.id ?? '');

  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // 当添加新任务后自动滚动到底部
  useEffect(() => {
    if (lastAddedTaskId && scrollContainerRef.current) {
      // 使用 requestAnimationFrame 确保 DOM 已更新
      requestAnimationFrame(() => {
        // 使用 instant 避免与任务入场动画冲突产生视觉跳动
        scrollContainerRef.current?.scrollTo({
          top: scrollContainerRef.current.scrollHeight,
          behavior: 'instant',
        });
      });
      // 清除标记，避免重复触发
      clearLastAddedTaskId();
    }
  }, [lastAddedTaskId, clearLastAddedTaskId]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // 禁止 X 方向拖动，仅允许垂直排序
  const restrictHorizontalMovement: Modifier = ({ transform }) => ({
    ...transform,
    x: 0,
  });

  const handleDragEnd = (event: DragEndEvent) => {
    if (isInstanceRunning) return;
    const { active, over } = event;
    if (over && active.id !== over.id && instance) {
      const oldIndex = instance.selectedTasks.findIndex((t) => t.id === active.id);
      const newIndex = instance.selectedTasks.findIndex((t) => t.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return;
      reorderTasks(instance.id, oldIndex, newIndex);
    }
  };

  const handleStartupDragEnd = (event: DragEndEvent) => {
    if (isInstanceRunning || !instance) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const steps = getStartupSteps(instance, projectInterface);
    const from = steps.findIndex(({ item }) => item.id === active.id);
    const to = steps.findIndex(({ item }) => item.id === over.id);
    reorderStartupSteps(instance.id, from, to);
  };

  // 任务列表区域右键菜单
  const handleListContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!instance) return;
      const position = { x: e.clientX, y: e.clientY };

      const tasks = instance.selectedTasks;
      const hasEnabledTasks = tasks.some((t) => t.enabled || t.runOnce);
      const hasExpandedTasks = tasks.some((t) => t.expanded);
      const hasTasks = tasks.length > 0;
      const projectName = projectInterface?.name;
      const exportHint = projectName
        ? t('preset.exportShareHint', { projectName, tabName: instance.name })
        : '';
      const exportFooter = projectName ? t('preset.exportShareFooter', { projectName }) : '';
      const exportOptions = projectInterface?.option;

      const menuItems: MenuItem[] = [
        {
          id: 'add',
          label: t('contextMenu.addTask'),
          icon: Plus,
          onClick: () => setShowAddTaskPanel(!showAddTaskPanel),
        },
        ...(hasTasks
          ? [
              { id: 'divider-1', label: '', divider: true },
              {
                id: 'select-all',
                label: hasEnabledTasks ? t('contextMenu.deselectAll') : t('contextMenu.selectAll'),
                icon: hasEnabledTasks ? Square : CheckSquare,
                onClick: () => selectAllTasks(instance.id, !hasEnabledTasks),
              },
              {
                id: 'collapse-all',
                label: hasExpandedTasks
                  ? t('contextMenu.collapseAllTasks')
                  : t('contextMenu.expandAllTasks'),
                icon: hasExpandedTasks ? ChevronUp : ChevronDown,
                onClick: () => collapseAllTasks(instance.id, !hasExpandedTasks),
              },
            ]
          : []),
        { id: 'divider-export', label: '', divider: true },
        {
          id: 'import',
          label: t('contextMenu.importConfig'),
          icon: ClipboardPaste,
          disabled: !projectName,
          children: [
            {
              id: 'import-clipboard',
              label: t('contextMenu.importFromClipboard'),
              icon: ClipboardPaste,
              onClick: importFromClipboard,
            },
            {
              id: 'import-file',
              label: t('contextMenu.importFromTxt'),
              icon: FileText,
              onClick: importFromFile,
            },
          ],
        },
        {
          id: 'export',
          label: t('contextMenu.exportConfig'),
          icon: Share2,
          disabled: !hasTasks || !projectName,
          children: [
            {
              id: 'export-clipboard',
              label: t('contextMenu.exportToClipboard'),
              icon: Copy,
              onClick: () => {
                if (projectName) {
                  exportWithToast(
                    instance,
                    projectName,
                    exportHint,
                    exportFooter,
                    {
                      success: t('preset.exportSuccess'),
                      failed: t('preset.exportFailed'),
                    },
                    exportOptions,
                  );
                }
              },
            },
            {
              id: 'export-file',
              label: t('contextMenu.exportToTxt'),
              icon: FileText,
              onClick: () => {
                if (projectName) {
                  exportFileWithToast(
                    instance,
                    projectName,
                    exportHint,
                    exportFooter,
                    {
                      success: t('preset.exportFileSuccess'),
                      failed: t('preset.exportFileFailed'),
                    },
                    exportOptions,
                  );
                }
              },
            },
          ],
        },
      ];

      showMenuAt(position, menuItems);
    },
    [
      t,
      instance,
      showAddTaskPanel,
      setShowAddTaskPanel,
      selectAllTasks,
      collapseAllTasks,
      showMenuAt,
      projectInterface,
      importFromClipboard,
      importFromFile,
    ],
  );

  if (!instance) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted">
        {t('taskList.noTasks')}
      </div>
    );
  }

  const tasks = instance.selectedTasks;
  const startupSteps = getStartupSteps(instance, projectInterface);
  const normalTasks = tasks.filter((t) => !isPretaskName(t.taskName));

  const preActions = instance.preActions ?? [];
  const showPreActions = preActions.length > 0;

  const hasPresets =
    (projectInterface?.preset?.length ?? 0) > 0 && !skippedPresetInstanceIds.has(instance.id);

  if (tasks.length === 0 && !showPreActions) {
    return (
      <>
        <div className="flex-1 overflow-y-auto" onContextMenu={handleListContextMenu}>
          {hasPresets ? (
            <PresetSelector instanceId={instance.id} />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-text-muted gap-3">
              <ListTodo className="w-12 h-12 opacity-30" />
              <p className="text-sm">{t('taskList.noTasks')}</p>
              <p className="text-xs">{t('taskList.dragToReorder')}</p>
              <ImportConfigButton instanceId={instance.id} />
            </div>
          )}
        </div>
        {menuState.isOpen && (
          <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
        )}
      </>
    );
  }

  const startupCards = startupSteps.length > 0 && (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleStartupDragEnd}
      modifiers={[restrictHorizontalMovement]}
    >
      <SortableContext
        items={startupSteps.map(({ item }) => item.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="space-y-2">
          {startupSteps.map((step, index) =>
            step.type === 'pretask' ? (
              <TaskItem key={step.item.id} instanceId={instance.id} task={step.item} />
            ) : (
              <ActionItem
                key={step.item.id}
                instanceId={instance.id}
                action={step.item}
                disabled={isInstanceRunning}
                canReorder={!isInstanceRunning && startupSteps.length > 1}
                index={index}
                total={startupSteps.length}
              />
            ),
          )}
        </div>
      </SortableContext>
    </DndContext>
  );

  if (tasks.length === 0) {
    return (
      <>
        <div
          className="flex-1 flex flex-col overflow-y-auto p-3 gap-2"
          onContextMenu={handleListContextMenu}
        >
          {startupCards}

          {hasPresets ? (
            <PresetSelector instanceId={instance.id} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-3 min-h-[120px]">
              <ListTodo className="w-12 h-12 opacity-30" />
              <p className="text-sm">{t('taskList.noTasks')}</p>
              <p className="text-xs">{t('taskList.dragToReorder')}</p>
              <ImportConfigButton instanceId={instance.id} />
            </div>
          )}
        </div>
        {menuState.isOpen && (
          <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
        )}
      </>
    );
  }

  return (
    <>
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden p-3"
        onClick={() => showAddTaskPanel && setShowAddTaskPanel(false)}
        onContextMenu={handleListContextMenu}
      >
        <div className="space-y-2">
          {startupCards}

          {/* 任务列表 */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            modifiers={[restrictHorizontalMovement]}
          >
            <SortableContext
              items={normalTasks.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {normalTasks.map((task) => (
                  <TaskItem key={task.id} instanceId={instance.id} task={task} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </div>
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}
    </>
  );
}
