"""调试脚本：打印**实际发给大模型的完整 prompt**。

agent 的系统提示词不是 `config/prompts.py` 里那份裸文本——运行期会被一堆
中间件逐层追加（工作空间路径、技能库清单、长期记忆……）。想知道模型最后
到底看到什么，光读源码拼不出来，得在模型调用处截下来看。

## 原理：为什么用模型回调而不是 middleware 截获

试过在自定义 middleware 列表末尾挂一个 `wrap_model_call` 截获器——**截不到
最终形态**。原因在 deepagents 的装配规则（`deepagents/graph.py`）：

- middleware 列表里出现 `name == "SkillsMiddleware"` 的实例时，框架提取它的
  sources、在 **core 栈尾部**建一份 SkillsMiddleware，再让自定义那份原地
  顶替——所以本项目的技能中间件不在自定义区，而在**最内层**；
- 其余自定义 middleware 落在自定义区（外层）。挂在自定义区的截获器看到的
  是技能块注入**之前**的请求。

`on_chat_model_start` 回调在**真正的模型调用处**触发，拿到的就是最终形态
（系统提示词全文 + 消息历史）。这是唯一不依赖中间件位置的截获点。

（实测块序：`本体 >> Shell paths >> 工作空间 >> 长期记忆 >> 技能库`——
技能块在记忆块**后面**，与 agent.py 注释里「skill 块排在记忆前面」的
预期相反，是 deepagents 按 name 顶替 core 槽位导致的。）

## 跑起来

    # 默认：用假模型跑一轮（不调 API、不花钱、确定性输出）
    uv run python examples/dump_prompt.py

    # 指定工作空间（项目级 skill / 记忆从它解析）和勾选的 skill
    uv run python examples/dump_prompt.py \\
        --workspace /path/to/your/project \\
        --skills langchain-fundamentals,langgraph-fundamentals

    # --live：直接用生产图（graph/agent.py 的 graph）+ conf/config.toml 里的
    # 真模型跑（产生 API 调用），模型每被调一次打印一次——观察工具循环里
    # prompt 怎么变
    uv run python examples/dump_prompt.py --live "看看当前目录有什么文件"

两种模式的差异：--live 用的是 `agent.py` 里那张现成的图（零漂移）；默认
模式必须**本地重建**一张（已编译的图换不了模型），建图参数镜像
`graph/agent.py`——改了那边要同步这里。

HITL 说明：本脚本没挂 checkpointer，模型若触发需要人工确认的工具会直接
报错；调试工具循环里的 HITL 行为请走 `langgraph dev` + 前端。
"""

from __future__ import annotations

import argparse
import sys
from typing import Any

from deepagents import create_deep_agent
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.language_models.fake_chat_models import (
    FakeMessagesListChatModel,
)
from langchain_core.messages import AIMessage, BaseMessage

import stupid_code.graph.agent as A
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.compaction import build_compaction_tool_middleware
from stupid_code.graph.memory import build_memory_middleware
from stupid_code.graph.model_switch import (
    ChatModelSwitchMiddleware,
    apply_model_switch_policy,
)
from stupid_code.graph.permissions import PermissionLevelMiddleware
from stupid_code.graph.repeated_calls import RepeatedCallMiddleware
from stupid_code.graph.run_context import RunContext
from stupid_code.graph.skills import build_skills_middleware
from stupid_code.graph.subagent_policy import apply_subagent_policies
from stupid_code.graph.workspace import WorkspaceMiddleware


class FakeAgentModel(FakeMessagesListChatModel):
    """假模型：接受 bind_tools（只记下工具名，不真调 API），返回固定回复。

    不覆盖 `bind_tools` 的话，agent 框架绑工具时会抛 NotImplementedError——
    这也是「模型真正收到哪些工具」的观测点：这里记下的就是最终工具清单。
    """

    tool_names: list[str] = []  # 类变量：handler 和模型实例之间共享

    def bind_tools(self, tools: Any, **kwargs: Any) -> "FakeAgentModel":
        FakeAgentModel.tool_names = [
            t.name if hasattr(t, "name") else str(t.get("name", t))
            for t in tools or []
        ]
        return self


