"""SQLite 持久化工厂。

LangGraph dev 默认用 in-memory runtime 把状态存成 `.langgraph_api/*.pckl`，
这里换成 SQLite：checkpoint（线程状态快照）和 store（长期记忆/向量索引）
都落在同一个 `data/langgraph.db` 文件里，便于查看和备份。

langgraph.json 通过 `checkpointer.path` / `store.path` 指向下面两个工厂，
API 服务器在启动时加载并管理生命周期。
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.store.sqlite import AsyncSqliteStore

# 数据库文件放在包根的 data/ 下（stupid_code/data/），路径与启动 CWD 解耦
_DB_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data"
)
os.makedirs(_DB_DIR, exist_ok=True)
# 注意：AsyncSqliteSaver / AsyncSqliteStore 把 conn_string 直接传给底层连接，
# 这里传文件路径即可，不要加 sqlite:/// 前缀。
DB_PATH = os.path.join(_DB_DIR, "langgraph.db")


@asynccontextmanager
async def checkpointer():
    """异步上下文管理器，yield 一个 AsyncSqliteSaver 实例。

    必须用异步版本：langgraph_api 的运行时全部走 aput/aget_tuple 等异步方法，
    同步 SqliteSaver 的异步方法会抛 NotImplementedError。
    """
    async with AsyncSqliteSaver.from_conn_string(DB_PATH) as saver:
        yield saver


@asynccontextmanager
async def store():
    """异步上下文管理器，yield 一个 AsyncSqliteStore 实例。"""
    async with AsyncSqliteStore.from_conn_string(DB_PATH) as s:
        yield s
