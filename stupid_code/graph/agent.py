from deepagents import create_deep_agent

from stupid_code.config.model import load_model
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.backend import build_backend
from stupid_code.graph.compaction import (
    build_compaction_middleware,
    build_compaction_tool_middleware,
)
from stupid_code.graph.mcp import load_mcp_tools
from stupid_code.graph.memory import build_memory_middleware
from stupid_code.graph.model_switch import (
    ChatModelSwitchMiddleware,
    apply_model_switch_policy,
)
from stupid_code.graph.permissions import PermissionLevelMiddleware, build_interrupt_on
from stupid_code.graph.repeated_calls import RepeatedCallMiddleware
from stupid_code.graph.skills import build_skills_middleware
from stupid_code.graph.subagent_policy import apply_subagent_policies
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

# MCP 服务器的工具：建图时按 conf/mcp.json 取一次，交给框架当普通工具。
# 服务器连不上只少它那几个工具，不会让后端起不来。见 graph/mcp.py
mcp_tools = load_mcp_tools()

# 执行命令前的人工确认：按运行期传来的权限档位决定拦不拦，
# 拦下时图挂起等前端批准/拒绝——见 graph/permissions.py
# 非只读的 MCP 工具也在这里登记：manual 档下同样要确认
interrupt_on = build_interrupt_on(mcp_tools=mcp_tools)

graph = create_deep_agent(
    model=default_model,
    system_prompt=SYSTEM_PROMPT,
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用。
    # 这里统一收紧策略：子 agent 继承父级 interrupt_on；声明了 permissions 的
    # 子 agent 换无 shell 的 backend，并且不继承 MCP 工具（见 graph/backend.py）。
    # fork 子 agent 还会继承父级全部 middleware，所以再用
    # apply_model_switch_policy() 顶掉模型切换中间件，保证它用自己配置的模型。
    subagents=[
        apply_model_switch_policy(
            apply_subagent_policies(spec, default_interrupt_on=interrupt_on)
        )
        for spec in load_subagents()
    ],
    # MCP 服务器的工具：建图时按 conf/mcp.json 取一次，交给框架当普通工具。
    # 服务器连不上只少它那几个工具，不会让后端起不来。见 graph/mcp.py
    tools=mcp_tools,
    backend=backend,
    # skill 源：**全局**的那份是静态的（`GLOBAL_SKILL_SOURCES`）——它不依赖
    # 工作空间，可以写死。项目级的那份不行（工作空间是运行期参数），由
    # 下面的 build_skills_middleware() 每轮现算。
    #
    # **不要给 create_deep_agent 传 skills=**：传了之后 deepagents 会在 core
    # 栈里挂一份自己的 SkillsMiddleware，我们的中间件只能「顶替」它——顶替
    # 保留的是 core 栈里的位置（tail，比记忆中间件更内层），skill 块就会
    # 跑到记忆块后面，记忆块就不再是系统提示词的最后一块了。
    # 不传的话我们的中间件落进自定义区（排在记忆前面），块序才对。
    #
    # 长期记忆：读用户级 + 项目级两份记忆文件（可选，不会自动创建）。
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
    #
    # skill 中间件排在记忆中间件**前面**：记忆块要留在系统提示词的最后一块
    # （prompt-caching 的断点落在那一块上）。skill 块在记忆块之前，同样在
    # 缓存范围内。
    #
    # 重复调用中间件排在最后：它只在工具调用的路径上插一刀（拦截同一个 tool
    # 用同一组参数反复失败），不碰提示词、不碰模型，跟别人的顺序无关。
    # 它靠扫消息历史判定连续失败，不写图状态，所以放在哪都不影响别的中间件。
    middleware=[
        ChatModelSwitchMiddleware(),
        WorkspaceMiddleware(),
        # 权限档位记进 state：HITL 的 when 谓词在恢复时会再跑一次，必须给出
        # 同样的答案，只读客户端回传的值会被档位变化带偏（详见 permissions.py）
        PermissionLevelMiddleware(),
        compaction,
        # compact_conversation 工具：模型自己也能压缩上下文窗口
        build_compaction_tool_middleware(compaction),
        # skill：发现全局 + 项目级两份目录，并把用户勾选的钉进上下文
        build_skills_middleware(backend),
        build_memory_middleware(),
        RepeatedCallMiddleware(),
    ],
    interrupt_on=interrupt_on,
)
