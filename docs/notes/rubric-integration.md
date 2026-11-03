# Rubric（验收闭环）接入纪要

> 一次完整的能力接入记录：从源码调研、概念对齐到前后端落地与端到端验证。
> 机制现状沉淀在 [backend.md §3.20](../../docs/backend/backend.md)（后端能力文档），
> 请求契约在 [API.md](../../stupid_code/API.md) 的 `input.rubric`——本文是**过程与决策**的版本，
> 讲清楚「为什么这样接」，三份文档互补。
>
> 环境：deepagents 0.7.28 / langchain 1.4.6 / langgraph 1.2.16。
> `RubricMiddleware` 是 `@beta` API，升级框架后本文结论需重新核对。

---

## 1. RubricMiddleware 是什么

deepagents 自带的自我验收中间件（[rubric.py](../../.venv/lib/python3.12/site-packages/deepagents/middleware/rubric.py)，
顶层 `from deepagents import RubricMiddleware` 可直接导入）：

- **激活是 opt-in**：run 的 **input** 带 `rubric` 键（描述「什么算干完」）时才工作；
  不带时 `before_agent` / `after_agent` 两个钩子都直接返回——**挂上不传等于不存在**，
  可以无条件装配、按需激活。
- **闭环机制**：agent 每次要收尾（模型不再调工具）时，把最近 30 条消息（每条截
  4000 字符，nonce 分隔符防注入）喂给一个**独立的 grader 子 agent**（内部
  `create_agent` + `response_format=GraderResponse` 结构化输出，逐条 criterion
  给 `passed`/`gap`，带交叉一致性校验）：
  - `needs_revision` → 把 gap 清单作为 `HumanMessage`（`lc_source="rubric_grader"`
    标记）注入对话历史，`jump_to="model"` 跳回模型返工；
  - `satisfied` / `failed` / 超过 `max_iterations`（本项目配 3）/ `grader_error`
    → 正常结束，**最后一次回答原样返回**（非 satisfied 终止不改写回复）。
- **`create_deep_agent` 没有对应参数**，只能走 `middleware=` 手动挂。好处：名字
  不与 core 栈相撞，不会被 skill 中间件那种「name 提取 → 顶进 core tail」的机制
  挪位置，老实落自定义区；且它只有 before/after_agent 钩子，不碰提示词不碰模型，
  **位置不敏感**。

## 2. 概念对齐（接入前理清的四个问题）

**① 评的是什么？** 不是「大模型的回复文本」，是**本次 run 的全部工作**——
grader 看的是 transcript（请求、每次模型回复、每次工具调用和结果、文件改动），
判定标准是「这轮活干完没」。适合任务级验收（类型注解、测试通过、改动不扩散），
不适合回复文笔打分。

**② 闭环的时间跨度？** 在**一个 run 内部**转完：一条消息可能展开成
「干活 → 评审 → 返工 → 干活 → 评审」最多 3 圈，转完才把回答返回给用户。
对使用者就是「这条消息回得慢了，但回来时已验收过」。

**③ 触发粒度 vs 生效跨度？** 两者要拆开：**触发是每次 invoke**（每个 run 独立
一轮完整闭环，`max_iterations` 预算每轮重置），**生效是整段对话**（rubric 是
公开 state key，按 thread 粘滞，checkpoint 持久化——传一次，粘到显式清除为止）。
中途换标准 = 传不同字符串（框架检测到变化会重置预算、重新分解 criterion；
**替换不是叠加，且不回溯**已验收的产出）。

**④ 要不要每次 invoke 都带？** 不用——传入即激活，之后粘滞。但前端不能依赖
粘滞（见 §3 的语义决策）。

## 3. 接入决策

### 3.1 传输通道：走 input，不走 context

workspace / permissions / skills / model 走 `context`（`context_schema=RunContext`
声明），rubric 却走 run 的 **input**——这不是随意选择：rubric 是框架的公开
state key（`RubricState.rubric`），框架按 input-state 的语义消费它。两套通道并存：

| | context（四个任务参数） | input.rubric |
|---|---|---|
| 消费方 | 各中间件读 `runtime.context` | `RubricMiddleware` 的钩子读 state |
| 生命周期 | 每次 run 随请求走，不落 state | 写进 state，按 thread 粘滞 |
| 「不传」的含义 | 用后端默认值 | **沿用 state 里的旧值** |

### 3.2 前端语义：UI 所见即所是

粘滞带来一个隐性 UX 陷阱：用户清空了设置界面，以为关了，state 里的旧 rubric
还在验。所以前端把语义固定为：

- **非空** → `input.rubric = 字符串`（设置/换尺子；重复传相同字符串无害——
  后端当新的一轮验收，预算重置）
- **空串** → `input.rubric = null`（**显式清除**）
- **永不省略这个键**——省略只表示「这次不改」，语义留给了粘滞的旧值

用户看界面显示「验收已开」就是真在验，清空就是真关了。

### 3.3 grader 模型：建图时固定，给 default_model

`ChatModelSwitchMiddleware` 只换**主 agent** 的 `request.model`——grader 是构造
时就建好的独立 agent（懒构建但模型参数固定），运行期切模型管不到它。接
`default_model`（`conf/config.toml` 的 `[models].default`）；副作用：改默认模型
要重启才影响 grader。

### 3.4 resume 不带 rubric

恢复挂起的运行（`command.resume`）**不需要带**：rubric 已在图状态里，挂起那次
run 的 `before_agent` 已经跑过，带了也不会重新触发。

## 4. 改动清单

