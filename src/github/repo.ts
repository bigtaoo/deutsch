// FR-11.3 / FR-11.4：一键创建备份仓库 + 校验 private 与写权限。
// 用户不需要手填 owner/repo，也不需要离开应用去 GitHub 建仓库。

import { githubRequest, githubRequestJson, GitHubApiError } from './client';
import { encodeBase64Utf8 } from '@/lib/base64';

export interface RepoRef {
  owner: string;
  repo: string;
  defaultBranch: string;
}

interface GitHubRepoResponse {
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
}

export async function listPrivateRepos(token: string): Promise<RepoRef[]> {
  const repos = await githubRequestJson<GitHubRepoResponse[]>(
    '/user/repos?visibility=private&per_page=100&sort=updated',
    token,
  );
  return repos.filter((r) => r.private).map(toRepoRef);
}

export async function createBackupRepo(token: string, name: string): Promise<RepoRef> {
  const data = await githubRequestJson<GitHubRepoResponse>('/user/repos', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, private: true, auto_init: true }),
  });
  if (!data.private) {
    // 不应该发生：我们显式传了 private:true。但如果 GitHub 一天改了默认行为，
    // 绝不能让一个 public 仓库悄悄成为备份目的地（§2.6.7）。
    throw new Error(`创建的仓库 "${name}" 不是 private，已中止`);
  }
  return toRepoRef(data);
}

function toRepoRef(data: GitHubRepoResponse): RepoRef {
  return { owner: data.owner.login, repo: data.name, defaultBranch: data.default_branch };
}

export interface RepoVerification {
  private: boolean;
  writable: boolean;
  reason?: string;
}

/** FR-11.4：仓库存在、为 private、token 确实可写（试写一个 .keep 验证）。 */
export async function verifyRepo(token: string, ref: RepoRef): Promise<RepoVerification> {
  const repoRes = await githubRequest(`/repos/${ref.owner}/${ref.repo}`, token);
  if (repoRes.status === 404) {
    return { private: false, writable: false, reason: '仓库不存在或 token 看不到它' };
  }
  if (!repoRes.ok) {
    throw new GitHubApiError(repoRes.status, `校验仓库失败：${repoRes.status}`);
  }
  const repoData = (await repoRes.json()) as { private: boolean };
  if (!repoData.private) {
    return { private: false, writable: false, reason: '仓库不是 private（备份含正文，不能公开，见 §2.6.7）' };
  }

  // .keep 可能是上次校验时已经建过的：先探测 sha，避免重复校验时因缺 sha 被 GitHub 拒绝（422）。
  const existing = await githubRequest(`/repos/${ref.owner}/${ref.repo}/contents/.keep`, token);
  const existingSha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const writeRes = await githubRequest(`/repos/${ref.owner}/${ref.repo}/contents/.keep`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'chore: verify write access',
      content: encodeBase64Utf8(''),
      sha: existingSha,
    }),
  });

  if (writeRes.status === 403 || writeRes.status === 404) {
    return {
      private: true,
      writable: false,
      reason: 'Token 没有写权限，需要 fine-grained PAT 的 Contents: Read and write',
    };
  }
  if (!writeRes.ok) {
    const body = await writeRes.text().catch(() => '');
    return { private: true, writable: false, reason: `写入校验失败：${writeRes.status} ${body}` };
  }

  return { private: true, writable: true };
}
