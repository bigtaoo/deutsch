// 打一个热更包（SPEC §7.12 / 变更 41）：把 dist/ 里**除了权重和词库之外**的东西压成 zip，
// 连同一份 manifest.json 写进 ota-staging/，由部署流水线搬进 dist/ota/ 发到 d.gamestao.com。
//
// 用法：npm run build:ota
//
// ── 打的必须是 native 构建 ──
// 所以 npm script 串的是 `build:native && node scripts/build-ota.mjs`，不是 `build`。
// 原因就是 vite.config.ts 顶部那段：web 构建带 Service Worker，而原生壳里 SW 既没用途
// 又有害（它会缓存住 index.html，而原生壳里没有地址栏也没有开发者工具可以清它）。
// 把 web 构建当热更包推下去，等于把变更 30 特意从原生壳里拆掉的东西又装了回去。
// main() 里有一道 sw.js 的硬校验挡着 —— 这种错发出去以后没有回头路（用户手上那份
// 会自己缓存自己），必须在构建时就炸。
//
// ── 为什么输出在 ota-staging/ 而不是直接写进 dist/ota/ ──
// dist 要先后被两次构建占用（native 打包 → web 发布），而 `vite build` 会清空 outDir。
// 写进 dist 的话第二次构建就把它删了。放仓库根的临时目录，部署那一步再搬进去。
//
// ── 为什么排除 models/ 与 dict/ ──
// 它们占 dist 的 458MB / 495MB，而且**从不随代码改动而变**（权重来自 HF 的固定 revision，
// 词库由 scripts 生成后基本不动）。每次热更传 458MB 既不可能也没意义。手机上这两份
// 一直用 IPA 里那一份 —— 热更包解开后由 AppDelegate.swift 建符号链接指回去，详见那边。
// `share/`（FR-18 的六张分享底图，1.3MB）**要进包**：它小，而且真的会跟着代码改。
//
// ── buildId 用 commit 短 sha ──
// 不用 semver 递增：只有 main 一条线，「换成这一份」就是全部语义，而版本号比大小会让
// **回滚**（版本号往回走）被客户端拒绝 —— 恰好在最需要更新生效的时候不生效。
// 判断逻辑见 src/platform/nativeUpdate.ts 的 decideUpdate。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT_DIR = join(ROOT, 'ota-staging');

/** 不进热更包的顶层目录。见文件顶部。 */
const EXCLUDE = new Set(['models', 'dict']);

/**
 * 能吃这个包的最低原生壳版本（MARKETING_VERSION）。
 *
 * **手改**。凡是这次前端改动用到了新的原生能力（align-native 新方法、新装的 Capacitor
 * 插件、AppDelegate 里的新行为），就把它提到那一版壳的版本号 —— 否则包会推给一个
 * 没有那些原生代码的旧壳，症状是「点了没反应」，比崩溃还难查（崩溃至少有回滚兜底）。
 * 0.4.0 是第一个带热更客户端的壳，所以下限从它开始：更早的壳根本不会来问。
 */
const MIN_NATIVE = '0.4.0';

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** dist 下所有该进包的文件，返回相对 dist 的 posix 路径。 */
async function collect(dir, base = DIST) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (dir === base && EXCLUDE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collect(full, base)));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(/[\\/]/).join(posix.sep));
    }
  }
  return out;
}

function gitShortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    // CI 之外、或者不在 git 检出里 —— 用时间戳兜底，至少保证每次构建都不一样
    // （buildId 相等就不更新，给了固定值会让本地打的包永远推不出去）。
    return `t${Date.now().toString(36)}`;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

async function main() {
  // index.html 必须在 zip 根 —— 插件就是这么找入口的。顺带证明 dist 是构建过的。
  try {
    await stat(join(DIST, 'index.html'));
  } catch {
    console.error('dist/index.html 不在 —— 先跑 npm run build:native');
    process.exit(1);
  }

  // 这一版**必须**是 native 构建。见文件顶部：把带 SW 的 web 构建热更下去，
  // 等于给一个没有地址栏、没有开发者工具的壳装上一个清不掉的缓存层。
  // 发出去就没有回头路了，所以在这儿硬拦。
  for (const swFile of ['sw.js', 'registerSW.js']) {
    try {
      await stat(join(DIST, swFile));
      console.error(
        `dist/${swFile} 在 —— 这是 web 构建，不能当热更包。` +
          '跑 npm run build:ota（它内部走的是 build:native）',
      );
      process.exit(1);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  const files = await collect(DIST);
  await mkdir(OUT_DIR, { recursive: true });

  const buildId = gitShortSha();
  const { version: appVersion } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const version = `${appVersion}+${buildId}`;
  const zipName = `bundle-${buildId}.zip`;
  const zipPath = join(OUT_DIR, zipName);

  const zip = new yazl.ZipFile();
  for (const rel of files) zip.addFile(join(DIST, rel), rel);
  zip.end();
  // 覆盖同名包是对的：同一个 commit 重跑一次就该得到同一个文件名。
  await new Promise((resolve, reject) => {
    const ws = zip.outputStream.pipe(createWriteStream(zipPath));
    ws.on('close', resolve);
    ws.on('error', reject);
  });

  const { size } = await stat(zipPath);
  const manifest = {
    buildId,
    version,
    url: `${(process.env.OTA_BASE ?? 'https://d.gamestao.com').replace(/\/$/, '')}/ota/${zipName}`,
    minNative: MIN_NATIVE,
    bytes: size,
    sha256: await sha256(zipPath),
    builtAt: new Date().toISOString(),
  };
  await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`热更包 ${zipName}：${files.length} 个文件，${mib(size)}`);
  console.log(`  version   ${version}`);
  console.log(`  minNative ${MIN_NATIVE}`);
  console.log(`  url       ${manifest.url}`);
}

await main();
