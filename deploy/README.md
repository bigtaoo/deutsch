# 同步后端的部署与联调

前端在 Cloudflare（`d.gamestao.com`，纯静态）。同步后端跑在 **wnet 的那台 VPS**
（`wnet-server` = `wnet-mock.elk.de` = `92.205.18.79`，Debian 13），域名 **`sync.gamestao.com`**。

这台机器上还跑着公司那套 wnet mock 栈（frontend / webapi / mssql / grafana / caddy）。
本方案对它的侵入面只有一处：**在 `~/wnet/docker/Caddyfile` 里加一个 site block**。
除此之外全部在 `~/deutsch-sync/` 这个独立的 compose 项目里，随时可以整个删掉。

---

## 0. 先决条件（**已于 2026-09-02 全部完成**，重装时照这里走）

> 现状：DNS 已配（灰云）、Google 项目 `deutsch`（项目号 996386780227）下的 Web 与 iOS
> 两个客户端已建、白名单是 `tao.wang.go@gmail.com`、Caddy 的 site block 已加且证书已从
> 正式 Let's Encrypt 签下。`curl https://sync.gamestao.com/v1/healthz` 现在就通。
> **Android 客户端还没建** —— 那条流水线一次没推过、签名 keystore 还不存在。

### ① DNS

在 Cloudflare 给 `gamestao.com` 加一条记录：

| 类型 | 名称 | 内容 | 代理状态 |
| --- | --- | --- | --- |
| A | `sync` | `92.205.18.79` | **仅 DNS（灰云）** |

**必须是灰云。** 橙云代理会让 Caddy 的 ACME 校验拿不到 Let's Encrypt 的挑战，
证书永远签不下来，症状是浏览器一直报 `ERR_SSL_...` 而服务器日志里只有重试。

### ② Google OAuth 客户端

Google Cloud Console → 新建项目（或用已有的）→ **API 和服务 → 凭据**：

1. **OAuth 同意屏幕**：用户类型选 **外部（External）**；发布状态留在「测试」也行，
   但要把自己的 Google 账号加进 **Audience → 测试用户**，否则登录会被挡。
   `email` / `profile` 这两个 scope 不需要审核。
2. 建 **Web 应用** 类型的客户端：
   - 已获授权的 JavaScript 来源：`https://d.gamestao.com`、`http://localhost:5173`
   - 已获授权的重定向 URI：`https://d.gamestao.com`、`http://localhost:5173`
     —— **这一条是必填的，而且要一字不差**。插件在浏览器里走的是「弹窗 + 完整 OAuth
     重定向」而不是 One Tap，前端送上去的 `redirect_uri` 就是这个裸 origin
     （src/sync/session.ts 的 `oauthRedirectUrl()` 写死成 `location.origin`）。
     多一条结尾斜杠、或者只填了「JavaScript 来源」没填这一栏，弹窗里就是
     `错误 400: redirect_uri_mismatch`。本机调试端口不是 5173 时同理要补一条。
   - → 得到 `VITE_GOOGLE_WEB_CLIENT_ID`，**Android 也用这个**
3. 建 **iOS** 类型的客户端：Bundle ID 填 `com.gamestao.deutsch`
   - → 得到 `VITE_GOOGLE_IOS_CLIENT_ID`
4. 建 **Android** 类型的客户端：包名 `com.gamestao.deutsch` + 签名 SHA-1
   - 调试版：`cd android && ./gradlew signingReport`
   - 正式版：`keytool -printcert -jarfile android/app/release/app-release.apk`
   - 上架 Play 商店后还要把 **Play 应用签名** 的 SHA-1 也登记一个
   - 这个客户端 ID **不进代码**，它只是让 Google 认这个 APK

三个客户端必须在**同一个** Google Cloud 项目里。控制台改动最长要等几小时才生效。

### ③ 白名单邮箱

服务器只认白名单里的 Google 邮箱（`ALLOWED_EMAILS`）。别人拿同一个登录按钮点下去会吃 403。
**留空服务器拒绝启动** —— 一个挂在公网 443 上、谁登录都给存东西的备份服务器，
比没有备份服务器糟糕得多。

---

## 1. 部署后端

从仓库根目录把 `server/` 推上去（不带 `node_modules` 和 `data`）：

```bash
rsync -av --delete --exclude node_modules --exclude data --exclude .env server/ wnet-server:~/deutsch-sync/
```

然后在服务器上：

