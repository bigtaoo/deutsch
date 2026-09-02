// 同步后端的地址与 Google 客户端 ID。三个值都从构建期环境变量来（`.env.local`），
// 因为它们在 web 版和原生壳里是同一份代码、不同的部署。
//
// 没配 = 同步功能整体关闭：设置页只显示一行说明，不会有半个按钮点下去报 404。
// 这是刻意的 —— 手动导出（FR-11.11）从来都能单独工作，同步是加分项不是前提。

export const SYNC_API_BASE = (import.meta.env.VITE_SYNC_API_BASE ?? '').replace(/\/+$/, '');

/** Web 与 Android 都用这个（Android 的客户端 ID 不进代码，只在 Google 控制台登记）。 */
export const GOOGLE_WEB_CLIENT_ID = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID ?? '';

/** iOS 单独一个。 */
export const GOOGLE_IOS_CLIENT_ID = import.meta.env.VITE_GOOGLE_IOS_CLIENT_ID ?? '';

export function isSyncConfigured(): boolean {
  return SYNC_API_BASE !== '' && GOOGLE_WEB_CLIENT_ID !== '';
}
