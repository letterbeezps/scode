from deepagents import create_deep_agent

from stupid_code.model_config import load_model
from stupid_code.subagent_config import load_subagents

graph = create_deep_agent(
    model=load_model(),
    system_prompt="你是一个编程助手。",
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用
    subagents=load_subagents(),
)
