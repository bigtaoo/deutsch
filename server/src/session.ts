// 应用自己的会话令牌。
//
// 为什么不直接一路用 Google 的 ID token：它只有一小时有效期，而这个应用的同步是
// 「后台安静地推」——每小时弹一次 Google 登录框，等于没有自动备份。所以拿 ID token
// 换一个我们自己签的、长期有效的令牌，之后所有 API 都认它。
//
// 它是 HS256 对称签名，密钥只在服务器上。令牌里只放 sub —— 邮箱、头像每次从库里读，
// 这样白名单里删掉一个人之后，他手上那张旧令牌立刻失效（authenticate() 会查不到用户）。

import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'deutsch-sync';
const AUDIENCE = 'deutsch-app';

export class SessionError extends Error {}

export async function signSession(
  secret: Uint8Array,
  userId: string,
  ttlDays: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + ttlDays * 86_400_000;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(secret);
  return { token, expiresAt };
}

export async function verifySession(secret: Uint8Array, token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('缺少 sub');
    return payload.sub;
  } catch (err) {
    throw new SessionError(err instanceof Error ? err.message : String(err));
  }
}
