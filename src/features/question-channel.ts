/**
 * QuestionChannel — 把 dsh 的 ask_user_question 桥接到 QQ 通道。
 *
 * 接入方式：包装 `userQuestions.ask`（而非 registerProvider），按 `request.agent.id`
 * 路由到 QQ 会话；非 QQ 会话委托宿主默认 provider（如 Web 弹出框），多通道共存。
 *
 * 每会话一个显式状态机，三态语义：
 *   - 待答（pending 中）：等待当前题的回答
 *   - 逐题推进：多问题时一次问一题，答完一题再问下一题
 *   - 完成 / 中断（abort / 超时 / 会话回收）：reject(ASK_ABORTED)
 */
import type { InlineKeyboard, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { DshAgent } from '../session/index.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { parseAnswer } from './answer-parser.ts';
import { buildKeyboard, formatQuestion } from './question-renderer.ts';
import { decodeButtonData } from './button-utils.ts';

// ── 最小契约（对齐 dsh-user-questions，避免硬依赖） ──

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  header?: string;
  question: string;
  options?: UserQuestionOption[];
  multiSelect?: boolean;
}

export interface UserQuestionAnswer {
  id: string;
  selected: string[];
  custom?: string;
}

export interface UserQuestionRequest {
  questions: UserQuestion[];
  agent?: { id?: string };
  signal?: AbortSignal;
}

export interface UserQuestionResult {
  answers: UserQuestionAnswer[];
}

export interface UserQuestionsServiceLike {
  ask: (request: UserQuestionRequest) => Promise<UserQuestionResult>;
  __qqQuestionPatched?: boolean;
}

// ── 依赖接口（结构化，便于单测） ──

export interface QuestionSessionRecordLike {
  sessionKey: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
}

export interface QuestionChannelManagerLike {
  findBySessionId(sessionId: string): QuestionSessionRecordLike | undefined;
  getSessionRecord(scope: ChatScope, peerId: string): QuestionSessionRecordLike | undefined;
  findByAgent?(agent: DshAgent): QuestionSessionRecordLike | undefined;
}

export interface QuestionChannelSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: InlineKeyboard }): Promise<unknown>;
}

interface ToolsRegistryLike {
  register(definition: unknown): unknown;
}

interface AskUserToolArgs {
  question: string;
  options: string[];
}

export const ASK_USER_TOOL_NAME = 'qqbot_ask_user';

export interface QuestionChannelConfigLike {
  requireMention: boolean;
  askTimeoutMs: number;
}

// ── 错误语义（对齐 dsh-user-questions 的 UserQuestionError code 约定） ──

/** 问答中断错误码：上层（如 plan-mode）按 code 区分「用户未作答」与普通发送/网络错误 */
const ASK_ABORTED = 'ASK_ABORTED';

class QuestionChannelError extends Error {
  public readonly code: string;

  public constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = 'QuestionChannelError';
  }
}

// ── 每会话状态机 ──

interface PendingEntry {
  record: QuestionSessionRecordLike;
  request: UserQuestionRequest;
  resolve: (result: UserQuestionResult) => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  /** 当前正在问的问题在 request.questions 的下标 */
  index: number;
  /** 已收集的答案 */
  collected: UserQuestionAnswer[];
}

export class QuestionChannel {
  private readonly pending = new Map<string, PendingEntry>();
  private uq?: UserQuestionsServiceLike;
  private origAsk?: UserQuestionsServiceLike['ask'];
  private askToolRegistered = false;
  private readonly manager: QuestionChannelManagerLike;
  private readonly sender: QuestionChannelSenderLike;
  private readonly config: QuestionChannelConfigLike;
  private readonly logger: Logger;

  public constructor(
    manager: QuestionChannelManagerLike,
    sender: QuestionChannelSenderLike,
    config: QuestionChannelConfigLike,
    logger: Logger,
  ) {
    this.manager = manager;
    this.sender = sender;
    this.config = config;
    this.logger = logger;
  }

  /**
   * 包装 userQuestions.ask：QQ 会话走 QQ 通道，其余委托原实现。
   * 幂等（已 patch 则跳过）；服务缺失或 ask 非函数时优雅禁用。
   */
  public install(ctx: { get(name: string): unknown }): void {
    this.registerAskTool(ctx);

    const uq = ctx.get('userQuestions') as UserQuestionsServiceLike | undefined;
    if (!uq || uq.__qqQuestionPatched) return;
    if (typeof uq.ask !== 'function') {
      this.logger.warn('im-qqbot: userQuestions service lacks ask() — host question bridge disabled; qqbot_ask_user remains available');
      return;
    }

    const self = this;
    this.origAsk = uq.ask.bind(uq);
    uq.ask = async function qqRoutedAsk(request: UserQuestionRequest): Promise<UserQuestionResult> {
      const sessionId = request?.agent?.id;
      const record = sessionId ? self.manager.findBySessionId(sessionId) : undefined;
      if (record) return self.askViaQQ(record, request);
      return self.origAsk!(request);
    };
    Object.defineProperty(uq, '__qqQuestionPatched', { value: true, configurable: true, enumerable: false });
    this.uq = uq;
    this.logger.info('im-qqbot: QQ question channel installed');
  }