class DumpPromptHandler(BaseCallbackHandler):
    """在真正的模型调用处打印完整 prompt。"""

    def __init__(self, *, live: bool) -> None:
        super().__init__()
        self._live = live
        self._call_index = 0

    def on_chat_model_start(
        self, serialized: dict[str, Any], messages: Any, **kwargs: Any
    ) -> None:
        # messages 形如 [[SystemMessage, HumanMessage, ...]]——外层是 batch 维度
        prompt: list[BaseMessage] = (
            messages[0] if messages and isinstance(messages[0], list) else list(messages)
        )
        self._call_index += 1
        self._print(prompt, kwargs)

    # ---------------------------------------------------------------- 打印

    def _print(self, prompt: list[BaseMessage], kwargs: dict[str, Any]) -> None:
        bar = "=" * 78
        print(f"\n{bar}")
        print(f"模型调用 #{self._call_index}  （这就是实际发给模型的 prompt）")
        print(bar)

        system = next((m for m in prompt if type(m).__name__ == "SystemMessage"), None)
        others = [m for m in prompt if m is not system]

        if system is not None:
            print("\n[系统提示词 · 块序一览] " + "─" * 44)
            self._print_block_overview(system)
            print("\n[系统提示词 · 全文] " + "─" * 48)
            print(self._content_text(system))

        tool_names = self._tool_names(kwargs)
        if tool_names is not None:
            print(f"\n[工具清单 · 共 {len(tool_names)} 个] " + "─" * 34)
            print("  " + ", ".join(tool_names) if tool_names else "  (无)")

        print(f"\n[消息历史 · 共 {len(others)} 条，不含系统提示词] " + "─" * 21)
        for i, msg in enumerate(others):
            self._print_message(i, msg)
        print(f"\n{bar}\n")

    @staticmethod
    def _print_block_overview(system: BaseMessage) -> None:
        """系统提示词的内容块列表：每块的第一个标题行。看块序用这个。"""
        content = system.content
        blocks = content if isinstance(content, list) else [content]
        for i, block in enumerate(blocks):
            text = block.get("text", "") if isinstance(block, dict) else str(block)
            first = next((line for line in text.splitlines() if line.strip()), "")
            print(f"  块 {i}: {first.strip()[:60]}")

    @staticmethod
    def _content_text(msg: BaseMessage) -> str:
        content = msg.content
        if isinstance(content, str):
            return content
        return "\n".join(
            block.get("text", "") if isinstance(block, dict) else str(block)
            for block in content or []
        )

    @staticmethod
    def _tool_names(kwargs: dict[str, Any]) -> list[str] | None:
        """取本次调用的工具清单。

        dry 模式：FakeAgentModel.bind_tools 记下的名字。
        live 模式：从 invocation_params 里抠（拿不到就返回 None，跳过打印）。
        """
        if FakeAgentModel.tool_names:
            return FakeAgentModel.tool_names
        params = kwargs.get("invocation_params") or {}
        tools = params.get("tools") or []
        names = [
            t.get("name", "?") if isinstance(t, dict) else getattr(t, "name", "?")
            for t in tools
        ]
        return names or None

    def _print_message(self, i: int, msg: BaseMessage) -> None:
        """打一条消息。tool call / tool result 是嵌套结构，这里只做浅层展开。"""
        header = f"  #{i:<3d} {type(msg).__name__:<14s}"
        if isinstance(msg.content, str):
            body = msg.content
        else:
            parts = []
            for block in msg.content or []:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        parts.append(block.get("text", ""))
                    else:
                        parts.append(f"<{block.get('type', '?')}>")
                else:
                    parts.append(str(block))
            body = " ".join(parts)
        tool_calls = getattr(msg, "tool_calls", None)
        if tool_calls:
            calls = ", ".join(f"{tc['name']}({tc['args']})" for tc in tool_calls)
            body = f"{body}  → 调用工具: {calls}" if body else f"→ 调用工具: {calls}"
        print(f"{header} {body}")

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        """live 模式下顺带打印模型回了什么（截 300 字）。"""
        if not self._live:
            return
        try:
            ai_msg = response.generations[0][0].message
            tool_calls = getattr(ai_msg, "tool_calls", None) or []
            what = (
                f"调用工具: {', '.join(tc['name'] for tc in tool_calls)}"
                if tool_calls
                else str(ai_msg.content)[:300]
            )
        except Exception:  # noqa: BLE001 —— 打印失败不影响主流程
            what = f"(无法解析响应: {response!r})"
        print(f"  [模型响应] {what}")


