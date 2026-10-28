"""运行期切换对话模型：不重启后端也能换供应商。

前端每次运行在 `context.model` 里送 `供应商名:模型名`；中间件在每次模型
调用前重新读 `conf/config.toml`，用 `request.override(model=...)` 换掉
`request.model`。框架最终拿 `request.model.bind_tools(...)` 发请求，所以换的是
真的。取不到就记 warning、退回启动时的默认模型；模型调用本身的错误不兜底。

作用域：主 agent。`isolated` / `general-purpose` 子 agent 用各自配置的模型；
`mode="fork"` 会继承父级 middleware，由 `apply_model_switch_policy()` 用同名
`enabled=False` 实例顶掉切换中间件。

摘要模型也跟着切（`graph/compaction.py` 的 `summarizer=`），但 harness profile
和压缩阈值仍按启动模型算。完整机制与已知边界见 `docs/backend/PROGRESS.md`
010 期、AGENTS.md 第 13 条。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.language_models import BaseChatModel
from langgraph.config import get_config

from stupid_code.config.model import build_model_by_spec, load_config
from stupid_code.graph.run_context import run_context_of
from stupid_code.graph.workspace import configurable_of

logger = logging.getLogger(__name__)

MODEL_KEY = "model"
"""`configurable` 里的 key；摘要路径拿不到 Runtime 时仍从这里读镜像值。"""


def selected_model_spec() -> str | None:
    """取当前运行里用户选中的模型 id（`供应商名:模型名`）。

    只给**摘要**用：`CompactionMiddleware` 的 summarizer 拿不到 Runtime，
    所以退回 `configurable`——Agent Server 会把 run 的 `context` 镜像进去。
    中间件本身直接读 `request.runtime.context.model`，走 `_select_model()`。
    """
    try:
        configurable = configurable_of(get_config())
    except RuntimeError:
        # 不在 runnable 上下文里（本地直接调中间件、或框架换了实现），
        # 取不到就当用户没选
        return None
    if not configurable:
        return None
    spec = configurable.get(MODEL_KEY)
    if isinstance(spec, str) and spec.strip():
        return spec.strip()
    return None


def _select_model(spec: str | None) -> BaseChatModel | None:
    """按模型 id 建模型；没选或建不出来返回 None。

    这是中间件与摘要共用的唯一解析入口。返回 None 的两种情况调用方处理不同：
    中间件据此决定「不覆盖 request.model」，摘要则退回默认模型。
    """
    spec = spec.strip() if isinstance(spec, str) else ""
    if not spec:
        return None
    try:
        config = load_config()
        return build_model_by_spec(config, spec)
    except Exception as exc:  # noqa: BLE001 — 取不到不该弄死整轮对话
        logger.warning("切换到模型 %r 失败，改用默认模型：%s", spec, exc)
        return None


def resolve_selected_model(default_model: BaseChatModel) -> BaseChatModel:
    """当前运行该用哪个模型：用户选中的那个，取不到就退回 default_model。

    与 `ChatModelSwitchMiddleware` 共用 `_select_model()`——**摘要也算
    一次模型调用**，走这里才能保证压缩历史时用的也是用户选中的供应商
    （见 graph/compaction.py）。
    """
    model = _select_model(selected_model_spec())
    return default_model if model is None else model


class ChatModelSwitchMiddleware(AgentMiddleware[Any, Any, Any]):
    """把 `request.model` 换成用户在界面上选中的那个模型。

    同时实现同步与异步两个钩子：langgraph dev 走异步（astream），
    但本地脚本 / 测试可能同步调用，两个都得实现，否则框架会抛
    NotImplementedError（只实现一个时）。
    """

    def __init__(self, *, enabled: bool = True) -> None:
        """`enabled=False` 用于 fork 子 agent。

        fork 会继承父级整份 middleware，需要在子 agent 规格里放一个**同名**的
        禁用实例去顶掉继承来的那个（见 `apply_model_switch_policy()`）。
        """
        super().__init__()
        self._enabled = enabled

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        """同步路径：换掉 request.model 再交给 handler。"""
        return handler(self._request_with_selected_model(request))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        """异步路径：换掉 request.model 再交给 handler。"""
        return await handler(self._request_with_selected_model(request))

    def _request_with_selected_model(self, request: ModelRequest[Any]) -> ModelRequest[Any]:
        """选中了可用模型就替换 request.model，否则原样返回。"""
        model = self._model_for_request(request.runtime)
        return request if model is None else request.override(model=model)

    def _model_for_request(self, runtime: Any) -> BaseChatModel | None:
        """这次模型调用该不该换模型。

        返回 None 表示「不切换」：禁用实例（fork 子 agent）、没选模型、或者选了
        但建不出来（这时已经记过 warning）。不切换时就继续用 `request.model`
        ——也就是启动时带的默认模型。
        """
        if not self._enabled:
            return None
        return _select_model(run_context_of(runtime).model)


def apply_model_switch_policy(spec: dict[str, Any]) -> dict[str, Any]:
    """给子 agent 规格补上「该不该跟着切模型」的策略。

    `mode="fork"` 的子 agent 会继承父 agent 的**全部 middleware**
    （deepagents `graph.py` 里 `if is_forked and middleware: ...`），
    其中就包括 `ChatModelSwitchMiddleware`。不处理的话，fork 子 agent 自己
    `conf/subagents.toml` 里配的模型会被父对话选中的模型覆盖。

    处理方式是往规格的 `middleware` 里放一个 `.name` 相同、但
    `enabled=False` 的实例：deepagents 按 `.name` 合并自定义中间件，
    同名项原地替换，父级继承来的那个就被顶掉了。`isolated` 子 agent
    不继承父级 middleware，原样返回即可。

    **新增任何 fork 入口时都要调用这个函数**，别只依赖 agent.py 当前这一处。
    """
    if spec.get("mode") != "fork":
        return spec

    middleware = list(spec.get("middleware", []))
    return {
        **spec,
        "middleware": [
            *middleware,
            # 放在最后：万一规格里已经有同名实例，dict 合并时后写入的值生效
            ChatModelSwitchMiddleware(enabled=False),
        ],
    }
