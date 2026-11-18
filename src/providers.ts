/**
 * 内置的模型服务商预设。全部走 OpenAI 兼容接口（/chat/completions、/models），
 * 区别在于各家对请求字段的兼容程度不同，这里按地址识别服务商并给出对应的兼容设置。
 *
 * Pi 自带按地址的识别，但只认得 DeepSeek / 智谱 / Kimi；通义千问、Claude 兼容层、
 * Gemini 兼容层会被当成标准 OpenAI，发送 store、max_completion_tokens 等字段。
 */

export interface ProviderPreset {
  id: string;
  label: string;
  /** 填入「API 地址」的默认值 */
  baseUrl: string;
  /** 申请 API Key 的页面 */
  keyUrl: string;
  /** 按主机名识别（后缀匹配），老师用自建网关时不会命中，按标准 OpenAI 处理 */
  hosts: string[];
  /** 写入 Pi models.json 的 compat（覆盖 Pi 的自动识别） */
  compat?: Record<string, unknown>;
  /** /models 返回的 ID 需要去掉的前缀（Gemini 返回 models/gemini-…） */
  modelIdPrefix?: string;
  /** 获取模型列表、测试连接时额外的请求头 */
  extraHeaders?: (apiKey: string | undefined) => Record<string, string>;
}

/** 非 OpenAI 官方接口：不发送 store / developer 角色，用通用的 max_tokens */
const NON_OPENAI = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens'
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hosts: ['deepseek.com'],
    compat: { ...NON_OPENAI }
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    hosts: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'],
    compat: { ...NON_OPENAI }
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    hosts: ['moonshot.cn', 'moonshot.ai'],
    compat: { ...NON_OPENAI }
  },
  {
    id: 'zhipu',
    label: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    hosts: ['open.bigmodel.cn'],
    compat: { ...NON_OPENAI }
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    hosts: ['api.openai.com']
  },
  {
    id: 'claude',
    label: 'Claude（兼容层）',
    baseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hosts: ['api.anthropic.com'],
    compat: { ...NON_OPENAI },
    // /v1/models 是 Anthropic 原生接口，需要 x-api-key 与 anthropic-version
    extraHeaders: (apiKey) => ({
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {})
    })
  },
  {
    id: 'gemini',
    label: 'Gemini（兼容层）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    hosts: ['generativelanguage.googleapis.com'],
    compat: { ...NON_OPENAI },
    modelIdPrefix: 'models/'
  }
];

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 按 API 地址识别服务商；自建网关、本地模型等返回 undefined */
export function detectProvider(baseUrl: string): ProviderPreset | undefined {
  const host = hostOf(baseUrl);
  if (!host) {
    return undefined;
  }
  return PROVIDER_PRESETS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
}

/** 发给平台面板的精简信息 */
export interface ProviderOption {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl: string;
}

export function providerOptions(): ProviderOption[] {
  return PROVIDER_PRESETS.map(({ id, label, baseUrl, keyUrl }) => ({ id, label, baseUrl, keyUrl }));
}
