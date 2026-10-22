# 008 launcher 的端口与关停行为

## 目标

修掉 launcher 的两个老毛病：

1. **端口被占时误报"已就绪"**——2024 上坐着旧服务时，`uv run scode` 会报
   "✅ Agent Server 已就绪"，但真正的新服务跑在另一个端口上，前端连的是旧
   代码，看起来就像"改了没生效"
2. **启动途中 Ctrl+C 留下孤儿**——服务还没就绪的那几秒按 Ctrl+C，子进程组
   没人收，孤儿一直占着 2024（于是引发第 1 条）

### 成功标准

- 端口**锁死 2024**：被占用时 launcher **启动失败**并说明是谁占着，不自动换端口
- 启动失败时不能有"✅ 已就绪"这种误导性输出
- 启动途中 Ctrl+C：子进程组一定被收掉，不留占端口的孤儿，也不甩 traceback
- 就绪后 Ctrl+C：行为不变（干净退出）

### 本期不做

- 不做端口可配置（`SCODE_PORT` 之类的环境变量）——前端默认连 2024，能换端口
  反而容易连错；真要跑多实例再说
- 不自动杀掉占着 2024 的进程（可能是用户有意开的服务）
- 不改 `langgraph dev` 自身的端口回退行为（那是框架的事，我们只是不再撞上它）

### 关键取舍

- **端口锁死 2024，占用就失败**，而不是"自动换一个"。两个理由：
  1. `langgraph dev` 在端口被占时会自己换一个（日志里写
     `Port 2024 is already in use, using port NNNNN instead`），而 launcher
     的就绪检查只轮询 2024。不锁定端口的话，就绪检查打到的是**占着 2024 的
     旧服务**——它当然"已就绪"，但跑的是旧代码
  2. 前端默认连 2024（`VITE_LANGGRAPH_URL`）。自动换端口的话前端得跟着改，
     一改就漏；而且旧服务还占着 2024，改了也是错的
- **启动前先探端口**（`socket.bind` 试一下），而不是等就绪超时。占用时立刻
  报错，用户不用干等 60 秒
- **整个生命周期只有一个 `finally`**。早期版本启动阶段是 `except Exception`，
  而 `KeyboardInterrupt` 继承自 `BaseException` 抓不住，异常穿透出去后，
  后面那个负责清理的 `finally` 根本没机会执行。现在把"启动 + 等待就绪 +
  等待退出"整段包在一个 `try/finally` 里，任何路径都会收掉子进程组

---

## 1. 改了什么

### 1.1 `stupid_code/launcher.py`

新增两个函数：

```python
def _is_port_free(port: int) -> bool:
    """端口能不能拿来监听（只探 127.0.0.1）。"""


def _resolve_port() -> int:
    """端口锁死 2024，被占用就直接报错。"""
```

`_resolve_port()` 的报错文案里带了排查命令：

```
启动失败：端口 2024 已被占用。多半是有个旧服务没退干净——用
`lsof -nP -iTCP:2024 -sTCP:LISTEN` 看是谁占着，关掉它（给它发 SIGTERM，
或 `pkill -f langgraph_cli dev`）再启动。
```

`main()` 的结构改成：

```python
try:
    ...启动、等就绪、等退出...
except KeyboardInterrupt:
    print("\n启动被中断，正在停止服务...", file=sys.stderr)
    raise SystemExit(130) from None   # 干净退出，不甩 traceback
finally:
    _cleanup_runtime(runtime_dir, proc)   # 任何路径都会收掉子进程组
```

端口相关的常量从模块级改成运行期变量（`port` / `base_url`），因为 2024
虽然锁死了，但代码里不再有"端口可能不是 2024"的分支。

---

## 2. 验证

### 步骤 1：正常启动 + Ctrl+C

```bash
cd $(mktemp -d) && uv run --project <项目路径> python -c "import stupid_code; stupid_code.start()"
# 另开一个终端
kill -INT <pid>
lsof -nP -iTCP:2024 -sTCP:LISTEN   # 应该没有输出
pgrep -f "langgraph_cli dev"        # 应该没有输出
```

### 步骤 2：启动途中 Ctrl+C

```bash
cd $(mktemp -d) && ... # 同上，但起来 1 秒就发 SIGINT
kill -INT <pid>
# 期望：无残留进程、2024 空闲、日志里是「启动被中断，正在停止服务...」且没有 Traceback
```

### 步骤 3：端口被占

```bash
# 第一个实例先跑着（占住 2024），再起第二个
# 期望：第二个直接报「启动失败：端口 2024 已被占用...」，不出现「已就绪」，
#       日志里也没有 "using port NNNNN instead"
```

---

## 3. 常见问题

**启动失败：端口 2024 已被占用**

有旧服务没退干净。查：

```bash
lsof -nP -iTCP:2024 -sTCP:LISTEN
```

确认是自己的残留再关掉：

```bash
pkill -f "langgraph_cli dev"
```

**我确实想同时跑两个实例**

现在不支持——端口锁死 2024。要么关掉一个，要么改 launcher 里的
`DEFAULT_PORT`（同时也要改前端的 `VITE_LANGGRAPH_URL`）。

**Ctrl+C 之后端口还占着**

先确认是不是"启动途中 Ctrl+C"的旧版本行为残留（现在不会了），
再按上面查占用进程。

---

## 4. 已验证的事实

- **就绪后 SIGINT**：无残留 langgraph 进程，2024 释放
- **启动途中 SIGINT**：无残留 langgraph 进程，2024 释放；日志是
  "启动被中断，正在停止服务..."，**没有 Traceback**（修复前这里会漏一个
  孤儿占着 2024）
- **2024 被占时启动第二个**：直接报"启动失败：端口 2024 已被占用..."，
  日志里**没有** "using port NNNNN instead"（说明子进程压根没起来），
  2024 上仍然是第一个服务，进程数没多
- `_is_port_free()` 用 `socket.bind` 试占用，带 `SO_REUSEADDR`，
  TIME_WAIT 状态的端口不算被占

## 5. 待核实

- 探端口和真正绑定之间有个极小的竞态窗口：探完到 `langgraph dev` 真正
  绑定之间，理论上可能被别人抢走。这时 `langgraph dev` 会自己换端口，
  就绪检查会超时（60 秒）后失败——**失败而不是误报**，可以接受
- 端口探测只探 127.0.0.1：如果有进程只绑了 0.0.0.0:2024，探不出来，
  `langgraph dev` 仍会自动换端口 → 同上，超时失败
