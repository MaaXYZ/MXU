// ============================================================================
// MXU 内置特殊任务系统
// ============================================================================

import type {
  TaskItem,
  InputOption,
  SwitchOption,
  SelectOption,
  OptionDefinition,
} from './interface';

/**
 * MXU 特殊任务定义接口
 * 用于注册 MXU 内置的特殊任务（通过 custom_action 实现）
 */
export interface MxuSpecialTaskDefinition {
  /** 任务唯一标识符，如 '__MXU_SLEEP__' */
  taskName: string;
  /** MaaFramework 任务入口名，如 'MXU_SLEEP' */
  entry: string;
  /** 虚拟 TaskItem 定义 */
  taskDef: TaskItem;
  /** 相关选项定义（键为选项 key） */
  optionDefs: Record<string, OptionDefinition>;
  /** 图标名称（对应 lucide-react 图标） */
  iconName:
    | 'Clock'
    | 'Zap'
    | 'Bell'
    | 'Timer'
    | 'Pause'
    | 'Play'
    | 'MessageSquare'
    | 'XCircle'
    | 'Power';
  /** 图标颜色 CSS 类 */
  iconColorClass: string;
}

// MXU_SLEEP 特殊任务常量（保留向后兼容）
export const MXU_SLEEP_TASK_NAME = '__MXU_SLEEP__';
export const MXU_SLEEP_ENTRY = 'MXU_SLEEP';
export const MXU_SLEEP_ACTION = 'MXU_SLEEP_ACTION';

// MXU_WAITUNTIL 特殊任务常量
export const MXU_WAITUNTIL_TASK_NAME = '__MXU_WAITUNTIL__';
export const MXU_WAITUNTIL_ENTRY = 'MXU_WAITUNTIL';
export const MXU_WAITUNTIL_ACTION = 'MXU_WAITUNTIL_ACTION';

// MXU_LAUNCH 特殊任务常量
export const MXU_LAUNCH_TASK_NAME = '__MXU_LAUNCH__';
export const MXU_LAUNCH_ENTRY = 'MXU_LAUNCH';
export const MXU_LAUNCH_ACTION = 'MXU_LAUNCH_ACTION';

// MXU_WEBHOOK 特殊任务常量
export const MXU_WEBHOOK_TASK_NAME = '__MXU_WEBHOOK__';
export const MXU_WEBHOOK_ENTRY = 'MXU_WEBHOOK';
export const MXU_WEBHOOK_ACTION = 'MXU_WEBHOOK_ACTION';

// MXU_NOTIFY 特殊任务常量
export const MXU_NOTIFY_TASK_NAME = '__MXU_NOTIFY__';
export const MXU_NOTIFY_ENTRY = 'MXU_NOTIFY';
export const MXU_NOTIFY_ACTION = 'MXU_NOTIFY_ACTION';

// MXU_KILLPROC 特殊任务常量
export const MXU_KILLPROC_TASK_NAME = '__MXU_KILLPROC__';
export const MXU_KILLPROC_ENTRY = 'MXU_KILLPROC';
export const MXU_KILLPROC_ACTION = 'MXU_KILLPROC_ACTION';

// MXU_POWER 特殊任务常量
export const MXU_POWER_TASK_NAME = '__MXU_POWER__';
export const MXU_POWER_ENTRY = 'MXU_POWER';
export const MXU_POWER_ACTION = 'MXU_POWER_ACTION';

// 这类特殊任务不依赖游戏画面，固定 target 可避免在窗口消失后被空识别框拦截。
const MXU_NON_VISUAL_CUSTOM_TARGET: [number, number, number, number] = [0, 0, 1, 1];

