import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        linkBundledAssets()
        return true
    }

    /// 给每个热更 bundle 目录补上指回 app 包的 `dict` 符号链接（SPEC §7.12，变更 41）。
    ///
    /// ── 为什么需要 ──
    /// 热更（@capgo/capacitor-updater）把 web 根整个切到
    /// `Library/NoCloud/ionic_built_snapshots/<id>/`，而 `/dict/`（40MB 词库）是
    /// **相对站点根的绝对路径** —— 根一换就 404。把它塞进热更包等于每次更新多传 40MB；
    /// 改走 `convertFileSrc` 则要换一套寻址。符号链接是唯一一条让 **web 代码一行不改**、
    /// 取数仍走同一个 WebViewAssetHandler 的路。
    ///
    /// 变更 42 之前这里还链着 `models`（418MB 对齐权重）。iOS 上的本地对齐整条删掉之后
    /// 包里不再有那份权重，这里也就只剩词库一条。
    ///
    /// ── 为什么每次启动都重建，而不是「没有才建」──
    /// app 包的路径里有一个每次安装都会变的 UUID
    /// （`/var/containers/Bundle/Application/<UUID>/App.app`）。装了新 IPA 之后，上一版
    /// 留下的链接全部指向一个不存在的目录 —— 而 `fileExists` 跟随链接，对这种断链返回
    /// false，于是「没有就建」会走进 createSymbolicLink 再以 EEXIST 失败，悄悄留下一个
    /// 永远坏着的 `/dict/`。所以：是链接就先删掉，再按当前包路径建一条新的。
    ///
    /// ── 时序 ──
    /// 插件下载新 bundle 是在 app 活着的时候，那时这个函数早跑完了，新目录里没有链接。
    /// 但新 bundle 要到**下次启动**才激活（nativeUpdate.ts 用的是 `next()` 不是 `set()`），
    /// 而下次启动会再跑一遍这里 —— 所以链接总是先于它被用到。
    private func linkBundledAssets() {
        let fm = FileManager.default
        let publicDir = Bundle.main.bundleURL.appendingPathComponent("public")
        guard let libraryDir = fm.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
        let snapshots = libraryDir.appendingPathComponent("NoCloud/ionic_built_snapshots")
        guard let bundles = try? fm.contentsOfDirectory(
            at: snapshots, includingPropertiesForKeys: [.isDirectoryKey]
        ) else {
            return  // 一个热更包都还没下过 —— 跑在包内 dist 上，那份本来就有真的 dict
        }

        for bundleDir in bundles {
            guard (try? bundleDir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
            for name in ["dict"] {
                let target = publicDir.appendingPathComponent(name)
                // 这一版的包里根本没有这份资源（比如构建时没跑 stage:align）就别建断链。
                guard fm.fileExists(atPath: target.path) else { continue }

                let link = bundleDir.appendingPathComponent(name)
                // attributesOfItem 走 lstat，**不跟随链接** —— 这正是判断「它本身是不是
                // 一条链接」所需要的。真目录（不该出现，但万一热更包里带了）就别碰。
                let attrs = try? fm.attributesOfItem(atPath: link.path)
                let type = attrs?[.type] as? FileAttributeType
                if type == .typeSymbolicLink {
                    try? fm.removeItem(at: link)
                } else if attrs != nil {
                    continue
                }
                do {
                    try fm.createSymbolicLink(at: link, withDestinationURL: target)
                } catch {
                    // 建不上就等于这个热更包里没有词库：查词会查不到。
                    // 是退化，不是崩溃，不值得让应用起不来。
                    NSLog("[ota] link \(name) failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// 把音频会话设成 .playback —— 原生壳唯一一处真正改变行为的原生代码。
    ///
    /// 它修掉 README §三 里那条「iOS 的静音开关会让 <audio> 没声音」：WKWebView 默认走
    /// .ambient/.soloAmbient，跟着侧边那个拨杆走，而这个应用的每一个动作都是「听一句」——
    /// 拨杆一拨等于整个应用坏掉，而且症状是「点了没反应」，最难自己想到原因。
    /// SPEC §3.2 当时留的方案是「必要时换 Web Audio API」；有了原生壳，一行 category
    /// 就够，不用把全局单例 <audio> 那套（§3.2 的 iOS 手势链约束）重写一遍。
    ///
    /// 故意**不**声明 UIBackgroundModes=audio：跟读和听写都要看着屏幕，
    /// 切走还在放只会变成「以为关了其实没关」。所以退到后台照旧暂停。
    private func configureAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // 拿不到会话就退回系统默认（跟静音开关走）。这是退化，不是故障，
            // 不值得让应用起不来。
            NSLog("[audio] setCategory(.playback) failed: \(error.localizedDescription)")
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
