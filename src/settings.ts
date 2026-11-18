import * as vscode from 'vscode';
import { ApprovalMode, CONFIG_SECTION, isModelConfigured, isValidBaseUrl, normalizeBaseUrl, readConfig } from './config';
import { SecretStore } from './secrets';
import { fetchModels, testConnection } from './modelCheck';
import { ProviderOption, providerOptions } from './providers';

/** 按 API 地址分别缓存模型列表 */
type ModelCache = Record<string, { models: string[]; at: number }>;

const CACHE_KEY = 'ptnAgent.modelCache.v2';
const MAX_CACHED_URLS = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MODES: ApprovalMode[] = ['ask', 'autoEdit', 'readOnly'];

/** 平台面板的设置表单展示的数据。API Key 永远不回传，只告诉面板「是否已保存」 */
export interface SettingsSnapshot {
  configured: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  model: string;
  approvalMode: ApprovalMode;
  allowedCommands: string[];
  autoContext: boolean;
  includeProjectContext: boolean;
  systemPromptExtra: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** 当前地址已缓存的模型列表，表单打开时直接可选 */
  models: string[];
  /** 内置的服务商预设，面板用来做「服务商」下拉 */
  providers: ProviderOption[];
}

/** 面板可以修改的设置项 */
export interface SettingsPatch {
  baseUrl?: string;
  model?: string;
  approvalMode?: string;
  allowedCommands?: string[];
  autoContext?: boolean;
  includeProjectContext?: boolean;
  systemPromptExtra?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

// ---------------- 校验（纯函数，供自检脚本使用） ----------------

export function validateBaseUrlInput(value: string): string | undefined {
  const v = value.trim();
  return !v || isValidBaseUrl(v) ? undefined : 'API 地址需要以 http:// 或 https:// 开头。';
}

export function validateContextWindowInput(value: number): string | undefined {
  return Number.isFinite(value) && value >= 2048 && value <= 4_000_000 ? undefined : '上下文窗口需要在 2048 到 4000000 之间。';
}

export function validateMaxOutputInput(value: number): string | undefined {
  return Number.isFinite(value) && value >= 256 && value <= 1_000_000 ? undefined : '最大输出需要在 256 到 1000000 之间。';
}

export function validateCommandPrefix(value: string): string | undefined {
  return /[;&|<>$()`\n]/.test(value) ? '命令前缀里不能包含 ; & | < > $ ( ) ` 等符号。' : undefined;
}

/** 校验一次修改；返回「字段 → 错误信息」，为空表示通过 */
export function validatePatch(patch: SettingsPatch): Record<string, string> {
  const errors: Record<string, string> = {};
  if (patch.baseUrl !== undefined) {
    const e = validateBaseUrlInput(String(patch.baseUrl));
    if (e) errors.baseUrl = e;
  }
  if (patch.approvalMode !== undefined && !MODES.includes(patch.approvalMode as ApprovalMode)) {
    errors.approvalMode = '未知的审批模式。';
  }
  if (patch.allowedCommands !== undefined) {
    if (!Array.isArray(patch.allowedCommands)) {
      errors.allowedCommands = '格式不正确。';
    } else {
      const bad = patch.allowedCommands.map((c) => validateCommandPrefix(String(c))).find(Boolean);
      if (bad) errors.allowedCommands = bad;
    }
  }
  if (patch.contextWindow !== undefined) {
    const e = validateContextWindowInput(Number(patch.contextWindow));
    if (e) errors.contextWindow = e;
  }
  if (patch.maxOutputTokens !== undefined) {
    const e = validateMaxOutputInput(Number(patch.maxOutputTokens));
    if (e) errors.maxOutputTokens = e;
  }
  return errors;
}

/**
 * 设置的读写：普通项写入 VS Code 配置（ptnAgent.*），API Key 写入 SecretStorage。
 * 模型列表来自所填 API 地址的 /models；服务商预设只用于快速填写地址和调整请求兼容性。
 */
export class SettingsStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: SecretStore,
    private readonly output: vscode.OutputChannel
  ) {}

