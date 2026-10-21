# 004 subagent 配置（conf/subagents.toml）

## 目标

让主 agent 能通过 `task` 工具把活派给专门的子 agent。子 agent 的声明放配置文件里，
不在 Python 代码里写死。

### 成功标准

- `conf/subagents.toml` 里声明一个子 agent，重启服务后主 agent 的 `task` 工具描述里
  就能看到它，`task(subagent_type="<name>")` 能真的调起来
- 每个子 agent 的 `model` 用 `供应商名:模型名` 写法，**复用 `config.toml` 里该供应商的
  base_url / api_key**，不在 subagent 配置里重复写连接信息
- 子 agent 的 model 解析成 `BaseChatModel` 实例传进去（不是把字符串丢给 deepagents
  自己解析——它认不出本项目自定义的供应商名）
- 配错时启动即报错，错误信息说清是哪个子 agent、哪个字段

### 本期不做

- 子 agent 的自定义 Python 工具（TOML 表达不了函数）
- `middleware` 字段（要 Python 对象，见「配置字段」表最后一行的说明）
- 子 agent 的管理接口（增删改子 agent）——本期只读配置文件
- 前端的审批 UI：子 agent 的 `interrupt_on` 会让运行挂起，但前端还没有"批准/拒绝"
  按钮，approve/reject 暂时只能用 API 触发（见「验证」步骤 5）

### 关键取舍

- **配置文件放 `conf/subagents.toml`，用 `[[subagents]]` 数组表**：跟 `config.toml`
  平级，供应商信息在 `config.toml`、子 agent 声明在 `subagents.toml`，各管一件事
- **这个文件入库**（不像 `config.toml`）：里面只有子 agent 声明，没有密钥。密钥仍然
  只在 `config.toml` 里，那份继续 gitignore
- **文件不存在 = 不配置任何子 agent**，返回空列表而不是报错——deepagents 自带的
  `general-purpose` 子 agent 照常可用
- **内容写错就报错**：不静默忽略。TOML 里字段名打错（比如 `system_promt`）要立刻
  报出来，否则会以为配上了其实没生效
- **`model` 必填**：deepagents 的 `SubAgent` 允许不写 model（继承父 agent 的），但
  本期要求每个子 agent 都显式指定，免得"看着配了其实用的是主模型"
- **不改 `langgraph.json`**：子 agent 不引入新的图，`graph/agent.py` 里 `create_deep_agent()`
  多传一个 `subagents=` 就够了

---

## 1. 文件清单

| 文件 | 动作 |
|---|---|
| `stupid_code/config/subagent.py` | 新建：读 `conf/subagents.toml`，校验并转成 deepagents 的 `SubAgent` 规格 |
| `stupid_code/config/model.py` | 修改：抽出 `build_model_by_spec()`，主 agent 与子 agent 共用 |
| `stupid_code/graph/agent.py` | 修改：`create_deep_agent()` 多传 `subagents=load_subagents()` |
| `conf/subagents.toml` | 新建：子 agent 声明（含全部字段的注释说明） |
| `stupid_code/README.md` | 同步：启动说明里提一句这个文件 |

### 1.1 `stupid_code/config/model.py`（修改：抽出 `build_model_by_spec`）

原来 `build_model()` 一个函数干两件事：选规格（`default` → `recent`）+ 按规格建模型。
子 agent 的 model 规格是显式给的，走不了"选"这一步，所以拆成两个：

```python
def build_model(config: dict[str, Any]) -> BaseChatModel:
    """按 [models].default → recent 的顺序构建主 agent 的模型。"""
    models = config.get("models")
    if not isinstance(models, dict):
        raise ConfigError("config.toml 缺少 [models] 段")

    return build_model_by_spec(config, _pick_model_spec(models))


def build_model_by_spec(config: dict[str, Any], spec: str) -> BaseChatModel:
    """按 "供应商名:模型名" 规格构建模型实例。"""
    # ...原来的建模型逻辑，供应商/协议/models 列表校验都在这里
```

### 1.2 `stupid_code/config/subagent.py`（新建）

三个公开函数，加若干个 `_` 前缀的字段解析函数：