// MXU_SLEEP 任务定义
const MXU_SLEEP_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_SLEEP_TASK_NAME,
  label: 'specialTask.sleep.label',
  entry: MXU_SLEEP_ENTRY,
  option: ['__MXU_SLEEP_OPTION__'],
  pipeline_override: {
    [MXU_SLEEP_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_SLEEP_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_SLEEP 选项定义
const MXU_SLEEP_OPTION_DEF_INTERNAL: InputOption = {
  type: 'input',
  label: 'specialTask.sleep.optionLabel',
  inputs: [
    {
      name: 'sleep_time',
      label: 'specialTask.sleep.inputLabel',
      default: '5',
      pipeline_type: 'int',
      verify: '^[1-9]\\d*$',
      pattern_msg: 'specialTask.sleep.inputError',
    },
  ],
  pipeline_override: {
    [MXU_SLEEP_ENTRY]: {
      custom_action_param: {
        sleep_time: '{sleep_time}',
      },
    },
  },
};

// MXU_WAITUNTIL 任务定义
const MXU_WAITUNTIL_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_WAITUNTIL_TASK_NAME,
  label: 'specialTask.waitUntil.label',
  entry: MXU_WAITUNTIL_ENTRY,
  option: ['__MXU_WAITUNTIL_OPTION__'],
  pipeline_override: {
    [MXU_WAITUNTIL_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_WAITUNTIL_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_WAITUNTIL 选项定义（目标时间）
const MXU_WAITUNTIL_OPTION_DEF_INTERNAL: InputOption = {
  type: 'input',
  label: 'specialTask.waitUntil.optionLabel',
  description: 'specialTask.waitUntil.optionDescription',
  inputs: [
    {
      name: 'target_time',
      label: 'specialTask.waitUntil.inputLabel',
      default: '08:00',
      pipeline_type: 'string',
      input_type: 'time',
    },
  ],
  pipeline_override: {
    [MXU_WAITUNTIL_ENTRY]: {
      custom_action_param: {
        target_time: '{target_time}',
      },
    },
  },
};

// MXU_LAUNCH 任务定义
const MXU_LAUNCH_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_LAUNCH_TASK_NAME,
  label: 'specialTask.launch.label',
  entry: MXU_LAUNCH_ENTRY,
  option: [
    '__MXU_LAUNCH_OPTION__',
    '__MXU_LAUNCH_WAIT_OPTION__',
    '__MXU_LAUNCH_SKIP_OPTION__',
    '__MXU_LAUNCH_CMD_OPTION__',
  ],
  pipeline_override: {
    [MXU_LAUNCH_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_LAUNCH_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_LAUNCH 输入选项定义（程序路径和参数）
const MXU_LAUNCH_INPUT_OPTION_DEF_INTERNAL: InputOption = {
  type: 'input',
  label: 'specialTask.launch.optionLabel',
  inputs: [
    {
      name: 'program',
      label: 'specialTask.launch.programLabel',
      default: '',
      pipeline_type: 'string',
      input_type: 'file',
      placeholder: 'specialTask.launch.programPlaceholder',
    },
    {
      name: 'args',
      label: 'specialTask.launch.argsLabel',
      default: '',
      pipeline_type: 'string',
      placeholder: 'specialTask.launch.argsPlaceholder',
    },
  ],
  pipeline_override: {
    [MXU_LAUNCH_ENTRY]: {
      custom_action_param: {
        program: '{program}',
        args: '{args}',
      },
    },
  },
};

// MXU_LAUNCH 等待选项定义（是否等待进程退出）
const MXU_LAUNCH_WAIT_OPTION_DEF_INTERNAL: SwitchOption = {
  type: 'switch',
  label: 'specialTask.launch.waitLabel',
  description: 'specialTask.launch.waitDescription',
  cases: [
    {
      name: 'Yes',
      label: 'specialTask.launch.waitYes',
      pipeline_override: {
        [MXU_LAUNCH_ENTRY]: {
          custom_action_param: {
            wait_for_exit: true,
          },
        },
      },
    },
    {
      name: 'No',
      label: 'specialTask.launch.waitNo',
      pipeline_override: {
        [MXU_LAUNCH_ENTRY]: {
          custom_action_param: {
            wait_for_exit: false,
          },
        },
      },
    },
  ],
  default_case: 'No',
};

// MXU_LAUNCH 使用 cmd /c 启动选项定义（仅 Windows 生效）
const MXU_LAUNCH_CMD_OPTION_DEF_INTERNAL: SwitchOption = {
  type: 'switch',
  label: 'specialTask.launch.cmdLabel',
  description: 'specialTask.launch.cmdDescription',
  cases: [
    {
      name: 'Yes',
      label: 'specialTask.launch.cmdYes',
      pipeline_override: {
        [MXU_LAUNCH_ENTRY]: {
          custom_action_param: {
            use_cmd: true,
          },
        },
      },
    },
    {
      name: 'No',
      label: 'specialTask.launch.cmdNo',
      pipeline_override: {
        [MXU_LAUNCH_ENTRY]: {
          custom_action_param: {
            use_cmd: false,
          },
        },
      },
    },
  ],
  default_case: 'No',
};

// MXU_LAUNCH 跳过已运行选项定义
const MXU_LAUNCH_SKIP_OPTION_DEF_INTERNAL: SwitchOption = {
  type: 'switch',
  label: 'specialTask.launch.skipLabel',
  description: 'specialTask.launch.skipDescription',
  cases: [
    {
      name: 'Yes',
      label: 'specialTask.launch.skipYes',
      pipeline_override: {
        [MXU_LAUNCH_ENTRY]: {
          custom_action_param: {
            skip_if_running: true,
          },
        },
      },
    },
    {
      name: 'No',
      label: 'specialTask.launch.skipNo',
      pipeline_override: {
        [MXU_LAUNCH_ENTRY]: {
          custom_action_param: {
            skip_if_running: false,
          },
        },
      },
    },
  ],
  default_case: 'No',
};

// MXU_WEBHOOK 任务定义
const MXU_WEBHOOK_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_WEBHOOK_TASK_NAME,
  label: 'specialTask.webhook.label',
  entry: MXU_WEBHOOK_ENTRY,
  option: ['__MXU_WEBHOOK_OPTION__'],
  pipeline_override: {
    [MXU_WEBHOOK_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_WEBHOOK_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_WEBHOOK 输入选项定义（URL）
const MXU_WEBHOOK_OPTION_DEF_INTERNAL: InputOption = {
  type: 'input',
  label: 'specialTask.webhook.optionLabel',
  inputs: [
    {
      name: 'url',
      label: 'specialTask.webhook.urlLabel',
      default: '',
      pipeline_type: 'string',
      placeholder: 'specialTask.webhook.urlPlaceholder',
    },
  ],
  pipeline_override: {
    [MXU_WEBHOOK_ENTRY]: {
      custom_action_param: {
        url: '{url}',
      },
    },
  },
};

// MXU_NOTIFY 任务定义
const MXU_NOTIFY_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_NOTIFY_TASK_NAME,
  label: 'specialTask.notify.label',
  entry: MXU_NOTIFY_ENTRY,
  option: ['__MXU_NOTIFY_OPTION__'],
  pipeline_override: {
    [MXU_NOTIFY_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_NOTIFY_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_NOTIFY 输入选项定义（通知标题和内容）
const MXU_NOTIFY_OPTION_DEF_INTERNAL: InputOption = {
  type: 'input',
  label: 'specialTask.notify.optionLabel',
  inputs: [
    {
      name: 'title',
      label: 'specialTask.notify.titleLabel',
      default: 'MXU',
      pipeline_type: 'string',
      placeholder: 'specialTask.notify.titlePlaceholder',
    },
    {
      name: 'body',
      label: 'specialTask.notify.bodyLabel',
      default: '',
      pipeline_type: 'string',
      placeholder: 'specialTask.notify.bodyPlaceholder',
    },
  ],
  pipeline_override: {
    [MXU_NOTIFY_ENTRY]: {
      custom_action_param: {
        title: '{title}',
        body: '{body}',
      },
    },
  },
};

// MXU_KILLPROC 任务定义
const MXU_KILLPROC_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_KILLPROC_TASK_NAME,
  label: 'specialTask.killProc.label',
  entry: MXU_KILLPROC_ENTRY,
  option: ['__MXU_KILLPROC_SELF_OPTION__'],
  pipeline_override: {
    [MXU_KILLPROC_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_KILLPROC_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_KILLPROC 开关选项定义（是否结束自身）
const MXU_KILLPROC_SELF_OPTION_DEF_INTERNAL: SwitchOption = {
  type: 'switch',
  label: 'specialTask.killProc.selfLabel',
  description: 'specialTask.killProc.selfDescription',
  cases: [
    {
      name: 'Yes',
      label: 'specialTask.killProc.selfYes',
      pipeline_override: {
        [MXU_KILLPROC_ENTRY]: {
          custom_action_param: {
            kill_self: true,
          },
        },
      },
    },
    {
      name: 'No',
      label: 'specialTask.killProc.selfNo',
      option: ['__MXU_KILLPROC_NAME_OPTION__'],
      pipeline_override: {
        [MXU_KILLPROC_ENTRY]: {
          custom_action_param: {
            kill_self: false,
          },
        },
      },
    },
  ],
  default_case: 'Yes',
};

// MXU_KILLPROC 输入选项定义（进程名称）
const MXU_KILLPROC_NAME_OPTION_DEF_INTERNAL: InputOption = {
  type: 'input',
  label: 'specialTask.killProc.nameOptionLabel',
  inputs: [
    {
      name: 'process_name',
      label: 'specialTask.killProc.nameLabel',
      default: '',
      pipeline_type: 'string',
      placeholder: 'specialTask.killProc.namePlaceholder',
    },
  ],
  pipeline_override: {
    [MXU_KILLPROC_ENTRY]: {
      custom_action_param: {
        process_name: '{process_name}',
      },
    },
  },
};

// MXU_POWER 任务定义
const MXU_POWER_TASK_DEF_INTERNAL: TaskItem = {
  name: MXU_POWER_TASK_NAME,
  label: 'specialTask.power.label',
  entry: MXU_POWER_ENTRY,
  option: ['__MXU_POWER_OPTION__'],
  pipeline_override: {
    [MXU_POWER_ENTRY]: {
      action: 'Custom',
      custom_action: MXU_POWER_ACTION,
      target: MXU_NON_VISUAL_CUSTOM_TARGET,
    },
  },
};

// MXU_POWER 下拉选项定义（关机/重启/息屏/睡眠/休眠/静音/解除静音）
const MXU_POWER_OPTION_DEF_INTERNAL: SelectOption = {
  type: 'select',
  label: 'specialTask.power.optionLabel',
  cases: [
    {
      name: 'shutdown',
      label: 'specialTask.power.shutdown',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'shutdown',
          },
        },
      },
    },
    {
      name: 'restart',
      label: 'specialTask.power.restart',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'restart',
          },
        },
      },
    },
    {
      name: 'screenoff',
      label: 'specialTask.power.screenoff',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'screenoff',
          },
        },
      },
    },
    {
      name: 'sleep',
      label: 'specialTask.power.sleep',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'sleep',
          },
        },
      },
    },
    {
      name: 'hibernate',
      label: 'specialTask.power.hibernate',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'hibernate',
          },
        },
      },
    },
    {
      name: 'mute',
      label: 'specialTask.power.mute',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'mute',
          },
        },
      },
    },
    {
      name: 'unmute',
      label: 'specialTask.power.unmute',
      pipeline_override: {
        [MXU_POWER_ENTRY]: {
          custom_action_param: {
            power_action: 'unmute',
          },
        },
      },
    },
  ],
  default_case: 'shutdown',
};

