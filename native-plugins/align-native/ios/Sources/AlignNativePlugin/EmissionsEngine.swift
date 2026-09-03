import Foundation
import OnnxRuntimeBindings

enum EmissionsError: LocalizedError {
    case vocabMismatch(expected: Int, got: Int)
    case badOutput(String)

    var errorDescription: String? {
        switch self {
        case .vocabMismatch(let expected, let got): return "模型词表大小是 \(got)，配置写的是 \(expected)"
        case .badOutput(let what): return "模型输出不对：\(what)"
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

    func run(samples: [Float], onProgress: (Double) -> Void) throws -> Result {
        let totalFrames = samples.count / options.frameStride
        var logProbs = [Float](repeating: Float(log(1.0 / Double(options.vocabSize))),
                               count: totalFrames * options.vocabSize)

        let chunks = planChunks(totalSamples: samples.count)
        for (index, chunk) in chunks.enumerated() {
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
            onProgress(Double(index + 1) / Double(chunks.count))
        }

        let data = logProbs.withUnsafeBufferPointer {
            Data(buffer: $0)
        }
        return Result(
            logProbs: data,
            frames: totalFrames,
            vocabSize: options.vocabSize,
            duration: Double(samples.count) / options.sampleRate
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
