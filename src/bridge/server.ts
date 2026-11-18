import * as http from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { AgentEvent, AgentService } from '../agent/service';

/** 面板与扩展之间的协议版本；不兼容的改动需要递增 */
export const PROTOCOL_VERSION = 1;

const HEARTBEAT_MS = 25_000;
const RETRY_STEPS_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
const MAX_MESSAGE_BYTES = 512 * 1024;

/** 同一容器里新打开的 VS Code 窗口请求旧窗口让出端口 */
const TAKEOVER_PATH = '/takeover';
const TAKEOVER_HEADER = 'x-sxpt-takeover';

/**
 * 只接受容器内另一个扩展实例直接发来的接管请求：
 * 浏览器请求一定带 Origin，且自定义头会触发预检（这里不响应 OPTIONS）；
 * 经 code-server 端口代理转发的请求带 X-Forwarded-*。
 */
export function isLocalTakeoverRequest(headers: http.IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined || headers.forwarded !== undefined) return false;
  if (Object.keys(headers).some((name) => name.toLowerCase().startsWith('x-forwarded-'))) return false;
  return headers[TAKEOVER_HEADER] === '1';
}

/** 请求占用端口的旧实例让出；对方不是 SXPT Agent（或旧版本）时返回 false */
export function requestTakeover(port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: TAKEOVER_PATH,
        method: 'POST',
        agent: false,
        headers: { [TAKEOVER_HEADER]: '1', Connection: 'close' },
        timeout: timeoutMs
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 判断 WebSocket 握手的来源是否可信。
 *
 * 平台页面经过两层代理到达这里：平台后端（校验课程票据，保留浏览器 Origin，
 * 设置 X-Forwarded-Host 为平台主机名）→ code-server 的 /proxy/<端口>/。
 * 只接受与平台主机（或直接访问时的 Host）同源的浏览器请求，
 * 防止学生访问的其他网站直接连容器地址操纵 Agent。
 */
export function isTrustedOrigin(headers: http.IncomingHttpHeaders): boolean {
  const origin = String(headers.origin ?? '');
  if (!origin) {
    // 非浏览器客户端（本机调试脚本）不带 Origin；服务只监听 127.0.0.1
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const forwarded = String(headers['x-forwarded-host'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const host = String(headers.host ?? '').toLowerCase();
  return forwarded.includes(originHost) || originHost === host;
}

/**
 * 实训平台 Agent 面板的桥接服务：在容器内 127.0.0.1:<端口> 提供
 * - GET /health：面板探测扩展是否就绪
 * - WebSocket /ws：请求 {id, type, ...} → 应答 {type:'reply', replyTo, data}；Agent 事件实时广播
 */
export class BridgeServer {
  private server?: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly clients = new Set<WebSocket>();
  private readonly alive = new WeakSet<WebSocket>();
  private unsubscribe?: () => void;
  private heartbeat?: NodeJS.Timeout;
  private retry?: NodeJS.Timeout;
  private retryAttempt = 0;
  private startInFlight?: Promise<boolean>;
  private disposed = false;
  /** 已把端口让给更新的窗口：不再重试监听 */
  private released = false;
  private takeoverTried = false;

  constructor(
    private readonly service: AgentService,
    private readonly log: (line: string) => void,
    private readonly port: number,
    private readonly version: string,
    private readonly onClientsChanged: (count: number) => void = () => undefined
  ) {}

  get clientCount(): number {
    return this.clients.size;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /**
   * 开始监听。端口被占用时：
   * - 通常是刷新页面后，code-server 仍保留着旧窗口的扩展进程（重连宽限期可达数小时），
   *   面板会连到看不见的旧窗口。先请求旧实例让出端口，由当前窗口接管；
   * - 对方不响应接管（不是 SXPT Agent 或旧版本）时短退避重试。
   */
  start(): Promise<boolean> {
    if (this.disposed || this.released) return Promise.resolve(false);
    if (this.server?.listening) return Promise.resolve(true);
    if (this.startInFlight) return this.startInFlight;

    const attempt = new Promise<boolean>((resolve) => {
      const server = http.createServer((req, res) => this.onHttp(req, res));
      server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (this.server === server) this.server = undefined;
        if (err.code === 'EADDRINUSE' && !this.takeoverTried) {
          this.takeoverTried = true;
          server.close();
          this.log(`[bridge] 端口 ${this.port} 被另一个 VS Code 窗口占用，请求它让出`);
          void requestTakeover(this.port).then((ok) => {
            this.log(ok ? '[bridge] 旧窗口已让出端口，由本窗口接管' : '[bridge] 占用端口的实例未响应接管，稍后重试');
            this.scheduleRetry(ok ? 100 : RETRY_STEPS_MS[0]);
          });
          resolve(false);
          return;
        }
        const delay = RETRY_STEPS_MS[Math.min(this.retryAttempt, RETRY_STEPS_MS.length - 1)];
        this.retryAttempt += 1;
        this.log(`[bridge] 无法监听 127.0.0.1:${this.port}：${err.code ?? err.message}，${delay}ms 后重试`);
        server.close();
        this.scheduleRetry(delay);
        resolve(false);
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        this.retryAttempt = 0;
        this.log(`[bridge] 平台面板服务已启动：127.0.0.1:${this.port}`);
        this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
        resolve(true);
      });
    });
    this.startInFlight = attempt;
    void attempt.then(() => {
      if (this.startInFlight === attempt) this.startInFlight = undefined;
    });
    return attempt;
  }

  private scheduleRetry(delay: number): void {
    if (this.disposed || this.released || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.start();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.unsubscribe?.();
    this.wss.close();
    this.server?.close();
    this.server = undefined;
  }

  /** 把端口让给更新的窗口：断开面板、停止监听，之后不再重试 */
  private release(): void {
    this.released = true;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    // 面板收到断开后会自动重连，连到接管端口的新窗口
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.onClientsChanged(0);
    const server = this.server;
    this.server = undefined;
    server?.close();
  }

  // ---------------- HTTP ----------------

  private onHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0];
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && url === TAKEOVER_PATH) {
      if (!isLocalTakeoverRequest(req.headers)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      res.setHeader('Connection', 'close');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }), () => {
        this.log('[bridge] 新打开的 VS Code 窗口接管了平台面板连接，本窗口让出端口');
        this.release();
      });
      return;
    }
    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true, name: 'sxpt-agent', version: this.version, protocol: PROTOCOL_VERSION }));
      return;
    }
    res.statusCode = 404;
    res.end();
  }

  // ---------------- WebSocket ----------------

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = (req.url ?? '').split('?')[0];
    if (url !== '/ws' || !isTrustedOrigin(req.headers)) {
      this.log(`[bridge] 拒绝连接：${url} origin=${String(req.headers.origin ?? '')}`);
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  private onConnection(ws: WebSocket): void {
    this.clients.add(ws);
    this.alive.add(ws);
    if (!this.unsubscribe) {
      this.unsubscribe = this.service.subscribe((event) => this.broadcast(event));
    }
    this.onClientsChanged(this.clients.size);
    ws.on('pong', () => this.alive.add(ws));
    ws.on('message', (data) => void this.onMessage(ws, data));
    ws.on('close', () => this.drop(ws));
    ws.on('error', () => this.drop(ws));
  }

  private drop(ws: WebSocket): void {
    if (!this.clients.delete(ws)) return;
    if (this.clients.size === 0) {
      // 没有面板时取消订阅：Agent 的审批会改用原生弹窗，避免任务卡住
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
    this.onClientsChanged(this.clients.size);
  }

  private async onMessage(ws: WebSocket, data: Buffer | string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const replyTo = msg.id;
    let reply: unknown;
    try {
      reply = await this.service.handle(msg);
    } catch (err) {
      this.log(`[bridge] 处理 ${String(msg.type)} 失败：${(err as Error).message}`);
      reply = { ok: false, message: (err as Error).message };
    }
    if (replyTo !== undefined) {
      this.send(ws, { type: 'reply', replyTo, data: reply });
    }
  }

  private broadcast(event: AgentEvent): void {
    const text = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  /** 心跳：经过两层代理的空闲连接容易被掐断；连续两次没有回应就断开 */
  private ping(): void {
    for (const ws of this.clients) {
      if (!this.alive.has(ws)) {
        ws.terminate();
        this.drop(ws);
        continue;
      }
      this.alive.delete(ws);
      ws.ping();
    }
  }
}
