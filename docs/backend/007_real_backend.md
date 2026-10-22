# 007 真实 backend（CompositeBackend + LocalShellBackend）

## 目标

让 agent 的文件操作落在工作空间的**真实磁盘**上，并拿到 `execute`（本机 shell）工具。

之前 backend 是 deepagents 的默认 `StateBackend`——虚拟文件系统，agent 的
`write_file` / `edit_file` 写的是内存副本，落不了盘。连带两个后果：

- 长期记忆文件存不下来（框架的记忆提示词写着"可以调用 edit_file 保存新知识"，
  但 agent 根本写不进那个文件）
- agent 不会跑命令，改完代码没法验证

### 成功标准

- `create_deep_agent` 收到 `backend` 参数：`CompositeBackend(default=LocalShellBackend(...))`
- agent 的 `write_file` / `edit_file` 改的是磁盘上的真文件
- `execute` 能在本机跑命令，cwd = 工作空间
- 长期记忆文件因此可写——agent 写进去的内容，下次开新会话会被读进提示词
- 声明了 `permissions` 的子 agent（`reviewer`）**仍然只读**，且框架不报错
- `langgraph validate` 通过

### 本期不做

- **不做危险操作的人工确认**。`execute` 是本机无隔离的 shell，真要拦就得靠
  `HumanInTheLoopMiddleware`——但前端还没有"批准/拒绝"按钮（见 004 文档的
  「本期不做」），加了之后每条命令都会挂起没人能点。留到前端有审批 UI 再说
- **不做 sandbox**。`LocalShellBackend` 就是"不隔离"——这是有意的取舍，
  不是待办
- **不给 agent 的文件工具做路径白名单**。`virtual_mode=True` 只挡 `..` 和 `~`，
  shell 命令更是完全不受它管
- 不改 `conf/subagents.toml` 的字段集（`permissions` 的语义没变，只是它现在
  由一个没有 shell 的 backend 来执行）

### 关键取舍

- **用 `CompositeBackend` 包一层，而不是直接用 `LocalShellBackend`**。直接用也行，
  但 CompositeBackend 把"哪部分路径走哪种存储"变成配置而不是散落在代码里：
  现在只有 `/tmp/` 一条例外，以后要加"某个目录走 langgraph store 跨会话持久化"
  之类的规则，加一条 route 就行
- **default 是 `LocalShellBackend`，`/tmp/` 路由到 `StateBackend`**。default 负责
  真实磁盘和 shell；`/tmp/` 是会话内的临时区，agent 的临时产物不该在用户磁盘上
  留垃圾。框架会自动为 CompositeBackend 生成一段"虚拟路径 ↔ shell 路径"的提示
  （`middleware/filesystem.py` 的 `_route_host_path_prompt`），`/tmp/` 会被标成
  "shell 访问不到，只能用文件工具"，模型不用自己踩这个坑
- **`inherit_env=True`**。`LocalShellBackend` 默认 `inherit_env=False`，也就是
  shell 拿到的是**空环境**：PATH 是空的，`uv` / `python` / `node` 全都找不到。
  继承当前环境才对得上"在本机干活"的预期
- **声明了 `permissions` 的子 agent 要换一套 backend**。框架有条硬限制：backend
  支持命令执行时，`FilesystemMiddleware` 不接受 `permissions`，直接抛
  `NotImplementedError`。理由站得住——`execute` 能用 shell 绕过任何文件权限
  （`echo x > file`），"工具层拦住写操作"在有 shell 的情况下根本不成立。
  我们主 agent 的 backend 有 shell，`reviewer` 又声明了 deny-write，不处理的话
  建图时就炸。处理办法：给这类子 agent 单独一个**没有 shell** 的
  `FilesystemBackend`（真实磁盘，路径同样锁在工作空间内），权限就真的拦得住
- **长期记忆中间件不共用这个 CompositeBackend**。记忆只需要"工作空间里那一个
  文件"，自己持有一个以工作空间为根的 `FilesystemBackend` 更直白。两者解析出来
  的真实路径是同一个（`<工作空间>/.scode-memory.md`），所以 agent 写进去的内容
  下次开新会话照样会被读进来

