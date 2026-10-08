/**
 * dsh-qqbot 浏览器半：在「设置」导航里注册 QQ Bot 配置页（order 90）。
 *
 * 本文件是**经典脚本**，不是模块：没有 import、没有 export，`tsc` 按原样输出
 * 成 lazy-CJS factory，由浏览器的模块表加载。产物必须满足：
 *   window.__ModuleLoader__.load({ id: '<包名>', factory(require) { ... } })
 * `id` 必须是包名（@tencent-connect/dsh-qqbot），否则该 Loader 行等不到注册。
 *
 * 配置读写不经过任何自有协议：页面用 dsh 的 settings 服务
 * （ctx.configForms）读写本插件在 profile 里的那一行 config，落盘、校验、
 * 乐观锁与热更新都由宿主负责。namespace 就是插件行的 id（im-qqbot）。
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
  init?: { headers?: Record<string, string> },
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
const ORDER = 90;

/** 宿主半注册的连接状态路由（文档相对路径，与 src/index.ts 的常量对应）。 */
const STATUS_ROUTE = 'api/dsh-qqbot/status';

/** 状态轮询间隔(ms)。 */
const STATUS_POLL_MS = 5000;

/** 透传标签：只为让编辑器把下面的块高亮成 CSS。 */
const css = (strings: TemplateStringsArray): string => strings.join('');

/**
 * 页面自带样式：一行一条规则，类名统一带 dqb- 前缀避免与宿主冲突，
 * 颜色只在状态点上写死（用户要求的绿点），其余用 --dsw-alias-* 主题 token。
 */
const CSS = css`
.dqb-page { display: flex; flex-direction: column; gap: 20px; max-width: 640px; padding: 16px 0; }
.dqb-toolbar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 10px 0; background: var(--dsw-alias-bg-base, transparent); border-bottom: 0.5px solid var(--dsw-alias-border-l1); }
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
.dqb-group { display: flex; flex-direction: column; gap: 8px; }
.dqb-group-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dqb-field { display: flex; flex-direction: column; gap: 4px; }
.dqb-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.dqb-label { flex: 0 0 168px; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.dqb-dirty { color: var(--dsw-alias-state-business-primary); }
.dqb-input { flex: 1 1 auto; min-width: 0; min-height: 28px; padding: 4px 8px; font: inherit; font-size: 13px; line-height: 18px; color: inherit; background: transparent; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 6px; }
.dqb-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dqb-input:disabled { opacity: 0.5; }
.dqb-textarea { min-height: 56px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.dqb-check { flex: 0 0 auto; width: 16px; height: 16px; }
.dqb-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
`;

