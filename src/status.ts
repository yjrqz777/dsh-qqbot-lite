/**
 * QQ 网关运行状态
 *
 * 设置页顶部的状态圆点读它。状态只存在进程内：
 * - 写入方：src/index.ts（启动/停止/失败）与网关回报的 ready/error 事件。
 * - 读取方：浏览器半通过 `GET /api/dsh-qqbot/status` 轮询（见 src/index.ts 注册的路由）。
 *
 * 这里的方法不允许抛出：状态本身出问题绝不能影响插件启动。
 */

/** 连接状态取值。 */
export type QqbotConnectionState =
  /** 没填 AppID / AppSecret。 */
  | 'unconfigured'
  /** 正在建立连接。 */
  | 'starting'
  /** 已连上 QQ。 */
  | 'connected'
  /** 启动失败或连接报错。 */
  | 'error'
  /** 网关已停止（配置变更、插件卸载等）。 */
  | 'stopped';

/** 状态快照（JSON 可序列化，直接作为路由响应体）。 */
export interface QqbotStatusSnapshot {
  /** 当前状态。 */
  state: QqbotConnectionState;
  /** 当前生效的 AppID；空串表示未配置。 */
  appId: string;
  /** 进入当前状态的时间戳(ms)。 */
  since: number;
  /** 最近一次错误信息；无错误为 null。 */
  error: string | null;
  /**
   * 最近一次「不影响连接、但影响功能」的错误（预设挂载失败、会话创建失败等）。
   * 与 `error` 分开：连接正常时状态点仍是绿的，页面上单独显示这条。
   */
  lastError: string | null;
}

/** 进程内状态持有者。 */
export class QqbotStatus {
  private value: QqbotStatusSnapshot = {
    state: 'unconfigured', appId: '', since: Date.now(), error: null, lastError: null,
  };

  /** 读当前快照。 @returns 状态快照副本。 */
  get(): QqbotStatusSnapshot {
    return { ...this.value };
  }

  /**
   * 更新状态；状态不变时保留原 `since`，避免轮询看到时间被反复刷新。
   * @param next 要覆盖的字段，未给出的沿用旧值。
   */
  set(next: Partial<QqbotStatusSnapshot>): void {
    const state = next.state ?? this.value.state;
    const since = state === this.value.state ? this.value.since : Date.now();
    this.value = { ...this.value, ...next, state, since };
  }
}
