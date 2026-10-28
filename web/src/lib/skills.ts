/**
 * 本次对话勾选的 skill —— 任务级参数，跟工作空间、权限一样。
 *
 * 勾选的名字随运行请求的 `context` 发给后端，后端会把它们的 `SKILL.md`
 * 全文**钉进上下文**（见后端 `stupid_code/graph/skills.py`）。
 *
 * 跟 `WORKSPACE_KEY` / `PERMISSIONS_KEY` 一样，值存在 taskStore 里、
 * 也写进 thread metadata，刷新页面后能回填。
 */

/** 与后端约定的 context 字段，见后端 `stupid_code/graph/run_context.py` */
export const SKILLS_KEY = 'skills'
