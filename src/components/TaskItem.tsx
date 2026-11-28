import { PiIcon } from './PiContent';
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
import clsx from 'clsx';
import { loggers } from '@/utils/logger';
import { isPasswordInput } from '@/utils/passwordOptionValues';

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

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded',
        'text-text-tertiary',
        'max-w-[140px]',
      )}
      title={`${label}: ${value}`}
    >
      {type === 'switch' ? (
        // Switch 类型：显示选项名 + 状态圆点
        <>
          <span className="truncate">{truncateText(label, 6)}</span>
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
          <span className="truncate flex-shrink-0">{truncateText(label, 4)}</span>
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
    <div className="space-y-3">
      {groups.map((group, index) => {
        const anchorKey = group.type === 'switchGrid' ? `__grid_${index}` : group.optionKey;
        const anchorDef =
          group.type === 'switchGrid'
            ? getOptionDef(group.optionKeys[0])
            : getOptionDef(group.optionKey);
        const anchorIsMxu =
          (group.type === 'switchGrid' ? group.optionKeys[0] : group.optionKey)?.startsWith(
            '__MXU_',
          ) ?? false;
        const anchorLabel = anchorDef
          ? anchorIsMxu
            ? t(anchorDef.label || '')
            : resolveI18nText(anchorDef.label, langKey) || ''
          : '';
        return (
          <div
            key={anchorKey}
            data-group-anchor={anchorKey}
            data-group-label={anchorLabel || anchorKey}
          >
            {group.type === 'switchGrid' ? (
              <SwitchGrid
                instanceId={instanceId}
                taskId={taskId}
                items={buildSwitchGridItems(group.optionKeys)}
                disabled={disabled}
              />
            ) : (
              <OptionEditor
                instanceId={instanceId}
                taskId={taskId}
                optionKey={group.optionKey}
                value={optionValues[group.optionKey]}
                disabled={disabled || isGroupOptionIncompatible(group.optionKey)}
                controllerIncompatible={isGroupOptionIncompatible(group.optionKey)}
                parentIncompatibilityReason={
                  isOptionControllerIncompatible(
                    getOptionDef(group.optionKey),
                    currentControllerName,
                  )
                    ? 'controller'
                    : isOptionResourceIncompatible(
                          getOptionDef(group.optionKey),
                          currentResourceName,
                        )
                      ? 'resource'
                      : undefined
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );

  function isGroupOptionIncompatible(optionKey: string): boolean {
    const def = getOptionDef(optionKey);
    return (
      isOptionControllerIncompatible(def, currentControllerName) ||
      isOptionResourceIncompatible(def, currentResourceName)
    );
  }
}

/** 分组导航：为面包屑与分段条提供「当前组 / 各组权重」 */
interface GroupNav {
  labels: string[];
  activeIndex: number;
  subLabel: string;
  nestedGroupCount: number;
  jumpTo: (index: number) => void;
}

function useGroupNav(
  panelRef: React.RefObject<HTMLDivElement | null>,
  cardRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  resolveKeyLabel: (key: string) => string,
): GroupNav {
  const layoutRef = useRef<{ anchors: HTMLElement[]; key: string; stickyHeight: number }>({
    anchors: [],
    key: '',
    stickyHeight: 0,
  });
  const [labels, setLabels] = useState<string[]>([]);
  const [nestedGroupCount, setNestedGroupCount] = useState(0);
  const [active, setActive] = useState<{ index: number; sub: string }>({ index: 0, sub: '' });

  // 布局测量：只在展开状态/尺寸变化时跑，且结果没变就不 setState
  const measureLayout = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) {
      if (layoutRef.current.key !== '') {
        layoutRef.current = { anchors: [], key: '', stickyHeight: 0 };
        setLabels([]);
        setNestedGroupCount(0);
      }
      return;
    }
    const anchors = Array.from(panel.querySelectorAll<HTMLElement>('[data-group-anchor]'));
    const nextLabels = anchors.map((a) => a.dataset.groupLabel ?? '');
    const nextNested = anchors.filter(
      (a) => a.querySelector('[data-option-depth="1"]') !== null,
    ).length;
    // 吸顶块高度缓存下来，滚动时不再重复读取
    const stickyHeight =
      cardRef.current?.querySelector<HTMLElement>('[data-task-sticky]')?.getBoundingClientRect()
        .height ?? 0;
    const key = `${nextLabels.join('\u0001')}#${nextNested}#${Math.round(stickyHeight)}`;
    if (key === layoutRef.current.key) return;
    layoutRef.current = { anchors, key, stickyHeight };
    setLabels(nextLabels);
    setNestedGroupCount(nextNested);
  }, [panelRef, cardRef]);

  // 子组名只在「当前分组变化」时算一次，不在滚动帧里算
  const resolveSubLabel = useCallback(
    (index: number) => {
      const panel = panelRef.current;
      const scroller = panel?.closest('[data-skin-slot="task-list"]');
      if (!panel || !scroller) return '';
      const anchors = panel.querySelectorAll<HTMLElement>('[data-group-anchor]');
      const nested = anchors[index]?.querySelectorAll<HTMLElement>('[data-option-depth="1"]');
      if (!nested) return '';
      const scrollerTop = scroller.getBoundingClientRect().top;
      const threshold = layoutRef.current.stickyHeight + 4;
      let sub = '';
      for (const node of nested) {
        if (node.getBoundingClientRect().top - scrollerTop > threshold) break;
        const key = node.dataset.optionKey;
        if (key) sub = resolveKeyLabel(key);
      }
      return sub;
    },
    [panelRef, resolveKeyLabel],
  );

  useEffect(() => {
    if (!enabled) return;
    const panel = panelRef.current;
    const card = cardRef.current;
    if (!panel || !card) return;
    const scroller = panel.closest('[data-skin-slot="task-list"]') as HTMLElement | null;
    if (!scroller) return;

    let observer: IntersectionObserver | null = null;
    let bottomObserver: IntersectionObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let debounceTimer = 0;
    let lastSignature = '';

    const applyActive = (index: number) => {
      setActive((prev) => {
        if (prev.index === index) return prev;
        // 换组时才读一次 DOM 求子组名
        const sub = resolveSubLabel(index);
        return { index, sub };
      });
    };

    // 用 IntersectionObserver 代替 scroll + rAF + getBoundingClientRect：
    // 滚动时主线程完全不跑测量代码，判定由浏览器合成阶段完成。
    const attach = () => {
      measureLayout();
      const anchors = layoutRef.current.anchors;
      if (!anchors.length) return;

      const stickyHeight = Math.round(layoutRef.current.stickyHeight);
      const viewHeight = scroller.clientHeight;
      // 签名要覆盖所有会改变相交带或锚点身份的输入：
      // 锚点顺序/数量、吸顶高度、滚动视口高度、以及锚点元素本身是否被替换
      const sameFirstAnchor = anchors[0] === layoutRef.current.anchors[0];
      const signature = `${anchors.map((a) => a.dataset.groupAnchor ?? '').join(',')}|${stickyHeight}|${viewHeight}|${sameFirstAnchor ? 1 : 0}`;
      if (signature === lastSignature) return;
      lastSignature = signature;

      observer?.disconnect();
      bottomObserver?.disconnect();
      // 目标带：吸顶头下沿起、高 1px 的一条横线
      const top = stickyHeight + 2;
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const index = anchors.indexOf(entry.target as HTMLElement);
            if (index >= 0) applyActive(index);
          }
        },
        {
          root: scroller,
          rootMargin: `-${top}px 0px -${Math.max(1, viewHeight - top - 1)}px 0px`,
        },
      );
      for (const anchor of anchors) observer.observe(anchor);

      // 最后一个分组可能短到滚不到顶部相交带（滚到底了它也没越过顶线），
      // 因此单独盯一个贴在面板末尾的哨兵：它进入视口底部区域即判定为"到底"。
      const sentinel = panel.querySelector('[data-group-sentinel]');
      if (sentinel) {
        bottomObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) applyActive(anchors.length - 1);
            }
          },
          {
            root: scroller,
            rootMargin: `-${Math.max(0, viewHeight - 40)}px 0px 0px 0px`,
          },
        );
        bottomObserver.observe(sentinel);
      }
    };

    attach();
    applyActive(0);

    // 展开/折叠动画期间面板每帧都在变尺寸，防抖后再重算，避开动画帧
    const scheduleAttach = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(attach, 150);
    };
    resizeObserver = new ResizeObserver(scheduleAttach);
    resizeObserver.observe(panel);
    // 滚动容器自身高度变化（窗口缩放/侧栏折叠）也要重建相交带
    resizeObserver.observe(scroller);

    return () => {
      window.clearTimeout(debounceTimer);
      observer?.disconnect();
      bottomObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [enabled, measureLayout, resolveSubLabel, panelRef]);

  const jumpTo = useCallback(
    (index: number) => {
      const panel = panelRef.current;
      const scroller = panel?.closest('[data-skin-slot="task-list"]');
      if (!panel || !scroller) return;
      const target = panel.querySelectorAll<HTMLElement>('[data-group-anchor]')[index];
      if (!target) return;
      const sticky = cardRef.current?.querySelector<HTMLElement>('[data-task-sticky]');
      const offset = (sticky?.getBoundingClientRect().height ?? 0) + 6;
      const top =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        offset;
      scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    },
    [panelRef, cardRef],
  );

  return {
    labels,
    activeIndex: active.index,
    subLabel: active.sub,
    nestedGroupCount,
    jumpTo,
  };
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
    instances,
    findMaaTaskIdBySelectedTaskId,
    basePath,
    interfaceTranslations,
    animatingTaskIds,
    removeAnimatingTaskId,
  } = useAppStore();

  // 获取任务运行状态
  const taskRunStatus: TaskRunStatus = instanceTaskRunStatus[instanceId]?.[task.id] || 'idle';

  // 获取实例运行状态
  const instance = instances.find((i) => i.id === instanceId);
  const isInstanceRunning = instance?.isRunning || false;

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
  const isCompact = isInstanceRunning && !task.enabled && !task.runOnce && taskRunStatus === 'idle';

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

  // 合并 sortable ref、动画 ref 与分组导航用的卡片 ref
  const cardRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      animationElementRef.current = node;
      cardRef.current = node;
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
  // 有选项或有描述时都可以展开
  const canExpand = hasOptions || hasDescription;

  // 分组导航：把 option key 解析成显示名，供面包屑第三级使用
  const resolveKeyLabel = useCallback(
    (key: string) => {
      const isMxuOption = key.startsWith('__MXU_');
      const def = isMxuOption ? findMxuOptionByKey(key) : projectInterface?.option?.[key];
      if (!def) return '';
      return isMxuOption ? t(def.label || key) : resolveI18nText(def.label, langKey) || key;
    },
    [projectInterface?.option, resolveI18nText, langKey, t],
  );
  // 至少存在 2 个「带子选项的顶层分组」时，面包屑与分段条才有意义；
  // 只有 1 个分组或者全是平铺叶子项时收起这套导航，避免噪音。
  const hasNestedGroups = useMemo(() => {
    const keys = taskDef?.option ?? [];
    const groupCount = keys.filter((key) => {
      const isMxuOption = key.startsWith('__MXU_');
      const def = isMxuOption ? findMxuOptionByKey(key) : projectInterface?.option?.[key];
      if (!def) return false;
      if (def.type === 'switch') return switchHasNestedOptions(def);
      const cases = (def as { cases?: CaseItem[] }).cases;
      return Boolean(cases?.some((item) => (item.option?.length ?? 0) > 0));
    }).length;
    return groupCount >= 2;
  }, [taskDef?.option, projectInterface?.option]);

  const navEnabled = canExpand && Boolean(task.expanded) && hasNestedGroups;
  const nav = useGroupNav(panelRef, cardRef, navEnabled, resolveKeyLabel);
  const navVisible = navEnabled && nav.nestedGroupCount >= 2;

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
      ];

      showMenu(e, menuItems);
    },
    [
      t,
      task.runOnce,
      instanceId,
      task.id,
      isInstanceRunning,
      isIncompatible,
      setTaskRunOnce,
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
        data-skin-slot="task-item"
        data-task-status={taskRunStatus}
        data-expanded={task.expanded}
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
      data-skin-slot="task-item"
      data-task-status={taskRunStatus}
      data-expanded={task.expanded}
      data-task-enabled={task.enabled ? 'true' : 'false'}
      data-task-title={displayName}
      style={style}
      onContextMenu={handleContextMenu}
      className={clsx(
        // overflow-clip 只在展开时需要（要给 sticky 头部让路同时裁圆角），
        // 折叠卡片没有溢出内容，省掉每张卡一个裁剪层
        'group bg-bg-secondary rounded-lg border border-border transition-shadow relative',
        task.expanded && 'overflow-clip',
        isDragging && 'shadow-lg opacity-50',
        taskRunStatus === 'running' && 'task-item-running',
        isAnimating && 'animate-task-slide-in',
      )}
    >
      {/* 任务状态指示器（左侧竖条） */}
      {taskRunStatus !== 'idle' && (
        <div
          className={clsx(
            'absolute left-0 top-0 bottom-0 w-1.5 transition-colors z-20',
            getStatusIndicatorClass(),
          )}
          title={t(`taskItem.status.${taskRunStatus}`)}
        />
      )}

      {/* 吸顶块：标题行 +（展开时）面包屑与分段条，保证滚动时始终能定位 */}
      <div
        data-task-sticky
        className={clsx(
          'bg-bg-secondary',
          // sticky 只在展开时需要；折叠卡片没有可滚动内容，省掉每张卡的 sticky 计算
          task.expanded
            ? 'sticky top-0 z-10 rounded-t-[inherit] border-b border-border'
            : 'rounded-[inherit]',
        )}
      >
        <div data-skin-slot="task-item-head" className="flex items-center gap-2 p-3">
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

          <PiIcon icon={taskDef?.icon} />
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
                      task.enabled
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
                    {/* 展开时：面包屑占住标题与箭头之间的空位（不再单独占一行） */}
                    {task.expanded && navVisible && (
                      <div
                        className="ml-2 flex min-w-0 flex-1 items-center gap-1 text-[11px] text-text-muted"
                        // 面包屑在「点击展开/折叠」区域内，点它不应该顺手把任务折叠掉
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            nav.jumpTo(nav.activeIndex);
                          }}
                          className="max-w-[50%] truncate text-accent-light hover:underline"
                          title={nav.labels[nav.activeIndex]}
                        >
                          {nav.labels[nav.activeIndex]}
                        </button>
                        {nav.subLabel && (
                          <>
                            <span className="shrink-0 text-border-strong">›</span>
                            <span className="min-w-0 truncate">{nav.subLabel}</span>
                          </>
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
      </div>

      {/* 展开面板（描述和/或选项）- 使用 grid 动画实现平滑展开/折叠 */}
      {canExpand && (
        <div
          className="grid transition-[grid-template-rows] duration-150 ease-out"
          style={{ gridTemplateRows: task.expanded ? '1fr' : '0fr' }}
        >
          <div className={clsx('min-h-0', task.expanded ? 'overflow-visible' : 'overflow-hidden')}>
            <div ref={panelRef} className="bg-bg-tertiary p-3 rounded-b-lg">
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
              {/* 哨兵：供「滚到底时选中最后一个分组」判定，不参与布局 */}
              {hasOptions && <div data-group-sentinel className="h-px w-full" aria-hidden="true" />}
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