/**
 * MXU 特殊任务注册表
 * 所有 MXU 内置特殊任务都在这里注册
 * 添加新特殊任务只需在此注册表中添加新条目
 */
/**
 * MXU 特殊任务注册表（按用户使用频率排序）
 * 所有 MXU 内置特殊任务都在这里注册
 * 添加新特殊任务只需在此注册表中添加新条目
 *
 * 排序（不含"前置任务"，前置任务在 AddTaskPanel 中独立渲染）：
 */
export const MXU_SPECIAL_TASKS: Record<string, MxuSpecialTaskDefinition> = {
  [MXU_SLEEP_TASK_NAME]: {
    taskName: MXU_SLEEP_TASK_NAME,
    entry: MXU_SLEEP_ENTRY,
    taskDef: MXU_SLEEP_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_SLEEP_OPTION__: MXU_SLEEP_OPTION_DEF_INTERNAL,
    },
    iconName: 'Timer',
    iconColorClass: 'text-warning/80',
  },
  [MXU_WAITUNTIL_TASK_NAME]: {
    taskName: MXU_WAITUNTIL_TASK_NAME,
    entry: MXU_WAITUNTIL_ENTRY,
    taskDef: MXU_WAITUNTIL_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_WAITUNTIL_OPTION__: MXU_WAITUNTIL_OPTION_DEF_INTERNAL,
    },
    iconName: 'Clock',
    iconColorClass: 'text-accent/80',
  },
  [MXU_NOTIFY_TASK_NAME]: {
    taskName: MXU_NOTIFY_TASK_NAME,
    entry: MXU_NOTIFY_ENTRY,
    taskDef: MXU_NOTIFY_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_NOTIFY_OPTION__: MXU_NOTIFY_OPTION_DEF_INTERNAL,
    },
    iconName: 'MessageSquare',
    iconColorClass: 'text-info/80',
  },
  [MXU_LAUNCH_TASK_NAME]: {
    taskName: MXU_LAUNCH_TASK_NAME,
    entry: MXU_LAUNCH_ENTRY,
    taskDef: MXU_LAUNCH_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_LAUNCH_OPTION__: MXU_LAUNCH_INPUT_OPTION_DEF_INTERNAL,
      __MXU_LAUNCH_WAIT_OPTION__: MXU_LAUNCH_WAIT_OPTION_DEF_INTERNAL,
      __MXU_LAUNCH_SKIP_OPTION__: MXU_LAUNCH_SKIP_OPTION_DEF_INTERNAL,
      __MXU_LAUNCH_CMD_OPTION__: MXU_LAUNCH_CMD_OPTION_DEF_INTERNAL,
    },
    iconName: 'Play',
    iconColorClass: 'text-success/80',
  },
  [MXU_KILLPROC_TASK_NAME]: {
    taskName: MXU_KILLPROC_TASK_NAME,
    entry: MXU_KILLPROC_ENTRY,
    taskDef: MXU_KILLPROC_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_KILLPROC_SELF_OPTION__: MXU_KILLPROC_SELF_OPTION_DEF_INTERNAL,
      __MXU_KILLPROC_NAME_OPTION__: MXU_KILLPROC_NAME_OPTION_DEF_INTERNAL,
    },
    iconName: 'XCircle',
    iconColorClass: 'text-error/80',
  },
  [MXU_POWER_TASK_NAME]: {
    taskName: MXU_POWER_TASK_NAME,
    entry: MXU_POWER_ENTRY,
    taskDef: MXU_POWER_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_POWER_OPTION__: MXU_POWER_OPTION_DEF_INTERNAL,
    },
    iconName: 'Power',
    iconColorClass: 'text-warning/80',
  },
  [MXU_WEBHOOK_TASK_NAME]: {
    taskName: MXU_WEBHOOK_TASK_NAME,
    entry: MXU_WEBHOOK_ENTRY,
    taskDef: MXU_WEBHOOK_TASK_DEF_INTERNAL,
    optionDefs: {
      __MXU_WEBHOOK_OPTION__: MXU_WEBHOOK_OPTION_DEF_INTERNAL,
    },
    iconName: 'Bell',
    iconColorClass: 'text-accent/80',
  },
};

