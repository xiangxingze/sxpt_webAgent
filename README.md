# SXPT AI Coding Agent

运行在 code-server（浏览器版 VS Code）里的 AI 编程 Agent 扩展。

扩展本身不画界面，只作为 Agent 的**执行端**：负责运行 Agent、审批修改、撤销、保存会话和设置。对话界面是嵌在宿主网页里、VS Code 旁边的一个面板，经 code-server 自带的端口代理，通过 WebSocket 和扩展通信。

```
浏览器面板 ──WebSocket──▶ code-server /proxy/<端口>/ws ──▶ 扩展桥接服务 127.0.0.1:<端口>
                                                              │
                                                              ▼
                                                  Pi SDK Agent ──▶ OpenAI 兼容模型接口
```

这样做是因为局域网里的 code-server 通常走 `http://` 访问，Webview 依赖的 Service Worker 需要安全上下文，在这种环境下会白屏。所以界面放到宿主页面里实现，扩展只负责执行。

## 功能

- **多步 Agent**：基于 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，模型反复执行「推理 → 调用工具 → 观察结果」，可以读代码、列计划、改文件、跑命令，并自己验证结果。
- **审批与撤销**：修改文件、运行命令前先把 diff 或命令发到面板等待确认；每次任务的修改都可以一键撤销。
- **会话**：保留多条会话和历史记录。面板断线重连后，会还原当前对话和正在执行的任务。
- **编辑器上下文**：自动附带当前文件、选区和问题面板里的诊断；问到项目结构时附带目录摘要。
- **快捷任务**：解释代码、修复问题、生成单元测试、重构、分析错误、理解项目。面板按钮和编辑器右键菜单 **AI Agent** 里都能用。

## 模型服务

只使用 OpenAI 兼容接口（`/chat/completions`、`/models`），模型需要支持工具调用（function calling）。内置以下服务商预设，选中后会自动填入地址，并按各家的差异调整请求字段：

| 服务商 | 默认地址 |
| --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi | `https://api.moonshot.cn/v1` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` |
| OpenAI | `https://api.openai.com/v1` |
| Claude（兼容层） | `https://api.anthropic.com/v1` |
| Gemini（兼容层） | `https://generativelanguage.googleapis.com/v1beta/openai` |

也可以选「自定义」，填写任意 OpenAI 兼容地址，例如自建网关或本地模型。本地模型可以不填 API Key。API Key 只保存在 VS Code SecretStorage 里，不会写入配置文件。

## 工具与安全边界

| 工具 | 作用 | 是否需要确认 |
| --- | --- | --- |
| `read` / `grep` / `find` / `ls` | 查看文件、搜索代码、列目录 | 否（仅限工作区内） |
| `edit` / `write` | 修改已有文件 / 新建或重写文件 | 是（`autoEdit` 模式下自动应用，可撤销） |
| `bash` | 运行测试、构建等命令 | 是（白名单里的命令可免确认） |
| `get_diagnostics` | 读取问题面板里的错误和警告 | 否 |
| `update_plan` | 展示多步任务的计划和进度 | 否 |

审批模式有三种：`ask` 逐项确认（默认）、`autoEdit` 自动应用文件修改、`readOnly` 只读。

- **路径限制**：工具只能访问工作区内的路径，符号链接会解析到真实路径再判断。
- **敏感文件**：`.env`、私钥、`.pem`、`.npmrc` 等文件不允许读取（`.env.example` 除外）；`.git` 目录不允许写入。
- **未保存保护**：文件在编辑器里有未保存的修改时，Agent 不会覆盖它。
- **命令分级**：高危命令（`rm -rf`、`sudo`、`git reset --hard` 等）一律拦截；只有命中白名单、且不含 shell 元字符的命令才能免确认。
- **超时与步数**：单条命令默认最长 120 秒；单次任务默认最长 600 秒、最多 40 轮推理。
- **隔离**：不读取 Pi 自身的配置和凭据，不加载项目里的 Pi 扩展。
- **撤销**：保留最近 10 次任务的快照；超过 1 MB 的文件不保存快照；`bash` 命令对文件的改动无法撤销。

