# Codex Account Switcher

Windows 本地 Codex 与 CPA 账号管理器。应用扫描账号文件、检测真实请求能力与额度，安全切换 Codex `auth.json` / `config.toml`，并统一管理 CPA 目录中的 Codex 与 Grok 凭据。

## 主要功能

- Codex 账号库可导入单个文件、多个文件、整个文件夹或粘贴内容；支持 `.json`、`.json.0`、`.jsonl`、`.txt`、`.md`、`.js`、`.mjs`、`.cjs`、`.zip`，兼容一账号一文件、一文件多账号、嵌套 Codex、CPA 扁平凭据和 SubAPI `accounts[].credentials`。普通导入只写应用自己的 `aa`，不会同步到 CPA 共享目录；`aa` 中统一保存为每账号一个无私有 schema、无空字段的 CPA 兼容 JSON。
- 支持直接粘贴混有 Markdown 代码块或说明文字的凭据内容，清洗后提取有效账号。
- 对齐 Sub2API 的 OpenAI 导入方式：浏览器 PKCE 授权、Codex CLI Refresh Token、OpenAI 移动端 Refresh Token、Codex JSON / 裸 Access Token 批量、Personal Access Token（`at-...`）。RT 支持每行一个、带等级标签、Markdown 转义字符和重复项；兑换后保存旋转的新 RT 及对应 `client_id`。
- 所有成功导入或粘贴的凭据都会清洗为统一的一账号一 JSON，保存到程序所在目录的 `aa`；文件名为 `邮箱_等级.json`，无等级时使用 `unknown`。外部源文件只参与一次导入，删除或移动源文件不影响账号库。
- 从 JWT 与文件字段提取邮箱、workspace 和过期时间；每个账号库内部按“提供商 + 规范化邮箱”保持唯一，重复项自动选择 token 更完整、刷新时间更新的凭据。Codex 与 Grok 使用独立命名空间，不会互相覆盖。
- 按 CPA 流程先读取 `wham/usage` 的完整额度与重置时间；额度可用时再调用 Codex compact 做真实验证，已明确耗尽时直接保留准确的 5h/周状态；401 时刷新并完整重试。
- 根据后端 `limit_window_seconds` 动态显示 5 小时、周额度及准确重置时间，并将“5 小时额度耗尽”和“周额度耗尽”保存为不同状态。
- 并发检测全部或选中账号，支持取消；检测中的账号使用稳定状态指示，每完成一个账号立即显示状态、额度、重置时间和刷新时间。
- 检测状态和额度结果持久保存到下次检测；支持按邮箱、workspace、计划、来源和错误搜索，并按账号状态筛选。
- Codex 主库、CPA Codex 与 CPA Grok 的凭据、删除记录和检测状态彼此独立；只有用户主动执行“导出到 CPA”才会把 Codex 主库账号写入 CPA 目录。
- 当前 `auth.json` 匹配到的 Codex 账号会置顶，并使用独立的青色整行高亮、“正在使用”徽标和摘要标记，避免与普通有效状态混淆。
- Codex 账号库、CPA Codex、CPA Grok 和定时切换候选列表支持按可用性/恢复时间、账号等级、状态或邮箱排序；默认把可用账号聚合在前，额度耗尽账号按最早恢复时间排列。
- 支持单击账号行直接累加多选，再次点击取消选择，复选框仍可用于全选和多选，并提供明确的整行选中高亮；删除前二次确认，删除会同步删除或重写 `aa` 中的托管文件，一文件多账号时只移除选中的账号，外部原始文件不受影响。
- Codex 页面统一显示“未测试、有效、已失效、5 小时额度耗尽、周额度耗尽、未知错误”六类状态；只有明确的授权失败才判定为失效，网络、模型和接口异常归入未知错误并保留诊断详情。
- 一键导出 CPA、SubAPI 或官方 Codex `auth.json`：支持每账号一个文件；CPA/Codex 多账号使用 ZIP，SubAPI 使用原生多账号 JSON。
- 原子切换 `auth.json`，只管理 `config.toml` 指定顶层键，保留 custom provider 定义。
- 完整 OAuth 账号使用标准 `chatgpt` 登录；只有 access token 的 CPA Team/K12 账号使用官方 Codex 源码定义的 `chatgptAuthTokens` 外部凭据结构，切换后必须重启 Codex，且 token 过期后不能自动刷新。
- 支持 SubAPI `accounts[].credentials` 中的 ChatGPT Personal Access Token（`at-...` / `personalAccessToken`）。检测时先调用官方 `whoami` 校验并补齐邮箱、workspace 和 Team 等级，再查询额度与发送真实 Codex 请求；切换时写入官方持久格式 `personal_access_token`，不再错误转换为 OAuth `tokens.access_token`。
- 顶部可在浅色和深色工作台主题之间切换，选择保存在本机并在下次启动时恢复。
- 恢复上一个配置或备份中的 API/代理模式；也可保存自定义 API 地址、模型和 Key 并一键切换。地址与模型会记忆，Key 使用 Windows DPAPI 加密且不会回显到 renderer。
- 可按秒设置定时检测当前账号，并自定义候选账号池；仅在凭据失效、无权限、不可刷新或 Codex 额度明确耗尽时自动切换，不会因普通网络错误或模型拥堵误切。可选择切换后自动重启 Codex。
- 点击最小化会保留窗口并正常缩到任务栏；点击关闭才会释放主界面并转入系统托盘，只保留主进程定时任务。托盘可重新打开界面、立即检查账号、开关定时自动切换或彻底退出。
- 按 Codex++ 行为同步历史 rollout、SQLite 可见性与工作区路径，写入前预览、加锁、备份并支持失败回滚；允许 Codex 运行时修复，锁定文件会跳过并提示，完成后自动复检。
- 内部凭据库与切换备份使用 Electron `safeStorage` / Windows DPAPI 加密，renderer 与日志不接收 token。按你的本地管理要求，安装目录 `aa` 中的一账号一文件是可移植的明文凭据 JSON，请像保护原始账号文件一样限制该目录访问。
- 打包版可直接检查 GitHub Release；安装包下载到当前 Windows 用户实际的“下载”文件夹，经 SHA-512 校验后覆盖安装，并在安装结束后自动删除、重启应用并显示安装结果。安装失败时会重新打开原版本，并在 `%TEMP%\CodexAccountSwitcher-update.log` 保留诊断信息。
- 安装或升级时只按安装目录精确查找并关闭旧程序，不会把下载目录中的安装器自身当成应用进程。应用内更新会按已安装 EXE 的完整路径等待所有旧进程，超时后只结束该路径对应的进程再继续覆盖安装。
- 应用启用 Windows 单实例锁；重复启动会聚焦已有窗口。