/** 一个可编辑字段：path 与 Config schema 中的固定路径一一对应。 */
interface FieldSpec {
  readonly path: string[];
  readonly label: string;
  readonly kind: 'text' | 'number' | 'boolean' | 'select' | 'list';
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
  id: '@tencent-connect/dsh-qqbot',
  factory(require) {
    // 依赖加载失败只让本插件的设置页消失，绝不把整个外壳带下水：
    // 返回一个什么都不做的插件，外壳照常启动。
    let React: {
      createElement: CreateElement;
      useState: (init: any) => [any, (next: any) => void];
      useEffect: (fn: () => void, deps: any[]) => void;
    };
    let createSnapshotStore: (init: any) => { getSnapshot(): any; set(next: any): void; subscribe(fn: () => void): () => void };
    try {
      React = require('react');
      createSnapshotStore = require('@deepseek-ai/dsh-client-store').createSnapshotStore;
    } catch (error: unknown) {
      console.error('[im-qqbot] 客户端半依赖加载失败（已隔离，不影响外壳）:', error);
      return { inject: [], apply(): void {} };
    }
    const h = React.createElement;
    const inject = ['slots', 'configForms'];

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

    /**
     * 表单控制器：把 configForms 的共享表单投影成页面可订阅的快照，
     * 并把一次「保存」排队成一次 mutate（单次写入 = 单次 revision 校验）。
     */
    function createController(form: any) {
      const store = createSnapshotStore({
        status: 'loading', value: {}, writable: false, mode: 'memory', revision: 0, error: null,
      });

      const sync = (): void => {
        const snapshot = form.getSnapshot();
        store.set({
          status: snapshot.status,
          value: snapshot.value ?? {},
          writable: snapshot.writable,
          mode: snapshot.mode,
          revision: snapshot.revision ?? 0,
          error: null,
        });
      };
      const off = form.subscribe(sync);
      sync();

      const fail = (message: string): false => {
        store.set({ ...store.getSnapshot(), error: message });
        return false;
      };

      const mutate = async (ops: any[]): Promise<boolean> => {
        try {
          const accepted = await form.mutate(ops);
          return accepted === true
            ? true
            : fail('宿主拒绝了这次保存（配置可能已被别处改动），页面已回到最新值。');
        } catch (error: unknown) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      };

      return { store, mutate, dispose: (): void => { off(); } };
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
          onChange: (event: any) => { setDraft(key, event.target.value); },
        }, (field.options ?? []).map(option => h('option', { key: option, value: option }, option))));
      }

      if (field.kind === 'list') {
        return frame(h('textarea', {
          className: 'dqb-input dqb-textarea',
          value: text,
          disabled,
          spellCheck: false,
          onChange: (event: any) => { setDraft(key, event.target.value); },
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
        onChange: (event: any) => { setDraft(key, event.target.value); },
      }));
    }

    /** 设置导航里的 QQ Bot 配置页。 */
    function QqbotSettingsPage(props: any): any {
      // 渲染器绑定的 use<Name> 是 uSES 选择器 hook，selector 必填
      // （ui-renderer 的 bindSnapshotSelector 直接把它交给
      // useSyncExternalStoreWithSelector）。恒等选择器即取整份快照。
      const snapshot = props.useQqbotSettings((state: any) => state);
      const save = props.mutateQqbotSettings as (ops: any[]) => Promise<boolean>;

      const [drafts, setDrafts] = React.useState({} as Record<string, any>);
      const [saveState, setSaveState] = React.useState({ status: 'idle', message: '' } as { status: string; message: string });
      const [link, setLink] = React.useState({ state: 'unknown', appId: '', error: null } as { state: string; appId?: string; error?: string | null });

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

      const dirtyKeys = Object.keys(drafts);
      const saving = saveState.status === 'saving';

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
        const accepted = await save(ops);
        if (accepted) {
          setDrafts({});
          setSaveState({ status: 'saved', message: `已保存（${new Date().toLocaleTimeString()}）` });
        } else {
          setSaveState({ status: 'error', message: '保存被拒绝，见下方提示' });
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

      const body = snapshot.status !== 'ready'
        ? null
        : GROUPS.map(group => h('section', { className: 'dqb-group', key: group.title },
          h('h3', { className: 'dqb-group-title' }, group.title),
          group.fields.map(field => renderField(field, snapshot, drafts, setDraft))));

      const notice = snapshot.status === 'loading'
        ? h('p', { className: 'dqb-notice' }, '正在读取配置…')
        : snapshot.status === 'unavailable'
          ? h('p', { className: 'dqb-notice' }, '宿主未提供 im-qqbot 的配置表单（插件未启用，或该行配置被 home patch / --patch 覆盖）。')
          : snapshot.error !== null
            ? h('p', { className: 'dqb-notice dqb-error' }, String(snapshot.error))
            : null;

      // 功能级错误（预设挂载失败、会话创建失败）：连接可能正常，但这条要说清楚。
      const runtimeError = link.lastError
        ? h('p', { className: 'dqb-notice dqb-error' }, `最近一次功能错误：${link.lastError}`)
        : null;

      return h('div', { className: 'dqb-page' },
        h('style', null, CSS),
        toolbar,
        h('p', { className: 'dqb-meta' }, `改动先存在页面上，点「保存」写回 profile 的 cordis.patch.yml 并即时生效（mode: ${snapshot.mode}）。`),
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
        const controller = createController(ctx.configForms.get(NS));
        ctx.effect(() => () => { controller.dispose(); }, 'im-qqbot: settings form subscription');
        ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'qqbot',
          order: ORDER,
          label: () => 'QQ Bot',
          inject: () => ({
            hooks: { qqbotSettings: controller.store },
            mutateQqbotSettings: controller.mutate,
          }),
        }, QqbotSettingsPage))), 'im-qqbot: settings page');
      } catch (error: unknown) {
        console.error('[im-qqbot] 设置页注册失败（已隔离，不影响外壳）:', error);
      }
    }

    return { inject, apply };
  },
});
})();
