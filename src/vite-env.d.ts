/// <reference types="vite/client" />
// `virtual:pwa-register` 的类型（src/platform/pwa.ts 用它注册 Service Worker）。
/// <reference types="vite-plugin-pwa/client" />

// Vite 的 ?url 导入：onnxruntime-web 的 wasm 与它的加载器 mjs（见 src/align/runtime.ts）。
declare module '*?url' {
  const url: string;
  export default url;
}
