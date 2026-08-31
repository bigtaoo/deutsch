// §7.8：从 DW 页面 HTML 里截出 `window.__APOLLO_STATE__`。
//
// 它是 `window.__APOLLO_STATE__={...}` 形式的内联 JS，不是 <script type="application/json">，
// 所以拿不到现成的 JSON。用**字符串感知的大括号配平**从 `={` 扫到匹配的 `}`。
// 不要用贪婪正则：正文里有的是 `}`，也有的是引号里的 `{`。

export interface ApolloState {
  [key: string]: unknown;
}

export class ApolloParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApolloParseError';
  }
}

const MARKER = '__APOLLO_STATE__';

/** 从 `{` 开始扫到配平的 `}`，返回结束位置的下一个下标。 */
function findBalancedEnd(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new ApolloParseError('__APOLLO_STATE__ 的大括号没有配平，页面结构可能变了');
}

export function extractApolloState(html: string): ApolloState {
  const marker = html.indexOf(MARKER);
  if (marker === -1) {
    throw new ApolloParseError('页面里找不到 __APOLLO_STATE__ —— DW 很可能改版了（附录 A.3 失效）');
  }
  const braceStart = html.indexOf('{', marker);
  if (braceStart === -1) throw new ApolloParseError('__APOLLO_STATE__ 后面没有对象字面量');

  const json = html.slice(braceStart, findBalancedEnd(html, braceStart));
  try {
    return JSON.parse(json) as ApolloState;
  } catch (err) {
    throw new ApolloParseError(`__APOLLO_STATE__ 不是合法 JSON：${err instanceof Error ? err.message : err}`);
  }
}

/** Apollo 的引用形状：`{ "__ref": "Knowledge:123" }`。 */
export function derefKey(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && '__ref' in value) {
    const ref = (value as { __ref: unknown }).__ref;
    return typeof ref === 'string' ? ref : null;
  }
  return null;
}

/** 按类型前缀找实体键，如 findKeys(state, 'Audio') → ['Audio:78400094']。 */
export function findKeys(state: ApolloState, type: string): string[] {
  return Object.keys(state).filter((key) => key.startsWith(`${type}:`));
}
