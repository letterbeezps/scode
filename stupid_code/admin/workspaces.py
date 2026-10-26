"""POST /workspaces/pick：弹**系统原生**的文件浏览窗口，让用户选一个工作空间。

## 为什么由后端弹窗，而不是浏览器弹窗

浏览器的目录选择 API（File System Access API 的 `showDirectoryPicker()`、
`<input webkitdirectory>`）**故意不暴露绝对路径**——只给目录名和相对路径，
这是浏览器的安全设计，绕不过去。而工作空间要的恰恰是绝对路径：agent 要在
那个目录里读文件、改文件、跑命令。

后端跑在用户自己的机器上，它既知道真实路径，也能调起系统的文件浏览窗口
（macOS 的 `choose folder`、Linux 的 zenity、Windows 的 FolderBrowserDialog）。
弹窗就弹在用户眼前，跟「cd 到目录里再跑 claude」是一回事。

## 弹不出来的情况

后端跑在无图形界面的环境里（Docker 容器、纯 SSH 的服务器）就弹不出来。
这时返回明确的错误，前端退回到「手打路径」——那条路永远可用。

## 「之前聊过的项目」列表不在这里

那份列表来自**对话历史**：每个 thread 的 metadata 里记着它用过的工作空间，
前端从线程列表里直接读（见 `web/src/components/chat/WorkspacePicker.tsx`）。
不需要后端再列一次目录——后端没有"项目"的概念，只有目录。
"""

from __future__ import annotations

import asyncio
import logging
import platform
import subprocess
import sys
import threading
from dataclasses import dataclass

from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

PICK_TIMEOUT_SECONDS = 600
"""弹窗最多等多久。用户可能对着窗口发呆，但不至于无限挂着。"""

_PICK_LOCK = threading.Lock()
"""同一时刻只允许一个系统弹窗。

弹窗会在默认 executor 的线程里阻塞最多 600 秒，而文件工具 / 记忆读写的
`asyncio.to_thread` 共用同一个池。并发请求会弹出一堆窗口、把线程池占满，
所以重复请求直接返回 409——前端按钮在等待期间已经禁用，这里防的是其他客户端。
"""


@dataclass
class PickResult:
    """弹窗的结果。

    三种状态互斥：选中了 / 用户取消了 / 出错了。
    """

    path: str | None = None
    cancelled: bool = False
    error: str | None = None


def _trim_trailing_slash(path: str) -> str:
    """去掉结尾斜杠（macOS 的 POSIX path of 目录会带斜杠），根目录除外。"""
    if len(path) > 1:
        return path.rstrip("/") or "/"
    return path


