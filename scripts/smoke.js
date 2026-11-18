// 激活冒烟测试：用最小 vscode 桩加载扩展，像平台面板一样通过 WebSocket 走一遍主要流程
require('./source-loader');
const Module = require('module');
const path = require('path');
const http = require('http');
const { WebSocket } = require('ws');
const manifest = require('../package.json');

const commands = new Map();
const forbidden = [];
const config = {};
const secretStore = new Map();
const disposable = () => ({ dispose() {} });

class Uri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = fsPath;
    this.path = fsPath;
  }
  toString() {
    return 'file://' + this.fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(base, ...parts) {
    return new Uri(path.join(base.fsPath, ...parts));
  }
}

const root = path.join(__dirname, '..');
const stub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  TabInputTextDiff: class {},
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  Uri,
  Position: class {},
  Range: class {},
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: { all: [], close: async () => true },
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    registerWebviewViewProvider: () => forbidden.push('webview') && disposable(),
    createWebviewPanel: () => forbidden.push('webview') && disposable(),
    createTerminal: () => forbidden.push('terminal') && disposable(),
    createTreeView: () => forbidden.push('tree') && disposable()
  },
  workspace: {
    workspaceFolders: [{ uri: Uri.file(root), name: 'sxpt-agent', index: 0 }],
    textDocuments: [],
    getConfiguration: () => ({
      get: (key) => config[key],
      inspect: () => ({}),
      update: async (key, value) => {
        config[key] = value;
      }
    }),
    onDidChangeConfiguration: () => disposable(),
    registerTextDocumentContentProvider: () => disposable(),
    asRelativePath: (uri) => path.relative(root, typeof uri === 'string' ? uri : uri.fsPath).replace(/\\/g, '/'),
    fs: { stat: async () => ({}), readFile: async () => Buffer.from('') }
  },
  languages: { getDiagnostics: () => [] },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return disposable();
    },
    executeCommand: async () => undefined
  },
  chat: {
    createChatParticipant: () => forbidden.push('chat') && disposable()
  }
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  return request === 'vscode' ? 'vscode-stub' : origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };

const ext = require(path.join(root, 'out', 'extension.js'));

let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('ok ' + name);
  } else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 和平台面板一样的最小客户端：请求带 id，等对应的 reply */
async function panel(port) {
  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    ws = await new Promise((resolve) => {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://platform.local', 'X-Forwarded-Host': 'platform.local' } });
      s.on('open', () => resolve(s));
      s.on('error', () => resolve(undefined));
    });
    if (!ws) await wait(50);
  }
  const events = [];
  const waiting = new Map();
  let seq = 0;
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type === 'reply') waiting.get(msg.replyTo)?.(msg.data);
    else events.push(msg);
  });
  return {
    ws,
    events,
    request: (type, extra = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        waiting.set(id, resolve);
        ws.send(JSON.stringify({ id, type, ...extra }));
      })
  };
}