// 导出兼容旧代码的常量（指向注册表中的定义）
export const MXU_SLEEP_TASK_DEF = MXU_SPECIAL_TASKS[MXU_SLEEP_TASK_NAME].taskDef;
export const MXU_SLEEP_OPTION_DEF = MXU_SPECIAL_TASKS[MXU_SLEEP_TASK_NAME].optionDefs[
  '__MXU_SLEEP_OPTION__'
] as InputOption;

/**
 * 判断是否为 MXU 内置特殊任务
 * @param taskName 任务名称
 * @returns 是否为特殊任务
 */
export function isMxuSpecialTask(taskName: string): boolean {
  return taskName in MXU_SPECIAL_TASKS;
}

/**
 * 获取 MXU 特殊任务定义
 * @param taskName 任务名称
 * @returns 特殊任务定义，不存在则返回 undefined
 */
export function getMxuSpecialTask(taskName: string): MxuSpecialTaskDefinition | undefined {
  return MXU_SPECIAL_TASKS[taskName];
}

/**
 * 获取 MXU 特殊任务的选项定义
 * @param taskName 任务名称
 * @param optionKey 选项键
 * @returns 选项定义，不存在则返回 undefined
 */
export function getMxuSpecialTaskOption(
  taskName: string,
  optionKey: string,
): OptionDefinition | undefined {
  const specialTask = MXU_SPECIAL_TASKS[taskName];
  return specialTask?.optionDefs[optionKey];
}

