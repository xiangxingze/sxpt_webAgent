import * as net from 'net';
import * as vscode from 'vscode';
import { SecretStore } from './secrets';
import { ChangeTracker } from './changeTracker';
import { DiffPreview } from './diffPreview';
import { PlatformClient } from './platform/client';
import { AgentService, QUICK_PROMPTS } from './agent/service';
import { BridgeServer } from './bridge/server';

const DEFAULT_BRIDGE_PORT = 8845;

/**
 * 扩展在容器里只做「执行端」：运行 Agent、审批、撤销、保存会话与设置。
 * 界面是实训平台页面里 VS Code 右侧的 Agent 面板，通过
 * 平台 /vscode 代理 → code-server /proxy/<端口>/ → 本扩展的桥接服务 与这里通信。
 */
export function activate(context: vscode.ExtensionContext): void {
  // Node 解析出多个地址时每个只等 250ms 就换下一个，出口延迟稍高时会全部判为超时
  // （UND_ERR_CONNECT_TIMEOUT），而 curl 正常。与 Pi CLI 一致放宽到 2 秒。
  try {
    net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
  } catch {
    // 旧版 Node 没有该接口时忽略
  }
  const output = vscode.window.createOutputChannel('SXPT AI Agent');
  const secrets = new SecretStore(context);
  const tracker = new ChangeTracker(context, output);
  const diffs = new DiffPreview();
  diffs.register(context);

  // 平台上下文是管理员侧能力，学生没有配置入口；令牌由平台对接方注入，目前不提供
  const platform = new PlatformClient(async () => undefined, output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'ptnAgent.status';
  context.subscriptions.push(statusBar, output);

  const service = new AgentService(context, secrets, tracker, diffs, platform, output, statusBar);
  context.subscriptions.push({ dispose: () => service.dispose() });

  const port = vscode.workspace.getConfiguration('ptnAgent').get<number>('bridgePort') || DEFAULT_BRIDGE_PORT;
  const version = String((context.extension?.packageJSON as { version?: string } | undefined)?.version ?? '');
  const bridge = new BridgeServer(service, (line) => output.appendLine(line), port, version, () => service.updateStatusBar());
  void bridge.start();
  context.subscriptions.push({ dispose: () => bridge.dispose() });

  const register = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('ptnAgent.status', async () => {
    const connected = bridge.clientCount > 0;
    const choice = await vscode.window.showInformationMessage(
      connected
        ? 'AI Agent 面板已连接：在平台页面 VS Code 右侧的面板里对话、确认修改和设置。'
        : `AI Agent 面板未连接。请从课程页面进入 VS Code，在右侧打开 Agent 面板。（服务端口 ${port}）`,
      '查看日志'
    );
    if (choice === '查看日志') output.show();
  });
  register('ptnAgent.undo', async () => {
    const result = (await service.handle({ type: 'undo' })) as { message: string };
    void vscode.window.showInformationMessage(result.message);
  });
  register('ptnAgent.stop', () => service.stop());

  // 编辑器右键菜单：任务发到平台面板里执行和展示
  for (const action of Object.keys(QUICK_PROMPTS)) {
    register(`ptnAgent.task.${action}`, async () => {
      if (bridge.clientCount === 0) {
        void vscode.window.showWarningMessage('请先在平台页面 VS Code 右侧打开 AI Agent 面板。');
        return;
      }
      const result = (await service.handle({ type: 'send', action })) as { ok: boolean; message?: string };
      if (!result.ok && result.message) void vscode.window.showWarningMessage(result.message);
    });
  }

  service.updateStatusBar();
  // 光标移动很频繁，合并后再推给面板（面板只用来显示「当前文件 · 行号」）
  let editorTimer: NodeJS.Timeout | undefined;
  const editorChanged = () => {
    if (editorTimer) clearTimeout(editorTimer);
    editorTimer = setTimeout(() => service.editorChanged(), 200);
  };
  const workspaceFoldersChanged = typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function'
    ? vscode.workspace.onDidChangeWorkspaceFolders(() => service.pushState())
    : undefined;
  context.subscriptions.push(
    { dispose: () => editorTimer && clearTimeout(editorTimer) },
    vscode.window.onDidChangeTextEditorSelection(editorChanged),
    vscode.window.onDidChangeActiveTextEditor(editorChanged),
    ...(workspaceFoldersChanged ? [workspaceFoldersChanged] : []),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ptnAgent')) service.pushState();
    })
  );

  output.appendLine('[sxpt-agent] activated');
}

export function deactivate(): void {
  // 资源都挂在 context.subscriptions 上，由宿主统一释放
}
