import type { ProjectInterface } from '../types/interface';

export interface WelcomeEntry {
  source: string;
  content: string;
}

/** 每条公告独立解析 i18n / 文件 / URL，异步加载仍保持声明顺序。 */
export async function resolveWelcomeEntries(
  welcome: ProjectInterface['welcome'],
  resolve: (source: string) => Promise<string>,
): Promise<WelcomeEntry[]> {
  const sources = Array.isArray(welcome) ? welcome : welcome ? [welcome] : [];
  return Promise.all(sources.map(async (source) => ({ source, content: await resolve(source) })));
}

/** 完整有序列表参与比较，避免拼接文本丢失条目边界；保留旧单条公告的 hash。 */
export function getWelcomeContentHash(entries: WelcomeEntry[]): string {
  const text = entries.length === 1 ? entries[0].content : JSON.stringify(entries);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
