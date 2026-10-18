# 002 config.toml 多供应商模型配置

## 目标

不再使用 `.env` 文件；模型供应商配置（含 api_key）统一放 `conf/config.toml`（项目根 `conf/` 目录，与代码分离，不入库），支持多供应商、anthropic / openai 两种协议；`create_deep_agent` 启动时按 `[models].default` → `[models].recent` 选择模型。

### 成功标准

- `config.toml` 配置两个不同协议的供应商（anthropic 协议 + openai 协议），`default` 指向 anthropic 协议那个，启动后前端能正常对话
- 把 `default` 切到 openai 协议供应商，重启后对话仍正常（多供应商切换生效）
- 配置错误（协议名不合法、模型不在列表、缺供应商段、缺 api_key）时启动失败，错误信息能直接指出怎么改
- 001 的验证项回归通过（停止按钮、刷新恢复历史）

### 本期不做

- `/models` 端点、前端模型选择器 —— 留到 003
- `recent` 的写回（切换模型后"记住上次使用"）—— 本期只读，`recent` 仅作 `default` 缺省时的回退
- anthropic / openai 之外的协议（google、bedrock 等）
- 运行中热切换模型 —— 改 `config.toml` 必须重启服务

### 关键取舍

- TOML 解析用标准库 `tomllib`（requires-python ≥ 3.12 已满足），不引新依赖
- 配置文件单独放在项目根 `conf/` 目录，与代码分离；供应商的**结构化**配置（协议、端点、key、模型列表）放 TOML——`.env` 表达不了嵌套结构，且本项目不再使用它
- `api_key` 明文必填，写在 `conf/config.toml`，靠 gitignore 保证不入库（与原 `.env` 的防泄漏方式一致）；入库的是模板 `conf/config.example.toml`
- 模型构建走 `init_chat_model(model, model_provider=protocol)` 而非直接 `import ChatAnthropic / ChatOpenAI`：protocol 是配置字符串，需要"字符串→类"的官方分发器；且它**懒加载**集成包——只配 anthropic 协议的环境不会加载 langchain-openai，直接顶部导入两个包会把它们变成强制依赖。与 001 的 `agent.py` 写法也保持一致，改造面最小
- 校验从严：模型不在供应商的 `models` 列表直接报错（防拼写错误），错误信息带修复提示
- 模型在 `agent.py` 导入时构建一次；改配置需重启（`langgraph dev` 只热重载代码文件，不监听 toml）
- `display_name` 本期不消费，为 003 的前端模型选择器预留

---

## 1. 文件清单

新增 2 个：`stupid_code/config.py`、`conf/config.example.toml`；修改 4 个：`stupid_code/agent.py`、`stupid_code/langgraph.json`（删 `env` 字段）、根 `.gitignore`、`stupid_code/README.md`；删除 1 个：`stupid_code/.env`。**依赖无需新增**：`langchain-anthropic` 与 `langchain-openai` 均已在 `pyproject.toml` 声明，`uv sync` 即可。代码文件仍在 `stupid_code/`，用户配置单独放项目根 `conf/` 目录。

### 1.1 `stupid_code/config.py`（新建）

