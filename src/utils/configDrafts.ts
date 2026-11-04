/** 可恢复但不自动上传的客户端编辑，避免冲突与页面关闭静默丢失用户输入。 */
export interface ConfigDraft<T> {
  key: string;
  config: T;
  savedAt: string;
}

type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export class ConfigDrafts<T> {
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
    this.storage().setItem(draft.key, JSON.stringify(draft));
    return draft;
  }

  list(projectName: string, hasChanges: (config: T) => boolean): ConfigDraft<T>[] {
    const storage = this.storage();
    const drafts: ConfigDraft<T>[] = [];
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(this.prefix(projectName))) continue;
      try {
        const draft = JSON.parse(storage.getItem(key) ?? 'null') as ConfigDraft<T>;
        if (!this.isValid(draft?.config) || typeof draft.savedAt !== 'string') continue;
        if (hasChanges(draft.config)) drafts.push({ ...draft, key });
        else storage.removeItem(key);
      } catch {
        // 单份无效草稿不能阻止恢复其它客户端的编辑。
      }
    }
    return drafts;
  }

  removeIfSaved(key: string, hasChanges: (config: T) => boolean): void {
    const draft = JSON.parse(this.storage().getItem(key) ?? 'null') as ConfigDraft<T> | null;
    if (draft && this.isValid(draft.config) && !hasChanges(draft.config))
      this.storage().removeItem(key);
  }

  remove(key: string): void {
    this.storage().removeItem(key);
  }
}
