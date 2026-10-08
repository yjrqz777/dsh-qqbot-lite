/**
 * 插件日志落盘
 *
 * 宿主控制台用户看不到，出问题只能靠猜。这里把插件走 `ctx.logger` 的每一条
 * 也写进 `~/.dsh-qqbot/plugin.log`（超过 512 KB 自动清空重来），
 * 便于事后定位「消息到底走到哪一步」。
 *
 * 任何写日志失败都不允许影响插件本身。
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 日志目录与文件。 */
const LOG_DIR = join(homedir(), '.dsh-qqbot');
const LOG_FILE = join(LOG_DIR, 'plugin.log');

/** 单文件上限：超过就清空重来，避免无限增长。 */
const MAX_BYTES = 512 * 1024;

/** 把参数拼成一行（与 console 的 %s/%o 风格保持宽松兼容）。 */
function format(message: unknown, args: unknown[]): string {
  let text = typeof message === 'string' ? message : String(message);
  for (const arg of args) {
    let value: string;
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') value = String(arg);
    else {
      try {
        value = JSON.stringify(arg);
      } catch {
        value = String(arg);
      }
    }
    text = text.includes('%s') || text.includes('%d') || text.includes('%o') || text.includes('%j')
      ? text.replace(/%[sdoj]/, value)
      : `${text} ${value}`;
  }
  return text;
}

/**
 * 追加一行日志。
 * @param scope 级别（info/warn/error/debug）。
 * @param message 已格式化的文本。
 */
export function fileLog(scope: string, message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) writeFileSync(LOG_FILE, '');
    } catch {
      // 文件还不存在：直接追加即可。
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [${scope}] ${message}\n`);
  } catch {
    // 日志是诊断手段，失败不能影响插件。
  }
}

/** 日志文件路径（供提示文案使用）。 */
export const LOG_PATH = LOG_FILE;

/** 宿主 logger 的最小接口。 */
export interface MinimalLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/**
 * 包一层：宿主 logger、控制台、日志文件三处都写。
 *
 * 控制台只打 info/warn/error（带 `[im-qqbot]` 前缀）；debug 级（SDK 的
 * token/api 调用）只进文件，否则控制台会被刷爆。
 * @param base 宿主 logger（可以是 console）。
 * @returns 同时落盘并打印的 logger。
 */
export function teeLogger(base: MinimalLogger): MinimalLogger {
  const pass = (scope: 'info' | 'warn' | 'error' | 'debug') =>
    (msg: string, ...args: unknown[]): void => {
      const text = format(msg, args);
      try {
        base[scope](msg, ...args);
      } catch {
        // 宿主日志失败不影响落盘。
      }
      if (scope !== 'debug') {
        try {
          const line = `[im-qqbot] ${text}`;
          if (scope === 'error') console.error(line);
          else if (scope === 'warn') console.warn(line);
          else console.log(line);
        } catch {
          // 控制台不可用时忽略。
        }
      }
      fileLog(scope, text);
    };
  return { info: pass('info'), warn: pass('warn'), error: pass('error'), debug: pass('debug') };
}
