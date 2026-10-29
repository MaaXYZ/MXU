import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GripVertical,
  ChevronRight,
  X,
  Loader2,
  FileText,
  Link,
  AlertCircle,
  Play,
  CircleDot,
  CalendarDays,
} from 'lucide-react';
import { useAppStore, type TaskRunStatus } from '@/stores/appStore';
import { maaService } from '@/services/maaService';
import { useResolvedContent } from '@/services/contentResolver';
import { generateTaskPipelineOverride } from '@/utils';
import { OptionEditor, SwitchGrid, switchHasNestedOptions } from './OptionEditor';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { Tooltip } from './ui/Tooltip';
import { ConfirmDialog } from './ConfirmDialog';
import { buildListItemMenuItems, InlineNameEditor } from './listItemShared';
import { TriStateCheckbox, getTaskCheckboxState } from './ui/TriStateCheckbox';
import { taskStartService } from '@/services/taskStartService';
import type { MenuItem } from './ContextMenu';
import type { SelectedTask, CaseItem } from '@/types/interface';
import { isMxuSpecialTask, getMxuSpecialTask, findMxuOptionByKey } from '@/types/specialTasks';
import { isPretaskName, getPretaskItem, buildPretaskDef } from '@/types/pretasks';
import { getInterfaceLangKey } from '@/i18n';
import { stripInlineRichText } from '@/utils/richText';
import { isTaskBlockedByWeeklySchedule, normalizeWeeklySchedule } from '@/utils/taskRunFilter';
import { useCurrentWeekday } from '@/hooks/useCurrentWeekday';
import clsx from 'clsx';
import { loggers } from '@/utils/logger';
import { isPasswordInput } from '@/utils/passwordOptionValues';

/** 周计划的全部星期（0=周日）；"启用周计划"时默认全选，启用后行为与启用前一致，再由用户取消不需要的天 */
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** 选项预览标签组件 */
function OptionPreviewTag({
  label,
  value,
  type,
}: {
  label: string;
  value: string;
  type: 'select' | 'checkbox' | 'switch' | 'input';
}) {
  // 截断过长的显示值
  const truncateText = (text: string, max: number) =>
    text.length > max ? text.slice(0, max) + '…' : text;

  // label 可能含行内 Markdown（图标等），预览标签空间有限，统一按纯文本处理
  const plainLabel = stripInlineRichText(label);

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded',
        'text-text-tertiary',
        'max-w-[140px]',
      )}
      title={`${plainLabel}: ${value}`}
    >
      {type === 'switch' ? (
        // Switch 类型：显示选项名 + 状态圆点
        <>
          <span className="truncate">{truncateText(plainLabel, 6)}</span>
          <span
            className={clsx(
              'w-1.5 h-1.5 rounded-full flex-shrink-0',
              value === 'ON' ? 'bg-success/70' : 'bg-text-muted/50',
            )}
          />
        </>
      ) : (
        // Select/Input 类型：显示选项名: 值
        <>
          <span className="truncate flex-shrink-0">{truncateText(plainLabel, 4)}</span>
          <span className="flex-shrink-0">:</span>
          <span className="truncate">{truncateText(value, 6)}</span>
        </>
      )}
    </span>
  );
}

interface TaskItemProps {
  instanceId: string;
  task: SelectedTask;
}

