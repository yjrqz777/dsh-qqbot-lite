/**
 * /persona — 管理和切换当前 QQ 对话的人格预设。
 *
 * /persona list      用 QQ 原生按钮选择人格
 * /persona new       通过后续两条消息创建人格（名称、提示词）
 * /persona set <名>  为当前群或私聊设置人格
 * /persona reset     恢复默认人格
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer } from '../shared/index.ts';
import type { ChatScope } from '../types.ts';
import type { SessionManager } from '../session/index.ts';

async function choosePersona(
  manager: SessionManager,
  scope: ChatScope,
  peerId: string,
): Promise<string> {
  const presets = manager.listPersonaPresets();
  if (presets.length === 0) return '目前没有可选的人格预设。';
  if (!manager.questionChannel) {
    return '当前 QQ 选项功能不可用。可以使用 /persona set <名称> 直接切换。';
  }

  const pageSize = 6;
  let page = 0;
  while (true) {
    const entries = presets.slice(page * pageSize, (page + 1) * pageSize);
    const labels = entries.map((preset, index) => `${index + 1}. ${preset.name}`);
    const hasPrevious = page > 0;
    const hasNext = (page + 1) * pageSize < presets.length;
    const options = [
      ...(hasPrevious ? ['上一页'] : []),
      ...labels,
      ...(hasNext ? ['下一页'] : []),
      '取消',
    ];
    const current = manager.getEffectivePersonaName(scope, peerId);
    const selected = await manager.questionChannel.chooseFromOptions(
      scope,
      peerId,
      `当前人格：${current}。请选择要用于当前对话的人格。`,
      options,
    );
    if (!selected || selected === '取消') return '已取消人格选择。';
    if (selected === '上一页') { page -= 1; continue; }
    if (selected === '下一页') { page += 1; continue; }

    const index = labels.indexOf(selected);
    const preset = index >= 0 ? entries[index] : undefined;
    if (!preset) return '没有识别到这个选项，请重新发送 /persona list。';
    manager.setPersonaOverride(scope, peerId, preset.name);
    return `✅ 当前对话已切换为「${preset.name}」。新提示词会在下一轮对话中重新注入。`;
  }
}

export function personaCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'persona',
    category: 'qqbot',
    description: '查看、切换或创建人格预设（/persona list | new | set <名称> | reset）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();
      const [action = '', ...restParts] = args.split(/\s+/);
      const value = restParts.join(' ').trim();

      if (!args) {
        if (!manager.questionChannel) {
          return '当前 QQ 选项功能不可用。请使用 /persona list 查看预设，或 /persona new 创建人格。';
        }
        const current = manager.getEffectivePersonaName(scope, peerId);
        const selected = await manager.questionChannel.chooseFromOptions(
          scope,
          peerId,
          `人格设置。当前对话使用「${current}」。请选择操作。`,
          ['查看/切换预设', '新建人格', '恢复默认人格'],
        );
        if (selected === '查看/切换预设') return choosePersona(manager, scope, peerId);
        if (selected === '新建人格') {
          manager.startPersonaCreation(scope, peerId);
          return '请分两条消息发送：先发送人格名称，再发送完整提示词。创建后会自动应用到当前对话；发送 /persona cancel 可取消。群聊中点击选项即可，不需要额外 @。';
        }
        if (selected === '恢复默认人格') {
          manager.clearPersonaOverride(scope, peerId);
          return '✅ 当前对话已恢复默认人格；新提示词会在下一轮对话中注入。';
        }
        return '已取消人格操作。';
      }

      if (action === 'list') {
        return choosePersona(manager, scope, peerId);
      }

      if (action === 'new') {
        manager.startPersonaCreation(scope, peerId);
        return '请分两条消息发送：先发送人格名称，再发送完整提示词。创建后会自动应用到当前对话；发送 /persona cancel 可取消。群聊中按当前 @ 触发设置发送。';
      }

      if (action === 'cancel') {
        return manager.cancelPersonaCreation(scope, peerId) ? '已取消人格创建。' : '当前没有待完成的人格创建。';
      }

      if (action === 'reset' || action === 'default') {
        manager.clearPersonaOverride(scope, peerId);
        return '✅ 当前对话已恢复默认人格；新提示词会在下一轮对话中注入。';
      }

      const name = action === 'set' ? value : [action, ...restParts].join(' ').trim();
      if (!name) return '用法：/persona list、/persona new、/persona set <名称> 或 /persona reset。';
      if (!manager.setPersonaOverride(scope, peerId, name)) {
        const available = manager.listPersonaPresets().map((preset) => preset.name).join('、');
        return `没有找到人格「${name}」。可用预设：${available || '无'}。发送 /persona list 查看列表。`;
      }

      return `✅ 当前对话已切换为「${name}」。新提示词会在下一轮对话中重新注入。`;
    },
  };
}