---

## 1. 改了什么

### 1.1 `stupid_code/graph/backend.py`（新建）

```python
workspace_dir() -> Path        # Path.cwd()，即工作空间
build_backend() -> CompositeBackend            # 主 agent：真实磁盘 + shell
build_restricted_backend() -> FilesystemBackend  # 无 shell 的真实磁盘
apply_permission_backend(spec) -> SubAgent     # 声明 permissions 的子 agent 换 backend
interrupt_on_from_permissions(perms) -> dict   # interrupt 模式的权限 → interrupt_on
```

主 agent 的 backend：

```python
CompositeBackend(
    default=LocalShellBackend(
        root_dir=workspace_dir(),
        virtual_mode=True,   # 文件操作锁在工作空间内（shell 不受限）
        inherit_env=True,    # shell 继承当前环境，否则 PATH 是空的
    ),
    routes={
        "/tmp/": StateBackend(),  # 临时区走虚拟 FS，不落盘
    },
)
```

### 1.2 `stupid_code/graph/agent.py`（修改）

```python
backend = build_backend()

graph = create_deep_agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    subagents=[apply_permission_backend(spec) for spec in load_subagents()],
    backend=backend,
    middleware=[build_memory_middleware()],
)
```

### 1.3 `stupid_code/graph/backend.py` 里的子 agent 处理

`apply_permission_backend()` 做三件事：

1. 把 `permissions` 从子 agent 规格里**摘出来**——留在规格里的话，deepagents
   建图时会用主 agent 那个带 shell 的 backend 构造 `FilesystemMiddleware`，
   然后抛 `NotImplementedError`
2. 塞一个自己的 `FilesystemMiddleware` 进去（真实磁盘、无 shell、带上
   `permissions`）。deepagents 按名字替换同名中间件（`graph._apply_custom_middleware`），
   所以这个会顶掉框架自动装的那个
3. 顺带把 `mode="interrupt"` 的权限规则翻译成 `interrupt_on`（框架本来也是
   这么做的，见 `deepagents.graph._build_interrupt_on_from_permissions`）——
   `FilesystemMiddleware` 自己不认识 HITL，只强制 deny 规则

### 1.4 `stupid_code/config/prompts.py`（修改）

提示词里"当前工具集"从 7 个变成 8 个（多了 `execute`），并加了一条行为准则：
破坏性命令先问用户。

---

## 2. 验证

### 步骤 1：配置有效

```bash
uv run langgraph validate --config stupid_code/langgraph.json
```

### 步骤 2：工具集

```bash
uv run python -c "
from deepagents.middleware.filesystem import FilesystemMiddleware
from stupid_code.graph.backend import build_backend
mw = FilesystemMiddleware(backend=build_backend())
print(sorted(t.name for t in mw.tools))
"
# ['delete', 'edit_file', 'execute', 'glob', 'grep', 'ls', 'read_file', 'write_file']
```

### 步骤 3：execute 能跑 shell

```bash
uv run python -c "
from deepagents.middleware.filesystem import FilesystemMiddleware
from stupid_code.graph.backend import build_backend
mw = FilesystemMiddleware(backend=build_backend())
t = next(t for t in mw.tools if t.name == 'execute')
class S: tool_call_id = 'x'
print(t.func(command='pwd', runtime=S()).content)
"
```

### 步骤 4：真实服务里写盘 + 跑命令

```bash
# 在工作空间里放一个带标记的 .scode-memory.md，然后在该目录下启动 scode
curl -s -N -X POST "http://127.0.0.1:<port>/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"...","input":{"messages":[{"role":"user","content":"用 write_file 工具把内容 XXX 写进 /.scode-memory.md"}]},"stream_mode":["values"],"on_disconnect":"continue"}'

cat .scode-memory.md    # 磁盘上的文件应该多出 XXX
```

### 步骤 5：子 agent 的权限还拦得住