- `subagents_path()` → `conf/subagents.toml` 的路径（用 `__file__` 定位，跟
  `config/model.py` 同一套办法）
- `load_subagent_config()` → 读 TOML；文件不存在返回 `{}`；语法错误抛 `ConfigError`
- `load_subagents()` → 读配置 + 读 `config.toml` + 逐个转成 `SubAgent` 规格
- `build_subagents(config, main_config)` → 纯函数，方便单独测

字段解析拆成 `_parse_tools()` / `_parse_interrupt_on()` / `_parse_permissions()`
三个小函数，每个只管一种字段的校验和转换。

关键点：**`model` 传实例，不传字符串**

```python
model = build_model_by_spec(main_config, model_spec)
spec = {"name": name, "description": description, "model": model}
```

deepagents 内部会做 `resolve_model(spec["model"])`：收到 `BaseChatModel` 实例原样返回，
收到 `"provider:model"` 字符串则去调 langchain 的 `init_chat_model()`——而
`init_chat_model` 不认识本项目自定义的供应商名（`minimax`、`deepseek`），
会直接抛错。所以必须在这里就换成实例。

**`permissions` 传对象，不传 dict**

deepagents 的 `SubAgent.permissions` 要的是 `FilesystemPermission` 数据类，
不是 dict。`FilesystemPermission` 自己的 `__post_init__` 会校验路径（必须以 `/`
开头、不能有 `..`、不能有 `~`），所以这里转成对象、把它的 `ValueError` 包成
`ConfigError` 再抛，错误信息才是中文人话。

### 1.3 `stupid_code/graph/agent.py`（修改）

```python
graph = create_deep_agent(
    model=load_model(),
    system_prompt="你是一个编程助手。",
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用
    subagents=load_subagents(),
)
```

### 1.4 `conf/subagents.toml`（新建）

三个示例子 agent，分别演示不同能力：

| 名字 | 演示的字段 |
|---|---|
| `reviewer` | `system_prompt` + `permissions`（只读：所有写操作 deny） |
| `fixer` | `interrupt_on`（写文件要人工确认） |
| `summarizer` | `response_format`（结构化输出，JSON schema） |

外加一段注释掉的 `mode = "fork"` 示例。

---

## 2. 配置字段对照表

`[[subagents]]` 里可用的字段，以及它们对应 deepagents `SubAgent` 规格的哪一项：

| TOML 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `name` | ✅ | 字符串 | 子 agent 标识，`task(subagent_type=...)` 用；不能重名 |
| `description` | ✅ | 字符串 | 能力描述。主 agent 靠它决定什么时候委派，写具体点 |
| `model` | ✅ | 字符串 | `"供应商名:模型名"`，供应商在 `config.toml` 里配 |
| `system_prompt` | | 字符串 | 子 agent 的系统提示词。`mode="fork"` 时是追加而非替换 |
| `mode` | | `"isolated"` / `"fork"` | 默认 `isolated`（只看得到委派任务）；`fork` 接着父对话跑（实验特性，启动有 beta 警告） |
| `skills` | | 字符串数组 | skill 目录路径。`mode="fork"` 时不能写（fork 直接继承父 agent 的） |
| `tools` | | 表数组 | 供应商内置工具（provider tool）。**不写就继承父 agent 传给 `create_deep_agent()` 的 `tools`**，写了就是替换那一项；文件工具（`ls` / `read_file` / `write_file` 等）来自 FilesystemMiddleware，不受此字段影响 |
| `interrupt_on` | | 表 | `{ 工具名 = true }` 或 `{ 工具名 = { allowed_decisions = [...], description = "..." } }` |
| `permissions` | | 表数组 | 文件访问规则 `{ operations = [...], paths = [...], mode = "allow"/"deny"/"interrupt" }`。不写就继承父 agent 的 |
| `response_format` | | 表 | 结构化输出的 JSON schema，键名和 `properties` 照 JSON Schema 写 |

deepagents 的 `SubAgent` 还有 `middleware` 字段，本期**不支持**：它要的是 Python
对象（`AgentMiddleware` 实例），TOML 表达不了。要改子 agent 的中间件栈，
目前只能改 `stupid_code/config/subagent.py` 里写死。

字段取值范围：

