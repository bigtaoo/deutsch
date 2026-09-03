import AVFoundation

enum AudioDecodeError: LocalizedError {
    case unsupported(String)
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .unsupported(let what): return "音频格式不支持：\(what)"
        case .failed(let why): return "音频解码失败：\(why)"
        }
    }
}

/// mp3 → 单声道 16kHz Float32 波形。
///
/// 这一步在 WebView 里也做得到（`src/align/decode.ts` 的 `decodeToMono16k`，
/// iOS 上是好的），挪到原生纯粹是为了**桥上的字节数**：
/// 8 分钟的波形是 30MB，base64 之后 41MB，而同一课的 mp3 只有 7MB。
/// 理由的全文在 src/align/nativeEmissions.ts 顶部。
struct AudioDecoder {
    static func monoFloat(url: URL, sampleRate: Double) throws -> [Float] {
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw AudioDecodeError.unsupported(error.localizedDescription)
        }

        let inFormat = file.processingFormat
        guard let outFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ) else {
            throw AudioDecodeError.failed("建不出 \(Int(sampleRate))Hz 单声道输出格式")
        }
        // AVAudioConverter 一次做完两件事：重采样到 16k、多声道下混成单声道。
        guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else {
            throw AudioDecodeError.unsupported("\(inFormat) → \(outFormat)")
        }

        let inCapacity: AVAudioFrameCount = 1 << 16
        guard let inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: inCapacity) else {
            throw AudioDecodeError.failed("分配不出解码缓冲")
        }
        let ratio = sampleRate / inFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(inCapacity) * ratio) + 1024

        var samples = [Float]()
        samples.reserveCapacity(Int(Double(file.length) * ratio) + 1024)
        // 输入取完了没有：`.inputRanOut` 既可能是「这一轮喂完了」也可能是「文件到底了」，
        // 只看返回值分不出来，所以由喂数据的那个闭包自己记一下。
        var exhausted = false

        loop: while true {
            guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity) else {
                throw AudioDecodeError.failed("分配不出输出缓冲")
            }
            var conversionError: NSError?
            let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
                if exhausted {
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                do {
                    try file.read(into: inBuffer, frameCount: inCapacity)
                } catch {
                    exhausted = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                if inBuffer.frameLength == 0 {
                    exhausted = true
                    inputStatus.pointee = .endOfStream
                    return nil
                }
                inputStatus.pointee = .haveData
                return inBuffer
            }
            if let conversionError {
                throw AudioDecodeError.failed(conversionError.localizedDescription)
            }
            if outBuffer.frameLength > 0, let channel = outBuffer.floatChannelData {
                samples.append(contentsOf: UnsafeBufferPointer(start: channel[0], count: Int(outBuffer.frameLength)))
            }

            switch status {
            case .haveData:
                continue
            case .inputRanOut:
                if exhausted { break loop }
            case .endOfStream:
                break loop
            case .error:
                throw AudioDecodeError.failed("AVAudioConverter 报错")
            @unknown default:
                break loop
            }
        }

        if samples.isEmpty {
            throw AudioDecodeError.failed("解出来是 0 个采样点")
        }
        return samples
    }
}
