import * as vscode from 'vscode';

const KEY_API = 'ptnAgent.apiKey';

/**
 * 读 SecretStorage 的最长等待时间。
 * code-server 里 SecretStorage 要经浏览器端（渲染进程）读写；页面刷新后旧窗口的
 * 扩展进程还会保留数小时，此时浏览器端已不在，读取会一直挂起，导致面板的 hello 永远没有应答。
 */
const SECRET_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Thenable<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读取 VS Code 密钥存储超时')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** API Key 只存放在 VS Code SecretStorage，不写入任何配置文件 */
export class SecretStore {
  /** 读过一次后缓存在内存里，避免每次都经浏览器端读取 */
  private cached: { value: string | undefined } | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.secrets.onDidChange?.((e) => {
      if (e.key === KEY_API) this.cached = undefined;
    });
  }

  async getApiKey(): Promise<string | undefined> {
    if (this.cached) return this.cached.value;
    try {
      const key = await withTimeout(this.context.secrets.get(KEY_API), SECRET_TIMEOUT_MS);
      const value = key && key.length > 0 ? key : undefined;
      this.cached = { value };
      return value;
    } catch {
      // 读不到时按「未保存」处理，不缓存，下次再试
      return undefined;
    }
  }

  async setApiKey(value: string): Promise<void> {
    if (!value) {
      await withTimeout(this.context.secrets.delete(KEY_API), SECRET_TIMEOUT_MS);
      this.cached = { value: undefined };
      return;
    }
    await withTimeout(this.context.secrets.store(KEY_API, value), SECRET_TIMEOUT_MS);
    this.cached = { value };
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }
}
