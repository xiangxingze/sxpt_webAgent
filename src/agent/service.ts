import * as vscode from 'vscode';
import * as path from 'path';
import { AgentConfig, APPROVAL_MODE_LABELS, isModelConfigured, readConfig } from '../config';
import { SecretStore } from '../secrets';
import { collectContext, contextToPrompt } from '../contextCollector';
import { PiAgent } from './piAgent';
import { SessionStore } from './session';
import { AgentHost, AgentSettings, ApprovalDecision, ApprovalRequest } from './types';
import { toFriendlyError } from '../modelCheck';
import { ChangeTracker } from '../changeTracker';
import { DiffPreview } from '../diffPreview';
import { SettingsPatch, SettingsStore } from '../settings';
import { isInsideRoots } from './policy';
import { PlatformClient, courseContextToPrompt } from '../platform/client';
import { getProjectOutline } from '../project/outline';
import { compactDiff } from './diffLines';

const PROJECT_INTENT = /项目|结构|架构|目录|模块|入口|依赖|技术栈|工程|仓库|代码库/i;

/** 快捷指令：面板上的快捷按钮与输入 /命令 共用 */
export const QUICK_PROMPTS: Record<string, { label: string; prompt: string; needsSelection?: boolean; project?: boolean }> = {
  explain: {
    label: '解释选中代码',
    prompt: '解释我当前选中的代码：它做什么、执行流程是什么、涉及哪些关键知识点。只讲解，不要修改文件。',
    needsSelection: true
  },
  fix: {
    label: '修复当前问题',
    prompt:
      '检查当前工作区的错误和警告（get_diagnostics）；如果项目有测试或构建命令，运行它们。' +
      '然后定位根因并修复，修复后重新验证，最后总结改了什么、为什么。'
  },
  tests: {
    label: '生成单元测试',
    prompt:
      '为我当前选中的代码编写单元测试：先看项目里已有的测试框架和风格，把测试写到合适的位置，' +
      '再运行测试确认通过，最后说明如何运行。',
    needsSelection: true
  },
  refactor: {
    label: '重构选中代码',
    prompt:
      '分析我当前选中的代码，指出可读性、结构和健壮性问题。给出重构方案，并先说明思路；' +
      '然后用 edit 工具做出修改，改完检查诊断并总结。',
    needsSelection: true
  },
  problems: {
    label: '分析错误',
    prompt: '用 get_diagnostics 查看当前的错误和警告，说明每个问题的原因。先只分析，不要修改文件。'
  },
  project: {
    label: '理解项目',
    prompt: '概述当前项目的目录结构和主要模块职责，指出入口文件和核心依赖。只查看，不要修改文件。',
    project: true
  }
};

/** 推给面板的事件（JSON 可序列化） */
export type AgentEvent = { type: string; [key: string]: unknown };

interface PendingApproval {
  request: ApprovalRequest;
  finish: (decision: ApprovalDecision) => void;
}

/** 本次任务里需要在面板重连后重放的事件 */
const REPLAY_EVENTS = new Set([
  'user',
  'assistantStart',
  'textDelta',
  'textReset',
  'toolStart',
  'toolEnd',
  'plan',
  'status',
  'approval',
  'approvalDone'
]);

/**
 * Agent 服务：负责一次任务的完整流程（上下文、运行、审批、撤销快照、汇总）、
 * 会话历史与设置，并把过程作为事件广播给实训平台里的 Agent 面板。
 * 本身不绘制任何界面。
 */
export class AgentService {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly agent: PiAgent;
  private readonly session: SessionStore;
  readonly settings: SettingsStore;
  private readonly pending = new Map<string, PendingApproval>();
  private busy = false;
  private switching = false;
  private abort?: AbortController;
  private runCompletion?: Promise<void>;
  private runEvents: AgentEvent[] = [];
  /** 正在运行的任务开始前的会话内容（运行中重连时用来还原对话） */
  private runHistory?: Array<{ role: string; content: string }>;

