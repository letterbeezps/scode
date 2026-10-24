# 前端镜像：Vite 构建产物 + nginx 静态托管 + /api 反代。
#
# 构建上下文是 web/ 目录（前端是独立的 pnpm 项目，不参与 uv 依赖管理）。

# ---------- 构建阶段 ----------
FROM node:24-slim AS build

WORKDIR /app

# 直接装指定版本的 pnpm，不用 corepack：
# corepack 校验新版 pnpm 的签名 key 时经常报 "Cannot find matching keyid"，
# 显式 npm i -g 更省事也更可控（版本与 package.json 的 packageManager 对齐）。
RUN npm install -g pnpm@12.11.2

# 先只拷依赖清单，让 pnpm install 这一层能被缓存住。
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

# 构建期注入 VITE_* 变量（Vite 在构建时把它们内联进产物）。
# 这些值必须显式给足，不能依赖宿主的 .env.local——它不在版本库里，
# 而且 mock 模式开着的话容器里跑的是假数据，看着像"后端没连上"。
#
#   VITE_USE_MOCK=false    接真后端
#   VITE_API_BASE_URL=/api 请求走同源相对路径，由 nginx 反代到后端
#   VITE_ASSISTANT_ID      对应 langgraph.json 里的 graphs key
ENV VITE_USE_MOCK=false \
    VITE_API_BASE_URL=/api \
    VITE_ASSISTANT_ID=code_agent

RUN pnpm build

# ---------- 运行阶段 ----------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
