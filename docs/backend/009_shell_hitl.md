# 009 shell 的人工确认（HITL）

## 目标

007 接上真实 backend 之后，agent 的 `execute` 工具能直接在本机跑任意命令，
中间没有任何拦截——这正是设计文档里列为「影响极高」的风险。本期把**执行命令
的人工确认**这条链路打通：后端按权限档位拦截，前端弹确认卡片，用户批准或拒绝
之后图才继续。

### 成功标准

- `execute` 在命中拦截条件时，图**挂起**（不是报错），等前端送回决定
- 前端能显示「要执行什么命令」「为什么被拦」
- 批准 → 命令真的执行；拒绝 → 命令不执行，模型知道被拒了
- 三档行为可区分：`auto` 全放行 / `manual` 每条都问 / `normal` 只问危险命令
- 拦截只在工具层生效，不依赖模型自觉（deepagents 是 "trust the LLM" 模型）

### 本期不做

- **不拦文件类工具**（`write_file` / `edit_file` / `delete`）。文件写入是 code
  agent 的日常，动辄就拦等于没法干活。真正不可逆的是 shell 命令。
- **不做 AI 审核危险与否**。原设想 `normal` 档由 AI 判断这次操作是否危险再决定
  要不要问人：AI 审核要额外一次模型调用，判断标准也没法复现，出了问题说不清
  是谁该负责。改成固定规则——命中就是命中，不命中就不命中，行为可预期。
- **不做命令编辑**（框架支持 `edit` 决策：人工改完命令再执行）。前端只给
  批准 / 拒绝两个按钮。
- 不做危险命令的目录白名单（哪些路径可以放心 `rm`）。
- 不拦子 agent 的 `execute`（子 agent 默认继承顶层 `interrupt_on`，见下文）。

### 关键取舍

- **只拦 `execute`**。框架有一条硬限制：backend 支持命令执行时
  `FilesystemMiddleware` 不接受 `permissions`（直接抛 `NotImplementedError`），
  所以文件权限和 shell 不能共存——见 007 的说明。本期绕开这个矛盾：只拦 shell，
  文件工具靠真实磁盘 + 提示词，不做工具层强制。
- **危险判定用固定正则，不用 AI**。理由同上：可复现、可解释、零额外开销。
- **档位随运行请求传，不存全局**。和 `workspace` 一样是任务级参数（008 之前
  就是这么定的）：同一次运行里档位变了，恢复时的判定结论也会变。
- **`normal` 档是默认档**。`manual` 每条命令都问太啰嗦，`auto` 太危险。

---

## 1. 改了什么

### 1.1 后端：`stupid_code/graph/permissions.py`（新文件）

三块内容：

**档位解析**

```python
PERMISSIONS_KEY = "permissions"       # configurable 里的 key，与前端对齐
DEFAULT_PERMISSION_LEVEL = "normal"    # 前端没传（或传了不认识的值）时的默认档

def permission_level(configurable: dict[str, Any] | None) -> str:
    ...
```

**危险命令识别**

`DANGEROUS_PATTERNS` 是一组 `(正则, 人话说明)`，命中就认为这条命令不可逆 /
影响系统 / 会拉远程代码执行。说明直接进确认卡片，用户不用猜为什么被拦：

| 模式 | 例子 | 说明 |
|---|---|---|
| `rm` 带 r/f | `rm -rf ./x` | 删除文件 |
| `dd if=` | `dd if=/dev/zero of=x` | 磁盘级写入 |
| `mkfs` / `fdisk` / `diskutil` | `mkfs.ext4 /dev/sda` | 磁盘/分区操作 |
| `:\(\)\s*\{` | `:{ :\|:& };:` | fork 炸弹 |
| `shutdown` / `reboot` / `halt` | `reboot` | 关机或重启 |
| `sudo` / `su -` | `sudo apt install x` | 提权执行 |
| `chmod 777` | `chmod -R 777 ./x` | 放宽权限 |
| `chown ... root` | `chown root:root ./x` | 改属主为 root |
| `git push --force` | `git push -f origin main` | 强制推送 |
| `git reset --hard` | `git reset --hard HEAD` | 丢弃本地改动 |
| `git clean -f` | `git clean -fd` | 删除未跟踪文件 |
| `curl/wget \| sh` | `curl x.com/i.sh \| sh` | 下载并执行远程脚本 |
| 重定向到系统目录 | `> /etc/passwd` | 写入系统目录 |
| `kill -9` / `killall` | `killall -9 node` | 强杀进程 |
| `history -c` | `history -c` | 清空命令历史 |