**后端**

- [graph/agent.py](../../stupid_code/graph/agent.py)：模块级构造
  `rubric = RubricMiddleware(model=default_model, max_iterations=3)`，挂到
  middleware 列表最后（附设计注释）。**仅此一处**——input 里的 `rubric` 键由
  中间件自己的 `state_schema = RubricState` 声明，图构建时自动并入 state schema。

**前端**

| 文件 | 改动 |
|---|---|
| [api/types.ts](../../web/src/api/types.ts) | `RunOptions.rubric: string` |
| [store/taskStore.ts](../../web/src/store/taskStore.ts) | `TaskSettings.rubric`（默认空串；draft/adopt/hydrate 机制自动覆盖，跟 skills 同一份任务参数） |
| [api/run.ts](../../web/src/api/run.ts) | `streamRun` 的 input 带 `rubric: options.rubric.trim() \|\| null`；`resumeRun` 不带（§3.4） |
| [store/conversationStore.ts](../../web/src/store/conversationStore.ts) | rubric 写进 thread metadata（刷新回填）+ `hydrateTaskSettings` 回填 |
| [components/chat/RubricPicker.tsx](../../web/src/components/chat/RubricPicker.tsx) | 新组件：输入框工具行「验收」按钮 + 弹层面板（textarea 草稿 / 保存 / 清除）；草稿播种在 click 事件里做，不放 effect（`set-state-in-effect`） |
| [components/chat/InputBar.tsx](../../web/src/components/chat/InputBar.tsx) | 工具行挂载；生成中 / 审批挂起时禁用（跟其他任务参数一致——审批恢复会原样带回） |
| api/mock/index.ts | mock 模式回显 rubric，前端无后端开发时能看出参数随请求发出 |

**文档**

- [API.md](../../stupid_code/API.md)：`POST /threads/{id}/runs/stream` 补 `input.rubric` 契约（含 null 清除语义、resume 不带）
- [backend.md](../../docs/backend/backend.md)：新增 §3.20（能力现状）；§4.1 建图快照、§1.2 速查表同步

## 5. 端到端验证记录

**方法**：`langgraph validate` 通过后，**镜像建图**做闭环实测（已编译的图换不了
模型）——主模型用假模型（永远回 `ok`，省主 agent 成本），grader 用生产那份
`default_model`（真评审），挂 `MemorySaver` 以读 `PrivateStateAttr` 状态。

**结果**（rubric =「回复必须只包含数字 1，不能含有其他任何字符」）：

```
--- 消息历史 ---
HumanMessage   src=               'hi'
AIMessage      src=               'ok'
HumanMessage   src=rubric_grader  'A grader reviewed your work ...'
HumanMessage   src=rubric_grader  'A grader reviewed your work ...'
--- 验收状态 ---
rubric: '回复必须只包含数字 1，…'
_rubric_status: max_iterations_reached
_rubric_iterations: 3
_rubric_evaluations: 3
```

grader 真实评审了 3 轮、每轮 `needs_revision` 注入反馈并 `jump_to="model"` 返工
（消息历史可见）——**`jump_to` 与本项目的 state 合并（`SubagentSessionState` +
`RubricState`）在实测中无冲突**。前端 `pnpm build`（含 tsc）+ lint 全绿。

**验证时的坑**：验收状态 `_rubric_status` 是 `PrivateStateAttr`，**不在 invoke
的输出里**——本地验证要读它必须给图挂 checkpointer 再 `get_state()`；生产环境
走平台，从 `GET /threads/{id}/state` 的 values 读，或订阅
`rubric_evaluation_start/end` 流事件（后者还没接进前端 `events.ts`，见 §7）。

## 6. 使用方式

重启后端后，输入框工具行（工作空间/权限旁）出现「**验收**」按钮：

1. 点击 → 写标准（建议写成可逐条核验的列表，grader 按 criterion 拆开逐条打分）→ 保存
   → 按钮变「验收已开」
2. 之后**每条消息**交付前都按此标准验收，不过自动返工（最多 3 轮）
3. 清空保存 / 点「清除」= 显式关闭（`rubric: null`），不会踩粘滞的坑
4. 改标准 = 直接改文本，下一次发送即换尺子（不回溯已验收的产出）
5. 标准按任务（thread）存：跟 workspace/skills 一样记进 thread metadata，
   刷新页面回填；新任务各自设置

**注意成本**：每轮验收多一次 grader 调用（transcript 有截断兜底），
`needs_revision` 还会让主 agent 再干一轮。大任务开着全程验收，token 消耗会
明显上升——只在需要的任务上开。

## 7. 遗留 / 未做

- **前端没展示验收过程**：`rubric_evaluation_start/end` 流事件和
  `_rubric_status` 还没接进 `events.ts` / UI——用户看不到「正在验收 / 验收
  通过与否」，只能感知到「回复变慢了」。返工反馈消息倒是在消息流里（带
  `rubric_grader` 标记，UI 未按 lc_source 区分渲染）。
- **给 grader 配核实工具**：构造参数支持 `tools=`（比如只读工具让 grader 真去
  跑测试、读文件核验，而不只看 transcript）。v1 没给，纯 transcript 评审；
  要给的话注意工具会落运行期工作空间、且会放大成本。
- **grader 模型不能单独配**：现在跟主 agent 默认模型绑定（§3.3）。想要
  「主用贵模型、grader 用便宜模型」，得在 `agent.py` 单独 load 一个。
- **beta API**：deepagents 0.7.28 的 `@beta` 标记，升级框架时这块最可能变。
