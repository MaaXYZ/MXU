import { invoke } from '@tauri-apps/api/core';
import type {
  ProjectInterface,
  TaskItem,
  OptionDefinition,
  ControllerType,
  PresetItem,
  GroupItem,
  InterfaceSettingSection,
  PretaskItem,
} from '@/types/interface';
import { normalizePretaskConfigs } from '@/types/interface';
import { loggers } from '@/utils/logger';
import { parseJsonc } from '@/utils/jsonc';
import { isTauri } from '@/utils/paths';
import { setBackendPort } from '@/utils/backendApi';

const log = loggers.app;

/**
 * 可导入的 PI 文件结构（支持 task、option、global_option、preset、group、setting 和 pretask 字段）
 */
interface ImportableInterface {
  task?: TaskItem[];
  option?: Record<string, OptionDefinition>;
  /** v2.3.0: 支持导入 global_option */
  global_option?: string[];
  /** v2.3.0: 支持导入 preset */
  preset?: PresetItem[];
  /** v2.4.0: 支持导入 group */
  group?: GroupItem[];
  /** MXU 扩展：支持导入 setting */
  setting?: InterfaceSettingSection[];
  /** v2.7.0: 支持导入 pretask */
  pretask?: PretaskItem | PretaskItem[];
}

export interface LoadResult {
  interface: ProjectInterface;
  translations: Record<string, Record<string, string>>;
  basePath: string;
  dataPath: string; // 数据目录（Linux: $XDG_DATA_HOME/{项目名}，macOS: ~/Library/Application Support/MXU/，Windows 同 basePath）
  webServerPort?: number; // 后端 Web 服务器实际监听端口（浏览器模式下用于 WS 直连）
  backendOS?: string; // 后端真实 OS（用于控制器过滤、更新匹配等；Tauri/HTTP 路径填充，dev 预览为空）
  backendArch?: string; // 后端真实架构
}

/**
 * 获取 exe 所在目录的绝对路径（Tauri 环境）
 */
async function getExeDir(): Promise<string> {
  return await invoke<string>('get_exe_dir');
}

/**
 * 获取应用数据目录的绝对路径（Tauri 环境）
 * - macOS: ~/Library/Application Support/MXU/
 * - Windows/Linux: exe 所在目录
 */
async function getDataDir(): Promise<string> {
  return await invoke<string>('get_data_dir');
}

// ============================================================================
// Tauri 环境：通过 Rust 读取本地文件
// ============================================================================

/**
 * 通过 Tauri 命令读取本地文件
 * @param filename 相对于 exe 目录的文件路径
 */
async function readLocalFile(filename: string): Promise<string> {
  return await invoke<string>('read_local_file', { filename });
}

/**
 * 拼接路径（处理空 basePath 的情况）
 */
function joinPath(basePath: string, relativePath: string): string {
  if (!basePath) return relativePath;
  return `${basePath}/${relativePath}`;
}

/**
 * 从本地文件加载 interface.json（Tauri 环境）
 * @param interfacePath interface.json 的路径（相对于 exe 目录）
 */
async function loadInterfaceFromLocal(interfacePath: string): Promise<ProjectInterface> {
  const content = await readLocalFile(interfacePath);
  const pi = parseJsonc<ProjectInterface>(content, interfacePath);

  if (pi.interface_version !== 2) {
    throw new Error(`不支持的 interface 版本: ${pi.interface_version}，仅支持 version 2`);
  }

  pi.task ??= [];
  return pi;
}

/**
 * 从本地文件加载翻译文件（Tauri 环境）
 * @param pi ProjectInterface 对象
 * @param basePath interface.json 所在目录（相对于 exe 目录）
 */
async function loadTranslationsFromLocal(
  pi: ProjectInterface,
  basePath: string,
): Promise<Record<string, Record<string, string>>> {
  const translations: Record<string, Record<string, string>> = {};

  if (!pi.languages) return translations;

  for (const [lang, relativePath] of Object.entries(pi.languages)) {
    try {
      const fullPath = joinPath(basePath, relativePath);
      const langContent = await readLocalFile(fullPath);
      translations[lang] = parseJsonc<Record<string, string>>(langContent, fullPath);
    } catch (err) {
      log.warn(`加载翻译文件失败 [${lang}]:`, err);
    }
  }

  return translations;
}

