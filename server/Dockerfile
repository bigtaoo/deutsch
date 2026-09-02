# 单阶段就够：Node 26 直接跑 .ts（内建类型擦除），所以镜像里没有构建步骤、没有 tsc、
# 也没有编译工具链 —— 存储用的是 Node 自带的 node:sqlite，不是 better-sqlite3。
FROM node:26-slim

WORKDIR /app

# 依赖单独一层：只改业务代码时这层命中缓存。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8790

# 数据目录由 compose 挂进来；镜像里先建好并交给 node 用户，容器不以 root 跑。
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8790

# 不用 npm start：npm 会多一层进程，容器停止时 SIGTERM 传不到 node，
# 于是每次 restart 都要等 10 秒超时被 KILL（index.ts 里那个优雅关闭就白写了）。
CMD ["node", "src/index.ts"]