## CPA 账号管理

- CPA 页面包含 Codex 和 Grok 两个独立子页。两类账号共用 `E:\home\<当前用户名>\.cli-proxy-api`，但测试全部、测试选中、实时进度、取消和筛选互不串台，CPA 页面也不会写入 `.codex`。
- 只有 CPA 页面中的明确管理操作或 Codex 账号库的“直接导出到 CPA”会写共享目录；直接导出按提供商与邮箱去重，已有账号会跳过。
- 支持单选、多选或批量把规范托管文件从 `.json` 改为 `.json.0`，使 CPA 暂停读取；再次启用会恢复 `.json`。只有周额度耗尽会在测试后自动停用，5 小时额度耗尽不会；后续测试发现周额度恢复时会自动启用。
- CPA 目录扫描、token 刷新和启停操作会把同一邮箱意外并存的 `.json` / `.json.0` 副本收敛为一个统一 CPA JSON；多账号文件会拆分成一账号一文件，字段标签误混入 token 值的旧文件会在解析后修复。共享目录之外的导入源文件不会被删除或改写。
- 支持 CPA/CLIProxyAPI 扁平 xAI JSON、Sub2API `accounts[].credentials` 批量导出、对象数组、JSONL、文本、Markdown、静态 JS 和 ZIP。
- Grok 与 Codex 分开后均优先按规范化邮箱去重；无邮箱时才回退到稳定 subject 身份。重复导入会合并较新、较完整的 token，不会产生重复文件。
- Grok 扫描与导入保持非破坏：不会删除或改写共享目录之外的用户源文件；只有二次确认删除账号时才移除与凭证指纹完全匹配的托管单账号文件。
- 按 CPA 与 Sub2API 的实现通过 `auth.x.ai/oauth2/token` 刷新 OAuth，再读取 Grok CLI 周/月 billing，最后以 CPA 相同的 Grok CLI 身份头和 SSE 流式 Responses 请求验证真实能力。503 等瞬时上游错误会短重试且不会误判失效，429 或明确的 `free-usage-exhausted` 才判额度耗尽。
- 支持搜索、状态筛选、额度/等级/状态排序、单选/多选、右键检测/复制/导出/删除、二次确认删除、CPA 一账号一文件导出和 Sub2API 多账号合并导出。
- CPA 共享目录中的凭据是供 CPA/Sub2API 直接使用的明文 OAuth JSON，请限制该目录访问。应用状态文件和 renderer 数据不包含 token。

