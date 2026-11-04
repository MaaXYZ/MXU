/**
 * WebSocket 服务
 *
 * 仅在浏览器（非 Tauri）环境中激活，建立与后端 /api/ws 的长连接，
 * 接收实时推送事件（Maa 回调、Agent 输出、配置变更等），
 * 通过订阅 API 将事件分发给各消费者。
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('wsService');

// ============================================================================
// 事件类型定义（与 Rust WsEvent 枚举对应）
// ============================================================================

export interface WsMaaCallbackPayload {
  instance_id?: string | null;
  message: string;
  details: string;
}

export interface WsAgentOutputPayload {
  instance_id: string;
  stream: string;
  line: string;
}

export type WsMessage =
  | { type: 'maa-callback'; payload: WsMaaCallbackPayload }
  | { type: 'maa-agent-output'; payload: WsAgentOutputPayload }
  | { type: 'config-changed'; payload: undefined }
  | { type: 'state-changed'; payload: { instance_id: string; kind: string } };

// ============================================================================
// 订阅者类型
// ============================================================================

type MaaCallbackHandler = (message: string, details: string, instanceId?: string | null) => void;
type AgentOutputHandler = (instanceId: string, stream: string, line: string) => void;
type ConfigChangedHandler = () => void;
type StateChangedHandler = (instanceId: string, kind: string) => void;
type ConnectionStatusHandler = (connected: boolean) => void;

// ============================================================================
// 内部状态
// ============================================================================

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let stopped = false;
/** 后端实际监听端口（由 setServerPort 注入） */
let serverPort: number | null = null;

const maaCallbackHandlers = new Set<MaaCallbackHandler>();
const agentOutputHandlers = new Set<AgentOutputHandler>();
const configChangedHandlers = new Set<ConfigChangedHandler>();
const stateChangedHandlers = new Set<StateChangedHandler>();
const connectionStatusHandlers = new Set<ConnectionStatusHandler>();

/** 当前是否处于已连接状态（用于去重通知） */
let currentlyConnected = false;
/** 是否曾经成功连接过（首次连接前不弹断开提示） */
let hasEverConnected = false;
/** 是否发生过一次意外断连（供晚注册的订阅者恢复当前断连态） */
let hasUnexpectedDisconnect = false;

function notifyConnectionStatus(connected: boolean, force = false) {
  const changed = connected !== currentlyConnected;
  currentlyConnected = connected;
  if (connected) {
    hasEverConnected = true;
    hasUnexpectedDisconnect = false;
  }
  if (!changed && !force) return;
  connectionStatusHandlers.forEach((h) => h(connected));
}

// ============================================================================
// WebSocket URL 推算
// ============================================================================

/**
 * 设置后端 Web 服务器的实际端口（由 App 初始化时从 /api/interface 获取）。
 * 设置后 WS 将直连该端口而非走 Vite proxy，避免端口不一致导致连接失败。
 */
export function setServerPort(port: number): void {
  serverPort = port;
  log.info('WebSocket 目标端口已设置:', port);
}

function getWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

  // 已探测到后端端口：直连（tauri 生产模式下 tauri://localhost 相对路径不可用）
  if (serverPort && serverPort > 0) {
    const hostname = window.location.hostname || '127.0.0.1';
    return `${protocol}//${hostname}:${serverPort}/api/ws`;
  }

  // 正常情况：通过 Nginx 反向代理
  if (window.location.host) {
    return `${protocol}//${window.location.host}/api/ws`;
  }

  // Fallback：直连后端
  const hostname = window.location.hostname || '127.0.0.1';
  const port = serverPort || 12701;
  return `${protocol}//${hostname}:${port}/api/ws`;
}