// ============================================================================
// 浏览器环境：通过 HTTP 加载（用于纯前端开发）
// ============================================================================

/**
 * 检查文件是否存在（HTTP 方式）
 */
async function httpFileExists(path: string): Promise<boolean> {
  try {
    const response = await fetch(path);
    const contentType = response.headers.get('content-type');
    return response.ok && (contentType?.includes('application/json') ?? false);
  } catch {
    return false;
  }
}

/**
 * 从 HTTP 路径加载 interface.json
 */
async function loadInterfaceFromHttp(path: string): Promise<ProjectInterface> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const content = await response.text();
  const pi = parseJsonc<ProjectInterface>(content, path);

  if (pi.interface_version !== 2) {
    throw new Error(`不支持的 interface 版本: ${pi.interface_version}，仅支持 version 2`);
  }

  pi.task ??= [];
  return pi;
}

/**
 * 从 HTTP 路径加载翻译文件
 */
async function loadTranslationsFromHttp(
  pi: ProjectInterface,
  basePath: string,
): Promise<Record<string, Record<string, string>>> {
  const translations: Record<string, Record<string, string>> = {};

  if (!pi.languages) return translations;

  for (const [lang, relativePath] of Object.entries(pi.languages)) {
    try {
      const langPath = basePath ? `${basePath}/${relativePath}` : `/${relativePath}`;
      const response = await fetch(langPath);
      if (response.ok) {
        const langContent = await response.text();
        translations[lang] = parseJsonc<Record<string, string>>(langContent, langPath);
      }
    } catch (err) {
      log.warn(`加载翻译文件失败 [${lang}]:`, err);
    }
  }

  return translations;
}

// ============================================================================
// Import 文件加载与合并
// ============================================================================

/**
 * 从本地文件加载可导入的 PI 文件（Tauri 环境）
 * @param importPath 导入文件的路径（相对于 exe 目录）
 */
async function loadImportFromLocal(importPath: string): Promise<ImportableInterface> {
  try {
    const content = await readLocalFile(importPath);
    return parseJsonc<ImportableInterface>(content, importPath);
  } catch (err) {
    log.warn(`加载导入文件失败 [${importPath}]:`, err);
    return {};
  }
}

/**
 * 从 HTTP 路径加载可导入的 PI 文件
 * @param importPath 导入文件的 HTTP 路径
 */
async function loadImportFromHttp(importPath: string): Promise<ImportableInterface> {
  try {
    const response = await fetch(importPath);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const content = await response.text();
    return parseJsonc<ImportableInterface>(content, importPath);
  } catch (err) {
    log.warn(`加载导入文件失败 [${importPath}]:`, err);
    return {};
  }
}

/**
 * 合并导入的 task、option、setting、pretask 等到主 interface
 * @param pi 主 ProjectInterface
 * @param imported 导入的内容
 */
