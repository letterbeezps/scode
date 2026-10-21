"""图与它的持久化。

    agent.py       建图：create_deep_agent()，导出 graph
    persistence.py checkpointer / store 工厂：SQLite → ../data/langgraph.db

langgraph.json 里的 graphs / checkpointer / store 三处都指向这里，
挪动这两个文件必须同步改 langgraph.json，否则启动时报找不到模块。
"""
