import Foundation
import OnnxRuntimeBindings

enum EmissionsError: LocalizedError {
    case vocabMismatch(expected: Int, got: Int)
    case badOutput(String)
    /// 用户按了「停止」。已经算完的块留在断点里，下一次接着算。
    case cancelled

    var errorDescription: String? {
        switch self {
        case .vocabMismatch(let expected, let got): return "模型词表大小是 \(got)，配置写的是 \(expected)"
        case .badOutput(let what): return "模型输出不对：\(what)"
        case .cancelled: return "已取消"
        }
    }
}

/// 波形 → 帧级 log-prob。**这个文件是 `src/align/emissions.ts` 的逐条移植**，
/// 两边的产物必须可以互换（同一课在桌面和 iPhone 上对齐要得到同样的时间戳），
/// 所以下面每一处数值约定都不是随手写的：
///
///   · 分块 20 秒、重叠 2 秒、每块只采用中间那段 —— `planChunks()`
///   · 每块各自做零均值单位方差归一化，eps `1e-7` —— HF 的 `Wav2Vec2FeatureExtractor`
///     （`preprocessor_config.json` 里 `do_normalize: true`）
///   · 全局帧号一律 `floor(sample / frameStride)`
///   · 没被任何块覆盖到的帧填 `log(1/vocabSize)`（= 完全不确定），**不能留 0**：
///     0 在 log 域是 log(1)=确定，那是最坏的默认值
///
/// 改这里的任何一条，就要同时改 emissions.ts —— 否则两个 provider 出来的矩阵
/// 在块边界上会有系统性差异，而句子边界恰好密集出现在那里。
final class EmissionsEngine {
    struct Options {
        let vocabSize: Int
        let sampleRate: Double
        let frameStride: Int
        let chunkSeconds: Double
        let overlapSeconds: Double
        /**
         断点续算的键，一般是 lesson id。`nil` = 不做断点。

         为什么可以为 nil：断点是**手机上才需要**的东西（变更 33），
         而这个引擎将来也可能被别处调用。nil 时行为与 0.2.1 完全一样。
         */
        let checkpointKey: String?
        /// 进指纹用：桥上收到的音频字节数。
        let audioBytes: Int
        /// 进指纹用：权重文件名。换了 dtype 中间态必须作废。
        let modelName: String
    }

    struct Result {
        /// float32 小端字节，帧优先（帧 t 的第 v 项在 t * vocabSize + v）
        let logProbs: Data
        let frames: Int
        let vocabSize: Int
        let duration: Double
    }

    private struct Chunk {
        let sampleStart: Int
        let sampleEnd: Int
        let keepFrameStart: Int
        let keepFrameEnd: Int
    }

    private let options: Options
    private let env: ORTEnv
    private let session: ORTSession

    /// Session 是**一次一课**的，不缓存。
    ///
    /// 桌面那边（emissions.ts）把模型缓存在模块级，因为连续对齐几课不该重复加载 200MB。
    /// 手机上反过来：常驻 230MB 之后，用户接着做的第一件事就是播这一课的音频，
    /// 那时再被系统盯上就是白丢一次对齐。这和 worker.ts 里那个 `release` 是同一条判断。
    init(modelURL: URL, options: Options) throws {
        self.options = options
        self.env = try ORTEnv(loggingLevel: ORTLoggingLevel.warning)
        let sessionOptions = try ORTSessionOptions()
        // 大核数量。给满逻辑核在手机上会把小核也算进来，反而更慢。
        try sessionOptions.setIntraOpNumThreads(Int32(max(1, ProcessInfo.processInfo.activeProcessorCount / 2)))
        // 这里**故意只用这一个 session option**。ORT 的 ObjC API 表面越大，
        // 在 CI 上编不过的可能就越大 —— 而 Swift 这半截本机验不了，一次编译失败
        // 就是一整轮 CI。想加 session config（例如初始化张量绕开 arena）时，
        // 先确认那个方法在钉住的 ORT 版本里真的存在。
        self.session = try ORTSession(env: env, modelPath: modelURL.path, sessionOptions: sessionOptions)
    }

