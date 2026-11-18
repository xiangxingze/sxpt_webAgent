/**
 * 服务商预设自检：识别规则、模型列表处理，以及经过 Pi 实际发出的请求字段。
 * 通过替换 globalThis.fetch 拦截请求，不访问外网。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { PROVIDER_PRESETS, detectProvider, providerOptions } = require(path.join(__dirname, '..', 'out', 'providers.js'));
const { fetchModels, testConnection, toFriendlyError } = require(path.join(__dirname, '..', 'out', 'modelCheck.js'));
const { PiAgent } = require(path.join(__dirname, '..', 'out', 'agent', 'piAgent.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

const realFetch = globalThis.fetch;
let captured = [];
let respond = () => new Response('{}', { status: 200 });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  const headers = {};
  new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => (headers[k] = v));
  let body = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  captured.push({ url, method: init.method ?? input.method ?? 'GET', headers, body: typeof body === 'string' && body ? JSON.parse(body) : undefined });
  return respond(url);
};

function sse(model) {
  const chunk = (delta, finish) => ({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
  const text = ['data: ' + JSON.stringify(chunk({ role: 'assistant', content: 'pong' })), 'data: ' + JSON.stringify(chunk({}, 'stop')), 'data: [DONE]', ''].join('\n\n');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function main() {
  // ---- 识别 ----
  expect('预设共 7 家', PROVIDER_PRESETS.length === 7 && providerOptions().length === 7);
  for (const p of PROVIDER_PRESETS) {
    expect(`按默认地址识别 ${p.label}`, detectProvider(p.baseUrl)?.id === p.id, detectProvider(p.baseUrl)?.id);
  }
  expect('末尾斜杠、大小写不影响识别', detectProvider('HTTPS://API.DeepSeek.com/v1/')?.id === 'deepseek');
  expect('自建网关不识别', detectProvider('http://10.0.0.5:3000/v1') === undefined);
  expect('不按路径或伪造后缀误判', detectProvider('https://evil-deepseek.com.example.org/v1') === undefined && detectProvider('https://notapi.openai.com.cn/v1') === undefined);
  expect('非法地址不识别', detectProvider('not a url') === undefined);
  expect('面板选项不暴露兼容细节', providerOptions().every((o) => Object.keys(o).sort().join() === 'baseUrl,id,keyUrl,label'));

  // ---- 模型列表 ----
  captured = [];
  respond = () => new Response(JSON.stringify({ data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }] }), { status: 200 });
  const gem = await fetchModels('https://generativelanguage.googleapis.com/v1beta/openai', 'g-key');
  expect('Gemini 去掉 models/ 前缀', gem.ok && gem.models.join() === 'gemini-2.5-flash', JSON.stringify(gem));

  captured = [];
  respond = () => new Response(JSON.stringify({ data: [{ id: 'claude-x', type: 'model' }] }), { status: 200 });
  await fetchModels('https://api.anthropic.com/v1', 'a-key');
  const ah = captured[0]?.headers ?? {};
  expect('Claude 获取列表带 x-api-key 与 anthropic-version', ah['x-api-key'] === 'a-key' && ah['anthropic-version'] === '2023-06-01' && ah.authorization === 'Bearer a-key', JSON.stringify(ah));

  captured = [];
  respond = () => new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 });
  await fetchModels('https://api.deepseek.com/v1', 'd-key');
  expect('其他服务商不加额外请求头', !('x-api-key' in (captured[0]?.headers ?? {})), JSON.stringify(captured[0]?.headers));

  respond = () => new Response(JSON.stringify({ error: { type: 'forbidden', message: 'Request not allowed' } }), { status: 403 });
  const blocked = await fetchModels('https://api.anthropic.com/v1', 'a-key');
  expect('地区封锁不误报为 Key 错误（列表）', !blocked.ok && /地区/.test(blocked.message), blocked.message);
  const blockedTest = await testConnection('https://api.anthropic.com/v1', 'claude-x', 'a-key');
  expect('地区封锁不误报为 Key 错误（测试连接）', !blockedTest.ok && /地区/.test(blockedTest.message), blockedTest.message);
  respond = () => new Response(JSON.stringify({ error: { code: 400, message: 'User location is not supported for the API use.' } }), { status: 400 });
  const gemBlocked = await fetchModels('https://generativelanguage.googleapis.com/v1beta/openai', 'g');
  expect('Gemini 地区限制给出提示', !gemBlocked.ok && /地区/.test(gemBlocked.message), gemBlocked.message);
  respond = () => new Response('{"error":"Invalid API key"}', { status: 401 });
  const badKey = await fetchModels('https://api.deepseek.com/v1', 'bad');
  expect('普通 401 仍提示 Key', !badKey.ok && /Key/.test(badKey.message), badKey.message);
  expect('连接超时给出可读提示', /连接超时/.test(toFriendlyError(new Error('UND_ERR_CONNECT_TIMEOUT'))));

  // ---- 经过 Pi 实际发出的对话请求 ----
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-providers-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-providers-ws-'));
  const host = {
    requestApproval: async () => 'deny',
    beforeWrite: async () => undefined,
    isDirty: () => false,
    getDiagnostics: async () => '',
    onPlan: () => undefined
  };
  const events = { onTextDelta: () => undefined, onTextReset: () => undefined, onToolStart: () => undefined, onToolEnd: () => undefined, onStatus: () => undefined };
  const bodies = {};
  try {
    for (const p of PROVIDER_PRESETS) {
      captured = [];
      respond = (url) => (url.endsWith('/chat/completions') ? sse('m') : new Response('{}', { status: 404 }));
      const agent = new PiAgent(host, () => undefined, path.join(storage, p.id));
      const settings = {
        baseUrl: p.baseUrl, model: `${p.id}-model`, apiKey: 'k', cwd: ws, roots: [ws], approvalMode: 'ask',
        allowedCommands: [], commandTimeoutMs: 5000, runTimeoutMs: 30000, contextWindow: 64000, maxOutputTokens: 2048, systemPromptExtra: ''
      };
      try {
        const r = await agent.run({ prompt: 'ping', history: [], settings, signal: new AbortController().signal }, events);
        expect(`${p.label} 对话请求成功`, r.text === 'pong', r.text);
      } catch (err) {
        expect(`${p.label} 对话请求成功`, false, err.message);
      } finally {
        agent.dispose();
      }
      const req = captured.find((c) => c.url === `${p.baseUrl}/chat/completions`);
      expect(`${p.label} 请求发往 ${p.baseUrl}/chat/completions`, !!req, captured.map((c) => c.url).join(', '));
      bodies[p.id] = req?.body ?? {};
    }

    const b = bodies;
    expect('OpenAI 保持官方字段（max_completion_tokens、store）', b.openai.max_completion_tokens === 2048 && b.openai.store === false, JSON.stringify(b.openai));
    for (const id of ['deepseek', 'qwen', 'kimi', 'zhipu', 'claude', 'gemini']) {
      const body = b[id];
      expect(`${id} 使用 max_tokens 且不发送 store`, body.max_tokens === 2048 && !('max_completion_tokens' in body) && !('store' in body), JSON.stringify(body));
      expect(`${id} 系统提示使用 system 角色`, body.messages?.[0]?.role === 'system', body.messages?.[0]?.role);
    }
    for (const [id, body] of Object.entries(b)) {
      expect(`${id} 带工具定义且不发送 strict`, Array.isArray(body.tools) && body.tools.length > 0 && body.tools.every((t) => !('strict' in t.function)), JSON.stringify(body.tools?.[0]));
      expect(`${id} 不发送思考参数`, !('thinking' in body) && !('enable_thinking' in body) && !('reasoning_effort' in body), JSON.stringify(body));
    }
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    globalThis.fetch = realFetch;
  }

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('provider preset tests passed');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
