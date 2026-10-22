from deepagents import create_deep_agent

from stupid_code.config.model import load_model
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.backend import apply_permission_backend, build_backend
from stupid_code.graph.memory import build_memory_middleware

# 真实 backend：文件操作落工作空间的真实磁盘，execute 直接在本机跑 shell。
backend = build_backend()

graph = create_deep_agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用。
    # 声明了 permissions 的子 agent 要换成无 shell 的 backend（见 graph/backend.py）
    subagents=[apply_permission_backend(spec) for spec in load_subagents()],
    backend=backend,
    # 长期记忆：读工作空间根的 .scode-memory.md（没有就创建）。
    # 走 middleware 参数而不是 create_deep_agent 的 memory 参数，
    # 这样能自己指定读文件的 backend——见 graph/memory.py 的说明
    middleware=[build_memory_middleware()],
)
