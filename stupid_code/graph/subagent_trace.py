"""子 agent 会话捕获：把子 agent 的内部过程抓下来，回传给主 agent。

**要解决的问题**：deepagents 的 `task` 工具用 `subagent.invoke()` 调子 agent，
而 `invoke()` **不产生流**——子 agent 内部跑了什么、想了什么，主图完全看不到，
父图只拿到最后一条汇报文本。本模块负责把这段过程捞出来。

**为什么不用流式转发**：框架的 task 工具是私有实现（`_build_task_tool`），
拿不到它的 `invoke()` 调用点；而我们如果自己包一层 task 工具，就得重复实现
框架那一整套 fork / response_format / interrupt 语义，框架一升级就跟着坏。
所以这里走**状态回传**这条路：

1. 子 agent 挂一个中间件，在 `after_agent` 钩子里把自己的消息历史写进
   图状态的一个自定义通道（`scode_subagent_sessions`）。
2. 框架的 task 工具在把子 agent 的结果交回父图时，会把**子 agent 状态里
   除了框架自带键之外的所有键**原样带回去（`deepagents/middleware/subagents.py`
   的 `_return_command_with_state_update`）。自定义通道不在排除名单里，
   于是 transcript 自动回到父图。
3. 父图用 `state_schema` 声明这个通道，前端从 `/threads/{id}/state` 的
   `values` 里就能读到——刷新页面也不丢。

**关联键**：一次委派对应父图里一条 `task` 工具调用。transcript 用
**父图那条工具调用的 id** 做键，前端就能把子 agent 会话挂到对应的
工具卡片上。

这个 id 只有父图拿得到——子 agent 侧够不着（隔离模式下它只看得到父图
的 `messages`，拿不到父图的工具调用 id）。所以分两步：

1. 子 agent 在 `after_agent` 里把 transcript 写进状态通道，键是**临时键**
   （见 `PENDING_KEY`）——同一时刻只会有一个子 agent 在跑，先到先得。
2. 父图的 `SubagentSessionBinder`（`wrap_tool_call`）在 task 调用返回后，
   从返回的 `Command.update` 里把这份 transcript 捞出来，**用父图那条工具
   调用的 id 重新编组**，再交回图状态。

第 2 步是关键：`task` 工具返回的 `Command.update` 里带着子 agent 写的
自定义键（框架的 `_return_command_with_state_update` 原样带回），父图
在这里改名，才能把 transcript 和对应的工具卡片对上。

细节见 AGENTS.md 的硬约束、docs/backend/backend.md §3.19。
"""

from __future__ import annotations

from typing import Annotated, Any, NotRequired, TypedDict

from langchain.agents.middleware.types import AgentMiddleware, AgentState
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langgraph.types import Command

SUBAGENT_SESSIONS_STATE_KEY = "scode_subagent_sessions"
"""图状态里存子 agent 会话的 key。

不是 `PrivateStateAttr`——前端要能从 `/threads/{id}/state` 读到它，
好让子 agent 的会话页在刷新后还能还原。
"""

# 子 agent transcript 的消息条数上限。
#
# transcript 会进 checkpoint（每次工具调用都存一份），不设上限的话，
# 一个跑了几十轮的子 agent 会把状态撑大。截断时**保留最后 N 条**——
# 结论在末尾，开头的铺垫价值最低。
MAX_TRANSCRIPT_MESSAGES = 200

PENDING_KEY = "__pending__"
"""子 agent 写 transcript 时用的临时键。

**为什么需要临时键**：子 agent 拿不到父图那条工具调用的 id（隔离模式下
它只看得到父图的 `messages`），没法直接用正确的键。父图侧会在 task 调用
返回后把临时键换成真正的工具调用 id（见 `SubagentSessionBinder`）。

同一时刻只有一个子 agent 在跑——父图的一个 `tools` 节点里如果并行委派了
多个子 agent，它们的 transcript 会撞在同一个临时键上。后到的会覆盖先到的，
这种情况靠父图侧从 `Command.update` 里**逐个**捞（每个 task 调用各自返回
一份 `Command`，各自带自己那份 transcript），不会真的丢。
"""


def _merge_sessions(
    left: dict[str, Any] | None,
    right: dict[str, Any] | None,
) -> dict[str, Any]:
    """子 agent 会话通道的 reducer：按 id 合并。

    同一 id 覆盖（同一轮里同一个工具调用只该有一份），不同 id 并存
    （一轮里可能并行委派好几个子 agent）。
    """
    merged = dict(left or {})
    merged.update(right or {})
    return merged


class SubagentSessionState(AgentState):
    """图状态：记下这一轮跑出来的子 agent 会话。

    字段是**普通字段**（不是 `PrivateStateAttr`）：前端要读它。
    """

    scode_subagent_sessions: NotRequired[Annotated[dict[str, Any], _merge_sessions]]


