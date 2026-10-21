from deepagents import create_deep_agent

from stupid_code.model_config import load_model
from stupid_code.prompts import SYSTEM_PROMPT
from stupid_code.subagent_config import load_subagents

graph = create_deep_agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    # 来自 conf/subagents.toml；文件不存在时为空列表，
    # deepagents 自带的 general-purpose subagent 照常可用
    subagents=load_subagents(),
)
