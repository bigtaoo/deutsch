import CapacitorUpdaterPlugin
import SocialLoginPlugin

public let isCapacitorApp = true

/// 强制引用这两个插件类，防止 SwiftPM 静态库把它们当死代码剥离（变更 52，2026-09-23）。
///
/// ── 为什么需要这个 ──
/// 这个文件在变更 52 之前只有 `isCapacitorApp = true` 一行 —— 没有任何 Swift 代码
/// 真正用到 `CapacitorUpdaterPlugin` / `SocialLoginPlugin`。它们能不能进最终二进制、
/// 能不能被 `registerPlugins()` 的 `NSClassFromString(...)` 找到，全靠 Capacitor 自己
/// 在 `capacitor.config.json` 的 `packageClassList` 里报了名，**没有任何编译期保证**
/// 说链接器一定会把这两个类的符号留下来。
///
/// ── 这解释的是哪个真机症状 ──
/// 变更 50 修的是「桥调用挂住不 settle」，但没查出**为什么**挂住。之后在真机上确认
/// `App.getInfo()` 是好的、只有 `CapacitorUpdater.current()` 哑——而两者走的是同一条
/// 桥调度队列（`CapacitorBridge.dispatchQueue`，单条串行），队列真堵了不可能让
/// `getInfo()` 先回来。更像的成因是 `CapacitorBridge.handleJSCall` 里那句
/// `guard let plugin = plugins[call.pluginId] ?? load() else { ...; return }`——
/// 插件类没能被加载，桥直接丢掉这次调用，JS 那边的 Promise 永远没人 resolve/reject。
/// `src/platform/nativeUpdate.ts` 的 `probePlugins()` 能在 JS 侧确认是不是这一种；
/// 这里补的是「假如真是这一种，怎么让它不再发生」——把两个类的引用摆在一个任何构建
/// 配置都不会优化掉的顶层数组里，链接器就没有「反正没人用」这个丢掉它们的理由。
///
/// 代价是零：这两个类本来就是 CapApp-SPM 的依赖（见 `Package.swift`），这里只是
/// 显式点名，不引入新依赖，猜错了也不会更坏。
let linkedNativePlugins: [AnyClass] = [
    CapacitorUpdaterPlugin.self,
    SocialLoginPlugin.self,
]
