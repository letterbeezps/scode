# 框架背景与学习路线

本文档收 README 里放不下的两块内容：**Deep Agents 这套框架给了什么**（背景知识），以及**按什么顺序学**（学习路线）。

想直接跑起来的话，回 [`README.md`](../README.md) 的「快速开始」；想看代码现状，回 [`docs/backend/PROGRESS.md`](backend/PROGRESS.md)。

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

## 学习路线

22 个 skill 大致可以这么用，跟着 `ecosystem-primer` 的选型表往下走：

**第一步 · 搞清楚选型** — 动手前先读 `ecosystem-primer`，它决定了你该用 Deep Agents 还是 LangChain 还是 LangGraph，以及下一步该加载哪个 skill。

**第二步 · 搭出最小 agent** — `deepagents-python-quickstart` + `deep-agents-core`。跑通官方 quickstart，然后逐个摸中间件：TodoList、Filesystem、SubAgent、HumanInTheLoop、Skills、Memory。

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