class SubagentTranscriptMiddleware(AgentMiddleware[Any, Any, Any]):
    """子 agent 侧：跑完后把自己的消息历史写进状态。

    挂在每个子 agent 的规格里（见 `graph/subagent_policy.py`）。
    框架的 task 工具会把子 agent 状态里的自定义键原样带回父图，
    所以这里写进去的东西最终会出现在父图的 `scode_subagent_sessions` 里。

    **为什么用 `after_agent` 而不是 `after_model`**：`after_agent` 只在
    子 agent 整轮跑完时触发一次，写的是**完整**的会话历史；`after_model`
    每轮模型调用都会触发，会写出半截历史，还要自己去重。
    """

    name = "SubagentTranscriptMiddleware"

    def __init__(self, agent_name: str) -> None:
        """`agent_name` 是这个子 agent 在 task 工具里的名字（规格里的 `name`）。"""
        super().__init__()
        self._agent_name = agent_name

    def after_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """整轮跑完：把消息历史打包写进状态通道（临时键）。"""
        messages = list(state.get("messages", []) or [])

        session: dict[str, Any] = {
            "agent": self._agent_name,
            "messages": [_serialize_message(m) for m in messages[-MAX_TRANSCRIPT_MESSAGES:]],
        }
        description = _task_description_of(messages)
        if description:
            session["description"] = description

        # 用临时键：真正的关联键（父图的工具调用 id）只有父图拿得到，
        # 由 SubagentSessionBinder 在 task 返回后补上。
        return {SUBAGENT_SESSIONS_STATE_KEY: {PENDING_KEY: session}}

    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        """异步路径：同上（纯内存操作，没有 FS 调用）。"""
        return self.after_agent(state, runtime)


class SubagentSessionBinder(AgentMiddleware[Any, Any, Any]):
    """父图侧：把子 agent 的 transcript 跟父图的工具调用对上号。

    挂在**主 agent** 的中间件栈里。task 工具跑完后，它返回的
    `Command.update` 里带着子 agent 写的 transcript（框架原样带回），
    这里把它从临时键改成父图那条工具调用的 id——前端就能把子 agent
    的会话挂到对应的工具卡片上。

    **为什么非得在父图做**：子 agent 在隔离模式下只看得到父图的
    `messages`，拿不到父图的工具调用 id（见 `tool_call_id_of` 的说明）。
    """

    name = "SubagentSessionBinder"

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Any,
    ) -> Any:
        """同步路径：跑完 task 后重新编组。"""
        return self._rebind(request, handler(request))

    async def awrap_tool_call(self, request: ToolCallRequest, handler: Any) -> Any:
        """异步路径：同上。"""
        return self._rebind(request, await handler(request))

    def _rebind(self, request: ToolCallRequest, result: Any) -> Any:
        """把 `Command.update` 里的临时键换成父图的工具调用 id。

        不是 task 调用就原样返回——别的工具（execute、write_file……）
        不产生 transcript。
        """
        if request.tool_call.get("name") != "task":
            return result
        if not isinstance(result, Command):
            return result

        update = result.update
        if not isinstance(update, dict):
            return result

        sessions = update.get(SUBAGENT_SESSIONS_STATE_KEY)
        if not isinstance(sessions, dict):
            return result

        pending = sessions.get(PENDING_KEY)
        if not isinstance(pending, dict):
            return result

        tool_call_id = request.tool_call.get("id") or ""
        if not tool_call_id:
            return result

        rebound = {k: v for k, v in sessions.items() if k != PENDING_KEY}
        rebound[tool_call_id] = {**pending, "tool_call_id": tool_call_id}

        return Command(
            update={**update, SUBAGENT_SESSIONS_STATE_KEY: rebound},
            goto=result.goto,
            resume=result.resume,
            graph=result.graph,
        )


def _task_description_of(messages: list[BaseMessage]) -> str:
    """从消息历史里取回委派任务描述（子 agent 收到的第一条人类消息）。"""
    for message in messages:
        if isinstance(message, HumanMessage):
            content = message.content
            if isinstance(content, str):
                return content
    return ""


def _serialize_message(message: BaseMessage) -> dict[str, Any]:
    """把一条 LangChain 消息转成能存进图状态、也能给前端看的普通 dict。

    **不能直接存消息对象**：状态要进 checkpoint（会被序列化），
    前端拿到的也是 JSON。转成 dict 后两边都能用。

    保留的字段：角色、正文、思考内容、工具调用、工具调用 id。
    """
    if isinstance(message, AIMessage):
        out: dict[str, Any] = {
            "role": "ai",
            "content": _content_of(message),
            "thinking": _thinking_of(message),
        }
        tool_calls = getattr(message, "tool_calls", None) or []
        if tool_calls:
            out["tool_calls"] = [
                {
                    "id": call.get("id", ""),
                    "name": call.get("name", ""),
                    "args": call.get("args", {}),
                }
                for call in tool_calls
            ]
        return out

    if isinstance(message, ToolMessage):
        return {
            "role": "tool",
            "content": _content_of(message),
            "tool_call_id": message.tool_call_id or "",
            "name": message.name or "",
        }

    if isinstance(message, HumanMessage):
        return {"role": "user", "content": _content_of(message)}

    return {"role": "other", "content": _content_of(message)}


def _content_of(message: BaseMessage) -> str:
    """取消息正文（多模态块数组拼成文本）。"""
    content = message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _thinking_of(message: AIMessage) -> str:
    """取思考内容。

    Anthropic 协议把思考放在 content 的 `thinking` 块里；
    langchain 的标准 content_blocks 叫 `reasoning` 块。两种都认。
    """
    content = message.content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "thinking" and isinstance(item.get("thinking"), str):
            parts.append(item["thinking"])
        elif item.get("type") == "reasoning" and isinstance(item.get("reasoning"), str):
            parts.append(item["reasoning"])
    return "".join(parts)