  async snapshot(): Promise<SettingsSnapshot> {
    const cfg = readConfig();
    return {
      configured: isModelConfigured(cfg),
      baseUrl: cfg.baseUrl,
      hasApiKey: await this.secrets.hasApiKey(),
      model: cfg.model,
      approvalMode: cfg.approvalMode,
      allowedCommands: cfg.allowedCommands,
      autoContext: cfg.autoContext,
      includeProjectContext: cfg.includeProjectContext,
      systemPromptExtra: cfg.systemPromptExtra,
      contextWindow: cfg.contextWindow,
      maxOutputTokens: cfg.maxOutputTokens,
      models: this.cachedModels(cfg.baseUrl),
      providers: providerOptions()
    };
  }

  /** 保存一次修改；校验失败时什么都不写 */
  async update(patch: SettingsPatch): Promise<Record<string, string>> {
    const errors = validatePatch(patch);
    if (Object.keys(errors).length) {
      return errors;
    }
    const writes: Array<[string, unknown]> = [];
    if (patch.baseUrl !== undefined) writes.push(['baseUrl', normalizeBaseUrl(String(patch.baseUrl))]);
    if (patch.model !== undefined) writes.push(['model', String(patch.model).trim()]);
    if (patch.approvalMode !== undefined) writes.push(['approvalMode', patch.approvalMode]);
    if (patch.allowedCommands !== undefined) {
      const list = [...new Set(patch.allowedCommands.map((c) => String(c).trim()).filter(Boolean))];
      writes.push(['allowedCommands', list]);
    }
    if (patch.autoContext !== undefined) writes.push(['autoContext', !!patch.autoContext]);
    if (patch.includeProjectContext !== undefined) writes.push(['includeProjectContext', !!patch.includeProjectContext]);
    if (patch.systemPromptExtra !== undefined) writes.push(['systemPromptExtra', String(patch.systemPromptExtra).trim()]);
    if (patch.contextWindow !== undefined) writes.push(['contextWindow', Math.round(Number(patch.contextWindow))]);
    if (patch.maxOutputTokens !== undefined) writes.push(['maxOutputTokens', Math.round(Number(patch.maxOutputTokens))]);
    for (const [key, value] of writes) {
      await this.write(key, value);
    }
    return {};
  }

  /** 保存 API Key；空字符串表示清除 */
  async setApiKey(value: string): Promise<void> {
    await this.secrets.setApiKey(String(value ?? '').trim());
  }

  /**
   * 获取模型列表。表单里的地址 / Key 还没保存时也可以先试，
   * 未传入的部分使用已保存的值。
   */
  async listModels(baseUrl?: string, apiKey?: string, refresh = false): Promise<{ ok: boolean; models: string[]; message?: string }> {
    const url = normalizeBaseUrl(baseUrl ?? readConfig().baseUrl);
    if (!url || !isValidBaseUrl(url)) {
      return { ok: false, models: [], message: '请先填写正确的 API 地址。' };
    }
    const entry = (this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {})[url];
    if (!refresh && apiKey === undefined && entry && Date.now() - entry.at < CACHE_TTL_MS) {
      return { ok: true, models: entry.models };
    }
    const result = await fetchModels(url, apiKey ?? (await this.secrets.getApiKey()));
    if (result.ok) {
      this.storeModels(url, result.models);
      return { ok: true, models: result.models };
    }
    this.output.appendLine(`[models] ${result.message}`);
    return { ok: false, models: entry?.models ?? [], message: result.message };
  }

  async test(baseUrl?: string, model?: string, apiKey?: string): Promise<{ ok: boolean; message: string }> {
    const cfg = readConfig();
    const url = normalizeBaseUrl(baseUrl ?? cfg.baseUrl);
    const name = (model ?? cfg.model).trim();
    if (!url || !name) {
      return { ok: false, message: '请先填写 API 地址并选择模型。' };
    }
    const result = await testConnection(url, name, apiKey ?? (await this.secrets.getApiKey()));
    return { ok: result.ok, message: result.message ?? (result.ok ? '连接成功' : '连接失败') };
  }

  private cachedModels(baseUrl: string): string[] {
    return (this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {})[baseUrl]?.models ?? [];
  }

  private storeModels(baseUrl: string, models: string[]): void {
    const cache: ModelCache = { ...(this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {}) };
    cache[baseUrl] = { models, at: Date.now() };
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    for (const old of keys.slice(MAX_CACHED_URLS)) {
      delete cache[old];
    }
    void this.context.globalState.update(CACHE_KEY, cache);
  }

  private write(key: string, value: unknown): Thenable<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspected = configuration.inspect?.(key);
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return configuration.update(key, value, target);
  }
}
