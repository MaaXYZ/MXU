/**
 * MCP 选项工具：选项结构描述、AI 传入值的严格校验与转换、当前值的可读输出。
 *
 * AI 侧使用与 interface.json preset 相同的取值格式：
 * - select：case 名称字符串
 * - checkbox：case 名称数组
 * - switch："Yes" / "No"
 * - input / hotkey：{ 字段名: 字符串值 }
 */
import type { CaseItem, InputItem, OptionDefinition, OptionValue } from '@/types/interface';
import { createDefaultOptionValue } from '@/stores/helpers';
import { findSwitchCase } from '@/utils/optionHelpers';

/** 密码字段在输出中的占位符 */
export const MASKED_VALUE = '******';

export interface OptionContext {
  /** 解析 label / description 为界面显示文本 */
  resolveText: (text: string | undefined) => string | undefined;
  controllerName?: string;
  resourceName?: string;
  /** 翻译错误信息（key 对应语言包 mcp.errors.*）；不传时使用内置中文 */
  translate?: (key: string, params: Record<string, string | number>) => string;
}

/** 错误信息的内置中文（与语言包 zh-CN 的 mcp.errors 保持一致） */
const DEFAULT_MESSAGES: Record<string, string> = {
  optionNotFoundForDescribe:
    '任务没有选项 "{{key}}"，请先不带 option_key 调用 describe_task 查看选项列表',
  optionIncompatible: '选项 "{{key}}" 不适用于当前控制器/资源',
  optionNotFound: '任务没有选项 "{{key}}"，可用选项：{{valid}}',
  noSettableOptions: '任务没有可设置的选项',
  inputNeedsObject: '选项 "{{key}}" 需要传入 { 字段名: 值 } 对象',
  inputFieldNotFound: '选项 "{{key}}" 没有字段 "{{name}}"，可用字段：{{valid}}',
  inputFieldNotString: '选项 "{{key}}" 的字段 "{{name}}" 需要传入字符串',
  inputFieldInvalid:
    '选项 "{{key}}" 的字段 "{{name}}" 的值 "{{value}}" 不符合格式要求（正则：{{verify}}）',
  inputFieldInvalidWithHint:
    '选项 "{{key}}" 的字段 "{{name}}" 的值 "{{value}}" 不符合格式要求：{{hint}}（正则：{{verify}}）',
  switchInvalid: '选项 "{{key}}" 是开关，取值只能是 "Yes" 或 "No"',
  checkboxNeedsArray: '选项 "{{key}}" 是多选，需要传入取值名称数组，可选：{{valid}}',
  casesInvalid: '选项 "{{key}}" 没有取值 {{invalid}}，可选：{{valid}}',
  checkboxMin: '选项 "{{key}}" 至少需要选择 {{count}} 项',
  checkboxMax: '选项 "{{key}}" 最多只能选择 {{count}} 项',
  selectInvalid: '选项 "{{key}}" 没有取值 "{{value}}"，可选：{{valid}}',
};

