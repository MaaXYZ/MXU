/**
 * Pipeline Override 生成工具
 * 用于生成任务的 pipeline_override JSON
 * MaaFramework 支持数组格式的 pipeline_override，会按顺序依次覆盖（同名字段完整替换，非深合并）
 */

import type {
  ProjectInterface,
  SelectedTask,
  OptionValue,
  OptionDefinition,
} from '@/types/interface';
import { isMxuSpecialTask, getMxuSpecialTask } from '@/types/specialTasks';
import { loggers } from './logger';
import { findSwitchCase } from './optionHelpers';
import { createDefaultOptionValue, sanitizeOptionValue } from '@/stores/helpers';

/**
 * 检查选项是否与当前控制器/资源不兼容
 * 返回 true 表示不兼容，应跳过该选项
 */
const isOptionIncompatible = (
  optionDef: OptionDefinition,
  controllerName?: string,
  resourceName?: string,
): boolean => {
  // 检查控制器兼容性
  if (optionDef.controller && optionDef.controller.length > 0) {
    if (!controllerName || !optionDef.controller.includes(controllerName)) {
      return true;
    }
  }
  // 检查资源兼容性
  if (optionDef.resource && optionDef.resource.length > 0) {
    if (!resourceName || !optionDef.resource.includes(resourceName)) {
      return true;
    }
  }
  return false;
};

/**
 * 递归处理选项的 pipeline_override，收集到数组中
 */