```python
"""config.toml 的加载、校验与模型构建。

配置文件在项目根的 conf/config.toml（与代码分离，不入库），
格式见同目录的 config.example.toml。
模型选择顺序：[models].default → [models].recent → 报错。
协议只支持 anthropic / openai，第三方端点通过 base_url 接入。
模型在 agent.py 导入时构建一次，改配置需重启服务。
"""

import tomllib
from pathlib import Path
from typing import Any

from langchain.chat_models import BaseChatModel, init_chat_model

SUPPORTED_PROTOCOLS = ("anthropic", "openai")
# 本文件位于 stupid_code/，上一级即项目根，配置统一放根下 conf/ 目录
_CONF_DIR = Path(__file__).resolve().parent.parent / "conf"
_CONFIG_FILENAME = "config.toml"


class ConfigError(Exception):
    """配置缺失或不合法。message 面向用户，可直接展示。"""


def config_path() -> Path:
    return _CONF_DIR / _CONFIG_FILENAME


def load_config() -> dict[str, Any]:
    path = config_path()
    if not path.is_file():
        raise ConfigError(
            f"找不到 {path}。请复制 conf/config.example.toml 为 conf/config.toml 并填入供应商信息。"
        )
    with path.open("rb") as fp:
        try:
            return tomllib.load(fp)
        except tomllib.TOMLDecodeError as exc:
            raise ConfigError(f"config.toml 语法错误：{exc}") from exc


def _pick_model_spec(models: dict[str, Any]) -> str:
    """default 优先；缺省回退 recent（recent 后续由模型切换功能写回，本期只读）。"""
    spec = models.get("default") or models.get("recent")
    if not isinstance(spec, str) or ":" not in spec:
        raise ConfigError(
            '[models] 里 default 与 recent 至少设置一个，'
            '格式为 "供应商名:模型名"，如 "minimax:MiniMax-M3"'
        )
    return spec


def _require_api_key(provider_name: str, provider: dict[str, Any]) -> str:
    """api_key 必填、明文写在 conf/config.toml（该文件已 gitignore，不入库）。

    必填是为了 fail-fast：缺 key 在配置阶段就报错，
    而不是等到首轮对话收到 401 才发现。本项目不再使用 .env。
    """
    api_key = provider.get("api_key")
    if not isinstance(api_key, str) or not api_key:
        raise ConfigError(
            f"供应商 {provider_name} 缺少 api_key，请在 [models.providers.{provider_name}] 段明文填写"
        )
    return api_key


def build_model(config: dict[str, Any]) -> BaseChatModel:
    models = config.get("models")
    if not isinstance(models, dict):
        raise ConfigError("config.toml 缺少 [models] 段")

    spec = _pick_model_spec(models)
    provider_name, _, model_id = spec.partition(":")
    provider_name = provider_name.strip()
    model_id = model_id.strip()
    if not provider_name or not model_id:
        raise ConfigError(f'模型标识 {spec!r} 不合法，应为 "供应商名:模型名"')

    providers = models.get("providers")
    if not isinstance(providers, dict) or not providers:
        raise ConfigError("config.toml 缺少 [models.providers.<供应商名>] 段")
    provider = providers.get(provider_name)
    if not isinstance(provider, dict):
        raise ConfigError(
            f"模型 {spec} 引用的供应商 {provider_name!r} 未配置，"
            f"需要 [models.providers.{provider_name}] 段"
        )

    protocol = provider.get("protocol")
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ConfigError(
            f"供应商 {provider_name} 的 protocol 只支持 "
            f"{' / '.join(SUPPORTED_PROTOCOLS)}，当前为 {protocol!r}"
        )

    allowed = provider.get("models")
    if not isinstance(allowed, list) or not allowed:
        raise ConfigError(f"供应商 {provider_name} 的 models 列表缺失或为空")
    if model_id not in allowed:
        raise ConfigError(
            f"模型 {model_id!r} 不在供应商 {provider_name} 的 models 列表里，"
            f"可用：{'、'.join(str(m) for m in allowed)}"
        )

    kwargs: dict[str, Any] = {}
    base_url = provider.get("base_url")
    if base_url:
        kwargs["base_url"] = base_url
    kwargs["api_key"] = _require_api_key(provider_name, provider)

    # init_chat_model 按 protocol 懒加载对应集成包：
    # anthropic → langchain-anthropic，openai → langchain-openai
    return init_chat_model(model_id, model_provider=protocol, **kwargs)


def load_model() -> BaseChatModel:
    return build_model(load_config())
```

### 1.2 `conf/config.example.toml`（新建）

```toml
# 复制本文件为同目录的 config.toml 后填写真实值（config.toml 不入库）。

[models]
# 模型选择顺序：default → recent。格式："供应商名:模型名"
default = "minimax:MiniMax-M3"
# recent 后续由"模型切换"功能自动写回，本期仅作 default 缺省时的回退
recent = "minimax:MiniMax-M3"

[models.providers.minimax]
# 协议只支持 anthropic / openai
protocol = "anthropic"
display_name = "MiniMax"
base_url = "https://api.minimax.cn/anthropic"
# 明文填写；conf/config.toml 已 gitignore，不会入库
api_key = "sk-你的MiniMax密钥"
models = [
    "MiniMax-M3",
    "MiniMax-M2.5",
]

# 第二个供应商示例：openai 协议（用于验证多供应商切换）
[models.providers.deepseek]
protocol = "openai"
display_name = "DeepSeek"
base_url = "https://api.deepseek.com"
api_key = "sk-你的DeepSeek密钥"
models = ["deepseek-chat"]
```

### 1.3 `stupid_code/agent.py`（修改）

```python
from deepagents import create_deep_agent

from stupid_code.config import load_model

graph = create_deep_agent(
    model=load_model(),
    system_prompt="你是一个编程助手。",
)
```

`uv run scode` 启动的 langgraph dev 把项目根放进 `sys.path`，`stupid_code` 是已安装包，按包内绝对导入即可，不需要兜底。

### 1.4 `stupid_code/langgraph.json`（修改）、删除 `stupid_code/.env`

`env` 字段随 `.env` 文件一起移除，最终内容：

```json
{
  "dependencies": ["."],
  "graphs": {
    "code_agent": "./agent.py:graph"
  }
}
```

同时删除 `stupid_code/.env`。注意：gitignore 只防未来提交，不洗历史——若 key 曾被提交过，删除文件后应到供应商后台**换新 key**。

### 1.5 `pyproject.toml`（无需修改）

`langchain-anthropic` 与 `langchain-openai` 均已在依赖中声明，openai 协议供应商被配置时 `init_chat_model` 加载 `langchain_openai` 集成包，无新增依赖，执行 `uv sync` 即可。

> 注意包名：官方 OpenAI 集成包是 **`langchain-openai`**。PyPI 上的 `langchain-openapi` 是第三方包（作者 zbmain，非官方、无文档说明），**不是**同一个东西，装错会导致 openai 协议模型构建时 `ImportError`。

### 1.6 `.gitignore`（根目录，修改）

