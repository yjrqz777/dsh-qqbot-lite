/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { TUDOU_PERSONA_PRESET, type ImQQBotConfig } from '../config.ts';
import { savePluginSettings } from '../settings-store.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import { IdleEvictor } from './idle-evictor.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  SessionsService,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  CompactionServiceLike,
  CompactOutcome,
} from './types.ts';

/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

/** system-prompt section 最小结构（name/order/text） */
interface PromptSection {
  name: string;
  order: number;
  text: string;
}

/** system-prompt/assemble waterfall 的 context 最小结构 */
interface AssembleContext {
  agent?: DshAgent;
}

/** system-prompt/assemble 的组装产物最小结构 */
interface AssembledPrompt {
  sections?: PromptSection[];
  [key: string]: unknown;
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private readonly evictor: IdleEvictor;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly agents: DshAgentRegistry;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  /** 已注入人格提示词的会话 ID，避免首轮中重复组装时重复追加。 */
  private readonly personaInjectedAgents = new WeakSet<DshAgent>();
  /** 人格切换后，在该会话下一轮重新注入一次提示词。 */
  private readonly personaReapplyAgents = new WeakSet<DshAgent>();
  /** /persona new 两阶段输入状态，按 QQ 对话隔离。 */
  private readonly personaDrafts = new Map<string, { stage: 'name' | 'prompt'; name?: string }>();
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: ImQQBotConfig,
    logger: Logger,
    /** 功能级错误上报（预设挂载失败、会话创建失败），用于设置页状态区展示。 */
    private readonly onError?: (message: string) => void,
    private readonly profileDir?: string,
  ) {
    this.ctx = ctx;
    this.agents = agents;
    this.config = config;
    this.logger = logger;
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => {
        this.logger.info(`evicting idle session: key=${key}`);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
        // 回收会话时统一清理其待答问题/待批审批，避免 pending 悬挂泄漏
        this.questionChannel?.cancelPending(key);
        this.approvalChannel?.cancelPending(key);
      },
    );

    this.registerScopePromptInjection();
  }

  /**
   * 通过 system-prompt/assemble waterfall 注入群聊/私聊额外 system prompt。
   *
   * 该事件在每次 turn 构建 request 时触发；此处按会话 scope（群聊/私聊）
   * 追加对应的额外 prompt section。会话尚未建立（首次 assemble）或未配置
   * 额外 prompt 时原样返回，不做改动。
   */
  private registerScopePromptInjection(): void {
    const assemble = async (
      _assembly: unknown,
      context: AssembleContext,
      next: () => Promise<AssembledPrompt>,
    ): Promise<AssembledPrompt> => {
      const assembled = await next();
      if (!context.agent) return assembled;

      const record = this.findByAgent(context.agent);
      if (!record) return assembled;

      const personaPrompt = this.getPersonaPrompt(record.scope, record.peerId);
      const priorAssistantTurn = context.agent.session.events?.some((event: any) => event.type === 'assistant/message') === true;
      const firstConversationTurn = !priorAssistantTurn && !this.personaInjectedAgents.has(context.agent);
      const shouldReapplyPersona = this.personaReapplyAgents.has(context.agent);
      const scopePrompt = record.scope === 'group' ? this.config.groupPrompt : this.config.directPrompt;
      const additions: PromptSection[] = [];
      if (personaPrompt && (firstConversationTurn || shouldReapplyPersona)) {
        additions.push({ name: 'qqbot:persona-prompt', order: 89, text: personaPrompt });
        this.personaInjectedAgents.add(context.agent);
        this.personaReapplyAgents.delete(context.agent);
      }
      if (scopePrompt) additions.push({ name: 'qqbot:scope-prompt', order: 90, text: scopePrompt });
      if (additions.length === 0) return assembled;

      return {
        ...assembled,
        sections: [...(assembled.sections ?? []), ...additions],
      };
    };

    (this.ctx as unknown as {
      on(event: 'system-prompt/assemble', handler: typeof assemble): void;
    }).on('system-prompt/assemble', assemble);
  }

  /**
   * 动态获取 sessions 服务（fork 能力，可选）
   */
  private getSessionsService(): SessionsService | undefined {
    try {
      return this.ctx.get('sessions') as SessionsService | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
   */
  private getPresetsService(): AgentPresetsLike | undefined {
    try {
      return this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
   * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
   */
  private async resolvePersistedPreset(sessionId: string): Promise<string | undefined> {
    let persistence: { load(id: string): Promise<{ meta?: { agentPreset?: string } }> } | undefined;
    try {
      persistence = this.ctx.get('sessionPersistence') as typeof persistence | undefined;
    } catch {
      return undefined;
    }
    if (!persistence) return undefined;
    try {
      const { meta } = await persistence.load(sessionId);
      return meta?.agentPreset;
    } catch {
      return undefined;
    }
  }

  private personaKey(scope: ChatScope, peerId: string): string {
    return `${this.config.appId}:${scope}:${peerId}`;
  }

  /** 当前对话生效的人格名称；未单独设置时使用全局默认人格。 */
  getEffectivePersonaName(scope: ChatScope, peerId: string): string {
    const override = this.config.personaOverrides?.[this.personaKey(scope, peerId)];
    if (override) return override;
    const prompt = (this.config.personaPrompt ?? '').trim() || TUDOU_PERSONA_PRESET.prompt;
    return this.listPersonaPresets().find((preset) => preset.prompt === prompt)?.name ?? '默认（土豆小猫）';
  }

  listPersonaPresets(): Array<{ name: string; prompt: string }> {
    return (this.config.personaPresets ?? []).map(({ name, prompt }) => ({ name, prompt }));
  }

  private getPersonaPrompt(scope: ChatScope, peerId: string): string {
    const override = this.config.personaOverrides?.[this.personaKey(scope, peerId)];
    if (override) {
      const selected = this.config.personaPresets?.find((preset) => preset.name === override);
      if (selected) return selected.prompt.trim();
    }
    return (this.config.personaPrompt ?? '').trim() || TUDOU_PERSONA_PRESET.prompt;
  }

  private persistPersonaSettings(): void {
    savePluginSettings({
      ...this.config,
      personaPresets: [...(this.config.personaPresets ?? [])],
      personaOverrides: { ...(this.config.personaOverrides ?? {}) },
    }, this.config, this.profileDir);
  }

  /** 创建预设并应用到当前会话。保存预设不会重连机器人。 */
  createPersonaPreset(scope: ChatScope, peerId: string, name: string, prompt: string): boolean {
    const cleanName = name.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanName || !cleanPrompt || this.config.personaPresets?.some((preset) => preset.name === cleanName)) {
      return false;
    }
    this.config.personaPresets ??= [];
    this.config.personaPresets.push({ name: cleanName, prompt: cleanPrompt });
    const overrides = this.config.personaOverrides ?? {};
    overrides[this.personaKey(scope, peerId)] = cleanName;
    this.config.personaOverrides = overrides;
    this.persistPersonaSettings();
    const active = this.sessions.get(this.sessionKey(scope, peerId));
    if (active) this.personaReapplyAgents.add(active.agent);
    return true;
  }

  /** 将人格应用到指定 QQ 对话；活动会话的下一轮重新注入提示词。 */
  setPersonaOverride(scope: ChatScope, peerId: string, name: string): boolean {
    if (!this.config.personaPresets?.some((preset) => preset.name === name)) return false;
    const overrides = this.config.personaOverrides ?? {};
    overrides[this.personaKey(scope, peerId)] = name;
    this.config.personaOverrides = overrides;
    this.persistPersonaSettings();
    const active = this.sessions.get(this.sessionKey(scope, peerId));
    if (active) this.personaReapplyAgents.add(active.agent);
    return true;
  }

  /** 清除当前对话的人格覆盖，回到默认人格；下一轮重新注入默认提示词。 */
  clearPersonaOverride(scope: ChatScope, peerId: string): void {
    const overrides = this.config.personaOverrides ?? {};
    delete overrides[this.personaKey(scope, peerId)];
    this.config.personaOverrides = overrides;
    this.persistPersonaSettings();
    const active = this.sessions.get(this.sessionKey(scope, peerId));
    if (active) this.personaReapplyAgents.add(active.agent);
  }

  startPersonaCreation(scope: ChatScope, peerId: string): void {
    this.personaDrafts.set(this.sessionKey(scope, peerId), { stage: 'name' });
  }

  cancelPersonaCreation(scope: ChatScope, peerId: string): boolean {
    return this.personaDrafts.delete(this.sessionKey(scope, peerId));
  }

  /** 消费 /persona new 后的名称和提示词两条文本，不转发给 Agent。 */
  async consumePersonaCreation(scope: ChatScope, peerId: string, text: string): Promise<string | undefined> {
    const key = this.sessionKey(scope, peerId);
    const draft = this.personaDrafts.get(key);
    const value = text.trim();
    if (!draft || !value || value.startsWith('/')) return undefined;
    if (draft.stage === 'name') {
      if (value.length > 80) return '人格名称请控制在 80 个字符以内，请重新发送名称，或发送 /persona cancel 取消。';
      this.personaDrafts.set(key, { stage: 'prompt', name: value });
      return '收到名称。请发送这套人格的提示词；发送 /persona cancel 可取消。';
    }
    this.personaDrafts.delete(key);
    const created = this.createPersonaPreset(scope, peerId, draft.name ?? '', value);
    if (!created) return '创建失败：名称或提示词为空，或该人格名称已存在。请重新执行 /persona new。';
    return `✅ 已创建并应用人格「${draft.name}」。新提示词会在当前会话下一轮注入。`;
  }
  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
   */
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
  }

  /** 按 sessionKey 解析生效 preset */
  private getEffectivePresetByKey(key: string): string | undefined {
    return this.modelResolver.getPreset(key) ?? this.config.preset;
  }

  /**
   * 列出所有可用 preset（/preset 命令用）
   */
  async listPresets(): Promise<PresetEntry[]> {
    const presets = this.getPresetsService();
    if (!presets) return [];
    try {
      const list = await presets.list();
      return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
    } catch (err) {
      this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 切换模型（fork + 重建会话，保留历史）
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void> {
    const key = this.sessionKey(scope, peerId);

    this.modelResolver.setOverride(key, route);

    const record = this.sessions.get(key);
    if (!record) {
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return;
    }

    await this.rebuildSession(record, { route });
    this.logger.info(`model switched via fork: key=${key} → ${route.provider}/${route.model}`);
  }

  /**
   * 切换指定 peer 的 agent preset（per-peer 覆盖）
   *
   * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
   * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
   */
  async setPresetOverride(scope: ChatScope, peerId: string, presetId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);

    // 1. 校验 preset 存在 + 可加载（broken 拒绝）
    const presets = this.getPresetsService();
    if (!presets) return { ok: false, reason: 'unavailable' };
    let resolved: { id: string; broken?: string };
    try {
      resolved = await presets.resolve(presetId);
    } catch (err) {
      return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
    }
    if (resolved.broken !== undefined) {
      return { ok: false, reason: 'broken', message: resolved.broken };
    }

    // 2. 持久化 per-peer 覆盖（新会话生效）
    this.modelResolver.setPreset(key, presetId);

    const hasActive = this.sessions.has(key);
    this.logger.info(
      `preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`,
    );
    return { ok: true, presetId };
  }

  /**
   * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
   */
  async clearPresetOverride(scope: ChatScope, peerId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearPreset(key);
    this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
    return { ok: true };
  }

  /**
   * fork + 重建会话（保留历史，换 model）
   *
   * options.route 缺省时沿用当前生效值。preset 沿用当前生效 preset（getEffectivePresetByKey）。
   * fork 不可用或失败时降级为 dispose（下次消息重建）。
   */
  private async rebuildSession(
    record: SessionRecord,
    options: { route?: ModelRoute },
  ): Promise<void> {
    const key = record.sessionKey;

    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      this.logger.warn(`fork unavailable, fallback to dispose: key=${key}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    let seed: readonly unknown[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      this.logger.warn(`fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    const childId = SessionId(randomUUID());
    const effectiveRoute = options.route ?? this.modelResolver.getEffectiveRoute(key);
    const composed = await this.composePreset(this.getEffectivePresetByKey(key));
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: this.config.cwd || process.cwd(),
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      ...(effectiveRoute ? { agentOptions: effectiveRoute } : {}),
      ...(composed.setup ? { setup: composed.setup } : {}),
    });

    this.modelResolver.setSessionId(key, childId);

    const oldHandle = record.handle;
    record.sessionId = childId;
    record.agent = created.agent;
    record.handle = created;
    record.agentPreset = composed.agentPreset;
    record.lastActivity = Date.now();

    void oldHandle.dispose().catch(() => {});
    this.logger.info(`session rebuilt via fork: key=${key} preset=${composed.agentPreset ?? 'none'} sessionId=${childId}`);
  }

  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      lastActivity: record?.lastActivity,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const events = record?.agent.session.events;
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message' || !event.usage) continue;
      stats.input += event.usage.input ?? 0;
      stats.output += event.usage.output ?? 0;
      stats.cacheRead += event.usage.cacheRead ?? 0;
      stats.cacheWrite += event.usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = record.agent.session.events;
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  /** 上报一条功能级错误（尽力而为，上报失败无副作用）。 */
  reportError(message: string): void {
    try {
      this.onError?.(message);
    } catch {
      // 上报是最佳努力，失败不影响会话。
    }
  }

  private countMessages(record: SessionRecord | undefined): number {
    const events = record?.agent.session.events;
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) return {};

    // 没指定 preset 时**不要**走预设机制：`presets.resolve(undefined)` 会退回
    // 部署默认预设（本机是 dadu），而它带着挂载失败的 `tool-fs-search` 行——
    // 挂载抛错被降级吞掉后，agent 半初始化，turn 会在几十毫秒内结束、什么都不回。
    // 宿主组合本来就够用，人设由插件自己的 prompt 字段（directPrompt/groupPrompt）注入。
    if (presetId === undefined || presetId === '') {
      this.logger.info('im-qqbot: 未指定 preset，使用宿主组合（不挂载任何预设）');
      return {};
    }

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          // 挂载失败必须降级而不是抛出：预设里有一行起不来（缺包、版本不匹配、
          // 审计不通过）时，抛错会让整个会话创建失败，QQ 用户只会收到「处理异常」。
          // 这里退回宿主组合：会话照常可用，问题记进状态接口供设置页显示。
          try {
            await presets.mount(agentCtx, resolvedId);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`im-qqbot: preset ${resolvedId} 挂载失败，改用宿主组合: ${message}`);
            this.reportError(`预设 ${resolvedId} 挂载失败：${message}`);
          }
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // 只用配置里显式写的 preset；**不再采用会话持久化的 preset**。
      //
      // 理由：预设里只要有一行在本安装里挂载失败（例如 dadu / suqing 都带的
      // `tool-fs-search` 行），mount 就会抛错；抛错被降级吞掉后 agent 会以
      // 半初始化状态建出来——turn 在几十毫秒内就结束、什么都不回。
      // 会话持久化的 preset 用户看不见也改不掉，留着就是这种定时炸弹。
      const persistedPreset = await this.resolvePersistedPreset(sessionId);
      const presetId = this.getEffectivePresetByKey(key);
      if (persistedPreset !== undefined && persistedPreset !== presetId) {
        this.logger.warn(`im-qqbot: 忽略会话持久化的 preset=${persistedPreset}（改用 preset=${presetId ?? '(宿主组合)'}），避免挂载失败的预设让 agent 半初始化`);
      }
      const composed = await this.composePreset(presetId);
      agentPreset = composed.agentPreset;
      try {
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch {
        try {
          const created = await this.agents.create({
            sessionId,
            meta: {
              cwd: this.config.cwd || process.cwd(),
              ...(agentPreset ? { agentPreset } : {}),
            },
            ...(route ? { agentOptions: route } : {}),
            ...(composed.setup ? { setup: composed.setup } : {}),
          });
          agent = created.agent;
          handle = created;
          this.logger.info(`created new session: key=${key} preset=${agentPreset ?? 'none'}`);
        } catch (error) {
          // 预设组合有问题（某一行起不来、版本不匹配）时，绝不能挡住会话：
          // 去掉预设再建一次，退回宿主组合。半初始化状态比没有预设更糟——
          // 那样 agent 建出来了但 turn 跑不起来，QQ 端会既没回复也没报错。
          if (composed.setup === undefined) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`im-qqbot: 带预设创建会话失败，改用宿主组合重试: ${message}`);
          this.reportError(`预设 ${agentPreset ?? presetId ?? '(default)'} 不可用，已退回宿主组合：${message}`);
          const fallback = await this.agents.create({
            sessionId,
            meta: { cwd: this.config.cwd || process.cwd() },
            ...(route ? { agentOptions: route } : {}),
          });
          agent = fallback.agent;
          handle = fallback;
          agentPreset = undefined;
          this.logger.info(`created new session (host composition): key=${key}`);
        }
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.sessions.set(key, record);
    return record;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    this.modelResolver.setSessionId(key, randomUUID());

    if (!record) return;
    this.sessions.delete(key);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    this.logger.info(`session removed: key=${key}`);
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * 需通过 agentPresets.serviceFor(agent, 'compaction') 解析；未挂载时优雅降级。
   * 这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(scope: ChatScope, peerId: string): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return { ok: false, reason: 'no-session' };
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };

    let compaction: CompactionServiceLike | undefined;
    try {
      const presets = this.getPresetsService();
      compaction = (presets?.serviceFor(record.agent, 'compaction') ?? this.ctx.get('compaction')) as CompactionServiceLike | undefined;
    } catch {
      compaction = undefined;
    }
    if (!compaction) return { ok: false, reason: 'unavailable' };

    const route = this.modelResolver.getEffectiveRoute(key);
    const agentCtx = {
      session: record.agent.session,
      options: { provider: route?.provider, model: route?.model },
      runMaintenance: record.agent.runMaintenance.bind(record.agent),
    };

    try {
      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    }
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
