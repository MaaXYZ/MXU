/** 检测 focus 日志正文中的 Markdown、HTML、多行内容或链接。 */
export function hasRichTextFeatures(text: string): boolean {
  return (
    /[*_`#\[\]!]/.test(text) || // Markdown 语法
    text.includes('\n') || // 多行内容
    /<[a-z][\s\S]*?>/i.test(text) || // HTML 标签
    /https?:\/\/\S+/.test(text) // URL
  );
}
