import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `public/_headers` 是 Cloudflare 读的响应头规则（原样拷进 dist/_headers）。
//
// 变更 60：原生壳的 origin 是 `capacitor://localhost`，取 /ota/manifest.json 是跨域，
// 没有放行头时热更整个停摆 —— 而网页版同源，对此毫无感觉，本地任何一条测试也不会红。
// deploy.yml 在发布**之后**会去线上查一次；这里在**推之前**就守住规则本身。
// 取 manifest 的 URL 与请求形状由 nativeUpdate.test.ts 那条「简单请求」用例守着，两边合起来
// 才是完整的一条：代码去取的路径，正好被这份规则放行。

type Rule = { pattern: string; headers: Record<string, string> };

/** 按 Cloudflare `_headers` 的格式解析：顶格一行是路径，缩进行是 `名: 值`，`#` 开头是注释。 */
function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: {} });
      continue;
    }
    const rule = rules.at(-1);
    const m = /^\s+([^:]+):\s*(.*)$/.exec(raw);
    if (!rule || !m) throw new Error(`_headers 里有一行解析不了：${JSON.stringify(raw)}`);
    rule.headers[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return rules;
}

/** `*` 匹配任意字符（Cloudflare 的 splat），其余按字面比。 */
function matches(pattern: string, path: string): boolean {
  // 按 `*` 切开，各段依次顺序出现：首段贴着开头、末段贴着结尾。
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === path;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!path.startsWith(first) || !path.endsWith(last) || path.length < first.length + last.length) return false;
  let at = first.length;
  for (const mid of parts.slice(1, -1)) {
    const i = path.indexOf(mid, at);
    if (i < 0 || i + mid.length > path.length - last.length) return false;
    at = i + mid.length;
  }
  return true;
}

function headersFor(rules: Rule[], path: string): Record<string, string> {
  return Object.assign({}, ...rules.filter((r) => matches(r.pattern, path)).map((r) => r.headers));
}

const rules = parseHeaders(readFileSync(resolve(process.cwd(), 'public/_headers'), 'utf8'));

describe('public/_headers', () => {
  it('热更 manifest 对任何 origin 放行 —— 手机壳是 capacitor://localhost', () => {
    expect(headersFor(rules, '/ota/manifest.json')['access-control-allow-origin']).toBe('*');
  });

  it('放行的是 `*` 就不能同时声明允许凭据（浏览器会整个拒收）', () => {
    const h = headersFor(rules, '/ota/manifest.json');
    expect(h['access-control-allow-credentials']).toBeUndefined();
  });

  it('规则只圈 /ota/，不把整站都放开', () => {
    expect(headersFor(rules, '/index.html')['access-control-allow-origin']).toBeUndefined();
    expect(headersFor(rules, '/')['access-control-allow-origin']).toBeUndefined();
  });

  it('解析器自己：认得注释、splat，读不懂的行直接报错而不是静默跳过', () => {
    expect(parseHeaders('# x\n/a/*\n  X-Y: 1\n')).toEqual([{ pattern: '/a/*', headers: { 'x-y': '1' } }]);
    expect(matches('/a/*', '/a/b/c')).toBe(true);
    expect(matches('/a/*', '/ab')).toBe(false);
    expect(() => parseHeaders('/a\n  broken\n')).toThrow();
  });
});