- `mode`：`isolated` / `fork`
- `permissions.operations`：`read` / `write`
- `permissions.mode`：`allow`（默认）/ `deny` / `interrupt`
- `interrupt_on.allowed_decisions`：`approve` / `edit` / `reject` / `respond`

---

## 3. 验证

### 步骤 0：配置能被解析

```bash
cd /path/to/stupid-code
uv run python -c "
from stupid_code.config.subagent import load_subagents
for s in load_subagents():
    print(s['name'], '->', type(s['model']).__name__, s['model'].model)
"
```

期望输出每个子 agent 的名字 + 解析出的模型实例：

```
reviewer -> ChatAnthropic MiniMax-M3.1-Flash
fixer -> ChatAnthropic MiniMax-M3
summarizer -> ChatAnthropic MiniMax-M3.1-Flash
```

### 步骤 1：图能加载

```bash
uv run langgraph validate --config stupid_code/langgraph.json
```

### 步骤 2：启动

```bash
uv run scode
```

### 步骤 3：`task` 工具描述里能看到子 agent

```bash
curl -s http://127.0.0.1:2024/assistants/search \
  -X POST -H 'Content-Type: application/json' -d '{"limit":10}'
```

拿到 `assistant_id` 后拉图：

```bash
curl -s "http://127.0.0.1:2024/assistants/<assistant_id>/graph" | head -c 200
```

或者直接看 `task` 工具的描述（本地就能看，不用启服务）：

```bash
uv run python -c "
from stupid_code.agent import graph
print(graph.nodes['tools'].bound.tools_by_name['task'].description)
"
```

描述里应该出现 `reviewer` / `fixer` / `summarizer` 三行。

### 步骤 4：真的调起一个子 agent

```bash
TID=$(curl -s -X POST http://127.0.0.1:2024/threads \
  -H 'Content-Type: application/json' -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['thread_id'])")

curl -s -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{
    "assistant_id": "<assistant_id>",
    "input": {"messages": [{"role": "user", "content": "调用 task 工具，subagent_type 必须填 summarizer。description 填：请对下面这段材料做结构化摘要并原样返回结构化结果。材料：LangGraph 的 checkpointer 负责把 agent 的状态快照持久化，store 负责跨线程的记忆读写。"}]},
    "stream_mode": ["updates"],
    "on_disconnect": "continue"
  }'
```

SSE 里应该能看到 `task` 工具调用（`subagent_type` 是 `summarizer`），以及工具返回的
结构化 JSON——字段就是 `response_format` 里定的 `title` / `points`。

### 步骤 5：`interrupt_on` 挂起 + 批准恢复

```bash
# 让 fixer 子 agent 写文件
curl -s -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"<assistant_id>","input":{"messages":[{"role":"user","content":"这件事必须由 fixer 子 agent 去做，你不要自己动手：调用 task 工具，subagent_type 填 fixer，description 填「创建文件 probe.txt，内容写 hello」。"}]},"stream_mode":["updates"],"on_disconnect":"continue"}'
```

跑完查线程状态，应该有挂起的 interrupt：

```bash
curl -s "http://127.0.0.1:2024/threads/$TID/state" | python3 -m json.tool | head -40
```

```json
{
  "next": ["tools"],
  "interrupts": [
    {
      "value": {
        "action_requests": [{"name": "write_file", "args": {...}}],
        "review_configs": [{"action_name": "write_file", "allowed_decisions": ["approve", "reject"]}]
      }
    }
  ]
}
```

批准并继续：

```bash
curl -s -N -X POST "http://127.0.0.1:2024/threads/$TID/runs/stream" \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"assistant_id":"<assistant_id>","command":{"resume":{"decisions":[{"type":"approve"}]}},"stream_mode":["updates"],"on_disconnect":"continue"}'
```

---

## 4. 常见问题

**启动报 `subagents.toml 第 N 个 [[subagents]] 的 model 无法解析`**
子 agent 的 model 里的供应商名或模型名在 `config.toml` 里没有。两个文件的模型名要
完全一致（包括大小写）。`config.toml` 的 `[models.providers.xxx].models` 是白名单，
不在里面就报错。

