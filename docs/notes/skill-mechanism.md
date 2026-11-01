# Skill 机制全流程解读

> 本文整理自一次对 `stupid_code/graph/skills.py` 的逐层代码走读，覆盖**装配 → 路径解析 → 钩子触发 → prompt 注入 → 调试**的完整链路，并附上调试过程中实测出的几个与注释预期不符的行为。
>
> 环境：deepagents 0.7.28 / langchain 1.4.6 / langgraph 1.2.16。框架还在 0.x，升级后本文的框架侧行号和行为需要重新核对。

---

## 0. 全景：一次 run 里 skill 的生命周期

```
启动后端（进程级，只发生一次）
  └→ import agent.py → create_deep_agent(...)
       ├→ WorkspaceSkillsMiddleware 实例化，顶掉框架槽位
       └→ （没有任何 skill 钩子运行）

一次 run（= 前端发一条消息 = 一次 POST /threads/{id}/runs）
  ├→ [入口节点] before_agent     ← 每 run 一次：判定要不要重扫目录、写 state
  │     └→ backend.ls() 经 cwd property 解析到「此刻」的工作空间
  ├→ 模型调用 #1
  │    ├→ modify_request          ← 每次模型调用：技能清单块 → 系统提示词
  │    ├→ before_model            ← 每次模型调用：勾选的 SKILL.md 全文 → 消息历史
  │    └→ 模型可能自己 read_file 某个 SKILL.md（工具结果进历史）
  ├→ 模型调用 #2（工具循环……）
  └→ run 结束，state 随 checkpoint 落盘 → 下一个 run 复用（不重扫）
```

---

## 1. 装配：建图时发生什么

### 1.1 `skills=` 参数只是语法糖

`create_deep_agent(skills=[...])` 内部等价于「往 core middleware 栈里挂一份默认的 `SkillsMiddleware`」。所以「用 `middleware=` 自己挂」不是绕开框架的另一种机制，而是**同一个机制的公开定制入口**——传的是本项目自己的子类实例。

### 1.2 `.name` 顶替与它的真实位置

