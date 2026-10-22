# 006 agent 长期记忆（工作空间 .scode-memory.md）

## 目标

让主 agent 有长期记忆：每次新会话开始时，把工作空间里的 `.scode-memory.md` 读进系统提示词。

### 成功标准

- 用 deepagents 的 `MemoryMiddleware`，通过 `create_deep_agent` 的 **`middleware` 参数**挂上去
- 记忆来源默认是**工作空间根目录的 `.scode-memory.md`**；文件不存在时自动创建一份带模板的
- 记忆内容真的进了系统提示词（模型能原样念出 `.scode-memory.md` 的内容）
- 不影响已有的 subagent / 提示词 / 管理接口

### 本期不做

- **不解决"agent 写不进真实 .scode-memory.md"**：deepagents 给 agent 的文件工具用的还是
  StateBackend（虚拟文件系统），`edit_file` 写的是虚拟 FS，落不了磁盘。记忆目前是**只读**的
- 不做记忆的运行时更新（改完 `.scode-memory.md` 要开新会话才生效，见「关键取舍」）
- 不做多来源记忆（`~/.deepagents/` 之类的全局记忆目录）
- 不做前端展示记忆内容

### 关键取舍

- **用 `middleware=` 而不是 `create_deep_agent(memory=...)`**。两者最终都是同一个
  `MemoryMiddleware`，但 `memory=` 只能用框架默认的 backend——而默认是 StateBackend，
  **读不到磁盘上的文件**。显式挂载才能自己指定 `FilesystemBackend`。
- **backend 只给记忆用，不给 agent 的文件工具用**。`FilesystemBackend` 的 docstring
  明确写了"Web 服务器 / HTTP API 不适用"（agent 能读任何文件，包括 `conf/config.toml`
  里的 api_key）。所以只让中间件用它读那一个文件，agent 的文件工具仍走 StateBackend。
  用 `virtual_mode=True`（默认），路径越不出工作空间根。
- **工作空间 = `Path.cwd()`**。launcher 把 langgraph 子进程的 cwd 设成用户的工作空间，
  graph 也在那个进程里导入，所以 `cwd()` 就是工作空间。跟项目既有的"cwd 即工作空间"语义一致。
- **记忆只在会话开始时读一次**。`MemoryMiddleware.before_agent` 见到 state 里已有
  `memory_contents` 就不重复读——这是框架的设计（记忆块要参与 prompt 缓存）。
  代价是**改完 `.scode-memory.md` 要开新会话才生效**，不能热更新。
- **没有 `.scode-memory.md` 就创建**，而不是静默跳过。deepagents 遇到读不到的文件会
  `continue` 跳过（不报错），那样用户根本不知道记忆为什么是空的。
- **记忆文件叫 `.scode-memory.md`，不用框架默认的 `AGENTS.md`**。deepagents 的约定是读
  `AGENTS.md`（跟 Claude Code 等工具一致），但那通常是"写给编码 agent 看的项目约定"——
  本项目根目录那份就是——和"agent 自己攒的长期记忆"是两回事。工作空间正好是项目根时，
  沿用默认名会把开发者的项目说明原样注入 agent 的提示词，语义错位。换成独立文件名后
  两边分开：点开头表示它是本地状态文件，通常进 `.gitignore`。

---

## 1. 改了什么

### 1.1 `stupid_code/graph/memory.py`（新建）

四个公开函数：

```python
workspace_dir() -> Path        # Path.cwd()，即工作空间
memory_path() -> Path          # workspace_dir() / ".scode-memory.md"
ensure_memory_file() -> Path   # 不存在就用模板创建；失败抛 MemorySetupError
build_memory_middleware() -> MemoryMiddleware
```

中间件这样构造：

```python
backend = FilesystemBackend(root_dir=workspace_dir(), virtual_mode=True)
return MemoryMiddleware(
    backend=backend,
    sources=["/.scode-memory.md"],
    add_cache_control=True,
)
```

- `sources` 用虚拟路径 `/.scode-memory.md`：`FilesystemBackend` 在 virtual 模式下把它解析到
  `root_dir` 下，即 `<工作空间>/.scode-memory.md`
- `add_cache_control=True` 与框架自己挂 `MemoryMiddleware` 时的行为一致：给记忆块加
  缓存断点，记忆内容变了也不会把整个前缀缓存打穿

### 1.2 `stupid_code/graph/agent.py`（修改）

```python
graph = create_deep_agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    subagents=load_subagents(),
    middleware=[build_memory_middleware()],
)
```