def _pick_macos() -> PickResult:
    """macOS：用 AppleScript 的 `choose folder` 弹原生目录选择框。

    `choose folder` 返回的是 alias（HFS 路径），所以要用 `POSIX path of`
    转成我们能用的绝对路径。转出来的目录路径**带结尾斜杠**（"/private/tmp/"），
    下面统一去掉，免得界面上显示成 "/path/to/dir/"。
    """
    try:
        proc = subprocess.run(
            [
                "osascript",
                "-e", "set targetFolder to choose folder",
                "-e", "POSIX path of targetFolder",
            ],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=PICK_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        return PickResult(error="系统里没有 osascript，弹不出目录选择框。")
    except subprocess.TimeoutExpired:
        return PickResult(error=f"选择目录超过 {PICK_TIMEOUT_SECONDS} 秒没有响应，已取消。")

    if proc.returncode == 0:
        path = _trim_trailing_slash(proc.stdout.strip())
        if path:
            return PickResult(path=path)
        return PickResult(error="没有拿到选中的目录路径。")
    if "User canceled" in proc.stderr or "-128" in proc.stderr:
        return PickResult(cancelled=True)
    if proc.returncode < 0:
        # 被信号杀掉（比如后端被关掉、或有人 kill 了 osascript）
        return PickResult(error="目录选择框被中断了。")
    return PickResult(error=f"目录选择框出错：{proc.stderr.strip() or proc.returncode}")


def _pick_linux() -> PickResult:
    """Linux：用 zenity 的目录选择模式（需要系统装了 zenity）。"""
    try:
        proc = subprocess.run(
            [
                "zenity",
                "--file-selection",
                "--directory",
                "--title=选择工作空间",
            ],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=PICK_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        return PickResult(error="系统里没有 zenity，弹不出目录选择框。")
    except subprocess.TimeoutExpired:
        return PickResult(error=f"选择目录超过 {PICK_TIMEOUT_SECONDS} 秒没有响应，已取消。")

    if proc.returncode == 0:
        path = proc.stdout.strip()
        if path:
            return PickResult(path=path)
        return PickResult(error="没有拿到选中的目录路径。")
    if proc.returncode == 1:
        # zenity 用 1 表示用户点了取消
        return PickResult(cancelled=True)
    return PickResult(error=f"目录选择框出错：{proc.stderr.strip() or proc.returncode}")


def _pick_windows() -> PickResult:
    """Windows：用 PowerShell 的 FolderBrowserDialog。"""
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;"
        "$dialog.Description = '选择工作空间';"
        "if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }"
    )
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=PICK_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError:
        return PickResult(error="系统里没有 powershell，弹不出目录选择框。")
    except subprocess.TimeoutExpired:
        return PickResult(error=f"选择目录超过 {PICK_TIMEOUT_SECONDS} 秒没有响应，已取消。")

    if proc.returncode == 0:
        path = proc.stdout.strip()
        if path:
            return PickResult(path=path)
        return PickResult(cancelled=True)
    return PickResult(error=f"目录选择框出错：{proc.stderr.strip() or proc.returncode}")


def _picker_for_current_platform() -> tuple[str, object] | None:
    """当前系统用哪个弹窗实现。认不出来就返回 None。"""
    if sys.platform == "darwin":
        return "macOS 的目录选择框", _pick_macos
    if sys.platform.startswith("win"):
        return "Windows 的目录选择框", _pick_windows
    if sys.platform.startswith("linux"):
        return "Linux 的目录选择框", _pick_linux
    return None


def pick_directory() -> PickResult:
    """弹窗选一个目录（同步版，内部会阻塞到用户选完或取消）。"""
    picker = _picker_for_current_platform()
    if picker is None:
        return PickResult(error=f"不认识的系统（{platform.system()}），弹不出目录选择框。")
    _label, func = picker
    return func()  # type: ignore[operator]


async def pick_workspace(request: Request) -> JSONResponse:
    """POST /workspaces/pick — 弹系统文件浏览窗口选一个目录。

    响应四种：

    - 选中了：JSON 里带 path 字段，值是绝对路径
    - 用户点了取消：JSON 里 cancelled 为 true，path 为 null（**不是错误**）
    - 弹不出来：HTTP 503，JSON 里 error 字段是中文原因
    - 已经有一个弹窗在等：HTTP 409，JSON 里 error 说明原因
    """
    if not _PICK_LOCK.acquire(blocking=False):
        return JSONResponse(
            {"error": "已经有一个目录选择框在等待用户选择，请先完成或取消它。"},
            status_code=409,
        )

    try:
        # 弹窗会阻塞到用户选完，整个过程可能好几分钟。子进程 + 阻塞 IO 都不能
        # 直接放在 async 函数里（langgraph dev 装了 blockbuster，会报 500），
        # 所以整段丢到线程里跑。
        result = await asyncio.to_thread(pick_directory)

        if result.error is not None:
            logger.warning("目录选择框失败：%s", result.error)
            return JSONResponse({"error": result.error}, status_code=503)
        if result.cancelled:
            return JSONResponse({"path": None, "cancelled": True})
        return JSONResponse({"path": result.path})
    finally:
        _PICK_LOCK.release()