## CPA 与 SubAPI 导入导出

| 格式 | 每账号一文件 | 多账号单文件 |
| --- | --- | --- |
| CPA / CLIProxyAPI | 标准扁平 `type: "codex"` JSON | ZIP，内部每账号一个标准 CPA JSON |
| SubAPI / Sub2API | 每个文件均为有效 `sub2api-data` v1 | 原生 `accounts[]` 合并 JSON |
| Codex | 每账号一个官方 `auth.json` 结构 | ZIP，内部每账号一个独立 auth JSON |

CPA 本身不接受顶层账号数组，因此合并导出使用 ZIP，避免生成看似可用但 CPA 无法导入的非标准 JSON。

Sub2API 导出保留 `accounts[].credentials` 嵌套结构；CPA 导出转为一账号一个扁平 `type: "codex"` 文件；Codex 导出根据 OAuth、PAT 或外部 access-only Team/K12 账号生成对应认证结构。

## 开发与验证

```powershell
npm install
npm run dev
npm run verify
npm run test:e2e
npm run package:win
```

构建产物位于 `release`：

- `Codex-Account-Switcher-Setup-0.10.1.exe`：安装版
- `Codex-Account-Switcher-Portable-0.10.1.exe`：便携版

## 默认路径

- 导入文件默认目录：上次选择的目录；新安装默认 `E:\home\<当前用户名>\.cli-proxy-api`
- 应用托管凭证库：安装版为安装目录下的 `aa`，便携版为 EXE 同目录下的 `aa`
- CPA Codex/Grok 共享凭证库：默认 `E:\home\<当前用户名>\.cli-proxy-api`
- Codex 凭据：自动查找 `CODEX_HOME` 或当前用户 `.codex\auth.json`
- Codex 配置：与自动发现的凭据位于同一个 `.codex\config.toml`

找不到 `.codex` 时应用会提示选择或创建目录；目录存在但没有 `auth.json` 时，首次切换会原子创建。所有路径均可在设置中修改。导入目录仅作为文件选择器的默认位置，应用不会删除、重命名或覆盖任何外部源文件。

只有 access token、没有完整 `id_token` 与 `refresh_token` 的 CPA Team/K12 账号仍可检测额度、持久管理、导出和切换。切换器会写入 `auth_mode: "chatgptAuthTokens"`、以 access JWT 作为外部 ID token，并保留 workspace ID；该模式来自官方 Codex 的外部凭据实现，但不会持久刷新，切换后需重启 Codex。标准 OAuth 凭据仍由 Codex 正常自动刷新。

`at-...` Personal Access Token 是另一种认证类型，不使用上面的 OAuth 外部 token 结构。应用会按官方 Codex 当前源码写入 `{ "OPENAI_API_KEY": null, "personal_access_token": "at-..." }`；Codex 通过该字段自动识别 `personalAccessToken` 模式。代理平台能使用这类 token、但把它放进 `tokens.access_token` 后 Codex 显示未登录，正是因为认证类型和持久化字段不匹配。

## 历史会话修复

修复操作只修改 `session_meta.payload.model_provider`、Codex SQLite `threads` 索引和相关工作区路径，不修改消息正文。Codex 运行时也可执行；被占用的文件会跳过并列出数量。应用在 `.codex\backups_state\account-switcher-provider-sync` 创建可审计备份，并在写入后重新扫描验证结果。

包含其他供应商 `encrypted_content` 的会话会显示警告；这类内容可能无法在不同供应商或账号间继续或压缩。
