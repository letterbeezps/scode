# 框架背景与学习路线

本文档收 README 里放不下的两块内容：**Deep Agents 这套框架给了什么**（背景知识），以及**按什么顺序学**（学习路线）。

想直接跑起来的话，回 [`README.md`](../README.md) 的「快速开始」；想看代码现状，回 [`docs/backend/backend.md`](backend/backend.md)。

---

## Deep Agents 提供了什么

它是建在 LangChain / LangGraph 之上的**开箱即用 agent harness**，规划、上下文管理、子 agent 这些能力是**配置出来的，不需要自己实现**：

- **任务规划** —— TodoList 中间件帮 agent 拆解复杂任务
- **上下文管理** —— 长对话自动摘要，工具输出落盘，不把 context 撑爆
- **文件系统** —— 可插拔后端（本地 / 沙箱 / 远程）上的读写、编辑、搜索
- **Shell 访问** —— 在你选的沙箱里执行命令
- **子 agent** —— 派发任务给上下文互相隔离的专职 agent
- **长期记忆** —— 跨会话的 pluggable state / store
- **人工介入** —— 敏感工具调用执行前可批准 / 编辑 / 拒绝
- **Skills** —— 按需加载的可复用行为
- **工具** —— 自己的函数，或任意 MCP server

### 三层关系，别搞混

```
Deep Agents   ← 最上层，带电池的 harness（规划 / 文件 / 子 agent / 记忆）
     ↓
LangChain     ← create_agent，模型 + 工具 + agent 循环的抽象层
     ↓
LangGraph     ← 底层运行时，图的编排、持久化、checkpoint
    
LangSmith     ← 横切，追踪与评测
```

层与层可以组合：任意 `CompiledStateGraph` 都能作为 Deep Agent 的子 agent 接进来。

---

## 装 skills

22 个 skill 装在 `.agents/skills/`，`.claude/skills/` 里是指过去的一串软链（给 Claude Code 用）。
这两个目录都在 `.gitignore` 里，**clone 之后要自己装一遍**，否则编码 Agent 看不到这些参考资料：

```bash
npx skills add langchain-ai/langchain-skills --skill '*' --yes
ls .agents/skills | head    # 看到 deep-agents-core、ecosystem-primer 等目录就成了
```

| 场景 | 命令 |
| --- | --- |
| 全局安装（所有项目可用） | `npx skills add langchain-ai/langchain-skills --skill '*' --yes --global` |
| 只装给某个 Agent（如 Claude Code） | `npx skills add langchain-ai/langchain-skills --agent claude-code --skill '*' --yes` |
| 只装单个 skill | `npx skills add langchain-ai/langchain-skills --skill deep-agents-core --yes` |

`npx skills` 遵循 Agent Skills 规范，Claude Code、Cursor、Windsurf 等支持该规范的编码工具都能用。
安装状态记录在 `skills-lock.json` 里。

---

## 学习路线

22 个 skill 大致可以这么用，跟着 `ecosystem-primer` 的选型表往下走：

**第一步 · 搞清楚选型** — 动手前先读 `ecosystem-primer`，它决定了你该用 Deep Agents 还是 LangChain 还是 LangGraph，以及下一步该加载哪个 skill。

**第二步 · 搭出最小 agent** — `deepagents-python-quickstart` + `deep-agents-core`。跑通官方 quickstart，然后逐个摸中间件：TodoList、Filesystem、SubAgent、HumanInTheLoop、Skills、Memory。其中 Filesystem / SubAgent / Skills / Memory 来自 `deepagents.middleware`，TodoList 和 HumanInTheLoop 来自 `langchain.agents.middleware`（Deep Agents 在 0.7 起把它们改成按需引入）。

**第三步 · 做深 code agent 的能力** — 这是本项目的正题：

| 想搞清楚的问题 | 看这个 skill |
| --- | --- |
| 长任务怎么不跑偏 | `deep-agents-core`、`deep-agents-orchestration` |
| 上下文爆了怎么办 | `deep-agents-core`（context management） |
| 跨会话记住东西 | `deep-agents-memory` |
| 危险操作怎么拦 | `langgraph-human-in-the-loop` |
| 中间件怎么写 | `langchain-middleware` |
| 断了能接着跑 | `langgraph-persistence`、`langgraph-fundamentals` |
| agent 好不好用 | `eval-engineering` |

**第四步 · 回头补底层** — 等你真的需要自定义控制流了，再下沉到 `langgraph-decision-models`、`langgraph-*` 系列。

其余还有 `langchain-fundamentals`、`langchain-rag`、`langchain-dependencies`（依赖版本管理）、`swarm`（多 agent 编排）、`managed-deep-agents`、`langgraph-cli` 等，按需查。

> 建议：**读文档和 skill 的优先级高于读本仓库的代码。** 这个仓库的代码大概率是粗糙的、甚至是错的，那正是学习项目该有的样子。
