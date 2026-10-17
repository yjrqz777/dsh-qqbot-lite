/**
 * QQ Bot 凭据初始化 — 扫码绑定
 *
 * 当 appId/appSecret 未配置时，通过 @tencent-connect/qqbot-connector
 * 唤起终端扫码流程获取凭据，并写入 dsh profile 配置。
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import type { QrConnectCredentials } from '@tencent-connect/qqbot-connector';

/** 凭据结果 */
export interface SetupCredentials {
  appId: string;
  appSecret: string;
}

/** cordis.patch.yml 中的 patch 条目 */
interface PatchEntry {
  id?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 终端可点击的 OSC 8 超链接（不支持 OSC 8 的终端会忽略控制序列，退化为纯 URL 文本） */
function clickableLink(url: string): string {
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}

/**
 * 执行 QR 扫码绑定，获取 QQ Bot 凭据
 *
 * 在终端打印二维码等待用户扫码；同时输出扫码 URL，
 * 供二维码因系统字符问题渲染错位时点击/复制到浏览器打开扫码。
 */
export async function runQrSetup(source = 'dsh-qqbot'): Promise<SetupCredentials | null> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  QQ Bot 凭据未配置，启动扫码绑定');
  console.log('══════════════════════════════════════════════════════\n');

  try {
    console.log('请使用手机 QQ 扫描下方二维码完成绑定...\n');

    // 回调风格：onQrDisplayed 会在二维码打印后、轮询开始前回调扫码 URL，
    // 让用户在二维码错位时也能通过链接打开扫码页（二维码过期刷新会再次触发）。
    const credentials = await new Promise<QrConnectCredentials[]>((resolve, reject) => {
      startQrConnect(
        {
          onSuccess: resolve,
          onFailure: reject,
          onQrDisplayed: (url) => {
            console.log('二维码显示异常？点击下方链接，用浏览器打开即可完成扫码:');
            console.log(`  ${clickableLink(url)}\n`);
          },
          onQrExpired: () => {
            console.log('二维码已过期，正在刷新…\n');
          },
        },
        { source },
      );
    });

    if (!credentials || credentials.length === 0) {
      console.error('[im-qqbot] 扫码未返回凭据');
      return null;
    }

    const cred = credentials[0];
    if (!cred) {
      console.error('[im-qqbot] 扫码未返回有效凭据');
      return null;
    }
    console.log(`\n✔ 绑定成功！AppID: ${cred.appId}\n`);

    return {
      appId: cred.appId,
      appSecret: cred.appSecret,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('Cannot find') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      console.error('[im-qqbot] @tencent-connect/qqbot-connector 未安装，无法扫码绑定');
      console.error('[im-qqbot] 请通过环境变量配置:');
      console.error('  export QQBOT_APPID="你的AppID"');
      console.error('  export QQBOT_SECRET="你的AppSecret"');
    } else {
      console.error(`[im-qqbot] 扫码绑定失败: ${msg}`);
    }

    return null;
  }
}

// ───────────────────────── 网页扫码绑定（设置页弹窗里显示二维码） ─────────────────────────

/** 一次绑定会话的对外信息。 */
export interface BindSessionInfo {
  id: string;
  /** 授权页链接（二维码内容就是这个链接） */
  url: string;
  /** 二维码图片，data URL（SVG） */
  qr: string;
}

/** 一次轮询的结果。 */
export type BindPollResult =
  | { status: 'pending'; url: string; qr: string }
  | { status: 'done'; appId: string; appSecret: string }
  | { status: 'error'; error: string };

/** qrcode 只用到 toString，写最小接口即可，不必引入 @types/qrcode 依赖。 */
interface QrEncoder {
  toString(text: string, options?: Record<string, unknown>): Promise<string>;
}

interface BindSession {
  id: string;
  url: string;
  qr: string;
  creds: SetupCredentials | null;
  error: string | null;
  stop: () => void;
  /** 最近一次二维码更新时间，用来回收没人管的僵尸会话 */
  at: number;
}

/** 进行中的绑定会话（可能同时有几个，按 id 取）。 */
const bindSessions = new Map<string, BindSession>();

/** 会话最长存活时间：二维码过期会自动刷新，超过这个时间没人管就回收。 */
const BIND_TTL_MS = 10 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((done) => { setTimeout(done, ms); });

