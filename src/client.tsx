/**
 * dsh-qqbot 浏览器半：在「设置」导航里注册 QQ Bot 配置页（order 90）。
 *
 * 本文件是**经典脚本**，不是模块：没有 import、没有 export，`tsc` 按原样输出
 * 成 lazy-CJS factory，由浏览器的模块表加载。产物必须满足：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... } })
 * `id` 必须是包名（@yjrqz777/dsh-qqbot-lite），否则该 Loader 行等不到注册。
 *
 * QQ Bot 全量配置通过宿主 connection 路由读写 profile 下的独立 JSON 文件；
 * 该文件首次创建时从当前 Cordis profile 配置迁移默认值。
 *
 * 隔离：整个脚本包在 IIFE 里（经典脚本共享全局词法作用域，顶层声明会撞名，
 * 撞名会让脚本整体失效并报 "loaded without registering"）；factory 的依赖加载
 * 与 apply 的注册各自 try/catch —— 这一半怎么坏都只是少一个设置页。
 */

type ModuleRequire = (name: string) => any;

interface LazyModule {
  readonly id: string;
  factory(require: ModuleRequire): unknown;
}

/** Web 外壳在装载任何 bundle 之前注入的注册队列。 */
declare const window: { __ModuleLoader__: { load(module: LazyModule): void } };

declare const console: { log(...args: unknown[]): void; error(...args: unknown[]): void };

/** 浏览器全局（只用到这几个，声明出来即可，lib 里没有 DOM）。 */
declare function fetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; json(): Promise<any> }>;
declare function setInterval(handler: () => void, timeout: number): number;
declare function clearInterval(handle: number): void;

/** 经典 `h` 工厂所需的 JSX 环境；React 由外壳的模块表在运行时提供。 */
declare namespace JSX {
  interface Element {}
  interface ElementClass {}
  interface ElementAttributesProperty {}
  interface IntrinsicElements {
    [name: string]: any;
  }
}

type CreateElement = (type: any, props?: any, ...children: any[]) => any;

/**
 * 运行时代码整体包在一个 IIFE 里。
 *
 * 客户端 bundle 是**经典脚本**，而经典脚本共享同一个全局词法作用域：任何顶层
 * `const`/`let` 都会与同页其它 bundle（或同一个组合脚本里的其它资源）撞名，
 * 抛 "Identifier '...' has already been declared"，脚本整体失效，于是不会向
 * `__ModuleLoader__` 注册，宿主只报 "loaded without registering"。
 * 官方的 tsdown 预设靠 factory 包裹达到同样效果，这里用 IIFE 复现。
 * （`declare` 语句不能放进函数体，所以 window/console/fetch/JSX 的声明留在顶层。）
 */
