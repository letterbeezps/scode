"""手动压缩对话历史：`/compaction` 命令 + 模型自压缩工具。

## 框架自带的两层

deepagents 的摘要中间件分两层，两者共用 `_summarization_event` 这个私有 state key：

- **SummarizationMiddleware**（自动层）：对话超阈值时自动把旧消息总结成一段摘要，
  原始消息写到 backend 的 `conversation_history/<session_id>.md`（agent 之后还能
  `read_file` 读回来），然后用摘要替换掉旧消息。
- **SummarizationToolMiddleware**（手动层）：注册一个 `compact_conversation` 工具，
  模型可以自己决定什么时候压缩。

本模块做三件事：

1. **摘要用「当前选中的模型」写**，不是建图时那个。
2. **`/compaction` 命令强制压缩一次**（不等阈值）。
3. 挂上 `compact_conversation` 工具，模型也能自己压缩。

## 一、摘要的模型：框架是建图时定死的

`langchain` 的 `SummarizationMiddleware.__init__` 里有一句
`self._summary_chat_model = self.model`——**摘要模型在构造那一刻就固定了**，
之后不管 `request.model` 换成谁，摘要都还是用建图时那个实例发出去的。

所以「切到新供应商之后，压缩历史还在烧旧供应商」是默认行为，不是 bug。
但那跟「这段对话用这个模型」的意图对不上：用户特意切过去，图省钱的，
压缩却偷偷按旧价结算。

框架留了公开的扩展点：`summarizer` 参数。传进去的 Runnable 会接管摘要调用
（收到的���是待总结的消息，摘要提示词要自己拼）。本模块用这个口子，
在**每次调用时**解析 `configurable.model`，拿到用户当前选中的模型再写摘要。

## 二、`/compaction` 怎么强制压缩

自动层判断「要不要压缩」的地方是 `_should_summarize()`。子类覆盖它：
**这一轮用户发的是 `/compaction` 就返回 True**，剩下的活全部交给框架原有 machinery
（切分 → 总结 → 落盘 → 生成 summary event）。

**只看最后一条用户消息**：`/compaction` 这条消息会留在对话里，如果只看「有没有
出现过」，下一轮又会误判一次，把历史反复压缩。

**顶掉自带的那份，不叠加**：deepagents 按中间件的 `.name` 合并——名字撞上已有
槽位就原地替换，不撞就多一份。所以本类把 `.name` 报成框架自带那一份的公开别名
（**从框架那里问出来的，不写死字面量**——框架升级改别名时这边跟着变），让它
原地替换掉 `create_deep_agent()` 塞进来的那一份。两份摘要中间件同时跑会重复
压缩、互相打架。

## 三、压缩了什么

框架的默认行为，被压缩的旧消息会**写到 backend 的文件里**
（`conversation_history/<session_id>.md`），摘要里带着那个路径，agent 之后可以
`read_file` 读回来。所以压缩不是「丢历史」，是「把历史挪进文件」。
"""

from __future__ import annotations

import logging
from typing import Any

from langchain_core.exceptions import ContextOverflowError
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AnyMessage, HumanMessage, get_buffer_string
from langchain_core.runnables import Runnable, RunnableConfig

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.summarization import (
    DEEPAGENTS_DEFAULT_SUMMARY_PROMPT,
    SummarizationMiddleware,
    SummarizationToolMiddleware,
    compute_summarization_defaults,
)

from stupid_code.graph.model_switch import resolve_selected_model

logger = logging.getLogger(__name__)

COMPACTION_COMMAND = "/compaction"
"""前端 `/` 菜单里的命令文本。与前端 web/src/lib/commands.ts 保持一致。"""


def _framework_summary_name() -> str:
    """问框架自带那一份「它自己的名字」——不写死字面量。

    框架把这个公开别名同时写在两处：`name` property 和 `serialized_name`
    这个 ClassVar（见 deepagents/middleware/summarization.py），两者当前一致。

    这里取 `serialized_name` 而不是 `name` property——**property 访问类属性
    拿到的是 property 对象本身，不是字符串**。直接 `return SummarizationMiddleware.name`
    会让合并键变成一个 property 对象，永远跟框架实例的名字不相等 →
    静默变成两份摘要中间件同时跑（重复压缩）。

    将来框架升级改了公开别名，这里跟着变，不用动我们的代码。
    """
    return SummarizationMiddleware.serialized_name


_FRAMEWORK_SUMMARY_NAME = _framework_summary_name()
"""框架自带那一份摘要中间件的 name。我们靠它原地替换掉那一份。"""


def _message_text(message: AnyMessage) -> str:
    """取消息的纯文本内容（内容可能是字符串，也可能是内容块列表）。"""
    content = message.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(content)


def is_compaction_request(messages: list[AnyMessage]) -> bool:
    """这一轮用户是不是在请求压缩历史。

    **只看最后一条用户消息**：命令消息会留在对话里（模型要看到它才知道发生了什么），
    如果判断成「出现过就行」，下一轮会再压一次，历史被反复压缩。
    """
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return _message_text(message).strip() == COMPACTION_COMMAND
    return False


