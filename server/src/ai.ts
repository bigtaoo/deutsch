// AI 补充解释（FR-9.11 / FR-9.12，2026-09-22 从「复制走 → 在外面问 → 粘回来」
// 改成服务器端实时调用）。
//
// ── 为什么现在可以接 API，之前不行 ──
// 手动剪贴板那条路存在的唯一理由是「没有自己的 API key」（见 KICKOFF 与 SPEC 变更记录）。
// 有了 key 之后，剪贴板那几步（复制、切到另一个会话、粘贴、对编号）全是纯摩擦，
// 换成一次服务器转发的 HTTP 请求。**这不违反 §3.1.1 R-1**：R-1 管的是「谁把 DW /
// Wiktionary 那类受版权的第三方内容转手了一遍」，而这里没有任何第三方素材经过这台服务器——
// 请求体只有用户自己敲的词/句，回复是模型生成的解释，不是任何人的版权作品的复制件。
//
// ── 为什么用 Haiku 而不是更贵的模型 ──
// 解释一个词或一句话不需要强推理能力，Haiku 够用且便宜。模型名留成配置项，
// 而不是写死，是因为「便宜模型」这件事本身会随时间变化（见 config.ts）。
//
// ── 失败即抛错，不在这里兜底成一段话 ──
// 调用方（app.ts 的路由）决定失败之后回什么状态码；这里只负责「成功就给一段干净的文本，
// 不成功就抛」，抛出的 message 允许直接展示给用户（不含 key、不含堆栈）。

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface AiExplainInput {
  /** 要解释的德语词或短句，已经 trim 过。 */
  word: string;
  /** 原句语境，如果有的话。 */
  context?: string;
  /** 词典已经给出的释义（内置词典 / de.wiktionary），有的话让模型别重复、只补充或纠偏。 */
  existing?: string;
}

export interface AiExplainer {
  explain(input: AiExplainInput): Promise<string>;
}

/**
 * 提示词。三条硬性要求都是踩过坑之后写清楚的：
 *   · 中文回复 —— 用户是中文母语，之前手动流程默认就是中文，不能因为改自动就变回英文；
 *   · 不认识就说不认识 —— 查词面板的「查不到」多半是生僻复合词或拼写错误，
 *     模型硬编一个解释比说「不知道」更糟：用户会把编出来的东西当真记下来；
 *   · 不写前言客套 —— 这段文本直接进 `VocabEntry.note`，原样显示在生词本列表里，
 *     「好的，我来为您解释」这种开场白会在每一条笔记前面重复出现。
 */
function buildPrompt({ word, context, existing }: AiExplainInput): string {
  const lines = [
    '你在帮一个中文母语、德语 C1 水平的学习者理解一个德语词或短句。',
    '直接给出讲解，不要开场白、不要总结语、不要客套（如「好的」「以下是」）。',
    '用中文回答。内容包括（视情况取舍，不要写不适用的项）：',
    '- 准确的意思：如果下面给了原句，按那个语境讲；没有原句就给最常见的意思',
    '- 和最容易混淆的近义词的区别（如果确实有容易混的近义词）',
    '- 常见搭配或固定用法',
    '- 名词给性和复数；动词给支配的介词和格',
    '- 如果合适，给一个简短的德语例句并附中文翻译',
    '',
    '如果这不是一个你能确认的德语词或短语（比如像是拼写错误、不是德语、或者你根本不认识），',
    '直接说明「这看起来不是一个常见的德语词，建议检查拼写」，不要编造解释。',
    '',
    `要讲解的内容：「${word}」`,
  ];
  if (context) lines.push(`出现的原句：${context}`);
  if (existing) lines.push(`词典已经给出的释义（不用重复，可以补充或纠偏）：${existing}`);
  return lines.join('\n');
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export function createAiExplainer(apiKey: string, model: string): AiExplainer {
  return {
    async explain(input: AiExplainInput): Promise<string> {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          messages: [{ role: 'user', content: buildPrompt(input) }],
        }),
      });

      if (!res.ok) {
        // 不把上游原文透传给客户端：可能带账单/额度相关的细节。
        throw new Error(`AI 接口返回 HTTP ${res.status}`);
      }

      const data = (await res.json()) as MessagesResponse;
      const text = data.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
      if (!text) throw new Error('AI 接口没有返回文本');
      return text;
    },
  };
}
