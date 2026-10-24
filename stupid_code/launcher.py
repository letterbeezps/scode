"""scode 入口：以子进程方式启动 `langgraph dev`，就绪后验证服务与图注册。

用法：

    cd /path/to/workspace
    uv run scode

工作空间语义：
- 在哪个目录运行 scode，那个目录就是 agent 的工作空间（子进程 cwd 不搬动）；
  agent 的 shell / 文件工具以这里为根（backend 是真实磁盘，见 graph/backend.py）。
- langgraph dev 必然在 cwd 下生成 `.langgraph_api/`（inmem 运行时硬编码的
  相对路径，无法通过配置改到别处）。**这个目录要保留，不要删**：checkpoint
  确实已由 graph/persistence.py 的 SQLite saver 接管（同名的
  `.langgraph_checkpoint.*.pckl` 是空的），但 `.langgraph_ops.pckl` 存的是
  **thread 索引**——会话列表与 metadata 的来源。删掉它，平台重启后认不出
  已有 thread：`/threads/search` 返回空、`/threads/{id}/state` 报 404，
  历史数据还躺在 SQLite 里却取不出来。
- 持久状态有两处，缺一不可：thread 索引在工作空间的 `.langgraph_api/` 里；
  checkpoint/store 由 graph/persistence.py 按 __file__ 定位到
  stupid_code/data/langgraph.db，与工作空间目录无关。

另外：
- 派生配置（把 langgraph.json 里的相对路径绝对化后）放系统临时目录，
  因为服务器一律按 cwd 解析这些相对路径，而这里的 cwd 是用户工作空间而非后端目录；
- 子进程设 PYTHONDONTWRITEBYTECODE=1，避免在后端源码目录写 __pycache__；
- 用 --no-reload：reload 监视 cwd，而 cwd 现在是用户的真实项目目录，
  agent 在工作空间写文件会自我触发重启，且后端源码不在 cwd，热重载本来就没意义；
- **端口锁死 2024**：被占用时直接启动失败，不自动换端口（见 `_resolve_port`）。
  早期版本让 `langgraph dev` 自己换端口，而就绪检查只轮询 2024——不锁定端口
  的话，就绪检查会打到**占着 2024 的旧服务**上误报"已就绪"，前端连的是旧
  代码，看起来就像"改了没生效"；
- Ctrl+C 时关闭整个子进程组（含 uvicorn 进程），不留孤儿进程——**启动阶段
  同样如此**（早期版本在启动阶段按 Ctrl+C 会漏掉清理，留下占端口的孤儿）。

监听地址：
- 默认绑 127.0.0.1（本机可见，这是安全姿态）；
- 容器里用 SCODE_BIND_HOST=0.0.0.0 改成全网卡绑，否则服务在容器外不可达。
  对外暴露面仍由 compose 的 ports 绑定（127.0.0.1）控制，见 AGENTS.md。
"""

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

# 监听地址。默认只听本机——这是安全姿态，不要改成 0.0.0.0（见 AGENTS.md）。
#
# 容器里要设成 0.0.0.0，否则服务在容器内网之外不可达。但那是**容器内部**
# 网络：对外暴露面由 compose 的 ports 绑定决定（只绑 127.0.0.1），
# 所以「只对本机可见」这条安全要求在容器形态下依然成立。
BIND_HOST = os.environ.get("SCODE_BIND_HOST", "127.0.0.1")

# 就绪探测永远打本机回环：绑 0.0.0.0 时 127.0.0.1 同样连得上，
# 而拿 0.0.0.0 当连接目标在不同平台上行为不一致。
PROBE_HOST = "127.0.0.1"

DEFAULT_PORT = 2024
GRAPH_ID = "code_agent"
CONFIG_NAME = "langgraph.json"
RUNTIME_DIR_PREFIX = "scode-config-"
READY_TIMEOUT_SECONDS = 60.0
POLL_INTERVAL_SECONDS = 0.5
STOP_TIMEOUT_SECONDS = 10.0


def _backend_dir() -> Path:
    # stupid_code/launcher.py 的上一级即后端目录（langgraph.json 所在处）
    return Path(__file__).resolve().parent


def _abs_import_spec(spec: str | dict, base_dir: Path) -> str | dict:
    """把 "./graph/agent.py:graph" 这类相对导入串改写成绝对路径形式。

    服务器对 graphs / checkpointer / store / http.app 的路径一律按进程 cwd
    解析，而 cwd 是用户的工作空间（任意目录），所以必须转成绝对路径。
    """
    if isinstance(spec, dict):
        return {**spec, "path": _abs_import_spec(spec["path"], base_dir)}

    path, sep, attr = spec.partition(":")
    if not sep or not path.startswith("."):
        return spec
    absolute = str((base_dir / path).resolve())
    return f"{absolute}:{attr}"