def build_dry_graph() -> Any:
    """镜像 graph/agent.py 的建图参数重建一张图，模型换成假的。

    建图参数逐项对齐 agent.py（模型 / subagents / tools / backend /
    context_schema / interrupt_on / middleware 顺序），只换模型。
    """
    return create_deep_agent(
        model=FakeAgentModel(
            responses=[
                AIMessage(
                    content="（假模型响应——本模式只打印 prompt，"
                    "不真正调用大模型。加 --live 用真模型。）"
                )
            ]
        ),
        system_prompt=SYSTEM_PROMPT,
        subagents=[
            apply_model_switch_policy(
                apply_subagent_policies(spec, default_interrupt_on=A.interrupt_on)
            )
            for spec in load_subagents()
        ],
        tools=A.mcp_tools,
        backend=A.backend,
        context_schema=RunContext,
        middleware=[
            ChatModelSwitchMiddleware(),
            WorkspaceMiddleware(),
            PermissionLevelMiddleware(),
            A.compaction,
            build_compaction_tool_middleware(A.compaction),
            build_skills_middleware(A.backend),
            build_memory_middleware(),
            RepeatedCallMiddleware(),
        ],
        interrupt_on=A.interrupt_on,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="打印实际发给大模型的完整 prompt（调试用）"
    )
    parser.add_argument(
        "question",
        nargs="?",
        default="你好，介绍一下你当前的工作环境和可用的技能。",
        help="发给 agent 的用户消息（默认是一句能触发技能清单展示的话）",
    )
    parser.add_argument(
        "--workspace",
        default="",
        help="工作空间绝对路径（默认走 SCODE_WORKSPACE 或当前目录）",
    )
    parser.add_argument(
        "--skills",
        default="",
        help="勾选的 skill 名字，逗号分隔（会以 pinned 形式全文进上下文）",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="用 conf/config.toml 里的真模型 + 生产图跑（产生 API 调用；"
        "每次模型调用都会打印一份完整 prompt）",
    )
    args = parser.parse_args()

    context: dict[str, Any] = {}
    if args.workspace:
        context["workspace"] = args.workspace
    if args.skills:
        context["skills"] = [s.strip() for s in args.skills.split(",") if s.strip()]

    handler = DumpPromptHandler(live=args.live)
    graph = A.graph if args.live else build_dry_graph()

    print(
        f"模式: {'live（真模型 + 生产图）' if args.live else 'dry（假模型，不调 API）'}\n"
        f"问题: {args.question}\n"
        f"context: {context or '(默认：走后端默认工作空间、不勾选 skill)'}",
        file=sys.stderr,
    )

    try:
        # 注意：直接调用图时 context 是 invoke 的独立关键字参数（不是 config
        # 里的 key——塞在 config dict 里会被静默丢掉，runtime.context 拿到 None）
        result = graph.invoke(
            {"messages": [{"role": "user", "content": args.question}]},
            {
                "configurable": {"thread_id": "dump-prompt-debug"},
                "callbacks": [handler],
            },
            context=context or None,
        )
    except Exception as exc:  # noqa: BLE001 —— 调试脚本，把错误原样端出来
        print(f"\n[run 失败] {type(exc).__name__}: {exc}", file=sys.stderr)
        print(
            "提示：模型触发了需要人工确认的工具时，本脚本因为没有 "
            "checkpointer 会直接报错——那种场景请走 langgraph dev + 前端。",
            file=sys.stderr,
        )
        sys.exit(1)

    last = result["messages"][-1]
    print("\n[最终回复]", file=sys.stderr)
    print(
        last.content if isinstance(last.content, str) else str(last.content),
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