const HOTKEY_KEY_MAP: Record<string, Record<string, number>> = {
  Win32: {
    BACKSPACE: 0x08,
    TAB: 0x09,
    ENTER: 0x0d,
    SHIFT: 0x10,
    CTRL: 0x11,
    ALT: 0x12,
    META: 0x5b,
    COMMAND: 0x5b,
    CMD: 0x5b,
    PAUSE: 0x13,
    CAPSLOCK: 0x14,
    ESC: 0x1b,
    SPACE: 0x20,
    PAGEUP: 0x21,
    PAGEDOWN: 0x22,
    END: 0x23,
    HOME: 0x24,
    LEFT: 0x25,
    UP: 0x26,
    RIGHT: 0x27,
    DOWN: 0x28,
    INSERT: 0x2d,
    DELETE: 0x2e,
    '0': 0x30,
    '1': 0x31,
    '2': 0x32,
    '3': 0x33,
    '4': 0x34,
    '5': 0x35,
    '6': 0x36,
    '7': 0x37,
    '8': 0x38,
    '9': 0x39,
    A: 0x41,
    B: 0x42,
    C: 0x43,
    D: 0x44,
    E: 0x45,
    F: 0x46,
    G: 0x47,
    H: 0x48,
    I: 0x49,
    J: 0x4a,
    K: 0x4b,
    L: 0x4c,
    M: 0x4d,
    N: 0x4e,
    O: 0x4f,
    P: 0x50,
    Q: 0x51,
    R: 0x52,
    S: 0x53,
    T: 0x54,
    U: 0x55,
    V: 0x56,
    W: 0x57,
    X: 0x58,
    Y: 0x59,
    Z: 0x5a,
    F1: 0x70,
    F2: 0x71,
    F3: 0x72,
    F4: 0x73,
    F5: 0x74,
    F6: 0x75,
    F7: 0x76,
    F8: 0x77,
    F9: 0x78,
    F10: 0x79,
    F11: 0x7a,
    F12: 0x7b,
  },
  // macOS 使用 CoreGraphics 的 CGKeyCode（对应 HIToolbox Events.h 中的 kVK_*）。
  // 字母/数字键按 ANSI 键盘物理位置映射；修饰键使用左侧 Shift / Control / Option / Command。
  MacOS: {
    BACKSPACE: 0x33,
    TAB: 0x30,
    ENTER: 0x24,
    SHIFT: 0x38,
    CTRL: 0x3b,
    ALT: 0x3a,
    META: 0x37,
    COMMAND: 0x37,
    CMD: 0x37,
    CAPSLOCK: 0x39,
    ESC: 0x35,
    SPACE: 0x31,
    PAGEUP: 0x74,
    PAGEDOWN: 0x79,
    END: 0x77,
    HOME: 0x73,
    LEFT: 0x7b,
    UP: 0x7e,
    RIGHT: 0x7c,
    DOWN: 0x7d,
    DELETE: 0x75,
    '0': 0x1d,
    '1': 0x12,
    '2': 0x13,
    '3': 0x14,
    '4': 0x15,
    '5': 0x17,
    '6': 0x16,
    '7': 0x1a,
    '8': 0x1c,
    '9': 0x19,
    A: 0x00,
    B: 0x0b,
    C: 0x08,
    D: 0x02,
    E: 0x0e,
    F: 0x03,
    G: 0x05,
    H: 0x04,
    I: 0x22,
    J: 0x26,
    K: 0x28,
    L: 0x25,
    M: 0x2e,
    N: 0x2d,
    O: 0x1f,
    P: 0x23,
    Q: 0x0c,
    R: 0x0f,
    S: 0x01,
    T: 0x11,
    U: 0x20,
    V: 0x09,
    W: 0x0d,
    X: 0x07,
    Y: 0x10,
    Z: 0x06,
    F1: 0x7a,
    F2: 0x78,
    F3: 0x63,
    F4: 0x76,
    F5: 0x60,
    F6: 0x61,
    F7: 0x62,
    F8: 0x64,
    F9: 0x65,
    F10: 0x6d,
    F11: 0x67,
    F12: 0x6f,
  },
  Adb: {
    BACKSPACE: 67,
    TAB: 61,
    ENTER: 66,
    SHIFT: 59,
    CTRL: 113,
    ALT: 57,
    META: 117,
    COMMAND: 117,
    CMD: 117,
    SPACE: 62,
    ESC: 111,
    DELETE: 112,
    HOME: 3,
    END: 123,
    PAGEUP: 92,
    PAGEDOWN: 93,
    LEFT: 21,
    RIGHT: 22,
    UP: 19,
    DOWN: 20,
    '0': 7,
    '1': 8,
    '2': 9,
    '3': 10,
    '4': 11,
    '5': 12,
    '6': 13,
    '7': 14,
    '8': 15,
    '9': 16,
    A: 29,
    B: 30,
    C: 31,
    D: 32,
    E: 33,
    F: 34,
    G: 35,
    H: 36,
    I: 37,
    J: 38,
    K: 39,
    L: 40,
    M: 41,
    N: 42,
    O: 43,
    P: 44,
    Q: 45,
    R: 46,
    S: 47,
    T: 48,
    U: 49,
    V: 50,
    W: 51,
    X: 52,
    Y: 53,
    Z: 54,
    F1: 131,
    F2: 132,
    F3: 133,
    F4: 134,
    F5: 135,
    F6: 136,
    F7: 137,
    F8: 138,
    F9: 139,
    F10: 140,
    F11: 141,
    F12: 142,
  },
  WlRoots: {
    BACKSPACE: 14,
    TAB: 15,
    ENTER: 28,
    SHIFT: 42,
    CTRL: 29,
    ALT: 56,
    META: 125,
    COMMAND: 125,
    CMD: 125,
    SPACE: 57,
    ESC: 1,
    DELETE: 111,
    HOME: 102,
    END: 107,
    PAGEUP: 104,
    PAGEDOWN: 109,
    LEFT: 105,
    RIGHT: 106,
    UP: 103,
    DOWN: 108,
    '0': 11,
    '1': 2,
    '2': 3,
    '3': 4,
    '4': 5,
    '5': 6,
    '6': 7,
    '7': 8,
    '8': 9,
    '9': 10,
    A: 30,
    B: 48,
    C: 46,
    D: 32,
    E: 18,
    F: 33,
    G: 34,
    H: 35,
    I: 23,
    J: 36,
    K: 37,
    L: 38,
    M: 50,
    N: 49,
    O: 24,
    P: 25,
    Q: 16,
    R: 19,
    S: 31,
    T: 20,
    U: 22,
    V: 47,
    W: 17,
    X: 45,
    Y: 21,
    Z: 44,
    F1: 59,
    F2: 60,
    F3: 61,
    F4: 62,
    F5: 63,
    F6: 64,
    F7: 65,
    F8: 66,
    F9: 67,
    F10: 68,
    F11: 87,
    F12: 88,
  },
};

// Linux 控制器复用 WlRoots 的 evdev 键码表（use_win32_vk_code=false 时）
HOTKEY_KEY_MAP.Linux = HOTKEY_KEY_MAP.WlRoots;

/**
 * 将单个按键名（如 "A"、"F1"、"Ctrl"）转换为指定控制器类型的虚拟键码。
 * 注意：这里按控制器 **类型**（Win32 / MacOS / Adb / WlRoots / Linux）查表，而非控制器 name。
 * 未知按键返回 null。
 */