// ============================================================================
// 连接管理
// ============================================================================

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;

  log.info(`WebSocket 将在 ${reconnectDelay}ms 后重连...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);

  // 指数退避：1s → 2s → 4s → 8s → ... → 最长 30s
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

function onOpen() {
  log.info('WebSocket 已连接');
  reconnectDelay = 1000;

  if (hasEverConnected && !currentlyConnected) {
    log.info('后端恢复，刷新页面以重新同步状态');
    window.location.reload();
    return;
  }

  notifyConnectionStatus(true);
}

function onClose(event: CloseEvent) {
  ws = null;
  currentlyConnected = false;
  if (!stopped) {
    log.warn(`WebSocket 断开 (code=${event.code})，准备重连`);
    const shouldForceNotify = !hasUnexpectedDisconnect;
    hasUnexpectedDisconnect = true;
    notifyConnectionStatus(false, shouldForceNotify);
    scheduleReconnect();
  }
}

function onError() {
  // 错误通常紧接着 onClose，不需要额外处理
  log.debug('WebSocket 发生错误');
}

function onMessage(event: MessageEvent) {
  let msg: WsMessage;
  try {
    msg = JSON.parse(event.data as string) as WsMessage;
  } catch {
    log.warn('收到无法解析的 WS 消息:', event.data);
    return;
  }

  switch (msg.type) {
    case 'maa-callback':
      maaCallbackHandlers.forEach((h) =>
        h(msg.payload.message, msg.payload.details, msg.payload.instance_id),
      );
      break;
    case 'maa-agent-output':
      agentOutputHandlers.forEach((h) =>
        h(msg.payload.instance_id, msg.payload.stream, msg.payload.line),
      );
      break;
    case 'config-changed':
      configChangedHandlers.forEach((h) => h());
      break;
    case 'state-changed':
      stateChangedHandlers.forEach((h) => h(msg.payload.instance_id, msg.payload.kind));
      break;
    default:
      log.debug('收到未知 WS 消息类型:', (msg as { type: string }).type);
  }
}

// ============================================================================
// 公开 API
// ============================================================================

/** 建立 WebSocket 连接（幂等：已连接则忽略）*/
export function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  stopped = false;
  const url = getWsUrl();
  log.info('连接 WebSocket:', url);

  ws = new WebSocket(url);
  ws.addEventListener('open', onOpen);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
  ws.addEventListener('message', onMessage);
}

/** 主动断开并停止自动重连 */
export function disconnect(): void {
  stopped = true;
  currentlyConnected = false;
  hasUnexpectedDisconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

/** 返回当前连接状态 */
export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}

// ============================================================================
// 订阅 API（返回取消订阅函数，与 Tauri unlisten 模式对齐）
// ============================================================================

/** 订阅 maa-callback 事件，返回取消订阅函数 */
export function onMaaCallback(handler: MaaCallbackHandler): () => void {
  maaCallbackHandlers.add(handler);
  return () => maaCallbackHandlers.delete(handler);
}

/** 订阅 maa-agent-output 事件，返回取消订阅函数 */
export function onAgentOutput(handler: AgentOutputHandler): () => void {
  agentOutputHandlers.add(handler);
  return () => agentOutputHandlers.delete(handler);
}

/** 订阅 config-changed 事件，返回取消订阅函数 */
export function onConfigChanged(handler: ConfigChangedHandler): () => void {
  configChangedHandlers.add(handler);
  return () => configChangedHandlers.delete(handler);
}

/** 订阅 state-changed 事件，返回取消订阅函数 */
export function onStateChanged(handler: StateChangedHandler): () => void {
  stateChangedHandlers.add(handler);
  return () => stateChangedHandlers.delete(handler);
}

/** 订阅连接状态变更（connected: true/false），返回取消订阅函数 */
export function onConnectionStatus(handler: ConnectionStatusHandler): () => void {
  connectionStatusHandlers.add(handler);
  if (currentlyConnected || hasUnexpectedDisconnect) {
    handler(currentlyConnected);
  }
  return () => connectionStatusHandlers.delete(handler);
}

/** 返回是否曾经成功建立过连接 */
export function hasConnectedBefore(): boolean {
  return hasEverConnected;
}
