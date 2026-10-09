/**
 * /persona — 管理和切换当前 QQ 对话的人格预设。
 *
 * /persona list      列出可用人格
 * /persona new       通过后续两条消息创建人格（名称、提示词）
 * /persona set <名>  为当前群或私聊设置人格
 * /persona reset     恢复默认人格
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, sendMarkdownChunked } from '../shared/index.ts';

export function personaCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'persona',
    category: 'qqbot',
    description: '查看、切换或创建人格预设（/persona list | new | set <名称> | reset）',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const args = (cmdCtx.command?.raw ?? '').trim();
      const [action = '', ...restParts] = args.split(/\s+/);
      const value = restParts.join(' ').trim();

      if (!args || action === 'list') {
        const current = manager.getEffectivePersonaName(scope, peerId);
        const presets = manager.listPersonaPresets();
        const lines = ['### 🎭 人格预设', '', `**当前对话:** ${current}`, '', '**可用预设:**'];
        for (const preset of presets) {
          lines.push(`- ${preset.name}${preset.name === current ? ' ✓' : ''}`);
        }
        lines.push('', '切换当前对话：`/persona set <名称>`', '新建预设：`/persona new`', '恢复默认：`/persona reset`');
        await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
        return { kind: 'noop' as const };
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
