# SXPT AI Coding Agent

实训平台内置 VS Code（LXC 容器中的 code-server）里的 AI 编程 Agent。

学生在 VS Code 自带的**对话面板**里输入 `@sxpt` 加上要完成的目标，Agent 会自己阅读代码、列出计划、修改文件、运行命令并验证结果。对话、会话列表、审批和设置**全部在同一个面板里完成**，不会再弹出别的面板、终端或网页。

## 一个面板完成全部操作

| 你想做的事 | 在对话面板里怎么做 |
| --- | --- |
| 开始对话 | 点状态栏右侧的 **AI Agent**，或按 `Ctrl+Alt+I`。面板打开后输入框里已填好 `@sxpt`，直接描述任务 |
| 新建 / 切换会话 | 用面板顶部原生的 **+** 和会话列表。切回旧会话后继续提问，Agent 会接着那条会话的上下文 |
| 看进度 | 回答里实时显示计划、正在执行的工具、命令输出 |
| 确认修改 / 命令 | 回答里出现「等待你的确认」卡片，显示改动的 diff 或要运行的命令，下面有 **允许 / 本次会话都允许 / 拒绝 / 查看完整 Diff** 按钮 |
| 撤销 | 任务结束后的修改汇总下有 **撤销本次修改**；也可以输入 `/undo` |
| 设置 | 输入 `/settings`，或点面板标题栏的齿轮。设置卡片列出所有选项，点每行的「修改」就地修改，改完卡片自动刷新 |

第一次使用时，无论发什么，面板里都会先出现「连接模型服务」引导和设置卡片。填好 **API 地址 → API Key → 模型** 后，Agent 会自动继续处理你刚才的请求。

### 快捷指令

| 指令 | 作用 |
| --- | --- |
| `/explain` | 解释当前选中的代码（只讲解，不修改） |
| `/fix` | 检查错误、运行测试，定位根因并修复 |
| `/tests` | 为选中的代码生成并运行单元测试 |
| `/refactor` | 重构选中的代码 |
| `/problems` | 分析当前的错误和警告（不修改） |
| `/project` | 理解项目结构 |
| `/undo` | 撤销上一次任务的文件修改 |
| `/context` | 查看下一条消息会附带给模型的上下文 |
| `/settings` | 设置卡片 |
| `/help` | 使用说明 |

编辑器右键菜单 **AI Agent** 里也有这些操作，点了会直接发送到对话面板。输入框里用 `#` 附加的文件也会告诉 Agent。

## Agent 能力与安全边界

基于内置的 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，由模型驱动「推理 → 调用工具 → 观察结果 → 再推理」的多步循环。

| 工具 | 作用 | 是否需要确认 |
| --- | --- | --- |
| `read` / `grep` / `find` / `ls` | 查看文件、搜索代码、列目录 | 否（限工作区内） |
| `edit` / `write` | 修改已有文件 / 新建或重写文件 | 是（`autoEdit` 模式下自动应用，可撤销） |
| `bash` | 运行测试、构建等命令 | 是（白名单命令可免确认） |
| `get_diagnostics` | 读取问题面板中的错误和警告 | 否 |
| `update_plan` | 展示多步任务的计划与进度 | 否 |

审批模式（设置卡片里切换）：`ask` 逐项确认（默认）、`autoEdit` 自动应用文件修改、`readOnly` 只读。

- **路径围栏**：工具只能访问工作区内的路径，会解析符号链接。
- **敏感文件**：`.env`、私钥、`.pem`、`.npmrc` 等不允许读取（`.env.example` 除外）；`.git` 不允许写入。
- **未保存保护**：文件在编辑器里有未保存的修改时，Agent 不会覆盖它。
- **命令分级**：高危命令（`rm -rf`、`sudo`、`git reset --hard` 等）一律拦截；命中白名单且不含 shell 元字符的命令才可免确认。
- **超时与步数**：单条命令默认 120 秒，单次任务默认最长 600 秒、最多 40 轮推理。
- **隔离**：不读取 Pi 自身的配置和凭据；API Key 只存放在 VS Code SecretStorage。
- **撤销**：保留最近 10 次任务的快照；超过 1 MB 的文件不保存快照。`bash` 对文件的改动无法撤销。

## 为什么用原生对话面板

平台在局域网用 `http://` 提供 code-server，Webview 依赖的 Service Worker 需要安全上下文，在这种环境下会白屏。所以本扩展只使用 VS Code 原生 UI：

- **对话**：VS Code Chat 面板 + 扩展注册的 Chat 参与者 `@sxpt`（稳定 API，VS Code ≥ 1.90）。
- **会话**：由面板原生管理。每次任务的回答元数据里记录会话 ID 和序号，下次请求时从 `chatContext.history` 还原对话，并判断底层 Agent 会话能否直接续用。
- **审批 / 设置**：回答里的 Markdown 卡片 + 原生按钮；单项编辑使用原生 InputBox / QuickPick。卡片里的命令链接只放行白名单中的命令。

## 部署到平台

1. 安装 VSIX：`code-server --install-extension sxpt-agent-<版本>.vsix`。
2. 检查 LXC 模板的 `settings.json`：
   - `chat.disableAIFeatures` 必须为 `false`（模板当前已是 `false`）。
   - 模板里的 `workbench.secondarySideBar.defaultVisibility` 为 `hidden`，对话面板默认收起。学生点状态栏的 **AI Agent** 就能打开；也可以改为 `visible`，让面板默认展开。
3. 打开面板时扩展会切到 **Ask** 模式：新版 VS Code 的 Agent 模式只走内置 Agent，不会把请求交给扩展参与者。

## 开发

```bash
npm install
npm run compile
npm run check     # 策略、命令、撤销、模型、Pi 端到端、对话面板逻辑、激活冒烟测试
npm run package   # 生成 VSIX
```

在 VS Code 中按 F5 启动扩展开发宿主进行调试。

### 目录

```
src/
  extension.ts          入口：注册参与者、命令、状态栏
  chat/participant.ts   Chat 参与者：任务执行、审批卡片、设置卡片、快捷指令
  chat/thread.ts        从原生会话历史还原上下文（纯逻辑）
  chat/render.ts        各类卡片的 Markdown（纯逻辑）
  chat/diffLines.ts     审批卡片里的精简 diff
  settings.ts           单项设置的原生编辑器
  agent/                Pi SDK 封装、工具审批拦截、安全策略
  ...                   上下文采集、撤销快照、Diff 预览、模型检查
```

配置项沿用 `ptnAgent.*` 前缀，与旧版本兼容。