async function main() {
  const port = await freePort();
  config.bridgePort = port;
  const context = {
    subscriptions: [],
    extensionUri: Uri.file(root),
    extension: { packageJSON: manifest },
    secrets: {
      get: async (k) => secretStore.get(k),
      store: async (k, v) => void secretStore.set(k, v),
      delete: async (k) => void secretStore.delete(k)
    },
    workspaceState: (() => {
      const m = new Map();
      return { get: (k) => m.get(k), update: async (k, v) => void m.set(k, v) };
    })(),
    globalState: (() => {
      const m = new Map();
      return { get: (k) => m.get(k), update: async (k, v) => void m.set(k, v) };
    })(),
    globalStorageUri: undefined
  };
  ext.activate(context);

  // ---------- 注册 ----------
  const declared = manifest.contributes.commands.map((c) => c.command);
  const missing = declared.filter((c) => !commands.has(c));
  check('清单声明的命令都已注册', missing.length === 0, missing.join(', '));
  const undeclared = [...commands.keys()].filter((c) => !declared.includes(c));
  check('注册的命令都在清单里', undeclared.length === 0, undeclared.join(', '));
  check('扩展不创建任何 VS Code 界面（Webview、终端、树视图、Chat 参与者）', forbidden.length === 0, forbidden.join(','));
  check('清单里没有 Chat 参与者和活动栏面板', !manifest.contributes.chatParticipants && !manifest.contributes.viewsContainers);
  check('依赖里声明了 ws', !!manifest.dependencies.ws);

  // ---------- 面板连接 ----------
  const p = await panel(port);
  check('面板通过 WebSocket 连上扩展', !!p.ws);
  const snap = await p.request('hello');
  check('快照包含状态、设置、会话、对话、快捷指令', snap.type === 'snapshot' && snap.state && snap.settings && snap.sessions && snap.transcript && snap.quickActions.length >= 5);
  check('未配置时状态为未连接', snap.state.configured === false && snap.settings.configured === false);
  check('快照不包含 API Key 本身', !JSON.stringify(snap).includes('apiKey"') && snap.settings.hasApiKey === false);

  // ---------- 设置表单 ----------
  let r = await p.request('settings.update', { patch: { baseUrl: 'ftp://x', contextWindow: 10 } });
  check('非法设置被拒绝并返回字段错误', r.ok === false && r.errors.baseUrl && r.errors.contextWindow);
  check('校验失败时什么都不写', config.baseUrl === undefined);
  r = await p.request('settings.update', { patch: { allowedCommands: ['npm test && rm'] } });
  check('免确认命令里的 shell 符号被拒绝', r.ok === false && r.errors.allowedCommands);

  p.events.length = 0;
  r = await p.request('settings.update', { patch: { baseUrl: 'http://127.0.0.1:9/v1/', model: 'demo', approvalMode: 'autoEdit', allowedCommands: ['npm test', 'npm test', ' '] } });
  check('合法设置保存成功', r.ok === true && config.baseUrl === 'http://127.0.0.1:9/v1' && config.model === 'demo' && config.approvalMode === 'autoEdit');
  check('免确认命令去重去空', JSON.stringify(config.allowedCommands) === '["npm test"]');
  await wait(20);
  const pushed = p.events.find((e) => e.type === 'settings');
  check('保存后向所有面板推送新设置', pushed && pushed.configured === true && pushed.model === 'demo');
  check('保存后推送新状态', p.events.some((e) => e.type === 'state' && e.configured === true));

  await p.request('settings.setApiKey', { apiKey: 'sk-test' });
  check('API Key 存进 SecretStorage', [...secretStore.values()].includes('sk-test'));
  check('设置里只显示已保存', p.events.some((e) => e.type === 'settings' && e.hasApiKey === true) && !JSON.stringify(p.events).includes('sk-test'));

  r = await p.request('settings.models', { baseUrl: 'not a url' });
  check('获取模型列表前校验地址', r.ok === false && /API 地址/.test(r.message));

  // ---------- 任务 ----------
  r = await p.request('send', { text: '   ' });
  check('空任务被拒绝', r.ok === false);
  r = await p.request('send', { action: 'explain' });
  check('需要选区的快捷指令在没有选区时提示', r.ok === false && /选中/.test(r.message));
  r = await p.request('send', { action: 'nope' });
  check('未知快捷指令被拒绝', r.ok === false);

  // ---------- 会话 ----------
  p.events.length = 0;
  await p.request('newSession');
  await wait(20);
  check('新建会话推送空对话与会话列表', p.events.some((e) => e.type === 'transcript' && e.messages.length === 0) && p.events.some((e) => e.type === 'sessions'));
  r = await p.request('deleteSession', { sessionId: 'not-exist' });
  check('删除不存在的会话返回失败', r.ok === false);
  r = await p.request('approve', { approvalId: 'x', decision: 'allow' });
  check('处理过的审批返回失败', r.ok === false);
  r = await p.request('undo');
  check('没有修改时撤销给出提示', r.ok === false && /没有可撤销/.test(r.message));
  r = await p.request('whatever');
  check('未知请求返回错误信息', r.ok === false && /未知请求/.test(r.message));

  // ---------- 端到端：假模型改文件 → 面板审批 → 修改汇总 → 撤销 ----------
  const fs = require('fs');
  const os = require('os');
  const { createModelServer, listen } = require('./fake-model');
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sxpt-smoke-ws-'));
  fs.writeFileSync(path.join(wsDir, 'a.txt'), 'hello world\n');
  stub.workspace.workspaceFolders = [{ uri: Uri.file(wsDir), name: 'demo', index: 0 }];
  stub.workspace.asRelativePath = (uri) => path.relative(wsDir, typeof uri === 'string' ? uri : uri.fsPath).replace(/\\/g, '/');
  stub.workspace.fs = {
    stat: async (u) => ({ size: fs.statSync(u.fsPath).size }),
    readFile: async (u) => fs.readFileSync(u.fsPath),
    writeFile: async (u, b) => fs.writeFileSync(u.fsPath, b),
    delete: async (u) => fs.rmSync(u.fsPath)
  };
  const { server } = createModelServer([
    { tool: 'update_plan', args: { steps: [{ step: '修改问候语', status: 'in_progress' }] } },
    { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'hello world', newText: 'hi there' }] } },
    { text: '改好了：把问候语换成了 hi there。' }
  ]);
  const modelPort = await listen(server);
  await p.request('settings.update', { patch: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'test-model', approvalMode: 'ask' } });

  p.events.length = 0;
  r = await p.request('send', { text: '把问候语改成 hi there' });
  check('任务被接受，过程通过事件推送', r.ok === true);
  const until = async (cond, ms = 15000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await wait(20);
    return cond();
  };
  check('面板收到审批卡片（含精简 diff）', await until(() => p.events.some((e) => e.type === 'approval')));
  const approval = p.events.find((e) => e.type === 'approval');
  check('审批信息含文件与增删行数', approval && approval.request.path === 'a.txt' && approval.request.added === 1 && approval.request.removed === 1 && Array.isArray(approval.request.diff));

  // 运行中另一个面板接入：快照里能重放进行中的对话
  const late = await panel(port);
  const lateSnap = await late.request('hello');
  check('运行中接入的面板能看到正在进行的任务', lateSnap.state.busy === true && lateSnap.running.some((e) => e.type === 'approval') && lateSnap.running.some((e) => e.type === 'user'));
  late.ws.close();

  r = await p.request('approve', { approvalId: approval.request.id, decision: 'allow' });
  check('面板里点「允许」', r.ok === true);
  check('任务完成', await until(() => p.events.some((e) => e.type === 'assistantEnd')));
  await wait(50);
  const types = p.events.map((e) => e.type);
  check('事件顺序：用户 → 计划 → 审批 → 完成 → 修改汇总', ['user', 'plan', 'approval', 'approvalDone', 'assistantEnd', 'changes'].every((t) => types.includes(t)) && types.indexOf('approval') < types.indexOf('assistantEnd'), types.join(','));
  check('回答文字流式推送', p.events.filter((e) => e.type === 'textDelta').map((e) => e.text).join('').includes('改好了'));
  check('文件确实被修改', fs.readFileSync(path.join(wsDir, 'a.txt'), 'utf8') === 'hi there\n');
  check('修改汇总列出文件', p.events.find((e) => e.type === 'changes')?.files.includes('a.txt'));
  check('会话列表出现这次对话', p.events.some((e) => e.type === 'sessions' && e.items.some((s) => s.title.includes('问候语'))));
  check('完成后状态不再忙碌、可撤销', p.events.filter((e) => e.type === 'state').at(-1)?.busy === false && p.events.filter((e) => e.type === 'state').at(-1)?.undoCount === 1);

  r = await p.request('undo');
  check('撤销恢复文件', r.ok === true && fs.readFileSync(path.join(wsDir, 'a.txt'), 'utf8') === 'hello world\n');
  server.close();

  p.ws.close();
  for (const d of context.subscriptions) d.dispose?.();
}

main()
  .catch((err) => {
    console.error(err);
    fail++;
  })
  .finally(() => {
    if (fail) {
      console.error(`smoke: ${fail} failed`);
      process.exit(1);
    }
    console.log('smoke: all passed');
    process.exit(0);
  });
