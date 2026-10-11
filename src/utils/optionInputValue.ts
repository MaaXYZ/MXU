import type { InputItem } from '@/types/interface';

/**
 * 是否为密码字段。
 * 与 `utils/passwordOptionValues.ts` 的 `isPasswordInput` 等价，此处内联是为了让本模块
 * 只依赖类型、可被 `node --test` 直接单测（不牵入加密实现）。
 */
const isPasswordInput = (input: InputItem): boolean => input.password === true;

/**
 * 输入值不可用的成因。
 * - `empty`：值为空，但该输入的格式要求（`verify`）不接受空值
 * - `pattern`：非空，但不匹配 `verify`
 * - `integer`：`pipeline_type: "int"` 但不是十进制整数
 * - `invalid-pattern`：`verify` 本身不是合法正则——属于项目定义问题，不再静默放行
 */
export type InputValueErrorKind = 'empty' | 'pattern' | 'integer' | 'invalid-pattern';

export interface InputValueError {
  kind: InputValueErrorKind;
}

/** 输入值是否"没有被填写"：键缺失、null、空串。 */
export const isEmptyInputValue = (value: string | null | undefined): boolean =>
  value === undefined || value === null || value === '';

/**
 * 输入是否声明了规范值（非空 `default`）。
 *
 * 只有这类输入，"框里为空"才确定是无意义的，可以自动补回上一个有效值；
 * 没有 `default` 的输入（"留空=不启用"这类语义）必须尊重用户留空。
 * 密码字段永远不参与：PI 禁止 password 声明 `default`，明文另有加密通道。
 */
export const hasDeclaredValue = (input: InputItem): boolean =>
  !isPasswordInput(input) && (input.default ?? '') !== '';

/**
 * 读取输入值：只有"没有数据"（键缺失 / null / 空串）才回退 `default`。
 *
 * 非空但格式非法的值**原样返回**——合法性由运行前的闸门判定，取值阶段不做任何改写，
 * 也不会替用户编造他没填过的值。
 */
export const resolveInputValue = (input: InputItem, saved: string | null | undefined): string => {
  if (!isEmptyInputValue(saved)) return saved as string;
  if (isPasswordInput(input)) return saved ?? '';
  return input.default ?? '';
};

/**
 * 校验单个输入值。返回 `null` 表示可以使用。
 *
 * 与 UI 红框、运行前闸门共用同一判定，避免"界面说没问题、运行时又拒绝"这类不一致。
 */
export const getInputValueError = (input: InputItem, value: string): InputValueError | null => {
  let regex: RegExp | null = null;
  if (input.verify) {
    try {
      regex = new RegExp(input.verify);
    } catch {
      return { kind: 'invalid-pattern' };
    }
  }

  if (value === '') {
    // int/bool 的空值由代入阶段兜底（0 / false），这里只按 verify 判定
    return regex && !regex.test('') ? { kind: 'empty' } : null;
  }

  if (regex && !regex.test(value)) return { kind: 'pattern' };
  // int 值会以裸整数代入流水线：非整数会让整段 override 变成非法 JSON 而被丢弃
  if (input.pipeline_type === 'int' && !/^-?\d+$/.test(value)) return { kind: 'integer' };
  return null;
};