const convertHotkeyKeyName = (keyName: string, controllerType?: string): number | null => {
  // MacOS 必须使用 CGKeyCode；即使映射表意外缺失，也不能退回 Win32 VK。
  const controllerMap =
    HOTKEY_KEY_MAP[controllerType || ''] ??
    (controllerType === 'MacOS' ? undefined : HOTKEY_KEY_MAP.Win32);
  const normalized = keyName.trim().toUpperCase();
  const keyCode = controllerMap?.[normalized];
  if (keyCode === undefined) {
    loggers.task.warn('未知热键按键，无法映射到虚拟键码', {
      keyName,
      controllerType: controllerType || '(fallback: Win32)',
    });
    return null;
  }
  return keyCode;
};

/**
 * 将组合键字符串（如 "Ctrl+Shift+A"）拆分为主键与修饰键。
 * 约定末位为主键，其余为修饰键（捕获时按 Ctrl/Meta/Alt/Shift 顺序排列）。
 */
const splitHotkeyCombo = (value: string): { primary: string; modifiers: string[] } => {
  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { primary: '', modifiers: [] };
  return { primary: parts[parts.length - 1], modifiers: parts.slice(0, -1) };
};

const collectOptionOverrides = (
  optionKey: string,
  optionValues: Record<string, OptionValue>,
  overrides: Record<string, unknown>[],
  allOptions: Record<string, OptionDefinition>,
  controllerName?: string,
  resourceName?: string,
  controllerType?: string,
) => {
  const optionDef = allOptions[optionKey];
  if (!optionDef) return;

  // 检查选项是否与当前控制器/资源兼容，不兼容则跳过
  if (isOptionIncompatible(optionDef, controllerName, resourceName)) {
    return;
  }

  const savedValue = optionValues[optionKey];
  const sanitizedValue = savedValue
    ? sanitizeOptionValue(optionKey, savedValue, allOptions, (message) =>
        loggers.task.warn(message),
      )
    : null;
  const optionValue = sanitizedValue || createDefaultOptionValue(optionDef);

  if (optionValue.type === 'checkbox' && optionDef.type === 'checkbox') {
    // v2.3.0: checkbox 多选类型，按 cases 定义顺序合并所有选中的 case
    const selectedNames = new Set(optionValue.caseNames);
    for (const caseDef of optionDef.cases) {
      if (selectedNames.has(caseDef.name) && caseDef.pipeline_override) {
        overrides.push(caseDef.pipeline_override as Record<string, unknown>);
      }
    }
  } else if (
    (optionValue.type === 'select' || optionValue.type === 'switch') &&
    'cases' in optionDef
  ) {
    let caseName: string;
    if (optionValue.type === 'switch') {
      const isChecked = optionValue.value;
      const switchCase = findSwitchCase(optionDef.cases, isChecked);
      caseName = switchCase?.name || (isChecked ? 'Yes' : 'No');
    } else {
      caseName = optionValue.caseName;
    }

    const caseDef = optionDef.cases?.find((c) => c.name === caseName);

    if (caseDef?.pipeline_override) {
      overrides.push(caseDef.pipeline_override as Record<string, unknown>);
    }

    if (caseDef?.option) {
      for (const nestedKey of caseDef.option) {
        collectOptionOverrides(
          nestedKey,
          optionValues,
          overrides,
          allOptions,
          controllerName,
          resourceName,
          controllerType,
        );
      }
    }
  } else if (
    (optionValue.type === 'input' || optionValue.type === 'hotkey') &&
    'pipeline_override' in optionDef &&
    optionDef.pipeline_override
  ) {
    const inputDefs =
      optionDef.type === 'hotkey' ? optionDef.hotkeys || [] : optionDef.inputs || [];
    let overrideStr = JSON.stringify(optionDef.pipeline_override);

    for (const inputDef of inputDefs) {
      const inputName = inputDef.name;
      const inputVal = optionValue.values[inputName] ?? inputDef.default ?? '';

      // 热键：拆分为主键 / 修饰键，统一转换为控制器类型对应的虚拟键码（int）
      // 对应 ClickKey / KeyDown 等动作的 `key` 字段（要求 int，见流水线协议）
      if (optionDef.type === 'hotkey') {
        const { primary, modifiers } = splitHotkeyCombo(inputVal);
        const resolveKeyCode = (name: string): string => {
          const code = name ? convertHotkeyKeyName(name, controllerType) : null;
          return code !== null ? String(code) : '';
        };
        const placeholderValues: Record<string, string> = {
          [`{${inputName}}`]: resolveKeyCode(primary),
          [`{${inputName}.primary}`]: resolveKeyCode(primary),
          [`{${inputName}.modifier1}`]: resolveKeyCode(modifiers[0] ?? ''),
          [`{${inputName}.modifier2}`]: resolveKeyCode(modifiers[1] ?? ''),
        };
        for (const [placeholder, keyCode] of Object.entries(placeholderValues)) {
          const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const intVal = keyCode || '0';
          // 优先替换带引号的占位符（去掉引号，产出裸整数），再兜底替换未加引号写法
          overrideStr = overrideStr.replace(new RegExp(`"${escapedPlaceholder}"`, 'g'), intVal);
          overrideStr = overrideStr.replace(new RegExp(escapedPlaceholder, 'g'), intVal);
        }
        continue;
      }

      const pipelineType = inputDef.pipeline_type || 'string';
      const placeholder = `{${inputName}}`;
      const escapedPlaceholder = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const placeholderRegex = new RegExp(escapedPlaceholder, 'g');

      if (pipelineType === 'int') {
        overrideStr = overrideStr.replace(
          new RegExp(`"${escapedPlaceholder}"`, 'g'),
          inputVal || '0',
        );
        overrideStr = overrideStr.replace(placeholderRegex, inputVal || '0');
      } else if (pipelineType === 'bool') {
        const boolVal = ['true', '1', 'yes', 'y'].includes((inputVal || '').toLowerCase())
          ? 'true'
          : 'false';
        overrideStr = overrideStr.replace(new RegExp(`"${escapedPlaceholder}"`, 'g'), boolVal);
        overrideStr = overrideStr.replace(placeholderRegex, boolVal);
      } else {
        // 字符串值需要 JSON 转义，避免 Windows 路径中的 '\' 破坏 JSON
        const stringVal = inputVal || '';
        const escapedStringVal = JSON.stringify(stringVal).slice(1, -1);
        // 优先替换被双引号包裹的完整占位符，保持 JSON 字符串结构正确
        overrideStr = overrideStr.replace(
          new RegExp(`"${escapedPlaceholder}"`, 'g'),
          JSON.stringify(stringVal),
        );
        // 兜底替换未加引号的占位符（极少数写法）
        overrideStr = overrideStr.replace(placeholderRegex, escapedStringVal);
      }
    }

    try {
      overrides.push(JSON.parse(overrideStr));
    } catch (e) {
      loggers.task.warn('解析选项覆盖失败:', {
        errorMessage: e instanceof Error ? e.message : String(e),
        errorStack: e instanceof Error ? e.stack : undefined,
        overrideStr,
      });
    }
  }
};

