/**
 * QQ Bot 全量配置的 profile 级文件存储。
 *
 * 首次启动将当前 Cordis 配置作为迁移来源；后续以此 JSON 文件为准。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProfileDir } from './shared/utils.ts';
import type { ImQQBotConfig } from './config.ts';

const FILE_NAME = 'dsh-qqbot-settings.json';
let cachedPath: string | undefined;
let cachedValue: ImQQBotConfig | undefined;

function settingsPath(profileDir?: string): string {
  const resolvedProfileDir = profileDir ?? getProfileDir();
  if (!resolvedProfileDir) throw new Error('无法定位 dsh profile 目录，不能保存 QQ Bot 配置');
  return join(resolvedProfileDir, FILE_NAME);
}

function normalize(value: unknown, defaults: ImQQBotConfig): ImQQBotConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('QQ Bot 配置格式错误');
  }
  const input = value as Record<string, any>;
  const result: ImQQBotConfig = {
    ...defaults,
    ...input,
    access: { ...defaults.access, ...(input.access ?? {}) },
    media: { ...defaults.media, ...(input.media ?? {}) },
    vision: { ...defaults.vision, ...(input.vision ?? {}) },
    sendFile: { ...defaults.sendFile, ...(input.sendFile ?? {}) },
  };
  if (typeof result.appId !== 'string' || typeof result.appSecret !== 'string') {
    throw new Error('AppID 和 AppSecret 必须是文本');
  }
  if (result.personaPrompt !== undefined && typeof result.personaPrompt !== 'string') {
    throw new Error('人格提示词必须是文本');
  }
  if (!Array.isArray(result.personaPresets)) result.personaPresets = [];
  return result;
}

function copy(value: ImQQBotConfig): ImQQBotConfig {
  return JSON.parse(JSON.stringify(value)) as ImQQBotConfig;
}

/** Load the per-profile file, initializing it from Cordis config once if absent. */
export function loadPluginSettings(defaults: ImQQBotConfig, profileDir?: string): ImQQBotConfig {
  const path = settingsPath(profileDir);
  if (cachedPath === path && cachedValue !== undefined) return copy(cachedValue);
  if (existsSync(path)) {
    cachedValue = normalize(JSON.parse(readFileSync(path, 'utf8')), defaults);
    cachedPath = path;
    return copy(cachedValue);
  }
  return savePluginSettings(defaults, defaults, profileDir);
}

/** Persist all QQ Bot settings atomically and update the runtime cache. */
export function savePluginSettings(value: unknown, defaults: ImQQBotConfig, profileDir?: string): ImQQBotConfig {
  const normalized = normalize(value, defaults);
  const path = settingsPath(profileDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  cachedPath = path;
  cachedValue = normalized;
  return copy(normalized);
}