/**
 * 把授权页链接编成二维码图片（data URL / SVG）。
 *
 * `qrcode` 用**非字面量**动态 import：一是本插件「缺包只让单个功能降级」的约定，
 * 二是非字面量说明符在 TypeScript 里类型为 any，不必为一个函数引入 @types/qrcode。
 */
async function qrDataUrl(text: string): Promise<string> {
  const mod = (await import('qrcode' as string)) as { default?: QrEncoder } & QrEncoder;
  const encoder = mod.default ?? mod;
  if (typeof encoder?.toString !== 'function') throw new Error('qrcode 模块不可用');
  const svg = await encoder.toString(text, { type: 'svg', margin: 1, width: 260 });
  return `data:image/svg+xml;base64,${Buffer.from(String(svg), 'utf8').toString('base64')}`;
}

/** 停止并移除一个会话（连带停掉底层轮询）。 */
function closeBindSession(id: string): void {
  const session = bindSessions.get(id);
  if (session === undefined) return;
  bindSessions.delete(id);
  try { session.stop(); } catch { /* 停不掉不影响结果 */ }
}

/** 清掉超时未使用的会话。 */
function sweepBindSessions(): void {
  const now = Date.now();
  for (const [id, session] of Array.from(bindSessions.entries())) {
    if (now - session.at > BIND_TTL_MS) closeBindSession(id);
  }
}

/**
 * 开始一次网页扫码绑定：起 QQ 官方扫码流程，等第一张二维码生成后返回。
 *
 * 与 `runQrSetup` 的区别：不在终端打印二维码（`displayQrCodeToConsole:false`），
 * 而是把授权页链接编成图片交给设置页弹窗显示。
 *
 * @param source 来源标识，会拼进授权页链接
 */
export async function startBindSession(source = 'dsh-qqbot-lite'): Promise<BindSessionInfo> {
  sweepBindSessions();

  const id = `bind-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const session: BindSession = { id, url: '', qr: '', creds: null, error: null, stop: () => {}, at: Date.now() };
  bindSessions.set(id, session);

  try {
    session.stop = startQrConnect({
      onSuccess: (credentials) => {
        const first = (Array.isArray(credentials) ? credentials : [credentials])[0];
        if (!first) { session.error = '扫码未返回凭据'; return; }
        session.creds = { appId: String(first.appId ?? ''), appSecret: String(first.appSecret ?? '') };
      },
      onFailure: (error) => { session.error = error instanceof Error ? error.message : String(error); },
      // 二维码过期会自动刷新，这里每次都用最新链接重画一张
      onQrDisplayed: (url) => {
        void qrDataUrl(url)
          .then((qr) => { session.url = url; session.qr = qr; session.error = null; session.at = Date.now(); })
          .catch((error: unknown) => {
            session.error = `二维码生成失败: ${error instanceof Error ? error.message : String(error)}`;
          });
      },
      onQrExpired: () => { /* 新链接会再次触发 onQrDisplayed，前端轮询自然拿到新图 */ },
    }, { displayQrCodeToConsole: false, source });
  } catch (error) {
    closeBindSession(id);
    throw error;
  }

  // 等第一张二维码：官方 12 秒内必出，超时按失败处理
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && session.qr === '' && session.error === null) {
    await sleep(200);
  }
  if (session.qr === '') {
    const message = session.error ?? '获取绑定二维码超时';
    closeBindSession(id);
    throw new Error(message);
  }
  return { id, url: session.url, qr: session.qr };
}

/**
 * 轮询一次绑定结果。
 * @returns null 表示会话不存在（已结束或服务重启）
 */
export function pollBindSession(id: string): BindPollResult | null {
  const session = bindSessions.get(id);
  if (session === undefined) return null;
  if (session.creds !== null) {
    const { appId, appSecret } = session.creds;
    closeBindSession(id);
    return { status: 'done', appId, appSecret };
  }
  if (session.error !== null) {
    const error = session.error;
    closeBindSession(id);
    return { status: 'error', error };
  }
  if (Date.now() - session.at > BIND_TTL_MS) {
    closeBindSession(id);
    return { status: 'error', error: '绑定超时，请重新获取二维码' };
  }
  return { status: 'pending', url: session.url, qr: session.qr };
}

/** 用户取消：停掉轮询并丢弃会话。 */
export function cancelBindSession(id: string): void {
  closeBindSession(id);
}

/**
 * 将凭据写入 dsh profile 的 cordis.patch.yml
 *
 * 用 js-yaml 解析现有文件后更新/追加 im-qqbot 条目，再 dump 写回，
 * 保证输出始终是合法 YAML。文件不存在或为空时安全重建；
 * 解析失败或结构异常时拒绝写入、保留原文件（避免覆盖用户其他配置）。
 */
export function persistCredentialsToProfile(
  credentials: SetupCredentials,
  profileDir?: string,
  logger?: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
): boolean {
  const log = logger ?? console;
  const dir = profileDir;
  if (!dir) {
    // 开发模式：插件从源码加载、不在 node_modules 下，无法定位 profile 目录
    printEnvInstructions(credentials);
    return false;
  }

  const patchPath = resolve(dir, 'cordis.patch.yml');

  try {
    // 1. 解析现有条目（文件不存在/为空才重建；解析失败会抛错，保留原文件）
    let entries: PatchEntry[] = [];
    if (existsSync(patchPath)) {
      entries = parsePatchEntries(readFileSync(patchPath, 'utf8'));
    }

    // 2. 查找已有 im-qqbot 条目
    const existing = entries.find((e) => e.id === 'im-qqbot');

    if (existing) {
      // 更新已有条目的 config
      existing.config = {
        ...(existing.config ?? {}),
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      };
    } else {
      // 追加新条目
      entries.push({
        id: 'im-qqbot',
        config: {
          appId: credentials.appId,
          appSecret: credentials.appSecret,
        },
      });
    }

    // 3. dump 写回（保证合法 YAML）
    //    先确保 profile 目录存在（文件不存在时也能正常创建，而非误入 ENOENT）
    const output = `# QQ Bot 凭据（扫码绑定自动生成）\n${yaml.dump(entries)}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(patchPath, output, 'utf8');
    log.info(`✔ 凭据已写入: ${patchPath}`);
    log.info(`  下次启动将自动使用保存的凭据`);
    return true;
  } catch (err) {
    log.warn(`写入配置失败: ${err instanceof Error ? err.message : String(err)}`);
    printYamlInstructions(credentials, patchPath);
    return false;
  }
}

