// 校验 Google ID token。
//
// 关键点：**签名必须自己验**。前端传上来的那串 JWT 是不可信输入，
// 解开 payload 直接信 email 等于没有鉴权 —— 谁都能手搓一个 `{"email":"你@gmail.com"}`。
// jose 的 createRemoteJWKSet 会按 Cache-Control 缓存 Google 的公钥并在轮换时自动重取。
//
// 三重校验缺一不可：
//   iss —— 必须是 Google；
//   aud —— 必须是**我们自己**的客户端 ID（否则任何一个 Google 应用的 token 都能拿来登录这里）；
//   email_verified —— Google 自己都不确认的邮箱，不能用来匹配白名单。

import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export class GoogleTokenError extends Error {}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

export function createGoogleVerifier(clientIds: string[]): GoogleVerifier {
  return async (idToken: string): Promise<GoogleIdentity> => {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
        issuer: GOOGLE_ISSUERS,
        audience: clientIds,
      }));
    } catch (err) {
      throw new GoogleTokenError(`Google ID token 校验失败：${err instanceof Error ? err.message : err}`);
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (!sub || !email) throw new GoogleTokenError('Google ID token 里没有 sub 或 email');
    if (payload.email_verified !== true) throw new GoogleTokenError('这个 Google 账号的邮箱未验证');

    return {
      sub,
      email: email.toLowerCase(),
      name: typeof payload.name === 'string' ? payload.name : null,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    };
  };
}
