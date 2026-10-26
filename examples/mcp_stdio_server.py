"""一个能直接跑的 stdio MCP 服务器——用来试 conf/mcp.json 的 stdio 传输。

**不用装任何东西**：FastMCP 是官方 SDK（`mcp` 包）自带的，
`from mcp.server.fastmcp import FastMCP` 直接就能用
（不需要另外 pip install fastmcp，那是另一个包）。

## 跑起来

    uv run python examples/mcp_stdio_server.py

它会**等 stdin 上的 MCP 协议**——所以直接跑看起来像卡住了，是正常的。
要跟它对话得让 agent 通过 stdio 传输连它。

## 接进 conf/mcp.json

在项目根的 conf/mcp.json 里加一段（然后**重启后端**——MCP 工具是建图时
静态注册的）：

```json
{
  "mcpServers": {
    "demo": {
      "type": "stdio",
      "command": "uv",
      "args": ["run", "python", "examples/mcp_stdio_server.py"]
    }
  }
}
```

`command` + `args` 就行，`type` 可以不写（有 command 就当 stdio）。
想指定工作目录加 `"cwd": "/绝对路径"`。

## 为什么放这个文件

http 传输用公网端点就能试，但 stdio 传输不配一个本地服务器就没法验证。
这个文件就是那个「本地服务器」——四个工具，全是纯计算，随便改。
（`count` 用来验证长会话：连续调用应该递增；每次新建会话的实现会一直返回 1。）

（agent 看到的工具名是 `mcp__demo__echo` 这种形式：加服务器前缀是为了
跟内置工具、跟别的服务器的工具不撞名。）
"""

from __future__ import annotations

from pathlib import Path

from mcp.server.fastmcp import FastMCP

app = FastMCP("demo")

_counter = 0


@app.tool()
def echo(text: str) -> str:
    """把输入原样返回——用来确认这条链路通不通。"""
    return f"echo: {text}"


@app.tool()
def count() -> int:
    """计数器加一并返回。用来验证「长会话」：连续调用应该递增。

    每次调用都新建会话的实现在这里会一直返回 1（每次都是新进程）。
    """
    global _counter
    _counter += 1
    return _counter


@app.tool()
def add(a: int, b: int) -> int:
    """两数相加。"""
    return a + b


@app.tool()
def list_files(directory: str = ".") -> list[str]:
    """列出目录下的文件（只看名字，不读内容）。"""
    root = Path(directory).expanduser()
    if not root.is_dir():
        return [f"不是目录：{root}"]
    return sorted(p.name for p in root.iterdir())


if __name__ == "__main__":
    # stdio 传输：MCP 协议走 stdin/stdout，日志必须走 stderr，
    # 否则会把协议流搅乱
    app.run()
