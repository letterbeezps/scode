# 005 后端包结构整理

## 目标

把 `stupid_code/` 里平铺在一级目录的模块按职责收进子包，顶层只留"进程入口"和"框架读的配置"。

### 成功标准

- `stupid_code/` 一级目录只剩 `__init__.py` / `launcher.py` / `langgraph.json` 三个文件
- 包的职责一眼能分清：图与持久化、配置解析、管理接口各一个子包
- `uv run scode` 能正常启动，图能加载、`/admin/models` 能调、子 agent 能被 `task` 调起
- 历史不变：`stupid_code/data/langgraph.db` 位置不变、thread 索引仍可用

### 本期不做

- 不改任何行为：提示词内容、配置格式、接口语义、模型解析逻辑一律不动
- 不拆 `admin/`（本来就是子包）
- 不动 `conf/`（项目根的数据目录）与 `web/`
- 不引入 `pyproject.toml` 的打包配置（`dependencies: ["."]` 仍靠 uv 的 editable 安装）

### 关键取舍

- **按"职责"分包，不按"技术类型"分包**。`config/` 里三个文件都是"读配置产出东西"的，
  `graph/` 里两个都是"图怎么建、状态存哪"的——比按 tools/prompts/utils 这种技术分类好找。
- **`config/`（包） vs `conf/`（目录）** 是两个东西：前者是代码，后者是数据。名字相近，
  所以在 `config/__init__.py` 里写明了区分，免得下一个人找错地方改。
- **`graph/` 而不是 `app/`**：`admin/app.py` 已经占了 app 这个名字；`graph/` 也更贴近
  `langgraph.json` 里的 `graphs` 段。
- **`data/` 留在包根**（`stupid_code/data/`），不跟着 `persistence.py` 搬进 `graph/`。
  它是"整个后端的持久产物"，不是"图的私有数据"；文档里也一直这么写。
- **用 `git mv` 搬文件**，保留改名历史，`git log --follow` 能追到。

---

## 1. 改了什么

### 1.1 目标结构

```
stupid_code/
├── __init__.py       # scode 命令入口
├── launcher.py       # 起停 langgraph dev
├── langgraph.json    # 图注册（框架读的配置）
├── graph/            # 图与它的持久化
│   ├── agent.py           # create_deep_agent()，导出 graph
│   └── persistence.py     # SQLite 工厂：checkpoint/store → ../data/langgraph.db
├── config/           # 读项目根 conf/ 的那层（代码在这里，数据在 ../../conf/）
│   ├── model.py           # conf/config.toml → 模型实例 + CRUD helpers
│   ├── subagent.py        # conf/subagents.toml → SubAgent 规格
│   └── prompts.py         # 主 agent 的系统提示词
├── admin/            # 挂在 /admin 下的管理接口
│   ├── app.py             # Starlette 子应用与路由表
│   └── models.py          # /admin/models 五个端点的处理函数
└── data/             # SQLite 数据库目录（gitignore）
```

### 1.2 文件移动对照

| 移动前 | 移动后 |
|---|---|
| `stupid_code/agent.py` | `stupid_code/graph/agent.py` |
| `stupid_code/persistence.py` | `stupid_code/graph/persistence.py` |
| `stupid_code/model_config.py` | `stupid_code/config/model.py` |
| `stupid_code/subagent_config.py` | `stupid_code/config/subagent.py` |
| `stupid_code/prompts.py` | `stupid_code/config/prompts.py` |

新增两个子包的 `__init__.py`（只写 docstring，交代每个文件的职责）。

### 1.3 路径解析的连带改动

`__file__` 定位目录的层数跟包结构绑死，搬完必须改：

```python
# config/model.py、config/subagent.py：项目根的 conf/
_CONF_DIR = Path(__file__).resolve().parents[2] / "conf"   # 原来是 .parent.parent

# graph/persistence.py：包根的 data/
_DB_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
)
```

`launcher.py` 的 `Path(__file__).resolve().parent` 不用改——它留在顶层，指向的还是
`stupid_code/`（`langgraph.json` 所在处）。