```bash
ssh wnet-server
cd ~/deutsch-sync
cp .env.example .env
openssl rand -hex 32          # 把结果填进 .env 的 SESSION_SECRET
id -u; id -g                  # 填进 SYNC_UID / SYNC_GID
vi .env                       # 再填 GOOGLE_CLIENT_IDS 和 ALLOWED_EMAILS
docker compose up -d --build
docker compose logs -f sync   # 看到「监听 0.0.0.0:8790」就起来了
```

**第一次启动如果报 `ERR_SQLITE_ERROR: unable to open database file`**：
`./data` 是 docker 头一次挂载时建的，属 root，容器里那个非 root 用户写不进去。
（这台机器上 `sudo` 要密码，所以借一个 root 容器改属主：）

```bash
docker run --rm -v "$PWD/data:/data" busybox chown -R "$(id -u):$(id -g)" /data
docker compose restart sync
```

`GOOGLE_CLIENT_IDS` 填 **Web 和 iOS 两个**客户端 ID，逗号分隔（Android 用的是 Web 那个，
所以不用填 Android 客户端 ID）。这是 ID token 的 `aud` 白名单 —— 不校验它，
任何一个 Google 应用签出来的 token 都能拿来登录这台服务器。

自检（不经过 Caddy，直接问容器）：

```bash
docker exec deutsch-sync node -e "fetch('http://127.0.0.1:8790/v1/healthz').then(r=>r.json()).then(console.log)"
```

## 2. 挂到 Caddy 上

要加的那段已经放在服务器上了：`~/deutsch-sync/Caddyfile.snippet`。内容是

```caddyfile
sync.gamestao.com {
	reverse_proxy deutsch-sync:8790
}
```

**这一步没有替你做**：`~/wnet/docker/Caddyfile` 是公司那套栈的配置，动它得你自己点头。
备份 + 追加 + 热加载（`reload` 不重启容器，wnet 那边的连接一条都不断）：

```bash
ssh wnet-server 'cd ~/wnet/docker && cp Caddyfile Caddyfile.bak-$(date +%Y%m%d-%H%M%S) && cat ~/deutsch-sync/Caddyfile.snippet >> Caddyfile && docker exec docker-caddy-1 caddy validate --config /etc/caddy/Caddyfile && docker exec docker-caddy-1 caddy reload --config /etc/caddy/Caddyfile'
```

要撤销就把 Caddyfile 换回那份 `.bak` 再 reload 一次。

DNS 生效后 Caddy 会自动签好证书。验证：

```bash
curl https://sync.gamestao.com/v1/healthz
# {"ok":true,"users":0,"docs":0}
```

## 3. 前端

本机手工发一次：仓库根 `cp .env.example .env.local`，填 `VITE_SYNC_API_BASE` 和两个客户端 ID，然后

```bash
npm run deploy
```

**走 CI 发布（push 到 main 的那条路）还要在 GitHub 上配三个仓库变量**，否则线上那份构建里
同步是关的 —— 而且不报错，只在设置页显示「这个构建没有配置同步服务器」，很容易当成代码坏了。

Settings → Secrets and variables → Actions → **Variables**（不是 Secrets：客户端 ID 本来就会
原样出现在下发的 JS 里，它不是秘密；真正的秘密是服务器上的 `SESSION_SECRET`，那个不进仓库）：

| 变量 | 值 |
| --- | --- |
| `SYNC_API_BASE` | `https://sync.gamestao.com` |
| `GOOGLE_WEB_CLIENT_ID` | Web 客户端 ID |
| `GOOGLE_IOS_CLIENT_ID` | iOS 客户端 ID |

`deploy.yml`、`release-ios.yml`、`release-android.yml` 三条流水线的构建步骤都读这三个变量。
本机构建读的仍然是 `.env.local`，两边要一致。

原生壳本机出包：`npm run cap:sync:ios` / `npm run cap:sync:android`。
**第一次必须跑一次 `cap sync`** —— Google 登录插件（`@capgo/capacitor-social-login`）的
原生依赖是靠它写进 iOS 的 `Package.swift` 和 Android 的 gradle 的。

### iOS 还要改 Info.plist

`ios/App/App/Info.plist` 里加上 iOS 客户端 ID 的**反向域名**作为 URL scheme
（形如 `com.googleusercontent.apps.1234567890-abcdef`，就是客户端 ID 前后两段调个个）：

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.googleusercontent.apps.你的-iOS客户端ID</string>
    </array>
  </dict>
