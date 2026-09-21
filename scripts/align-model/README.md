# 对齐模型的两个配置文件

这两份是 `oliverguhr/wav2vec2-large-xlsr-53-german-cv9` 的 `onnx/config.json` 与
`onnx/preprocessor_config.json`，**入库是刻意的**：权重（230MB）不进 git，但这两份加起来
2.5KB，而它们里面有一处**我们自己改过**的地方，必须跟着代码走版本。

改的那一处：`preprocessor_config.json` 里删掉了

```json
"processor_class": "Wav2Vec2ProcessorWithLM"
```

原因：transformers.js 的 `AutoProcessor.from_pretrained` 认这个字段，认出来之后会连着
去加载 **tokenizer**（`tokenizer.json` / `tokenizer_config.json`）和那套 n-gram 语言模型。
那个仓库里根本没有 `tokenizer.json`，于是取件落到 SPA fallback 上、拿回一份 index.html，
报错是 `Unexpected token '<', "<!doctype "... is not valid JSON` —— 和「权重没放好」
长得一模一样，实际原因却完全不同（2026-09-21 踩过一次）。

而我们**本来就不需要 tokenizer**：文本这一侧是 `src/align/vocab.ts` 自己做的
（词表内联 + 词分隔符 `|`），处理器只用来把波形归一化。删掉这个字段之后
`AutoProcessor` 只按 `feature_extractor_type` 建一个 `Wav2Vec2FeatureExtractor`，正合需要。

`npm run stage:align` 从这里拷这两份（**不从 HF 下**，否则那个字段会回来）。
权重站（服务器 `/v1/align/weights/`）上的那两份也必须是这里这一份。
