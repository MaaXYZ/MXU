/**
 * 容器任务定义：把若干「作战任务」条目收纳进轮换容器的能力（目前为 MaaEnd DLC）。
 *
 * 容器任务本身是一个普通的 PI 任务；拖入容器的每个条目都是一个独立的轮换
 * 槽位（可以有多个同型任务，各带自身配置与阈值）。装配运行时 MXU 会把槽位表
 * （任务名 + 逐槽位阈值）写入容器入口节点的 `attach`，并只合并「当前槽位」
 * 条目的选项覆写；项目侧从该节点读取槽位表，负责轮换与状态持久化。
 * 做成注册表便于以后通用化（例如由 interface.json 声明容器能力）。
 */
/** 子条目显示名后缀规则（用于把「协议空间」等条目按所选类型命名）。 */
export interface ContainerDisplaySuffixRule {
  /** 第一段取哪个选项的当前 case 标签 */
  optionKey: string;
  /** 为 true 时追加第二段：取「当前 case 名同名的选项」的当前 case 标签 */
  followCaseOption?: boolean;
}

export interface ContainerTaskDefinition {
  /** 容器任务在 interface.json 中的任务名 */
  taskName: string;
  /** 允许被收纳的子任务名 */
  childTaskNames: string[];
  /** 状态文件相对 Agent 工作目录（basePath）的路径 */
  stateFile: string;
  /** 槽位表以 attach 写入的容器入口节点名 */
  attachNode: string;
  /** 子任务名 → 该任务的「循环作战协议阈值」选项 key（MXU 读取其选项值写入 `slot_thresholds`） */
  thresholdOptions: Record<string, string>;
  /** 子任务名 → 在容器内隐藏的选项 key（如已被容器接管的「执行周期」） */
  childHiddenOptions: Record<string, string[]>;
  /** 子条目显示名后缀规则（按选项当前选择动态命名） */
  displaySuffix?: ContainerDisplaySuffixRule;
}

/** 容器任务注册表。目前仅 MaaEnd 的「循环作战协议」。 */
export const CONTAINER_TASKS: Record<string, ContainerTaskDefinition> = {
  CombatProtocol: {
    taskName: 'CombatProtocol',
    childTaskNames: ['AutoEssence', 'ProtocolSpace'],
    stateFile: 'debug/record/CombatProtocol.json',
    attachNode: 'CombatProtocolMain',
    thresholdOptions: {
      AutoEssence: 'AutoEssenceCycleThreshold',
      ProtocolSpace: 'ProtocolSpaceCycleThreshold',
    },
    // 执行周期（星期勾选）已由容器接管，容器内的条目不再展示
    childHiddenOptions: {
      AutoEssence: ['AutoEssenceSchedule'],
      ProtocolSpace: ['ProtocolSpaceSchedule'],
    },
    // 协议空间：显示名后缀 = 分页（员养成/武器养成/危境预演）- 该分页下的细分种类
    displaySuffix: { optionKey: 'ProtocolSpaceTab', followCaseOption: true },
  },
};

/** 返回任务名对应的容器定义（不是容器任务时返回 undefined） */
export function getContainerDefinition(taskName: string): ContainerTaskDefinition | undefined {
  return CONTAINER_TASKS[taskName];
}

/** 任务名是否为容器任务 */
export function isContainerTaskName(taskName: string): boolean {
  return taskName in CONTAINER_TASKS;
}

/** 任务名能否被某个容器收纳（自身不是容器且被任一容器的 childTaskNames 支持） */
export function getContainerForChild(taskName: string): ContainerTaskDefinition | undefined {
  if (isContainerTaskName(taskName)) return undefined;
  return Object.values(CONTAINER_TASKS).find((def) => def.childTaskNames.includes(taskName));
}

/**
 * 依据槽位表（任务名 + 逐槽位阈值，按条目顺序）生成写入容器 `attach` 的
 * 合成覆写。该覆写随运行任务一并下发给项目侧，是槽位信息的唯一传递通道。
 */
export function buildContainerAttachOverride(
  def: ContainerTaskDefinition,
  slotTaskNames: string[],
  slotThresholds: number[],
): Record<string, unknown> {
  return {
    [def.attachNode]: {
      attach: {
        slots: [...slotTaskNames],
        slot_thresholds: [...slotThresholds],
      },
    },
  };
}