</array>
```

没有它，登录会跳出去 Safari 然后回不来。

### Android

不用改代码。要确认的是 `android/app/build.gradle` 里的 `applicationId` 与 Google 控制台里
Android 客户端登记的包名**逐字一致**（含任何 `.debug` 后缀）。

---

## 4. 验收清单

- [ ] `curl https://sync.gamestao.com/v1/healthz` 返回 `{"ok":true,...}`，证书是 Let's Encrypt 签的
- [ ] 桌面浏览器：设置页点「用 Google 登录」→ 显示已登录 + 邮箱
- [ ] 用**不在白名单**的 Google 账号登一次 → 明确的 403 提示（不是白屏、不是「登录成功但同步不动」）
- [ ] 做一轮听写 → 设置页「同步状态」的「上次成功同步」变成刚才
- [ ] 换一台设备登同一个账号 → 「一键恢复」→ 课程与生词都在，课程显示「素材未下载」
- [ ] 两台设备各改一课同一处 → 后改的赢，先改的那台下次同步后跟上（不是互相覆盖）
- [ ] 断网做一课 → 首页状态条「待推送 N 项」→ 恢复网络自动清零
- [ ] iPhone 真机走一遍上面四条（原生壳的 Google 登录走的是系统账号，和 web 不是同一条码）

## 4b. 对齐那一半（FR-15.17，2026-09-03 新增）

这台服务器现在还替手机算 emissions（音频 → 帧级 log-prob）。**同步不依赖它** ——
装不上、关掉、算挂了都只让对齐那三条路由回 503，同步照常。

### 一次性：改 compose 并放好权重

**这两步 CI 干不了**（部署脚本只搬 `src/`、`package.json`、`package-lock.json`、`Dockerfile`，
compose 与 `.env` 一律不动，理由见 §6），所以第一次上线要手工做一次。
**2026-09-03（0.3.0）已经做过**：compose 送上去了（容器上确认 `mem=2147483648`、`cpus=3`），
权重是让服务器自己从 HF 取的（那一次 60.7 秒）。下面这些留着，是为了重装或换机器时照着走：

```bash
# ① mem_limit 必须从 256m 提到 2g，否则第一次对齐会把容器 OOM 掉（连同步一起带走）。
#    仓库里 server/docker-compose.yml 已经是新的，把它同步过去即可：
scp server/docker-compose.yml wnet-server:~/deutsch-sync/docker-compose.yml
```

```bash
# ② 权重（241MB 的 model_q4.onnx）。不放也能用 —— 第一次对齐时服务器自己去 HF 取，
#    只是那一次要多等几分钟。本机已经有一份（npm run stage:align 下过），直接送过去更快：
# 一行，别加反斜杠续行 —— 这些命令是在 PowerShell 里跑的
scp public/models/onnx-community/mms-300m-1130-forced-aligner-ONNX/onnx/model_q4.onnx wnet-server:~/deutsch-sync/data/models/onnx-community/mms-300m-1130-forced-aligner-ONNX/onnx/
```

```bash
# 目标目录要先建出来（属主是跑容器那个用户）
ssh wnet-server 'mkdir -p ~/deutsch-sync/data/models/onnx-community/mms-300m-1130-forced-aligner-ONNX/onnx'
```

```bash
# ③ 重建并起来（Dockerfile 变了：多了 ffmpeg + libgomp1 + onnxruntime-node）
ssh wnet-server 'cd ~/deutsch-sync && docker compose up -d --build'
```

`.env` 里**什么都不用加**：对齐默认开着，其余全有默认值。想调的话有这些
（改完 `docker compose up -d`）：`ALIGN_ENABLED`、`ALIGN_MODEL_DTYPE`（默认 q4，
**换它意味着服务器算的和手机/桌面算的不再逐位相同**）、`ALIGN_THREADS`（默认 3）、
`ALIGN_MAX_AUDIO_BYTES`（40MB）、`ALIGN_MAX_SECONDS`（1800）、`ALIGN_MAX_QUEUED`（3）、
`ALIGN_RESULT_TTL_MS`（30 分钟）。

### 验收（对齐这一半）

```bash
# ① 服务器认自己开着对齐
curl -s https://sync.gamestao.com/v1/healthz
# align.status 是 idle（还没加载过权重）或 ready；off = 被关掉了 / ORT 没装上
```

```bash
# ② 在真机器上读三个数：解码几秒、加载权重几秒、**一块几秒**。
#    先把一个真实 mp3 放进 data/（它只是探针的输入，不会被服务读到）
ssh wnet-server 'cd ~/deutsch-sync && docker compose exec sync node src/align/probe.ts /data/sample.mp3'
```

第 ③ 个数（一块几秒）× 27 就是「一课要等多久」。
探针最后打的那份指纹（frames + 前 5 个 log-prob + 全局均值）是拿来和桌面浏览器
算同一课时的结果对比的：**三条路应该给出同一份矩阵**。