function message(
  ctx: OptionContext,
  key: string,
  params: Record<string, string | number> = {},
): Error {
  const text = ctx.translate
    ? ctx.translate(key, params)
    : (DEFAULT_MESSAGES[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
        String(params[name] ?? ''),
      );
  return new Error(text);
}

export interface McpCaseDescription {
  name: string;
  label?: string;
  description?: string;
  /** 选中该取值后出现的子选项 key（定义见 options 表） */
  options?: string[];
}

export interface McpInputDescription {
  name: string;
  label?: string;
  description?: string;
  default?: string;
  /** 取值需匹配的正则 */
  verify?: string;
  verify_message?: string;
  password?: boolean;
}

export interface McpOptionDescription {
  type: 'select' | 'checkbox' | 'switch' | 'input' | 'hotkey';
  label?: string;
  description?: string;
  /** 默认值（preset 格式） */
  default?: unknown;
  cases?: McpCaseDescription[];
  inputs?: McpInputDescription[];
  min_count?: number;
  max_count?: number;
  /** 取值列表与该选项完全相同（省略 cases，避免重复输出大列表） */
  cases_same_as?: string;
  /** 取值过多时省略 cases，只给出数量；用 describe_task 的 option_key 单独查看 */
  case_count?: number;
  cases_omitted?: boolean;
}

/**
 * 选项结构（与 interface.json 一致的摊平形式）：
 * root_options 为顶层选项 key，options 为 key → 定义表，取值下的 options 为子选项 key。
 */
export interface McpOptionTree {
  root_options: string[];
  options: Record<string, McpOptionDescription>;
}

const SWITCH_YES = ['Yes', 'yes', 'Y', 'y', 'true', 'True'];
const SWITCH_NO = ['No', 'no', 'N', 'n', 'false', 'False'];

const optionType = (def: OptionDefinition) => def.type || 'select';

/** 选项是否不适用于当前控制器/资源（与生成 pipeline_override 时的判断一致） */
export function isOptionIncompatible(def: OptionDefinition, ctx: OptionContext): boolean {
  if (def.controller && def.controller.length > 0) {
    if (!ctx.controllerName || !def.controller.includes(ctx.controllerName)) return true;
  }
  if (def.resource && def.resource.length > 0) {
    if (!ctx.resourceName || !def.resource.includes(ctx.resourceName)) return true;
  }
  return false;
}

/** 把运行时选项值转为 preset 格式 */
function toPresetValue(def: OptionDefinition, value: OptionValue): unknown {
  switch (value.type) {
    case 'select':
      return value.caseName;
    case 'checkbox':
      return [...value.caseNames];
    case 'switch':
      return value.value ? 'Yes' : 'No';
    case 'input': {
      const inputs = def.type === 'input' ? def.inputs : [];
      const result: Record<string, string> = {};
      for (const [name, val] of Object.entries(value.values)) {
        const inputDef = inputs.find((i) => i.name === name);
        result[name] = inputDef?.password && val ? MASKED_VALUE : val;
      }
      return result;
    }
    case 'hotkey':
      return { ...value.values };
  }
}

/** 当前取值下处于激活状态的子选项 key */
function activeChildKeys(def: OptionDefinition, value: OptionValue | undefined): string[] {
  if (!value) return [];
  if (def.type === 'switch' && value.type === 'switch') {
    return findSwitchCase(def.cases, value.value)?.option ?? [];
  }
  if ((!def.type || def.type === 'select') && value.type === 'select') {
    return def.cases.find((c) => c.name === value.caseName)?.option ?? [];
  }
  if (def.type === 'checkbox' && value.type === 'checkbox') {
    return def.cases.filter((c) => value.caseNames.includes(c.name)).flatMap((c) => c.option ?? []);
  }
  return [];
}

// ============================================================================
// 结构描述
// ============================================================================

function describeInput(input: InputItem, ctx: OptionContext): McpInputDescription {
  return {
    name: input.name,
    label: ctx.resolveText(input.label),
    description: ctx.resolveText(input.description),
    default: input.default,
    verify: input.verify,
    verify_message: ctx.resolveText(input.pattern_msg),
    password: input.password || undefined,
  };
}

/** 取值数量达到此值时，才对完全相同的取值列表做去重 */
const CASE_LIST_DEDUPE_MIN = 8;
/** 取值数量超过此值时默认不展开（如物品、角色清单），需单独查看 */
export const CASE_LIST_COLLAPSE_MAX = 50;

interface DescribeState {
  allOptions: Record<string, OptionDefinition>;
  ctx: OptionContext;
  /** 输出的定义表（同时用于去重与防止循环引用） */
  table: Record<string, McpOptionDescription>;
  /** 取值列表签名 → 首次出现的选项 key */
  caseLists: Map<string, string>;
  /** 单独查看的选项：即使取值很多也完整展开 */
  expandKey?: string;
}

/** 描述一组选项，返回其中可用（存在且兼容当前控制器/资源）的 key */
function visitOptions(keys: string[] | undefined, state: DescribeState): string[] {
  const result: string[] = [];
  for (const key of keys ?? []) {
    const def = state.allOptions[key];
    if (!def || isOptionIncompatible(def, state.ctx)) continue;
    visitOption(key, def, state);
    result.push(key);
  }
  return result;
}

function describeCase(caseItem: CaseItem, state: DescribeState): McpCaseDescription {
  const children = visitOptions(caseItem.option, state);
  return {
    name: caseItem.name,
    label: state.ctx.resolveText(caseItem.label),
    description: state.ctx.resolveText(caseItem.description),
    options: children.length > 0 ? children : undefined,
  };
}

function visitOption(key: string, def: OptionDefinition, state: DescribeState) {
  // 每个选项只描述一次；先占位再递归，避免循环引用
  if (state.table[key]) return;
  const { ctx } = state;
  const desc: McpOptionDescription = {
    type: optionType(def),
    label: ctx.resolveText(def.label),
    description: ctx.resolveText(def.description),
    default: toPresetValue(def, createDefaultOptionValue(def)),
  };
  state.table[key] = desc;

  if (def.type === 'input') {
    desc.inputs = def.inputs.map((i) => describeInput(i, ctx));
  } else if (def.type === 'hotkey') {
    desc.inputs = def.hotkeys.map((i) => describeInput(i, ctx));
  } else if (def.type === 'switch') {
    // switch 的取值统一为 Yes / No；只有存在子选项时才列出取值
    const yesCase = findSwitchCase(def.cases, true);
    const noCase = findSwitchCase(def.cases, false);
    const cases = [
      { ...describeCase(yesCase ?? { name: 'Yes' }, state), name: 'Yes' },
      { ...describeCase(noCase ?? { name: 'No' }, state), name: 'No' },
    ];
    if (cases.some((c) => c.options)) desc.cases = cases;
  } else {
    if (def.type === 'checkbox') {
      desc.min_count = def.min_count;
      desc.max_count = def.max_count;
    }
    if (def.cases.length > CASE_LIST_COLLAPSE_MAX && key !== state.expandKey) {
      // 取值过多：只给数量，AI 需要时再用 option_key 单独查看
      desc.case_count = def.cases.length;
      desc.cases_omitted = true;
      return;
    }
    const cases = def.cases.map((c) => describeCase(c, state));
    // 多个选项共用同一份大列表（如多个优先级下拉框）时，只输出第一份
    const signature = cases.length >= CASE_LIST_DEDUPE_MIN ? JSON.stringify(cases) : null;
    const sameAs = signature ? state.caseLists.get(signature) : undefined;
    if (sameAs) {
      desc.cases_same_as = sameAs;
    } else {
      desc.cases = cases;
      if (signature) state.caseLists.set(signature, key);
    }
  }
}

/**
 * 描述任务的选项结构（摊平形式，跳过不适用于当前控制器/资源的选项）。
 * 为控制体积：完全相同的大取值列表只输出一次（之后用 cases_same_as 引用），
 * 取值超过 CASE_LIST_COLLAPSE_MAX 的列表不展开（标记 cases_omitted）。
 */
export function describeOptions(
  optionKeys: string[],
  allOptions: Record<string, OptionDefinition>,
  ctx: OptionContext,
): McpOptionTree {
  const state: DescribeState = { allOptions, ctx, table: {}, caseLists: new Map() };
  const root = visitOptions(optionKeys, state);
  return { root_options: root, options: state.table };
}

/** 单独描述任务中的某个选项（含其子选项），该选项的取值列表完整展开 */
export function describeSingleOption(
  optionKey: string,
  optionKeys: string[],
  allOptions: Record<string, OptionDefinition>,
  ctx: OptionContext,
): McpOptionTree {
  const reachable = collectReachableKeys(optionKeys, allOptions);
  const def = allOptions[optionKey];
  if (!reachable.has(optionKey) || !def) {
    throw message(ctx, 'optionNotFoundForDescribe', { key: optionKey });
  }
  if (isOptionIncompatible(def, ctx)) {
    throw message(ctx, 'optionIncompatible', { key: optionKey });
  }
  const state: DescribeState = {
    allOptions,
    ctx,
    table: {},
    caseLists: new Map(),
    expandKey: optionKey,
  };
  const root = visitOptions([optionKey], state);
  return { root_options: root, options: state.table };
}

// ============================================================================
// 校验与转换
// ============================================================================

/** 收集可设置的选项 key：顶层选项及其所有取值下的子选项 */
function collectReachableKeys(
  optionKeys: string[],
  allOptions: Record<string, OptionDefinition>,
  result: Set<string> = new Set(),
): Set<string> {
  for (const key of optionKeys) {
    const def = allOptions[key];
    if (!def || result.has(key)) continue;
    result.add(key);
    if (def.type !== 'input' && def.type !== 'hotkey') {
      for (const c of def.cases) {
        if (c.option?.length) collectReachableKeys(c.option, allOptions, result);
      }
    }
  }
  return result;
}

const listNames = (names: string[]) => names.map((n) => `"${n}"`).join(', ');

function convertFields(
  key: string,
  raw: unknown,
  inputs: InputItem[],
  base: Record<string, string>,
  ctx: OptionContext,
): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw message(ctx, 'inputNeedsObject', { key });
  }
  const validNames = inputs.map((i) => i.name);
  const values = { ...base };
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    const inputDef = inputs.find((i) => i.name === name);
    if (!inputDef) {
      throw message(ctx, 'inputFieldNotFound', { key, name, valid: listNames(validNames) });
    }
    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
      throw message(ctx, 'inputFieldNotString', { key, name });
    }
    const str = String(val);
    // 密码在输出中被打码；AI 原样传回打码值时保留已保存的密码，避免被占位符覆盖
    if (inputDef.password && str === MASKED_VALUE) continue;
    if (inputDef.verify) {
      let matched = true;
      try {
        matched = new RegExp(inputDef.verify).test(str);
      } catch {
        // 项目提供的正则无效时不做校验，与界面行为一致
      }
      if (!matched) {
        // 带上项目配置的格式提示（与界面显示一致），便于 AI 理解如何修正
        const hint = ctx.resolveText(inputDef.pattern_msg);
        const params = { key, name, value: str, verify: inputDef.verify };
        throw hint
          ? message(ctx, 'inputFieldInvalidWithHint', { ...params, hint })
          : message(ctx, 'inputFieldInvalid', params);
      }
    }
    values[name] = str;
  }
  return values;
}