class _RuntimeSummaryRunnable(Runnable[list[AnyMessage], str]):
    """用「当前选中的模型」写摘要的 Runnable。

    框架调摘要的方式有两种：同步路径 `summarizer.invoke(...)`、异步路径
    `summarizer.ainvoke(...)`。两种都得自己实现——用 `RunnableLambda` 包一个
    同步函数的话，异步路径会把它丢进线程池执行，而 `get_config()` 依赖
    contextvar，跨线程不一定拿得到 `configurable`，就静默退回默认模型了。

    自己实现 `invoke` / `ainvoke` 就没有这个问题：异步路径直接在当前任务里 await。
    """

    def __init__(self, model: BaseChatModel, summary_prompt: str) -> None:
        self._model = model
        self._summary_prompt = summary_prompt

    @property
    def model(self) -> BaseChatModel:
        """建图时带的模型（用户没选时用它）。"""
        return self._model

    def _render_prompt(self, messages: list[AnyMessage]) -> str:
        """按框架的格式把待总结的消息渲染成提示词。

        格式跟 langchain 的 `_format_summary_prompt` 一致：XML 化 + `{messages}` 占位。
        """
        formatted = get_buffer_string(messages, format="xml")
        return self._summary_prompt.format(messages=formatted).rstrip()

    def _resolve(self) -> BaseChatModel:
        """这一轮该用哪个模型写摘要——用户选中的那个。"""
        return resolve_selected_model(self._model)

    def invoke(
        self,
        input: list[AnyMessage],
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> str:
        """同步写摘要。"""
        model = self._resolve()
        try:
            return model.invoke(self._render_prompt(input)).text.strip()
        except ContextOverflowError:
            # 切到的模型上下文窗口比建图时那个小 → 摘要提示词超预算。
            # 只留较近的一半再试一次（完整历史已经落到 conversation_history 文件里）
            half = input[len(input) // 2 :]
            return model.invoke(self._render_prompt(half)).text.strip()

    async def ainvoke(
        self,
        input: list[AnyMessage],
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> str:
        """异步写摘要。"""
        model = self._resolve()
        try:
            response = await model.ainvoke(self._render_prompt(input))
            return response.text.strip()
        except ContextOverflowError:
            half = input[len(input) // 2 :]
            response = await model.ainvoke(self._render_prompt(half))
            return response.text.strip()


class CompactionMiddleware(SummarizationMiddleware):
    """deepagents 摘要中间件的子类：加「手动压缩」和「摘要用当前模型」。

    继承自带那一份的全部 machinery（切分、落盘、summary event、上下文超限兜底），
    只改两个点：

    - `.name` 报成框架自带那一份的公开别名——**顶掉** `create_deep_agent()`
      自带的那一份，而不是多出一份（别名的取法见 `_framework_summary_name`）
    - `_should_summarize()`：用户这轮发了 `/compaction` 就强制压缩
    """

    @property
    def name(self) -> str:
        """报成框架自带那一份的名字，让它被原地替换。

        deepagents 按中间件的 `.name` 合并：名字撞上已有槽位就原地替换，不撞
        就追加一份。框架对「正好是它自己」返回公开别名、对子类返回类名
        （不想让用户的子类悄悄继承那个别名），所以这里必须显式覆盖，不能靠继承。

        **故意与框架的意图相反**：我们要的就是那个别名，撞上才能替换掉
        `create_deep_agent()` 塞进来的那一份。不覆盖就会变成两份摘要中间件
        同时跑——重复压缩、互相打架。

        名字本身是从框架那里问出来的（见 `_framework_summary_name`），不是写死的
        字面量：框架升级改了公开别名，这里跟着变。
        """
        return _FRAMEWORK_SUMMARY_NAME

    def _should_summarize(self, messages: list[AnyMessage], total_tokens: int) -> bool:
        """要不要压缩。

        用户显式下过 `/compaction` → 强制压缩，不等阈值；
        否则按框架的阈值判断（对话超预算时自动压缩）。
        """
        if is_compaction_request(messages):
            return True
        return super()._should_summarize(messages, total_tokens)


def build_compaction_middleware(
    model: BaseChatModel,
    backend: BackendProtocol,
) -> CompactionMiddleware:
    """构造 CompactionMiddleware。

    触发阈值 / 保留条数跟框架自带的保持一致（`compute_summarization_defaults`
    按模型的上下文窗口算），否则换掉自带那份就等于改了压缩策略。
    """
    defaults = compute_summarization_defaults(model)
    return CompactionMiddleware(
        model=model,
        backend=backend,
        trigger=defaults["trigger"],
        keep=defaults["keep"],
        truncate_args_settings=defaults["truncate_args_settings"],
        # 与 create_summarization_middleware 一致：默认不额外裁剪待总结的消息
        trim_tokens_to_summarize=None,
        # 接管摘要调用：写摘要时用用户当前选中的模型，而不是建图时那个
        summarizer=_RuntimeSummaryRunnable(model, DEEPAGENTS_DEFAULT_SUMMARY_PROMPT),
    )


def build_compaction_tool_middleware(
    compaction: CompactionMiddleware,
) -> SummarizationToolMiddleware:
    """挂上 `compact_conversation` 工具——模型自己也能压缩。

    传的是同一个 compaction 实例：工具和自动层共用 `_summarization_event`，
    状态才对得上（框架的约定，见 `SummarizationToolMiddleware` 的文档）。

    `system_prompt=None`：不在系统提示词里加「记得调用压缩工具」的话术。
    工具本身在工具列表里，模型看得见；要不要提前压缩由它自己判断。
    """
    return SummarizationToolMiddleware(compaction, system_prompt=None)