## 桥接协议

扩展启动后（`onStartupFinished`）在 `127.0.0.1:<ptnAgent.bridgePort>`（默认 `8845`）上提供以下接口：

| 接口 | 说明 |
| --- | --- |
| `GET /health` | 返回 `{ ok, name, version, protocol }`，用来探测扩展是否就绪 |
| `WebSocket /ws` | 面板发请求 `{ id, type, ... }`，扩展回复 `{ type: 'reply', replyTo, data }`；Agent 过程中的事件会实时广播 |
| `POST /takeover` | 只接受同一容器内其他扩展实例发来的请求，用于新窗口接管端口（见下文） |

面板连上后先发 `hello`，扩展返回完整快照，包括状态、设置、会话列表、当前对话和正在执行的事件。其他请求类型有 `send`、`stop`、`approve`、`undo`、`newSession`、`selectSession`、`settings.*` 等，具体见 `src/agent/service.ts`。

- **来源校验**：WebSocket 握手只接受浏览器 `Origin` 与 `X-Forwarded-Host`（或 `Host`）同源的请求，防止其他网站直接连到容器操纵 Agent。
- **端口接管**：页面刷新后，code-server 会把旧窗口的扩展进程保留一段时间。新窗口启动时如果发现端口被占用，会请求旧实例让出端口，保证面板连到的是当前窗口。
- **无面板时**：没有面板连接时，审批改用 VS Code 原生对话框，任务不会卡住。

## 部署

1. 安装扩展：`code-server --install-extension sxpt-agent-<版本>.vsix`，并删除旧版本的扩展目录。
2. code-server 不能加 `--disable-proxy`，因为面板要经 `/proxy/<端口>/` 连接扩展。
3. 前面的反向代理要放行该路径的 WebSocket Upgrade，并透传带端口的 `X-Forwarded-Host`，否则握手会被来源校验拒绝（403）。
4. 容器要能访问所选的模型接口。DNS 不稳定或解析到不可达的节点时，常见现象是 `UND_ERR_CONNECT_TIMEOUT`。
5. 建议在 code-server 设置里关闭扩展自动更新（`extensions.autoUpdate: false`），避免被扩展商店里的同名扩展覆盖。

主要配置项（`ptnAgent.*`）：`approvalMode`、`baseUrl`、`model`、`contextWindow`、`maxOutputTokens`、`allowedCommands`、`commandTimeoutMs`、`runTimeoutMs`、`systemPromptExtra`、`bridgePort`。面板的设置页可以修改其中大部分。

## 开发

```bash
npm install
npm run compile
npm run check     # 策略、命令、撤销、模型、服务商、Pi 端到端、桥接、激活冒烟测试
npm run package   # 生成 VSIX（打包前会自动编译）
```

`npm run check` 里有一项会实际执行 shell 命令。Windows 上请在 Git Bash 里运行，或者确保 Git 安装在默认位置。

在 VS Code 中按 F5 可以启动扩展开发宿主调试。

### 目录

```
src/
  extension.ts           入口：创建服务、启动桥接、注册命令和右键菜单
  bridge/server.ts       桥接服务：健康检查、WebSocket、来源校验、端口接管
  agent/service.ts       Agent 服务：任务流程、审批、会话、事件广播
  agent/piAgent.ts       Pi SDK 封装：模型配置、工具拦截与审批
  agent/policy.ts        路径限制、敏感文件、编辑预览
  agent/session.ts       会话历史
  tools/commandRunner.ts 命令分级与执行
  providers.ts           服务商预设与兼容设置
  modelCheck.ts          获取模型列表、测试连接、错误提示
  settings.ts            设置读写与校验
  secrets.ts             API Key 存储
  changeTracker.ts       撤销快照
  contextCollector.ts    编辑器上下文采集
scripts/                 自检脚本（npm run check）
```

配置项沿用 `ptnAgent.*` 前缀，与旧版本兼容。
