/**
 * MAA 回调日志监听 hook
 * 监听 maa-callback 事件并将相关信息添加到日志面板
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { maaService, type MaaCallbackDetails } from '@/services/maaService';
import { useAppStore, type LogType } from '@/stores/appStore';
import { loggers } from '@/utils/logger';
import i18n, { getInterfaceLangKey } from '@/i18n';
import { getMxuSpecialTask } from '@/types/specialTasks';
import { isTauri } from '@/utils/paths';
import { isDesktopWindowControllerType, getLinuxDeviceName } from '@/utils/controller';
import * as wsService from '@/services/wsService';
import {
  resolveI18nText,
  detectContentType,
  resolveContent,
  markdownToHtmlWithLocalImages,
} from '@/services/contentResolver';
import { hasRichTextFeatures } from '@/utils/richText';
import type { FocusTemplate, FocusDisplayChannel } from '@/types/interface';

const log = loggers.app;

const AGENT_LOG_FLOOD_WINDOW_MS = 2000;
const AGENT_LOG_FLOOD_THRESHOLD = 15;

// 每次会话只请求一次通知权限，避免多条 focus 消息重复弹权限弹窗
let focusNotificationPermissionRequested = false;

/**
 * 将富文本消息转为系统通知用纯文本。
 * 通过 DOM 解析做 HTML 感知转换：字面尖括号文本按原样保留；
 * `<br>` 与块级元素转换后追加换行，避免相邻内容粘连。
 */
function htmlToPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  doc.body
    .querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre')
    .forEach((el) => el.after('\n'));
  return (doc.body.textContent ?? '')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * v2.3.0: toast/notification 渠道 - 使用系统通知。
 * Tauri 桌面端经 Rust 侧 notify-rust 发送（WebView2 的 Web Notification API
 * 权限恒为 denied 且无权限弹窗，直接调用会静默失效）；
 * Web 端保留浏览器 Notification API。
 */
async function dispatchFocusNotification(message: string) {
  try {
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('send_system_notification', { title: 'MXU', body: htmlToPlainText(message) });
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification('MXU', { body: message });
    } else if (Notification.permission !== 'denied' && !focusNotificationPermissionRequested) {
      focusNotificationPermissionRequested = true;
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        new Notification('MXU', { body: message });
      }
    }
  } catch (error) {
    log.warn('Notification not available', error);
  }
}

/**
 * v2.3.0: 归一化 focus 模板（字符串简写 / 对象完整写法）。
 * 无展示内容（v2.9.1 起 content 可缺省，如只配 trace）时返回 undefined。
 */
function parseFocusEntry(
  entry: FocusTemplate,
): { content: string; displayChannels: FocusDisplayChannel[] } | undefined {
  if (typeof entry === 'string') {
    return { content: entry, displayChannels: ['log'] };
  }
  if (!entry.content) return undefined;
  const display = entry.display;
  return {
    content: entry.content,
    displayChannels: display ? (Array.isArray(display) ? display : [display]) : ['log'],
  };
}

// Focus 消息的占位符替换（不包含 {image}，由专门函数处理）
function replaceFocusPlaceholders(
  template: string,
  details: MaaCallbackDetails & Record<string, unknown>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    // {image} 由专门的函数处理，这里跳过
    if (key === 'image') return match;
    const value = details[key];
    if (value !== undefined && value !== null) {
      return String(value);
    }
    return match;
  });
}

/**
 * 解析 focus 消息内容
 * 支持国际化（$开头）、URL、文件路径、Markdown 格式、{image} 截图占位符
 * @param template 模板字符串
 * @param details 回调详情（用于占位符替换）
 * @param instanceId 实例 ID（用于获取截图）
 */