    /// `onProgress(done, total)` —— **块数而不是比例**，而且第 0 块之前就先报一次。
    ///
    /// 两处都是 2026-09-03 那次真机症状逼出来的：iPhone 上「开始之后好几分钟一动不动」。
    /// 原因不是卡住，是这条路上**从头到尾只有一种事件**（每块算完报一个比例），
    /// 而在手机上「加载 230MB 权重 + 算完第一块」本身就要好几分钟 ——
    /// 于是最需要耐心的那一段恰好是唯一没有任何反馈的一段，和真的卡死长得一模一样。
    /// 现在 total 一出来就先报 (0, total)：进度条从此刻起就能说出「第 0/27 块」，
    /// 「模型加载完了没有」也因此变成界面上看得见的事。
    func run(
        samples: [Float],
        onProgress: (Int, Int) -> Void,
        isCancelled: () -> Bool = { false }
    ) throws -> Result {
        let totalFrames = samples.count / options.frameStride
        var logProbs = [Float](repeating: Float(log(1.0 / Double(options.vocabSize))),
                               count: totalFrames * options.vocabSize)

        let chunks = planChunks(totalSamples: samples.count)

        // ── 断点续算（变更 33）──
        // 手机上一课十几分钟，而切走 App、被 jetsam 杀、按停止这三件事随时会打断它。
        // 块是顺序算的，所以「算到哪儿了」就是一个数字，续算 = 从那一块开始。
        let checkpoint = options.checkpointKey.flatMap {
            EmissionsCheckpoint(
                key: $0,
                fingerprint: EmissionsCheckpoint.Fingerprint(
                    samples: samples.count,
                    audioBytes: options.audioBytes,
                    vocabSize: options.vocabSize,
                    frameStride: options.frameStride,
                    chunkSeconds: options.chunkSeconds,
                    overlapSeconds: options.overlapSeconds,
                    chunks: chunks.count,
                    model: options.modelName
                )
            )
        }
        var start = 0
        if let resumed = checkpoint?.load() {
            logProbs = resumed.values
            start = resumed.done
        }

        // 一课要分多少块，这是**推理开始前**唯一能报出来的量。报了它，界面才有分母；
        // 续算时它同时也是「上次算到哪儿」—— 进度条一上来就停在第 13/27 块，
        // 而不是从 0 开始让人以为白算了。
        onProgress(start, chunks.count)

        // 全部块都在断点里（上次算完了但没能把结果交回 JS：比如死在回程那 4MB 上）。
        // 这时候连一次推理都不用做。**代价是这一趟仍然白加载了一次权重** ——
        // 要省掉它就得把 planChunks 挪到 session 之前，那是另一次重构，而这条路很窄。
        if start >= chunks.count {
            return result(logProbs: logProbs, totalFrames: totalFrames, samples: samples.count)
        }

        for index in start..<chunks.count {
            // 只在**块边界**检查取消。块内没有检查点：一次 session.run 是原子的,
            // 而它本身就是这里的时间粒度（几十秒）。
            if isCancelled() { throw EmissionsError.cancelled }
            let chunk = chunks[index]
            let normalized = normalize(Array(samples[chunk.sampleStart..<chunk.sampleEnd]))
            let (local, chunkFrames) = try infer(normalized)

            // 全局帧 g 对应块内帧 g - floor(sampleStart / stride)
            let chunkFrameBase = chunk.sampleStart / options.frameStride
            for g in chunk.keepFrameStart..<chunk.keepFrameEnd {
                let localFrame = g - chunkFrameBase
                if localFrame < 0 || localFrame >= chunkFrames { continue }
                if g < 0 || g >= totalFrames { continue }
                for v in 0..<options.vocabSize {
                    logProbs[g * options.vocabSize + v] = local[localFrame * options.vocabSize + v]
                }
            }
            // 先落盘再报进度：界面上说「第 13 块好了」的时候，磁盘上就真的有 13 块。
            checkpoint?.save(values: logProbs, done: index + 1)
            onProgress(index + 1, chunks.count)
        }

        // 算完了就把中间态扔掉。**只有这一条路上能扔** —— 取消和抛错都要留着它。
        checkpoint?.discard()
        return result(logProbs: logProbs, totalFrames: totalFrames, samples: samples.count)
    }

    private func result(logProbs: [Float], totalFrames: Int, samples: Int) -> Result {
        Result(
            logProbs: logProbs.withUnsafeBufferPointer { Data(buffer: $0) },
            frames: totalFrames,
            vocabSize: options.vocabSize,
            duration: Double(samples) / options.sampleRate
        )
    }

    // MARK: - 一块的推理