function convertValue(
  key: string,
  def: OptionDefinition,
  raw: unknown,
  ctx: OptionContext,
  inputBase?: Record<string, string>,
): OptionValue {
  const type = optionType(def);

  if (type === 'input' || type === 'hotkey') {
    const inputs = def.type === 'input' ? def.inputs : def.type === 'hotkey' ? def.hotkeys : [];
    const defaults = createDefaultOptionValue(def);
    const base = {
      ...(defaults.type === 'input' || defaults.type === 'hotkey' ? defaults.values : {}),
      ...inputBase,
    };
    const values = convertFields(key, raw, inputs, base, ctx);
    return type === 'input' ? { type: 'input', values } : { type: 'hotkey', values };
  }

  if (def.type === 'switch') {
    if (raw === true || (typeof raw === 'string' && SWITCH_YES.includes(raw))) {
      return { type: 'switch', value: true };
    }
    if (raw === false || (typeof raw === 'string' && SWITCH_NO.includes(raw))) {
      return { type: 'switch', value: false };
    }
    throw message(ctx, 'switchInvalid', { key });
  }

  const caseNames =
    def.type === 'input' || def.type === 'hotkey' ? [] : def.cases.map((c) => c.name);

  if (def.type === 'checkbox') {
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      throw message(ctx, 'checkboxNeedsArray', { key, valid: listNames(caseNames) });
    }
    const invalid = (raw as string[]).filter((v) => !caseNames.includes(v));
    if (invalid.length > 0) {
      throw message(ctx, 'casesInvalid', {
        key,
        invalid: listNames(invalid),
        valid: listNames(caseNames),
      });
    }
    const selected = [...new Set(raw as string[])];
    if (def.min_count !== undefined && selected.length < def.min_count) {
      throw message(ctx, 'checkboxMin', { key, count: def.min_count });
    }
    if (def.max_count !== undefined && selected.length > def.max_count) {
      throw message(ctx, 'checkboxMax', { key, count: def.max_count });
    }
    return { type: 'checkbox', caseNames: selected };
  }

  // select
  if (typeof raw !== 'string' || !caseNames.includes(raw)) {
    throw message(ctx, 'selectInvalid', { key, value: String(raw), valid: listNames(caseNames) });
  }
  return { type: 'select', caseName: raw };
}

