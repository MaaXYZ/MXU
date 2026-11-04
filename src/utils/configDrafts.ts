/** 可恢复但不自动上传的客户端编辑，避免冲突与页面关闭静默丢失用户输入。 */
export interface ConfigDraft<T> {
  key: string;
  config: T;
  savedAt: string;
}

type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export class ConfigDrafts<T> {
  private volatile = new Map<string, ConfigDraft<T>>();

  constructor(
    private readonly storage: () => DraftStorage,
    private readonly isValid: (value: unknown) => value is T,
  ) {}

  private prefix(projectName: string): string {
    return `mxu-unsaved-${encodeURIComponent(projectName)}-`;
  }

  save(config: T, projectName: string, clientId: string): ConfigDraft<T> {
    const draft = {
      key: `${this.prefix(projectName)}${clientId}`,
      config,
      savedAt: new Date().toISOString(),
    };
    try {
      this.storage().setItem(draft.key, JSON.stringify(draft));
      this.volatile.delete(draft.key);
    } catch {
      // 仍可在当前页面导出；卸载时必须提醒用户尚未安全持久化。
      this.volatile.set(draft.key, draft);
    }
    return draft;
  }

  isPersistent(draft: ConfigDraft<T>): boolean {
    return !this.volatile.has(draft.key);
  }

  hasVolatileDrafts(): boolean {
    return this.volatile.size > 0;
  }

  list(projectName: string, hasChanges: (config: T) => boolean): ConfigDraft<T>[] {
    for (const [key, draft] of this.volatile)
      if (key.startsWith(this.prefix(projectName)) && !hasChanges(draft.config))
        this.volatile.delete(key);
    const drafts = new Map(
      [...this.volatile].filter(([key]) => key.startsWith(this.prefix(projectName))),
    );
    let storage: DraftStorage;
    let keys: (string | null)[];
    try {
      storage = this.storage();
      keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    } catch {
      return [...drafts.values()].filter((draft) => hasChanges(draft.config));
    }
    for (const key of keys) {
      if (!key?.startsWith(this.prefix(projectName))) continue;
      try {
        const draft = JSON.parse(storage.getItem(key) ?? 'null') as ConfigDraft<T>;
        if (!this.isValid(draft?.config) || typeof draft.savedAt !== 'string') continue;
        if (!hasChanges(draft.config)) storage.removeItem(key);
        else if (!drafts.has(key)) drafts.set(key, { ...draft, key });
      } catch {
        // 单份无效草稿不能阻止恢复其它客户端的编辑。
      }
    }
    return [...drafts.values()].filter((draft) => hasChanges(draft.config));
  }

  removeIfSaved(key: string, hasChanges: (config: T) => boolean): void {
    const pending = this.volatile.get(key);
    if (pending && !hasChanges(pending.config)) this.volatile.delete(key);
    try {
      const draft = JSON.parse(this.storage().getItem(key) ?? 'null') as ConfigDraft<T> | null;
      if (draft && this.isValid(draft.config) && !hasChanges(draft.config))
        this.storage().removeItem(key);
    } catch {
      /* 存储不可用时仍可清理已成功同步的内存草稿。 */
    }
  }

  remove(key: string): void {
    this.volatile.delete(key);
    this.storage().removeItem(key);
  }
}
