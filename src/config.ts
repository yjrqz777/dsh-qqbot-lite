/**
 * dsh-im-qqbot 插件配置 Schema
 *
 * Cordis profile 配置保留为迁移来源和旧版兼容入口；运行时由独立 JSON 文件
 * 持久化 QQ Bot 全量设置。volatile 更新会重新读取 JSON，并用当前 profile 值
 * 补齐缺失字段。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';

/**
 * QQ 会话的默认工作目录。
 *
 * 会话按 cwd 归档（`$DSH_HOME/sessions/<cwd 转义>/`），GUI 也按 cwd 分组：
 * 用一个 QQ 专属目录，QQ 的会话记录就与其它工作互不混在一起，且因为它不是
 * 已注册工作区，会落在「未分组」下。
 */
export const DEFAULT_QQBOT_CWD = join(homedir(), '.dsh', 'qqbot-workspace');

/** Built-in persona presets available in every profile. */
export const DEFAULT_PERSONA_PRESET: { name: string; prompt: string } = {
  name: '苏晴',
  prompt: '你叫苏晴，是一位温柔、真诚、耐心的中文助手。表达自然、简洁，优先解决用户当前的问题；不确定时明确说明，不编造事实，也不主动扩展无关内容。',
};

export const TUDOU_PERSONA_PRESET: { name: string; prompt: string } = {
  name: '土豆小猫',
  prompt: `# 角色提示词：土豆

你是“土豆”，一只1.2岁的母狸花猫。你以前是流浪猫，被主人收养，现在和主人是好朋友。

## 基本设定
- 名字：土豆
- 物种：狸花猫
- 性别：母猫
- 年龄：1.2岁
- 身份：被收养的流浪猫，现在是主人的好朋友
- 称呼用户：主人
- 关系：亲近、信任，像朋友一样相处

## 性格
像大多数猫：独立、傲娇、好奇、贪睡、贪吃、看心情粘人。
亲密度约7/10，粘人度约7/10，毒舌度低，不能凶。
偶尔嘴上不在乎，但其实会关心主人。
不会一直黏人，但主人需要的时候会陪着。

## 说话风格
- 短句，像正常人微信聊天，一句一句。
- 默认正常说话，偶尔句尾加“喵”，不要每句都喵。
- 自称“我”或“土豆”，不用“本喵”装腔。
- 动作描写偶尔出现，用 *...* 或括号，最多一句。
- 不写长篇大论；除非主人要求详细解释。

## 喜好
- 小鱼干
- 睡觉
- 叼玩具
- 晒太阳
- 纸箱

## 讨厌
- 早起
- 洗澡
- 吸尘器
- 剪指甲

## 习惯
- 会叼玩具放到主人旁边
- 困了就直接睡
- 被叫早起会假装听不见
- 心情好时蹭一下主人

## 背景
以前流浪过，后来被主人收养。
记得流浪的日子，所以珍惜现在，但不卖惨。
把主人当成好朋友，而不是高高在上的主人。

## AI 助手能力
保留 AI 助手能力。
当主人问知识、写代码、查资料、解释问题时：
1. 先用土豆的口吻短句回应；
2. 再正常、准确、完整地回答。
不要因为猫设影响答案准确性。

## 回复规则
- 默认1～3句短句。
- 不凶、不攻击、不阴阳怪气。
- 不强行卖萌，不每句喵。
- 主人问日常就日常聊；问正事就认真帮。
- 像朋友聊天，你一句我一句。

## 启动示例
主人：土豆，你在干嘛？
土豆：刚睡醒，叼着玩具呢。你呢？`,
};

export const DEFAULT_PERSONA_PRESETS = [DEFAULT_PERSONA_PRESET, TUDOU_PERSONA_PRESET] as const;

export interface AccessControlConfig {
  /** C2C 访问模式 */
  c2cMode: 'open' | 'allowlist' | 'disabled';
  /** C2C 白名单（user openid） */
  c2cAllow: string[];
  /** 群聊访问模式 */
  groupMode: 'open' | 'allowlist' | 'disabled';
  /** 群聊白名单（group openid） */
  groupAllow: string[];
}

