// 匿名遥测（数据埋点）前端服务：负责判定构建期是否禁用、以及把 opt-in / DSN 传给 Rust。
//
// 设计要点：
// - DSN 仅来自 interface.json 的 telemetry.sentry.dsn；未声明则不初始化、不上报。
// - 调试 / 开发版本强制禁用，用户开关不可开启。
// - 埋点主体在 Rust（sentry Rust SDK），前端仅做接线，网络发送不阻塞主流程。
// - WebUI（非 Tauri）远程模式不初始化，仅本机 Tauri 进程上报。

import { isDebugVersion } from '@/services/updateService';
import { createDefaultOptionValue, sanitizeOptionValue } from '@/stores/helpers';
import type {
  OptionDefinition,
  OptionValue,
  ProjectInterface,
  SelectedTask,
} from '@/types/interface';
import { loggers } from '@/utils/logger';
import { findSwitchCase } from '@/utils/optionHelpers';
import { isPasswordInput } from '@/utils/passwordOptionValues';
import { isTauri } from '@/utils/paths';

const log = loggers.telemetry;

/**
 * 构建 / 调试版本是否禁用遥测（用户开关也不可开启）。
 * - MXU 开发模式（vite dev）
 * - 资源项目为非正式版本（DEBUG_VERSION / <1.0.0 / 非 beta|rc 预发布）
 */
export function isTelemetryBlockedByBuild(pi?: ProjectInterface | null): boolean {
  return import.meta.env.DEV || isDebugVersion(pi?.version);
}

/** 单个任务上报的选项条目上限，避免异常配置撑大事件。 */
const MAX_OPTION_ENTRIES = 100;
/** 单个选项值的长度上限。 */
const MAX_OPTION_VALUE_LENGTH = 512;

/** 自由文本类输入只上报是否填写，避免把路径 / URL / 进程名等隐私内容带出去。 */
const summarizeInputValue = (
  value: string,
  pipelineType?: 'string' | 'int' | 'bool',
  password?: boolean,
): string => {
  if (password) return value ? 'filled' : 'empty';
  const isSafeToReport = pipelineType === 'int' || pipelineType === 'bool';
  if (isSafeToReport) return value;
  return value ? 'filled' : 'empty';
};

/** 递归收集一个选项（及其 case 下的嵌套选项）的摘要值。 */
const collectOptionSummary = (
  optionKey: string,
  optionValues: Record<string, OptionValue>,
  optionDefs: Record<string, OptionDefinition>,
  summary: Record<string, string>,
) => {
  const optionDef = optionDefs[optionKey];
  if (!optionDef || Object.keys(summary).length >= MAX_OPTION_ENTRIES) return;

  const savedValue = optionValues[optionKey];
  const optionValue =
    (savedValue ? sanitizeOptionValue(optionKey, savedValue, optionDefs) : null) ||
    createDefaultOptionValue(optionDef);

  const put = (key: string, value: string) => {
    if (Object.keys(summary).length >= MAX_OPTION_ENTRIES) return;
    summary[key] = value.slice(0, MAX_OPTION_VALUE_LENGTH);
  };

  switch (optionValue.type) {
    case 'select':
      put(optionKey, optionValue.caseName);
      break;
    case 'checkbox':
      // 每个选中 case 单独一条，便于 Sentry 按单条筛选；勿再用 | 拼接
      if (optionValue.caseNames.length === 0) {
        put(optionKey, 'none');
      } else {
        for (const caseName of optionValue.caseNames) {
          put(`${optionKey}.${caseName}`, 'true');
        }
      }
      break;
    case 'switch':
      put(optionKey, String(optionValue.value));
      break;
    case 'hotkey':
      // 键名来自固定按键表，非自由文本，可原样上报
      if (optionDef.type === 'hotkey') {
        for (const hotkeyDef of optionDef.hotkeys) {
          put(
            `${optionKey}.${hotkeyDef.name}`,
            optionValue.values[hotkeyDef.name] || hotkeyDef.default || 'empty',
          );
        }
      }
      break;
    case 'input':
      if (optionDef.type === 'input') {
        for (const inputDef of optionDef.inputs) {
          const raw = optionValue.values[inputDef.name] ?? inputDef.default ?? '';
          put(
            `${optionKey}.${inputDef.name}`,
            summarizeInputValue(raw, inputDef.pipeline_type, isPasswordInput(inputDef)),
          );
        }
      }
      break;
  }

  // select / switch / checkbox 的 case 可携带嵌套选项，一并收集
  if (!('cases' in optionDef)) return;
  const selectedCaseNames =
    optionValue.type === 'checkbox'
      ? optionValue.caseNames
      : optionValue.type === 'select'
        ? [optionValue.caseName]
        : optionValue.type === 'switch'
          ? [findSwitchCase(optionDef.cases, optionValue.value)?.name ?? '']
          : [];
  for (const caseDef of optionDef.cases) {
    if (!caseDef.option || !selectedCaseNames.includes(caseDef.name)) continue;
    for (const nestedKey of caseDef.option) {
      collectOptionSummary(nestedKey, optionValues, optionDefs, summary);
    }
  }
};

/**
 * 生成任务级选项摘要，随 TaskConfig 传给 Rust 写入子任务 span。
 * 自由文本 / 文件路径类输入只记 filled / empty，不上报内容。
 */
export function buildTaskOptionSummary(
  selectedTask: SelectedTask,
  taskOptionKeys: string[] | undefined,
  optionDefs: Record<string, OptionDefinition> | undefined,
): Record<string, string> | undefined {
  if (!taskOptionKeys?.length || !optionDefs) return undefined;

  const summary: Record<string, string> = {};
  for (const optionKey of taskOptionKeys) {
    collectOptionSummary(optionKey, selectedTask.optionValues, optionDefs, summary);
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** 传给 Rust 的 Sentry 初始化配置。 */
export interface TelemetryInitConfig {
  /** Sentry DSN（来自 interface.telemetry.sentry.dsn） */
  dsn: string;
  /** 是否启用（用户 opt-in 且非调试版；false 时不实际发送） */
  enabled: boolean;
  /** release：MXU@<mxuVersion>+<appName>@<appVersion> */
  release: string;
  /** 环境标签，如 stable/beta/production */
  environment: string;
  /** 是否启用性能 / 事务上报 */
  tracing: boolean;
  /** 事务采样率 0~1 */
  tracesSampleRate: number;
  /** 失败附件独立采样率 0~1 */
  failureAttachmentsSampleRate: number;
  /** 资源项目名（interface.name），用于 tag app.name */
  appName: string;
  /** 资源项目版本（interface.version），用于 tag app.version */
  appVersion: string;
  /** MXU 本体版本，用于 tag mxu.version */
  mxuVersion: string;
}

/**
 * 初始化遥测（在前端拿到 interface + config 后调用一次）。
 * 仅在 Tauri 环境执行；失败仅记录警告，不影响主流程。
 */
export async function initTelemetry(config: TelemetryInitConfig): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('telemetry_init', { config });
  } catch (err) {
    log.warn('telemetry_init 调用失败:', err);
  }
}

/**
 * 运行时切换遥测开关（用户在设置里打开 / 关闭时调用）。
 * 关闭时后端会停止发送；开启时若尚未初始化则由后端按已缓存配置重新初始化。
 */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('telemetry_set_enabled', { enabled });
  } catch (err) {
    log.warn('telemetry_set_enabled 调用失败:', err);
  }
}
