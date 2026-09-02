// 和同步后端说话的唯一出口。上面的 docs.ts / session.ts 都只用这里的三个东西：
// syncFetch、三种错误类型。
//
// 错误分三类是因为**调用方对它们的反应完全不同**：
//   SyncAuthError     → 会话没了，要请用户重新登录（不能默默重试，重试一万次也是 401）
//   SyncConflictError → 远端更新了，按 §2.4 合并后重推（正常流程的一部分，不是故障）
//   其余 SyncApiError / 网络错误 → 进队列，等网络恢复再试（FR-11.10）

import { SYNC_API_BASE } from './config';

export class SyncApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

/** 401：令牌过期、被撤销，或账号已被移出服务器白名单。 */
export class SyncAuthError extends SyncApiError {
  constructor(message: string) {
    super(401, message);
    this.name = 'SyncAuthError';
  }
}

/** 409：远端版本比本地记的新。body 是远端现值，直接拿去合并，不用再 GET 一次。 */
export class SyncConflictError extends SyncApiError {
  constructor(
    readonly version: number,
    readonly body: unknown,
  ) {
    super(409, '远端有更新的版本');
    this.name = 'SyncConflictError';
  }
}

export interface SyncRequestOptions {
  method?: 'GET' | 'PUT' | 'POST' | 'DELETE';
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
}

interface ErrorBody {
  error?: string;
  code?: string;
  version?: number;
  body?: unknown;
}

/**
 * 发一次请求并解析 JSON。2xx 之外一律抛错 —— 让「失败」永远是异常，
 * 而不是一个调用方可能忘了检查的返回值（静默失败的备份比没有备份更危险）。
 */
export async function syncFetch<T>(path: string, options: SyncRequestOptions = {}): Promise<T> {
  const { method = 'GET', body, token, signal } = options;

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${SYNC_API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (response.ok) return (await response.json()) as T;

  const payload = (await response.json().catch(() => ({}))) as ErrorBody;
  if (response.status === 409) {
    throw new SyncConflictError(payload.version ?? 0, payload.body);
  }
  if (response.status === 401) {
    throw new SyncAuthError(payload.error ?? '会话已过期，请重新登录');
  }
  throw new SyncApiError(response.status, payload.error ?? `请求失败：HTTP ${response.status}`);
}
