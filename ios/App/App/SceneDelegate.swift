import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = CAPBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// 屏幕常亮，原生侧接管（FR-18.7，变更 52，2026-09-23）。
    ///
    /// ── 为什么加这个，Web Wake Lock 不够吗 ──
    /// `src/platform/wakeLock.ts` 那套 `navigator.wakeLock` 在真机上被拒了
    /// （用户报「常亮申请被拒且非省电模式」），而 JS 侧只知道「被拒」，
    /// 不知道 WKWebView 为什么拒——那是浏览器标准 API 在原生壳里的行为，Web Wake Lock
    /// 规范本身不保证 WKWebView 实现、也不保证实现了就一定放行。真正**不过 Web API
    /// 这层**的开关是 `UIApplication.isIdleTimerDisabled`：这是 App 自己对系统说
    /// 「先别自动锁屏」，跟 WebKit 认不认 Wake Lock 没有关系。
    ///
    /// ── 为什么挂在 SceneDelegate，不是 AppDelegate ──
    /// 这份工程有 `UIApplicationSceneManifest`（Info.plist）+ SceneDelegate，
    /// **场景生命周期起了之后 `AppDelegate.applicationDidBecomeActive` 就不会再被调用**——
    /// 挂在那里等于挂了个永远不响的钩子。真正的「前台/后台」事件在这里。
    ///
    /// ── 代价照旧有上界 ──
    /// 场景一进后台（切走、锁屏、接电话）系统就会把这个应用的场景挂起，
    /// `isIdleTimerDisabled` 不会跨应用生效，所以「忘了关」最多亮到手机自己按灭那一下。
    /// 低电量模式下系统会直接无视这个开关——这一档没有代码能治，只能如实告诉用户。
    func sceneDidBecomeActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func sceneWillResignActive(_ scene: UIScene) {
        UIApplication.shared.isIdleTimerDisabled = false
    }
}
