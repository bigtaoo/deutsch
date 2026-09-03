import Foundation
import Capacitor

/// FR-15 的前半截（音频 → 帧级 log-prob）在原生进程里跑。
///
/// 存在的理由是一件具体的事：iPhone 13 上 WebView 里的**两档后端都被系统杀掉**
/// （SPEC §7.10、变更 21），而 `q4f16` 已经是这个模型最小的变体，所以降档救不了。
/// 挪进原生的两个直接收益：
///   1. 原生进程的 jetsam 线远高于 WKWebView 的 WebContent 进程；
///   2. ORT-web 至少要「JS 堆一份 + wasm 堆一份」，原生只有一份。
///
/// 后半截（viterbi）**仍然在 WebView 的 Worker 里**，一行都没改 —— 那道缝的形状
/// 定在 src/align/emissionMatrix.ts，这个插件只是它的第二个 provider。
@objc(AlignNativePlugin)
public class AlignNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AlignNativePlugin"
    public let jsName = "AlignNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "computeEmissions", returnType: CAPPluginReturnPromise)
    ]

    /// 串行队列，`userInitiated` 而不是 `background`：
    /// 后者会被系统降到小核上跑，一课能从几分钟变成十几分钟。
    /// 串行是故意的 —— 两次并发各要一份 230MB 权重，那正是要躲开的事。
    private let queue = DispatchQueue(label: "com.gamestao.deutsch.align.emissions", qos: .userInitiated)

    @objc func computeEmissions(_ call: CAPPluginCall) {
        guard let base64 = call.getString("audio"),
              let audio = Data(base64Encoded: base64) else {
            call.reject("没有音频数据")
            return
        }
        guard let modelPath = call.getString("modelPath") else {
            call.reject("没给权重路径")
            return
        }

        let options = EmissionsEngine.Options(
            vocabSize: call.getInt("vocabSize") ?? 31,
            sampleRate: Double(call.getInt("sampleRate") ?? 16000),
            frameStride: call.getInt("frameStride") ?? 320,
            chunkSeconds: call.getDouble("chunkSeconds") ?? 20,
            overlapSeconds: call.getDouble("overlapSeconds") ?? 2
        )
        let fileExtension = call.getString("extension") ?? "mp3"

        queue.async { [weak self] in
            // 权重在 app bundle 的 public/ 下 —— 那正是 `cap sync` 把 dist（含
            // public/models）刷进去的位置。这里不做任何网络回退：随包权重是
            // FR-11「完全离线」的实现方式，取不到就该报错，而不是悄悄去联网下 230MB。
            let modelURL = Bundle.main.bundleURL
                .appendingPathComponent("public")
                .appendingPathComponent(modelPath)
            guard FileManager.default.fileExists(atPath: modelURL.path) else {
                call.reject("包里没有这份权重：public/\(modelPath)")
                return
            }

            // 音频先落到临时文件：AVAudioFile 只认 URL。扩展名要给对 ——
            // ExtAudioFile 会先看扩展名再嗅探内容，给错会得到一句没有信息量的
            // 「格式不支持」。
            let audioURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("align-\(UUID().uuidString).\(fileExtension)")
            defer { try? FileManager.default.removeItem(at: audioURL) }

            do {
                try audio.write(to: audioURL, options: .atomic)
                let samples = try AudioDecoder.monoFloat(url: audioURL, sampleRate: options.sampleRate)
                let engine = try EmissionsEngine(modelURL: modelURL, options: options)
                let result = try engine.run(samples: samples) { fraction in
                    // 进度回给 JS：AlignBar 那条常驻进度条就是靠它动的。
                    self?.notifyListeners("emissionsProgress", data: ["fraction": fraction])
                }
                call.resolve([
                    "logProbs": result.logProbs.base64EncodedString(),
                    "frames": result.frames,
                    "vocabSize": result.vocabSize,
                    "duration": result.duration
                ])
            } catch {
                call.reject("原生对齐失败：\(error.localizedDescription)", nil, error)
            }
        }
    }
}