function mergeImported(pi: ProjectInterface, imported: ImportableInterface): void {
  // 合并 task 数组（追加到末尾）
  if (imported.task && imported.task.length > 0) {
    pi.task = [...(pi.task || []), ...imported.task];
    log.info(`合并了 ${imported.task.length} 个导入的 task`);
  }

  // 合并 global_option（按导入顺序追加并去重）
  if (imported.global_option && imported.global_option.length > 0) {
    const existingGlobalOptions = pi.global_option || [];
    const seen = new Set(existingGlobalOptions);
    const dedupedImported = imported.global_option.filter((optionKey) => {
      if (seen.has(optionKey)) return false;
      seen.add(optionKey);
      return true;
    });

    if (dedupedImported.length > 0) {
      pi.global_option = [...existingGlobalOptions, ...dedupedImported];
      log.info(`合并了 ${dedupedImported.length} 个导入的 global_option`);
    }
  }

  // 合并 option 对象（后导入的覆盖先导入的）
  if (imported.option && Object.keys(imported.option).length > 0) {
    pi.option = { ...pi.option, ...imported.option };
    log.info(`合并了 ${Object.keys(imported.option).length} 个导入的 option`);
  }

  // MXU 扩展：合并 setting 数组（追加到末尾，保持导入顺序）
  if (imported.setting && imported.setting.length > 0) {
    pi.setting = [...(pi.setting || []), ...imported.setting];
    log.info(`合并了 ${imported.setting.length} 个导入的 setting`);
  }

  // v2.3.0: 合并 preset 数组（追加到末尾）
  if (imported.preset && imported.preset.length > 0) {
    pi.preset = [...(pi.preset || []), ...imported.preset];
    log.info(`合并了 ${imported.preset.length} 个导入的 preset`);
  }

  // v2.4.0: 合并 group 数组（按 name 去重，保持先定义优先）
  if (imported.group && imported.group.length > 0) {
    const existingGroups = pi.group || [];
    const seenNames = new Set(existingGroups.map((g) => g.name));
    const dedupedImported: GroupItem[] = [];
    let skippedDuplicates = 0;
    const duplicateNames: string[] = [];

    for (const group of imported.group) {
      if (seenNames.has(group.name)) {
        skippedDuplicates += 1;
        duplicateNames.push(group.name);
        continue;
      }
      seenNames.add(group.name);
      dedupedImported.push(group);
    }

    if (dedupedImported.length > 0) {
      pi.group = [...existingGroups, ...dedupedImported];
      log.info(`合并了 ${dedupedImported.length} 个导入的 group`);
    }
    if (skippedDuplicates > 0) {
      const uniqueDuplicateNames = Array.from(new Set(duplicateNames));
      log.warn(
        `忽略了 ${skippedDuplicates} 个重名 group，名称包括: ${uniqueDuplicateNames.join(', ')}`,
      );
    }
  }

  // v2.7.0: 合并 pretask（单对象视为一项，按导入顺序追加为有序列表）
  const importedPretasks = normalizePretaskConfigs(imported.pretask);
  if (importedPretasks && importedPretasks.length > 0) {
    const existing = normalizePretaskConfigs(pi.pretask) || [];
    pi.pretask = [...existing, ...importedPretasks];
    log.info(`合并了 ${importedPretasks.length} 个导入的 pretask`);
  }
}

/**
 * 处理 import 字段，加载并合并所有导入的文件
 * @param pi 主 ProjectInterface
 * @param basePath interface.json 所在目录
 * @param useLocal 是否使用本地文件加载（Tauri 环境）
 */
async function processImports(
  pi: ProjectInterface,
  basePath: string,
  useLocal: boolean,
): Promise<void> {
  if (!pi.import || pi.import.length === 0) {
    return;
  }

  log.info(`处理 ${pi.import.length} 个导入文件...`);

  for (const importPath of pi.import) {
    const fullPath = joinPath(basePath, importPath);
    log.info(`加载导入文件: ${fullPath}`);

    const imported = useLocal
      ? await loadImportFromLocal(fullPath)
      : await loadImportFromHttp(fullPath);

    mergeImported(pi, imported);
  }
}

// ============================================================================
// 平台过滤
// ============================================================================

/**
 * 根据 OS 字符串计算平台标志
 * @param os 后端真实 OS（如 "windows"/"macos"/"linux"）；空串时回退到浏览器 navigator.platform（仅纯前端 dev 预览，无后端）
 *
 * 注意：控制器过滤必须以后端 OS 为准（WebUI 可被异构 OS 的浏览器远程访问），
 * 不得直接使用 navigator.platform，否则会导致远程浏览器与后端 OS 不一致时过滤错误。
 */
function getPlatformFlags(os: string) {
  const platform = os ? os.toLowerCase() : navigator.platform.toLowerCase();
  return {
    isWindows: platform.includes('win'),
    isMacOS: platform === 'macos' || platform.includes('mac'),
    isLinux: platform.includes('linux'),
  };
}

