"""conf/subagents.toml 的加载、校验与 SubAgent 规格构建。

配置文件在项目根的 conf/subagents.toml（与代码分离），格式见同目录的
subagents.example.toml。文件不存在 = 不配置任何 subagent，加载返回空列表，
此时 deepagents 自带的 general-purpose subagent 照常可用。

每个 [[subagents]] 至少要有 name / description / model 三项：

- name：subagent 标识，主 agent 用 task(agent="<name>") 调用
- description：能力描述，主 agent 据此决定何时委派
- model："供应商名:模型名"，与 config.toml 的 [models] 写法一致；
  解析时复用 config.toml 里该供应商的 base_url / api_key，不重复写连接信息

其余可选字段对应 deepagents 的 SubAgent 规格，TOML 能表达的部分都在下面
逐个解析；没法用 TOML 表达的（middleware 需要 Python 对象）不在本期范围。
"""

import tomllib
from pathlib import Path
from typing import Any, cast

from deepagents import FilesystemPermission, SubAgent

from stupid_code.model_config import ConfigError, build_model_by_spec, load_config

# 本文件位于 stupid_code/，上一级即项目根，配置统一放根下 conf/ 目录
_CONF_DIR = Path(__file__).resolve().parent.parent / "conf"
_SUBAGENTS_FILENAME = "subagents.toml"

# 允许出现在 [[subagents]] 里的字段：deepagents SubAgent 规格的 TOML 可表达子集
_ALLOWED_FIELDS = frozenset({
    "name",
    "description",
    "model",
    "system_prompt",
    "mode",
    "skills",
    "tools",
    "interrupt_on",
    "permissions",
    "response_format",
})

_VALID_MODES = ("isolated", "fork")
_VALID_OPERATIONS = ("read", "write")
_VALID_PERMISSION_MODES = ("allow", "deny", "interrupt")
_VALID_DECISIONS = ("approve", "edit", "reject", "respond")


def subagents_path() -> Path:
    return _CONF_DIR / _SUBAGENTS_FILENAME


def load_subagent_config() -> dict[str, Any]:
    """读 conf/subagents.toml。文件不存在返回空 dict（表示不配置 subagent）。"""
    path = subagents_path()
    if not path.is_file():
        return {}
    with path.open("rb") as fp:
        try:
            return tomllib.load(fp)
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"subagents.toml 语法错误：{exc}") from exc


def load_subagents() -> list[SubAgent]:
    """加载 conf/subagents.toml，构建 SubAgent 规格列表。

    在 agent.py 导入时调用一次，改配置需重启服务。
    """
    config = load_subagent_config()
    if not config:
        return []
    return build_subagents(config, load_config())


def build_subagents(config: dict[str, Any], main_config: dict[str, Any]) -> list[SubAgent]:
    """把 [[subagents]] 原始表转成 deepagents 的 SubAgent 规格列表。

    main_config 是 config.toml 的内容，subagent 的 model 按里面的供应商
    配置解析。
    """
    entries = config.get("subagents")
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ConfigError("subagents.toml 的 subagents 必须是数组（用 [[subagents]] 写法）")

    specs: list[SubAgent] = []
    seen: set[str] = set()
    for index, entry in enumerate(entries):
        where = f"subagents.toml 第 {index + 1} 个 [[subagents]]"
        specs.append(_build_subagent(entry, where, main_config, seen))
    return specs


def _build_subagent(
    entry: Any,
    where: str,
    main_config: dict[str, Any],
    seen: set[str],
) -> SubAgent:
    """校验并转换单个 [[subagents]] 表。"""
    if not isinstance(entry, dict):
        raise ConfigError(f"{where} 必须是表")

    unknown = set(entry) - _ALLOWED_FIELDS
    if unknown:
        raise ConfigError(
            f"{where} 出现未知字段：{'、'.join(sorted(unknown))}；"
            f"可用字段：{'、'.join(sorted(_ALLOWED_FIELDS))}"
        )

    name = _require_str(entry, "name", where)
    if name in seen:
        raise ConfigError(f"subagent 名称重复：{name!r}")
    seen.add(name)

    description = _require_str(entry, "description", where)

    model_spec = _require_str(entry, "model", where)
    try:
        model = build_model_by_spec(main_config, model_spec)
    except ConfigError as exc:
        raise ConfigError(f"{where}（{name}）的 model {model_spec!r} 无法解析：{exc}") from exc

    spec: dict[str, Any] = {
        "name": name,
        "description": description,
        # 传实例而不是 "provider:model" 字符串：字符串会走 deepagents 自己的
        # init_chat_model，认不出本项目自定义的供应商名（minimax 等）
        "model": model,
    }

    system_prompt = entry.get("system_prompt")
    if system_prompt is not None:
        if not isinstance(system_prompt, str):
            raise ConfigError(f"{where} 的 system_prompt 必须是字符串")
        spec["system_prompt"] = system_prompt

    mode = entry.get("mode", "isolated")
    if mode not in _VALID_MODES:
        raise ConfigError(
            f"{where} 的 mode 只支持 {' / '.join(_VALID_MODES)}，当前为 {mode!r}"
        )
    spec["mode"] = mode

    skills = entry.get("skills")
    if skills is not None:
        if not isinstance(skills, list) or not all(isinstance(s, str) for s in skills):
            raise ConfigError(f"{where} 的 skills 必须是字符串数组")
        if mode == "fork" and skills:
            raise ConfigError(
                f"{where}（{name}）mode='fork' 时不能设置 skills，"
                "fork 直接继承父 agent 的 skills"
            )
        spec["skills"] = list(skills)

    if "tools" in entry:
        spec["tools"] = _parse_tools(entry["tools"], where)

    if "interrupt_on" in entry:
        spec["interrupt_on"] = _parse_interrupt_on(entry["interrupt_on"], where)

    if "permissions" in entry:
        spec["permissions"] = _parse_permissions(entry["permissions"], where)

    response_format = entry.get("response_format")
    if response_format is not None:
        if not isinstance(response_format, dict):
            raise ConfigError(f"{where} 的 response_format 必须是表（JSON schema）")
        spec["response_format"] = dict(response_format)

    return cast("SubAgent", spec)


