# deutsch-align-native

自动对齐（FR-15）**前半截**的原生实现：音频 → 帧级 log-prob。iOS only。

它不是一个可复用的库，是这个仓库的一块原生代码；做成 npm 包只是因为
**Capacitor 只认这一种形状** —— `ios/App/CapApp-SPM/Package.swift` 由
`npx cap sync ios` 按 `package.json` 里装了哪些插件重写（文件头就写着
DO NOT MODIFY），手工往里加一条依赖会在下一次 sync 时被抹掉。所以插件必须是
一个装在 `package.json` 里的包：

```
"deutsch-align-native": "file:native-plugins/align-native"
```

## 为什么有这个东西

iPhone 13 上 WebView 里的两档后端**都被系统杀掉**（SPEC §7.10、§0 变更 21），
而 `q4f16` 已经是这个模型最小的变体 —— 降档救不了。原因不是设备内存不够：

- WKWebView 的 WebContent 进程 jetsam 线远低于原生进程；
- ORT-web 至少要「JS 堆一份 + wasm 堆一份」，原生只有一份。

`src/align/emissionMatrix.ts` 那道缝就是为这一天准备的：换掉的只有
「音频 → 矩阵」这一半，viterbi 与下游（applyTimings → 落库 → 同步）一行都没动。

## 三个文件

| 文件 | 干什么 |
| --- | --- |
| `AlignNativePlugin.swift` | Capacitor 桥。base64 音频进、base64 矩阵出，进度走 `emissionsProgress` 事件 |
| `AudioDecoder.swift` | mp3 → 单声道 16kHz Float32（`AVAudioFile` + `AVAudioConverter`） |
| `EmissionsEngine.swift` | ORT session + 分块 + 归一化 + log-softmax。**是 `src/align/emissions.ts` 的逐条移植** |

`EmissionsEngine.swift` 里每一处数值约定（20 秒块 / 2 秒重叠 / 只采用中间段 /
按块零均值单位方差 eps 1e-7 / 全局帧号 `floor(sample/320)` / 未覆盖帧填
`log(1/vocabSize)`）都必须与 `emissions.ts` 一致 —— 同一课在桌面和 iPhone 上
对齐要得到同样的时间戳。改一边就要改另一边。

## 权重

不随插件走。用的是 app bundle 里 `public/models/<modelId>/onnx/model_q4.onnx`
——`npm run stage:align` 下载、`cap sync` 刷进包里的那一份。选 `q4` 而不是
WebGPU 那档的 `q4f16`：`q4f16` 要 fp16 算力，而原生走 ORT 的 CPU EP，
`q4` 用的 MatMulNBits 正是 ORT 自己的 4-bit 通路。

换 dtype 要三处一起改：`src/align/config.ts` 的 `NATIVE_PLAN`、
`scripts/stage-align-assets.mjs` 的文件表、以及这个 README。

## 本机没法验

Windows 上开发，Swift 这半截只有 CI（macOS runner）会编，真机结果只有 TestFlight
上能看。所以：**改完这里一定要出一个包再说「好了」**，`npm run typecheck` 通过
只说明 JS 那半截没问题。
