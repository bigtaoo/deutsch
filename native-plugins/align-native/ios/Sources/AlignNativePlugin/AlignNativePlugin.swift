import Foundation
import UIKit
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
        CAPPluginMethod(name: "computeEmissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelEmissions", returnType: CAPPluginReturnPromise)
    ]

    /// 串行队列，`userInitiated` 而不是 `background`：
    /// 后者会被系统降到小核上跑，一课能从几分钟变成十几分钟。
    /// 串行是故意的 —— 两次并发各要一份 230MB 权重，那正是要躲开的事。
    private let queue = DispatchQueue(label: "com.gamestao.deutsch.align.emissions", qos: .userInitiated)

    /// 「停止」按下了没有。跨线程读写（JS 那边在主线程按，引擎在 `queue` 上读），
    /// 所以要一把锁 —— 不是为了原子性（Bool 的写在实践中是原子的），
    /// 而是为了**可见性**：没有同步原语的话，引擎那个线程可能一直读到缓存里的旧值。
    private let cancelLock = NSLock()
    private var cancelRequested = false

    private func setCancelled(_ value: Bool) {
        cancelLock.lock()
        cancelRequested = value
        cancelLock.unlock()
    }

    private func isCancelled() -> Bool {
        cancelLock.lock()
        defer { cancelLock.unlock() }
        return cancelRequested
    }

    /// 停掉正在跑的那一课。**已经算完的块留在断点里**（Checkpoint.swift），
    /// 下一次点「接着算」从那儿继续 —— 这才是「停止」在手机上敢做的事：
    /// 十几分钟的活儿必须允许分几次干。
    ///
    /// 只在块边界生效，所以最多再等一块（几十秒）才真的停。
    @objc func cancelEmissions(_ call: CAPPluginCall) {
        setCancelled(true)
        call.resolve()
    }

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
            overlapSeconds: call.getDouble("overlapSeconds") ?? 2,
            // 没给键就不做断点，行为退回 0.2.1。
            checkpointKey: call.getString("checkpointKey"),
            audioBytes: audio.count,
            // 指纹的一部分：路径里带着 dtype，换档之后旧的中间态就该作废。
            modelName: modelPath
        )
        let fileExtension = call.getString("extension") ?? "mp3"

        // 每次新的调用都先把上一次的「停止」清掉 —— 否则按过一次停止之后，
        // 后面每一课都会在第一个块边界立刻自杀。
        setCancelled(false)

        // ── 防锁屏（变更 33）──
        // 一课要十几分钟，而 iOS 默认 30 秒到 2 分钟就自动锁屏。锁屏之后 App 进后台被挂起,
        // 带着 400MB 常驻被挂起的进程又正是 jetsam 最先挑的那一个 —— 也就是说
        // 不关掉这个定时器，「在手机上对齐」这件事基本不可能自己跑完。
        //
        // 这只解决**锁屏**。用户主动切到别的 App 照样会被挂起，那条没有便宜的解法
        // （要申请 background mode）—— 兜住它的是断点续算（Checkpoint.swift）：
        // 切出去最坏是「回来接着算」，而不是十几分钟白烧。
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }

        queue.async { [weak self] in
            // 无论成功、失败、还是中途抛错，都要把定时器还给系统。
            defer { DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false } }

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

            // 进度回给 JS：AlignBar 那条常驻进度条就是靠它动的。
            //
            // **每个阶段都要报，哪怕它一次进度都给不出来。** 2026-09-03 真机上的症状是
            // 「开始之后好几分钟一动不动」——原因不是卡住，而是这条路上原本只有
            // 「每块算完报一个比例」一种事件，而它之前的三件事（9MB base64 过桥、
            // 原生解码、加载 230MB 权重）在 iPhone 上加起来就是好几分钟的静默。
            // 静默和卡死在界面上无法区分，而这个功能真实的历史故障恰好就是卡死
            // （进程被 jetsam 杀掉），所以「分不清」这件事本身就是 bug。
            // 两条语句而不是一条：单表达式闭包里 `self?.foo()` 的类型是 `()?`，
            // 而这里声明的返回类型是 Void —— 那个转换在不同 Swift 版本上行为不一样，
            // 而 Swift 这半截本机验不了，一次编译失败就是一整轮 CI。
            let notify: ([String: Any]) -> Void = { payload in
                guard let plugin = self else { return }
                plugin.notifyListeners("emissionsProgress", data: payload)
            }

            do {
                try audio.write(to: audioURL, options: .atomic)
                // 报这一下的意思是「桥过来了、字节收到了」—— 上一个阶段（JS 侧 base64
                // 加 WKWebView 的消息序列化）没有任何回调，只能靠它的**结束**来证明。
                notify(["phase": "decode", "bytes": audio.count])
                let samples = try AudioDecoder.monoFloat(url: audioURL, sampleRate: options.sampleRate)
                notify([
                    "phase": "model",
                    "audioSeconds": Double(samples.count) / options.sampleRate
                ])
                let engine = try EmissionsEngine(modelURL: modelURL, options: options)
                let result = try engine.run(
                    samples: samples,
                    onProgress: { done, total in
                        notify([
                            "phase": "infer",
                            "fraction": total > 0 ? Double(done) / Double(total) : 0.0,
                            "chunk": done,
                            "chunks": total
                        ])
                    },
                    // 拿不到 self 就当成已取消：那说明插件本身已经没了。
                    isCancelled: { self?.isCancelled() ?? true }
                )
                call.resolve([
                    "logProbs": result.logProbs.base64EncodedString(),
                    "frames": result.frames,
                    "vocabSize": result.vocabSize,
                    "duration": result.duration
                ])
            } catch EmissionsError.cancelled {
                // 取消**不是失败**：JS 那边按这个字符串判断（useAlignStore 的 drain），
                // 包一层「原生对齐失败：」会让界面上摆出一条红色的错误横条。
                call.reject("已取消")
            } catch {
                call.reject("原生对齐失败：\(error.localizedDescription)", nil, error)
            }
        }
    }
}
