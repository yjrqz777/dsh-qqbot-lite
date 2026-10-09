/**
 * dsh-im-qqbot — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 网关组装（中间件编排 + 事件 + 出站 + 生命周期）见 src/gateway/。
 *
 * 运行时全量配置保存在 profile 目录的独立 JSON 文件中；Cordis 配置作为首次
 * 初始化和旧版兼容的默认值。收到 `loader/volatile-update` 时重新读取 JSON 并按需重启网关。
 *
 * ── 启动隔离（硬约束）──
 * 本插件无论怎么坏，都不允许影响 harness 启动：
 * 1. `apply()` 全程 try/catch，抛错只记录，fiber 绝不进入 FAILED。
 * 2. 不 await 任何交互式流程：终端扫码只在真连着 TTY 时后台发起，永不阻塞启动。
 * 3. 依赖 QQ SDK / connector 的模块走动态 import，缺包或损坏只让本插件降级。
 * 4. 凭据缺失或明显非法时不构造 SDK 实例，停在本插件内部。
 */
import { mkdirSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, resolveConfigValues, type ImQQBotConfig, type ImQQBotFormConfig } from './config.ts';
import { LOG_PATH, teeLogger } from './log.ts';
import type { DshAgentRegistry } from './session/index.ts';
import { resolveEnv } from './shared/index.ts';
import { QqbotStatus } from './status.ts';
import { loadPluginSettings, savePluginSettings } from './settings-store.ts';
import type { Logger } from './types.ts';

// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents'];
export const Config: Schemastery = ConfigSchema;

export type { ImQQBotConfig, ImQQBotFormConfig } from './config.ts';

/** 浏览器半轮询连接状态用的路由（与 client.tsx 里的常量一致）。 */
const STATUS_PATH = '/api/dsh-qqbot/status';
const SETTINGS_PATH = '/api/dsh-qqbot/settings';

/** 取错误文本（unknown → string）。 */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 插件主体 ──
/**
 * 插件入口。任何异常都在这里被吞掉并记录：插件失败最多等于
 * 「QQ 机器人不可用」，不会让 harness 起不来。
 */
export async function apply(ctx: Context, config: ImQQBotFormConfig): Promise<void> {
  const base = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;
  // 宿主控制台用户看不到，所有日志同时落到 ~/.dsh-qqbot/plugin.log。
  const logger: Logger = teeLogger(base);

  console.log('[im-qqbot] apply() called');
  logger.info(`[im-qqbot] apply() 开始（日志文件：${LOG_PATH}）`);

  try {
    await bootstrap(ctx, config, logger);
  } catch (error) {
    logger.error(`[im-qqbot] 初始化失败，插件已停用（不影响 harness）: ${reason(error)}`);
  }
}