    private func infer(_ chunk: [Float]) throws -> (logProbs: [Float], frames: Int) {
        // ORT **不拷贝** tensorData，所以这个 NSMutableData 必须活过 run()。
        // 它是这里的局部变量，作用域正好覆盖 run —— 别把它挪进闭包或更小的作用域。
        let inputData = chunk.withUnsafeBufferPointer { buffer -> NSMutableData in
            NSMutableData(bytes: buffer.baseAddress, length: buffer.count * MemoryLayout<Float>.size)
        }
        let input = try ORTValue(
            tensorData: inputData,
            elementType: ORTTensorElementDataType.float,
            shape: [1, NSNumber(value: chunk.count)]
        )

        // 这份导出的图只有一个输入 `input_values`、一个输出 `logits`
        // （**没有** attention_mask —— transformers.js 那边会造一个，但图里不收）。
        let outputs = try session.run(
            withInputs: ["input_values": input],
            outputNames: ["logits"],
            runOptions: nil
        )
        guard let logits = outputs["logits"] else {
            throw EmissionsError.badOutput("没有 logits")
        }

        let shape = try logits.tensorTypeAndShapeInfo().shape.map { $0.intValue }
        guard shape.count == 3 else {
            throw EmissionsError.badOutput("形状是 \(shape)，期望 [1, frames, vocab]")
        }
        let frames = shape[1]
        let vocabSize = shape[2]
        guard vocabSize == options.vocabSize else {
            throw EmissionsError.vocabMismatch(expected: options.vocabSize, got: vocabSize)
        }

        let raw = try logits.tensorData() as Data
        var values = [Float](repeating: 0, count: frames * vocabSize)
        guard raw.count >= values.count * MemoryLayout<Float>.size else {
            throw EmissionsError.badOutput("logits 只有 \(raw.count) 字节")
        }
        raw.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            let source = base.assumingMemoryBound(to: Float.self)
            values.withUnsafeMutableBufferPointer { destination in
                destination.baseAddress?.update(from: source, count: destination.count)
            }
        }
        logSoftmaxInPlace(&values, frames: frames, vocabSize: vocabSize)
        return (values, frames)
    }

    // MARK: - 与 emissions.ts 逐条对应的纯计算

    /// HF `Wav2Vec2FeatureExtractor._zero_mean_unit_var_norm`：**按块**算均值方差，eps 1e-7。
    /// 按块而不是按整段是 transformers.js 的行为（processor 收到的就是那一块），
    /// 这里必须一样，否则两边的输入分布就不同了。
    private func normalize(_ chunk: [Float]) -> [Float] {
        guard !chunk.isEmpty else { return chunk }
        var sum = 0.0
        for value in chunk { sum += Double(value) }
        let mean = sum / Double(chunk.count)
        var variance = 0.0
        for value in chunk {
            let d = Double(value) - mean
            variance += d * d
        }
        variance /= Double(chunk.count)
        let scale = 1.0 / (variance + 1e-7).squareRoot()
        return chunk.map { Float((Double($0) - mean) * scale) }
    }

    /// 就地 log-softmax。先减每帧最大值再取 exp —— 否则 exp 溢出。
    private func logSoftmaxInPlace(_ data: inout [Float], frames: Int, vocabSize: Int) {
        for t in 0..<frames {
            let base = t * vocabSize
            var maxValue = -Float.greatestFiniteMagnitude
            for v in 0..<vocabSize where data[base + v] > maxValue { maxValue = data[base + v] }
            var sum = 0.0
            for v in 0..<vocabSize { sum += exp(Double(data[base + v] - maxValue)) }
            let logSum = Double(maxValue) + log(sum)
            for v in 0..<vocabSize { data[base + v] = Float(Double(data[base + v]) - logSum) }
        }
    }

    /// `planChunks()` 的移植。全局帧号定义为 floor(sample / frameStride)：
    /// 与模型内部卷积的实际对齐差不到一帧（20ms），换来的是块与块之间帧号绝不错位。
    private func planChunks(totalSamples: Int) -> [Chunk] {
        let chunkSamples = Int((options.chunkSeconds * options.sampleRate).rounded())
        let overlapSamples = Int((options.overlapSeconds * options.sampleRate).rounded())
        let strideSamples = max(1, chunkSamples - overlapSamples)
        let totalFrames = totalSamples / options.frameStride

        if totalSamples <= chunkSamples {
            return [Chunk(sampleStart: 0, sampleEnd: totalSamples, keepFrameStart: 0, keepFrameEnd: totalFrames)]
        }

        var chunks = [Chunk]()
        var start = 0
        while start < totalSamples {
            let sampleEnd = min(totalSamples, start + chunkSamples)
            let isFirst = start == 0
            let isLast = sampleEnd >= totalSamples
            let trim = overlapSamples / 2
            let keepStart = isFirst ? 0 : start + trim
            let keepEnd = isLast ? totalSamples : sampleEnd - trim
            chunks.append(Chunk(
                sampleStart: start,
                sampleEnd: sampleEnd,
                keepFrameStart: keepStart / options.frameStride,
                keepFrameEnd: min(totalFrames, keepEnd / options.frameStride)
            ))
            if isLast { break }
            start += strideSamples
        }
        return chunks
    }
}
