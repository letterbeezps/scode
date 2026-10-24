"""运行期切换对话模型：不重启后端也能换供应商。

## 为什么是中间件，而不是重建一张图

deepagents 在 `create_deep_agent()` 时把模型实例交给了 `create_agent()`，
之后每次模型调用都用同一个实例发起。框架在每次调用前组装一个 `ModelRequest`，
其中 `request.model` 就是「这次该用哪个模型」——中间件的 `wrap_model_call` /
`awrap_model_call` 拿到它，可以 `request.override(model=...)` 换掉。

换了是真的换了：框架最终是拿 `request.model.bind_tools(...)` 去发请求的
（见 langchain/agents/factory.py 的 `_get_bound_model`），不是拿建图时那个实例。

## 模型从哪来

前端在每次运行的 `configurable["model"]` 里带上选中的模型 id
（`供应商名:模型名`，与 conf/config.toml 的写法一致）。中间件按这个 id 去
conf/config.toml 查 base_url / api_key / protocol，现场建一个模型实例。

**每次调用都重新读配置**，所以新增模型、改 base_url、改 api_key 都不用重启
后端——这是本功能跟「后端启动时固定一个 default model」最大的区别。

## 取不到就退回默认模型

选了一个不存在的模型（刚被删掉、id 写错、供应商段缺字段）时，不能让整个
对话挂掉：记一条 warning，继续用后端启动时带的默认模型。

**这个失败在界面上看不出来**——前端只管把 id 发过去，不知道后端退回了默认模型。
唯一能看到的是后端日志里的那条 warning。真要确认切没切成功，看消息里的
`response_metadata.model_name`（见 docs/backend/PROGRESS.md 的验证步骤）。

模型**调用**阶段的失败（401、限流、上下文超长）不在这里兜底：那是真实错误，
直接抛给用户看。

## 作用域：只切主 agent，子 agent 不跟着切

**这个中间件只挂在主 agent 上。子 agent 保持各自原有的模型。**

- `conf/subagents.toml` 里声明了 model 的子 agent：一律用它自己写的那个
- deepagents 自动加的 `general-purpose`：用建图时继承来的那个（即启动时的默认模型）

**为什么不跟着切**：子 agent 用哪个模型是**配置**出来的——本项目的 `reviewer` /
`summarizer` 刻意用便宜的 `MiniMax-M3.1-Flash`，主 agent 用 `MiniMax-M3`，
「主对话用强模型、委派出去用便宜模型」是这个结构的一部分。用户在下拉框里选一个
模型，意图是「**这段对话**用这个模型」，不是「我买的这个模型套餐随便怎么烧都行」。
让子 agent 跟着切，等于把委派出去的活偷偷挪到新选（可能很贵）的模型上，
把配置好的成本结构打乱。

真要改某个子 agent 用哪个模型，去 `conf/subagents.toml` 写死它——那才是
「显式配置」该待的地方。

（框架层面其实做得到：子 agent 的中间件也能拿到父图的 `configurable`。
这里选择不用。）

## 已知边界

这几条是「不重启后端换模型」的固有代价，不是实现偷懒：

1. **harness profile 跟着启动时的模型走**。deepagents 按模型决定系统提示词
   的附加内容、工具描述改写、排除哪些工具，这些在建图时定死。切到另一个
   供应商后这套 profile 不会跟着换。
2. **历史压缩（summarization）的阈值也按启动时的模型算**。切到上下文窗口
   更小的模型时，压缩可能触发得偏晚，出现超长上下文错误。
3. **摘要用的模型跟着切换走**（011 期改的）。框架默认把摘要模型在构造时定死
   （`self._summary_chat_model = self.model`），切了之后压缩还在烧旧供应商；
   `graph/compaction.py` 用 `summarizer=` 接管了摘要调用，改成每次调用时解析
   当前选中的模型。但**阈值判断仍按启动时的模型算**——那条属于第 2 点。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.language_models import BaseChatModel
from langgraph.config import get_config

from stupid_code.config.model import build_model_by_spec, load_config

logger = logging.getLogger(__name__)

MODEL_KEY = "model"
"""`configurable` 里的 key，与前端 web/src/lib/model.ts 的 MODEL_KEY 一致。"""


def selected_model_spec() -> str | None:
    """取当前运行里用户选中的模型 id（`供应商名:模型名`）。

    没选、取值不是字符串、或者不在 runnable 上下文里，都返回 None
    （None 的意思是「不切换，按后端默认模型来」）。
    """
    try:
        config = get_config()
    except RuntimeError:
        # 不在 runnable 上下文里（本地直接调中间件、或框架换了实现），
        # 取不到就当用户没选
        return None

    configurable = config.get("configurable")
    if not isinstance(configurable, dict):
        return None
    spec = configurable.get(MODEL_KEY)
    if isinstance(spec, str) and spec.strip():
        return spec.strip()
    return None


def resolve_selected_model(default_model: BaseChatModel) -> BaseChatModel:
    """当前运行该用哪个模型：用户选中的那个，取不到就退回 default_model。

    与 `ChatModelSwitchMiddleware` 共用同一套解析逻辑——**摘要也算一次模型
    调用**，走这里才能保证压缩历史时用的也是用户选中的供应商
    （见 graph/compaction.py）。
    """
    spec = selected_model_spec()
    if not spec:
        return default_model
    try:
        config = load_config()
        return build_model_by_spec(config, spec)
    except Exception as exc:  # noqa: BLE001 — 取不到不该弄死整轮对话
        logger.warning("切换到模型 %r 失败，改用默认模型：%s", spec, exc)
        return default_model


class ChatModelSwitchMiddleware(AgentMiddleware[Any, Any, Any]):
    """把 `request.model` 换成用户在界面上选中的那个模型。

    同时实现同步与异步两个钩子：langgraph dev 走异步（astream），
    但本地脚本 / 测试可能同步调用，两个都得实现，否则框架会抛
    NotImplementedError（只实现一个时）。
    """

    def __init__(self, default_model: BaseChatModel) -> None:
        """default_model 是后端启动时带的那个模型，选中项取不到时退回它。"""
        super().__init__()
        self._default_model = default_model

    @property
    def default_model(self) -> BaseChatModel:
        """启动时的默认模型（取不到选中项时的退路）。"""
        return self._default_model

    def wrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], ModelResponse[Any]],
    ) -> ModelResponse[Any]:
        """同步路径：换掉 request.model 再交给 handler。"""
        model = self._resolve_model()
        if model is None:
            return handler(request)
        return handler(request.override(model=model))

    async def awrap_model_call(
        self,
        request: ModelRequest[Any],
        handler: Callable[[ModelRequest[Any]], Awaitable[ModelResponse[Any]]],
    ) -> ModelResponse[Any]:
        """异步路径：换掉 request.model 再交给 handler。"""
        model = self._resolve_model()
        if model is None:
            return await handler(request)
        return await handler(request.override(model=model))

    def _resolve_model(self) -> BaseChatModel | None:
        """按 selectable 的模型 id 建一个模型实例。

        返回 None 表示「不切换」：没选模型、或者选了但建不出来
        （这时已经记过 warning）。
        """
        spec = selected_model_spec()
        if not spec:
            return None
        try:
            config = load_config()
            return build_model_by_spec(config, spec)
        except Exception as exc:  # noqa: BLE001 — 切换失败不该弄死整轮对话
            logger.warning("切换到模型 %r 失败，改用默认模型：%s", spec, exc)
            return None