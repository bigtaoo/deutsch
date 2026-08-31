/**
 * `crypto.randomUUID` 在多数现代浏览器里可用，但部分测试环境（jsdom 的旧版本）
 * 不提供它。这里做一个不依赖它的兜底，保证任何环境下都能生成够用的本地唯一 id。
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
