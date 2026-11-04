/** MXU 配置快照的条件写入；版本仅用于客户端/后端同步，不写入配置文件。 */
export interface ConfigSnapshot<T> {
  config: T;
  revision: string;
}

export interface ConfigSaveRequest<T> extends ConfigSnapshot<T> {
  client_id: string;
}

export interface ConfigChangedEvent {
  client_id: string;
  revision: string;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

export class ConfigSync<T> {
  private revision: string | null = null;
  private savedConfig = '';
  private generation = 0;
  private ready = false;
  private pending: Promise<boolean> = Promise.resolve(true);
  private writesInFlight = 0;

  constructor(
    readonly clientId: string,
    private readonly write: (request: ConfigSaveRequest<T>) => Promise<ConfigSnapshot<T>>,
    private readonly onConflict: (error: unknown) => void,
  ) {}

  /** 接受服务端快照时取消基于旧快照排队的保存。 */
  adopt(snapshot: ConfigSnapshot<T>): void {
    this.generation++;
    this.revision = snapshot.revision;
    this.ready = true;
    this.savedConfig = stableJson(snapshot.config);
  }

  /** 断线后暂停写入；恢复时必须先拉取服务端快照。 */
  suspend(): void {
    this.generation++;
    this.ready = false;
  }

  getRevision(): string | null {
    return this.revision;
  }

  hasChanges(config: T): boolean {
    return stableJson(config) !== this.savedConfig;
  }

  isOwnChange(event: ConfigChangedEvent | undefined): boolean {
    return event?.client_id === this.clientId;
  }

  private request(config: T): ConfigSaveRequest<T> | null {
    if (!this.ready || this.revision === null || !this.hasChanges(config)) return null;
    return { config, revision: this.revision, client_id: this.clientId };
  }

  /** 卸载时只发送尚未保存的编辑；已在途的写入不另发可能乱序的 beacon。 */
  unloadRequest(config: T): ConfigSaveRequest<T> | null {
    if (this.writesInFlight > 0) return null;
    const request = this.request(config);
    this.suspend();
    return request;
  }

  save(config: T): Promise<boolean> {
    const generation = this.generation;
    // 冻结快照，防止排队期间调用方继续修改对象。
    const snapshot = JSON.parse(JSON.stringify(config)) as T;
    this.writesInFlight++;
    const next = this.pending.then(async () => {
      if (generation !== this.generation || !this.ready || this.revision === null) return false;
      const request = this.request(snapshot);
      if (!request) return true;
      try {
        const saved = await this.write(request);
        // 等待响应期间可能已收到其它客户端的快照，不可把版本退回去。
        if (generation === this.generation) {
          this.revision = saved.revision;
          this.savedConfig = stableJson(saved.config);
        }
        return true;
      } catch (error) {
        if (generation === this.generation) {
          this.suspend();
          this.onConflict(error);
        }
        return false;
      }
    });
    this.pending = next.finally(() => this.writesInFlight--);
    return this.pending;
  }
}
