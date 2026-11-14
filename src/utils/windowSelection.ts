import type {
  ControllerItem,
  ProjectInterface,
  ResourceItem,
  SavedDeviceInfo,
} from '../types/interface';
import type { Win32Window } from '../types/maa';

export const WINDOW_ERROR_KEYS = {
  WINDOW_FILTER_INVALID: 'windowTarget.invalidFilter',
  WINDOW_NOT_FOUND: 'windowTarget.notFound',
  WINDOW_TARGET_MISMATCH: 'windowTarget.mismatch',
  WINDOW_TARGET_CHANGED: 'windowTarget.changed',
  WINDOW_SELECTION_REQUIRED: 'windowTarget.multiple',
} as const;

export class WindowTargetError extends Error {
  constructor(
    readonly code: keyof typeof WINDOW_ERROR_KEYS,
    message: string = code,
  ) {
    super(message);
    this.name = 'WindowTargetError';
  }
}

/** Late discovery responses cannot overwrite a manual choice or a newer search. */
export class WindowSearchGuard {
  private generation = 0;

  begin(isSameContext: () => boolean): () => boolean {
    const generation = ++this.generation;
    return () => generation === this.generation && isSameContext();
  }

  invalidate(): void {
    this.generation++;
  }
}

export function localizeWindowError(error: unknown, translate: (key: string) => string): unknown {
  if (error instanceof WindowTargetError) {
    return new WindowTargetError(error.code, translate(WINDOW_ERROR_KEYS[error.code]));
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const [code, key] of Object.entries(WINDOW_ERROR_KEYS)) {
    if (new RegExp(`(^|[^A-Z_])${code}($|[^A-Z_])`).test(message)) {
      return new WindowTargetError(code as keyof typeof WINDOW_ERROR_KEYS, translate(key));
    }
  }
  return error;
}

/** Only use fresh, project-filtered discovery results, never the global UI cache. */
export function selectWindow(
  windows: readonly Win32Window[],
  savedDevice?: Pick<SavedDeviceInfo, 'windowName'>,
): Win32Window {
  const unique = [...new Map(windows.map((window) => [window.handle, window])).values()];
  if (unique.length === 0) throw new WindowTargetError('WINDOW_NOT_FOUND');
  const remembered = savedDevice?.windowName
    ? unique.filter((window) => window.window_name === savedDevice.windowName)
    : [];
  if (remembered.length === 1) return remembered[0];
  if (unique.length === 1) return unique[0];
  throw new WindowTargetError('WINDOW_SELECTION_REQUIRED');
}

export interface InitialWindowSelection {
  controller: ControllerItem;
  resource: ResourceItem;
  window: Win32Window;
}

/** Bootstrap only an empty configuration, before rendering editable UI. */
export async function discoverInitialWindow(
  pi: Pick<ProjectInterface, 'controller' | 'resource'>,
  find: (classRegex?: string, titleRegex?: string) => Promise<Win32Window[]>,
): Promise<InitialWindowSelection | undefined> {
  const controllers = pi.controller.filter(
    (controller) =>
      controller.type === 'Win32' &&
      (controller.win32?.class_regex || controller.win32?.window_regex),
  );
  const candidates = new Map<number, InitialWindowSelection>();
  let searched = false;
  for (const controller of controllers) {
    const resource = pi.resource.find(
      (item) => !item.controller?.length || item.controller.includes(controller.name),
    );
    if (!resource) continue;
    searched = true;
    const windows = await find(controller.win32?.class_regex, controller.win32?.window_regex);
    for (const window of windows) {
      if (!candidates.has(window.handle))
        candidates.set(window.handle, { controller, resource, window });
    }
  }
  if (candidates.size > 1) throw new WindowTargetError('WINDOW_SELECTION_REQUIRED');
  if (searched && candidates.size === 0) throw new WindowTargetError('WINDOW_NOT_FOUND');
  return candidates.values().next().value;
}
