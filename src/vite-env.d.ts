/// <reference types="vite/client" />

// Vite 的 ?url 导入：onnxruntime-web 的 wasm 与它的加载器 mjs（见 src/align/runtime.ts）。
declare module '*?url' {
  const url: string;
  export default url;
}
