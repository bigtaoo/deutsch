import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        return true
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