### 1.3 模板内容

新建的 `.scode-memory.md` 带一份中文模板，分四块：项目约定 / 常用命令 / 经验与坑 / 杂项。

---

## 2. 验证

### 步骤 1：文件不存在会被创建

在一个空目录里：

```bash
cd $(mktemp -d) && uv run --project <项目路径> python -c "
from stupid_code.graph.memory import ensure_memory_file
p = ensure_memory_file()
print(p, p.exists())
"
```

### 步骤 2：记忆进了系统提示词

用假模型把 `request.system_message` 打出来：

```python
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatResult, ChatGeneration

class SpyModel(BaseChatModel):
    @property
    def _llm_type(self): return "spy"
    def bind_tools(self, tools, **kwargs): return self
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        for m in messages:
            if getattr(m, "type", "") == "system":
                print(m.content)
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])
```

提示词里应该能看到 `<agent_memory>` 块和文件内容。

### 步骤 3：真实服务里模型能念出记忆内容

```bash
# 在工作空间里放一个带标记的 .scode-memory.md，然后在该目录下启动 scode
curl -s -N -X POST "http://127.0.0.1:<port>/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"...","input":{"messages":[{"role":"user","content":"请把 <agent_memory> 块里的内容原样念出来"}]},"stream_mode":["updates"],"on_disconnect":"continue"}'
```

模型应当原样念出 `.scode-memory.md` 的内容。

### 步骤 4：图里能看到中间件节点

```bash
curl -s "http://127.0.0.1:<port>/assistants/$AID/graph"
```

节点列表里应出现 `MemoryMiddleware.before_agent`。

---

## 3. 常见问题

**模型说"工作区里没有 .scode-memory.md"**
它多半是用 `glob` 工具在虚拟 FS 里找的——文件工具是 StateBackend，看不到真实磁盘。
记忆本身是通过中间件注入的，与文件工具无关。可以直接问它"把 `<agent_memory>` 块念出来"。

**改了 `.scode-memory.md` 没生效**
记忆只在会话开始时读一次，开个新会话（新建 thread）即可。

**启动报 `MemorySetupError`**
工作空间不可写（创建不了 `.scode-memory.md`）。把工作空间换成可写目录。

**2024 端口被占，`scode` 却报"已就绪"**
**launcher 的就绪检查只轮询 2024**。端口被占时 `langgraph dev` 会自动换端口（看启动日志里
`Port 2024 is already in use, using port NNNNN instead`），但 launcher 还在对着旧服务做
就绪验证，于是**误报就绪**——新服务其实在另一个端口上。测试时务必看日志里那个真实端口。

---

## 4. 已验证的事实

- 空工作空间里 `ensure_memory_file()` 会创建带模板的 `.scode-memory.md`（709 字节）
- `MemoryMiddleware` 的 `backend.download_files(["/.scode-memory.md"])` 能读到真实文件内容
  （`FilesystemBackend` + `virtual_mode=True`，路径限定在工作空间内）
- 用假模型抓 `request.system_message`：记忆内容确实在系统提示词的 `<agent_memory>` 块里
- 真实服务里发"请把 `<agent_memory>` 块原样念出来"，模型原样念出了工作空间
  `.scode-memory.md` 的内容（标记 `WORKSPACE_MEMORY_MARKER_99`）
- 记忆文件从 `AGENTS.md` 改名为 `.scode-memory.md` 后复验过：假模型的系统提示词里
  `<agent_memory>` 块指向 `/.scode-memory.md` 且带文件内容；真实服务里模型念出了
  改名后文件里的标记 `SCODE_E2E_MEMORY_MARKER_77`
- 服务端的图节点列表出现 `MemoryMiddleware.before_agent`
- `create_agent` 会把中间件的 `state_schema`（`MemoryState`）合并进图的状态 schema，
  所以 `memory_contents` 这个 channel 存在，私有状态不进入输出 state
- 不传 `memory=` 参数时，框架不会自己挂 `MemoryMiddleware`——本项目是自己挂的，
  图里能查到节点

## 5. 待核实

- **记忆是只读的**：agent 的 `edit_file` 走 StateBackend，写不进真实的 `.scode-memory.md`，
  而框架的记忆提示词里写着"可以调用 `edit_file` 保存新知识"——在接真实磁盘 backend
  之前，这句话对用户是误导
- 记忆内容不参与"哪些文件可以读"的权限判断（`permissions` 管的是文件工具，不是中间件）
- launcher 的端口占用误报问题（见「常见问题」）本期没改