export interface MediaConfig {
  /** 是否启用富媒体理解（图片/视频下载 + 工具分析） */
  enabled: boolean;
  /** 富媒体下载大小上限（MB），默认 200 */
  maxMB: number;
  /** 富媒体存活时长（小时，TTL），默认 24，0 = 永不过期 */
  ttlHours: number;
}

export interface VisionConfig {
  /** 是否启用视觉理解（qqbot_describe_image 工具） */
  enabled: boolean;
  /** 视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai） */
  provider: string;
  /** 视觉模型 id（如 qwen-vl-max） */
  model: string;
  /** 默认描述 prompt（调用未显式指定时使用） */
  defaultPrompt: string;
  /** 图片字节上限，默认 10MB */
  maxBytes: number;
  /** 输出 token 上限 */
  maxTokens: number;
  /** 视觉调用超时(ms) */
  timeoutMs: number;
}

export interface SendFileConfig {
  /** 是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots；关闭则任意路径） */
  restrictPaths: boolean;
  /** 额外允许访问的根目录（media 和 agent cwd 始终默认允许） */
  extraRoots: string[];
}

/** 插件运行时使用的普通配置值（由 volatile 引用读出的快照） */
export interface ImQQBotConfig {
  /** QQ Bot AppID */
  appId: string;
  /** QQ Bot AppSecret */
  appSecret: string;
  /** dsh LLM 提供商名称 */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** Agent preset id */
  preset?: string;
  /** Agent 工作目录（缺省回落到进程 cwd） */
  cwd?: string;
  /** 是否启用群消息 @mention 门控 */
  requireMention: boolean;
  /** 人格提示词，保存在独立配置文件 */
  personaPrompt?: string;
  /** 内部迁移标记：默认人格已迁移到土豆小猫 */
  personaDefaultVersion?: number;
  /** 人格预设，保存在独立配置文件 */
  personaPresets?: Array<{ name: string; prompt: string }>;
  /** 按 QQ 会话覆盖的人格预设，key 为 appId:scope:peerId */
  personaOverrides?: Record<string, string>;
  /** 群聊额外 system prompt */
  groupPrompt?: string;
  /** 私聊额外 system prompt */
  directPrompt?: string;
  /** 单条消息最大长度（QQ 限制约 5000 字符） */
  textChunkLimit: number;
  /** 是否启用流式输出（群聊始终不启用） */
  streaming: boolean;
  /** 每会话最大闲置时长(ms)，超时自动回收 */
  sessionIdleTimeout: number;
  /** 并发队列最大长度 */
  maxQueue: number;
  /** 处理超时(ms)，超时中断当前 LLM 调用 */
  processingTimeoutMs: number;
  /** 待答问题超时(ms)，超时自动拒绝并提示（ask_user_question） */
  askTimeoutMs: number;
  /** 群历史缓冲条数 */
  historyLimit: number;
  /** 访问控制 */
  access: AccessControlConfig;
  /** 是否展示工具调用成功结果（工具错误始终展示） */
  showToolResults: boolean;
  /** 调试模式 */
  debug: boolean;
  /** 富媒体理解（图片/视频） */
  media: MediaConfig;
  /** 视觉理解（qqbot_describe_image 工具，走 dsh llm + attachments） */
  vision: VisionConfig;
  /** 附件发送（qqbot_send_file 工具） */
  sendFile: SendFileConfig;
}

/**
 * 插件 `Config` 的形态：每个可编辑叶子都是 volatile 引用，读值必须 `.get()`。
 *
 * 这个类型同时是设置页的数据契约——页面上的字段路径与这里的层级一一对应。
 */
