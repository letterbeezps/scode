"""scode 入口：以子进程方式启动 `langgraph dev`，就绪后验证服务与图注册。

用法：

    cd /path/to/workspace
    uv run scode

工作空间语义：
- 在哪个目录运行 scode，那个目录就是 agent 的工作空间（子进程 cwd 不搬动）；
  未来 agent 的 shell / 文件工具（deepagents 现在默认 StateBackend，
  即 graph state 里的虚拟文件系统，与 cwd 无关；将来接真实磁盘 backend 时
  会直接以 cwd 为根）。
- langgraph dev 必然在 cwd 下生成 `.langgraph_api/`（inmem 运行时硬编码的
  相对路径，无法通过配置改到别处）。它只是 inmem 的易失缓存：
  checkpoint 已由 persistence.py 的 SQLite saver 接管，里面没有有价值数据，
  所以 scode 在【启动前】和【退出时】各删一次——让它成为一个"注定消失"的目录；
  启动前删是为了兜住上次被强杀（SIGKILL / 断电）没走到退出清理的情况。
- 唯一有价值的运行产物是 checkpoint/store，由 persistence.py 按 __file__
  定位到 stupid_code/data/langgraph.db，与工作空间目录无关。

另外：
- 派生配置（把 ./agent.py 等相对路径绝对化后的 langgraph.json）放系统临时目录，
  因为服务器一律按 cwd 解析这些相对路径，而这里的 cwd 是用户工作空间而非后端目录；
- 子进程设 PYTHONDONTWRITEBYTECODE=1，避免在后端源码目录写 __pycache__；
- 用 --no-reload：reload 监视 cwd，而 cwd 现在是用户的真实项目目录，
  agent 将来在工作空间写文件会自我触发重启，且后端源码不在 cwd，热重载本来就没意义。

Ctrl+C 时关闭整个子进程组（含 uvicorn 进程），不留孤儿进程。
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

HOST = "127.0.0.1"
PORT = 2024
BASE_URL = f"http://{HOST}:{PORT}"
OK_URL = f"{BASE_URL}/ok"
GRAPH_ID = "code_agent"
CONFIG_NAME = "langgraph.json"
RUNTIME_DIR_PREFIX = "scode-config-"
LANGGRAPH_CACHE_DIR = ".langgraph_api"
READY_TIMEOUT_SECONDS = 60.0
POLL_INTERVAL_SECONDS = 0.5
STOP_TIMEOUT_SECONDS = 10.0


def _backend_dir() -> Path:
    # stupid_code/main.py 的上一级即后端目录（langgraph.json 所在处）
    return Path(__file__).resolve().parent


def _abs_import_spec(spec: str | dict, base_dir: Path) -> str | dict:
    """把 "./agent.py:graph" 这类相对导入串改写成绝对路径形式。

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
        f"{OK_URL} 或 {GRAPH_ID} 图未正常加载"
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


def _cleanup_runtime(workspace: Path, runtime_dir: Path, proc: subprocess.Popen) -> None:
    """停止子进程并清掉两类残留：工作空间里的 .langgraph_api、临时配置目录。"""
    _terminate(proc)
    # 子进程停手后再删缓存，避免与它的 flush 线程竞争
    shutil.rmtree(workspace / LANGGRAPH_CACHE_DIR, ignore_errors=True)
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

    # 上次若被强杀，.langgraph_api 会留在工作空间；启动前先清，保证幂等。
    shutil.rmtree(workspace / LANGGRAPH_CACHE_DIR, ignore_errors=True)

    # 派生配置只放临时目录（退出即删），不污染工作空间
    runtime_dir = Path(tempfile.mkdtemp(prefix=RUNTIME_DIR_PREFIX))
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
        HOST,
        "--port",
        str(PORT),
    ]

    # cwd = 用户工作空间：agent 未来的 shell / 文件工具以这里为根。
    # .langgraph_api 会生成在工作空间下，由本进程在启动前/退出时清理。
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

    try:
        print(f"正在启动 LangGraph Agent Server（{HOST}:{PORT}）...")
        print(f"工作空间：{workspace}")
        with httpx.Client(base_url=BASE_URL) as client:
            node_count = _wait_until_ready(client, proc)
    except Exception as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        _cleanup_runtime(workspace, runtime_dir, proc)
        raise SystemExit(1) from exc

    print(f"✅ Agent Server 已就绪：{OK_URL}")
    print(f"✅ 图 {GRAPH_ID} 已注册并可加载（{node_count} 个节点）")
    print(f"📚 API Docs：{BASE_URL}/docs")
    print("前端启动：cd web && pnpm dev（http://localhost:5173）")
    print("提示：已关闭热重载，修改后端代码后请重启 scode")
    print("按 Ctrl+C 停止服务")

    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\n正在停止服务...")
    finally:
        _cleanup_runtime(workspace, runtime_dir, proc)