  constructor(
    context: vscode.ExtensionContext,
    private readonly secrets: SecretStore,
    private readonly tracker: ChangeTracker,
    private readonly diffs: DiffPreview,
    private readonly platform: PlatformClient,
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem
  ) {
    this.session = new SessionStore(context);
    this.settings = new SettingsStore(context, secrets, output);
    this.agent = new PiAgent(this.createHost(), (line) => output.appendLine(line), context.globalStorageUri?.fsPath);
  }

  // ---------------- 事件 ----------------

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentEvent): void {
    if (this.busy && REPLAY_EVENTS.has(event.type)) {
      const last = this.runEvents[this.runEvents.length - 1];
      if (event.type === 'textDelta' && last?.type === 'textDelta') {
        last.text = String(last.text) + String(event.text);
      } else {
        this.runEvents.push({ ...event });
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.output.appendLine(`[bridge] ${(err as Error).message}`);
      }
    }
  }

  /** 面板连接（或重连）时的完整快照：状态、设置、会话列表、当前对话、运行中的事件 */
  async snapshot(): Promise<AgentEvent> {
    return {
      type: 'snapshot',
      state: this.stateView(),
      settings: await this.settings.snapshot(),
      sessions: this.sessionsView(),
      transcript: this.transcriptView(),
      running: this.busy ? this.runEvents : [],
      quickActions: Object.entries(QUICK_PROMPTS).map(([id, item]) => ({
        id,
        label: item.label,
        needsSelection: !!item.needsSelection
      }))
    };
  }

  private stateView(): Record<string, unknown> {
    const cfg = readConfig();
    return {
      busy: this.busy,
      configured: isModelConfigured(cfg),
      model: cfg.model,
      approvalMode: cfg.approvalMode,
      autoEdits: this.agent.autoEditsEnabled,
      sessionId: this.session.currentId,
      undoCount: this.tracker.undoCount,
      editor: this.describeEditor(),
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? ''
    };
  }

  private sessionsView(): Record<string, unknown> {
    return { activeId: this.session.currentId, items: this.session.history };
  }

  private transcriptView(): Record<string, unknown> {
    return {
      sessionId: this.session.currentId,
      draft: this.session.currentDraft,
      messages: (this.runHistory ?? this.session.all)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))
    };
  }

  pushState(): void {
    this.emit({ type: 'state', ...this.stateView() });
    this.updateStatusBar();
  }

  private async pushSettings(): Promise<void> {
    this.emit({ type: 'settings', ...(await this.settings.snapshot()) });
    this.pushState();
  }

  private pushSessions(): void {
    this.emit({ type: 'sessions', ...this.sessionsView() });
  }

  /** 编辑器光标 / 选区变化：只推送一个轻量的状态 */
  editorChanged(): void {
    this.emit({ type: 'editor', editor: this.describeEditor() });
  }

  // ---------------- 面板发来的请求 ----------------

  /** 处理一条请求，返回值作为应答（reply）发回请求方 */
  async handle(msg: Record<string, any>): Promise<unknown> {
    switch (msg?.type) {
      case 'hello':
        void this.settings.listModels().catch(() => undefined);
        return this.snapshot();
      case 'send':
        return this.send(String(msg.text ?? ''), typeof msg.action === 'string' ? msg.action : undefined);
      case 'stop':
        this.stop();
        return { ok: true };
      case 'approve':
        return { ok: this.resolveApproval(String(msg.approvalId ?? ''), msg.decision) };
      case 'openDiff':
        return { ok: await this.openDiff(String(msg.approvalId ?? '')) };
      case 'openFile':
        return { ok: await this.openFile(String(msg.path ?? ''), Number(msg.line) || 0) };
      case 'newSession':
        await this.changeSession();
        return { ok: true };
      case 'selectSession':
        await this.changeSession(String(msg.sessionId ?? ''));
        return { ok: true };
      case 'deleteSession':
        return { ok: await this.deleteSession(String(msg.sessionId ?? '')) };
      case 'saveDraft':
        if (typeof msg.text === 'string') this.session.saveDraft(msg.text);
        return { ok: true };
      case 'undo':
        return this.undo();
      case 'settings.update': {
        const errors = await this.settings.update((msg.patch ?? {}) as SettingsPatch);
        if (!Object.keys(errors).length) await this.pushSettings();
        return { ok: !Object.keys(errors).length, errors };
      }
      case 'settings.setApiKey':
        await this.settings.setApiKey(String(msg.apiKey ?? ''));
        await this.pushSettings();
        return { ok: true };
      case 'settings.models':
        return this.settings.listModels(
          typeof msg.baseUrl === 'string' ? msg.baseUrl : undefined,
          typeof msg.apiKey === 'string' && msg.apiKey ? msg.apiKey : undefined,
          !!msg.refresh
        );
      case 'settings.test':
        return this.settings.test(
          typeof msg.baseUrl === 'string' ? msg.baseUrl : undefined,
          typeof msg.model === 'string' ? msg.model : undefined,
          typeof msg.apiKey === 'string' && msg.apiKey ? msg.apiKey : undefined
        );
      default:
        return { ok: false, message: `未知请求：${String(msg?.type)}` };
    }
  }

  // ---------------- 一次 Agent 任务 ----------------

  private async send(text: string, action?: string): Promise<{ ok: boolean; message?: string }> {
    const quick = action ? QUICK_PROMPTS[action] : undefined;
    if (action && !quick) {
      return { ok: false, message: '未知的快捷指令。' };
    }
    const extra = text.trim();
    const userText = quick ? (extra ? `${quick.prompt}\n\n补充说明：${extra}` : quick.prompt) : extra;
    if (!userText) {
      return { ok: false, message: '请输入要完成的任务。' };
    }
    if (this.busy || this.switching) {
      return { ok: false, message: 'Agent 正在运行，请等它完成或先停止。' };
    }
    if (!isModelConfigured(readConfig())) {
      return { ok: false, message: '还没有连接模型服务，请先在设置里填写 API 地址并选择模型。' };
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      return { ok: false, message: 'Agent 需要在一个工作区文件夹中工作，请先在 VS Code 里打开项目文件夹。' };
    }
    if (quick?.needsSelection) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return { ok: false, message: '请先在编辑器中选中要处理的代码。' };
      }
    }
    // 任务在后台运行，过程通过事件推送；请求本身立即应答
    void this.runTask(userText, extra || quick?.label || userText, !!quick?.project);
    return { ok: true };
  }

  private async runTask(userText: string, displayText: string, forceProject: boolean): Promise<void> {
    this.busy = true;
    this.runEvents = [];
    const controller = new AbortController();
    this.abort = controller;
    const completion = this.runUserText(userText, displayText, forceProject, controller);
    this.runCompletion = completion;
    try {
      await completion;
    } catch (error) {
      const friendly = controller.signal.aborted ? '已停止。' : toFriendlyError(error);
      if (this.session.all.at(-1)?.role === 'user') this.session.addAssistant(friendly);
      this.emit({ type: 'error', message: friendly });
    } finally {
      this.runCompletion = undefined;
      this.runEvents = [];
      this.runHistory = undefined;
      this.abort = undefined;
      this.busy = false;
      this.pushSessions();
      this.pushState();
    }
  }

  private async runUserText(userText: string, displayText: string, forceProject: boolean, controller: AbortController): Promise<void> {
    const cfg = readConfig();
    const settings = this.buildSettings(cfg, await this.secrets.getApiKey());
    if (!settings) {
      throw new Error('Agent 需要在一个工作区文件夹中工作，请先打开项目文件夹。');
    }

    const previousHistory = [...this.session.all];
    this.runHistory = previousHistory;
    this.session.saveDraft('');
    this.emit({ type: 'user', text: displayText });
    this.pushState();

    this.tracker.beginRun();
    const id = `a${Date.now()}`;
    let changed: string[] = [];
    let replyText = '';
    this.session.addUser(userText);

    try {
      this.emit({ type: 'assistantStart', id });
      this.emit({ type: 'status', text: '正在收集上下文…' });
      const contextBlock = await this.buildContextBlock(cfg, userText, forceProject);
      const prompt = contextBlock ? `${contextBlock}\n\n【我的请求】\n${userText}` : userText;
      this.emit({ type: 'status', text: '正在思考…' });
      try {
        if (controller.signal.aborted) throw new Error('已停止');
        const result = await this.agent.run(
          { prompt, history: previousHistory, settings, signal: controller.signal },
          {
            onTextDelta: (delta) => {
              replyText += delta;
              this.emit({ type: 'textDelta', text: delta });
            },
            onTextReset: () => {
              replyText = '';
              this.emit({ type: 'textReset' });
            },
            onToolStart: (info) => this.emit({ type: 'toolStart', ...info }),
            onToolEnd: (info) => this.emit({ type: 'toolEnd', ...info }),
            onStatus: (text) => this.emit({ type: 'status', text })
          }
        );
        changed = this.tracker.commitRun().map((f) => this.rel(f));
        const finalText = result.text || replyText || (result.aborted ? '已停止。' : '（已完成操作）');
        const changeNote = changed.length ? `\n\n（本次修改了：${changed.join('、')}）` : '';
        this.session.addAssistant(finalText + changeNote);
        this.emit({
          type: 'assistantEnd',
          id,
          text: finalText,
          aborted: result.aborted,
          model: result.model,
          elapsedMs: result.elapsedMs,
          toolCalls: result.toolCalls
        });
      } catch (err) {
        changed = this.tracker.commitRun().map((f) => this.rel(f));
        const friendly = controller.signal.aborted ? '已停止。' : toFriendlyError(err);
        this.session.addAssistant([replyText, friendly].filter(Boolean).join('\n\n'));
        this.emit({ type: 'assistantEnd', id, text: replyText, aborted: true });
        this.emit({ type: 'error', message: friendly });
        this.output.appendLine(`[agent] ${friendly}`);
      }
      if (changed.length) {
        this.emit({ type: 'changes', files: changed });
      }
    } finally {
      this.tracker.commitRun();
      this.cancelPendingApprovals();
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  dispose(): void {
    this.abort?.abort();
    this.cancelPendingApprovals();
    this.agent.dispose();
    this.listeners.clear();
  }

  // ---------------- 会话 ----------------

  private async changeSession(id?: string): Promise<void> {
    if (this.switching) return;
    if (id && id === this.session.currentId) return;
    if (id && !this.session.history.some((s) => s.id === id)) return;
    this.switching = true;
    try {
      this.abort?.abort();
      this.cancelPendingApprovals();
      await this.runCompletion?.catch(() => undefined);
      await this.agent.reset();
      if (id) this.session.select(id);
      else this.session.reset();
      this.runEvents = [];
      this.emit({ type: 'transcript', ...this.transcriptView() });
      this.pushSessions();
      this.pushState();
    } finally {
      this.switching = false;
    }
  }

  private async deleteSession(id: string): Promise<boolean> {
    if (!id) return false;
    if (id === this.session.currentId) {
      if (this.busy) return false;
      await this.agent.reset();
      this.session.remove(id);
      this.emit({ type: 'transcript', ...this.transcriptView() });
    } else if (!this.session.remove(id)) {
      return false;
    }
    this.pushSessions();
    this.pushState();
    return true;
  }

  private async undo(): Promise<{ ok: boolean; message: string }> {
    if (this.busy) {
      return { ok: false, message: 'Agent 正在运行，请等它完成或先停止后再撤销。' };
    }
    const ok = await this.tracker.undoLast();
    this.pushState();
    return { ok, message: ok ? '已撤销上一次任务的文件修改。' : '没有可撤销的 AI 修改记录。' };
  }

  // ---------------- Agent 宿主能力 ----------------

  private createHost(): AgentHost {
    return {
      requestApproval: (request, signal) => this.requestApproval(request, signal),
      beforeWrite: (absPath) => this.tracker.snapshot(absPath),
      isDirty: (absPath) => this.isDirty(absPath),
      getDiagnostics: (p) => this.collectDiagnostics(p),
      onPlan: (steps) => this.emit({ type: 'plan', steps })
    };
  }

  private isDirty(absPath: string): boolean {
    const target = normalizeFsPath(absPath);
    return vscode.workspace.textDocuments.some(
      (doc) => doc.uri.scheme === 'file' && doc.isDirty && normalizeFsPath(doc.uri.fsPath) === target
    );
  }

  private async collectDiagnostics(p: string | undefined): Promise<string> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) {
      return '当前没有打开工作区。';
    }
    const filterPath = p && p.trim() ? path.resolve(roots[0], p.trim().replace(/^@/, '')) : undefined;
    const lines: string[] = [];
    let total = 0;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') continue;
      const fsPath = uri.fsPath;
      if (!roots.some((r) => normalizeFsPath(fsPath).startsWith(normalizeFsPath(r)))) continue;
      if (filterPath && normalizeFsPath(fsPath) !== normalizeFsPath(filterPath)) continue;
      const rel = vscode.workspace.asRelativePath(uri, false);
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        total++;
        if (lines.length < 60) {
          const label = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
          const source = d.source ? ` (${d.source})` : '';
          lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${label}] ${d.message.split('\n')[0]}${source}`);
        }
      }
    }
    if (total === 0) {
      return '没有错误或警告。（仅包含语言服务已分析的文件，未打开过的文件可能不在其中。）';
    }
    const more = total > lines.length ? `\n……另有 ${total - lines.length} 条未显示` : '';
    return `共 ${total} 条错误/警告：\n${lines.join('\n')}${more}`;
  }

  // ---------------- 审批 ----------------

  /** 发给面板的审批信息：不含文件全文，只带精简的行级 Diff */
  private approvalView(request: ApprovalRequest): Record<string, unknown> {
    return {
      id: request.id,
      kind: request.kind,
      title: request.title,
      path: request.relPath,
      command: request.command,
      cwd: request.cwd,
      isNewFile: !!request.isNewFile,
      added: request.added ?? 0,
      removed: request.removed ?? 0,
      diff: request.kind !== 'bash' && request.proposed !== undefined ? compactDiff(request.original ?? '', request.proposed) : undefined
    };
  }

  private requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        this.pending.delete(request.id);
        signal.removeEventListener('abort', onAbort);
        void this.diffs.close(request.id);
        this.emit({ type: 'approvalDone', id: request.id, decision });
        this.updateStatusBar();
        resolve(decision);
      };
      const onAbort = () => finish('deny');
      if (signal.aborted) {
        finish('deny');
        return;
      }
      signal.addEventListener('abort', onAbort);
      this.pending.set(request.id, { request, finish });
      this.emit({ type: 'approval', request: this.approvalView(request) });
      this.updateStatusBar();
      if (this.listeners.size === 0) {
        // 没有面板连着（例如在新窗口单独打开了 VS Code）：改用原生弹窗，避免任务卡住
        void this.modalApproval(request).then(finish);
      }
    });
  }

  private async modalApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const detail =
      request.kind === 'bash'
        ? `命令：${request.command}\n工作目录：${request.cwd}`
        : `${request.title}（+${request.added ?? 0} −${request.removed ?? 0}）`;
    const choice = await vscode.window.showWarningMessage(`AI Agent 请求：${detail}`, { modal: true }, '允许');
    return choice === '允许' ? 'allow' : 'deny';
  }

  private cancelPendingApprovals(): void {
    for (const pending of [...this.pending.values()]) {
      pending.finish('deny');
    }
  }

  private resolveApproval(id: string, decision: unknown): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    pending.finish(decision === 'allow' || decision === 'allowAllEdits' ? decision : 'deny');
    return true;
  }

  private async openDiff(id: string): Promise<boolean> {
    const pending = this.pending.get(id);
    if (!pending || pending.request.kind === 'bash') return false;
    await this.diffs.show(pending.request, vscode.ViewColumn.Active);
    return true;
  }

  /** 面板里点击文件名：在 VS Code 编辑器中打开（只允许工作区内的文件） */
  private async openFile(relPath: string, line: number): Promise<boolean> {
    const clean = relPath.trim().replace(/^@/, '');
    if (!clean) return false;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    let target: vscode.Uri | undefined;
    for (const root of roots) {
      const abs = path.resolve(root, clean);
      if (isInsideRoots(roots, abs) && (await exists(abs))) {
        target = vscode.Uri.file(abs);
        break;
      }
    }
    if (!target && !path.isAbsolute(clean) && !clean.includes('..')) {
      target = (await vscode.workspace.findFiles(`**/${clean}`, '**/node_modules/**', 1))[0];
    }
    if (!target) return false;
    const doc = await vscode.workspace.openTextDocument(target);
    const position = new vscode.Position(Math.min(Math.max(0, line - 1), Math.max(0, doc.lineCount - 1)), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(position, position), preview: true });
    return true;
  }

  // ---------------- 上下文 ----------------

  private buildSettings(cfg: AgentConfig, apiKey: string | undefined): AgentSettings | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) return undefined;
    return {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey,
      cwd: roots[0],
      roots,
      approvalMode: cfg.approvalMode,
      allowedCommands: cfg.allowedCommands,
      commandTimeoutMs: cfg.commandTimeoutMs,
      runTimeoutMs: cfg.runTimeoutMs,
      contextWindow: cfg.contextWindow,
      maxOutputTokens: cfg.maxOutputTokens,
      systemPromptExtra: cfg.systemPromptExtra
    };
  }

  private async buildContextBlock(cfg: AgentConfig, question: string, forceProject: boolean): Promise<string> {
    const blocks: string[] = [];
    if (cfg.platformUrl) {
      const prompt = courseContextToPrompt(await this.platform.getContext(cfg.platformUrl));
      if (prompt) {
        blocks.push(prompt);
      } else if (this.platform.lastErrorMessage) {
        this.output.appendLine(`[platform] 不可用：${this.platform.lastErrorMessage}，已按本地模式继续`);
      }
    }
    if (cfg.autoContext) {
      try {
        const body = contextToPrompt(await collectContext());
        if (body) blocks.push(`【当前 IDE 上下文】\n${body}`);
      } catch (err) {
        this.output.appendLine(`[context] 采集失败：${(err as Error).message}`);
      }
    }
    if (cfg.includeProjectContext && (forceProject || PROJECT_INTENT.test(question))) {
      const outline = await getProjectOutline();
      if (outline) blocks.push(`【项目结构摘要】\n${outline.summary}`);
    }
    return blocks.join('\n\n');
  }

  private describeEditor(): { file: string; line: number; selection?: string } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return null;
    const sel = editor.selection;
    return {
      file: vscode.workspace.asRelativePath(editor.document.uri, false),
      line: sel.active.line + 1,
      selection: sel.isEmpty ? undefined : `L${sel.start.line + 1}-${sel.end.line + 1}`
    };
  }

  private rel(absPath: string): string {
    return vscode.workspace.asRelativePath(vscode.Uri.file(absPath), false);
  }

  // ---------------- 状态栏 ----------------

  updateStatusBar(): void {
    const cfg = readConfig();
    let background: vscode.ThemeColor | undefined;
    const panels = this.listeners.size;
    if (this.pending.size > 0) {
      this.statusBar.text = '$(bell-dot) AI Agent 等待确认';
      this.statusBar.tooltip = '有操作正在等待你在平台右侧的 Agent 面板里确认';
      background = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (!isModelConfigured(cfg)) {
      this.statusBar.text = '$(sparkle) AI Agent：未配置';
      this.statusBar.tooltip = '在平台页面右侧的 Agent 面板里打开设置，连接模型服务';
    } else {
      this.statusBar.text = `${this.busy ? '$(sync~spin)' : '$(sparkle)'} AI Agent · ${cfg.model}`;
      this.statusBar.tooltip = `模型：${cfg.model}\n审批：${APPROVAL_MODE_LABELS[cfg.approvalMode]}\n${panels ? '平台面板已连接' : '平台面板未连接'}`;
    }
    this.statusBar.backgroundColor = background;
    this.statusBar.show();
  }
}

function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function exists(p: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}
