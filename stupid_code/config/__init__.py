"""配置解析层：读项目根 conf/ 下的文件，产出 agent 需要的东西。

    model.py     读 conf/config.toml → 模型实例 + 模型 CRUD helpers
    subagent.py  读 conf/subagents.toml → deepagents 的 SubAgent 规格
    prompts.py   主 agent 的系统提示词（框架已不提供内置提示词）

注意区分：这里放**代码**，数据在项目根的 conf/ 目录（**别混淆**）。
这几个模块都用 __file__ 往上定位 conf/，再往下挪目录时要同步改 parents 的层数。
"""