def _require_str(entry: dict[str, Any], key: str, where: str) -> str:
    value = entry.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{where} 的 {key} 必须是非空字符串")
    return value.strip()


def _parse_tools(raw: Any, where: str) -> list[dict[str, Any]]:
    """tools：供应商内置工具的表列表，原样透传给模型供应商。

    不写 tools 时 subagent 继承父 agent 传给 create_deep_agent 的 tools；
    写了就是替换那一项。注意文件工具（ls / read_file / write_file 等）来自
    FilesystemMiddleware，不受这个字段影响。

    TOML 只能描述"供应商侧执行"的工具，纯 Python 函数工具要在代码里注册。
    """
    if not isinstance(raw, list):
        raise ConfigError(f"{where} 的 tools 必须是数组")
    tools: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ConfigError(f"{where} 的 tools 每项必须是表（供应商内置工具用表描述）")
        tools.append(dict(item))
    return tools


def _parse_interrupt_on(raw: Any, where: str) -> dict[str, Any]:
    """interrupt_on：{ 工具名 = true } 或 { 工具名 = { allowed_decisions = [...], description = "..." } }。

    命中规则的工具调用会挂起等人工确认，需要 checkpointer —— 本项目的
    checkpointer 在 langgraph.json 里配好了，不用额外传。
    """
    if not isinstance(raw, dict):
        raise ConfigError(f"{where} 的 interrupt_on 必须是表")

    out: dict[str, Any] = {}
    for tool_name, value in raw.items():
        if isinstance(value, bool):
            out[tool_name] = value
            continue
        if not isinstance(value, dict):
            raise ConfigError(
                f"{where} 的 interrupt_on[{tool_name}] 必须是布尔值或表"
            )
        allowed = value.get("allowed_decisions")
        if not isinstance(allowed, list) or not allowed:
            raise ConfigError(
                f"{where} 的 interrupt_on[{tool_name}] 缺 allowed_decisions（非空数组）"
            )
        for decision in allowed:
            if decision not in _VALID_DECISIONS:
                raise ConfigError(
                    f"{where} 的 interrupt_on[{tool_name}] 里有不支持的决策 {decision!r}，"
                    f"只支持 {' / '.join(_VALID_DECISIONS)}"
                )
        config: dict[str, Any] = {"allowed_decisions": list(allowed)}
        description = value.get("description")
        if description is not None:
            if not isinstance(description, str):
                raise ConfigError(
                    f"{where} 的 interrupt_on[{tool_name}].description 必须是字符串"
                )
            config["description"] = description
        out[tool_name] = config
    return out


def _parse_permissions(raw: Any, where: str) -> list[FilesystemPermission]:
    """permissions：文件访问规则，转成 deepagents 的 FilesystemPermission。

    写法：{ operations = ["read"], paths = ["/secrets/**"], mode = "deny" }
    规则按声明顺序匹配，第一条命中的生效。
    """
    if not isinstance(raw, list):
        raise ConfigError(f"{where} 的 permissions 必须是数组")

    permissions: list[FilesystemPermission] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ConfigError(f"{where} 的 permissions 每项必须是表")

        operations = item.get("operations")
        if not isinstance(operations, list) or not operations:
            raise ConfigError(
                f"{where} 的 permissions 每项都要有 operations（非空数组）"
            )
        for operation in operations:
            if operation not in _VALID_OPERATIONS:
                raise ConfigError(
                    f"{where} 的 permissions 里有不支持的 operation {operation!r}，"
                    f"只支持 {' / '.join(_VALID_OPERATIONS)}"
                )

        paths = item.get("paths")
        if not isinstance(paths, list) or not paths:
            raise ConfigError(f"{where} 的 permissions 每项都要有 paths（非空数组）")
        for path in paths:
            if not isinstance(path, str):
                raise ConfigError(f"{where} 的 permissions 里 paths 必须是字符串")

        mode = item.get("mode", "allow")
        if mode not in _VALID_PERMISSION_MODES:
            raise ConfigError(
                f"{where} 的 permissions 里 mode 只支持 "
                f"{' / '.join(_VALID_PERMISSION_MODES)}，当前为 {mode!r}"
            )

        try:
            permissions.append(
                FilesystemPermission(
                    operations=list(operations),
                    paths=list(paths),
                    mode=mode,
                )
            )
        except (ValueError, NotImplementedError) as exc:
            raise ConfigError(f"{where} 的 permissions 不合法：{exc}") from exc
    return permissions
