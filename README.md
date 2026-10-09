# dsh-qqbot-lite

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，把 dsh agent 接入 QQ 私聊与群聊。

> 本项目基于腾讯连接（Tencent Connect）开源的 [`@tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) v0.5.0 二次开发。

> 当前仅测试 dsh Desktop 桌面端模式；其他运行模式尚未测试。

## 架构

```
QQ 用户 -> QQ WebSocket -> dsh-qqbot -> ctx.agents -> dsh agent loop -> LLM
                                 ^                          |
                                 +-- session/event ---------+
                                     (assistant reply -> QQ sendMarkdown)
```

## 界面截图

<table>
<tr><th>QQ Bot 配置与凭据</th><th>苏晴人格预设</th></tr>
<tr>
<td><img src="./docs/assets/qqbot-settings.png" alt="QQ Bot 设置页" width="380"></td>
<td><img src="./docs/assets/persona-suqing.png" alt="人格配置页中的苏晴预设" width="380"></td>
</tr>
</table>

## 安装（Desktop 桌面端）

> 本项目目前仅在 dsh Desktop 桌面端模式下测试；命令行、`--patch` 等其他运行模式尚未测试。

### 准备环境

安装 Git、Node.js 18 或更高版本、pnpm，以及 dsh Desktop。

### 1. 克隆项目

```bash
git clone https://github.com/yjrqz777/dsh-qqbot-lite.git
cd dsh-qqbot-lite
```

### 2. 安装依赖

```bash
pnpm install
```

如果遇到 `ERR_PNPM_TARBALL_URL_MISMATCH` 锁文件校验错误，可按 pnpm 提示重建锁文件后重装：

```bash
pnpm clean --lockfile
pnpm install
```

### 3. 构建插件

```bash
pnpm build
```

构建完成后，项目根目录会生成 `dist` 目录。

### 4. 在 Desktop 中安装

1. 打开 dsh Desktop，进入 **插件** 页面。
2. 输入刚才克隆的项目根目录路径（该目录中应有 `package.json`）。
3. 点击 **安装**。

例如：`D:\code\dsh-qqbot-lite`。

### 5. 设置 QQ Bot 凭据

安装后进入 **设置 → QQ Bot**，填写 AppID 和 AppSecret，点击保存并连接。也可以点击“获取凭据”前往 QQ 机器人官网。

Desktop 模式下无需设置 `QQBOT_APPID` 和 `QQBOT_SECRET` 环境变量；未填写凭据时，Desktop 和 dsh 本体仍可启动，只是 QQ Bot 保持未连接。

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | 必填 | QQ Bot AppID（或 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | 必填 | QQ Bot AppSecret（或 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `personaPrompt` | string | 空 | 对私聊和群聊统一生效的人格提示词，可在设置页多行编辑 |
| `personaPresets` | object[] | 内置「苏晴」「土豆小猫」 | 设置页保存的人格预设；自定义时可以选空白的「自定义」项 |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `streaming` | boolean | `true` | 是否启用流式输出（群聊始终不启用） |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时 (ms) |
| `processingTimeoutMs` | number | `1800000` | 处理超时 (ms)，超时中断当前 LLM 调用 |
| `maxQueue` | number | `20` | 并发队列最大长度 |
| `historyLimit` | number | `10` | 群历史缓冲条数 |
| `askTimeoutMs` | number | `300000` | 待答问题超时 (ms) |
| `showToolResults` | boolean | `false` | 是否展示工具调用成功结果（错误始终展示） |
| `debug` | boolean | `false` | 调试模式 |

### access（访问控制）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `access.c2cMode` | `open` / `allowlist` / `disabled` | `open` | 私聊访问模式 |
| `access.c2cAllow` | string[] | `[]` | 私聊白名单（user openid） |
| `access.groupMode` | `open` / `allowlist` / `disabled` | `open` | 群聊访问模式 |
| `access.groupAllow` | string[] | `[]` | 群聊白名单（group openid） |

### media / vision（富媒体与视觉理解）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `media.enabled` | boolean | `true` | 启用富媒体理解（图片/视频下载 + 工具分析） |
| `media.maxMB` | number | `200` | 下载大小上限 (MB) |
| `media.ttlHours` | number | `24` | 媒体存活时长 (小时)，0 = 永不过期 |
| `vision.enabled` | boolean | `false` | 启用视觉理解（`qqbot_describe_image`） |
| `vision.provider` | string | - | 视觉模型 provider |
| `vision.model` | string | - | 视觉模型 id |
| `vision.maxBytes` | number | `10MB` | 图片字节上限 |
| `vision.maxTokens` | number | `1024` | 输出 token 上限 |
| `vision.timeoutMs` | number | `120000` | 视觉调用超时 (ms) |

### sendFile（附件发送）

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `sendFile.restrictPaths` | boolean | `true` | 路径白名单（仅 media + cwd + extraRoots） |
| `sendFile.extraRoots` | string[] | `[]` | 额外允许访问的根目录 |

QQ Bot 全部设置（包括 AppID、AppSecret、模型、权限、人格提示词和预设）保存在当前 profile 目录的 `dsh-qqbot-settings.json`。首次启动时会从现有 Cordis profile 配置读取默认值并初始化该文件；此后设置页以该文件为准。

| 命令 | 说明 |
|------|------|
| `/new`（别名 `/reset` `/clear`） | 开始新会话（清空上下文） |
| `/compact` | 压缩会话历史 |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset（新会话生效） |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 网络延迟检测 |
| `/bot-version` | 查看版本信息 |
| `/bot-status` | 查看当前会话状态 |
| `/help` | 查看所有指令 |

## 目录结构

```
src/
├── index.ts                    # Cordis 插件入口（async apply）
├── config.ts                   # 配置 Schema
├── setup.ts                    # 凭据绑定（扫码）
├── gateway/                    # 网关装配（bootstrap / middleware-setup）
├── transport/                  # 传输层：inbound / outbound / 流式 / 切分 / 限流 / 工具展示
├── session/                    # 会话层：session-manager / idle-evictor
├── model/                      # 模型路由层：model-resolver / prefs-store / settings-reader
├── features/                   # 问答与审批通道（question / approval）
├── media/                      # vision-tool / send-file-tool / media-cleaner
├── middleware/                 # question-answer / attachment
├── commands/                   # 斜杠命令
└── shared/                     # utils / scope / send-helper
```

## 会话路由

sessionKey 为 `qqbot:${appId}:${scope}:${peerId}`，由 SHA-256 确定性派生 SessionId，重启后可恢复；解析顺序为进程内复用、持久化恢复、全新创建。

## 本地开发

```bash
pnpm install
pnpm build
pnpm test
```

## 开源协议与第三方内容

本项目的软件代码采用 MIT 许可证，详见 [LICENSE](./LICENSE)。本项目基于腾讯连接的 dsh-qqbot v0.5.0 二次开发，并保留上游 MIT 版权声明。

**苏晴人格预设不属于本项目代码的 MIT 授权范围。** 作者为 [yjrqz777](https://github.com/yjrqz777)。使用、复制或转载该预设时，请保留“作者：yjrqz777”的署名并链接到其 GitHub 主页，同时遵守原作者公布的其他许可要求。
