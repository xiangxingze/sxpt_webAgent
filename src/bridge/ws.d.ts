// `ws` 的最小类型声明（只覆盖桥接服务用到的部分），避免额外引入 @types/ws
declare module 'ws' {
  import type { IncomingMessage } from 'http';
  import type { Duplex } from 'stream';
  import { EventEmitter } from 'events';

  class WebSocket extends EventEmitter {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    ping(): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'message', listener: (data: Buffer | string) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'pong', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  interface ServerOptions {
    noServer?: boolean;
    maxPayload?: number;
  }

  class WebSocketServer extends EventEmitter {
    constructor(options: ServerOptions);
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: WebSocket) => void): void;
    close(): void;
  }

  export { WebSocket, WebSocketServer };
}