**改了 `conf/subagents.toml` 没生效**
改完要重启服务。子 agent 在 `graph/agent.py` 导入时构建一次，跟模型一样。

**`task` 工具里只有 `general-purpose`**
要么 `conf/subagents.toml` 不存在（那就该是这样），要么服务没重启，要么改的是
`config.toml` 之外的另一份文件——路径是按 `stupid_code/config/subagent.py` 的位置
算的（项目根的 `conf/`），不是当前工作目录。

**主 agent 老是派给 `general-purpose` 不派给你的子 agent**
`description` 写得不够具体。主 agent 是靠 `description` 判断该派给谁的，
"负责写代码"这种描述区分不出跟 `general-purpose` 的差别，要写清楚"做什么类型的活"。

**`Port 2024 is already in use, using port 54908 instead`**
已经有服务在跑了（`lsof -nP -iTCP:2024 -sTCP:LISTEN` 能查）。
`langgraph dev` 会自动换端口，但 `scode` 的就绪检查只认 2024——它会对着旧服务报
"已就绪"，实际你的新服务在另一个端口上。测试时记得用日志里那个真实端口。
先关掉旧服务更省事。

**子 agent 写文件没落磁盘**
正常。deepagents 默认用 `StateBackend`，文件系统是 graph state 里的虚拟文件系统，
跟 cwd 无关。文件工具"写成功"指的是写进了虚拟 FS。要落真实磁盘得给
`create_deep_agent()` 传 `backend=FilesystemBackend(root_dir=...)`，那是另一期的事。

---

## 5. 已验证的事实

- `conf/subagents.toml` 里 `model = "minimax:MiniMax-M3.1-Flash"` 解析成
  `ChatAnthropic` 实例，`base_url` / `api_key` 来自 `config.toml` 的
  `[models.providers.minimax]`——连接信息不用在 subagent 配置里重复写
- `task` 工具的描述里正确列出 `general-purpose`（deepagents 自带）+ 配置的三个
  子 agent
- `summarizer` 子 agent 真实跑通：主 agent `task(subagent_type="summarizer")`，
  子 agent 用自己的模型和 `system_prompt` 执行，返回的 JSON 严格符合
  `response_format` 里定的 schema（`title` + `points`）
- `fixer` 的 `interrupt_on = { write_file = { allowed_decisions = ["approve", "reject"] } }`
  生效：写文件调用被挂起，线程状态里 `next = ["tools"]` 且 `interrupts` 里带着
  `allowed_decisions: ["approve", "reject"]`；文件没有执行
- approve 恢复可用：`{"command": {"resume": {"decisions": [{"type": "approve"}]}}}`
  之后子 agent 继续执行并返回结果
- `permissions` 的 deny 规则在工具层拦得住：规则
  `{ operations = ["write"], paths = ["/**"], mode = "deny" }` 装到 middleware 上，
  `write_file` 返回 `Error: permission denied for write on /probe.txt`；去掉规则就能写
- `mode="fork"` / `skills` / `tools` 三种配置都能正常构建出 agent（fork 会抛
  `LangChainBetaWarning`，是 deepagents 自己的实验特性标记）
- 校验错误信息能直接给人看：缺字段、未知字段、模型不在白名单、供应商不存在、
  `mode` 取值非法、`fork` + `skills` 冲突、`allowed_decisions` 取值非法、
  `operations` 取值非法、权限路径不以 `/` 开头、名字重复——逐条都报得出来
- `subagents` 传空列表不影响 `create_deep_agent()`：`general-purpose` 照常存在

## 6. 待核实

- 前端没有审批 UI：子 agent 触发 `interrupt_on` 之后，运行会挂起，前端目前只能
  显示成"被中断"，没有批准/拒绝的按钮。要用得先补前端
- `tools` 字段只支持供应商内置工具（provider tool，dict 形态）；langchain 的
  `create_agent` 也接受 dict 形态的工具，但那是被原样透传给模型供应商的，
  不是本地执行的 Python 函数
- `mode="fork"` 只验证了能构建，没在真实对话里跑过 fork 的完整行为（beta 特性）
- 2024 端口被占时 `scode` 的就绪检查会误报（见「常见问题」），属于 launcher 的
  已知问题，本期没改