  /** 注册模型可直接调用的单选提问工具；不依赖宿主是否提供 userQuestions.ask。 */
  private registerAskTool(ctx: { get(name: string): unknown }): void {
    if (this.askToolRegistered) return;

    const tools = ctx.get('tools') as ToolsRegistryLike | undefined;
    if (!tools?.register) {
      this.logger.warn('im-qqbot: tools 服务不可用，qqbot_ask_user 工具未注册');
      return;
    }

    const self = this;
    tools.register({
      name: ASK_USER_TOOL_NAME,
      description: 'Ask the user in the current QQ conversation to choose one option. It sends clickable buttons and waits for the user to click or reply with an option. Use only when a decision or clarification is needed; never guess the user’s choice.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'A short question for the user.' },
          options: {
            type: 'array',
            description: 'Two to eight concise single-choice options.',
            minItems: 2,
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        required: ['question', 'options'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { selected: { type: 'string' } },
          required: ['selected'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: unknown): ContentBlock[] => [
          { type: 'text', text: `用户选择了：${(value as { selected: string }).selected}` },
        ],
      },
      async execute(args: unknown, exec: { signal: AbortSignal; agent?: unknown }): Promise<Record<string, unknown>> {
        const input = args as AskUserToolArgs;
        const question = typeof input?.question === 'string' ? input.question.trim() : '';
        const options = Array.isArray(input?.options)
          ? input.options.filter((option): option is string => typeof option === 'string').map(option => option.trim())
          : [];
        if (!question) throw new Error('qqbot_ask_user: question must be a non-empty string');
        if (options.length < 2 || options.length > 8 || options.some(option => !option)) {
          throw new Error('qqbot_ask_user: provide 2 to 8 non-empty options');
        }

        const agent = exec.agent as DshAgent | undefined;
        const record = agent ? self.manager.findByAgent?.(agent) : undefined;
        if (!record) {
          throw new Error('qqbot_ask_user: cannot find the current QQ conversation');
        }

        const result = await self.askViaQQ(record, {
          questions: [{
            id: randomUUID(),
            question,
            options: options.map(label => ({ label })),
          }],
          ...(agent ? { agent: { id: agent.id } } : {}),
          signal: exec.signal,
        });
        const answer = result.answers[0];
        return { selected: answer?.selected[0] ?? answer?.custom ?? '' };
      },
    });

    this.askToolRegistered = true;
    this.logger.info('im-qqbot: qqbot_ask_user tool registered');
  }

  public uninstall(): void {
    if (this.uq && this.origAsk) {
      this.uq.ask = this.origAsk;
      delete this.uq.__qqQuestionPatched;
      this.uq = undefined;
      this.origAsk = undefined;
    }
    for (const [, entry] of this.pending) {
      this.clearTimer(entry);
      this.removeAbort(entry);
      entry.reject(new QuestionChannelError('QQ question channel was unloaded before the user answered', ASK_ABORTED));
    }
    this.pending.clear();
  }

  /** 会话回收时清理其待答问题，避免 pending 悬挂导致 Promise 与闭包泄漏 */
  public cancelPending(sessionKey: string): void {
    const entry = this.pending.get(sessionKey);
    if (!entry) return;
    this.pending.delete(sessionKey);
    this.clearTimer(entry);
    this.removeAbort(entry);
    entry.reject(new QuestionChannelError('ask_user_question was cancelled before the user answered', ASK_ABORTED));
  }

  /** 入站文本作答：该会话若有待答问题且本条消息有文本，解析为答案并推进 */
  public tryAnswer(scope: ChatScope, peerId: string, text: string): boolean {
    const record = this.manager.getSessionRecord(scope, peerId);
    if (!record) return false;
    const key = record.sessionKey;
    const entry = this.pending.get(key);
    if (!entry) return false;
    if (!text) return false; // 纯图片/表情等：继续等待，消息走常规流程

    const current = entry.request.questions[entry.index];
    if (!current) return false;
    const answer = parseAnswer(current, text);
    this.advance(entry, key, answer);
    return true;
  }

  /** 按钮点击作答：解码 button_data 选项下标，推进状态机 */
  public handleInteraction(event: InteractionEvent): boolean {
    const peerId = event.group_openid ?? event.user_openid;
    if (!peerId) return false;
    const scope: ChatScope = event.group_openid ? 'group' : 'c2c';
    const record = this.manager.getSessionRecord(scope, peerId);
    if (!record) return false;
    const entry = this.pending.get(record.sessionKey);
    if (!entry) return false;

    const data = event.data?.resolved?.button_data;
    if (!data) return false;
    const button = decodeButtonData(data);
    if (!button || button.t !== 'question') return false;
    const current = entry.request.questions[entry.index];
    if (!current) return false;
    // 校验按钮归属题：旧题按钮在新题推进后被点击（误点/延迟事件），
    // 其 q 不等于当前题 id，直接忽略，避免错位映射到当前题选项。
    if (button.q !== current.id) return false;
    const idx = button.i;
    const opts = current.options ?? [];
    if (idx < 0 || idx >= opts.length) return false;

    this.advance(entry, record.sessionKey, { id: current.id, selected: [opts[idx]!.label] });
    return true;
  }

  /** 走 QQ 通道：发送首题 + 挂起 Promise，等待逐题作答 */
  private async askViaQQ(record: QuestionSessionRecordLike, request: UserQuestionRequest): Promise<UserQuestionResult> {
    const key = record.sessionKey;
    // 会话回收/取消可能在发送前发生：signal 已 abort 则直接失败，避免悬挂
    if (request.signal?.aborted) {
      throw new QuestionChannelError('ask_user_question was aborted before delivery', ASK_ABORTED);
    }
    // 同会话已有待答问题（理论上不会发生：回合阻塞在第一个问题上）→ 拒绝旧的
    const prev = this.pending.get(key);
    if (prev) {
      this.pending.delete(key);
      this.clearTimer(prev);
      this.removeAbort(prev);
      prev.reject(new QuestionChannelError('superseded by a new question', ASK_ABORTED));
    }

    const first = request.questions[0];
    if (!first) throw new Error('ask_user_question with empty questions');

    return new Promise<UserQuestionResult>((resolve, reject) => {
      const entry: PendingEntry = { record, request, resolve, reject, index: 0, collected: [] };
      if (request.signal) {
        const onAbort = (): void => {
          if (this.pending.get(key) !== entry) return;
          this.pending.delete(key);
          this.clearTimer(entry);
          reject(new QuestionChannelError('ask_user_question was aborted before the user answered', ASK_ABORTED));
        };
        entry.onAbort = onAbort;
        request.signal.addEventListener('abort', onAbort, { once: true });
      }
      entry.timer = setTimeout(() => this.onTimeout(key), this.config.askTimeoutMs);
      // Install pending state before sending so a fast button click cannot race registration.
      this.pending.set(key, entry);
      this.logger.info(`im-qqbot: question sent to QQ, waiting for answer key=${key}`);
      void this.sendQuestion(record, first).catch((err) => {
        if (this.pending.get(key) !== entry) return;
        this.pending.delete(key);
        this.clearTimer(entry);
        this.removeAbort(entry);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** 推进状态机：收集答案 → 有下一题则发送，否则 resolve 全部答案 */
  private advance(entry: PendingEntry, key: string, answer: UserQuestionAnswer): void {
    entry.collected.push(answer);
    entry.index += 1;

    if (entry.index < entry.request.questions.length) {
      const next = entry.request.questions[entry.index]!;
      this.resetTimer(entry, key);
      void this.sendQuestion(entry.record, next).catch((err) => {
        this.pending.delete(key);
        this.clearTimer(entry);
        this.removeAbort(entry);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      });
      return;
    }

    this.pending.delete(key);
    this.clearTimer(entry);
    this.removeAbort(entry);
    this.logger.info(`im-qqbot: question answered via QQ key=${key}`);
    entry.resolve({ answers: entry.collected });
  }

  /** 发送单个问题：优先带按钮，按钮发送失败降级纯文本 */
  private async sendQuestion(record: QuestionSessionRecordLike, question: UserQuestion): Promise<void> {
    const hint = record.scope === 'group' && this.config.requireMention === true;
    const keyboard = buildKeyboard(question);
    try {
      if (keyboard) {
        try {
          await this.sender.sendMarkdown(record.replyTarget, formatQuestion(question, hint, true), { keyboard });
          return;
        } catch (err) {
          const detail = (err instanceof Error ? err.message : String(err)).replace(/\\s+/g, ' ').slice(0, 240);
          this.logger.warn(`im-qqbot: keyboard send failed, fallback to text: ${detail}`);
          const fallback = formatQuestion(question, hint, false)
            + `\\n\\n> ⚠️ 按钮发送失败，已切换为文字选项。原因：${detail || '未知错误'}`;
          await this.sender.sendMarkdown(record.replyTarget, fallback);
          return;
        }
      }
      await this.sender.sendMarkdown(record.replyTarget, formatQuestion(question, hint, false));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`im-qqbot: question send failed key=${record.sessionKey}: ${msg}`);
      throw new Error(`failed to deliver question to QQ: ${msg}`);
    }
  }

  private onTimeout(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.removeAbort(entry);
    entry.timer = undefined;
    void this.sender.sendMarkdown(entry.record.replyTarget, '⚠️ 提问已超时，未收到回答。').catch(() => {});
    entry.reject(new QuestionChannelError('ask_user_question timed out before the user answered', ASK_ABORTED));
  }

  private resetTimer(entry: PendingEntry, key: string): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.onTimeout(key), this.config.askTimeoutMs);
  }

  private clearTimer(entry: PendingEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private removeAbort(entry: PendingEntry): void {
    if (entry.onAbort && entry.request.signal) {
      entry.request.signal.removeEventListener('abort', entry.onAbort);
    }
  }
}