(() => {

/** 插件行 id，同时是 settings namespace。 */
const NS = 'im-qqbot';

/** 设置导航里的排序位置。 */
const ORDER = 77;

/** 宿主半注册的连接状态路由（文档相对路径，与 src/index.ts 的常量对应）。 */
const STATUS_ROUTE = '/api/dsh-qqbot/status';
const CONNECT_ROUTE = '/api/dsh-qqbot/connect';
const DISCONNECT_ROUTE = '/api/dsh-qqbot/disconnect';
const SETTINGS_ROUTE = '/api/dsh-qqbot/settings';

/** 状态轮询间隔(ms)。 */
const STATUS_POLL_MS = 5000;

/** 透传标签：只为让编辑器把下面的块高亮成 CSS。 */
const css = (strings: TemplateStringsArray): string => strings.join('');

/**
 * 页面自带样式：一行一条规则，类名统一带 dqb- 前缀避免与宿主冲突，
 * 颜色只在状态点上写死（用户要求的绿点），其余用 --dsw-alias-* 主题 token。
 */
const CSS = css`
.dqb-page { display: flex; flex-direction: column; gap: 16px; max-width: 760px; padding: 0 0 24px; }
.dqb-sticky-header { position: sticky; top: 0; z-index: 10; display: flex; flex-direction: column; background: var(--dsw-alias-bg-base, #fff); }
.dqb-toolbar { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 8px 0; background: var(--dsw-alias-bg-base, #fff); border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
.dqb-status { display: flex; align-items: center; gap: 6px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dqb-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; background: #8b949e; box-shadow: 0 0 0 3px rgba(139, 148, 158, 0.18); }
.dqb-dot-connected { background: #2ea043; box-shadow: 0 0 0 3px rgba(46, 160, 67, 0.2); }
.dqb-dot-starting { background: #d29922; box-shadow: 0 0 0 3px rgba(210, 153, 34, 0.2); }
.dqb-dot-error { background: #d1242f; box-shadow: 0 0 0 3px rgba(209, 36, 47, 0.2); }
.dqb-status-detail { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dqb-spacer { flex: 1 1 auto; }
.dqb-button { min-height: 28px; padding: 6px 14px; font: inherit; font-size: 13px; line-height: 16px; color: inherit; background: transparent; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; cursor: pointer; transition: background-color 120ms ease, transform 120ms ease; }
.dqb-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dqb-button:active:not(:disabled) { transform: scale(0.96); }
.dqb-button:disabled { opacity: 0.45; cursor: default; }
.dqb-button-primary { border-color: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-state-business-primary); }
.dqb-save { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dqb-save-saved { color: var(--dsw-alias-state-business-primary); }
.dqb-save-error { color: var(--dsw-alias-state-error-primary); }
.dqb-meta { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dqb-notice { margin: 0; padding: 8px 10px; font-size: 12px; line-height: 18px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; color: var(--dsw-alias-label-secondary); }
.dqb-error { color: var(--dsw-alias-state-error-primary); }
.dqb-category-tabs { display: flex; gap: 22px; overflow-x: auto; min-height: 42px; border-bottom: 1px solid var(--dsw-alias-border-l1); scrollbar-width: thin; }
.dqb-category-tab { position: relative; flex: 0 0 auto; padding: 10px 2px 9px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-secondary); background: transparent; border: 0; cursor: pointer; }
.dqb-category-tab:hover { color: var(--dsw-alias-label-primary); }
.dqb-category-tab-active { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dqb-category-tab-active::after { position: absolute; right: 0; bottom: -1px; left: 0; height: 2px; background: var(--dsw-alias-state-business-primary); content: ''; }
.dqb-group { display: flex; flex-direction: column; gap: 12px; padding: 8px 0; }
.dqb-group-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dqb-credential-link { margin-left: 8px; font-weight: 400; color: var(--dsw-alias-state-business-primary); text-decoration: none; }
.dqb-credential-link:hover { text-decoration: underline; }
.dqb-field { display: flex; flex-direction: column; gap: 4px; }
.dqb-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.dqb-label { flex: 0 0 168px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dqb-dirty { color: var(--dsw-alias-state-business-primary); }
.dqb-input { flex: 1 1 auto; min-width: 0; min-height: 28px; padding: 4px 8px; font: inherit; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-elevated, rgba(127, 127, 127, 0.14)); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.dqb-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dqb-input:disabled { opacity: 0.5; }
.dqb-textarea { min-height: 56px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dqb-persona-input { min-height: 120px; font-family: inherit; }
.dqb-preset-tools { display: flex; gap: 8px; align-items: center; }
.dqb-preset-name { max-width: 220px; }
.dqb-preset-select { max-width: 260px; }
.dqb-preset-save { white-space: nowrap; }
.dqb-persona-peers { display: grid; gap: 10px; margin-top: 20px; }
.dqb-persona-peers-title { margin: 0; font-size: 14px; }
.dqb-persona-peer { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dqb-persona-peer-info { display: flex; flex: 1 1 auto; min-width: 0; flex-direction: column; gap: 3px; }
.dqb-persona-peer-info small { overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); }
.dqb-persona-peer-select { max-width: 240px; }
.dqb-check { flex: 0 0 auto; width: 16px; height: 16px; }
.dqb-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
`;

/** 一个可编辑字段：path 与 Config schema 中的固定路径一一对应。 */
interface FieldSpec {
  readonly path: string[];
  readonly label: string;
  readonly kind: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'list';
  readonly options?: string[];
  readonly hint?: string;
}

interface FieldGroup {
  readonly title: string;
  readonly fields: FieldSpec[];
}

/** 页面字段清单（与 src/config.ts 的 volatile 字段一一对应）。 */
const GROUPS: FieldGroup[] = [
  {
    title: '凭据',
    fields: [
      { path: ['appId'], label: 'AppID', kind: 'text', hint: 'QQ Bot 的数字 AppID。' },
      { path: ['appSecret'], label: 'AppSecret', kind: 'text', hint: '明文保存并回显；填错会导致连不上。' },
    ],
  },
  {
    title: '模型与会话',
    fields: [
      { path: ['provider'], label: 'LLM provider', kind: 'text', hint: '留空表示继承宿主默认模型路由。' },
      { path: ['model'], label: '模型', kind: 'text' },
      { path: ['preset'], label: 'Agent preset', kind: 'text' },
      { path: ['cwd'], label: '工作目录', kind: 'text' },
      { path: ['streaming'], label: '流式输出', kind: 'boolean', hint: '群聊始终不启用。' },
      { path: ['textChunkLimit'], label: '单条消息上限', kind: 'number' },
      { path: ['sessionIdleTimeout'], label: '会话闲置超时（ms）', kind: 'number' },
      { path: ['processingTimeoutMs'], label: '处理超时（ms）', kind: 'number' },
      { path: ['askTimeoutMs'], label: '待答问题超时（ms）', kind: 'number' },
      { path: ['maxQueue'], label: '并发队列长度', kind: 'number' },
      { path: ['historyLimit'], label: '群历史条数', kind: 'number' },
      { path: ['showToolResults'], label: '展示工具成功结果', kind: 'boolean' },
      { path: ['debug'], label: '调试模式', kind: 'boolean' },
    ],
  },
  {
    title: '人格配置',
    fields: [
      { path: ['personaPrompt'], label: '人格提示词', kind: 'textarea', hint: '对每个私聊和群聊会话的首轮生效。支持多行。' },
    ],
  },
  {
    title: '触发与提示词',
    fields: [
      { path: ['requireMention'], label: '群聊需 @bot', kind: 'boolean' },
      { path: ['groupPrompt'], label: '群聊额外 prompt', kind: 'text' },
      { path: ['directPrompt'], label: '私聊额外 prompt', kind: 'text' },
    ],
  },
  {
    title: '访问控制',
    fields: [
      { path: ['access', 'c2cMode'], label: '私聊模式', kind: 'select', options: ['open', 'allowlist', 'disabled'] },
      { path: ['access', 'c2cAllow'], label: '私聊白名单', kind: 'list', hint: 'user openid，逗号或换行分隔。' },
      { path: ['access', 'groupMode'], label: '群聊模式', kind: 'select', options: ['open', 'allowlist', 'disabled'] },
      { path: ['access', 'groupAllow'], label: '群聊白名单', kind: 'list', hint: 'group openid，逗号或换行分隔。' },
    ],
  },
  {
    title: '富媒体理解',
    fields: [
      { path: ['media', 'enabled'], label: '启用富媒体', kind: 'boolean' },
      { path: ['media', 'maxMB'], label: '下载上限（MB）', kind: 'number' },
      { path: ['media', 'ttlHours'], label: '存活时长（小时）', kind: 'number', hint: '0 表示永不过期。' },
    ],
  },
  {
    title: '视觉理解',
    fields: [
      { path: ['vision', 'enabled'], label: '启用视觉理解', kind: 'boolean' },
      { path: ['vision', 'provider'], label: '视觉 provider', kind: 'text' },
      { path: ['vision', 'model'], label: '视觉模型', kind: 'text' },
      { path: ['vision', 'defaultPrompt'], label: '默认 prompt', kind: 'text' },
      { path: ['vision', 'maxBytes'], label: '图片字节上限', kind: 'number' },
      { path: ['vision', 'maxTokens'], label: '输出 token 上限', kind: 'number' },
      { path: ['vision', 'timeoutMs'], label: '调用超时（ms）', kind: 'number' },
    ],
  },
  {
    title: '附件发送',
    fields: [
      { path: ['sendFile', 'restrictPaths'], label: '启用路径白名单', kind: 'boolean' },
      { path: ['sendFile', 'extraRoots'], label: '额外根目录', kind: 'list', hint: '每行一个绝对路径。' },
    ],
  },
];

window.__ModuleLoader__.load({
  id: '@yjrqz777/dsh-qqbot-lite',
  factory(require) {
    // 依赖加载失败只让本插件的设置页消失，绝不把整个外壳带下水：
    // 返回一个什么都不做的插件，外壳照常启动。
    let React: {
      createElement: CreateElement;
      useState: (init: any) => [any, (next: any) => void];
      useEffect: (fn: () => void, deps: any[]) => void;
    };
    try {
      React = require('react');
    } catch (error: unknown) {
      console.error('[im-qqbot] 客户端半依赖加载失败（已隔离，不影响外壳）:', error);
      return { inject: [], apply(): void {} };
    }
    const h = React.createElement;
    const inject = ['slots'];

    /** 按固定路径读取嵌套值。 */
    const valueAt = (root: any, path: string[]): any =>
      path.reduce((node: any, key: string) => (node === null || node === undefined ? undefined : node[key]), root);

    /** 一个字段在草稿里的键。 */
    const draftKey = (path: string[]): string => path.join('.');

    /** 字段索引：草稿键 → 字段定义（保存时按它把文本还原成配置值）。 */
    const FIELDS_BY_KEY = new Map<string, FieldSpec>(
      GROUPS.flatMap(group => group.fields.map(field => [draftKey(field.path), field] as [string, FieldSpec])),
    );

    /** 配置值的输入框文本形式。 */
    function formatValue(field: FieldSpec, value: unknown): string {
      if (value === undefined || value === null) return '';
      if (field.kind === 'list') return Array.isArray(value) ? value.join('\n') : String(value);
      return String(value);
    }

    /** 把草稿还原成配置值；返回 null 表示这一项不合法、拒绝保存。 */
    function parseInput(field: FieldSpec, raw: unknown): unknown | null {
      if (field.kind === 'boolean') return typeof raw === 'boolean' ? raw : null;
      const text = String(raw ?? '');
      if (field.kind === 'number') {
        const parsed = Number(text.trim());
        return text.trim() !== '' && Number.isFinite(parsed) ? parsed : null;
      }
      if (field.kind === 'list') {
        return text.split(/[\n,，]/).map(part => part.trim()).filter(part => part !== '');
      }
      return text;
    }

    /** 状态点颜色与文案。 */
    const LINK_VIEW: Record<string, { text: string }> = {
      connected: { text: '已连接' },
      starting: { text: '连接中' },
      error: { text: '连接失败' },
      unconfigured: { text: '未配置凭据' },
      stopped: { text: '已停止' },
      unknown: { text: '状态未知' },
    };

    /**
     * 渲染一行字段。所有改动只进本地草稿，点「保存」才写回宿主。
     */
    function renderField(
      field: FieldSpec,
      snapshot: any,
      drafts: Record<string, any>,
      setDraft: (key: string, value: unknown) => void,
      onPersonaEdit: () => void,
    ): any {
      const key = draftKey(field.path);
      const edited = Object.prototype.hasOwnProperty.call(drafts, key);
      const stored = valueAt(snapshot.value, field.path);
      const disabled = snapshot.status !== 'ready' || snapshot.writable !== true;
      const label = h('span', { className: edited ? 'dqb-label dqb-dirty' : 'dqb-label', key: 'label' }, field.label);

      const frame = (control: any): any => h('div', { className: 'dqb-field', key },
        h('div', { className: 'dqb-row' }, label, control),
        field.hint === undefined ? null : h('p', { className: 'dqb-hint' }, field.hint));

      if (field.kind === 'boolean') {
        const current = edited ? drafts[key] === true : stored === true;
        return frame(h('input', {
          type: 'checkbox',
          className: 'dqb-check',
          checked: current,
          disabled,
          onChange: (event: any) => { setDraft(key, event.target.checked); },
        }));
      }

      const text = edited ? String(drafts[key] ?? '') : formatValue(field, stored);

      if (field.kind === 'select') {
        return frame(h('select', {
          className: 'dqb-input',
          value: text,
          disabled,
          onChange: (event: any) => { if (key === 'personaPrompt') onPersonaEdit(); setDraft(key, event.target.value); },
        }, (field.options ?? []).map(option => h('option', { key: option, value: option }, option))));
      }

      if (field.kind === 'list' || field.kind === 'textarea') {
        return frame(h('textarea', {
          className: field.kind === 'textarea' ? 'dqb-input dqb-textarea dqb-persona-input' : 'dqb-input dqb-textarea',
          rows: field.kind === 'textarea' ? 5 : undefined,
          value: text,
          disabled,
          spellCheck: false,
          onChange: (event: any) => { if (key === 'personaPrompt') onPersonaEdit(); setDraft(key, event.target.value); },
        }));
      }

      // 凭据与普通文本都用明文输入框：AppSecret 不回显就无从核对。
      return frame(h('input', {
        className: 'dqb-input',
        type: 'text',
        value: text,
        disabled,
        spellCheck: false,
        autoComplete: 'off',
        onChange: (event: any) => { if (key === 'personaPrompt') onPersonaEdit(); setDraft(key, event.target.value); },
      }));
    }

    function setAtPath(root: any, path: string[], value: unknown): void {
      let node = root;
      for (const key of path.slice(0, -1)) {
        if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
        node = node[key];
      }
      node[path[path.length - 1]] = value;
    }

    async function persistSettings(value: any): Promise<any> {
      const response = await fetch(SETTINGS_ROUTE, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error ?? '设置保存失败');
      return result;
    }

    /** 设置导航里的 QQ Bot 配置页。 */
    function QqbotSettingsPage(): any {
      const [snapshot, setSnapshot] = React.useState({ status: 'loading', value: {}, writable: false, mode: 'profile-file', revision: 0, error: null } as any);

      const [drafts, setDrafts] = React.useState({} as Record<string, any>);
      const [saveState, setSaveState] = React.useState({ status: 'idle', message: '' } as { status: string; message: string });
      const [link, setLink] = React.useState({ state: 'unknown', appId: '', error: null } as { state: string; appId?: string; error?: string | null });
      const [selectedPreset, setSelectedPreset] = React.useState('自定义');
      const [presetName, setPresetName] = React.useState('');
      const [connectionBusy, setConnectionBusy] = React.useState(false);
      const [selectedGroup, setSelectedGroup] = React.useState(GROUPS[0]?.title ?? '');

      React.useEffect(() => {
        let alive = true;
        void fetch(SETTINGS_ROUTE, { headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json();
            if (!response.ok) throw new Error(value?.error ?? '读取设置失败');
            if (alive) {
              setSnapshot({ status: 'ready', value, writable: true, mode: 'profile-file', revision: 0, error: null });
              const activePreset = (Array.isArray(value.personaPresets) ? value.personaPresets : [])
                .find((item: any) => item.prompt === String(value.personaPrompt ?? ''));
              setSelectedPreset(activePreset?.name ?? '自定义');
            }
          })
          .catch((error: unknown) => {
            if (alive) setSnapshot((current: any) => ({ ...current, status: 'unavailable', error: error instanceof Error ? error.message : String(error) }));
          });
        return () => { alive = false; };
      }, []);

      // 连接状态轮询：宿主半的 /api/dsh-qqbot/status。
      // 路由不存在（宿主没装 connection 服务）时一直是「状态未知」，不影响配置。
      React.useEffect(() => {
        let alive = true;
        const tick = async (): Promise<void> => {
          try {
            const response = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } });
            const body = response.ok ? await response.json() : { state: 'unknown' };
            if (alive) setLink(body !== null && typeof body === 'object' ? body : { state: 'unknown' });
          } catch {
            if (alive) setLink({ state: 'unknown' });
          }
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, STATUS_POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, []);

      const setDraft = (key: string, value: unknown): void => {
        setDrafts((current: Record<string, any>) => ({ ...current, [key]: value }));
        setSaveState({ status: 'idle', message: '' });
      };

      const saving = saveState.status === 'saving';
      const dirtyKeys = Object.keys(drafts);
      const personaPresets = Array.isArray(snapshot.value.personaPresets) ? snapshot.value.personaPresets : [];
      const selectedPrompt = Object.prototype.hasOwnProperty.call(drafts, 'personaPrompt')
        ? String(drafts.personaPrompt ?? '')
        : String(snapshot.value.personaPrompt ?? '');
      const onToggleConnection = async (): Promise<void> => {
        if (connectionBusy) return;
        const disconnect = link.state === 'connected';
        setConnectionBusy(true);
        try {
          const response = await fetch(disconnect ? DISCONNECT_ROUTE : CONNECT_ROUTE, { method: 'POST', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error('连接操作失败');
          const body = await response.json();
          if (body && typeof body === 'object') setLink(body);
        } catch (error: unknown) {
          setLink({ state: 'error', error: error instanceof Error ? error.message : String(error) });
        } finally { setConnectionBusy(false); }
      };
      const onSavePreset = async (): Promise<void> => {
        const name = presetName.trim();
        if (!name || !selectedPrompt.trim()) {
          setSaveState({ status: 'error', message: '请填写预设名称和人格提示词' });
          return;
        }
        const nextPresets = [...personaPresets.filter((item: any) => item.name !== name), { name, prompt: selectedPrompt }];
        setSaveState({ status: 'saving', message: '保存预设中…' });
        try {
          const next = JSON.parse(JSON.stringify(snapshot.value));
          setAtPath(next, ['personaPresets'], nextPresets);
          const saved = await persistSettings(next);
          setSnapshot({ ...snapshot, status: 'ready', value: saved, writable: true, error: null });
          setSelectedPreset(name);
          setPresetName('');
          setSaveState({ status: 'saved', message: selectedPrompt === String(snapshot.value.personaPrompt ?? '')
            ? '预设已保存（未应用到机器人）'
            : '预设已保存；点击“保存”后应用人格配置' });
        } catch (error: unknown) {
          setSaveState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      };
      const personaTools = h('div', { className: 'dqb-preset-tools' },
        h('select', {
          className: 'dqb-input dqb-preset-select', value: selectedPreset,
          disabled: snapshot.status !== 'ready' || snapshot.writable !== true,
          onChange: (event: any) => {
            const name = event.target.value;
            setSelectedPreset(name);
            if (name === '自定义') { setDraft('personaPrompt', ''); return; }
            const preset = personaPresets.find((item: any) => item.name === name);
            if (preset) setDraft('personaPrompt', preset.prompt);
          },
        }, [h('option', { key: 'custom', value: '自定义' }, '自定义'), ...personaPresets.map((item: any) => h('option', { key: item.name, value: item.name }, item.name))]),
        h('input', { className: 'dqb-input dqb-preset-name', type: 'text', value: presetName, placeholder: '预设名称', disabled: snapshot.status !== 'ready' || snapshot.writable !== true, onChange: (event: any) => setPresetName(event.target.value) }),
        h('button', { className: 'dqb-button dqb-preset-save', type: 'button', disabled: saving || snapshot.status !== 'ready' || snapshot.writable !== true, onClick: () => { void onSavePreset(); } }, '保存预设'));

      const personaPeers = Array.isArray(snapshot.value.personaPeers) ? snapshot.value.personaPeers : [];
      const personaOverrides = snapshot.value.personaOverrides !== null && typeof snapshot.value.personaOverrides === 'object'
        ? snapshot.value.personaOverrides
        : {};
      const peerPersonaKey = (peer: any): string => `${snapshot.value.appId}:${peer.scope}:${peer.peerId}`;
      const onPeerPersonaChange = async (peer: any, name: string): Promise<void> => {
        const next = JSON.parse(JSON.stringify(snapshot.value));
        const overrides = { ...(next.personaOverrides ?? {}) };
        const key = peerPersonaKey(peer);
        if (name === '') delete overrides[key];
        else overrides[key] = name;
        next.personaOverrides = overrides;
        setSaveState({ status: 'saving', message: '保存会话人格…' });
        try {
          const saved = await persistSettings(next);
          setSnapshot({ ...snapshot, status: 'ready', value: saved, writable: true, error: null });
          setSaveState({ status: 'saved', message: '会话人格已保存' });
        } catch (error: unknown) {
          setSaveState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      };
      const personaPeerTools = h('div', { className: 'dqb-persona-peers' },
        h('h4', { className: 'dqb-persona-peers-title' }, '按群或好友设置人格'),
        h('p', { className: 'dqb-hint' }, '这里只显示机器人已经收到过消息的会话。新群或好友发消息后会自动出现在列表中。'),
        personaPeers.length === 0
          ? h('p', { className: 'dqb-notice' }, '暂无会话记录')
          : personaPeers.map((peer: any) => h('div', {
            className: 'dqb-persona-peer',
            key: `${peer.scope}:${peer.peerId}`,
          },
            h('div', { className: 'dqb-persona-peer-info' },
              h('strong', null, peer.label),
              h('small', null, `${peer.scope === 'group' ? '群聊' : '好友'} · ${peer.peerId}`)),
            h('select', {
              className: 'dqb-input dqb-persona-peer-select',
              value: personaOverrides[peerPersonaKey(peer)] ?? '',
              disabled: saving || snapshot.status !== 'ready' || snapshot.writable !== true,
              onChange: (event: any) => { void onPeerPersonaChange(peer, event.target.value); },
            }, [
              h('option', { key: 'default', value: '' }, '跟随默认人格'),
              ...personaPresets.map((preset: any) => h('option', { key: preset.name, value: preset.name }, preset.name)),
            ]))));

      /** 把所有草稿合成一次 mutate；任一项不合法就整体不提交。 */
      const onSave = async (): Promise<void> => {
        const ops: any[] = [];
        for (const key of dirtyKeys) {
          const field = FIELDS_BY_KEY.get(key);
          if (field === undefined) continue;
          const parsed = parseInput(field, drafts[key]);
          if (parsed === null) {
            setSaveState({ status: 'error', message: `${field.label} 的值不合法，未提交` });
            return;
          }
          ops.push({ op: 'set', path: field.path, value: parsed });
        }
        if (ops.length === 0) return;

        setSaveState({ status: 'saving', message: '保存中…' });
        try {
          const next = JSON.parse(JSON.stringify(snapshot.value));
          for (const op of ops) setAtPath(next, op.path, op.value);
          const saved = await persistSettings(next);
          setSnapshot({ ...snapshot, status: 'ready', value: saved, writable: true, error: null });
          setDrafts({});
          setSaveState({ status: 'saved', message: `已保存（${new Date().toLocaleTimeString()}）` });
        } catch (error: unknown) {
          setSaveState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      };

      const view = LINK_VIEW[link.state] ?? LINK_VIEW.unknown;
      const detail = link.state === 'connected' && link.appId ? `（${link.appId}）` : '';
      const linkError = link.state === 'error' && link.error ? `：${link.error}` : '';

      const toolbar = h('div', { className: 'dqb-toolbar' },
        h('span', { className: 'dqb-status', title: link.state },
          h('span', { className: `dqb-dot dqb-dot-${link.state}` }),
          h('span', null, `${view.text}${detail}`)),
        linkError === '' ? null : h('span', { className: 'dqb-status-detail' }, linkError),
        h('button', {
          className: 'dqb-button dqb-button-primary', type: 'button',
          disabled: connectionBusy || link.state === 'starting' || link.state === 'unknown' || link.state === 'unconfigured',
          onClick: () => { void onToggleConnection(); },
        }, connectionBusy || link.state === 'starting' ? '连接中…' : (link.state === 'connected' ? '断开' : '连接')),
        h('span', { className: 'dqb-spacer' }),
        saveState.message === '' ? null : h('span', { className: `dqb-save dqb-save-${saveState.status}` }, saveState.message),
        h('button', {
          className: 'dqb-button',
          type: 'button',
          disabled: dirtyKeys.length === 0 || saving,
          onClick: () => { setDrafts({}); setSaveState({ status: 'idle', message: '' }); },
        }, '撤销'),
        h('button', {
          className: 'dqb-button dqb-button-primary',
          type: 'button',
          disabled: dirtyKeys.length === 0 || saving,
          onClick: () => { void onSave(); },
        }, saving ? '保存中…' : (dirtyKeys.length === 0 ? '保存' : `保存 (${dirtyKeys.length})`)));

      const activeGroup = GROUPS.find(group => group.title === selectedGroup) ?? GROUPS[0];
      const categoryTabs = h('nav', { className: 'dqb-category-tabs', 'aria-label': 'QQ Bot 设置分类' },
        GROUPS.map(group => h('button', {
          className: group.title === activeGroup.title ? 'dqb-category-tab dqb-category-tab-active' : 'dqb-category-tab',
          type: 'button',
          key: group.title,
          'aria-current': group.title === activeGroup.title ? 'page' : undefined,
          onClick: () => setSelectedGroup(group.title),
        }, group.title)));

      const body = snapshot.status !== 'ready' || activeGroup === undefined
        ? null
        : h('section', { className: 'dqb-group', key: activeGroup.title },
          h('h3', { className: 'dqb-group-title' },
             activeGroup.title,
             activeGroup.title === '凭据'
               ? h('a', {
                 className: 'dqb-credential-link',
                 href: 'https://q.qq.com/qqbot/openclaw/login.html',
                 target: '_blank',
                 rel: 'noopener noreferrer',
               }, '获取凭据')
               : null),
          activeGroup.title === '人格配置' ? personaTools : null,
          activeGroup.fields.map(field => renderField(field, snapshot, drafts, setDraft, () => setSelectedPreset('自定义'))),
          activeGroup.title === '人格配置' ? personaPeerTools : null);

      const notice = snapshot.status === 'loading'
        ? h('p', { className: 'dqb-notice' }, '正在读取配置…')
        : snapshot.status === 'unavailable'
          ? h('p', { className: 'dqb-notice' }, '无法读取 QQ Bot 独立配置文件；请确认插件已启用且 profile 目录可写。')
          : snapshot.error !== null
            ? h('p', { className: 'dqb-notice dqb-error' }, String(snapshot.error))
            : null;

      // 功能级错误（预设挂载失败、会话创建失败）：连接可能正常，但这条要说清楚。
      const runtimeError = link.lastError
        ? h('p', { className: 'dqb-notice dqb-error' }, `最近一次功能错误：${link.lastError}`)
        : null;

      return h('div', { className: 'dqb-page' },
        h('style', null, CSS),
        h('div', { className: 'dqb-sticky-header' },
          toolbar,
          categoryTabs),
        h('p', { className: 'dqb-meta' }, '全部 QQ Bot 配置保存在 profile 目录下的 dsh-qqbot-settings.json。'),
        runtimeError,
        notice,
        body);
    }

    /**
     * 注册设置页，并在宿主提供该 namespace 期间保持注册。
     * 整段包在 try/catch 里：客户端半失败只是少一个设置页，不允许影响外壳。
     */
    function apply(ctx: any): void {
      try {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qqbot',
          order: ORDER,
          label: () => 'QQ Bot',
        }, QqbotSettingsPage)), 'im-qqbot: settings page');
      } catch (error: unknown) {
        console.error('[im-qqbot] 设置页注册失败（已隔离，不影响外壳）:', error);
      }
    }

    return { inject, apply };
  },
});
})();
