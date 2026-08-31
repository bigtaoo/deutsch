// FR-11.8：sha 做乐观并发令牌；409 时不静默覆盖 —— 拉远端、合并、重推。

import { githubRequest, GitHubApiError } from './client';
import { encodeBase64Utf8, decodeBase64Utf8 } from '@/lib/base64';
import type { RepoRef } from './repo';

export interface RemoteFile {
  content: string;
  sha: string;
}

export async function getFile(token: string, ref: RepoRef, path: string): Promise<RemoteFile | null> {
  const res = await githubRequest(`/repos/${ref.owner}/${ref.repo}/contents/${path}`, token);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(res.status, `读取 ${path} 失败：${res.status} ${body}`);
  }
  const data = (await res.json()) as { content: string; sha: string; encoding: string };
  const content = data.encoding === 'base64' ? decodeBase64Utf8(data.content) : data.content;
  return { content, sha: data.sha };
}

/** 收到 409 时被调用一次：拿到远端最新内容，返回"合并后应该写回的内容"。 */
export type ConflictResolver = (remoteContent: string) => string | Promise<string>;

export interface PutFileOptions {
  message: string;
  sha?: string;
  onConflict?: ConflictResolver;
}

export interface PutFileResult {
  sha: string;
}

export async function putFile(
  token: string,
  ref: RepoRef,
  path: string,
  content: string,
  opts: PutFileOptions,
): Promise<PutFileResult> {
  const res = await githubRequest(`/repos/${ref.owner}/${ref.repo}/contents/${path}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: opts.message,
      content: encodeBase64Utf8(content),
      sha: opts.sha,
    }),
  });

  if (res.status === 409 && opts.onConflict) {
    const remote = await getFile(token, ref, path);
    const resolvedContent = await opts.onConflict(remote?.content ?? '');
    // 合并后只重试一次：如果这次还冲突，说明有并发写入在飞速抢占，抛错比死循环重试更安全。
    return putFile(token, ref, path, resolvedContent, { message: opts.message, sha: remote?.sha });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GitHubApiError(res.status, `写入 ${path} 失败：${res.status} ${body}`);
  }

  const data = (await res.json()) as { content: { sha: string } };
  return { sha: data.content.sha };
}