/** 描述内容组件：显示从文件/URL/直接文本解析的内容 */
function DescriptionContent({
  html,
  loading,
  type,
  loaded,
  error,
}: {
  html: string;
  loading: boolean;
  type: 'url' | 'file' | 'text';
  loaded: boolean;
  error?: string;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-text-muted">
        <Loader2 className="w-3 h-3 animate-spin" />
        <span>{t('taskItem.loadingDescription')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* 来源提示 */}
      {loaded && type !== 'text' && (
        <div className="flex items-center gap-1 text-[10px] text-text-muted">
          {type === 'file' ? <FileText className="w-3 h-3" /> : <Link className="w-3 h-3" />}
          <span>{t(type === 'file' ? 'taskItem.loadedFromFile' : 'taskItem.loadedFromUrl')}</span>
        </div>
      )}
      {/* 加载错误提示 */}
      {error && type !== 'text' && (
        <div className="flex items-center gap-1 text-[10px] text-warning">
          <AlertCircle className="w-3 h-3" />
          <span>
            {t('taskItem.loadDescriptionFailed')}: {error}
          </span>
        </div>
      )}
      {/* 内容 */}
      {html && (
        <div
          className="text-xs text-text-secondary [&_p]:my-0.5 [&_a]:text-accent [&_a]:hover:underline"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

/** 选项分组项类型 */
type OptionGroup =
  | { type: 'single'; optionKey: string }
  | { type: 'switchGrid'; optionKeys: string[] };

/** 检查选项是否与当前控制器不兼容 */
function isOptionControllerIncompatible(
  optionDef: import('@/types/interface').OptionDefinition | null | undefined,
  currentControllerName: string | undefined,
): boolean {
  if (!optionDef?.controller || optionDef.controller.length === 0) return false;
  if (!currentControllerName) return false;
  return !optionDef.controller.includes(currentControllerName);
}

/** v2.3.0: 检查选项是否与当前资源不兼容 */
function isOptionResourceIncompatible(
  optionDef: import('@/types/interface').OptionDefinition | null | undefined,
  currentResourceName: string | undefined,
): boolean {
  if (!optionDef?.resource || optionDef.resource.length === 0) return false;
  if (!currentResourceName) return false;
  return !optionDef.resource.includes(currentResourceName);
}

/** 选项列表渲染器：自动将连续的无子选项 switch 分组为网格 */
function OptionListRenderer({
  instanceId,
  taskId,
  optionKeys,
  optionValues,
  disabled,
  currentControllerName,
  currentResourceName,
}: {
  instanceId: string;
  taskId: string;
  optionKeys: string[];
  optionValues: Record<string, import('@/types/interface').OptionValue>;
  disabled: boolean;
  currentControllerName: string | undefined;
  currentResourceName: string | undefined;
}) {
  const { projectInterface, resolveI18nText, language } = useAppStore();
  const { t } = useTranslation();
  const langKey = getInterfaceLangKey(language);

  // 获取选项定义（支持 MXU 特殊任务）
  const getOptionDef = (optionKey: string) => {
    const isMxuOption = optionKey.startsWith('__MXU_');
    return isMxuOption ? findMxuOptionByKey(optionKey) : projectInterface?.option?.[optionKey];
  };

  // 将选项分组：连续 5 个以上无子选项的 switch 合并为网格
  const groups = useMemo(() => {
    const result: OptionGroup[] = [];
    let currentSwitchGroup: string[] = [];

    const flushSwitchGroup = () => {
      if (currentSwitchGroup.length > 4) {
        // 超过 4 个，使用网格
        result.push({ type: 'switchGrid', optionKeys: [...currentSwitchGroup] });
      } else {
        // 4 个及以下，单独渲染
        for (const key of currentSwitchGroup) {
          result.push({ type: 'single', optionKey: key });
        }
      }
      currentSwitchGroup = [];
    };

    for (const optionKey of optionKeys) {
      const optionDef = getOptionDef(optionKey);

      // 判断是否为无子选项的 switch
      const isSimpleSwitch = optionDef?.type === 'switch' && !switchHasNestedOptions(optionDef);

      if (isSimpleSwitch) {
        currentSwitchGroup.push(optionKey);
      } else {
        // 非 switch 或有子选项，先刷新当前 switch 组
        flushSwitchGroup();
        result.push({ type: 'single', optionKey });
      }
    }

    // 处理末尾的 switch 组
    flushSwitchGroup();

    return result;
  }, [optionKeys, projectInterface?.option]);

  // 构建 SwitchGrid 的数据
  const buildSwitchGridItems = (keys: string[]) => {
    return keys.map((optionKey) => {
      const optionDef = getOptionDef(optionKey);
      const value = optionValues[optionKey];
      const isChecked = value?.type === 'switch' ? value.value : false;
      const isMxuOption = optionKey.startsWith('__MXU_');

      // 对于 MXU 内置选项，使用 t() 翻译；否则使用 resolveI18nText
      const label = isMxuOption
        ? t(optionDef?.label || optionKey)
        : resolveI18nText(optionDef?.label, langKey) || optionKey;
      const description = isMxuOption
        ? optionDef?.description
          ? t(optionDef.description)
          : undefined
        : resolveI18nText(optionDef?.description, langKey);

      const controllerIncompatible = isOptionControllerIncompatible(
        optionDef,
        currentControllerName,
      );
      const resourceIncompatible = isOptionResourceIncompatible(optionDef, currentResourceName);

      return {
        optionKey,
        label,
        description,
        isChecked,
        controllerIncompatible: controllerIncompatible || resourceIncompatible,
      };
    });
  };

  return (
    <div className="space-y-4">
      {groups.map((group, index) => {
        if (group.type === 'switchGrid') {
          return (
            <SwitchGrid
              key={`grid-${index}`}
              instanceId={instanceId}
              taskId={taskId}
              items={buildSwitchGridItems(group.optionKeys)}
              disabled={disabled}
            />
          );
        }
        const optionDef = getOptionDef(group.optionKey);
        const optionControllerIncompatible = isOptionControllerIncompatible(
          optionDef,
          currentControllerName,
        );
        const optionResourceIncompatible = isOptionResourceIncompatible(
          optionDef,
          currentResourceName,
        );
        const optionIncompatible = optionControllerIncompatible || optionResourceIncompatible;
        const parentIncompatibilityReason = optionControllerIncompatible
          ? 'controller'
          : optionResourceIncompatible
            ? 'resource'
            : undefined;
        return (
          <OptionEditor
            key={group.optionKey}
            instanceId={instanceId}
            taskId={taskId}
            optionKey={group.optionKey}
            value={optionValues[group.optionKey]}
            disabled={disabled || optionIncompatible}
            controllerIncompatible={optionIncompatible}
            parentIncompatibilityReason={parentIncompatibilityReason}
          />
        );
      })}
    </div>
  );
}

export function TaskItem({ instanceId, task }: TaskItemProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [editName, setEditName] = useState('');

  const {
    projectInterface,
    toggleTaskEnabled,
    setTaskRunOnce,
    setTaskWeeklySchedule,
    toggleTaskExpanded,
    removeTaskFromInstance,
    confirmBeforeDelete,
    renameTask,
    duplicateTask,
    moveTaskUp,
    moveTaskDown,
    moveTaskToTop,
    moveTaskToBottom,
    resolveI18nText,
    language,
    getActiveInstance,
    showOptionPreview,
    instanceTaskRunStatus,
    instanceTaskRunSelection,
    instances,
    findMaaTaskIdBySelectedTaskId,
    basePath,
    interfaceTranslations,
    animatingTaskIds,
    removeAnimatingTaskId,
  } = useAppStore();

  // 获取实例运行状态
  const instance = instances.find((i) => i.id === instanceId);
  const isInstanceRunning = instance?.isRunning || false;
  const todayWeekday = useCurrentWeekday();
  const runSelection = instanceTaskRunSelection[instanceId];
  const backendTaskRunStatus: TaskRunStatus =
    instanceTaskRunStatus[instanceId]?.[task.id] || 'idle';
  // 后端正在排队/执行的事实优先；刷新页面恢复的批次可能没有本地筛选快照。
  const hasCurrentExecution =
    backendTaskRunStatus === 'pending' || backendTaskRunStatus === 'running';
  const weeklyScheduleBlockedToday =
    !hasCurrentExecution &&
    (runSelection
      ? runSelection.excludedByWeeklyScheduleIds.includes(task.id)
      : !(isInstanceRunning && backendTaskRunStatus !== 'idle') &&
        isTaskBlockedByWeeklySchedule(task, todayWeekday));
  // 历史成功/失败不能冒充本次结果；显式单独运行、跨午夜时以启动快照为准。
  const taskRunStatus: TaskRunStatus =
    !hasCurrentExecution &&
    (weeklyScheduleBlockedToday ||
      (runSelection && !runSelection.includedTaskIds.includes(task.id)))
      ? 'idle'
      : backendTaskRunStatus;

  // 获取任务定义 - 支持 MXU 内置特殊任务与 pretask 前置任务
  const isMxuTask = isMxuSpecialTask(task.taskName);
  const isPretask = isPretaskName(task.taskName);
  const mxuSpecialTask = isMxuTask ? getMxuSpecialTask(task.taskName) : null;
  const pretaskItem = isPretask ? getPretaskItem(projectInterface, task.taskName) : undefined;
  const taskDef = isMxuTask
    ? mxuSpecialTask?.taskDef
    : isPretask
      ? pretaskItem
        ? buildPretaskDef(pretaskItem)
        : undefined
      : projectInterface?.task.find((t) => t.name === task.taskName);

  // 检查任务是否与当前控制器/资源兼容
  // 未选择时，使用第一个控制器/资源作为默认值判断兼容性
  const currentControllerName = instance?.controllerName || projectInterface?.controller[0]?.name;
  const currentResourceName = instance?.resourceName || projectInterface?.resource[0]?.name;
  const langKey = getInterfaceLangKey(language);

  const isControllerIncompatible = useMemo(() => {
    if (!taskDef?.controller || taskDef.controller.length === 0) return false;
    if (!currentControllerName) return false;
    return !taskDef.controller.includes(currentControllerName);
  }, [taskDef?.controller, currentControllerName]);

  const isResourceIncompatible = useMemo(() => {
    if (!taskDef?.resource || taskDef.resource.length === 0) return false;
    if (!currentResourceName) return false;
    return !taskDef.resource.includes(currentResourceName);
  }, [taskDef?.resource, currentResourceName]);

  const isIncompatible = isControllerIncompatible || isResourceIncompatible;

  // 生成不兼容提示信息
  const incompatibleReason = useMemo(() => {
    if (!isIncompatible) return '';
    const reasons: string[] = [];
    if (isControllerIncompatible) {
      reasons.push(t('taskItem.incompatibleController'));
    }
    if (isResourceIncompatible) {
      reasons.push(t('taskItem.incompatibleResource'));
    }
    return reasons.join(', ');
  }, [isIncompatible, isControllerIncompatible, isResourceIncompatible, t]);

  // 生成支持的控制器提示（用于 Tooltip hover 显示）
  const supportedControllerHint = useMemo(() => {
    if (!isControllerIncompatible || !taskDef?.controller || taskDef.controller.length === 0)
      return '';
    const labels = taskDef.controller.map((name) => {
      const ctrl = projectInterface?.controller.find((c) => c.name === name);
      return ctrl ? resolveI18nText(ctrl.label, langKey) || ctrl.name : name;
    });
    return t('taskItem.supportedControllers', { controllers: labels.join(', ') });
  }, [
    isControllerIncompatible,
    taskDef?.controller,
    projectInterface?.controller,
    resolveI18nText,
    langKey,
    t,
  ]);

  // 紧凑模式：实例运行时，未参与运行的任务显示为紧凑样式
  const isCompact =
    isInstanceRunning &&
    (weeklyScheduleBlockedToday || (!task.enabled && !task.runOnce)) &&
    taskRunStatus === 'idle';

  // 判断是否可以编辑选项：实例未运行时始终可以编辑，运行中只有 pending 或 idle 状态的任务可以编辑
  const canEditOptions =
    !isInstanceRunning || taskRunStatus === 'idle' || taskRunStatus === 'pending';

  // 判断是否可以调整顺序/删除（实例运行时禁用）
  const canReorder = !isInstanceRunning;
  const canDelete = !isInstanceRunning;

  // 用于追踪选项值变化的 ref（避免首次渲染时触发）
  const prevOptionValuesRef = useRef<string | null>(null);

  // 入场动画状态
  const isAnimating = animatingTaskIds.includes(task.id);
  const animationElementRef = useRef<HTMLDivElement | null>(null);

  // 当选项值变化且任务状态为 pending 时，调用 overridePipeline 更新任务配置
  useEffect(() => {
    const currentOptionValues = JSON.stringify(task.optionValues);

    // 首次渲染时只记录当前值，不触发 override
    if (prevOptionValuesRef.current === null) {
      prevOptionValuesRef.current = currentOptionValues;
      return;
    }

    // 如果选项值没有变化，不处理
    if (prevOptionValuesRef.current === currentOptionValues) {
      return;
    }

    // 更新 ref
    prevOptionValuesRef.current = currentOptionValues;

    // 只有 pending 状态的任务才需要调用 overridePipeline
    if (taskRunStatus !== 'pending') {
      return;
    }

    // 获取对应的 maaTaskId
    const maaTaskId = findMaaTaskIdBySelectedTaskId(instanceId, task.id);
    if (maaTaskId === null) {
      return;
    }

    // 生成新的 pipeline override 并调用后端
    const pipelineOverride = generateTaskPipelineOverride(
      task,
      projectInterface,
      currentControllerName,
      currentResourceName,
      useAppStore.getState().globalOptionValues,
    );
    maaService.overridePipeline(instanceId, maaTaskId, pipelineOverride).catch((err) => {
      loggers.task.error('Failed to override pipeline:', err);
    });
  }, [
    task.optionValues,
    taskRunStatus,
    instanceId,
    task.id,
    projectInterface,
    currentControllerName,
    currentResourceName,
  ]);

  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();

  // 获取翻译表
  const translations = interfaceTranslations[langKey];

  // 使用新的 Hook 解析任务描述（支持文件/URL/直接文本）
  const resolvedDescription = useResolvedContent(
    taskDef?.description ? resolveI18nText(taskDef.description, langKey) : undefined,
    basePath,
    translations,
  );

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !canReorder,
  });

  // 禁止 X 方向位移，仅允许垂直拖动；同时忽略 dnd-kit 的缩放分量，
  // 避免拖拽中的半透明项在高度变化时把文本一起纵向拉伸。
  const constrainedTransform = transform
    ? {
        ...transform,
        x: 0,
        scaleX: 1,
        scaleY: 1,
      }
    : null;

  const style = {
    transform: CSS.Transform.toString(constrainedTransform),
    transition,
  };

  // 合并 sortable ref 和动画 ref
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      animationElementRef.current = node;
    },
    [setNodeRef],
  );

  // 动画结束后移除动画状态
  useEffect(() => {
    if (!isAnimating || !animationElementRef.current) return;

    const element = animationElementRef.current;
    const handleAnimationEnd = () => {
      removeAnimatingTaskId(task.id);
    };

    element.addEventListener('animationend', handleAnimationEnd);
    return () => element.removeEventListener('animationend', handleAnimationEnd);
  }, [isAnimating, task.id, removeAnimatingTaskId]);

  // 对于 MXU 内置任务，使用 t() 翻译，否则使用 resolveI18nText
  const originalLabel = taskDef
    ? isMxuTask
      ? t(taskDef.label || taskDef.name)
      : resolveI18nText(taskDef.label, langKey) || taskDef.name
    : '';
  const displayName = task.customName || originalLabel;
  const hasOptions = !!taskDef?.option && taskDef.option.length > 0;
  // 判断是否有描述内容（包括正在加载的情况）
  const hasDescription = !!resolvedDescription.html || resolvedDescription.loading;
  // 周计划：0-6（0=周日）；缺省或空数组表示未启用
  const weeklySchedule = useMemo(
    () => normalizeWeeklySchedule(task.weeklySchedule) ?? [],
    [task.weeklySchedule],
  );
  const hasWeeklySchedule = weeklySchedule.length > 0;
  const weekdayLabels = t('schedule.weekdays', { returnObjects: true }) as string[];
  // 有选项、有描述或启用了周计划时都可以展开
  const canExpand = hasOptions || hasDescription || hasWeeklySchedule;

  // 生成选项预览信息（最多显示3个）
  const optionPreviews = useMemo(() => {
    if (!hasOptions) return [];
    if (!projectInterface?.option && !isMxuTask) return [];

    const previews: {
      key: string;
      label: string;
      value: string;
      type: 'select' | 'checkbox' | 'switch' | 'input';
    }[] = [];
    const maxPreviews = 3;

    for (const optionKey of taskDef.option || []) {
      if (previews.length >= maxPreviews) break;

      // 优先从 projectInterface 查找，MXU 特殊任务从注册表查找
      const isMxuOption = optionKey.startsWith('__MXU_');
      const optionDef = isMxuOption
        ? findMxuOptionByKey(optionKey)
        : projectInterface?.option?.[optionKey];
      if (!optionDef) continue;

      // MXU 特殊任务的 label 是 i18n key，需要用 t() 翻译
      const optionLabel = isMxuOption
        ? t(optionDef.label || optionKey)
        : resolveI18nText(optionDef.label, langKey) || optionKey;
      const optionValue = task.optionValues[optionKey];

      if (optionDef.type === 'switch') {
        const isOn = optionValue?.type === 'switch' ? optionValue.value : false;
        previews.push({
          key: optionKey,
          label: optionLabel,
          value: isOn ? 'ON' : 'OFF',
          type: 'switch',
        });
      } else if (optionDef.type === 'input') {
        const inputValues = optionValue?.type === 'input' ? optionValue.values : {};
        // 获取第一个有值的输入项
        const firstInput = optionDef.inputs[0];
        if (firstInput) {
          const inputValue = inputValues[firstInput.name] || firstInput.default || '';
          if (inputValue) {
            previews.push({
              key: optionKey,
              label: optionLabel,
              value: isPasswordInput(firstInput) ? '••••' : inputValue,
              type: 'input',
            });
          }
        }
      } else if (optionDef.type === 'checkbox') {
        const caseNames =
          optionValue?.type === 'checkbox' ? optionValue.caseNames : optionDef.default_case || [];
        previews.push({
          key: optionKey,
          label: optionLabel,
          value: `${caseNames.length}/${optionDef.cases.length}`,
          type: 'checkbox',
        });
      } else if (optionDef.type === 'select' || optionDef.type === undefined) {
        const caseName =
          optionValue?.type === 'select'
            ? optionValue.caseName
            : optionDef.default_case || optionDef.cases?.[0]?.name || '';
        const selectedCase =
          optionDef.cases?.find((c: CaseItem) => c.name === caseName) ||
          optionDef.cases?.find((c: CaseItem) => c.name === optionDef.default_case) ||
          optionDef.cases?.[0];
        const caseLabel = selectedCase
          ? isMxuOption
            ? t(selectedCase.label || selectedCase.name)
            : resolveI18nText(selectedCase.label, langKey) || selectedCase.name
          : caseName;
        previews.push({
          key: optionKey,
          label: optionLabel,
          value: caseLabel,
          type: 'select',
        });
      }
    }

    return previews;
  }, [
    hasOptions,
    projectInterface?.option,
    taskDef?.option,
    task.optionValues,
    langKey,
    resolveI18nText,
    isMxuTask,
    t,
  ]);

  const checkboxState = getTaskCheckboxState(task.enabled, Boolean(task.runOnce));

  const handleToggleWeeklyScheduleDay = useCallback(
    (day: number) => {
      const next = weeklySchedule.includes(day)
        ? weeklySchedule.filter((d) => d !== day)
        : [...weeklySchedule, day];
      setTaskWeeklySchedule(instanceId, task.id, next);
    },
    [weeklySchedule, instanceId, task.id, setTaskWeeklySchedule],
  );

  const handleCheckboxClick = () => {
    if (isInstanceRunning || isIncompatible) return;
    toggleTaskEnabled(instanceId, task.id);
  };

  const handleCheckboxContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isInstanceRunning || isIncompatible) return;

      const menuItems: MenuItem[] = [
        {
          id: 'run-once',
          label: t('contextMenu.runOnceTask'),
          icon: CircleDot,
          checked: Boolean(task.runOnce),
          onClick: () => setTaskRunOnce(instanceId, task.id, !task.runOnce),
        },
        {
          id: 'clear-run-once',
          label: t('contextMenu.clearRunOnceTask'),
          disabled: !task.runOnce,
          onClick: () => setTaskRunOnce(instanceId, task.id, false),
        },
        {
          id: 'weekly-schedule',
          label: t('contextMenu.enableWeeklySchedule'),
          icon: CalendarDays,
          checked: hasWeeklySchedule,
          onClick: () => {
            const nextEnabled = !hasWeeklySchedule;
            setTaskWeeklySchedule(instanceId, task.id, nextEnabled ? ALL_WEEKDAYS : []);
            // 启用后展开卡片，否则收起状态下看不到周计划区域、没有任何反馈
            if (nextEnabled && !task.expanded) {
              toggleTaskExpanded(instanceId, task.id);
            }
          },
        },
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      task.runOnce,
      task.expanded,
      hasWeeklySchedule,
      instanceId,
      task.id,
      isInstanceRunning,
      isIncompatible,
      setTaskRunOnce,
      setTaskWeeklySchedule,
      toggleTaskExpanded,
      showMenu,
    ],
  );

  const handleRunFromHere = useCallback(async () => {
    if (!instance || isInstanceRunning || isIncompatible) return;
    await taskStartService.start(instance, { startFromTaskId: task.id });
  }, [instance, isInstanceRunning, isIncompatible, task.id]);

  const handleRunSingle = useCallback(async () => {
    if (!instance || isInstanceRunning || isIncompatible) return;
    await taskStartService.start(instance, { singleTaskId: task.id });
  }, [instance, isInstanceRunning, isIncompatible, task.id]);

  const handleNameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isInstanceRunning || isIncompatible) return;
    toggleTaskEnabled(instanceId, task.id);
  };

  const handleSaveEdit = () => {
    renameTask(instanceId, task.id, editName.trim());
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditName('');
  };

  // 右键菜单处理
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const instance = getActiveInstance();
      if (!instance) return;

      const tasks = instance.selectedTasks;
      const taskIndex = tasks.findIndex((t) => t.id === task.id);

      const menuItems: MenuItem[] = [
        {
          id: 'run-from-here',
          label: t('contextMenu.runFromHere'),
          icon: Play,
          disabled: isInstanceRunning || isIncompatible,
          onClick: () => void handleRunFromHere(),
        },
        {
          id: 'run-single',
          label: t('contextMenu.runSingleTask'),
          icon: Play,
          disabled: isInstanceRunning || isIncompatible,
          onClick: () => void handleRunSingle(),
        },
        { id: 'divider-run', label: '', divider: true },
        ...buildListItemMenuItems({
          labels: {
            duplicate: t('contextMenu.duplicateTask'),
            rename: t('contextMenu.renameTask'),
            enable: t('contextMenu.enableTask'),
            disable: t('contextMenu.disableTask'),
            expand: t('contextMenu.expandOptions'),
            collapse: t('contextMenu.collapseOptions'),
            moveUp: t('contextMenu.moveUp'),
            moveDown: t('contextMenu.moveDown'),
            moveToTop: t('contextMenu.moveToTop'),
            moveToBottom: t('contextMenu.moveToBottom'),
            delete: t('contextMenu.deleteTask'),
          },
          isEnabled: task.enabled,
          isExpanded: !!task.expanded,
          canExpand,
          isFirst: taskIndex === 0,
          isLast: taskIndex === tasks.length - 1,
          isLocked: isInstanceRunning,
          onDuplicate: () => duplicateTask(instanceId, task.id),
          onRename: () => {
            setEditName(task.customName || '');
            setIsEditing(true);
          },
          onToggle: () => toggleTaskEnabled(instanceId, task.id),
          onExpand: () => toggleTaskExpanded(instanceId, task.id),
          onMoveUp: () => moveTaskUp(instanceId, task.id),
          onMoveDown: () => moveTaskDown(instanceId, task.id),
          onMoveToTop: () => moveTaskToTop(instanceId, task.id),
          onMoveToBottom: () => moveTaskToBottom(instanceId, task.id),
          onDelete: () => {
            if (!confirmBeforeDelete) {
              removeTaskFromInstance(instanceId, task.id);
              return;
            }
            setShowDeleteConfirm(true);
          },
        }),
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      task,
      instanceId,
      canExpand,
      getActiveInstance,
      duplicateTask,
      toggleTaskEnabled,
      toggleTaskExpanded,
      moveTaskUp,
      moveTaskDown,
      moveTaskToTop,
      moveTaskToBottom,
      removeTaskFromInstance,
      confirmBeforeDelete,
      showMenu,
      isInstanceRunning,
      isIncompatible,
      handleRunFromHere,
      handleRunSingle,
    ],
  );

  if (!taskDef) return null;

  // 状态指示器颜色
  const getStatusIndicatorClass = (): string => {
    switch (taskRunStatus) {
      case 'pending':
        return 'bg-text-muted';
      case 'running':
        return 'bg-accent task-running-indicator';
      case 'succeeded':
        return 'bg-success';
      case 'failed':
        return 'bg-error';
      default:
        return 'bg-transparent';
    }
  };

  // 紧凑模式：只显示最简化的任务项
  if (isCompact) {
    return (
      <div
        ref={setRefs}
        style={style}
        onContextMenu={handleContextMenu}
        className={clsx(
          'group bg-bg-secondary/50 rounded-lg border border-border/50 overflow-hidden',
          'transition-all duration-200',
          isDragging && 'shadow-lg opacity-50',
          isAnimating && 'animate-task-slide-in',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          {/* 复选框 - 紧凑模式下禁用 */}
          <label className="flex items-center cursor-not-allowed opacity-40">
            <input
              type="checkbox"
              checked={false}
              disabled
              className="w-3.5 h-3.5 rounded border-border-strong accent-accent cursor-not-allowed"
            />
          </label>

          {/* 任务名称 - 紧凑显示 */}
          <span className="text-xs text-text-muted/70 truncate">{displayName}</span>
        </div>

        {/* 右键菜单 */}
        {menuState.isOpen && (
          <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
        )}
      </div>
    );
  }

  return (
    <div
      ref={setRefs}
      style={style}
      onContextMenu={handleContextMenu}
      className={clsx(
        'group bg-bg-secondary rounded-lg border border-border transition-shadow relative overflow-hidden',
        isDragging && 'shadow-lg opacity-50',
        taskRunStatus === 'running' && 'task-item-running',
        isAnimating && 'animate-task-slide-in',
      )}
    >
      {/* 任务状态指示器（左侧竖条） */}
      {taskRunStatus !== 'idle' && (
        <div
          className={clsx(
            'absolute left-0 top-0 bottom-0 w-1.5 transition-colors',
            getStatusIndicatorClass(),
          )}
          title={t(`taskItem.status.${taskRunStatus}`)}
        />
      )}

      {/* 任务头部 */}
      <div className="flex items-center gap-2 p-3">
        {/* 拖拽手柄 */}
        <div
          {...attributes}
          {...(canReorder ? listeners : {})}
          className={clsx(
            'p-1 rounded',
            canReorder
              ? 'cursor-grab active:cursor-grabbing hover:bg-bg-hover'
              : 'cursor-not-allowed opacity-30',
          )}
        >
          <GripVertical className="w-4 h-4 text-text-muted" />
        </div>

        {/* 启用复选框 - 运行时或不兼容时禁用 */}
        <div
          className={clsx(
            'flex items-center relative',
            isInstanceRunning || isIncompatible ? 'opacity-50' : '',
          )}
          title={
            isIncompatible
              ? incompatibleReason
              : weeklyScheduleBlockedToday
                ? t('taskItem.weeklyScheduleSkippedTodayHint')
                : checkboxState === 'once'
                  ? t('taskItem.runOnceHint')
                  : undefined
          }
        >
          <TriStateCheckbox
            state={checkboxState}
            disabled={isInstanceRunning || isIncompatible}
            onClick={handleCheckboxClick}
            onContextMenu={handleCheckboxContextMenu}
          />
          {/* 不兼容警告图标 */}
          {isIncompatible && (
            <AlertCircle className="w-3.5 h-3.5 text-warning absolute -top-1 -right-1 pointer-events-none" />
          )}
        </div>

        {/* 任务名称 + 展开区域容器 */}
        <div className="flex-1 flex items-center min-w-0">
          {isEditing ? (
            <InlineNameEditor
              value={editName}
              onChange={setEditName}
              onSave={handleSaveEdit}
              onCancel={handleCancelEdit}
              placeholder={originalLabel}
            />
          ) : (
            <>
              {/* 任务名称：单击切换选中 */}
              <div
                className={clsx(
                  'flex items-center gap-1 min-w-0 overflow-hidden',
                  isInstanceRunning || isIncompatible ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
                onClick={handleNameClick}
                title={t('taskItem.clickToToggle')}
              >
                <span
                  className={clsx(
                    'min-w-0 text-sm font-medium truncate',
                    weeklyScheduleBlockedToday
                      ? 'text-text-muted'
                      : task.enabled
                        ? 'text-text-primary'
                        : task.runOnce
                          ? 'text-accent'
                          : 'text-text-muted',
                  )}
                >
                  {displayName}
                </span>
                {task.customName && (
                  <span className="min-w-0 truncate text-xs text-text-muted">
                    ({originalLabel})
                  </span>
                )}
              </div>

              {weeklyScheduleBlockedToday && (
                <span
                  data-role="weekly-schedule-exclusion"
                  className="ml-2 inline-flex items-center gap-1 shrink-0 rounded bg-bg-hover px-1.5 py-0.5 text-xs text-text-muted"
                  title={t('taskItem.weeklyScheduleSkippedTodayHint')}
                >
                  <CalendarDays className="h-3 w-3" />
                  {t('taskItem.weeklyScheduleSkippedToday')}
                </span>
              )}

              {/* 不带选项的任务：直接显示不兼容警告 */}
              {!canExpand && isIncompatible && (
                <div className="flex-1 flex items-center gap-1.5 mx-2 overflow-hidden">
                  <Tooltip content={supportedControllerHint || undefined}>
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-warning">
                      <AlertCircle className="w-3 h-3" />
                      {incompatibleReason}
                    </span>
                  </Tooltip>
                </div>
              )}

              {/* 展开/折叠点击区域（包含选项预览） */}
              {canExpand && (
                <div
                  onClick={() => toggleTaskExpanded(instanceId, task.id)}
                  className="flex-1 min-w-0 flex items-center self-stretch min-h-[28px] cursor-pointer"
                  title={task.expanded ? t('taskItem.collapse') : t('taskItem.expand')}
                >
                  {/* 选项预览标签 - 未展开时显示：不兼容时显示警告，否则显示选项预览 */}
                  {!task.expanded && (
                    <div className="flex-1 flex items-center gap-1.5 mx-2 overflow-hidden">
                      {isIncompatible ? (
                        <Tooltip content={supportedControllerHint || undefined}>
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-warning">
                            <AlertCircle className="w-3 h-3" />
                            {incompatibleReason}
                          </span>
                        </Tooltip>
                      ) : (
                        showOptionPreview &&
                        optionPreviews.length > 0 &&
                        optionPreviews.map((preview) => (
                          <OptionPreviewTag
                            key={preview.key}
                            label={preview.label}
                            value={preview.value}
                            type={preview.type}
                          />
                        ))
                      )}
                    </div>
                  )}
                  {/* 展开/折叠箭头 */}
                  <div className="flex shrink-0 items-center justify-end pl-2 ml-auto">
                    <ChevronRight
                      className={clsx(
                        'w-4 h-4 text-text-secondary transition-transform duration-150 ease-out',
                        task.expanded && 'rotate-90',
                      )}
                    />
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* 删除按钮 - hover 时显示，运行时隐藏 */}
        {!isEditing && canDelete && (
          <button
            onClick={() => {
              if (!confirmBeforeDelete) {
                removeTaskFromInstance(instanceId, task.id);
                return;
              }
              setShowDeleteConfirm(true);
            }}
            className={clsx(
              'p-1 rounded opacity-0 group-hover:opacity-100 transition-all',
              'text-text-muted hover:bg-error/10 hover:text-error',
            )}
            title={t('taskItem.remove')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 展开面板（描述和/或选项）- 使用 grid 动画实现平滑展开/折叠 */}
      {canExpand && (
        <div
          className="grid transition-[grid-template-rows] duration-150 ease-out"
          style={{ gridTemplateRows: task.expanded ? '1fr' : '0fr' }}
        >
          <div className={clsx('min-h-0', task.expanded ? 'overflow-visible' : 'overflow-hidden')}>
            <div className="border-t border-border bg-bg-tertiary p-3 rounded-b-lg">
              {/* 任务描述 */}
              {hasDescription && (
                <div className={hasOptions || isIncompatible ? 'mb-5' : ''}>
                  <DescriptionContent
                    html={resolvedDescription.html}
                    loading={resolvedDescription.loading}
                    type={resolvedDescription.type}
                    loaded={resolvedDescription.loaded}
                    error={resolvedDescription.error}
                  />
                </div>
              )}
              {/* 不兼容提示 - 独立于选项列表显示 */}
              {isIncompatible && (
                <Tooltip content={supportedControllerHint || undefined}>
                  <div
                    className={clsx(
                      'flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-warning/10 text-warning text-xs',
                      hasOptions && 'mb-3',
                    )}
                  >
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>{incompatibleReason}</span>
                  </div>
                </Tooltip>
              )}
              {/* 周计划区域 - 仅在启用时显示 */}
              {hasWeeklySchedule && (
                <div
                  className={clsx(
                    'rounded-md border border-border bg-bg-primary p-2.5',
                    (hasOptions || isIncompatible) && 'mb-3',
                  )}
                >
                  <div className="flex items-center gap-1.5 mb-2">
                    <CalendarDays className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                    <span className="text-xs font-medium text-text-secondary">
                      {t('taskItem.weeklyScheduleTitle')}
                    </span>
                    {weeklyScheduleBlockedToday && (
                      <span className="text-xs text-text-muted">
                        · {t('taskItem.weeklyScheduleSkippedToday')}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[1, 2, 3, 4, 5, 6, 0].map((day) => {
                      const selected = weeklySchedule.includes(day);
                      const isToday = day === todayWeekday;
                      const dayDisabled = isInstanceRunning || isIncompatible;
                      return (
                        <button
                          key={day}
                          type="button"
                          onClick={() => handleToggleWeeklyScheduleDay(day)}
                          disabled={dayDisabled}
                          title={isToday ? t('taskItem.weeklyScheduleToday') : undefined}
                          className={clsx(
                            'px-2 py-1 text-xs rounded border transition-colors',
                            selected
                              ? 'bg-accent text-white border-accent'
                              : 'bg-bg-primary text-text-secondary border-border hover:border-accent hover:text-accent',
                            isToday && !selected && 'ring-1 ring-accent/40',
                            dayDisabled && 'opacity-50 cursor-not-allowed',
                          )}
                        >
                          {weekdayLabels[day]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* 选项列表 - 仅在有选项时显示 */}
              {hasOptions && (
                <OptionListRenderer
                  instanceId={instanceId}
                  taskId={task.id}
                  optionKeys={taskDef.option || []}
                  optionValues={task.optionValues}
                  disabled={!canEditOptions || isIncompatible}
                  currentControllerName={currentControllerName}
                  currentResourceName={currentResourceName}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title={t('taskItem.removeConfirmTitle')}
        message={t('taskItem.removeConfirmMessage')}
        cancelText={t('common.cancel')}
        confirmText={t('common.delete')}
        destructive
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={() => {
          setShowDeleteConfirm(false);
          removeTaskFromInstance(instanceId, task.id);
        }}
      />
    </div>
  );
}