/**
 * 解析 cordis.patch.yml 为条目数组
 *
 * - 空内容 / 仅注释（yaml.load 返回 null/undefined）→ 空数组（允许安全重建）
 * - 空数组 `[]` / 条目列表 → 过滤出含 id 的对象
 * - 非数组结构 / YAML 语法错误 → 抛错（由调用方保留原文件，避免覆盖用户其他配置）
 */
function parsePatchEntries(content: string): PatchEntry[] {
  if (!content.trim()) return [];

  const parsed = yaml.load(content);
  // 仅注释/空白 → null/undefined，等价于空文件，允许重建
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('cordis.patch.yml 顶层必须是 YAML 数组');
  }
  return parsed.filter(
    (e): e is PatchEntry =>
      typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).id === 'string',
  );
}

/** 开发模式引导：未定位到 profile 目录，引导用环境变量配置（console.log 确保可见） */
function printEnvInstructions(credentials: SetupCredentials): void {
  console.log('未检测到 profile 目录（开发模式），请通过环境变量配置凭据:');
  if (process.platform === 'win32') {
    // Windows CMD 语法（PowerShell 请用 $env:QQBOT_APPID="xxx"）
    console.log(`  set QQBOT_APPID=${credentials.appId}`);
    console.log(`  set QQBOT_SECRET=${credentials.appSecret}`);
  } else {
    console.log(`  export QQBOT_APPID="${credentials.appId}"`);
    console.log(`  export QQBOT_SECRET="${credentials.appSecret}"`);
  }
}

/** 正式安装引导：自动写入失败，引导手动在 cordis.patch.yml 配置（console.log 确保可见） */
function printYamlInstructions(credentials: SetupCredentials, patchPath: string): void {
  console.log('无法自动保存凭据，请手动打开以下文件添加配置:');
  console.log(`  ${patchPath}`);
  console.log('');
  console.log('  - id: im-qqbot');
  console.log('    config:');
  console.log(`      appId: "${credentials.appId}"`);
  console.log(`      appSecret: "${credentials.appSecret}"`);
}
