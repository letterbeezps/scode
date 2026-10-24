# 后端镜像：LangGraph Agent Server（langgraph dev，inmem 运行时）。
#
# 构建上下文是仓库根目录。
#
# ## 目录布局
#
#   /opt/venv    Python 虚拟环境（依赖 + 项目本身的 editable 安装）
#   /app         stupid-code 本体：源码 + conf/ + data/
#   /workspace   agent 的工作空间 = agent 能操作的目录（运行时 volume 挂载）
#
# ## 为什么 app 根和 workspace 要分开
#
# 两者都是"目录"，但**性质不同**：
#
# - `/app` 是被执行的代码，它的位置是**框架约定死的**：
#   `config/model.py` 用 `parents[2] / "conf"` 找配置，
#   `graph/persistence.py` 用 `parents[1] / "data"` 找 SQLite，
#   `launcher.py` 用 `__file__` 的上级目录找 langgraph.json。
#   项目必须装成 **editable**（`uv sync` 默认如此），`stupid_code` 才解析到
#   `/app/stupid_code` 而不是 site-packages——装成非 editable 这些路径全落到
#   site-packages 里，直接找不到文件。
#
# - `/workspace` 是 agent 干活的目录，它的内容由用户决定，随时可以指向别的项目。
#
# 早先一版把两者合在 `/workspace`（源码也放那儿），结果 **workspace 一换，
# 挂载就把源码整个盖住**，容器直接 ModuleNotFoundError。分开是必须的。
#
# ## 运行时挂载
#
#   ./conf               → /app/conf                （api_key 在这，不进镜像）
#   ./stupid_code/data   → /app/stupid_code/data    （SQLite checkpoint）
#   $SCODE_WORKSPACE     → /workspace               （agent 的工作空间）
#
# 挂 ./conf 和 ./data 而不是整仓库，是为了让**后端代码来自镜像**（稳定、
# 与 workspace 无关），而**配置和持久化来自宿主**（含密钥、可备份）。

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

# uv 只用来装依赖；留在镜像里方便进容器排查。
RUN pip install --no-cache-dir uv==0.11.3

# ---- 构建：代码装在 /app ----
WORKDIR /app

# 先只拷锁文件装依赖：改代码不会让这一层失效。
# README.md 一起带上——hatchling 构包时要读它（pyproject.toml 里
# readme = "README.md"），缺了构建会失败。
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-install-project --no-dev

# 再拷源码，装项目本身（editable，.pth 指向 /app）。
COPY stupid_code/ ./stupid_code/
COPY conf/ ./conf/
RUN uv sync --frozen --no-dev

# ---- 运行 ----
# 工作空间：agent 的 shell / 文件工具以此为根（launcher 取进程 cwd）。
RUN mkdir -p /workspace
WORKDIR /workspace

EXPOSE 2024

# 健康检查用 venv 里的 python，不额外装 curl。
# /ok 是 langgraph dev 的就绪端点（launcher 也用它做启动校验）。
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=6 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:2024/ok', timeout=2).read()"

# 容器里要绑 0.0.0.0 才对外可达。对外暴露面由 compose 的 ports 绑定控制
# （只绑 127.0.0.1），见 docker-compose.yml。
ENV SCODE_BIND_HOST=0.0.0.0

# scode 自己就是入口：它负责派生配置、就绪校验、端口锁定和优雅关停。
ENTRYPOINT ["/opt/venv/bin/scode"]
