from deepagents import create_deep_agent

from stupid_code.config.model import load_model
from stupid_code.config.prompts import SYSTEM_PROMPT
from stupid_code.config.subagent import load_subagents
from stupid_code.graph.memory import build_memory_middleware

graph = create_deep_agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用
    subagents=load_subagents(),
    # 长期记忆：读工作空间根的 AGENTS.md（没有就创建）。
    # 走 middleware 参数而不是 create_deep_agent 的 memory 参数，
    # 这样能自己指定读文件的 backend——见 graph/memory.py 的说明
    middleware=[build_memory_middleware()],
)