async function resolveFocusContent(
  template: string,
  details: MaaCallbackDetails & Record<string, unknown>,
  instanceId: string,
): Promise<{ message: string; html?: string }> {
  const state = useAppStore.getState();
  const langKey = getInterfaceLangKey(state.language);
  const translations = state.interfaceTranslations[langKey];
  const basePath = state.basePath;

  // 1. 替换普通占位符（不包含 {image}）
  let withPlaceholders = replaceFocusPlaceholders(template, details);

  // 2. 处理 {image} 占位符 - 获取控制器缓存的截图（带超时保护）
  if (withPlaceholders.includes('{image}')) {
    try {
      // 添加超时保护，避免长时间阻塞
      const timeoutPromise = new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error('获取截图超时')), 5000);
      });
      const imagePromise = maaService.getCachedImage(instanceId);

      const imageDataUrl = await Promise.race([imagePromise, timeoutPromise]);
      if (imageDataUrl) {
        // 直接替换为 data URL，用户可自行组装到 Markdown/HTML 中
        withPlaceholders = withPlaceholders.replace(/\{image\}/g, imageDataUrl);
      } else {
        withPlaceholders = withPlaceholders.replace(/\{image\}/g, '');
      }
    } catch (err) {
      log.warn('获取截图失败:', err);
      withPlaceholders = withPlaceholders.replace(/\{image\}/g, '');
    }
  }

  // 3. 处理国际化
  const resolved = resolveI18nText(withPlaceholders, translations);

  // 4. 检测内容类型
  const contentType = detectContentType(resolved);

  // 5. 如果是直接文本，检查是否包含富文本特征
  if (contentType === 'text') {
    // 判定规则集中在 utils/richText，避免各处各写一套正则
    if (hasRichTextFeatures(resolved)) {
      const html = await markdownToHtmlWithLocalImages(resolved, basePath);
      return { message: resolved, html };
    }
    return { message: resolved };
  }

  // 6. 加载外部内容（URL 或文件）
  try {
    const loadedContent = await resolveContent(resolved, { translations, basePath });
    // 将加载的内容转换为 HTML（支持 Markdown）
    const html = await markdownToHtmlWithLocalImages(loadedContent, basePath);
    return { message: loadedContent, html };
  } catch (err) {
    log.warn(`加载 focus 内容失败 [${resolved}]:`, err);
    // 加载失败时返回原始文本
    return { message: resolved };
  }
}

// 检查是否是连接动作
function isConnectAction(details: MaaCallbackDetails): boolean {
  return details.action === 'Connect' || details.action === 'connect';
}

// 从当前实例配置推断控制器类型和名称（用于解决回调时序问题）
function inferCtrlInfoFromInstance(
  instanceId: string,
  labels: { portal: string; linux: string },
): {
  type: 'device' | 'window' | undefined;
  name: string | undefined;
} {
  const state = useAppStore.getState();
  const instance = state.instances.find((i) => i.id === instanceId);
  const savedDevice = instance?.savedDevice;
  // 获取控制器名称：优先使用已选中的，否则使用第一个作为默认值（与 Toolbar.tsx 保持一致）
  const controllerName =
    state.selectedController[instanceId] || state.projectInterface?.controller?.[0]?.name;

  if (!controllerName) return { type: undefined, name: undefined };

  const controller = state.projectInterface?.controller?.find((c) => c.name === controllerName);
  if (!controller) return { type: undefined, name: undefined };

  // 根据控制器类型确定类型和名称
  if (isDesktopWindowControllerType(controller.type)) {
    return { type: 'window', name: savedDevice?.windowName };
  } else if (controller.type === 'Adb') {
    return { type: 'device', name: savedDevice?.adbDeviceName };
  } else if (controller.type === 'WlRoots') {
    return { type: 'device', name: savedDevice?.wlrSocketPath };
  } else if (controller.type === 'Linux') {
    // 按当前配置实际需要的设备派生名称：不依赖 gamescope 的配置（如 Portal+Uinput）
    // 会忽略残留的 savedDevice.gamescopeDisplayNo，避免显示过期的 `gamescope-<n>`。
    const name = getLinuxDeviceName(
      controller,
      {
        wlrSocketPath: savedDevice?.wlrSocketPath,
        gamescopeDisplayNo: savedDevice?.gamescopeDisplayNo,
      },
      labels,
    );
    return { type: 'device', name };
  } else if (controller.type === 'PlayCover') {
    return { type: 'device', name: savedDevice?.playcoverAddress };
  }
  return { type: 'device', name: undefined };
}

// 从当前实例配置推断资源显示名称（用于解决回调时序问题，类似 inferCtrlInfoFromInstance）
function inferResInfoFromInstance(instanceId: string): string | undefined {
  const state = useAppStore.getState();
  const resourceName =
    state.selectedResource[instanceId] || state.projectInterface?.resource?.[0]?.name;
  if (!resourceName) return undefined;

  const resource = state.projectInterface?.resource?.find((r) => r.name === resourceName);
  if (!resource) return undefined;

  const langKey = getInterfaceLangKey(state.language);
  const translations = state.interfaceTranslations[langKey];
  return resolveI18nText(resource.label, translations) || resource.name;
}

