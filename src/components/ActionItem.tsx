import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, X, GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore } from '@/stores/appStore';
import { ContextMenu, useContextMenu } from './ContextMenu';
import { ConfirmDialog } from './ConfirmDialog';
import { buildListItemMenuItems, InlineNameEditor } from './listItemShared';
import type { ActionConfig } from '@/types/interface';
import clsx from 'clsx';
import { FileField, TextField, SwitchField } from './FormControls';

interface ActionItemProps {
  instanceId: string;
  action: ActionConfig;
  disabled?: boolean;
  canReorder?: boolean;
  index: number;
  total: number;
}

const defaultValues: Omit<ActionConfig, 'id'> = {
  enabled: false,
  program: '',
  args: '',
  waitForExit: false,
  skipIfRunning: true,
  useCmd: false,
};

/** 参数预览标签 */
function ActionPreviewTag({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded text-text-tertiary max-w-[140px]"
      title={`${label}: ${on ? 'ON' : 'OFF'}`}
    >
      <span className="truncate">{label}</span>
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full flex-shrink-0',
          on ? 'bg-success/70' : 'bg-text-muted/50',
        )}
      />
    </span>
  );
}

export function ActionItem({
  instanceId,
  action,
  disabled,
  canReorder,
  index,
  total,
}: ActionItemProps) {
  const { t } = useTranslation();
  const {
    updatePreAction,
    removePreAction,
    renamePreAction,
    duplicatePreAction,
    reorderStartupSteps,
    confirmBeforeDelete,
    backendOS,
  } = useAppStore();

  // useCmd 仅 Windows 后端支持（后端 utils.rs 按 cfg!(target_os = "windows") 消费）
  // 后端 OS 未知（纯前端 dev 预览）时回退到浏览器判断，保持既有行为
  const isWindowsBackend = backendOS
    ? backendOS === 'windows'
    : navigator.userAgent.toLowerCase().includes('win');

  const [expanded, setExpanded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { state: menuState, show: showMenu, hide: hideMenu } = useContextMenu();

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: action.id,
    disabled: !canReorder,
  });

  const constrainedTransform = transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null;

  const style = {
    transform: CSS.Transform.toString(constrainedTransform),
    transition,
  };

  const currentAction = useMemo<ActionConfig>(() => ({ ...defaultValues, ...action }), [action]);

  const defaultTitle = t('action.preAction');
  const displayName = currentAction.customName || defaultTitle;
  const hasConfig = currentAction.program.trim().length > 0;

  const handleRemove = () => {
    if (disabled) return;
    if (confirmBeforeDelete) {
      setShowDeleteConfirm(true);
    } else {
      removePreAction(instanceId, action.id);
    }
  };

  const updateAction = (updates: Partial<ActionConfig>) => {
    updatePreAction(instanceId, action.id, updates);
  };

  const handleToggleEnabled = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    updateAction({ enabled: !currentAction.enabled });
  };

  const handleSaveEdit = () => {
    renamePreAction(instanceId, action.id, editName.trim());
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditName('');
  };

  // 右键菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const menuItems = buildListItemMenuItems({
        labels: {
          duplicate: t('contextMenu.duplicateAction'),
          rename: t('contextMenu.renameAction'),
          enable: t('contextMenu.enableAction'),
          disable: t('contextMenu.disableAction'),
          expand: t('contextMenu.expandAction'),
          collapse: t('contextMenu.collapseAction'),
          moveUp: t('contextMenu.moveUp'),
          moveDown: t('contextMenu.moveDown'),
          moveToTop: t('contextMenu.moveToTop'),
          moveToBottom: t('contextMenu.moveToBottom'),
          delete: t('contextMenu.deleteAction'),
        },
        isEnabled: currentAction.enabled,
        isExpanded: expanded,
        isFirst: index === 0,
        isLast: index === total - 1,
        isLocked: !!disabled,
        onDuplicate: () => duplicatePreAction(instanceId, action.id),
        onRename: () => {
          setEditName(currentAction.customName || '');
          setIsEditing(true);
        },
        onToggle: () => updateAction({ enabled: !currentAction.enabled }),
        onExpand: () => setExpanded(!expanded),
        onMoveUp: () => reorderStartupSteps(instanceId, index, index - 1),
        onMoveDown: () => reorderStartupSteps(instanceId, index, index + 1),
        onMoveToTop: () => reorderStartupSteps(instanceId, index, 0),
        onMoveToBottom: () => reorderStartupSteps(instanceId, index, total - 1),
        onDelete: handleRemove,
      });

      showMenu(e, menuItems);
    },
    [
      t,
      action.id,
      instanceId,
      index,
      total,
      disabled,
      expanded,
      currentAction.enabled,
      currentAction.customName,
      duplicatePreAction,
      reorderStartupSteps,
      updateAction,
      showMenu,
      handleRemove,
    ],
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      onContextMenu={handleContextMenu}
      className={clsx(
        'group rounded-lg border overflow-hidden transition-shadow flex-shrink-0',
        currentAction.enabled
          ? 'bg-bg-secondary border-border'
          : 'bg-bg-secondary/50 border-border/50',
        disabled && 'opacity-50',
        isDragging && 'opacity-50 shadow-lg z-10',
      )}
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 p-3">
        {/* 拖拽手柄 */}
        <div
          {...attributes}
          {...listeners}
          className={clsx(
            'p-1 rounded',
            canReorder
              ? 'cursor-grab active:cursor-grabbing hover:bg-bg-hover'
              : 'opacity-30 cursor-not-allowed',
          )}
        >
          <GripVertical className="w-4 h-4 text-text-muted" />
        </div>

        {/* 启用复选框 */}
        <label
          className={clsx(
            'flex items-center',
            disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
          )}
          onClick={handleToggleEnabled}
        >
          <input
            type="checkbox"
            checked={currentAction.enabled}
            onChange={() => {}}
            disabled={disabled}
            className="w-4 h-4 rounded border-border-strong accent-accent disabled:cursor-not-allowed"
          />
        </label>

        {/* 名称 + 展开区域 */}
        <div className="flex-1 flex items-center min-w-0">
          {isEditing ? (
            <InlineNameEditor
              value={editName}
              onChange={setEditName}
              onSave={handleSaveEdit}
              onCancel={handleCancelEdit}
              placeholder={defaultTitle}
            />
          ) : (
            <>
              {/* 名称：点击切换启用 */}
              <div
                className={clsx(
                  'flex items-center gap-1 min-w-0 overflow-hidden',
                  disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                )}
                onClick={handleToggleEnabled}
              >
                <span
                  className={clsx(
                    'min-w-0 text-sm font-medium truncate',
                    currentAction.enabled ? 'text-text-primary' : 'text-text-muted',
                  )}
                >
                  {displayName}
                </span>
                {currentAction.customName && (
                  <span className="min-w-0 truncate text-xs text-text-muted">({defaultTitle})</span>
                )}
              </div>

              {/* 展开/折叠点击区域（含参数预览） */}
              <div
                onClick={() => setExpanded(!expanded)}
                className="flex-1 min-w-0 flex items-center self-stretch min-h-[28px] cursor-pointer"
              >
                {!expanded && (
                  <div className="flex-1 flex items-center gap-1.5 mx-2 overflow-hidden">
                    {hasConfig ? (
                      <>
                        <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded text-text-tertiary max-w-[180px] truncate">
                          {currentAction.program.split(/[/\\]/).pop()}
                        </span>
                        <ActionPreviewTag
                          label={t('action.waitForExit')}
                          on={currentAction.waitForExit}
                        />
                        <ActionPreviewTag
                          label={t('action.skipIfRunning')}
                          on={currentAction.skipIfRunning}
                        />
                      </>
                    ) : null}
                  </div>
                )}
                <div className="flex shrink-0 items-center justify-end pl-2 ml-auto">
                  <ChevronRight
                    className={clsx(
                      'w-4 h-4 text-text-secondary transition-transform duration-150 ease-out',
                      expanded && 'rotate-90',
                    )}
                  />
                </div>
              </div>
            </>
          )}
        </div>

        {/* 删除按钮 */}
        {!disabled && !isEditing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            className={clsx(
              'p-1 rounded opacity-0 group-hover:opacity-100 transition-all',
              'text-text-muted hover:bg-error/10 hover:text-error',
            )}
            title={t('common.delete')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* 展开面板 */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className={clsx('min-h-0', expanded ? 'overflow-visible' : 'overflow-hidden')}>
          <div className="border-t border-border bg-bg-tertiary p-3 space-y-3">
            <FileField
              label={t('action.program')}
              value={currentAction.program}
              onChange={(v) => updateAction({ program: v })}
              placeholder={t('action.programPlaceholder')}
              disabled={disabled}
            />
            <TextField
              label={t('action.args')}
              value={currentAction.args}
              onChange={(v) => updateAction({ args: v })}
              placeholder={t('action.argsPlaceholder')}
              disabled={disabled}
            />
            <SwitchField
              label={t('action.waitForExit')}
              hint={t('action.waitForExitHintPre')}
              value={currentAction.waitForExit}
              onChange={(v) => updateAction({ waitForExit: v })}
              disabled={disabled}
            />
            <SwitchField
              label={t('action.skipIfRunning')}
              hint={t('action.skipIfRunningHint')}
              value={currentAction.skipIfRunning}
              onChange={(v) => updateAction({ skipIfRunning: v })}
              disabled={disabled}
            />
            {isWindowsBackend && (
              <SwitchField
                label={t('action.useCmd')}
                hint={t('action.useCmdHint')}
                value={currentAction.useCmd}
                onChange={(v) => updateAction({ useCmd: v })}
                disabled={disabled}
              />
            )}
          </div>
        </div>
      </div>

      {/* 右键菜单 */}
      {menuState.isOpen && (
        <ContextMenu items={menuState.items} position={menuState.position} onClose={hideMenu} />
      )}

      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title={t('action.removeConfirmTitle')}
        message={t('action.removeConfirmMessage')}
        cancelText={t('common.cancel')}
        confirmText={t('common.delete')}
        destructive
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={() => {
          setShowDeleteConfirm(false);
          removePreAction(instanceId, action.id);
        }}
      />
    </div>
  );
}
