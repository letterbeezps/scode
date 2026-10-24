from deepagents import create_deep_agent

from stupid_code.config.model import load_model
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.backend import apply_permission_backend, build_backend
from stupid_code.graph.memory import build_memory_middleware
from stupid_code.graph.model_switch import ChatModelSwitchMiddleware
from stupid_code.graph.permissions import build_interrupt_on

# 真实 backend：文件操作落工作空间的真实磁盘，execute 直接在本机跑 shell。
backend = build_backend()

# 启动时带的默认模型。运行期切换见 graph/model_switch.py：
# 前端把选中的模型 id 放进 configurable，中间件在每次模型调用前换掉
# request.model —— 不需要重启后端。
default_model = load_model()

graph = create_deep_agent(
    model=default_model,
    system_prompt=SYSTEM_PROMPT,
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用。
    # 声明了 permissions 的子 agent 要换成无 shell 的 backend（见 graph/backend.py）
    subagents=[apply_permission_backend(spec) for spec in load_subagents()],
    backend=backend,
    # 长期记忆：读工作空间根的 .scode-memory.md（没有就创建）。
    # 走 middleware 参数而不是 create_deep_agent 的 memory 参数，
    # 这样能自己指定读文件的 backend——见 graph/memory.py 的说明
    #
    # 顺序：切换中间件放在最前，让它在最外层——这样内层的
    # AnthropicPromptCachingMiddleware / MemoryMiddleware 看到的是
    # 已经换过的模型，缓存断点才会按新模型决定加不加。
    middleware=[ChatModelSwitchMiddleware(default_model), build_memory_middleware()],
    # 执行命令前的人工确认：按运行期传来的权限档位决定拦不拦，
    # 拦下时图挂起等前端批准/拒绝——见 graph/permissions.py
    interrupt_on=build_interrupt_on(),
)