**没有真实 mp3 也能验** —— 探针要的三个数与音频内容无关，现场生成一段正弦波就行：

```bash
ssh wnet-server 'cd ~/deutsch-sync && docker compose exec -T sync sh -c "ffmpeg -hide_banner -loglevel error -f lavfi -i \"sine=frequency=220:duration=25\" -ac 1 -ar 16000 /tmp/probe25.wav"'
```

**2026-09-03（0.3.0）在这台机器上的实测值**，以后回归时拿它对照：

| | 实测 |
|---|---|
| ffmpeg | 7.1.5，解码 25 秒音频用 0.1~0.2 秒 |
| `MatMulNBits` | 认（没有「算子找不到」）|
| 权重加载 | 首次 **60.7 秒**（含从 HF 下 241MB），之后 **0.6 秒** |
| 一块（20 秒音频）| **4.1~4.5 秒** → 一课 27 块约 **2 分钟**，实时倍率 4.5× |
| 容器内存 | 空载 104MiB / 2GiB |

- [x] `healthz` 里 `align.status` 不是 `off`（是 `idle`，还没加载过权重）
- [x] `probe.ts` 跑通：解码正常、权重加载成功（说明这份 ORT 认 `MatMulNBits`）、帧数与期望一致
- [x] 同一输入跑两次得到**逐位相同**的指纹
- [x] 容器上的限制真的生效了：`docker inspect deutsch-sync --format "{{.HostConfig.Memory}}"` = 2147483648
- [ ] 手机（登录状态）导入一课 → 自动送到服务器算 → 一两分钟后有时间戳，**期间锁屏不影响**
- [ ] 对齐进行中把 App 切走、回来 → 结果照样能取到（计算不在这台设备上）
- [ ] 桌面上对同一课算一遍，与服务器算的对比（指纹/时间戳应当一致）
- [ ] 关掉对齐（`ALIGN_ENABLED=false` + 重启）→ 手机上退回「不自动对齐」，而同步一切正常

### 出问题时先看哪儿

| 症状 | 多半是 |
|---|---|
| `align.status` 是 `off` | `ALIGN_ENABLED=false`，或 `onnxruntime-node` 没装进镜像（它是 optionalDependency，`npm ci` 会静静跳过装不上的平台） |
| 第一次对齐失败，`align.message` 里有 `libgomp` / `binding` | 镜像少了 `libgomp1`（Dockerfile 里有，确认镜像是新的） |
| 报错里有 `ffmpeg` | 镜像少了 ffmpeg，或那个音频文件本身坏了 |
| 容器反复重启、日志末尾是 `Killed` | `mem_limit` 还是 256m（见上面 ①） |
| 手机上按钮还是「在这台手机上对齐」 | 没登录（远端可用的判据是「配了服务器 + 有会话令牌」），或服务器回过 `align_off` |

## 5. 运维

前后端都由 CI 自动部署（见 §6）。下面这些是手工干预时用的。

### 常用命令

```bash
# 看日志
docker compose -f ~/deutsch-sync/docker-compose.yml logs -f sync

# 备份数据库（就一个 SQLite 文件）
scp wnet-server:~/deutsch-sync/data/sync.sqlite ./sync-backup-$(date +%F).sqlite

# 手工更新代码（正常走 CI，这条是绕过 CI 时用）
rsync -av --delete --exclude node_modules --exclude data --exclude .env server/ wnet-server:~/deutsch-sync/
ssh wnet-server 'cd ~/deutsch-sync && docker compose up -d --build'

# 改 compose 或环境变量：CI **改不了**这两样（见 §6），只能手工
ssh wnet-server 'cd ~/deutsch-sync && vi .env && docker compose up -d'

# 整个拆掉（对 wnet 栈零影响，记得同时删掉 Caddyfile 里那个 block）
ssh wnet-server 'cd ~/deutsch-sync && docker compose down && rm -rf ~/deutsch-sync'
```

每个文档在服务器上保留最近 30 个历史版本（`REVISIONS_PER_DOC`），这是 GitHub 方案里
「git 历史可回滚」的替代物 —— 写坏数据后同步上去，旧版本还在：

```bash
curl -H "Authorization: Bearer <会话令牌>" https://sync.gamestao.com/v1/docs/vocab/revisions
curl -H "Authorization: Bearer <会话令牌>" https://sync.gamestao.com/v1/docs/vocab/revisions/12
```

---

## 6. CI 自动部署（前后端都有）

push 到 `main` → CI 跑绿 → `deploy.yml` 里两个 job 并行：

