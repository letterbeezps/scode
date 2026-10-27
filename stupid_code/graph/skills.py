"""skill 发现与注入：全局 `$SCODE_HOME/.agents/skills/` + 项目级
`<工作空间>/.agents/skills/`。

项目级源用虚拟路径 `/.agents/skills/`，跟着运行期工作空间走；用户勾选的
skill 由 `configurable.skills` 送来，正文钉进上下文。换工作空间或换勾选时
摘掉 `skills_metadata` 强制重读。

细节见 `docs/backend/PROGRESS.md` 018 期、AGENTS.md 第 20 条。
"""

from __future__ import annotations

from typing import Annotated, Any, NotRequired

from deepagents.middleware.skills import SkillsMiddleware, SkillsState
from langchain.agents.middleware.types import PrivateStateAttr
from langchain_core.runnables import RunnableConfig

from stupid_code.graph.paths import GLOBAL_SKILLS_ROUTE
from stupid_code.graph.workspace import configurable_of, workspace_of

SKILLS_KEY = "skills"
"""`configurable` 里的 key：本次对话勾选的 skill 名字列表。

跟 `web/src/store/taskStore.ts` 的 `TaskSettings.skills` 对应。
"""

GLOBAL_SKILLS_LABEL = "全局"
PROJECT_SKILLS_LABEL = "项目"

PROJECT_SKILLS_SOURCE = "/.agents/skills/"
"""项目级 skill 的虚拟路径。

相对工作空间根解析——工作空间是运行期参数，所以这个源**不是静态的**，
它每一轮指向的真实目录都由主 backend 的运行期根目录决定。

跟 langchain-skills 的约定一致：`<工作空间>/.agents/skills/<名字>/SKILL.md`。
"""

GLOBAL_SKILL_SOURCES: tuple[tuple[str, str], ...] = (
    (GLOBAL_SKILLS_ROUTE, GLOBAL_SKILLS_LABEL),
)
"""全局 skill 源 —— **静态**。

它不依赖工作空间，所以可以写死成一个常量：全局 skill 是「这台机器上的
所有 agent 共用的」，项目级才是「这个项目的」。
"""

_FRAMEWORK_SKILLS_NAME = SkillsMiddleware.__name__
"""框架自带那一份 skill 中间件的 name。我们靠它原地替换掉那一份。

从框架那里问出来的（类名），不是写死的字面量——框架改了公开别名，这里
跟着变。

**为什么必须顶掉而不是多挂一份**：deepagents 按中间件的 `.name` 合并——
名字撞上已有槽位就原地替换，不撞就多一份。两份 skill 中间件同时跑，会往
系统提示词里塞**两块** skill 列表，模型看到重复的条目。
"""


def skill_sources() -> tuple[tuple[str, str], ...]:
    """本轮要读的 skill 源。

    - **全局**：静态常量，不依赖工作空间
    - **项目级**：虚拟路径，由主 backend 的运行期根目录解析

    顺序有意义：框架按源的顺序读，**同名时后面的覆盖前面的**（见框架
    `before_agent` 里的 `all_skills[skill["name"]] = skill`）。项目级在后 →
    项目级覆盖全局——项目级更具体，理应优先。
    """
    return (*GLOBAL_SKILL_SOURCES, (PROJECT_SKILLS_SOURCE, PROJECT_SKILLS_LABEL))


def selected_skills(config: RunnableConfig | None) -> list[str]:
    """本次对话勾选了哪些 skill（`configurable["skills"]`）。

    去重、去掉空串、保持前端给的顺序。名字对不上已加载的 skill 时，框架
    的 pin 逻辑会跳过它（不报错）。
    """
    configurable = configurable_of(config)
    raw = configurable.get(SKILLS_KEY) if configurable else None
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str) and item.strip() and item not in out:
            out.append(item)
    return out