/**
 * 获取指定平台不支持的控制器类型集合
 * @param os 后端真实 OS；空串时回退到浏览器平台（dev 预览）
 */
function getUnsupportedControllerTypes(os: string): Set<ControllerType> {
  const { isWindows, isMacOS, isLinux } = getPlatformFlags(os);
  const unsupported = new Set<ControllerType>();
  // 非 Windows 系统不支持 Win32 和 Gamepad
  if (!isWindows) {
    unsupported.add('Win32');
    unsupported.add('Gamepad');
  }
  // 非 macOS 系统不支持原生 macOS 控制器和 PlayCover
  if (!isMacOS) {
    unsupported.add('MacOS');
    unsupported.add('PlayCover');
  }
  // 非 Linux 系统不支持 WlRoots 和 Linux 控制器
  if (!isLinux) {
    unsupported.add('WlRoots');
    unsupported.add('Linux');
  }
  return unsupported;
}

/**
 * 过滤掉指定平台不支持的控制器
 * 在解析阶段直接移除，使后续所有消费 controller 的地方都只看到兼容的控制器
 * @param os 后端真实 OS；空串时回退到浏览器平台（dev 预览）
 */
function filterControllersByPlatform(pi: ProjectInterface, os: string): void {
  // WlRoots 已废弃：仍保留兼容（类型合法），但打印 deprecated 提示
  for (const c of pi.controller) {
    if (c.type === 'WlRoots') {
      log.warn(`[interface] 控制器 "${c.name}" 使用了已废弃的 WlRoots 类型，请迁移到 Linux 控制器`);
    }
  }

  const unsupported = getUnsupportedControllerTypes(os);
  if (unsupported.size === 0) return;

  const originalCount = pi.controller.length;
  pi.controller = pi.controller.filter((c) => !unsupported.has(c.type));
  const filteredCount = originalCount - pi.controller.length;

  if (filteredCount > 0) {
    log.info(
      `平台过滤: 移除了 ${filteredCount} 个不支持的控制器 (不支持的类型: ${[...unsupported].join(', ')})`,
    );
  }
}

// ============================================================================
// 统一入口
// ============================================================================

/**
 * 从路径中提取目录部分
 * 例如: "config/interface.json" -> "config"
 *       "interface.json" -> ""
 */
function getDirectoryFromPath(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return filePath.substring(0, lastSlash);
}

/**
 * 加载 interface.json
 *
 * basePath 是 interface.json 所在目录的绝对路径，所有相对路径（翻译文件、资源、图标等）都基于此目录
 *
 * Tauri 环境：从 exe 同目录加载，basePath 为 exe 目录的绝对路径
 * 浏览器环境：从 HTTP 根路径加载（需要 public/interface.json），basePath 为空
 */
