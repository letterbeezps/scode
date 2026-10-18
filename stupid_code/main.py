"""scode 入口：以子进程方式启动 `langgraph dev`，就绪后验证服务与图注册。

用法：

    uv run scode

等价于开发者手动执行 `langgraph dev --no-browser`，区别是：
- 子进程 cwd 固定为 stupid_code/（langgraph.json 所在处），不依赖调用时的 cwd；
- 启动后依次轮询 GET /ok 与 GET /assistants/{id}/graph，
  确认 HTTP 服务可用且 code_agent 图能被正常加载；
- Ctrl+C 时关闭整个子进程组（含 uvicorn reload worker），不留孤儿进程。
"""

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

HOST = "127.0.0.1"
PORT = 2024
BASE_URL = f"http://{HOST}:{PORT}"
OK_URL = f"{BASE_URL}/ok"
GRAPH_ID = "code_agent"
CONFIG_NAME = "langgraph.json"
READY_TIMEOUT_SECONDS = 60.0
POLL_INTERVAL_SECONDS = 0.5
STOP_TIMEOUT_SECONDS = 10.0


def _backend_dir() -> Path:
    # stupid_code/main.py 的上一级即后端目录（langgraph.json 所在处）
    return Path(__file__).resolve().parent


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


def main() -> None:
    # 非 tty（如 IDE 任务面板、重定向到文件）下 stdout 是块缓冲，
    # 不启用行缓冲的话就绪提示要等缓冲满或进程退出才出现。
    sys.stdout.reconfigure(line_buffering=True)

    # SIGTERM 默认直接终止进程、不执行 finally，会留下子进程组孤儿占用端口；
    # 转成 KeyboardInterrupt，与 Ctrl+C 走同一条优雅关闭路径。
    signal.signal(signal.SIGTERM, _handle_sigterm)

    backend_dir = _backend_dir()
    command = [
        sys.executable,
        "-m",
        "langgraph_cli",
        "dev",
        "--config",
        CONFIG_NAME,
        "--no-browser",
        "--host",
        HOST,
        "--port",
        str(PORT),
    ]

    # cwd 固定到后端目录：langgraph.json 里的 ./agent.py、./.env、"." 依赖
    # 都按该目录解析；.langgraph_api 持久化缓存也落在该目录下。
    # start_new_session=True：子进程成为新进程组组长，退出时可整组清理，
    # 同时 Ctrl+C 的 SIGINT 只发给父进程，由我们统一控制关闭顺序。
    proc = subprocess.Popen(
        command,
        cwd=backend_dir,
        start_new_session=True,
    )

    try:
        print(f"正在启动 LangGraph Agent Server（{HOST}:{PORT}）...")
        with httpx.Client(base_url=BASE_URL) as client:
            node_count = _wait_until_ready(client, proc)
    except (RuntimeError, TimeoutError) as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        _terminate(proc)
        raise SystemExit(1) from exc

    print(f"✅ Agent Server 已就绪：{OK_URL}")
    print(f"✅ 图 {GRAPH_ID} 已注册并可加载（{node_count} 个节点）")
    print(f"📚 API Docs：{BASE_URL}/docs")
    print("前端启动：cd web && pnpm dev（http://localhost:5173）")
    print("按 Ctrl+C 停止服务")

    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\n正在停止服务...")
    finally:
        _terminate(proc)