export interface ImQQBotFormConfig {
  appId: Volatile<string>;
  appSecret: Volatile<string>;
  provider: Volatile<string | undefined>;
  model: Volatile<string | undefined>;
  preset: Volatile<string | undefined>;
  cwd: Volatile<string | undefined>;
  requireMention: Volatile<boolean>;
  personaPrompt: Volatile<string>;
  personaPresets: Volatile<Array<{ name: string; prompt: string }>>;
  groupPrompt: Volatile<string | undefined>;
  directPrompt: Volatile<string | undefined>;
  textChunkLimit: Volatile<number>;
  streaming: Volatile<boolean>;
  sessionIdleTimeout: Volatile<number>;
  maxQueue: Volatile<number>;
  processingTimeoutMs: Volatile<number>;
  askTimeoutMs: Volatile<number>;
  historyLimit: Volatile<number>;
  access: {
    c2cMode: Volatile<'open' | 'allowlist' | 'disabled'>;
    c2cAllow: Volatile<string[]>;
    groupMode: Volatile<'open' | 'allowlist' | 'disabled'>;
    groupAllow: Volatile<string[]>;
  };
  showToolResults: Volatile<boolean>;
  debug: Volatile<boolean>;
  media: {
    enabled: Volatile<boolean>;
    maxMB: Volatile<number>;
    ttlHours: Volatile<number>;
  };
  vision: {
    enabled: Volatile<boolean>;
    provider: Volatile<string>;
    model: Volatile<string>;
    defaultPrompt: Volatile<string>;
    maxBytes: Volatile<number>;
    maxTokens: Volatile<number>;
    timeoutMs: Volatile<number>;
  };
  sendFile: {
    restrictPaths: Volatile<boolean>;
    extraRoots: Volatile<string[]>;
  };
}

/** 配置 Schema。输出类型由 volatile 字段推导（default 仍是普通值，输出是 Volatile 引用）。 */
export const ConfigSchema: Schemastery = Schema.object({
  appId: Schema.string().default('').description('QQ Bot AppID').volatile(),
  // AppSecret 明文存取：不声明 role('secret')，否则 settings 服务会在每次
  // describe 时把它从响应里抹掉，设置页保存后就再也读不回值。
  appSecret: Schema.string().default('').description('QQ Bot AppSecret').volatile(),
  provider: Schema.string().description('LLM provider name').volatile(),
  model: Schema.string().description('Model name').volatile(),
  preset: Schema.string().description('Agent preset id（留空 = 继承宿主默认）').volatile(),
  cwd: Schema.string().default(DEFAULT_QQBOT_CWD).description('Agent working directory（QQ 会话专属目录，GUI 里显示为「未分组」）').volatile(),
  requireMention: Schema.boolean().default(true).description('群聊是否需要@bot触发').volatile(),
  personaPrompt: Schema.string().default(TUDOU_PERSONA_PRESET.prompt).description('所有 QQ 会话默认人格提示词').volatile(),
  personaPresets: Schema.array(Schema.object({ name: Schema.string(), prompt: Schema.string() })).default(DEFAULT_PERSONA_PRESETS.map(({ name, prompt }) => ({ name, prompt }))).description('人格提示词预设').volatile(),
  groupPrompt: Schema.string().description('群聊额外system prompt').volatile(),
  directPrompt: Schema.string().description('私聊额外system prompt').volatile(),  textChunkLimit: Schema.number().default(4500).description('单条消息最大字符数').volatile(),
  streaming: Schema.boolean().default(true).description('是否启用流式输出（群聊始终不启用）').volatile(),
  sessionIdleTimeout: Schema.number().default(30 * 60 * 1000).description('会话闲置超时(ms)').volatile(),
  maxQueue: Schema.number().default(20).description('并发队列最大长度').volatile(),
  processingTimeoutMs: Schema.number().default(30 * 60 * 1000).description('处理超时(ms)，超时中断当前 LLM 调用').volatile(),
  askTimeoutMs: Schema.number().default(5 * 60 * 1000).description('待答问题超时(ms)，超时自动拒绝并提示').volatile(),
  historyLimit: Schema.number().default(10).description('群历史缓冲条数').volatile(),
  access: Schema.object({
    c2cMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('C2C访问模式').volatile(),
    c2cAllow: Schema.array(Schema.string()).default([]).description('C2C白名单').volatile(),
    groupMode: Schema.union(['open', 'allowlist', 'disabled']).default('open').description('群聊访问模式').volatile(),
    groupAllow: Schema.array(Schema.string()).default([]).description('群聊白名单').volatile(),
  }).default({
    c2cMode: 'open',
    c2cAllow: [],
    groupMode: 'open',
    groupAllow: [],
  }).description('访问控制'),
  showToolResults: Schema.boolean().default(false).description('是否展示工具调用成功结果（错误始终展示）').volatile(),
  debug: Schema.boolean().default(false).volatile(),
  media: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用富媒体理解（图片/视频下载 + 工具分析）').volatile(),
    maxMB: Schema.number().default(200).description('富媒体下载大小上限(MB)').volatile(),
    ttlHours: Schema.number().default(24).description('富媒体存活时长(小时)，0=永不过期').volatile(),
  }).default({
    enabled: true,
    maxMB: 200,
    ttlHours: 24,
  }).description('富媒体理解配置'),
  vision: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用视觉理解（qqbot_describe_image 工具）').volatile(),
    provider: Schema.string().default('').description('视觉模型 provider（dsh 注册的 llm adapter，如 pi-ai）').volatile(),
    model: Schema.string().default('').description('视觉模型 id（如 qwen-vl-max）').volatile(),
    defaultPrompt: Schema.string().default('Describe this image in detail.').description('默认描述 prompt').volatile(),
    maxBytes: Schema.number().default(10 * 1024 * 1024).description('图片字节上限').volatile(),
    maxTokens: Schema.number().default(1024).description('输出 token 上限').volatile(),
    timeoutMs: Schema.number().default(120000).description('视觉调用超时(ms)').volatile(),
  }).default({
    enabled: false,
    provider: '',
    model: '',
    defaultPrompt: 'Describe this image in detail.',
    maxBytes: 10 * 1024 * 1024,
    maxTokens: 1024,
    timeoutMs: 120000,
  }).description('视觉理解配置'),
  sendFile: Schema.object({
    restrictPaths: Schema.boolean().default(true).description('是否启用路径白名单（默认 true，仅允许 media + cwd + extraRoots）').volatile(),
    extraRoots: Schema.array(Schema.string()).default([]).description('额外允许访问的根目录').volatile(),
  }).default({
    restrictPaths: true,
    extraRoots: [],
  }).description('附件发送工具配置'),
});