deepagents 合并中间件时按 `.name` 匹配：撞名就**原地替换**。`WorkspaceSkillsMiddleware` 把 `name` 覆盖成框架类名（`SkillsMiddleware.__name__`，从框架问出来、不写死字面量，见 [skills.py:187-194](../../stupid_code/graph/skills.py#L187-L194)），因此它不是「多挂一份」而是「顶掉框架默认那份」。

**但位置有个关键细节**（deepagents `graph.py`）：

- 只要 middleware 列表里出现 `name == "SkillsMiddleware"` 的实例，框架就会提取它的 `sources`、在 **core 栈尾部**建一份 SkillsMiddleware，再让自定义那份原地顶替（`_passed_skills_sources`，graph.py:683-684；替换逻辑 graph.py:219-232）；
- 其余自定义 middleware 落在**自定义区**（core 之后、tail 之前）。

所以本项目的技能中间件**不在自定义区，而在最内层 tail 槽位**（比记忆中间件更内层）。

### 1.3 ⚠️ 实测块序与 agent.py 注释的意图相反

[agent.py:67-75](../../stupid_code/graph/agent.py#L67-L75) 注释说「不传 `skills=`，中间件落进自定义区（排在记忆前面），记忆块留在系统提示词最后一块」。**实测并非如此**（见 §6 的 dump_prompt.py 输出）：

```
块 0: 系统提示词本体
块 1: ## Shell paths vs. virtual paths     （FilesystemMiddleware，core）
块 2: ## 当前工作空间                        （WorkspaceMiddleware，自定义区）
块 3: ## 长期记忆                            （MemoryMiddleware，自定义区）
块 4: ## 技能库                              （SkillsMiddleware，core tail ← 顶替到此）
```

**技能库块在记忆块后面**——正因为 1.2 的机制：顶替发生在 core tail 槽位，而不是自定义区。这可能影响 prompt-caching 断点的预期位置（原意图是断点落在最后的记忆块上）。待核实缓存行为。

---

## 2. 工作空间如何生效：两半拼起来

「项目级 skill 跟着运行期工作空间走」**不是中间件实现的——中间件一行路径解析代码都没有**。路径解析在 backend 里：

### 2.1 解析层（backend 提供，免定制）

框架的 `before_agent` 只会调 `backend.ls("/.agents/skills/")`——框架中间件是「工作空间盲」的。这个虚拟路径落到哪由主 backend（`CompositeBackend`）决定：

```
backend.ls("/.agents/skills/")
 ├→ 路由判定：不以 "/user-skills/" 开头 → 走 default = WorkspaceShellBackend
 └→ WorkspaceShellBackend.ls("/.agents/skills/")     （继承框架 FilesystemBackend）
      └→ self.cwd / ".agents/skills"
           └→ cwd 是 property！（backend.py:68-71）
                return current_workspace()           ← 此刻现算本轮工作空间
```

关键在**惰性求值**：`cwd` 从实例属性换成 property（类上的数据描述符优先于实例 `__dict__`，父类 `__init__` 里的赋值落进 setter 被忽略），每次 `ls` 都现算根目录。run #1 在 `/proj-a` 扫 `/proj-a/.agents/skills/`；run #2 换到 `/proj-b`，同一段代码扫 `/proj-b/.agents/skills/`。

全局源 `/user-skills/` 则命中 CompositeBackend 的固定路由，落到 `~/.scode/.agents/skills/`，与工作空间无关。

### 2.2 触发层（自定义中间件提供）

框架只在一个 thread 没有 `skills_metadata` 时扫一次（判定是 `state.get("skills_metadata") is not None`）。不定制的话，换工作空间后 state 里还是旧项目的清单。所以必须**摘掉 metadata 逼它重扫**——见 §3.2。

---

## 3. 三个钩子、三个时点

对照框架源码（`.venv/.../deepagents/middleware/skills.py`）：

### 3.1 `before_agent` —— 每 run 开始一次（入口节点）

被编译成图的真实节点（langchain factory.py:1636-1641），且是 **entry node**（factory.py:1715-1719）：`before_agent → before_model → model`。项目里的重写是「三明治」结构（[skills.py:198-228](../../stupid_code/graph/skills.py#L198-L228)）：

```python
def before_agent(self, state, runtime, config):
    prepared, workspace, selected = self._prepare_before(state, runtime)  # ① 前置
    update = super().before_agent(prepared, runtime, config)              # ② 框架
    return self._finish(update, workspace, selected)                      # ③ 收尾
```

入参：`state`（当前 thread 的图状态，**只读快照**）、`runtime`（`.context` = 本次请求的 `RunContext`）、`config`（透传）。返回值是 state update 字典（见 §4）。

**① `_prepare_before`**：从 `runtime.context` 算出本轮工作空间（`workspace_of`）和勾选清单（`selected_skills`，做去重去空串保序清洗）。两个值都来自**本次请求**，不是 state 里的旧值——这是「任务级参数按 run 走」的落点。

**② 摘 metadata 的机关（`_state_for_reload`，[skills.py:232-252](../../stupid_code/graph/skills.py#L232-L252)）**：

| 情况 | 动作 |
|---|---|
| state 里没有 `skills_metadata`（新会话首次 run） | 原样返回 → 框架扫目录 |
| 工作空间没变 **且** 勾选没变（比对 state 里的脚印） | 原样返回 → 框架跳过，本轮零开销 |
| 有一样变了 | 返回**摘掉 `skills_metadata` 的副本** → 框架重扫 |

摘 key 为什么有效：框架判定是 `state.get("skills_metadata") is not None`——**key 不存在和值为 `None` 等价**。而且这其实是框架官方认可的 reload 接口（框架 skills.py:926-932 明确写了 `agent.invoke({"skills_metadata": None}, ...)`）。注意摘的是「传给框架的视图副本」（dict comprehension 复制、唯独丢掉这个 key），原始 state 没被碰。

**框架内部（②展开）**：遍历 `self.sources = ("/user-skills/", "/.agents/skills/")`，逐个 `backend.ls()`，同名 skill **后面的源覆盖前面的**——所以项目级覆盖全局。返回的 `SkillsStateUpdate` 只含元数据（名字、路径、frontmatter 里的 description），**不含正文**。

**③ `_finish`（[skills.py:254-287](../../stupid_code/graph/skills.py#L254-L287)）**：
- `update is None` 直接返回（框架跳过了）；
- 滤掉「目录不存在」的 load error——大部分工作空间没有 `.agents/`，这个警告会进系统提示词的 `<skill_load_warnings>` 段，纯噪音；
- 写脚印 `scode_skill_workspace`（下一轮比对的材料）；
- 勾选非空时写 `pinned_skills`（框架消费）和 `scode_pinned_skills`（自留脚印）。

**同步/异步孪生**：`abefore_agent` 逻辑完全一样（框架扫目录走 backend 异步接口），LangGraph 按执行环境二选一——**两个都要实现**。

### 3.2 `modify_request` —— 每次模型调用前

在框架自己的 `wrap_model_call` 内部执行（skills.py:1322-1337）。从 state 读 `skills_metadata`，用中文模板渲染成「技能库」块追加进系统提示词。**清单里只有名字+描述+路径，没有正文**——这是渐进式披露的「菜单」。

### 3.3 `before_model` —— 每次模型调用前（框架实现，项目不覆盖）

读 state 里的 `pinned_skills`，非空则按名字在 `skills_metadata` 里查路径，`backend.download_files()` 读 SKILL.md，**全文作为一条消息追加进对话历史**，然后写 `Overwrite([])` 清空。清空意味着钉的动作只在重读那一轮发生一次；钉进去的消息留在历史里，之后每轮随历史自动重发。`pinned_skills` 的 reducer 是累加（`_append_skill_names`），消费即清空，正常不重复。

---

## 4. 返回值的去向：state 是中间件间的通信介质

`before_agent` 的返回 dict 的直接调用者是 **LangGraph 图引擎**（节点返回值 = state update 协议，像任何节点 `return {"messages": [...]}`）。引擎合并进 thread 的 state，然后分两路：

```
返回 dict → LangGraph 合并进 state
 ├→ 路径 A：随 checkpoint 落盘 SQLite → 存活到以后的 run
 └→ 路径 B：流向本次 run 的后续节点 → 模型调用
```

各 key 的消费者：

| key | 消费者 | 何时 |
|---|---|---|
| `skills_metadata` | 框架 `modify_request` | 每次模型调用：渲染技能清单块 |
| `skills_metadata` | 框架 `before_model` | pin 时按名字查路径 |
| `skills_load_errors` | 框架 `modify_request` | 渲染 `<skill_load_warnings>` 段 |
| `pinned_skills` | 框架 `before_model` | 钉全文后 `Overwrite([])` 清空 |
| `scode_skill_workspace` / `scode_pinned_skills` | **它自己** | **下一个 run** 的 `_state_for_reload` 比对 |

精妙之处：`before_agent` 写、`before_model` 读——**中间件的不同钩子之间靠 state 传话**，实例本身不存任何 per-run 数据。这就是「无状态」设计的通信介质。

---

## 5. skill 进入 prompt 的三条通道

**所有内容最终都进模型上下文，但载体和时机不同：**

| 通道 | 载体 | 内容 | 时机 | 谁决定 |
|---|---|---|---|---|
| ① 技能清单 | 系统提示词 | 名字+描述+路径 | 每次模型调用 | 中间件（无条件） |
| ② 勾选 pin | 对话历史（消息） | SKILL.md 全文 | pin 的那轮注入，之后常驻 | 用户勾选 |
| ③ 模型自取 | 对话历史（工具结果） | SKILL.md 全文 | 模型调 `read_file` 时 | 模型自己 |

通道③的路径是清单里给的虚拟路径（`/user-skills/...` 或 `/.agents/skills/...`），由 backend 路由翻译到磁盘。正因为「全文」只发生在②③（按需），token 消耗才可控。

---

## 6. 调试：examples/dump_prompt.py

配套脚本 [examples/dump_prompt.py](../../examples/dump_prompt.py) 打印**实际发给大模型的完整 prompt**：

```bash
uv run python examples/dump_prompt.py                     # dry：假模型，不调 API
uv run python examples/dump_prompt.py --skills deep-agents-core
uv run python examples/dump_prompt.py --live "..."        # 真模型 + 生产图
```

### 6.1 为什么用模型回调而不是 middleware 截获

在自定义 middleware 列表末尾挂 `wrap_model_call` 截获器**截不到最终形态**：因为 §1.2 的机制，技能中间件在 core tail（最内层），自定义区的截获器看到的是技能块注入**之前**的请求。`on_chat_model_start` 回调在真正的模型调用处触发，拿到的才是最终形态。这是唯一不依赖中间件位置的截获点。

### 6.2 直接 invoke 图的 context 传参坑

直接 `graph.invoke(input, config, context={...})`——**`context` 是 invoke 的独立关键字参数**（langgraph runtime.py:188）。塞在 config dict 里会被**静默丢弃**（`runtime.context` 拿到 `None`，不报错）。生产环境走 langgraph dev 没这个问题（平台注入），但本地调试脚本必踩。

### 6.3 假模型要覆盖 `bind_tools`

`FakeMessagesListChatModel` 不支持 `bind_tools`（框架在每次模型调用前 `request.model.bind_tools(...)`，会抛 `NotImplementedError`）。脚本里覆盖成「记下工具名、返回 self」——顺带这正好是「模型真正收到哪些工具」的观测点。

---

## 7. 速查：重读 / 跳过判定

`_state_for_reload` 是唯一开关，对照记在 state 里的两个脚印（`scode_skill_workspace` / `scode_pinned_skills`）：

| 本轮 vs state 记录 | 动作 |
|---|---|
| state 里没有 `skills_metadata` | 扫目录，加载 |
| 工作空间变了 **或** 勾选变了 | 摘掉 metadata → 重扫、重新 pin |
| 都没变 | 框架跳过（返回 `None`），本轮零开销 |
| 取消勾选 | 重读但不写 `pinned_skills`——已钉的消息**不移除**（AGENTS.md 第 20 条⑤） |

## 8. 概念分层（容易混）

| 概念 | 是什么 | skill 相关行为 |
|---|---|---|
| 启动项目 | `langgraph dev` 起进程、建图 | 只装配，无钩子运行 |
| thread（会话） | 一个对话，state 由 checkpointer 持久化 | `skills_metadata` 跨 run 存活 |
| run | 图的一次执行 = 一条消息 = 一次 `POST /threads/{id}/runs` | `before_agent` 每 run 一次 |
| 模型调用 | run 内「模型→工具→模型…」循环的每一圈 | `modify_request` / `before_model` 每圈一次 |

HITL 挂起再恢复**不算新 run**：`before_agent` 节点在挂起前已执行完并进了 checkpoint，LangGraph 从被打断的节点继续，不重跑入口节点。
