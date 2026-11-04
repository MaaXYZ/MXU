import type {
  OptionDefinition,
  OptionValue,
  PresetOptionValue,
  InputItem,
} from '@/types/interface';
import { createDefaultOptionValue } from '@/stores/helpers';
import { PiMcpError } from '@/services/piMcpRuntime';
import { findSwitchCase } from '@/utils/optionHelpers';

export interface OptionContext {
  resolveText(text: string | undefined): string | undefined;
  controllerName?: string;
  resourceName?: string;
  validateHotkey?(value: string): boolean;
  error?(code: string, path?: string): PiMcpError;
}
function fail(ctx: OptionContext, code: string, path?: string): never {
  throw ctx.error?.(code, path) ?? new PiMcpError({ code, message: code, path });
}
export function isOptionIncompatible(
  def: Pick<OptionDefinition, 'controller' | 'resource'>,
  ctx: OptionContext,
) {
  return !!(
    (def.controller?.length && !def.controller.includes(ctx.controllerName ?? '')) ||
    (def.resource?.length && !def.resource.includes(ctx.resourceName ?? ''))
  );
}
export function reachableOptions(
  roots: string[],
  definitions: Record<string, OptionDefinition>,
  ctx: OptionContext,
  found = new Set<string>(),
) {
  for (const key of roots) {
    const def = definitions[key];
    if (!def || found.has(key) || isOptionIncompatible(def, ctx)) continue;
    found.add(key);
    if (def.type !== 'input' && def.type !== 'hotkey') {
      for (const item of def.cases) reachableOptions(item.option ?? [], definitions, ctx, found);
    }
  }
  return found;
}
export function activeChildKeys(def: OptionDefinition, value: OptionValue): string[] {
  if (value.type === 'switch' && def.type === 'switch')
    return findSwitchCase(def.cases, value.value)?.option ?? [];
  if (value.type === 'select' && (def.type === 'select' || !def.type)) {
    return def.cases.find((item) => item.name === value.caseName)?.option ?? [];
  }
  if (value.type === 'checkbox' && def.type === 'checkbox') {
    return def.cases
      .filter((item) => value.caseNames.includes(item.name))
      .flatMap((item) => item.option ?? []);
  }
  return [];
}
export function baselineOptions(
  roots: string[],
  definitions: Record<string, OptionDefinition>,
  ctx: OptionContext,
  saved: Record<string, OptionValue> = {},
) {
  return Object.fromEntries(
    [...reachableOptions(roots, definitions, ctx)].map((key) => {
      const def = definitions[key];
      const value = structuredClone(saved[key] ?? createDefaultOptionValue(def));
      if (def.type === 'input' && value.type === 'input' && !saved[key]) {
        for (const field of def.inputs) if (field.password) delete value.values[field.name];
      }
      return [key, value];
    }),
  );
}
export function presetValue(def: OptionDefinition, value: OptionValue): PresetOptionValue {
  if (value.type === 'select') return value.caseName;
  if (value.type === 'checkbox') return [...value.caseNames];
  if (value.type === 'switch' && def.type === 'switch')
    return findSwitchCase(def.cases, value.value)?.name ?? '';
  if (value.type === 'input' || value.type === 'hotkey') {
    return Object.fromEntries(
      Object.entries(value.values).filter(
        ([name]) =>
          def.type !== 'input' || !def.inputs.find((field) => field.name === name)?.password,
      ),
    );
  }
  return '';
}
export function formatOptionValues(
  roots: string[],
  definitions: Record<string, OptionDefinition>,
  values: Record<string, OptionValue>,
  ctx: OptionContext,
  result: Record<string, unknown> = {},
) {
  for (const key of roots) {
    const def = definitions[key];
    if (!def || key in result || isOptionIncompatible(def, ctx)) continue;
    const value = values[key] ?? createDefaultOptionValue(def);
    result[key] = presetValue(def, value);
    formatOptionValues(activeChildKeys(def, value), definitions, values, ctx, result);
  }
  return result;
}
export function describeOptions(
  roots: string[],
  definitions: Record<string, OptionDefinition>,
  ctx: OptionContext,
  values: Record<string, OptionValue>,
  optionKey?: string,
  offset = 0,
  limit = 50,
) {
  const reachable = reachableOptions(roots, definitions, ctx);
  if (optionKey !== undefined && !reachable.has(optionKey))
    fail(ctx, 'option_not_found', '/option_key');
  const options: Record<string, Record<string, unknown>> = {};
  let caseCount = 0;
  const fieldDescription = (field: InputItem) => ({
    name: field.name,
    label: ctx.resolveText(field.label),
    description: ctx.resolveText(field.description),
    ...(field.password ? { password: true } : { default: field.default }),
    pipeline_type: field.pipeline_type,
    verify: field.verify,
    pattern_msg: ctx.resolveText(field.pattern_msg),
    input_type: field.input_type,
  });
  for (const key of optionKey === undefined ? reachable : [optionKey]) {
    const def = definitions[key];
    const item: Record<string, unknown> = {
      type: def.type ?? 'select',
      label: ctx.resolveText(def.label),
      description: ctx.resolveText(def.description),
      value: presetValue(def, values[key] ?? createDefaultOptionValue(def)),
    };
    if (def.type === 'input') item.inputs = def.inputs.map(fieldDescription);
    else if (def.type === 'hotkey') item.hotkeys = def.hotkeys.map(fieldDescription);
    else {
      item.case_count = def.cases.length;
      if (def.type === 'checkbox') {
        item.min_count = def.min_count;
        item.max_count = def.max_count;
      }
      if (optionKey !== undefined) {
        caseCount = def.cases.length;
        item.cases = def.cases.slice(offset, offset + limit).map((entry) => ({
          name: entry.name,
          label: ctx.resolveText(entry.label),
          description: ctx.resolveText(entry.description),
          option: (entry.option ?? []).filter((child) => reachable.has(child)),
        }));
      }
    }
    options[key] = item;
  }
  return {
    root_options: roots.filter((key) => reachable.has(key)),
    options,
    nextOffset: optionKey !== undefined && offset + limit < caseCount ? offset + limit : null,
  };
}
function convertValue(
  def: OptionDefinition,
  raw: unknown,
  base: OptionValue,
  ctx: OptionContext,
  path: string,
): OptionValue {
  const invalid = () => fail(ctx, 'invalid_option', path);
  if (def.type === 'input' || def.type === 'hotkey') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const fields = def.type === 'input' ? def.inputs : def.hotkeys;
    const values = base.type === 'input' || base.type === 'hotkey' ? { ...base.values } : {};
    for (const [name, value] of Object.entries(raw)) {
      const field = fields.find((item) => item.name === name);
      if (!field) return invalid();
      if ('password' in field && field.password) fail(ctx, 'sensitive_option', path);
      if (typeof value !== 'string') return invalid();
      values[name] = value;
    }
    for (const field of fields) {
      const value = values[field.name] ?? '';
      const sensitive = 'password' in field && field.password;
      if ('verify' in field && field.verify) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(field.verify);
        } catch {
          return invalid();
        }
        if (!pattern.test(value)) {
          if (sensitive) fail(ctx, 'configuration_required', path);
          return invalid();
        }
      }
      if (def.type === 'hotkey' && ctx.validateHotkey && !ctx.validateHotkey(value))
        return invalid();
      if ('pipeline_type' in field) {
        if (
          field.pipeline_type === 'int' &&
          value !== '' &&
          (!/^-?(0|[1-9][0-9]*)$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))
        )
          return invalid();
        if (
          field.pipeline_type === 'bool' &&
          !['', 'true', 'false', '1', '0', 'yes', 'no', 'y', 'n'].includes(value.toLowerCase())
        )
          return invalid();
      }
    }
    return { type: def.type, values };
  }
  if (def.type === 'checkbox') {
    if (
      !Array.isArray(raw) ||
      raw.some((value) => typeof value !== 'string') ||
      new Set(raw).size !== raw.length ||
      raw.some((name) => !def.cases.some((item) => item.name === name)) ||
      raw.length < (def.min_count ?? 0) ||
      raw.length > (def.max_count ?? Infinity)
    )
      return invalid();
    return { type: 'checkbox', caseNames: [...raw] as string[] };
  }
  if (typeof raw !== 'string' || !def.cases.some((item) => item.name === raw)) return invalid();
  if (def.type === 'switch') {
    const yes = findSwitchCase(def.cases, true);
    const no = findSwitchCase(def.cases, false);
    if (raw !== yes?.name && raw !== no?.name) return invalid();
    return { type: 'switch', value: raw === yes?.name };
  }
  return { type: 'select', caseName: raw };
}
export function convertMcpOptions({
  optionKeys,
  allOptions,
  defaults,
  input,
  ctx,
  path = '/option',
}: {
  optionKeys: string[];
  allOptions: Record<string, OptionDefinition>;
  defaults: Record<string, OptionValue>;
  input: Record<string, unknown>;
  ctx: OptionContext;
  path?: string;
}) {
  const reachable = reachableOptions(optionKeys, allOptions, ctx);
  const values = baselineOptions(optionKeys, allOptions, ctx, defaults);
  for (const [key, raw] of Object.entries(input)) {
    if (!reachable.has(key)) fail(ctx, 'option_not_found', path);
    values[key] = convertValue(allOptions[key], raw, values[key], ctx, path);
  }
  const active = new Set<string>();
  const visit = (keys: string[]) => {
    for (const key of keys) {
      if (!reachable.has(key) || active.has(key)) continue;
      active.add(key);
      const def = allOptions[key];
      values[key] = convertValue(def, presetValue(def, values[key]), values[key], ctx, path);
      visit(activeChildKeys(def, values[key]));
    }
  };
  visit(optionKeys);
  for (const key of Object.keys(input)) if (!active.has(key)) fail(ctx, 'invalid_option', path);
  return values;
}
