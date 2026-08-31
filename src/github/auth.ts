// FR-11.2 / FR-11.5：粘贴 token 后自动识别账号 + 监控过期。

import { githubRequest, GitHubApiError } from './client';

export interface GitHubIdentity {
  login: string;
  avatarUrl: string;
}

export interface TokenExpiryInfo {
  /** null = 无法从响应头解析出过期时间（见下方注释） */
  expiresAt: Date | null;
}

/**
 * 附录 B.2 标记为"待实现时确认"：fine-grained PAT 过期时间具体走哪个响应头，
 * 没有真实 PAT 无法实测。这里先按 GitHub 文档记录的候选名解析；
 * 拿到真实 token 联调时如果实测出不同的头名，只需要改这个数组，不用动调用方。
 * 解析不到就返回 null 而不是抛错 —— 这只是"续期提醒"这个次要功能失效，
 * 不该因为一个不确定的细节挡住整条连接流程（FR-11.2/11.3 仍要能走通）。
 */
const CANDIDATE_EXPIRY_HEADERS = [
  'github-authentication-token-expiration',
  'x-github-authentication-token-expiration',
];

export async function verifyToken(
  token: string,
): Promise<{ identity: GitHubIdentity; expiry: TokenExpiryInfo }> {
  const res = await githubRequest('/user', token);

  if (res.status === 401) {
    throw new GitHubApiError(401, 'Token 无效或已过期');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(res.status, `GitHub API ${res.status}: ${body || res.statusText}`);
  }

  const data = (await res.json()) as { login: string; avatar_url: string };

  let expiresAt: Date | null = null;
  for (const header of CANDIDATE_EXPIRY_HEADERS) {
    const value = res.headers.get(header);
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      expiresAt = parsed;
      break;
    }
  }

  return { identity: { login: data.login, avatarUrl: data.avatar_url }, expiry: { expiresAt } };
}

export function daysUntilExpiry(expiresAt: Date, now: Date = new Date()): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay);
}

/** FR-11.5：剩余 30 天起提醒续期。 */
export function shouldWarnAboutExpiry(expiresAt: Date | null, now?: Date): boolean {
  if (!expiresAt) return false;
  return daysUntilExpiry(expiresAt, now) <= 30;
}