export async function autoLoadInterface(): Promise<LoadResult> {
  // interface.json 的路径（将来可配置）
  const interfacePath = 'interface.json';
  // 相对 basePath（interface.json 所在目录的相对路径部分）
  const relativeBasePath = getDirectoryFromPath(interfacePath);

  // Tauri 环境：通过 Rust 读取本地文件
  if (isTauri()) {
    log.info('Tauri 环境，加载 interface.json');
    // 获取 exe 目录的绝对路径作为 basePath
    const exeDir = await getExeDir();
    const basePath = relativeBasePath ? `${exeDir}/${relativeBasePath}` : exeDir;
    log.info('basePath (绝对路径):', basePath);

    // 获取数据目录（Linux 使用 XDG，macOS 使用 Application Support，Windows 同 basePath）
    const dataPath = await getDataDir();
    log.info('dataPath (数据目录):', dataPath);

    const pi = await loadInterfaceFromLocal(interfacePath);

    // 处理 import 字段
    await processImports(pi, relativeBasePath, true);

    // 获取后端真实 OS/架构（Tauri 环境），用于平台过滤与下游消费
    const [backendOS, backendArch] = await Promise.all([
      invoke<string>('get_os'),
      invoke<string>('get_arch'),
    ]);

    // 过滤掉当前平台不支持的控制器（以后端 OS 为准，而非浏览器 OS）
    filterControllersByPlatform(pi, backendOS);

    const translations = await loadTranslationsFromLocal(pi, relativeBasePath);

    // tauri 环境下后端 HTTP API（/api/*）走内置 axum web server（默认 12701），
    // 但 getApiBase() 依赖 backendPort 才能返回绝对 URL（tauri://localhost 下相对 /api 不可达）。
    // 这里显式设置端口（web server 未就绪时 get_web_server_port 返回 0，也回退默认端口），
    // 确保后续 fetch(getApiBase()/...) 直连后端。
    try {
      const port = await invoke<number>('get_web_server_port');
      setBackendPort(port > 0 ? port : 12701);
    } catch {
      setBackendPort(12701);
    }

    return { interface: pi, translations, basePath, dataPath, backendOS, backendArch };
  }

  // 浏览器环境：尝试后端 HTTP API（先走 Vite proxy，失败则探测端口直连）
  {
    type InterfaceApiResult = {
      interface: ProjectInterface;
      translations: Record<string, Record<string, string>>;
      basePath: string;
      dataPath: string;
      webServerPort?: number;
      backendOS?: string;
      backendArch?: string;
    };

    const tryFetchInterface = async (
      url: string,
      timeoutMs = 3000,
    ): Promise<InterfaceApiResult | null> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) return null;
        const result = (await resp.json()) as InterfaceApiResult;
        return result?.interface ? result : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };

    // 1. 先通过 Vite proxy（相对路径）尝试（短超时，proxy 正常时应很快）
    let apiResult = await tryFetchInterface('/api/interface', 2000);

    // 2. proxy 失败时，并行探测后端端口范围（使用页面 hostname 而非 localhost，以支持局域网访问）
    if (!apiResult) {
      const DEFAULT_PORT = 12701;
      const MAX_PROBE = 10;
      const probeHost = window.location.hostname || 'localhost';
      const probes = Array.from({ length: MAX_PROBE }, (_, i) => {
        const port = DEFAULT_PORT + i;
        return tryFetchInterface(`http://${probeHost}:${port}/api/interface`, 3000).then(
          (result) => {
            if (result) return { result, port };
            throw new Error('not available');
          },
        );
      });

      try {
        const found = await Promise.any(probes);
        apiResult = found.result;
        log.info(`探测到后端在端口 ${found.port}`);
        setBackendPort(found.port);
      } catch {
        // 所有端口探测均失败
      }
    }

    if (apiResult) {
      log.info('从后端 HTTP API 加载 interface.json');
      // 以后端返回的 OS 为准过滤（远程浏览器 OS 可能与后端不同）
      filterControllersByPlatform(apiResult.interface, apiResult.backendOS ?? '');
      return {
        interface: apiResult.interface,
        translations: apiResult.translations ?? {},
        basePath: apiResult.basePath ?? '',
        dataPath: apiResult.dataPath ?? '',
        webServerPort: apiResult.webServerPort,
        backendOS: apiResult.backendOS,
        backendArch: apiResult.backendArch,
      };
    }
    log.info('后端 HTTP API 不可用，回退到静态文件加载');
  }

  // 回退：从 public 目录加载（纯前端开发预览模式）
  const httpPath = `/${interfacePath}`;
  if (await httpFileExists(httpPath)) {
    const pi = await loadInterfaceFromHttp(httpPath);

    // 处理 import 字段
    const httpBasePath = relativeBasePath ? `/${relativeBasePath}` : '';
    await processImports(pi, httpBasePath, false);

    // 过滤掉当前平台不支持的控制器（纯前端 dev 预览无后端，回退到浏览器平台）
    filterControllersByPlatform(pi, '');

    const translations = await loadTranslationsFromHttp(pi, httpBasePath);
    // 浏览器环境下 dataPath 与 basePath 相同
    return { interface: pi, translations, basePath: relativeBasePath, dataPath: relativeBasePath };
  }

  throw new Error('未找到 interface.json 文件，请确保程序同目录下存在 interface.json');
}
