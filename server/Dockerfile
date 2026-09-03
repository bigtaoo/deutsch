# 单阶段就够：Node 26 直接跑 .ts（内建类型擦除），所以镜像里没有构建步骤、没有 tsc、
# 也没有编译工具链 —— 存储用的是 Node 自带的 node:sqlite，不是 better-sqlite3。
FROM node:26-slim

WORKDIR /app

# 这两个包是**对齐那一半**（FR-15.17）要的，同步那一半一个都不需要：
#   · ffmpeg   —— 把 mp3 解成 16kHz 单声道 float32（server/src/align/decode.ts）
#   · libgomp1 —— onnxruntime 的 OpenMP 运行时。少了它 onnxruntime_binding.node
#                 加载即失败，而报错长得像「模块找不到」，会把人引到 npm 那边去查半天
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
 && rm -rf /var/lib/apt/lists/*

# 依赖单独一层：只改业务代码时这层命中缓存。
#
# `--ignore-scripts`：onnxruntime-node 的 postinstall 只为下载 CUDA EP 的额外二进制，
# 而 **CPU 那份是随包带的**（bin/napi-v6/linux/x64）。新版 npm 默认也会拦住这个脚本，
# 显式写出来是为了让「装出来的东西」在任何 npm 版本下都一样。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force
# 别的平台那几份 ORT 二进制在这台机器上永远用不到（Windows 那份还带 18MB 的 DirectML）。
# 删掉省约 100MB —— 这台 VPS 的根盘已经 84% 满了。
RUN rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/onnxruntime-node/bin/napi-v6/win32

COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8790

# 数据目录由 compose 挂进来；镜像里先建好并交给 node 用户，容器不以 root 跑。
# 对齐的权重也落在这里（/data/models），所以它**不进镜像** —— 见 src/align/model.ts。
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8790

# 不用 npm start：npm 会多一层进程，容器停止时 SIGTERM 传不到 node，
# 于是每次 restart 都要等 10 秒超时被 KILL（index.ts 里那个优雅关闭就白写了）。
CMD ["node", "src/index.ts"]