export function useMaaCallbackLogger() {
  const { t } = useTranslation();
  const { addLog } = useAppStore();
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;

    // 设置回调监听
    const setupListener = async () => {
      try {
        const unlisten = await maaService.onCallback((message, details) => {
          // 组件已卸载则忽略
          if (cancelled) return;

          // 获取当前活动实例 ID
          const currentActiveId = useAppStore.getState().activeInstanceId;
          if (!currentActiveId) return;

          // 根据消息类型处理
          handleCallback(
            currentActiveId,
            message,
            details as MaaCallbackDetails & Record<string, unknown>,
            t,
            addLog,
          );
        });

        // 如果在等待期间组件已卸载，立即取消监听
        if (cancelled) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      } catch (err) {
        log.error('Failed to setup maa callback listener:', err);
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [t, addLog]);
}

/**
 * 根据 task_id 获取任务显示名
 * 优先使用 maaTaskIdMapping 查找 selectedTaskId，然后从实例任务列表获取显示名
 * 这样可以避免 entry 覆盖问题和竞态条件
 */
function getTaskDisplayName(
  instanceId: string,
  taskId: number | undefined,
  entry: string | undefined,
): string | undefined {
  const state = useAppStore.getState();

  // 1. 优先通过 task_id 查找
  if (taskId !== undefined) {
    // 先尝试 taskIdToName（快速路径）
    const directName = state.taskIdToName[taskId];
    if (directName) return directName;

    // 通过 maaTaskIdMapping 查找 selectedTaskId，然后从实例任务列表获取
    const selectedTaskId = state.maaTaskIdMapping[instanceId]?.[taskId];
    if (selectedTaskId) {
      const instance = state.instances.find((i) => i.id === instanceId);
      const selectedTask = instance?.selectedTasks.find((t) => t.id === selectedTaskId);
      if (selectedTask) {
        if (selectedTask.customName) return selectedTask.customName;

        // 检查是否为 MXU 特殊任务（使用 i18n.t 翻译 label）
        const specialTask = getMxuSpecialTask(selectedTask.taskName);
        if (specialTask?.taskDef.label) {
          return i18n.t(specialTask.taskDef.label);
        }

        // 普通任务：使用项目接口翻译
        const taskDef = state.projectInterface?.task.find((t) => t.name === selectedTask.taskName);
        const langKey = getInterfaceLangKey(state.language);
        const translations = state.interfaceTranslations[langKey];
        return resolveI18nText(taskDef?.label, translations) || selectedTask.taskName;
      }
    }
  }

  // 2. 尝试通过 entry 查找（兼容旧逻辑，但优先级降低）
  if (entry) {
    return state.entryToTaskName[entry];
  }

  return undefined;
}

function handleCallback(
  instanceId: string,
  message: string,
  details: MaaCallbackDetails & Record<string, unknown>,
  t: (key: string, options?: Record<string, unknown>) => string,
  addLog: (instanceId: string, log: { type: LogType; message: string; html?: string }) => void,
) {
  // 获取 ID 名称映射函数
  const { getCtrlName, getCtrlType, getResName, getResBatchInfo } = useAppStore.getState();

  // 首先检查是否有 focus 字段，有展示内容则优先处理 focus 消息
  // （v2.9.1 起对象可以只配 trace 不配 content，这种没有展示内容，落回常规消息处理）
  const focus = details.focus as Record<string, FocusTemplate> | undefined;
  const focusTemplateEntry = focus?.[message];
  const focusEntry = focusTemplateEntry ? parseFocusEntry(focusTemplateEntry) : undefined;
  if (focusEntry) {
    const { content: focusTemplate, displayChannels } = focusEntry;

    // 如果包含 {image} 占位符，先快速显示不含图片的版本，避免阻塞
    const hasImagePlaceholder = focusTemplate.includes('{image}');
    if (hasImagePlaceholder && displayChannels.includes('log')) {
      const tempMessage = replaceFocusPlaceholders(focusTemplate, details).replace(
        /\{image\}/g,
        '[图片加载中...]',
      );
      addLog(instanceId, { type: 'focus', message: tempMessage });
    }

    resolveFocusContent(focusTemplate, details, instanceId)
      .then((resolved) => {
        // 根据 display 渠道分发消息；toast 与 notification 同为系统通知，去重避免双发
        let notificationDispatched = false;
        for (const channel of displayChannels) {
          switch (channel) {
            case 'log':
              if (!hasImagePlaceholder) {
                addLog(instanceId, {
                  type: 'focus',
                  message: resolved.message,
                  html: resolved.html,
                });
              }
              break;
            case 'toast':
            case 'notification':
              if (!notificationDispatched) {
                notificationDispatched = true;
                dispatchFocusNotification(resolved.message);
              }
              break;
            case 'dialog':
            case 'modal':
              // dialog 和 modal 当前都作为 log 处理，将来可扩展为弹窗
              addLog(instanceId, { type: 'focus', message: resolved.message, html: resolved.html });
              break;
          }
        }
      })
      .catch((err) => {
        log.warn('Failed to resolve focus content:', err);
        if (!hasImagePlaceholder && displayChannels.includes('log')) {
          addLog(instanceId, { type: 'focus', message: focusTemplate });
        }
      });

    return;
  }

  // 处理各种消息类型
  switch (message) {
    // ==================== 控制器连接消息 ====================
    case 'Controller.Action.Starting':
      if (isConnectAction(details)) {
        // 优先从注册信息获取，未注册时从实例配置推断（解决回调时序问题）
        const registeredName =
          details.ctrl_id !== undefined ? getCtrlName(details.ctrl_id) : undefined;
        const registeredType =
          details.ctrl_id !== undefined ? getCtrlType(details.ctrl_id) : undefined;
        const inferred = inferCtrlInfoFromInstance(instanceId, {
          portal: t('controller.portal'),
          linux: t('controller.linux'),
        });
        const deviceName = registeredName || inferred.name || '';
        const ctrlType = registeredType || inferred.type;
        const targetText =
          ctrlType === 'window' ? t('logs.messages.targetWindow') : t('logs.messages.targetDevice');
        addLog(instanceId, {
          type: 'info',
          message: `${t('logs.messages.connecting', { target: targetText })} ${deviceName}`,
        });
      }
      break;

    case 'Controller.Action.Succeeded':
      if (isConnectAction(details)) {
        const registeredName =
          details.ctrl_id !== undefined ? getCtrlName(details.ctrl_id) : undefined;
        const registeredType =
          details.ctrl_id !== undefined ? getCtrlType(details.ctrl_id) : undefined;
        const inferred = inferCtrlInfoFromInstance(instanceId, {
          portal: t('controller.portal'),
          linux: t('controller.linux'),
        });
        const deviceName = registeredName || inferred.name || '';
        const ctrlType = registeredType || inferred.type;
        const targetText =
          ctrlType === 'window' ? t('logs.messages.targetWindow') : t('logs.messages.targetDevice');
        addLog(instanceId, {
          type: 'success',
          message: `${t('logs.messages.connected', { target: targetText })} ${deviceName}`,
        });
      }
      break;

    case 'Controller.Action.Failed':
      if (isConnectAction(details)) {
        const registeredName =
          details.ctrl_id !== undefined ? getCtrlName(details.ctrl_id) : undefined;
        const registeredType =
          details.ctrl_id !== undefined ? getCtrlType(details.ctrl_id) : undefined;
        const inferred = inferCtrlInfoFromInstance(instanceId, {
          portal: t('controller.portal'),
          linux: t('controller.linux'),
        });
        const deviceName = registeredName || inferred.name || '';
        const ctrlType = registeredType || inferred.type;
        const targetText =
          ctrlType === 'window' ? t('logs.messages.targetWindow') : t('logs.messages.targetDevice');
        addLog(instanceId, {
          type: 'error',
          message: `${t('logs.messages.connectFailed', { target: targetText })} ${deviceName}`,
        });
      }
      break;

    // ==================== 资源加载消息 ====================
    case 'Resource.Loading.Starting': {
      const batchInfo = details.res_id !== undefined ? getResBatchInfo(details.res_id) : undefined;
      // 批量加载时只显示第一个 path 的"开始加载"
      if (batchInfo && !batchInfo.isFirst) break;
      const registeredName = details.res_id !== undefined ? getResName(details.res_id) : undefined;
      const inferredName = inferResInfoFromInstance(instanceId);
      const resourceName = registeredName || inferredName;
      addLog(instanceId, {
        type: 'info',
        message: t('logs.messages.loadingResource', {
          name: resourceName || details.path || '',
        }),
      });
      break;
    }

    case 'Resource.Loading.Succeeded': {
      const batchInfo = details.res_id !== undefined ? getResBatchInfo(details.res_id) : undefined;
      // 批量加载时只显示最后一个 path 的"加载成功"
      if (batchInfo && !batchInfo.isLast) break;
      const registeredName = details.res_id !== undefined ? getResName(details.res_id) : undefined;
      const inferredName = inferResInfoFromInstance(instanceId);
      const resourceName = registeredName || inferredName;
      addLog(instanceId, {
        type: 'success',
        message: t('logs.messages.resourceLoaded', { name: resourceName || details.path || '' }),
      });
      break;
    }

    case 'Resource.Loading.Failed': {
      const registeredName = details.res_id !== undefined ? getResName(details.res_id) : undefined;
      const inferredName = inferResInfoFromInstance(instanceId);
      const resourceName = registeredName || inferredName;
      const resourceLabel = [resourceName, details.path].filter(Boolean).join(' ') || '';
      addLog(instanceId, {
        type: 'error',
        message: `${t('logs.messages.resourceFailed', { name: resourceLabel })} ${t('logs.messages.resourceFailedHint')}`,
      });
      break;
    }

    // ==================== 任务消息 ====================
    case 'Tasker.Task.Starting': {
      // 特殊处理内部停止任务
      if (details.entry === 'MaaTaskerPostStop') {
        addLog(instanceId, {
          type: 'info',
          message: t('logs.messages.taskStarting', { name: t('logs.messages.stopTask') }),
        });
        break;
      }
      // 使用改进的任务名查找逻辑，避免 entry 覆盖和竞态问题
      const taskName = getTaskDisplayName(instanceId, details.task_id, details.entry);
      addLog(instanceId, {
        type: 'info',
        message: t('logs.messages.taskStarting', {
          name: taskName || details.entry || '',
        }),
      });
      break;
    }

    case 'Tasker.Task.Succeeded': {
      // 特殊处理内部停止任务
      if (details.entry === 'MaaTaskerPostStop') {
        addLog(instanceId, {
          type: 'success',
          message: t('logs.messages.taskSucceeded', { name: t('logs.messages.stopTask') }),
        });
        break;
      }
      const taskName = getTaskDisplayName(instanceId, details.task_id, details.entry);
      addLog(instanceId, {
        type: 'success',
        message: t('logs.messages.taskSucceeded', {
          name: taskName || details.entry || '',
        }),
      });
      break;
    }

    case 'Tasker.Task.Failed': {
      // 特殊处理内部停止任务
      if (details.entry === 'MaaTaskerPostStop') {
        addLog(instanceId, {
          type: 'error',
          message: t('logs.messages.taskFailed', { name: t('logs.messages.stopTask') }),
        });
        break;
      }
      const taskName = getTaskDisplayName(instanceId, details.task_id, details.entry);
      addLog(instanceId, {
        type: 'error',
        message: t('logs.messages.taskFailed', {
          name: taskName || details.entry || '',
        }),
      });
      break;
    }

    // ==================== 节点消息（仅在有 focus 时显示，否则忽略）====================
    // 这些消息只有在 focus 配置时才显示，上面已经处理过了
    case 'Node.Recognition.Starting':
    case 'Node.Recognition.Succeeded':
    case 'Node.Recognition.Failed':
    case 'Node.Action.Starting':
    case 'Node.Action.Succeeded':
    case 'Node.Action.Failed':
    case 'Node.PipelineNode.Starting':
    case 'Node.PipelineNode.Succeeded':
    case 'Node.PipelineNode.Failed':
    case 'Node.NextList.Starting':
    case 'Node.NextList.Succeeded':
    case 'Node.NextList.Failed':
      // 没有 focus 配置时不显示这些消息
      break;

    default:
      // 未知消息类型，可以选择记录到控制台
      // log.debug('Unknown maa callback:', message, details);
      break;
  }
}

/**
 * 监听 Agent 输出事件
 */
export function useMaaAgentLogger() {
  const { t } = useTranslation();
  const { addLog } = useAppStore();
  const unlistenRef = useRef<(() => void) | null>(null);
  const agentFloodStateRef = useRef<
    Map<
      string,
      {
        recentTimestamps: number[];
        floodSuppressed: boolean;
        recoveryTimer: ReturnType<typeof setTimeout> | null;
        warningEmitted: boolean;
      }
    >
  >(new Map());

  const pruneAgentFloodWindow = (timestamps: number[], now: number): number[] =>
    timestamps.filter((timestamp) => now - timestamp < AGENT_LOG_FLOOD_WINDOW_MS);

  const ensureAgentFloodState = (instanceId: string) => {
    const existing = agentFloodStateRef.current.get(instanceId);
    if (existing) return existing;

    const created = {
      recentTimestamps: [] as number[],
      floodSuppressed: false,
      recoveryTimer: null as ReturnType<typeof setTimeout> | null,
      warningEmitted: false,
    };
    agentFloodStateRef.current.set(instanceId, created);
    return created;
  };

  const clearAgentRecoveryTimer = (batch: {
    recoveryTimer: ReturnType<typeof setTimeout> | null;
  }) => {
    if (batch.recoveryTimer !== null) {
      clearTimeout(batch.recoveryTimer);
      batch.recoveryTimer = null;
    }
  };

  const scheduleAgentRecoveryCheck = (instanceId: string) => {
    const batch = agentFloodStateRef.current.get(instanceId);
    if (!batch) return;

    clearAgentRecoveryTimer(batch);
    batch.recoveryTimer = setTimeout(() => {
      const currentBatch = agentFloodStateRef.current.get(instanceId);
      if (!currentBatch) return;

      const now = Date.now();
      currentBatch.recentTimestamps = pruneAgentFloodWindow(currentBatch.recentTimestamps, now);

      if (currentBatch.recentTimestamps.length < AGENT_LOG_FLOOD_THRESHOLD) {
        if (currentBatch.floodSuppressed) {
          currentBatch.floodSuppressed = false;
          currentBatch.warningEmitted = false;
          addLog(instanceId, {
            type: 'warning',
            message: t('logs.messages.agentLogFloodRecovered'),
          });
        }
      } else {
        scheduleAgentRecoveryCheck(instanceId);
      }
    }, AGENT_LOG_FLOOD_WINDOW_MS);
  };

  const emitAgentLog = (instanceId: string, mergedLine: string) => {
    resolveFocusContent(mergedLine, {} as MaaCallbackDetails & Record<string, unknown>, instanceId)
      .then((resolved) => {
        addLog(instanceId, {
          type: 'agent',
          message: resolved.message,
          html: resolved.html,
        });
      })
      .catch((err) => {
        log.warn('Failed to resolve agent content:', err);
        addLog(instanceId, { type: 'agent', message: mergedLine });
      });
  };

  useEffect(() => {
    let cancelled = false;

    const handleAgentOutput = (instanceId: string, _stream: string, line: string) => {
      if (cancelled) return;

      const state = ensureAgentFloodState(instanceId);
      const now = Date.now();
      state.recentTimestamps = pruneAgentFloodWindow(state.recentTimestamps, now);

      if (state.floodSuppressed) {
        scheduleAgentRecoveryCheck(instanceId);
        return;
      }

      state.recentTimestamps.push(now);
      if (state.recentTimestamps.length >= AGENT_LOG_FLOOD_THRESHOLD) {
        state.floodSuppressed = true;
        if (!state.warningEmitted) {
          state.warningEmitted = true;
          addLog(instanceId, {
            type: 'warning',
            message: t('logs.messages.agentLogFloodWarning'),
          });
        }
        scheduleAgentRecoveryCheck(instanceId);
        return;
      }

      emitAgentLog(instanceId, line);

      if (state.recentTimestamps.length > 0) {
        scheduleAgentRecoveryCheck(instanceId);
      }
    };

    const setupListener = async () => {
      try {
        if (isTauri()) {
          const { listen } = await import('@tauri-apps/api/event');
          const unlisten = await listen<{ instance_id: string; stream: string; line: string }>(
            'maa-agent-output',
            (event) => {
              const { instance_id, stream, line } = event.payload;
              handleAgentOutput(instance_id, stream, line);
            },
          );

          if (cancelled) {
            unlisten();
          } else {
            unlistenRef.current = unlisten;
          }
        } else {
          const unlisten = wsService.onAgentOutput(handleAgentOutput);
          if (cancelled) {
            unlisten();
          } else {
            unlistenRef.current = unlisten;
          }
        }
      } catch (err) {
        log.warn('Failed to setup agent output listener:', err);
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }

      for (const batch of agentFloodStateRef.current.values()) {
        clearAgentRecoveryTimer(batch);
      }
      agentFloodStateRef.current.clear();
    };
  }, [addLog, t]);
}
