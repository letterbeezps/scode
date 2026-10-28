"""拦同一个 tool 用同一组参数反复失败。

连续同签名 `status="error"` 到阈值（默认 3）就不再执行，返回错误消息让模型
换思路。签名 = tool 名 + 参数排序后的 JSON；中间夹了别的调用或成功就清零。
HITL 拒绝和本中间件自己的拦截消息不计入。

判定扫消息历史，不写图状态。`execute` 的非零退出码是 `status="success"`，
不会被拦；它拦的是工具本身用不了（路径不存在、edit_file 对不上等）。

细节和边界见 `docs/backend/backend.md` §3.16。
"""

from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain.tools.tool_node import ToolCallRequest
from langchain_core.messages import AIMessage, ToolMessage

DEFAULT_THRESHOLD = 3
"""连续失败几次就拦。

允许模型试 2 次——参数写错一两次很正常，第 3 次还没成功就基本可以断定它在
原地转圈了。
"""

HITL_REJECT_MARKER = "User rejected the tool call for"
"""HITL 拒绝消息的 content 前缀。

用户拒绝也产生 `status="error"` 的 ToolMessage，但那不是模型重试失败——是用户
的决策。按前缀排除，否则用户拒绝两次就会把 agent 的正常后续调用给挡了。
"""

BLOCKED_MARKER = "（已拦截：重复的失败调用）"
"""本中间件自己发的拦截消息的 content 标记。

**必须放在消息开头**：判定时靠 content 的**前缀**认出这条是本中间件发的。

拦截消息也是 `status="error"`，所以它会出现在下一次判定的历史里——如果不排除，
拦截消息自己会把自己算成一次失败，计数越滚越大（实测：拦一次之后每次都拦，
而且提示里的次数会一直涨）。

排除它，计数就只反映**工具真的失败**的次数。
"""


def call_signature(tool_name: str, args: dict[str, Any]) -> str:
    """算一个调用的签名。

    `sort_keys=True` 是关键：参数顺序不同但内容相同的调用，必须是同一个签名，
    否则模型把 `{"a":1,"b":2}` 改成 `{"b":2,"a":1}` 就能绕过去。

    `default=str` 兜底非 JSON 可序列化的参数值（少见，但不能因此崩）。
    """
    try:
        payload = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):  # pragma: no cover —— default=str 之后基本不会走到
        payload = repr(sorted(args.items()))
    return f"{tool_name}\x00{payload}"


def _tool_args_by_call_id(messages: list[Any]) -> dict[str, dict[str, Any]]:
    """从消息历史里抽出「tool_call_id → 参数」。

    `ToolMessage` 自己不带参数（只有 `tool_call_id`），参数在对应的
    `AIMessage.tool_calls` 里。所以先扫一遍 AI 消息建索引。

    查不到就返回空——那次的失败不参与计数（宁可漏判，不可误判）。
    """
    index: dict[str, dict[str, Any]] = {}
    for message in messages:
        if isinstance(message, AIMessage):
            for call in message.tool_calls:
                call_id = call.get("id")
                args = call.get("args")
                if call_id and isinstance(args, dict):
                    index[call_id] = args
    return index


def _is_hitl_rejection(message: ToolMessage) -> bool:
    """这条 error 消息是用户手动拒绝的（不是模型重试失败）。"""
    return _content_starts_with(message, HITL_REJECT_MARKER)


def _is_our_own_block(message: ToolMessage) -> bool:
    """这条 error 消息是本中间件上次发的拦截消息（不是工具真的失败）。"""
    return _content_starts_with(message, BLOCKED_MARKER)


def _content_starts_with(message: ToolMessage, marker: str) -> bool:
    """消息内容是否以 marker 开头。

    content 可能是 str，也可能是多模态内容块列表——两种都要认。
    """
    content = message.content
    if isinstance(content, str):
        return content.startswith(marker)
    if isinstance(content, list):
        for block in content:
            if isinstance(block, str) and block.startswith(marker):
                return True
            if isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str) and text.startswith(marker):
                    return True
    return False