def _build_runtime_config(backend_dir: Path, runtime_dir: Path) -> Path:
    """读取后端目录的 langgraph.json，路径绝对化后写到临时目录。"""
    source = json.loads((backend_dir / CONFIG_NAME).read_text(encoding="utf-8"))

    source["graphs"] = {
        gid: _abs_import_spec(spec, backend_dir)
        for gid, spec in source.get("graphs", {}).items()
    }
    for key in ("checkpointer", "store"):
        section = source.get(key)
        if isinstance(section, dict) and "path" in section:
            section["path"] = _abs_import_spec(section["path"], backend_dir)
    http_section = source.get("http")
    if isinstance(http_section, dict) and "app" in http_section:
        http_section["app"] = _abs_import_spec(http_section["app"], backend_dir)

    target = runtime_dir / CONFIG_NAME
    target.write_text(
        json.dumps(source, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return target


def _graph_node_count(client: httpx.Client) -> int | None:
    """查询 code_agent 对应 assistant 的图结构，返回节点数；未就绪返回 None。"""
    search = client.post("/assistants/search", json={})
    if search.status_code != 200:
        return None
    assistant = next(
        (item for item in search.json() if item.get("graph_id") == GRAPH_ID),
        None,
    )
    if assistant is None:
        return None
    graph = client.get(f"/assistants/{assistant['assistant_id']}/graph")
    if graph.status_code != 200:
        return None
    nodes = graph.json().get("nodes") or []
    return len(nodes) or None


def _is_port_free(port: int) -> bool:
    """端口能不能拿来监听。

    探监听地址本身（BIND_HOST）：绑 0.0.0.0 时被占用的情况和绑 127.0.0.1
    不一样，探错地址会漏判。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        # 允许绑定 TIME_WAIT 状态的端口（那不是"被占用"）
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((BIND_HOST, port))
        except OSError:
            return False
    return True


def _resolve_port() -> int:
    """端口锁死 2024，被占用就直接报错。

    **不做自动换端口**，有两个原因：

    1. `langgraph dev` 在端口被占时会自己换一个（日志里写
       `Port 2024 is already in use, using port NNNNN instead`），但就绪检查
       只轮询 2024——不把端口定死的话，就绪检查打到的是**占着 2024 的旧
       服务**：它当然"已就绪"，但跑的是旧代码；真正的新服务在另一个端口上，
       前端连的是旧代码，看起来就像"改了没生效"。
    2. 前端默认连 2024（`VITE_LANGGRAPH_URL`）。自动换端口的话前端得跟着
       改，一改就漏；而且旧服务还占着 2024，改了也是错的。

    所以端口被占时宁可启动失败，也不能"看起来启动成功"。
    """
    if _is_port_free(DEFAULT_PORT):
        return DEFAULT_PORT
    raise RuntimeError(
        f"端口 {DEFAULT_PORT} 已被占用。"
        f"多半是有个旧服务没退干净——用 "
        f"`lsof -nP -iTCP:{DEFAULT_PORT} -sTCP:LISTEN` 看是谁占着，"
        f"关掉它（给它发 SIGTERM，或 `pkill -f langgraph_cli dev`）再启动。"
    )


def _wait_until_ready(client: httpx.Client, proc: subprocess.Popen) -> int:
    """轮询直到 /ok 可用且 code_agent 图正常；返回图节点数。"""
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(
                f"langgraph dev 已退出（退出码 {proc.returncode}），请查看上方日志"
            )
        try:
            if client.get("/ok", timeout=1.0).status_code == 200:
                node_count = _graph_node_count(client)
                if node_count is not None:
                    return node_count
        except httpx.RequestError:
            pass
        time.sleep(POLL_INTERVAL_SECONDS)
    raise TimeoutError(
        f"等待服务就绪超时（{READY_TIMEOUT_SECONDS:.0f}s）："
        f"{client.base_url}/ok 或 {GRAPH_ID} 图未正常加载"
    )


def _terminate(proc: subprocess.Popen) -> None:
    """优雅终止整个子进程组，超时后强杀。"""
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        proc.wait(timeout=STOP_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.wait()


def _handle_sigterm(*_) -> None:
    """SIGTERM 转成 KeyboardInterrupt，复用 finally 里的整组清理逻辑。"""
    raise KeyboardInterrupt()


def _cleanup_runtime(runtime_dir: Path, proc: subprocess.Popen | None) -> None:
    """停止子进程并清掉临时配置目录。

    proc 可能还没创建（派生配置生成失败、Popen 抛错），这时只删临时目录。
    工作空间里的 .langgraph_api **不删**：它是 langgraph dev 的 thread 索引
    （.langgraph_ops.pckl），删掉等于每次重启都把会话列表清零。
    """
    if proc is not None:
        _terminate(proc)
    # 子进程停手后再删临时配置，避免与它的 flush 线程竞争
    shutil.rmtree(runtime_dir, ignore_errors=True)


def main() -> None:
    # 非 tty（如 IDE 任务面板、重定向到文件）下 stdout 是块缓冲，
    # 不启用行缓冲的话就绪提示要等缓冲满或进程退出才出现。
    sys.stdout.reconfigure(line_buffering=True)

    # __init__ 自身的 .pyc 在模块体执行前就已写入，dont_write_bytecode
    # 拦不住它；这里启动时主动删掉，保证源码目录零运行残留。
    shutil.rmtree(Path(__file__).resolve().parent / "__pycache__", ignore_errors=True)

    # SIGTERM 默认直接终止进程、不执行 finally，会留下子进程组孤儿占用端口；
    # SIGINT 也显式接管：非交互环境（IDE 任务、后台作业）启动时可能继承
    # SIGINT=IGN，仅靠 Python 默认的 KeyboardInterrupt 注入在那种环境下不触发。
    # 两个信号都转成 KeyboardInterrupt，与终端 Ctrl+C 走同一条优雅关闭路径。
    signal.signal(signal.SIGTERM, _handle_sigterm)
    signal.signal(signal.SIGINT, _handle_sigterm)

    # 用户在哪个目录运行 scode，哪个目录就是工作空间（子进程 cwd）
    workspace = Path.cwd()
    backend_dir = _backend_dir()

    # 端口锁死 2024：被占用就启动失败（见 _resolve_port 的理由）
    try:
        port = _resolve_port()
    except RuntimeError as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    # 就绪探测打回环，不打 BIND_HOST
    base_url = f"http://{PROBE_HOST}:{port}"

    # 派生配置只放临时目录（退出即删），不污染工作空间。
    # runtime_dir 一创建就进入下面的 try：配置生成失败或 Popen 抛错时也要清掉它。
    runtime_dir = Path(tempfile.mkdtemp(prefix=RUNTIME_DIR_PREFIX))
    proc: subprocess.Popen | None = None

    # 整个生命周期只有一个 finally：不管启动失败、启动途中 Ctrl+C，还是
    # 正常运行后 Ctrl+C，子进程组都一定会被收掉（早期版本在启动阶段按
    # Ctrl+C 会漏掉清理，留下占端口的孤儿——KeyboardInterrupt 是
    # BaseException，except Exception 抓不住）。
    try:
        config_path = _build_runtime_config(backend_dir, runtime_dir)

        command = [
            sys.executable,
            "-m",
            "langgraph_cli",
            "dev",
            "--config",
            str(config_path),
            "--no-browser",
            "--no-reload",
            "--host",
            BIND_HOST,
            "--port",
            str(port),
        ]

        # cwd = 用户工作空间：agent 未来的 shell / 文件工具以这里为根。
        # .langgraph_api 生成在工作空间下并**保留**：里面的 ops pckl 是 thread 索引，
        # 删了重启后会话列表就空了（checkpoint 本身在 SQLite，不受影响）。
        # PYTHONDONTWRITEBYTECODE：后端源码按绝对路径加载，不在源码目录留 __pycache__。
        # start_new_session=True：子进程成为新进程组组长，退出时可整组清理，
        # 同时 Ctrl+C 的 SIGINT 只发给父进程，由我们统一控制关闭顺序。
        child_env = {
            **os.environ,
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        proc = subprocess.Popen(
            command,
            cwd=workspace,
            env=child_env,
            start_new_session=True,
        )

        print(f"正在启动 LangGraph Agent Server（{BIND_HOST}:{port}）...")
        print(f"工作空间：{workspace}")
        try:
            with httpx.Client(base_url=base_url) as client:
                node_count = _wait_until_ready(client, proc)
        except Exception as exc:
            print(f"启动失败：{exc}", file=sys.stderr)
            raise SystemExit(1) from exc

        print(f"✅ Agent Server 已就绪：{base_url}/ok")
        print(f"✅ 图 {GRAPH_ID} 已注册并可加载（{node_count} 个节点）")
        print(f"📚 API Docs：{base_url}/docs")
        print("前端启动：cd web && pnpm dev（http://localhost:5173）")
        print(f"前端连后端：VITE_LANGGRAPH_URL={base_url}")
        print("提示：已关闭热重载，修改后端代码后请重启 scode")
        print("按 Ctrl+C 停止服务")

        try:
            proc.wait()
        except KeyboardInterrupt:
            print("\n正在停止服务...")
    except KeyboardInterrupt:
        # 启动途中被 Ctrl+C：正常退出，别甩一段 traceback 给用户
        print("\n启动被中断，正在停止服务...", file=sys.stderr)
        raise SystemExit(130) from None
    finally:
        _cleanup_runtime(runtime_dir, proc)