```diff
 # Secrets — never commit API keys
 .env
 .env.*
 !.env.example
+conf/config.toml
```

只忽略 `conf/config.toml` 本身；`conf/config.example.toml` 不被该模式命中，会正常入库。

### 1.7 `stupid_code/README.md`（同步更新）

文件表删掉 `.env` 一行，增加 `config.py` 一行（说明配置文件位于项目根 `conf/config.toml`）；「注意」小节增加：

> - 模型供应商配置在项目根 `conf/config.toml`（从 `conf/config.example.toml` 复制），选择顺序 `default` → `recent`，协议只支持 anthropic / openai；改配置需重启服务。

---

## 2. 配置语义

| 字段 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `default` | `[models]` | 与 `recent` 至少一个 | 启动时优先使用的模型，`"供应商名:模型名"` |
| `recent` | `[models]` | 同上 | `default` 缺省时的回退；本期只读 |
| `protocol` | `[models.providers.<name>]` | 是 | 只接受 `anthropic` / `openai` |
| `display_name` | `[models.providers.<name>]` | 否 | 展示名，本期不消费，留给前端模型选择器 |
| `base_url` | `[models.providers.<name>]` | 否 | 不填则用协议官方端点 |
| `api_key` | `[models.providers.<name>]` | 是 | 明文 key，写在 `conf/config.toml`（已 gitignore） |
| `models` | `[models.providers.<name>]` | 是 | 该供应商可用模型名列表（非空），不在列表里的模型会被拒绝 |

协议到模型类的映射：`anthropic` → `ChatAnthropic`（langchain-anthropic），`openai` → `ChatOpenAI`（langchain-openai），由 `init_chat_model(model, model_provider=protocol, **kwargs)` 完成构建并透传 `base_url` / `api_key`。

## 3. 验证

### 步骤 0：配置冒烟（不起服务，最快暴露配置错误）

```bash
cd /Users/1token/Desktop/project/stupid-code
uv sync
uv run python -c "
from stupid_code.config import load_model
m = load_model()
print(type(m).__module__, type(m).__name__)
"
```

期望输出包含 `ChatAnthropic`（`default` 指向 anthropic 协议供应商时；openai 协议则为 `ChatOpenAI`）。配置有错时这一步直接抛 `ConfigError`，不必等 `scode` 超时。

### 步骤 1：启动

与 001 相同：`uv run scode`。看到 001 的两条 ✅ 就绪提示即通过——图能加载说明包内导入和配置解析都成功了。

### 步骤 2：anthropic 协议端到端

浏览器发一句"你好"，`default` 指向的 minimax 模型正常回复即通过。

### 步骤 3：切换供应商（openai 协议端到端）

`config.toml` 里把 `default` 改为 `"deepseek:deepseek-chat"`，`Ctrl+C` 重启 `scode`，再对话一轮。回复正常即证明多供应商、双协议切换生效。

### 步骤 4：错误校验冒烟

把某个供应商的 `protocol` 临时改成 `"minimax"`，重跑步骤 0 的冒烟命令，期望立刻抛出 `ConfigError`，文案包含"只支持 anthropic / openai"；改回。

### 步骤 5：回归 001

停止按钮、刷新恢复历史两项照 001 步骤 3/4 重跑一遍。

## 4. 常见问题

| 现象 | 怎么办 |
|---|---|
| 找不到 config.toml | 复制 `conf/config.example.toml` 为 `conf/config.toml` |
| ConfigError：缺少 api_key | 在对应 `[models.providers.<name>]` 段明文补上（`conf/config.toml` 不会入库） |
| ConfigError：protocol 只支持 anthropic / openai | `protocol` 填协议名，不是供应商名 |
| ConfigError：模型不在 models 列表 | 改 `default` 的模型名拼写，或把新模型加进列表 |
| 改了 config.toml 不生效 | 模型在 `agent.py` 导入时构建一次，必须重启 `scode` |
| openai 协议 404 / model not found | 检查 `base_url` 是否需要 `/v1` 后缀（各供应商不同）；确认模型名 |
| scode 60 秒超时退出 | 大概率是配置错误导致图加载失败：先跑步骤 0 冒烟，再看终端 1 的 langgraph 日志 |

## 5. 假设与待核实

- **MiniMax 的 anthropic 端点与模型名**（`https://api.minimax.cn/anthropic`、`MiniMax-M3`、`MiniMax-M2.5`）：来自 draft，非官方文档核实。步骤 2 对话失败时先 `curl` 该端点确认。[待核实: 步骤 2]
- **DeepSeek 的 openai 兼容端点与模型名**：`https://api.deepseek.com` + `deepseek-chat` 按其官方文档惯例；步骤 3 实测。[待核实: 步骤 3]
- **依赖相容**：`langchain-anthropic>=1.7.6`、`langchain-openai>=1.0` 已在 `pyproject.toml` 声明（已核实 PyPI：官方包为 `langchain-openai`，当前 1.7.2；`langchain-openapi` 是无关的第三方包）。与 langchain 1.4.6 的版本相容由 `uv sync` 解析。[已通过：`uv sync` 输出 "Resolved 99 packages"，无冲突]