def _is_missing_source(error: str) -> bool:
    """这个加载错误是不是「目录不存在」？

    目录不存在**不是错误**——大部分工作空间压根没有 `.agents/`。框架会把它
    记成一条 load error，然后塞进系统提示词的 `<skill_load_warnings>` 段——
    那个段是给模型看的「不可信的诊断信息」，一个「目录不存在」的警告挂在
    每轮提示词里纯属噪音，还会占 token。

    框架的 error 文本形如：
    `Cannot load skills from '/.agents/skills/': Path '/.agents/skills/': path_not_found`
    """
    return "path_not_found" in error


_SKILLS_TEMPLATE = """## 技能库

你可以用**技能**（skill）——每个技能是一份 `SKILL.md`，里面是某个领域的专门流程、
最佳实践和例子。

{skills_locations}{skills_load_warnings}
**可用的技能：**

{skills_list}

**怎么用（渐进式披露）**

技能是**按需加载**的：上面只列了名字和说明，完整指令要你自己读。

1. **认出该不该用**：看用户的任务跟哪个技能的说明对得上
2. **读完整指令**：`read_file` 上面列出的路径，**带上 `limit=1000`**（默认 100 行
   太小，多数技能文件都超）
3. **照着做**：`SKILL.md` 里有分步流程、最佳实践和例子
4. **用配套文件**：技能目录里可能还有脚本、配置、参考文档

**已经被钉进来的技能**：用户勾选过的技能，它的完整内容已经作为对话的一部分给
你了——直接照着做，不用再 `read_file` 读一遍。

**什么时候用技能**

- 用户的请求落在某个技能的领域里
- 你需要某个领域的专门知识或固定流程
- 技能里给了验证过的做法，比你现编的靠谱

**执行技能里的脚本**

技能里可能有 Python 脚本或别的可执行文件。**用上面列表里给的路径**，别自己拼。
"""
"""技能块模板。替换框架自带的英文 `SKILLS_SYSTEM_PROMPT`。

框架那份提到了 "Sources labeled 'Deepagents' / 'Agents'"——那是 deepagents 自己
的标签约定，本项目用的是「全局 / 项目」，对不上。而且它是英文的，跟项目的中文
系统提示词不一致。

**模板里三个槽位一个都不能少**（`{skills_locations}` / `{skills_load_warnings}` /
`{skills_list}`）——框架用 `str.format()` 填，少一个就 KeyError。
"""


class WorkspaceSkillsState(SkillsState):
    """在框架的 SkillsState 上记两个东西。"""

    scode_skill_workspace: NotRequired[Annotated[str, PrivateStateAttr]]
    """上次读 skill 时的工作空间。变了就重读。"""

    scode_pinned_skills: NotRequired[Annotated[list[str], PrivateStateAttr]]
    """上次钉进上下文的 skill 名字。变了才重新钉——不然每轮都追加一份
    同样的全文，几轮下来上下文就爆了。"""