**拦截判定**

```python
def should_interrupt(request: ToolCallRequest) -> bool:
    level = permission_level(request.runtime.config.get("configurable"))
    if level == LEVEL_AUTO:
        return False
    if level == LEVEL_MANUAL:
        return True
    return is_dangerous_command(_command_of(request))
```

`build_interrupt_on()` 把它包成 `create_deep_agent(interrupt_on=...)` 要的形状：

```python
{
    "execute": {
        "allowed_decisions": ["approve", "reject"],
        "when": should_interrupt,
        "description": _describe,
    }
}
```

`description` 是回调，会把命中的危险原因写进确认卡片。

### 1.2 后端：`stupid_code/graph/agent.py`

```python
interrupt_on=build_interrupt_on(),
```

建出来的图里会多一个节点 `HumanInTheLoopMiddleware.after_model`——这是框架挂
HITL 的地方。

### 1.3 前端：`web/src/api/events.ts`

平台把挂起的运行放在 chunk 的 `__interrupt__` 键下：

```json
{"__interrupt__": [{"value": {"action_requests": [{"name","args","description"}],
                            "review_configs": [...]}}]}
```

`parseInterrupts()` 把它解析成 `ApprovalRequest[]`，`updates` 和 `values` 两种
模式都认。

### 1.4 前端：`web/src/api/run.ts`

`resumeRun()` 走同一个端点，只是把 `command.resume` 带上决定：

```json
{"command": {"resume": {"decisions": [{"type": "approve"}]}}}
```

平台把它转成 LangGraph 的 `Command(resume=...)` 当作本次运行的输入，图从挂起点
继续。

**档位必须原样带回去**：后端的拦截判定在恢复时会再跑一次，档位变了结论就可能
变（批准后变成"这条命令要拦"，就永远批不掉了）。

### 1.5 前端：`web/src/store/conversationStore.ts`

- `pendingApproval` 存待确认的动作组
- 挂起期间**消息不落位**（`pendingMessage` 留着），批准/拒绝后继续往同一条
  消息上追加，最后一起落位
- `decideApproval()` 发决定 + 恢复运行

### 1.6 前端：`web/src/components/chat/ApprovalCard.tsx`（新文件）

卡片作为消息的一个 part 渲染，出现在「模型说要干什么」和「结果出来」之间。

---

## 2. 验证

### 步骤 1：后端加载正常

```bash
uv run python -c "from stupid_code.graph.agent import graph; print(list(graph.nodes))"
# 期望看到 'HumanInTheLoopMiddleware.after_model'
```

### 步骤 2：前端构建

```bash
cd web && pnpm build
```

### 步骤 3：真实服务 E2E

在临时目录起服务（工作空间 = 临时目录，agent 的 shell 就在里面跑）：

```bash
cd $(mktemp -d)
PYTHONPATH=<项目路径> <项目路径>/.venv/bin/python -c "import stupid_code; stupid_code.start()"
```

另开一个终端，POST `/threads/{tid}/runs/stream`，`config.configurable.permissions`
传档位，观察 SSE：

```bash
curl -N -X POST http://127.0.0.1:2024/threads/$TID/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"code_agent",
       "input":{"messages":[{"role":"user","content":"请执行命令：echo hello"}]},
       "stream_mode":["updates"],
       "config":{"configurable":{"workspace":"/tmp/xxx","permissions":"manual"}}}'
```

期望在 `updates` 事件里看到：

```json
{"__interrupt__": [{"value": {"action_requests": [{"name": "execute",
  "args": {"command": "echo hello"},
  "description": "这条命令会在你的机器上真的执行。"}],
  "review_configs": [{"action_name": "execute",
                       "allowed_decisions": ["approve", "reject"]}]}}]}
```

然后恢复：

```bash
curl -N -X POST http://127.0.0.1:2024/threads/$TID/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{"assistant_id":"code_agent",
       "command":{"resume":{"decisions":[{"type":"approve"}]}},
       "stream_mode":["updates"],
       "config":{"configurable":{"workspace":"/tmp/xxx","permissions":"manual"}}}'
```

期望：命令真的执行，模型继续往下说。

