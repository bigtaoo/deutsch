// 登录与会话。
//
// 流程：Google 给一张 ID token（一小时有效）→ 后端验签 + 查白名单 → 换回一张我们自己的
// 会话令牌（90 天）→ 之后所有同步请求带着它。ID token 用完即弃，不落库。
//
// 三个平台走的是**同一个调用**：@capgo/capacitor-social-login 在 iOS/Android 用系统的
// Google 账号，在 web 开一个弹窗走完整的 OAuth 重定向（不是 One Tap —— 插件的 web 实现
// 只有这一条路，所以重定向地址必须登记，见 oauthRedirectUrl()）。业务代码不判平台 ——
// 这条规矩来自 src/platform/native.ts 顶部那段，这里照办。
//
// 插件是动态 import 的：web 版首屏不该为一个「大多数会话都用不到」的登录 SDK 付包体。

import { getMeta, putMeta, deleteMeta } from '@/db/meta';
import { META_KEYS } from '@/db/schema';
import { syncFetch, SyncAuthError } from './client';
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID, isSyncConfigured } from './config';

export interface SyncAccount {
  email: string;
  name: string | null;
  picture: string | null;
}

export interface SyncSession {
  token: string;
  expiresAt: number;
  account: SyncAccount;
}

export async function getSession(): Promise<SyncSession | undefined> {
  return getMeta<SyncSession>(META_KEYS.syncSession);
}

/** 同步链路上所有请求都从这里拿令牌；没登录就是 undefined，调用方据此静默跳过。 */
export async function getSessionToken(): Promise<string | undefined> {
  return (await getSession())?.token;
}

export async function clearSession(): Promise<void> {
  await deleteMeta(META_KEYS.syncSession);
}

let initialized: Promise<void> | null = null;

/**
 * 初始化登录插件。web 上它是往 document 里插一个 Google 的 script 标签，
 * 而插件自己说「无法知道脚本何时就绪」—— 所以这里插完之后轮询等 `google.accounts` 出现，
 * 免得用户点得快一点就撞上一个没头没脑的报错。
 */
export async function ensureGoogleReady(): Promise<void> {
  if (!isSyncConfigured()) throw new Error('这个构建没有配置同步服务器');
  initialized ??= (async () => {
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    await SocialLogin.initialize({
      google: {
        webClientId: GOOGLE_WEB_CLIENT_ID,
        iOSClientId: GOOGLE_IOS_CLIENT_ID || undefined,
        iOSServerClientId: GOOGLE_WEB_CLIENT_ID,
        mode: 'online',
        redirectUrl: oauthRedirectUrl(),
      },
    });
    await waitForGoogleScript();
  })();
  return initialized;
}

/**
 * web 版的 OAuth 重定向地址。
 *
 * 插件在浏览器里走的是「弹窗 + 完整 OAuth 重定向」，不是 One Tap —— 所以这个地址必须
 * **一字不差**地登记在 Google 控制台的「已获授权的重定向 URI」里，否则弹窗里只会看到
 * `错误 400: redirect_uri_mismatch`。
 *
 * 为什么要自己给而不用插件的默认值：它的默认值是 `origin + pathname`，末尾带一条斜杠
 * （`https://d.gamestao.com/`），而控制台里登记的是裸域名。Google 对这个值是逐字符比对的，
 * 多一条斜杠就是另一个地址。写死成 origin 之后它跟部署路径、路由都无关，只有一个值要登记。
 *
 * 原生壳里这个字段是死的（iOS/Android 用系统账号，源码里根本不读 google.redirectUrl），
 * 所以照 src/platform/native.ts 的规矩：不判平台，无条件给。
 */
function oauthRedirectUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location.origin;
}

/** 插件用来标记「有一次登录正在进行」的 localStorage 键。它没有导出，只能照抄。 */
const OAUTH_PENDING_KEY = 'social_login_oauth_pending';

/**
 * 「我是不是登录弹窗跳回来的那个窗口」。
 *
 * Google 把令牌拼在 fragment 里重定向回 `oauthRedirectUrl()`，也就是本站首页 —— 于是弹窗里
 * 会**再启动一遍整个 App**。收尾（postMessage 回主窗口 + 关掉自己）挂在插件模块的 import
 * 副作用上，而这个 App 平时是懒加载插件的：弹窗里没人 import 它，主窗口就永远等不到结果。
 * main.tsx 用这个判断在弹窗里只 import 插件、不启动 App。
 */
export function isOAuthPopupReturn(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.localStorage.getItem(OAUTH_PENDING_KEY)) return false;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const search = new URLSearchParams(window.location.search);
  return (
    hash.has('access_token') || hash.has('id_token') || hash.has('error') || search.has('code')
  );
}

async function waitForGoogleScript(timeoutMs = 8000): Promise<void> {
  if (typeof window === 'undefined') return;
  const ready = () =>
    Boolean((window as { google?: { accounts?: unknown } }).google?.accounts);
  // 原生壳里根本不会有这个全局，等一小会儿拿不到就直接放行 —— 那边用的是系统账号。
  const deadline = Date.now() + timeoutMs;
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface AuthResponse {
  token: string;
  expiresAt: number;
  account: SyncAccount;
}

/** 走完整条登录链路。任何一步失败都抛出去，由设置页显示原文（后端的报错是写给人看的）。 */
export async function signIn(): Promise<SyncAccount> {
  await ensureGoogleReady();
  const { SocialLogin } = await import('@capgo/capacitor-social-login');
  const login = await SocialLogin.login({
    provider: 'google',
    options: { scopes: ['email', 'profile'] },
  });

  // 插件把令牌放在 result 里（不是顶层），三端一致。
  const idToken = (login.result as { idToken?: string } | undefined)?.idToken;
  if (!idToken) throw new Error('Google 没有返回 ID token');

  const session = await syncFetch<AuthResponse>('/v1/auth/google', {
    method: 'POST',
    body: { idToken },
  });
  await putMeta<SyncSession>(META_KEYS.syncSession, session);
  return session.account;
}

export async function signOut(): Promise<void> {
  await clearSession();
  try {
    const { SocialLogin } = await import('@capgo/capacitor-social-login');
    await SocialLogin.logout({ provider: 'google' });
  } catch {
    // 本机会话已经清了，插件那边登没登出不影响正确性。
  }
}

/**
 * 向服务器确认这张令牌还有效。启动时静默调一次：
 * 令牌被撤销（白名单里删了这个邮箱）时要尽早把 UI 变成「未登录」，
 * 而不是等到某次推送失败才发现——那时用户已经练完一整课了。
 */
export async function refreshAccount(): Promise<SyncAccount | null> {
  const session = await getSession();
  if (!session) return null;
  try {
    const { account } = await syncFetch<{ account: SyncAccount }>('/v1/me', {
      token: session.token,
    });
    await putMeta<SyncSession>(META_KEYS.syncSession, { ...session, account });
    return account;
  } catch (err) {
    if (err instanceof SyncAuthError) {
      await clearSession();
      return null;
    }
    // 离线：保持已登录状态，等下次。
    return session.account;
  }
}