/**
 * 为单个任务生成 pipeline override JSON
 * 返回数组格式的 JSON 字符串，MaaFramework 会按顺序依次覆盖（同名字段完整替换）
 *
 * v2.3.0 覆盖顺序：global_option < resource.option < controller.option < task.option
 *
 * `skipOptionKeys` 用于容器子任务：被容器接管的选项（如执行周期）在界面中隐藏，
 * 其保存值也不应再进入合成的覆写，避免绕过容器自己的设置。
 */
export const generateTaskPipelineOverride = (
  selectedTask: SelectedTask,
  projectInterface: ProjectInterface | null,
  controllerName?: string,
  resourceName?: string,
  globalOptionValues?: Record<string, OptionValue>,
  skipOptionKeys?: Iterable<string>,
): string => {
  // 处理 MXU 内置特殊任务
  if (isMxuSpecialTask(selectedTask.taskName)) {
    return generateMxuSpecialTaskOverride(selectedTask);
  }

  if (!projectInterface) return '[]';

  const skipped = skipOptionKeys ? new Set(skipOptionKeys) : undefined;

  // 热键键码按控制器 **类型**（Win32 / MacOS / Adb / WlRoots）查表，这里先由 name 解析出 type。
  // WlRoots 可配置接受 Win32 VK 或原始 evdev 键码，热键 override 必须与控制器配置一致。
  const controllerDef = controllerName
    ? projectInterface.controller.find((c) => c.name === controllerName)
    : undefined;
  const controllerType =
    (controllerDef?.type === 'WlRoots' && controllerDef.wlroots?.use_win32_vk_code) ||
    (controllerDef?.type === 'Linux' && controllerDef.linux?.use_win32_vk_code)
      ? 'Win32'
      : controllerDef?.type;

  const overrides: Record<string, unknown>[] = [];
  const taskDef = projectInterface.task.find((t) => t.name === selectedTask.taskName);
  if (!taskDef) return '[]';

  // 添加任务自身的 pipeline_override
  if (taskDef.pipeline_override) {
    overrides.push(taskDef.pipeline_override as Record<string, unknown>);
  }

  if (projectInterface.option) {
    // v2.3.0 覆盖顺序：global_option → resource.option → controller.option → task.option
    // 1. 全局选项（优先级最低）：取值来自全局设置 globalOptionValues（设置页统一编辑）
    if (projectInterface.global_option) {
      for (const optionKey of projectInterface.global_option) {
        if (skipped?.has(optionKey)) continue;
        collectOptionOverrides(
          optionKey,
          globalOptionValues ?? {},
          overrides,
          projectInterface.option,
          controllerName,
          resourceName,
          controllerType,
        );
      }
    }

    // 2. 资源包级选项
    if (resourceName) {
      const resourceDef = projectInterface.resource.find((r) => r.name === resourceName);
      if (resourceDef?.option) {
        for (const optionKey of resourceDef.option) {
          if (skipped?.has(optionKey)) continue;
          collectOptionOverrides(
            optionKey,
            selectedTask.optionValues,
            overrides,
            projectInterface.option,
            controllerName,
            resourceName,
            controllerType,
          );
        }
      }
    }

    // 3. 控制器级选项
    if (controllerName) {
      const controllerDef = projectInterface.controller.find((c) => c.name === controllerName);
      if (controllerDef?.option) {
        for (const optionKey of controllerDef.option) {
          if (skipped?.has(optionKey)) continue;
          collectOptionOverrides(
            optionKey,
            selectedTask.optionValues,
            overrides,
            projectInterface.option,
            controllerName,
            resourceName,
            controllerType,
          );
        }
      }
    }

    // 4. 任务级选项（优先级最高）
    if (taskDef.option) {
      for (const optionKey of taskDef.option) {
        if (skipped?.has(optionKey)) continue;
        collectOptionOverrides(
          optionKey,
          selectedTask.optionValues,
          overrides,
          projectInterface.option,
          controllerName,
          resourceName,
          controllerType,
        );
      }
    }
  }

  return JSON.stringify(overrides);
};

