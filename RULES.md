# QQ 桥接权限与安全规则（RULES）

## 运行模式（QQ 桥接四模式）

模式由 DSH WebUI **设置页 → 插件设置（qq-mode）** 控制（DSH 重启后生效），
也可回退到 `qq-bridge/state/mode.json`（`{"mode": "reserved2"}`）临时指定。
桥接每 5 秒读取一次，切换即时生效（新会话生效，旧会话可 `/reset` 重建）。
全新安装运行 `scripts/setup-dsh.mjs` 后，DSH 设置与本地兜底默认均为 `reserved2`；若已存在 `state/mode.json` 或 DSH 设置旧值，脚本不会覆盖。

| 模式 | 允许通道 | agent preset | 用途 |
| --- | --- | --- | --- |
| `chat` | 白名单群 + 白名单私聊 | qq-chat（安全聊天） | 日常聊天 |
| `closed-agent` | **仅** 私聊 ownerQQ | router-standard（完整工具） | 你在 QQ 私聊里操控 DSH |
| `reserved`（一代仿真） | 暂同 chat | qq-chat | 仿真群友：观望/活跃/试探/退场状态机，选择性参与并主动收尾 |
| `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后默认） | 暂同 chat | qq-chat-v2 | 文本不自动转发，AI 通过工具自主看消息/发言/等待/设置唤醒与潜水 |

> ⚠️ `closed-agent` 模式下 owner 私聊 agent 拥有**完整本地工具**（router-standard），
> 这是有意为之（QQ 远程操控 DSH）。该模式只放行 owner 私聊，群友完全无法触达；
> 切换回 `chat` 后，owner 私聊也回到 qq-chat 安全预设。

## 权限分层

| 主体 | 通道 | 权限 |
| --- | --- | --- |
| **管理员（ownerQQ，控制台或 DSH 设置页可配置）** | QQ 群/私聊 | 正常聊天 + **管理命令由桥接硬执行**（不经过模型）：`/role <角色名>` 切人格、`/role off` 清除、`/silent` 静默、`/active` 恢复、`/reset`、`/status`；消息自动带【管理员】标记 |
| **群友** | QQ 群 | **仅正常聊天**。控制词、`/` 管理命令被桥接拦截；静默模式下消息不投递给 agent |
| **管理员** | **DSH WebUI** | **最高权限**：控制模式（设置页 qq-mode 卡片）、控制角色/静默（写 `state/current-role.json`）、完整 DSH 工具（含本地操作）、查看 QQ 活动日志（`state/qq-activity.log`）、直接打开「QQ 聊天」工作区会话对话 |
| **QQ 会话 agent（chat 模式）** | — | 最低权限面（见下） |

## QQ 会话 agent 的硬边界

1. **无本地工具**：qq-chat / qq-chat-v2 预设不挂载 bash/pwsh、文件读写、子代理、工作流——群友无论如何诱导，agent 物理上无法操作本机。
2. **QQ 动作安全子集**：只允许 `mcp__snowluma__*`、`mcp__snowluma-host__*` 两个命名空间下的工具，以及 `ask_user_question` / `todo_write` 和只读浏览器工具（`browser_open` / `browser_content` / `browser_snapshot` / `browser_screenshot` 等，见 `qq-tool-restrict.mjs` 的 `BROWSER_DENY` 白名单）；其他工具（含 `dev_*` 开发/管理工具）在执行期会被 `qq-tool-restrict.mjs` 拒绝。QQ 动作无禁言、踢人、文件上传下载等管理操作；管理员工具会话的独立文件传输例外见下文，不注册到群聊共用 MCP。
3. **只读联网查询**：`qq-chat-v2` 预设已关闭 DSH 内置 `tool-web` 的 `search` / `fetch`，联网统一走只读浏览器（`dsh-builtin-browser`）——`browser_open` 打开搜索页/文章链接、`browser_content` 读正文，全部为只读：无点击/输入/填表/执行 JS/写本地文件/导出登录态。不暴露本地文件、命令执行、写操作。
4. **发送强制白名单**：所有发送类工具（`qq_send_group_message` / `qq_send_private_message` / `qq_send_message` / `qq_send_burst` / `qq_reply` / `qq_send_poke` / `qq_send_sticker` 等）的目标必须命中 `config.json` 的 `allow.groups` / `allow.private`，否则拒绝执行。
5. **发送禁令（模型层）**：persona 明确规定只有「管理端明确指示」或「【管理员】标记的明确要求」才可使用发送工具；禁止写"我已回复/消息已发送（message_id）"类汇报。
6. **回复审计（桥接层硬拦截）**：agent 回复文本若包含本机路径（`C:\`、`/home/` 等）或凭据特征（token/password/secret/api key 等）→ **整条拦截不发送**，并告知"被安全策略拦截"。
7. **人格由桥接注入**：角色设定来自 `state/current-role.json` + `roles/<角色>.md`，桥接注入到消息；群友口头要求改角色无效（桥接直接拦截），agent 也无文件工具自行更改。
8. **静默模式**：`current-role.json` 的 `mode: "silent"` 时，群友消息不再投递给 agent（仅记录日志），只有管理员消息可对话。

## 黑话 / 网络用语学习与迭代

- 桥接会把普通群聊消息放入滚动窗口（`state/slang.json` 的候选来源），攒够 `slang.extractMinMessages` 条后交给独立 DSH 学习会话提取“疑似黑话”。
- 候选默认 **不自动转正**：DSH 可联网搜索生成含义/用法/示例，但最终必须由管理员在控制台「黑话管理」里 **确认 / 拒绝 / 编辑 / 删除**。
- 只有 `status: confirmed` 且含义非空的词条会被注入 QQ 聊天 agent 的 prompt（`【群聊黑话表】`），且按出现次数排序、最多 `slang.injectMax` 条。
- 学习会话与 QQ 会话隔离：学习任务的输出不会发到 QQ；它只读消息文本，不执行本地操作。
- 学习会话不会向用户提问/请求审批，桥接会自动跳过这类请求，避免阻塞学习任务。
- 联网考究结果仅作为候选解释，不视为权威；控制台可随时修改或拒绝。
- 敏感信息/路径/凭据仍走统一审计；黑话库仅存白名单群内消息的文本证据，控制台可删除。

## 管理员操作手册

### 切换角色 / 模式（两种途径，均为硬性机制）

**途径 A：QQ 群内管理命令**（桥接直接执行，不经过模型判断）：
```
/role 傲娇助手    # 切换角色（roles/傲娇助手.md）
/role off         # 清除角色
/silent           # 静默模式（群友消息不回复）
/active           # 恢复正常
/status           # 查看会话/白名单/角色/模式状态
/reset            # 重置当前 QQ 会话上下文
```

**途径 A2：管理员聊天内自动角色切换**（仅 ownerQQ，桥接直接执行，同样不经模型判断）：
管理员在任意 QQ 会话里直接发：
```
进入角色扮演：纯良鲸鱼娘   # 或「切换角色：X」「设置角色 X」「把角色改成 X」「换成角色 X」
退出角色扮演              # 或「关闭角色扮演」「清除角色」「恢复原样」「不演了」
```
桥接会自动写 `state/current-role.json` 并让角色卡在下一轮重新注入；角色名写错会提示可用角色列表。

**途径 B：DSH WebUI**：
- 在 GUI 会话里对我说「给 QQ 机器人设置角色：傲娇助手」/「清除角色」/「开启静默模式」，我写 `state/current-role.json`
- 或手动编辑 `qq-bridge/state/current-role.json`：
  ```json
  { "role": "傲娇助手", "mode": "active" }   // active=正常, silent=静默
  ```
- 角色文件放 `qq-bridge/roles/<角色名>.md`（格式见 `roles/README.md`）

### 查看 QQ 活动

- WebUI 里直接打开「QQ 聊天」工作区的会话，可完整查看每次交互（含工具调用）
- 桥接还会把每次收发写入 `qq-bridge/state/qq-activity.log`（最近 500 行），GUI 会话的 agent 可读取汇报

### 在 WebUI 与 QQ 机器人对话

打开「QQ 聊天」工作区里的会话即可直接对话（DSH 原生）；你的消息只进该会话，**不会自动发到 QQ 群**——需要发群时明确说"发到群里"，agent 按【管理员】指示使用发送工具（受白名单限制）。

## 管理员私聊文件传输

- 仅 ownerQQ 且 dsh.ownerTools=true 的私聊可收发，不开放群聊或普通私聊；发送经独立控制台令牌接口 `/api/owner/send-file`，任何 x-agent-token 请求都拒绝。
- 管理员完整本地工具可运行 `scripts/send-owner-file.mjs` 发送工作区内产物；共用 snowluma-safe MCP 不提供文件上传工具，避免群友借管理员目标绕过隔离。
- 最大 20 MiB；发送真实路径必须在管理员工作区内，阻止配置/凭据/内部状态文件；接收仅从网关解析的文件事件下载，使用 SSRF 防护，保存到 `QQ收件箱/` 且不自动执行。
- 用法、限制及验证范围见 `docs/文件传输.md`。

## 事故与兜底

- 群友诱导 agent 失败时，agent 会按 persona 规则拒绝；即使被诱导成功，最坏后果也只是**发一条白名单内的消息**——本地操作在工具面上不存在，敏感信息会被回复审计拦截。
- 想彻底关闭机器人：停止桥接进程（start.bat 窗口 Ctrl+C）或 SnowLuma。
- 修改白名单/角色/owner 后保存即热更新（控制台写入 config.json / state/*.json 后即时生效）；修改 preset（`~/.dsh/.agent-presets/qq-chat*/`）后重启 DSH 生效。
- ⚠️ 桥接只能运行一个实例：消息异常时先检查任务管理器里是否有多余的 `node ...bridge.js`。
