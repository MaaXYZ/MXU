// Windows 智能应用控制拦截未签名 DLL 时，LoadLibrary 返回 193（0xC000012F），
// 各语言系统的错误文案不同，这里只做特征匹配，平台判断交给调用方。
const WINDOWS_DLL_LOAD_FAILURE_PATTERNS = [
  /0x?c000012f/i,
  /not a valid win32 application/i,
  /bad exe format/i,
  /没有被指定在\s*windows\s*上运行/i,
  /不是有效的\s*win32\s*应用程序/i,
  /failed to load library[^\n]*maawin32controlunit/i,
];

export function isWindowsDllLoadBlockedMessage(message: string): boolean {
  return WINDOWS_DLL_LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

/** 只在命中特征且尚未包含提示时追加，避免连接失败被两次本地化后重复提示。 */
export function appendWindowsDllHint(message: string, hint: string): string {
  if (!isWindowsDllLoadBlockedMessage(message) || message.includes(hint)) {
    return message;
  }
  return `${message}\n${hint}`;
}

/** A stale connection must not clean up the instance now owned by a newer request. */
export class ControllerConnectionSupersededError extends Error {
  readonly code = 'CONTROLLER_CONNECTION_SUPERSEDED';

  constructor(message: string) {
    super(message);
    this.name = 'ControllerConnectionSupersededError';
  }
}