/** 为已设置的取值补齐新激活的子选项默认值 */
function fillActivatedChildren(
  keys: string[],
  allOptions: Record<string, OptionDefinition>,
  values: Record<string, OptionValue>,
  defaults: Record<string, OptionValue>,
  visiting: Set<string> = new Set(),
) {
  for (const key of keys) {
    const def = allOptions[key];
    if (!def || visiting.has(key)) continue;
    visiting.add(key);
    const current = values[key] ?? defaults[key];
    const children = activeChildKeys(def, current);
    for (const child of children) {
      const childDef = allOptions[child];
      if (childDef && !values[child] && !defaults[child]) {
        values[child] = createDefaultOptionValue(childDef);
      }
    }
    fillActivatedChildren(children, allOptions, values, defaults, visiting);
  }
}

export interface ConvertOptionsParams {
  /** 任务的顶层选项 key */
  optionKeys: string[];
  allOptions: Record<string, OptionDefinition>;
  /** 任务添加时的默认选项值 */
  defaults: Record<string, OptionValue>;
  /** AI 传入的选项（preset 格式） */
  input: Record<string, unknown>;
  ctx: OptionContext;
}

/**
 * 校验并转换 AI 传入的选项值。
 * 返回需要覆盖到默认值之上的选项值；校验失败时抛出带合法取值提示的错误。
 */
