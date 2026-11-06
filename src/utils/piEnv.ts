import { getInterfaceLangKey } from '@/i18n';
import type { ProjectInterface } from '@/types/interface';

export interface PiEnvContext {
  projectInterface: ProjectInterface | null;
  controllerName: string | undefined;
  resourceName: string | undefined;
  translations: Record<string, string> | undefined;
  language: string;
  maaVersion: string | null;
}

/**
 * 仅解析 `$` 开头的 i18n key，保留普通字符串字段原值不变。
 */
function resolvePiI18nText(text: string, translations?: Record<string, string>): string {
  if (!text.startsWith('$')) {
    return text;
  }

  const key = text.slice(1);
  return translations?.[key] ?? key;
}

function resolveI18nValue(value: unknown, translations?: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return resolvePiI18nText(value, translations);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveI18nValue(item, translations));
  }

  if (typeof value === 'object' && value !== null) {
    return resolveI18nInObject(value as Record<string, unknown>, translations);
  }

  return value;
}

function resolveI18nInObject(
  obj: Record<string, unknown>,
  translations?: Record<string, string>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    resolved[key] = resolveI18nValue(value, translations);
  }
  return resolved;
}

/**
 * PI v2.5.0: 构建启动 Agent 子进程时应注入的 `PI_*` 环境变量。
 *
 * @see https://github.com/MaaXYZ/MaaFramework/pull/1226
 */
export function buildPiEnvVars(context: PiEnvContext): Record<string, string> {
  const { projectInterface, controllerName, resourceName, translations, language, maaVersion } =
    context;

  const envs: Record<string, string> = {};

  envs.PI_INTERFACE_VERSION = 'v2.11.0';
  envs.PI_CLIENT_NAME = 'MXU';
  envs.PI_CLIENT_VERSION = typeof __MXU_VERSION__ !== 'undefined' ? __MXU_VERSION__ : 'unknown';
  envs.PI_CLIENT_LANGUAGE = getInterfaceLangKey(language);

  if (maaVersion) {
    envs.PI_CLIENT_MAAFW_VERSION = maaVersion.startsWith('v') ? maaVersion : `v${maaVersion}`;
  }

  if (projectInterface?.version) {
    envs.PI_VERSION = projectInterface.version;
  }

  const controller = projectInterface?.controller.find((c) => c.name === controllerName);
  if (controller) {
    const resolved = resolveI18nInObject(
      controller as unknown as Record<string, unknown>,
      translations,
    );
    envs.PI_CONTROLLER = JSON.stringify(resolved);
  }

  const resource = projectInterface?.resource.find((r) => r.name === resourceName);
  if (resource) {
    const resolved = resolveI18nInObject(
      resource as unknown as Record<string, unknown>,
      translations,
    );
    envs.PI_RESOURCE = JSON.stringify(resolved);
  }

  return envs;
}