class WorkspaceSkillsMiddleware(SkillsMiddleware):
    """按运行期工作空间发现 skill，并把用户勾选的钉进上下文。

    框架那份的三件事在这里被改掉了：

    1. **项目级 skill 不是静态的**：框架的 `self.sources` 是建图时定死的，
       这里每轮现算——项目级源指向当前工作空间（`skill_sources()`）。
    2. **换工作空间会重读**：框架一个 thread 只读一次，摘掉
       `skills_metadata` 逼它重来（跟记忆中间件同一套路）。
    3. **用户勾选的会钉进上下文**：写进 `pinned_skills`，框架的
       `before_model` 会把 `SKILL.md` 全文作为一条消息追加进对话历史。
    """

    state_schema = WorkspaceSkillsState

    def __init__(self, *, backend: Any, **kwargs: Any) -> None:
        """构造。

        `sources` 传**两个**源：全局（静态）和项目级（虚拟路径，指向运行期
        工作空间）。这两个源字符串是恒定的——**「项目级」跟着工作空间走，靠的
        不是源字符串，而是主 backend 那个运行期根目录**（`_WorkspaceCwdMixin.cwd`
        是个 property）。所以同一个中间件实例能服务不同项目的对话。

        `system_prompt` 换成本项目自己的中文模板（框架那份提到的标签跟我们对
        不上，而且它是英文的）。
        """
        super().__init__(
            backend=backend,
            sources=skill_sources(),
            system_prompt=_SKILLS_TEMPLATE,
            **kwargs,
        )

    @property
    def name(self) -> str:
        """报成框架自带那一份的公开别名。

        deepagents 按 `.name` 合并：撞名原地替换，不撞就多挂一份。名字是从
        框架那里问出来的（`_FRAMEWORK_SKILLS_NAME`），不是写死的字面量。
        """
        return _FRAMEWORK_SKILLS_NAME

    # ---------------------------------------------------------------- 读

    def before_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """同步路径：读 skill（换工作空间或换选择就重读），并钉住勾选的。"""
        prepared, workspace, selected = self._prepare_before(state, config)
        update = super().before_agent(prepared, runtime, config)
        return self._finish(update, workspace, selected)

    async def abefore_agent(
        self,
        state: Any,
        runtime: Any,
        config: RunnableConfig,
    ) -> dict[str, Any] | None:
        """异步路径：同上；框架自己的目录扫描走 backend 的异步接口。"""
        prepared, workspace, selected = self._prepare_before(state, config)
        update = await super().abefore_agent(prepared, runtime, config)
        return self._finish(update, workspace, selected)

    def _prepare_before(
        self,
        state: Any,
        config: RunnableConfig,
    ) -> tuple[Any, str, list[str]]:
        """算出本轮工作空间和勾选，并在需要时摘掉旧 skill 列表。"""
        workspace = str(workspace_of(config))
        selected = selected_skills(config)
        return self._state_for_reload(state, workspace, selected), workspace, selected

    # ---------------------------------------------------------------- 内部

    @staticmethod
    def _state_for_reload(state: Any, workspace: str, selected: list[str]) -> Any:
        """该重读的时候，把 `skills_metadata` 摘掉。

        框架的跳过条件是「state 里已经有 `skills_metadata`」——摘掉 key 之后
        `.get()` 返回 `None`，框架就会重新读。

        两种情况要重读：

        - **换工作空间**：项目级 skill 换了，不重读就是拿 A 项目的 skill 去
          指导 B 项目的活。
        - **换选择**：要钉新的 skill 进上下文，得让框架重新交一份
          `skills_metadata` 回来（顺便重读一次目录，成本很低）。
        """
        if "skills_metadata" not in state:
            return state
        same_workspace = state.get("scode_skill_workspace") == workspace
        same_selection = list(state.get("scode_pinned_skills") or []) == list(selected)
        if same_workspace and same_selection:
            return state
        return {key: value for key, value in state.items() if key != "skills_metadata"}

    @staticmethod
    def _finish(
        update: dict[str, Any] | None,
        workspace: str,
        selected: list[str],
    ) -> dict[str, Any] | None:
        """收尾：滤掉「目录不存在」的警告，记下工作空间，钉住勾选的 skill。

        `update` 是 None 表示框架这轮没读（state 里已经有 `skills_metadata`
        且工作空间和选择都没变）——那就不用管。
        """
        if update is None:
            return None

        result = dict(update)

        errors = result.get("skills_load_errors") or []
        kept = [error for error in errors if not _is_missing_source(error)]
        if len(kept) != len(errors):
            result["skills_load_errors"] = kept

        result["scode_skill_workspace"] = workspace

        if selected:
            # `pinned_skills` 的 reducer 是**累加**（框架的 `_append_skill_names`），
            # 消费时框架会用 `Overwrite([])` 清空，所以正常情况下不会重复。
            # 这里只在「选择变了」时写——写一次就够，钉进去的消息会在对话
            # 历史里一直留着，每轮自动重发。
            result["pinned_skills"] = list(selected)
            result["scode_pinned_skills"] = list(selected)

        return result


def build_skills_middleware(backend: Any) -> WorkspaceSkillsMiddleware:
    """构造 skill 中间件。

    `backend` 是主 backend——它要能同时解析两种源：

    - `/user-skills/` 走路由（主 backend 上有这条路由）
    - `/.agents/skills/` 走 default，根目录是**运行期**的工作空间

    所以同一个中间件实例能服务不同工作空间的对话。
    """
    return WorkspaceSkillsMiddleware(backend=backend)