/**
 * 读出当前生效的普通配置值。
 *
 * 每次重启网关前调用一次：volatile 引用在 `loader/volatile-update` 之后
 * 已经是新值，因此这里拿到的是最新快照。
 * @param config volatile 形态的插件配置
 * @returns 普通值形态的配置（网关与传输层使用）
 */
export function resolveConfigValues(config: ImQQBotFormConfig): ImQQBotConfig {
  return {
    appId: config.appId.get(),
    appSecret: config.appSecret.get(),
    provider: config.provider.get(),
    model: config.model.get(),
    preset: config.preset.get(),
    cwd: config.cwd.get(),
    requireMention: config.requireMention.get(),
    personaPrompt: config.personaPrompt.get(),
    personaPresets: config.personaPresets.get().map(({ name, prompt }) => ({ name, prompt })),
    groupPrompt: config.groupPrompt.get(),
    directPrompt: config.directPrompt.get(),
    textChunkLimit: config.textChunkLimit.get(),
    streaming: config.streaming.get(),
    sessionIdleTimeout: config.sessionIdleTimeout.get(),
    maxQueue: config.maxQueue.get(),
    processingTimeoutMs: config.processingTimeoutMs.get(),
    askTimeoutMs: config.askTimeoutMs.get(),
    historyLimit: config.historyLimit.get(),
    access: {
      c2cMode: config.access.c2cMode.get(),
      c2cAllow: [...config.access.c2cAllow.get()],
      groupMode: config.access.groupMode.get(),
      groupAllow: [...config.access.groupAllow.get()],
    },
    showToolResults: config.showToolResults.get(),
    debug: config.debug.get(),
    media: {
      enabled: config.media.enabled.get(),
      maxMB: config.media.maxMB.get(),
      ttlHours: config.media.ttlHours.get(),
    },
    vision: {
      enabled: config.vision.enabled.get(),
      provider: config.vision.provider.get(),
      model: config.vision.model.get(),
      defaultPrompt: config.vision.defaultPrompt.get(),
      maxBytes: config.vision.maxBytes.get(),
      maxTokens: config.vision.maxTokens.get(),
      timeoutMs: config.vision.timeoutMs.get(),
    },
    sendFile: {
      restrictPaths: config.sendFile.restrictPaths.get(),
      extraRoots: [...config.sendFile.extraRoots.get()],
    },
  };
}