| job | 目标 | 怎么做 |
| --- | --- | --- |
| `deploy` | `d.gamestao.com` | `npm run build`（读三个仓库变量注入客户端 ID）→ `wrangler deploy` |
| `deploy-server` | `sync.gamestao.com` | 把 `server/` 打成 tar 从 stdin 推过去 → 服务器上重建容器 → 内外各验一次 healthz |

两个 job 互不依赖，谁失败都不影响另一个。前后端可以各自单独上线：API 是加法式演进的，
新前端配旧后端最多是某个新功能不工作，不会把数据弄坏。

### 那把部署密钥能干什么（只能干什么）

CI 用的**不是**你日常那把 `D:\cloud\id_ed25519`，而是专用的
`D:\cloud\deutsch_sync_ci_ed25519`（私钥同时写进了 GitHub Secret `SYNC_DEPLOY_KEY`；
**本地这份是唯一可读的副本** —— GitHub Secret 只写不可读，见 `ios-release-vault` 那条教训）。

它在服务器的 `~/.ssh/authorized_keys` 里挂着 OpenSSH 的**强制命令**：

```
command="/home/tao/deutsch-sync-ci-deploy.sh",restrict ssh-ed25519 AAAA...
```

于是拿着这把私钥的人**不能登录那台机器**，只能触发那一个部署脚本。`restrict` 再关掉
端口转发、agent 转发、pty 和 X11（否则可以用转发绕开强制命令）。那台机器上还跑着
公司的 wnet 栈（mssql / webapi / grafana），所以这层收紧不是洁癖。

脚本本体：仓库里的副本是 `deploy/ci-deploy.sh`，**活的那份装在 `~/deutsch-sync-ci-deploy.sh`
（部署目标的外面）** —— 装在里面的话，一次部署就能把它自己换掉，强制命令当场失效。

它只搬四样东西进 `~/deutsch-sync/`：`src/`、`package.json`、`package-lock.json`、`Dockerfile`。
**`docker-compose.yml` 和 `.env` 一律不动**，这样这把密钥就无法写一个「把宿主 `/` 挂进容器」
的 compose 去拿宿主 root —— 那是「CI 能部署容器」这件事最大的一个洞。代价是改 compose
或环境变量必须手工上服务器改（一年几次的事，命令在 §5）。

### 一次性安装（已完成，重装时照这个来）

```bash
# 1. 生成专用密钥并留档
ssh-keygen -t ed25519 -f /d/cloud/deutsch_sync_ci_ed25519 -N "" -C "github-actions deutsch-sync deploy"

# 2. 装部署脚本（注意：装在 ~/deutsch-sync 的外面）
scp deploy/ci-deploy.sh wnet-server:~/deutsch-sync-ci-deploy.sh
ssh wnet-server 'chmod 700 ~/deutsch-sync-ci-deploy.sh'

# 3. 把公钥按强制命令的形式登记。
#    这台机器的 ~/.ssh 与 authorized_keys **属 root**，tao 改不了，所以要 sudo：
ssh -t wnet-server 'sudo sh -c "cat /home/tao/deutsch-sync-ci-authorized-key.txt >> /home/tao/.ssh/authorized_keys"'

# 4. 写进 GitHub
gh secret set SYNC_DEPLOY_KEY -R bigtaoo/deutsch < /d/cloud/deutsch_sync_ci_ed25519
gh variable set SYNC_SSH_HOST -R bigtaoo/deutsch -b "92.205.18.79"
gh variable set SYNC_SSH_USER -R bigtaoo/deutsch -b "tao"
gh variable set SYNC_SSH_KNOWN_HOSTS -R bigtaoo/deutsch -b "$(ssh-keyscan -t ed25519 92.205.18.79 | grep -v '^#')"
gh variable set SERVER_DEPLOY_ENABLED -R bigtaoo/deutsch -b "true"
```

第 4 步里的 `known_hosts` 是**固定主机密钥**用的，工作流里刻意不用
`StrictHostKeyChecking=no` —— 那等于每次部署都接受任何自称是这台机器的主机，
把私钥和整份载荷交给它。装的时候核对过：`ssh-keyscan` 扫到的指纹与从已建立信任的
通道里问服务器自己（`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`）一致，
`SHA256:oK6aAE5TqSiyITnytJ+DQgHObRmI3aqBYOEPKHAY6GA`。**换机器或重装 sshd 之后这条要重设。**

### 手动触发一次部署

```bash
gh workflow run deploy -R bigtaoo/deutsch
gh run watch -R bigtaoo/deutsch
```

`workflow_dispatch` 走的是同一条路，不必先 push 一个 commit。
