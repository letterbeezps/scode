from deepagents import create_deep_agent

from stupid_code.model_config import load_model

graph = create_deep_agent(
    model=load_model(),
    system_prompt="你是一个编程助手。",
)