/**
 * 深合并多个对象（递归合并嵌套对象，非对象值后者覆盖前者）
 * 用于在前端侧合并多个 pipeline_override，避免 MaaFramework 的浅替换导致字段丢失
 */
const deepMergeObjects = (...sources: Record<string, unknown>[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        result[key] !== null &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMergeObjects(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }
  return result;
};

/**
 * 生成 MXU 内置特殊任务的 pipeline override
 * 复用通用的 collectOptionOverrides 处理所有选项类型（input/select/switch 及嵌套选项）
 *
 * 重要：MaaFramework 对同一节点的同名字段（如 custom_action_param）执行完整替换而非深合并。
 * 因此此处先在前端将所有 override 深合并为一个对象，再作为单元素数组发送给 MaaFramework，
 * 确保多个选项贡献的 custom_action_param 字段不会互相覆盖。
 */
const generateMxuSpecialTaskOverride = (selectedTask: SelectedTask): string => {
  const specialTask = getMxuSpecialTask(selectedTask.taskName);
  if (!specialTask) {
    loggers.task.warn(`未找到特殊任务定义: ${selectedTask.taskName}`);
    return '[]';
  }

  const overrides: Record<string, unknown>[] = [];
  const { taskDef, optionDefs } = specialTask;

  // 添加任务自身的 pipeline_override（如果有）
  if (taskDef.pipeline_override) {
    overrides.push(taskDef.pipeline_override as Record<string, unknown>);
  }

  // 复用通用选项处理函数，支持所有选项类型及嵌套选项
  if (taskDef.option) {
    for (const optionKey of taskDef.option) {
      collectOptionOverrides(optionKey, selectedTask.optionValues, overrides, optionDefs);
    }
  }

  if (overrides.length === 0) return '[]';

  // 前端深合并所有 override 为单个对象，避免 MaaFramework 浅替换丢失字段
  const merged = deepMergeObjects(...overrides);
  return JSON.stringify([merged]);
};