/** 插件初始化：所有可能失败的步骤都各自隔离。 */
async function bootstrap(ctx: Context, config: ImQQBotFormConfig, logger: Logger): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const defaults = resolveConfigValues(config);
  let activeSettings: ImQQBotConfig = defaults;
  try {
    activeSettings = loadPluginSettings(defaults);
  } catch (error) {
    logger.warn(`独立配置文件读取失败，将使用 profile 默认值: ${reason(error)}`);
  }
  let requestSettingsSave: (value: unknown) => Promise<ImQQBotConfig> = async () => activeSettings;

  /** 进程内连接状态，供设置页顶部的状态圆点读取。 */
  const status = new QqbotStatus();

  // 连接状态查询与手动连接/断开接口，供设置页状态和按钮使用。
  // `connection` 只存在于 GUI 组合；缺失或注册失败都只是状态点不可用（灰点），
  // 不影响插件本身运行。
  let connectionEnabled = true;
  let requestConnection: (connect: boolean) => Promise<void> = async () => {};
  try {
    ctx.inject(['connection'], (connectionCtx) => {
      const connection = (connectionCtx as unknown as Record<string, unknown>).connection as
        | { fetch: { register(route: Record<string, unknown>): () => void } }
        | undefined;
      if (connection === undefined) return;
      connectionCtx.effect(
        () => connection.fetch.register({
          path: STATUS_PATH,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: () => Promise.resolve(Response.json(status.get(), {
            headers: { 'cache-control': 'no-store' },
          })),
        }),
        'im-qqbot: status route',
      );
      connectionCtx.effect(
        () => connection.fetch.register({
          path: '/api/dsh-qqbot/connect', methods: ['POST'], requestBody: 'buffered',
          fetch: async () => { await requestConnection(true); return Response.json(status.get()); },
        }),
        'im-qqbot: connect route',
      );
      connectionCtx.effect(
        () => connection.fetch.register({
          path: '/api/dsh-qqbot/disconnect', methods: ['POST'], requestBody: 'buffered',
          fetch: async () => { await requestConnection(false); return Response.json(status.get()); },
        }),
        'im-qqbot: disconnect route',
      );
      connectionCtx.effect(
        () => connection.fetch.register({
          path: SETTINGS_PATH, methods: ['GET', 'POST'], requestBody: 'buffered',
          fetch: async (request: Request) => {
            try {
              if (request.method === 'GET') return Response.json(activeSettings, { headers: { 'cache-control': 'no-store' } });
              const saved = await requestSettingsSave(await request.json());
              return Response.json(saved, { headers: { 'cache-control': 'no-store' } });
            } catch (error) {
              return Response.json({ error: reason(error) }, { status: 400, headers: { 'cache-control': 'no-store' } });
            }
          },
        }),
        'im-qqbot: settings route',
      );
    });
  } catch (error) {
    logger.warn(`连接状态路由注册失败（状态点将不可用）: ${reason(error)}`);
  }

  // 关掉 Plugins 页对本行自动生成的配置表单：本插件自带设置页（浏览器半）。
  // `settings` 只存在于 Web 组合，缺失时这个 inject 回调不会运行。
  try {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = (settingsCtx as unknown as Record<string, unknown>).settings as
        | { configure(presentation: { auto?: boolean }, owner?: unknown): () => void }
        | undefined;
      if (settings === undefined) return;
      settingsCtx.effect(
        () => settings.configure({ auto: false }, ctx.fiber),
        'im-qqbot: settings presentation',
      );
    });
  } catch (error) {
    logger.warn(`关闭自动配置页失败（忽略）: ${reason(error)}`);
  }

  /** 当前生效的网关 fiber；重建前必须销毁，否则旧连接与旧注册会泄漏。 */
  let gateway: { dispose(): void | Promise<void> } | undefined;
  /** 最近一次启动所用的配置签名，用于跳过无变化的重启。 */
  let activeSignature: string | undefined;
  /** 串行化重启：并发的 volatile 事件不会各建一个网关。 */
  let pending: Promise<void> = Promise.resolve();
  /**
   * 网关代次：每次销毁 +1。旧网关的销毁是异步的，它随后回报的 'stopped'
   * 不能覆盖新网关已经写入的 'starting'/'connected'，所以回报一律带代次校验。
   */
  let generation = 0;

  const stopGateway = (): void => {
    const current = gateway;
    gateway = undefined;
    activeSignature = undefined;
    generation += 1;
    if (current === undefined) return;
    try {
      void Promise.resolve(current.dispose()).catch((error: unknown) => {
        logger.warn(`网关销毁失败（忽略）: ${reason(error)}`);
      });
    } catch (error) {
      logger.warn(`网关销毁失败（忽略）: ${reason(error)}`);
    }
  };

  /**
   * 按当前配置启动（或重启）QQ 网关。
   * @param allowQrSetup 凭据缺失时是否允许后台唤起扫码绑定；只有首次 apply 允许。
   */
  const startGateway = async (allowQrSetup: boolean): Promise<void> => {
    if (!connectionEnabled) {
      stopGateway();
      status.set({ state: 'stopped', error: null });
      return;
    }
    const values = activeSettings;
    const appId = resolveEnv(values.appId, 'QQBOT_APPID').trim();
    const appSecret = resolveEnv(values.appSecret, 'QQBOT_SECRET').trim();

    if (!appId || !appSecret) {
      stopGateway();
      status.set({ state: 'unconfigured', appId: '', error: null });
      logger.warn('QQ Bot 凭据未配置：请在「设置 → QQ Bot」填写 AppID / AppSecret，或设置 QQBOT_APPID / QQBOT_SECRET 环境变量。');
      // 扫码是长时间交互流程：绝不 await。只在真的连着终端时后台发起，
      // 否则（桌面版等无 TTY 场景）连试都不试，避免把启动拖住。
      if (allowQrSetup && process.stdin.isTTY === true) void qrBind(logger, async (credentials) => {
        await requestSettingsSave({ ...activeSettings, appId: credentials.appId, appSecret: credentials.appSecret });
      });
      return;
    }

    if (!/^\d+$/.test(appId)) {
      stopGateway();
      status.set({ state: 'error', appId, error: 'AppID 必须是纯数字' });
      logger.error(`AppID "${appId}" 不是 QQ Bot 的数字 AppID，已跳过启动（不影响 harness）。请在设置页更正。`);
      return;
    }

    const resolvedConfig: ImQQBotConfig = { ...values, appId, appSecret };

    // QQ 会话的专属工作目录必须真实存在：它同时是 agent 的 cwd 与会话归档目录。
    // 建目录失败只记录——Agent 创建时会再报一次，不影响 harness。
    if (resolvedConfig.cwd) {
      try {
        mkdirSync(resolvedConfig.cwd, { recursive: true });
      } catch (error) {
        logger.warn(`创建 QQ 工作目录失败（忽略）: ${reason(error)}`);
      }
    }

    const signature = JSON.stringify(resolvedConfig);
    if (gateway !== undefined && signature === activeSignature) return;

    stopGateway();

    // QQ SDK 动态加载：缺包、装坏、版本不匹配都只让本插件降级。
    let bootstrapGateway: typeof import('./gateway/index.ts').bootstrapGateway;
    try {
      ({ bootstrapGateway } = await import('./gateway/index.ts'));
    } catch (error) {
      status.set({ state: 'error', appId, error: reason(error) });
      logger.error(`QQ SDK 加载失败，QQ 机器人未启动（不影响 harness）: ${reason(error)}`);
      return;
    }

    activeSignature = signature;
    status.set({ state: 'starting', appId, error: null });
    /** 本次挂载的代次：旧网关的异步回报按它丢弃。 */
    const mountedGeneration = generation;
    try {
      gateway = ctx.plugin({
        name: 'im-qqbot-gateway',
        apply: async (child: Context) => {
          try {
            await bootstrapGateway(child, agents, resolvedConfig, logger, (state, error) => {
              if (mountedGeneration !== generation) return;
              status.set({ state, appId, error: error ?? null });
            }, (message) => {
              // 功能级错误（预设挂载失败、会话创建失败）：不改连接状态，
              // 只在设置页状态区留痕，方便定位。
              status.set({ lastError: message });
            });
          } catch (error) {
            if (mountedGeneration === generation) {
              status.set({ state: 'error', appId, error: reason(error) });
            }
            logger.error(`QQ 网关启动失败（不影响 harness）: ${reason(error)}`);
          }
        },
      });
    } catch (error) {
      activeSignature = undefined;
      status.set({ state: 'error', appId, error: reason(error) });
      logger.error(`QQ 网关挂载失败（不影响 harness）: ${reason(error)}`);
    }
  };

  requestSettingsSave = async (value: unknown): Promise<ImQQBotConfig> => {
    const updated = savePluginSettings(value, defaults);
    activeSettings = updated;
    pending = pending.then(() => startGateway(false)).catch((error: unknown) => {
      logger.error(`保存设置后重启网关失败: ${reason(error)}`);
    });
    await pending;
    return activeSettings;
  };

  requestConnection = async (connect: boolean): Promise<void> => {
    connectionEnabled = connect;
    pending = pending.then(async () => {
      if (connect) await startGateway(false);
      else {
        stopGateway();
        status.set({ state: 'stopped', error: null });
      }
    });
    await pending;
  };

  await startGateway(true);

  // volatile 配置变更：新值已提交进引用，这里按新值重启网关。
  // 事件名由 Loader 声明，本包不额外依赖那个包，沿用本仓库既有的强转写法。
  (ctx as unknown as { on(event: string, handler: () => void): void })
    .on('loader/volatile-update', () => {
      try { activeSettings = loadPluginSettings(resolveConfigValues(config)); } catch (error) {
        logger.warn(`读取独立设置失败: ${reason(error)}`);
      }
      pending = pending
        .then(() => startGateway(false))
        .catch((error: unknown) => {
          logger.error(`配置变更后重启网关失败（不影响 harness）: ${reason(error)}`);
        });
    });
}

/**
 * 终端扫码绑定：完全后台执行，绝不阻塞启动，失败只记录。
 * 成功后凭据通过注入的回调写入 QQ Bot 独立配置文件并重启网关。
 */
async function qrBind(logger: Logger, saveCredentials: (credentials: { appId: string; appSecret: string }) => Promise<unknown>): Promise<void> {
  try {
    const { runQrSetup } = await import('./setup.ts');
    const credentials = await runQrSetup();

    if (credentials === null) {
      logger.error('扫码未取得凭据，QQ 机器人保持未启动');
      return;
    }

    process.env.QQBOT_APPID = credentials.appId;
    process.env.QQBOT_SECRET = credentials.appSecret;

    await saveCredentials(credentials);
    logger.info('凭据已保存到 QQ Bot 独立配置文件。');
  } catch (error) {
    logger.error(`扫码绑定失败（不影响 harness）: ${reason(error)}`);
  }
}
