import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, CornerUpLeft, GripVertical, Trash2 } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';

import { ContextMenu, useContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import { OptionListRenderer } from './TaskItem';
import { useAppStore } from '@/stores/appStore';
import {
  getChildStatusByIndex,
  useContainerStatusVersion,
} from '@/services/containerStatusService';
import { getInterfaceLangKey } from '@/i18n';
import { getContainerDefinition } from '@/types/containerTasks';
import { getChildDisplaySegments } from '@/utils/containerDisplay';
import type { SelectedTask } from '@/types/interface';

interface ContainerChildItemProps {
  instanceId: string;
  task: SelectedTask;
}

/** 状态灯类名（橙 = 即将执行并呼吸，绿 = 已完成，红 = 失败，灰 = 未执行） */
const STATUS_INDICATOR_CLASS: Record<string, string> = {
  next: 'bg-warning container-next-indicator',
  succeeded: 'bg-success',
  failed: 'bg-error',
  pending: 'bg-text-muted',
};

/**
 * 容器内的子任务行：缩进展示、运行时状态灯（来自项目侧状态文件）、
 * 独立配置入口（展开后渲染该任务自身的全部选项，随容器运行时由 MXU
 * 合并下发）与移出容器操作。子任务不进入主运行队列。
 */
export function ContainerChildItem({ instanceId, task }: ContainerChildItemProps) {
  const { t } = useTranslation();
  const setTaskParent = useAppStore((s) => s.setTaskParent);
  const removeTaskFromInstance = useAppStore((s) => s.removeTaskFromInstance);
  const toggleTaskExpanded = useAppStore((s) => s.toggleTaskExpanded);
  const projectInterface = useAppStore((s) => s.projectInterface);
  const language = useAppStore((s) => s.language);
  const resolveI18nText = useAppStore((s) => s.resolveI18nText);
  const instance = useAppStore((s) => s.instances.find((i) => i.id === instanceId));

  useContainerStatusVersion();
  // 槽位索引 = 条目在容器内的位置；状态文件按槽位索引记录
  const parentTask = instance?.selectedTasks.find((t) => t.id === task.parentId);
  const slotIndex =
    instance && parentTask
      ? instance.selectedTasks
          .filter((t) => t.parentId === parentTask.id)
          .findIndex((t) => t.id === task.id)
      : -1;
  const status = parentTask
    ? getChildStatusByIndex(parentTask.taskName, Math.max(slotIndex, 0))
    : 'pending';

  const isInstanceRunning = instance?.isRunning ?? false;
  const canReorder = !isInstanceRunning;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled: !canReorder,
  });
  const constrainedTransform = transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null;
  const style = {
    transform: CSS.Transform.toString(constrainedTransform),
    transition,
  };

  const taskDef = projectInterface?.task.find((td) => td.name === task.taskName);
  const langKey = getInterfaceLangKey(language);
  const containerDef = parentTask ? getContainerDefinition(parentTask.taskName) : undefined;
  // 容器已接管的选项（如执行周期/星期勾选）不在子条目配置中展示
  const hiddenKeys = containerDef?.childHiddenOptions[task.taskName] ?? [];
  const optionKeys = (taskDef?.option ?? []).filter((key) => !hiddenKeys.includes(key));
  const hasOptions = optionKeys.length > 0;
  const canEditOptions = !isInstanceRunning;
  const currentControllerName = instance?.controllerName || projectInterface?.controller[0]?.name;
  const currentResourceName = instance?.resourceName || projectInterface?.resource[0]?.name;
  // 显示名：协议空间等条目按所选分页/细分种类动态命名（协议空间-类型-细分种类）
  const baseLabel = resolveI18nText(taskDef?.label, langKey) || taskDef?.name || task.taskName;
  const suffixSegments = containerDef
    ? getChildDisplaySegments(containerDef, task, projectInterface?.option)
        .map((key) => resolveI18nText(key, langKey))
        .filter((segment) => segment.length > 0)
    : [];
  const displayName = task.customName || [baseLabel, ...suffixSegments].join('-');

  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();

  const releaseFromContainer = useCallback(() => {
    setTaskParent(instanceId, task.id, null);
  }, [instanceId, setTaskParent, task.id]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!canReorder) return;
      const menuItems: MenuItem[] = [
        {
          id: 'release-from-container',
          label: t('container.releaseChild'),
          icon: CornerUpLeft,
          onClick: releaseFromContainer,
        },
        {
          id: 'delete-child-task',
          label: t('contextMenu.deleteTask'),
          icon: Trash2,
          danger: true,
          onClick: () => removeTaskFromInstance(instanceId, task.id),
        },
      ];
      showMenu(e, menuItems);
    },
    [canReorder, releaseFromContainer, removeTaskFromInstance, instanceId, task.id, t, showMenu],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx('relative ml-6 pl-3', isDragging && 'opacity-60')}
      onContextMenu={handleContextMenu}
    >
      {/* 嵌套连接线 */}
      <div className="absolute left-0 top-0 bottom-0 w-px bg-border" />
      <div className="absolute left-0 top-0 h-1/2 w-3 rounded-bl-md border-b border-l border-border" />
      <div
        className={clsx(
          'group relative flex items-center gap-2 rounded-md bg-bg-secondary px-2 py-1.5 text-sm',
          'border border-transparent hover:border-border',
        )}
      >
        {/* 状态灯（左侧竖条） */}
        <div
          className={clsx(
            'absolute left-0 top-0 bottom-0 w-1.5 rounded-l-md transition-colors',
            STATUS_INDICATOR_CLASS[status],
          )}
          title={t(`container.childStatus.${status}`)}
        />
        <span
          className={clsx(
            'ml-1 text-text-muted',
            canReorder ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed opacity-50',
          )}
          {...attributes}
          {...(canReorder ? listeners : {})}
        >
          <GripVertical className="w-3.5 h-3.5" />
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => hasOptions && toggleTaskExpanded(instanceId, task.id)}
        >
          <span className="flex-1 truncate">{displayName}</span>
          {hasOptions && (
            <ChevronDown
              className={clsx(
                'w-3.5 h-3.5 flex-shrink-0 text-text-muted transition-transform',
                task.expanded && 'rotate-180',
              )}
            />
          )}
        </button>
        <button
          type="button"
          className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs text-text-muted hover:bg-bg-tertiary hover:text-text group-hover:inline-flex"
          onClick={releaseFromContainer}
          disabled={!canReorder}
          title={t('container.releaseChild')}
        >
          <CornerUpLeft className="w-3 h-3" />
          {t('container.releaseChild')}
        </button>
      </div>
      {/* 子任务自身选项：随容器运行时由 MXU 合并下发 */}
      {hasOptions && (
        <div
          className="grid transition-[grid-template-rows] duration-150 ease-out"
          style={{ gridTemplateRows: task.expanded ? '1fr' : '0fr' }}
        >
          <div className={clsx('min-h-0', task.expanded ? 'overflow-visible' : 'overflow-hidden')}>
            <div className="mt-1 rounded-md border border-border bg-bg-tertiary p-2">
              <OptionListRenderer
                instanceId={instanceId}
                taskId={task.id}
                optionKeys={optionKeys}
                optionValues={task.optionValues}
                disabled={!canEditOptions}
                currentControllerName={currentControllerName}
                currentResourceName={currentResourceName}
              />
            </div>
          </div>
        </div>
      )}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}
    </div>
  );
}
