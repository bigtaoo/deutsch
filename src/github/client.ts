// 附录 B.1：api.github.com 对所有请求（含 401）都带 Access-Control-Allow-Origin: *，
// 浏览器可以直连，不需要代理。这个文件是唯一知道 base URL 和鉴权头格式的地方。

export const GITHUB_API_BASE = 'https://api.github.com';

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export async function githubRequest(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init.headers,
    },
  });
}

export async function githubRequestJson<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await githubRequest(path, token, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(res.status, `GitHub API ${res.status} ${path}: ${body || res.statusText}`);
  }
  return (await res.json()) as T;
}