---

## 3. 常见问题

**前端不弹确认卡片，但命令执行了**

先看档位：是不是传了 `auto`。`auto` 档就是全部放行。

**前端弹了卡片，但点了没反应**

看控制台有没有 422/500。常见原因是 `decisions` 的个数和 `action_requests`
对不上——框架会直接抛
`Number of human decisions (N) does not match number of hanging tool calls (M)`，
整个运行报错。

**批准后命令还是被拦**

恢复请求里没原样带回档位，或者档位在两次请求之间变了。

**模型自己在对话里问了，没调工具**

这不是拦截，是提示词在起作用。`config/prompts.py` 里写了「破坏性命令先问
用户」，模型可能选择先问一句再动手——这时候没有 `__interrupt__`。要验证拦截
本身，用一条模型不会犹豫的命令（`manual` 档下 `echo hello` 就够）。

**危险命令没被拦（`normal` 档）**

正常：危险判定是**正则匹配**，命令写法一变就可能匹配不上（比如
`rm --recursive --force` 就匹配不到 `rm` 那条）。这是固定规则的固有局限，
宁可漏拦也不误拦——误拦会让 agent 基本没法干活。

---

## 4. 已验证的事实（2026-10-22 对真实服务实测）

- 平台把 interrupt 以 **`updates` 事件**下发，键是 `__interrupt__`，值是
  `[{value: {action_requests, review_configs}}]`。前端 `parseInterrupts` 的形状
  对得上。
- `configurable.permissions` 能到达后端的 `when` 谓词：三档行为在真实服务上
  可区分（`auto` 全放行、`manual` 每条都拦、`normal` 只拦危险命令）。
- `command.resume` 能让图从挂起点继续：批准后命令真的执行（`echo` 有输出、
  写文件真的落盘），拒绝后命令不执行，模型收到
  `User rejected the tool call for 'execute' with reason: ...`。
- **reject 的理由字段叫 `message`，不叫 `feedback`**（框架的 `RejectDecision`
  定义）。叫错的话理由被静默丢掉，模型只看到"用户拒绝了这次工具调用"。
  早期版本踩过这个坑。
- **一次 interrupt 可能含多个 `action_request`**（模型一轮里发了多条命令）。
  框架在 `HumanInTheLoopMiddleware.after_model` 里校验
  `len(decisions) == len(action_requests)`，对不上直接抛
  `Number of human decisions (N) does not match number of hanging tool calls (M)`，
  整个运行报错。早期版本只发一个 decision，遇到这个场景直接崩。
- **`2>/dev/null` 不能算「写入系统目录」**。原来的正则 `>\s*/(etc|usr|...|dev)`
  会匹配 `2>/dev/null`，而这种写法满地都是——等于几乎每条命令都被拦，
  拦截就失去意义了。现在用负向前瞻排除 `/dev/null`、`/dev/stdout`、
  `/dev/stderr`、`/dev/fd/*`。
- 平台的后端工具在 `execute` 之外还有 `ls` / `read_file` / `write_file` /
  `edit_file` / `delete` / `glob` / `grep`；本期只拦 `execute`。
- 子 agent 默认**继承顶层 `interrupt_on`**（deepagents 的合并规则：
  `spec.get("interrupt_on", interrupt_on)`）。所以没声明 `permissions` 的子 agent
  （如 `fixer`）执行命令也会走 HITL。声明了 `permissions` 的子 agent
  （`reviewer`）被换成无 shell 的 backend，压根没有 `execute` 工具，不受影响。

---

## 5. 待核实 / 已知缺口

- **危险判定是正则，不是语义分析**。`rm --recursive --force` 这类等价写法
  匹配不上。`normal` 档属于「宁可漏拦」的设计。
- **`manual` 档的体验**：每条命令都问，包括 `ls`、`cat` 这类无害的。
  `normal` 档作为默认就是为这个。
- **前端只给批准 / 拒绝**，没有框架支持的 `edit`（人工改完命令再执行）。
- **拒绝的粒度是整组**：一次挂起含多条命令时，卡片把整组展示，批准或拒绝都是
  整组一起决定，没有逐条挑选的 UI。
- **子 agent 也会触发确认**：`fixer` 这类没声明 `permissions` 的子 agent 执行
  命令同样会挂起等人确认。要不要让子 agent 默认放行，是个待定的产品决策。