export function convertMcpOptions({
  optionKeys,
  allOptions,
  defaults,
  input,
  ctx,
}: ConvertOptionsParams): Record<string, OptionValue> {
  const reachable = collectReachableKeys(optionKeys, allOptions);
  const values: Record<string, OptionValue> = {};

  for (const [key, raw] of Object.entries(input)) {
    if (!reachable.has(key)) {
      const valid = [...reachable].filter((k) => !isOptionIncompatible(allOptions[k], ctx));
      throw valid.length > 0
        ? message(ctx, 'optionNotFound', { key, valid: listNames(valid) })
        : message(ctx, 'noSettableOptions');
    }
    const def = allOptions[key];
    if (isOptionIncompatible(def, ctx)) {
      throw message(ctx, 'optionIncompatible', { key });
    }
    const base = defaults[key];
    const inputBase = base && (base.type === 'input' || base.type === 'hotkey') ? base.values : {};
    values[key] = convertValue(key, def, raw, ctx, inputBase);
  }

  fillActivatedChildren(optionKeys, allOptions, values, defaults);
  return values;
}

// ============================================================================
// 当前值输出
// ============================================================================

/** 按当前取值输出处于激活状态的选项值（preset 格式，密码打码） */
export function formatOptionValues(
  optionKeys: string[],
  allOptions: Record<string, OptionDefinition>,
  values: Record<string, OptionValue>,
  ctx: OptionContext,
  result: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const key of optionKeys) {
    const def = allOptions[key];
    if (!def || key in result || isOptionIncompatible(def, ctx)) continue;
    const value = values[key] ?? createDefaultOptionValue(def);
    result[key] = toPresetValue(def, value);
    formatOptionValues(activeChildKeys(def, value), allOptions, values, ctx, result);
  }
  return result;
}
