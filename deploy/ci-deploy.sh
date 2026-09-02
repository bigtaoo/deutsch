#!/bin/sh
# CI 部署同步后端时在服务器上执行的**唯一**命令。
#
# ── 它为什么是这个形状 ──
# 部署密钥在服务器的 `~/.ssh/authorized_keys` 里是这样登记的：
#
#   command="/home/tao/deutsch-sync-ci-deploy.sh",restrict ssh-ed25519 AAAA...
#
# `command=` 是 OpenSSH 的**强制命令**：拿着这把私钥的人无论请求执行什么，
# sshd 都只运行这个脚本。于是这把密钥的能力被钉死成「部署一次同步后端」，
# 而不是「以 tao 的身份登录那台机器」—— 那台机器上还跑着公司的 wnet 栈。
# `restrict` 再关掉端口转发、agent 转发、pty 和 X11（否则可以拿转发绕开强制命令）。
#
# ── 它为什么装在 ~/deutsch-sync 的**外面** ──
# 因为它自己不能是可部署内容。装在部署目标里的话，一次部署就能把这个脚本替换掉，
# 强制命令的约束当场归零。所以**活的那份在 `~/deutsch-sync-ci-deploy.sh`，
# 这份只是仓库里的副本，改了要手工重新装一遍**（deploy/README.md §6 有命令）。
#
# ── 它为什么只搬四样东西 ──
# `docker-compose.yml` 和 `.env` 一律不动。让这把密钥无法改 compose，
# 它就无法写一个「把宿主 / 挂进容器」的 compose 文件去拿宿主 root ——
# 那是「CI 能部署容器」这件事本身最大的一个洞，堵在这里最省事。
# 代价：改了 compose 或环境变量必须手工上服务器改一次（一年几次的事）。
set -eu

TARGET="$HOME/deutsch-sync"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# CI 端是 `tar czf - -C server . | ssh ...`，所以载荷从 stdin 来。
tar xzf - -C "$STAGE"

for path in src package.json package-lock.json Dockerfile; do
  if [ ! -e "$STAGE/$path" ]; then
    echo "载荷里缺少 $path，中止（没有半途而废的部署）" >&2
    exit 1
  fi
done

rm -rf "$TARGET/src"
cp -R "$STAGE/src" "$TARGET/src"
cp "$STAGE/package.json" "$STAGE/package-lock.json" "$STAGE/Dockerfile" "$TARGET/"

cd "$TARGET"
docker compose up -d --build
docker compose ps --format '{{.Name}} {{.Status}}'

# 部署不以「命令返回 0」为成功，以**服务真的答话**为成功。
# 没有这一步，一个起不来的容器会让 CI 显示绿色 —— 静默失败的部署和静默失败的备份一样坏。
docker exec deutsch-sync node -e "
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 15; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:8790/v1/healthz');
      if (res.ok) {
        console.log('healthz', JSON.stringify(await res.json()));
        process.exit(0);
      }
    } catch {
      /* 还没起来 */
    }
    await wait(1000);
  }
  console.error('15 秒内 /v1/healthz 没有回应，部署算失败');
  process.exit(1);
})();
"
