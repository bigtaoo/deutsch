# 音效来源

三个音效来自 **Kenney「Interface Sounds」(1.0)**，<https://kenney.nl/assets/interface-sounds>，
许可 **CC0 1.0**（公有领域奉献，不要求署名 —— 但拿了别人的东西总该说得出它是谁的）。

| 本仓库的文件 | 原包里的文件 | 时长 | 用在哪 |
|---|---|---|---|
| `tap.wav` | `Audio/select_002.ogg` | 0.043s | 复习时点一个选项（FR-10.12） |
| `right.wav` | `Audio/confirmation_001.ogg` | 0.290s | 答对 |
| `wrong.wav` | `Audio/error_002.ogg` | 0.165s | 答错 |

## 为什么入库的是 WAV 而不是原包的 OGG

Safari / iOS WKWebView 对 Ogg Vorbis 的支持一直不可靠，而这三段音要在原生壳里响。
WAV 是唯一一处都认的格式，且 0.04–0.29 秒的单声道 16-bit PCM 一共只有 43 KB ——
为省这几十 KB 去赌一个「在我的手机上没声音」的失败面不划算。

转换做了三件事（一次性脚本，不入库）：立体声下混成单声道、峰值归一到 0.85、
末尾 3ms 淡出（切断处的直流台阶在手机小喇叭上是一声「啪」）。

## 换一个音效

原包里还有 `click_001`~`005`、`tick_001/002/004`、`confirmation_001`~`004`、
`error_001`~`008`、`pluck`、`glass`、`switch`、`toggle` 等约 100 个。换的时候：
重新下原包 → 转成同名 WAV 放这里 → 这份清单跟着改。
`src/audio/sfx.ts` 里只有文件名，不用动代码。