```python
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.backend import apply_permission_backend

spec = next(s for s in load_subagents() if s["name"] == "reviewer")
prepared = apply_permission_backend(spec)
mw = prepared["middleware"][0]
print(sorted(t.name for t in mw.tools))   # 没有 execute
write = next(t for t in mw.tools if t.name == "write_file")
class S: tool_call_id = "x"
print(write.func(file_path="/x.txt", content="x", runtime=S()).content)
# Error: permission denied for write on /x.txt
```

---

## 3. 常见问题

**建图时报 `NotImplementedError: FilesystemMiddleware does not yet support
permissions with backends that provide command execution`**

有子 agent 声明了 `permissions`，而它的 backend 带 shell。看
`stupid_code/graph/backend.py` 的 `apply_permission_backend()`——正常路径下
`permissions` 会被摘出来换成无 shell 的中间件。出现这个报错说明有子 agent
绕过了那层处理（自己传了 `permissions`）。

**`execute` 工具调了没反应 / 报 "Execution not available"**

`supports_execution()` 对 CompositeBackend 检查的是 **default** backend
（`middleware/filesystem.py`），不是 routes。default 不是
`SandboxBackendProtocol` 的实现就没有 execute。

**`/tmp/` 下的文件在磁盘上找不到**

故意的：`/tmp/` 路由到 `StateBackend`，是会话内的虚拟 FS，线程结束就没了。
要落盘就用工作空间里的普通路径。

**子 agent 读不到工作空间里的文件**

声明了 `permissions` 的子 agent 用的是 `FilesystemBackend(root_dir=工作空间,
virtual_mode=True)`，路径和主 agent 一样（`/` 就是工作空间根）。如果读不到，
先确认它读的是绝对虚拟路径（`/stupid_code/...`）而不是相对路径。

**shell 里 `python` / `uv` 找不到**

`inherit_env` 没开。`LocalShellBackend` 默认给 shell 一个**空环境**，
PATH 是空的。

---

## 4. 已验证的事实

- 主 agent 的文件工具集是 `ls / read_file / write_file / edit_file / delete /
  glob / grep / execute`
- `execute` 真能跑本机命令：cwd = 工作空间，`$HOME` 等环境变量继承得到
- agent 的 `write_file` 写进 `/.scode-memory.md` 后，磁盘上那个文件的内容真的变了
  （早先用 StateBackend 时只改虚拟 FS）
- 真实服务里复验过一轮：模型念出了记忆文件里的标记 `SCODE_E2E2_MEMORY_MARKER_3`，
  用 `write_file` 把 `SCODE_E2E2_WRITTEN_MARKER_4` 写进了磁盘上的同一个文件，
  用 `execute` 跑 `pwd` 返回的正是工作空间路径
- `reviewer` 的工具集里**没有 execute**；调它的 `write_file` 返回
  `Error: permission denied for write on /should-not-exist.txt`，文件没有被创建
- 框架确实在「backend 支持 execute + 有 permissions」时抛 `NotImplementedError`
  （`deepagents/middleware/filesystem.py`，`FilesystemMiddleware.__init__` 里）
- `supports_execution()` 对 CompositeBackend 查的是 `backend.default`
  （`isinstance(backend.default, SandboxBackendProtocol)`）
- `CompositeBackend.execute()` 直接转发给 default backend
- 框架会自动为 CompositeBackend 生成「Shell paths vs. virtual paths」提示段，
  `/tmp/` 这种非磁盘路由会被标成"shell 访问不到"
- `LocalShellBackend` 默认 `inherit_env=False`，shell 拿到的是空环境
- `langgraph validate` 通过；图节点里仍有 `MemoryMiddleware.before_agent`

## 5. 待核实

- **没有人工确认**。`execute` 是无隔离的本机 shell，agent 能读任何文件
  （包括 `conf/config.toml` 里的 api_key）、能改任何东西。前端没有审批 UI，
  所以现在既没有 HITL 拦截，也没有别的护栏。补的办法是给 `execute` 加
  `interrupt_on` + 前端批准按钮
- **子 agent 的"无 shell"只覆盖声明了 `permissions` 的那些**。没声明 permissions
  的子 agent（比如 `fixer`）拿的是主 agent 那套带 shell 的 backend
- 记忆仍然是**只在会话开始时读一次**（框架设计），改完要开新会话