/**
 * 通过选项键反查 MXU 特殊任务的选项定义
 * 遍历所有注册的特殊任务，查找包含该 optionKey 的选项定义
 * @param optionKey 选项键，如 '__MXU_LAUNCH_WAIT_OPTION__'
 * @returns 选项定义，不存在则返回 undefined
 */
export function findMxuOptionByKey(optionKey: string): OptionDefinition | undefined {
  for (const specialTask of Object.values(MXU_SPECIAL_TASKS)) {
    const optionDef = specialTask.optionDefs[optionKey];
    if (optionDef) return optionDef;
  }
  return undefined;
}

/**
 * 获取所有 MXU 特殊任务定义列表
 * @returns 特殊任务定义数组
 */
export function getAllMxuSpecialTasks(): MxuSpecialTaskDefinition[] {
  return Object.values(MXU_SPECIAL_TASKS);
}

/**
 * 获取所有 MXU 特殊任务参数列表
 * @returns 特殊任务参数记录
 */
export function getAllMxuSpecialTasksOptions(): Record<string, OptionDefinition> {
  let rec: Record<string, OptionDefinition> = {};
  getAllMxuSpecialTasks().forEach((specialTask) => {
    Object.entries(specialTask.optionDefs).forEach((t) => {
      rec[t[0]] = t[1];
    });
  });
  return rec;
}
