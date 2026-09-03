// swift-tools-version: 5.9
import PackageDescription

// 包名与库名**必须**是 DeutschAlignNative：Capacitor CLI 从 npm 包名推它
// （`deutsch-align-native` → fixName → `DeutschAlignNative`，见 @capacitor/cli 的
// dist/plugin.js），然后照这个名字往 ios/App/CapApp-SPM/Package.swift 里写
// `.package(name:)` 与 `.product(name:)`。改 npm 包名就要同时改这两行，
// 否则 `cap sync ios` 生成的那份引用不到这个包，而报错发生在 Xcode 里，不在 sync 里。
let package = Package(
    name: "DeutschAlignNative",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "DeutschAlignNative",
            targets: ["AlignNativePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        // ONNX Runtime 官方的 SPM 分发（binaryTarget，构建时下载 xcframework）。
        // 模块名是 OnnxRuntimeBindings，暴露的是 Objective-C API（ORTEnv/ORTSession/ORTValue）。
        //
        // 用 upToNextMajor 而不是钉死一个补丁号：1.x 的 ObjC API 是只增不改的，
        // 而新版本带来的正是我们最需要的东西 —— ARM64 上 MatMulNBits（4-bit）的内核。
        // 真出了兼容问题，钉版本就是改这一行。
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager.git", .upToNextMajor(from: "1.20.0"))
    ],
    targets: [
        .target(
            name: "AlignNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager")
            ],
            path: "ios/Sources/AlignNativePlugin")
    ]
)
