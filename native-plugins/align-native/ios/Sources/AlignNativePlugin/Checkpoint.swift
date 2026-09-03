import Foundation

/// 一次对齐算到哪儿了。**存在的理由是手机不肯给你十几分钟**（SPEC §0 变更 33）。
///
/// ── 为什么必须有这个 ──
/// iPhone 上一课 8 分钟音频要 27 块、10–15 分钟。而这段时间里有三件事随时会打断它：
///   · 用户切到别的 App（iOS 挂起前台进程，没有 background mode 就是没有）
///   · 系统内存紧张时把这个带着 400MB 常驻的进程杀掉（2026-09-01 那次就是）
///   · 用户自己按「停止」
/// 没有断点的话，这三件事每一件都等于「十几分钟白烧」，于是「在手机上对齐」
/// 实际上是一件**运气好才能完成**的事。有了断点，它变成「分几次也能完成」。
///
/// ── 形状：一个前缀 + 一个指纹 ──
/// 块是**顺序**算的，所以「算到哪儿了」是一个数字（前 done 块已落盘），不需要位图。
/// 指纹管的是「这份中间态还配不配得上现在这次运行」：音频换了、参数改了、模型换了，
/// 中间态就必须整份扔掉 —— 混用会得到一个**看起来正常但时间戳系统性错位**的结果，
/// 那是最坏的一种失败。
///
/// ── 落在 Caches 里 ──
/// 它是可重算的中间产物，不该进备份、也不该占用户的「文档」。Caches 会被系统在
/// 磁盘紧张时清掉 —— 那正是想要的语义：清掉最坏也只是从头算一次。
struct EmissionsCheckpoint {
    /// 「这份中间态是不是这次运行的」。任何一项不同就整份作废。
    struct Fingerprint: Codable, Equatable {
        /// 解码出来的采样点数。音频换了这个数几乎一定变。
        let samples: Int
        /// 再加一道：剪过但长度巧合相同的音频靠这个分开。
        let audioBytes: Int
        let vocabSize: Int
        let frameStride: Int
        let chunkSeconds: Double
        let overlapSeconds: Double
        let chunks: Int
        /// 权重文件名。降档换了 dtype，中间态也必须作废。
        let model: String

        /// 完整矩阵有多少个 float。load 时用它验文件长度。
        var floats: Int { (samples / frameStride) * vocabSize }
    }

    private struct Header: Codable {
        let fingerprint: Fingerprint
        /// 前 `done` 块已经写进 .bin 里了。
        let done: Int
    }

    private let dataURL: URL
    private let headerURL: URL
    private let fingerprint: Fingerprint

    init?(key: String, fingerprint: Fingerprint) {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let directory = caches.appendingPathComponent("align-emissions", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // lesson id 直接当文件名不安全（它是外部数据）。只留下这几类字符,
        // 其余一律换成下划线 —— 碰撞了也无所谓,指纹会把不匹配的那份挡掉。
        let safe = String(key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
        self.dataURL = directory.appendingPathComponent("\(safe).bin")
        self.headerURL = directory.appendingPathComponent("\(safe).json")
        self.fingerprint = fingerprint
    }

    /// 读回中间态。任何一处不对（没有、指纹不符、长度不符、解不开）都当成「没有」——
    /// 这个函数**不报错**：断点是优化，不是正确性的一部分，坏了就从头算。
    func load() -> (values: [Float], done: Int)? {
        guard let headerData = try? Data(contentsOf: headerURL),
              let header = try? JSONDecoder().decode(Header.self, from: headerData),
              header.fingerprint == fingerprint,
              header.done > 0,
              header.done <= fingerprint.chunks,
              let raw = try? Data(contentsOf: dataURL),
              raw.count == fingerprint.floats * MemoryLayout<Float>.size else {
            return nil
        }
        var values = [Float](repeating: 0, count: fingerprint.floats)
        raw.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            let source = base.assumingMemoryBound(to: Float.self)
            values.withUnsafeMutableBufferPointer { destination in
                destination.baseAddress?.update(from: source, count: destination.count)
            }
        }
        return (values, header.done)
    }

    /// 落盘。**先数据、后 header**：反过来的话，死在两次写之间会留下一个
    /// 「声称第 13 块已好、实际没写」的中间态，而那种坏法是静默的。
    /// 这个顺序下最坏只是 header 落后一块 —— 下次把那块重算一遍，结果一模一样。
    ///
    /// 整份 3MB 全写，不做增量：一次写 3MB 在 iPhone 的闪存上是十几毫秒，
    /// 一课 27 次总共不到一秒，而它换来的是 `.atomic` 那份「要么全新要么全旧」的保证。
    func save(values: [Float], done: Int) {
        let data = values.withUnsafeBufferPointer { Data(buffer: $0) }
        guard (try? data.write(to: dataURL, options: .atomic)) != nil,
              let header = try? JSONEncoder().encode(Header(fingerprint: fingerprint, done: done)) else {
            return
        }
        try? header.write(to: headerURL, options: .atomic)
    }

    /// 算完了就扔 —— 3MB 留着没有意义，而且下一次重对同一课要的是从头算。
    /// **只在成功时调**：取消和崩溃都要把它留着，那正是它存在的意义。
    func discard() {
        try? FileManager.default.removeItem(at: dataURL)
        try? FileManager.default.removeItem(at: headerURL)
    }
}
