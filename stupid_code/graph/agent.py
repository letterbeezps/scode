from deepagents import create_deep_agent

from stupid_code.config.model import load_model
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.backend import apply_subagent_policies, build_backend
from stupid_code.graph.compaction import (
    build_compaction_middleware,
    build_compaction_tool_middleware,
)
from stupid_code.graph.mcp import load_mcp_tools
from stupid_code.graph.memory import build_memory_middleware
from stupid_code.graph.model_switch import ChatModelSwitchMiddleware
from stupid_code.graph.permissions import PermissionLevelMiddleware, build_interrupt_on
from stupid_code.graph.workspace import WorkspaceMiddleware

# 真实 backend：文件操作落工作空间的真实磁盘，execute 直接在本机跑 shell。
backend = build_backend()

# 启动时带的默认模型。运行期切换见 graph/model_switch.py：
# 前端把选中的模型 id 放进 configurable，中间件在每次模型调用前换掉
# request.model —— 不需要重启后端。
default_model = load_model()

# 摘要中间件：顶掉 create_deep_agent() 自带的那份（靠 .name 匹配原地替换），
# 加两件事——用户发 /compaction 时强制压缩一次；写摘要用当前选中的模型。
compaction = build_compaction_middleware(default_model, backend)

# 执行命令前的人工确认：按运行期传来的权限档位决定拦不拦，
# 拦下时图挂起等前端批准/拒绝——见 graph/permissions.py
interrupt_on = build_interrupt_on()

graph = create_deep_agent(
    model=default_model,
    system_prompt=SYSTEM_PROMPT,
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用。
    # 这里统一收紧策略：子 agent 继承父级 interrupt_on；声明了 permissions 的
    # 子 agent 换无 shell 的 backend，并且不继承 MCP 工具（见 graph/backend.py）
    subagents=[
        apply_subagent_policies(spec, default_interrupt_on=interrupt_on)
        for spec in load_subagents()
    ],
    # MCP 服务器的工具：建图时按 conf/mcp.json 取一次，交给框架当普通工具。
    # 服务器连不上只少它那几个工具，不会让后端起不来。见 graph/mcp.py
    tools=load_mcp_tools(),
    backend=backend,
    # 长期记忆：读工作空间根的 .scode-memory.md（可选文件，不会自动创建）。
    # 走 middleware 参数而不是 create_deep_agent 的 memory 参数，
    # 这样能自己指定读文件的 backend——见 graph/memory.py 的说明
    #
    # 顺序：切换中间件放在最前，让它在最外层——这样内层的
    # AnthropicPromptCachingMiddleware / MemoryMiddleware 看到的是
    # 已经换过的模型，缓存断点才会按新模型决定加不加。
    #
    # 工作空间中间件紧随其后：它每轮开跑前校验工作空间（不存在就直接报错），
    # 把解析结果刷进缓存，并把绝对路径写进系统提示词。它必须排在记忆中间件
    # 前面——记忆中间件要用同一份缓存决定从哪个目录读记忆。
    middleware=[
        ChatModelSwitchMiddleware(default_model),
        WorkspaceMiddleware(),
        # 权限档位记进 state：HITL 的 when 谓词在恢复时会再跑一次，必须给出
        # 同样的答案，只读客户端回传的值会被档位变化带偏（详见 permissions.py）
        PermissionLevelMiddleware(),
        compaction,
        # compact_conversation 工具：模型自己也能压缩上下文窗口
        build_compaction_tool_middleware(compaction),
        build_memory_middleware(),
    ],
    interrupt_on=interrupt_on,
)