def consecutive_failures(messages: list[Any], signature: str) -> int:
    """历史上「紧邻的」同签名失败次数。

    从消息尾巴往前数：连续的同签名 `status="error"` 就算，中间隔了别的调用
    （或者遇到一次成功）就停——那说明模型已经换过思路了，重新开始数。

    两种 error 消息不计入：

    - HITL 拒绝（用户决策，见 `HITL_REJECT_MARKER`）——当「不连续」处理
    - 本中间件自己发的拦截消息（见 `BLOCKED_MARKER`）——跳过，不计数也不断连续性

    **只数连续**：这是本模块最关键的一条。模型失败之后换个参数再试是正常行为，
    不能因为「它最近失败过」就把它拦下来。
    """
    if not messages:
        return 0

    args_index = _tool_args_by_call_id(messages)

    failures = 0
    for message in reversed(messages):
        if not isinstance(message, ToolMessage):
            # AI 消息不算失败——同一批里的多个 tool call 是并行的，不是重试
            continue
        if message.status != "error":
            # 成功过：中间的同签名失败不算「连续」
            break
        if _is_our_own_block(message):
            # 本中间件上次发的拦截消息：跳过（不计数，也不断连续性）。
            # 它自己会滚雪球——算进去的话，拦一次之后每次都拦，提示里的次数
            # 还会一直涨。跳过后计数只反映工具真的失败的次数。
            continue
        if _is_hitl_rejection(message):
            # 用户拒绝不是模型重试失败——当「不连续」处理
            break
        args = args_index.get(message.tool_call_id)
        if args is None:
            # 找不到对应参数（消息被压缩过、或 AI 消息不在历史里）——判不了，
            # 当作不连续，宁可漏判不可误判
            break
        message_signature = call_signature(message.name or "", args)
        if message_signature != signature:
            # 换了个调用——不连续
            break
        failures += 1
    return failures


def _messages_of(state: Any) -> list[Any]:
    """从图状态里取消息列表。

    state 可能是 dict、TypedDict 实例或 pydantic 模型——都兼容一下。
    """
    if isinstance(state, dict):
        messages = state.get("messages")
    else:
        messages = getattr(state, "messages", None)
    return list(messages) if isinstance(messages, list) else []


class RepeatedCallMiddleware(AgentMiddleware[Any, Any, Any]):
    """同一个 tool 用同一组参数反复失败时，不再执行。

    拦下时返回一条 `status="error"` 的 ToolMessage，内容明确告诉模型
    「这个调用你已经试过 N 次了，别再用同样的参数重试，换个思路或者告诉用户
    你卡在哪」。

    **为什么返回消息而不是抛异常**：抛异常会中断整轮运行——但模型可能只需要
    换个参数就能过。返回一条错误消息让它自己调整，是更温和的做法。

    **为什么拦得住**：deepagents 是 "trust the LLM" 模型，agent 不会自我约束。
    边界必须在工具层强制执行（跟 `permissions.py` 同一个立场）。
    """

    def __init__(self, threshold: int = DEFAULT_THRESHOLD) -> None:
        """构造。

        `threshold` 是连续失败几次就拦。必须 ≥ 2（拦掉第一次失败没有意义——
        第一次失败正是模型该得到反馈的时候）。
        """
        if threshold < 2:
            raise ValueError(f"threshold 必须 ≥ 2，收到 {threshold}")
        self.threshold = threshold

    def wrap_tool_call(self, request: ToolCallRequest, handler: Any) -> Any:
        """同步路径。"""
        blocked = self._blocked_message_or_none(request)
        return blocked if blocked is not None else handler(request)

    async def awrap_tool_call(self, request: ToolCallRequest, handler: Any) -> Any:
        """异步路径：同上（项目走的就是这条路）。"""
        blocked = self._blocked_message_or_none(request)
        return blocked if blocked is not None else await handler(request)

    def _blocked_message_or_none(self, request: ToolCallRequest) -> ToolMessage | None:
        """这次调用是否已经达到「连续同样失败」的阈值。"""
        tool_call = request.tool_call
        signature = call_signature(tool_call["name"], tool_call.get("args") or {})
        failures = consecutive_failures(_messages_of(request.state), signature)
        if failures < self.threshold - 1:
            # 还没到阈值：正常执行，失败的话下一轮就会数上
            return None
        return self._blocked_message(tool_call, failures + 1)

    def _blocked_message(self, tool_call: dict[str, Any], attempts: int) -> ToolMessage:
        """构造「拦下来了」的那条错误消息。

        **标记必须在开头**（`BLOCKED_MARKER`）：判定时靠 content 的**前缀**认出
        这条是本中间件自己发的，放后面就认不出来，拦截消息会把自己算成一次失败。
        """
        name = tool_call["name"]
        return ToolMessage(
            content=(
                f"{BLOCKED_MARKER}：`{name}` 用完全相同的参数已经连续失败 {attempts} 次了。\n"
                f"不要再用同样的参数重试——先看前几次的错误消息里的具体原因，"
                f"分析清楚为什么失败：要么换个参数、要么换个做法，"
                f"要么直接告诉用户你卡在哪里、需要什么。"
            ),
            name=name,
            tool_call_id=tool_call["id"],
            status="error",
        )