### 1.4 `langgraph.json`

三处路径跟着搬：

```json
{
  "graphs":      {"code_agent": "./graph/agent.py:graph"},
  "http":        {"app": "./admin/app.py:app"},
  "checkpointer":{"path": "./graph/persistence.py:checkpointer"},
  "store":       {"path": "./graph/persistence.py:store"}
}
```

launcher 的 `_abs_import_spec()` 只要求路径以 `.` 开头，嵌套路径照样能绝对化，不用改逻辑。

### 1.5 import 改动

```python
# graph/agent.py
from stupid_code.config.model import load_model
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents

# config/subagent.py
from stupid_code.config.model import ConfigError, build_model_by_spec, load_config

# admin/models.py
from stupid_code.config.model import (...)
```

---

## 2. 验证

### 步骤 1：路径解析

```bash
cd /path/to/stupid-code
uv run python -c "
from stupid_code.config import model as m, subagent as s
from stupid_code.graph import persistence as p
print(m._CONF_DIR, m._CONF_DIR.is_dir())
print(s._CONF_DIR, s._CONF_DIR.is_dir())
print(p.DB_PATH)
"
```

期望：`conf/` 指向**项目根**、`DB_PATH` 指向 `stupid_code/data/langgraph.db`。

### 步骤 2：配置校验

```bash
uv run langgraph validate --config stupid_code/langgraph.json
```

### 步骤 3：启动

```bash
uv run scode
```

看到"Agent Server 已就绪"和"图 code_agent 已注册并可加载（6 个节点）"。

### 步骤 4：接口与委派

```bash
# 管理接口（config/model.py 链路）
curl -s http://127.0.0.1:2024/admin/models | python3 -m json.tool | head -10

# 子 agent 能被 task 调起（config/subagent.py → 模型实例 → SubAgent 规格）
# 发一条要求委派 summarizer 的消息，看 SSE 里 task 的 subagent_type
```

### 步骤 5：别留下错误位置的 data 目录

```bash
ls -d stupid_code/graph/data stupid_code/config/data   # 都不该存在
```

---

## 3. 常见问题

**启动报"找不到模块"**
`langgraph.json` 里的路径和实际文件位置对不上。搬文件必须同步改它。

**启动报 `ConfigError: 找不到 conf/config.toml`**
`config/` 下模块的 `parents[2]` 层数错了。`config/model.py` 往上两级才是项目根。

**对话历史没了**
`graph/persistence.py` 的 `data` 路径算错，SQLite 落到了别处（比如 `stupid_code/graph/data/`）。
检查 `p.DB_PATH`。

**会话列表空了**
跟对话历史是两回事：thread 索引在工作空间的 `.langgraph_api/` 里，不受本次改动影响。

---

## 4. 已验证的事实

- 搬完后 `conf/` 解析到项目根、`data/` 解析到 `stupid_code/data/`，两个路径都实测存在
- `uv run langgraph validate` 通过；派生配置里三条路径都被正确绝对化
  （`.../stupid_code/graph/agent.py:graph` 等）
- 实际 `uv run scode` 启动成功：图加载出 6 个节点，`GET /ok` 返回 ok
- `/admin/models` 正常返回（default = `minimax:MiniMax-M3`，3 个模型）
- 真实对话跑通：主 agent 用 `task` 调起 `summarizer` 子 agent（子 agent 用自己配置的
  模型，日志里能看到对 `api.minimax.cn` 的 3 次调用），主 agent 拿到结果后收尾
- `stupid_code/graph/data/` 与 `stupid_code/config/data/` 都没被创建——DB 仍在
  `stupid_code/data/langgraph.db`，历史没挪位置

## 5. 待核实

- `stupid_code/README.md` 里的文件表链接用的是相对路径（如 `graph/agent.py`），
  在 GitHub 上能点开，但打包成 wheel 后 `README.md` 不在包内——本期不处理
- `pyproject.toml` 用 hatchling 自动发现包。子包多了之后要确认打包时
  `graph/` / `config/` / `admin/` 都被打进去（当前只做 editable 安装，未验证 wheel）
