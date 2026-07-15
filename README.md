# Codex Account Switcher

Windows 本地 Codex 账号切换器。应用扫描账号文件、检测真实 Codex 请求能力与额度，安全切换 `auth.json` / `config.toml`，并可修复切换供应商后不可见的历史会话。

## 主要功能

- 递归扫描或导入单个文件、多个文件、整个文件夹，支持 `.json`、`.jsonl`、`.txt`、`.md`、`.js`、`.mjs`、`.cjs`、`.zip`，兼容一账号一文件、一文件多账号、嵌套 Codex、CPA 扁平凭据和 SubAPI `accounts[].credentials`。
- 支持直接粘贴混有 Markdown 代码块或说明文字的凭据内容，清洗后提取有效账号。
- 所有成功导入或粘贴的凭据都会清洗为统一的一账号一 JSON，保存到程序所在目录的 `aa`；文件名为 `邮箱_等级.json`，无等级时使用 `unknown`。外部源文件只参与一次导入，删除或移动源文件不影响账号库。
- 从 JWT 与文件字段提取邮箱、workspace 和过期时间，按 subject、邮箱与 workspace 去重。
- 按 CPA 流程先读取 `wham/usage` 的完整额度与重置时间，再调用 Codex compact 做真实验证；401 时刷新并完整重试。
- 根据后端 `limit_window_seconds` 动态显示 5 小时、周额度及准确重置时间，并将“5 小时额度耗尽”和“周额度耗尽”保存为不同状态。
- 并发检测全部或选中账号，支持取消；检测中的账号使用稳定状态指示，每完成一个账号立即显示状态、额度、重置时间和刷新时间。
- 检测状态和额度结果持久保存到下次检测；支持按邮箱、workspace、计划、来源和错误搜索，并按账号状态筛选。
- 支持单选、全选和多选账号，删除前二次确认；删除会同步删除或重写 `aa` 中的托管文件，一文件多账号时只移除选中的账号，外部原始文件不受影响。
- 按完整账号行显示有效、5 小时耗尽、周额度耗尽、工作区停用、无权限、失效、不可刷新、模型、网络和文件状态配色。
- 一键导出 CPA 或 SubAPI：每账号一个文件，或 CPA 多账号 ZIP / SubAPI 原生多账号 JSON。
- 原子切换 `auth.json`，只管理 `config.toml` 指定顶层键，保留 custom provider 定义。
- 完整 OAuth 账号使用标准 `chatgpt` 登录；只有 access token 的 CPA Team/K12 账号使用官方 Codex 源码定义的 `chatgptAuthTokens` 外部凭据结构，切换后必须重启 Codex，且 token 过期后不能自动刷新。
- 恢复上一个配置或最初保存的 API/代理模式。
- 可按秒设置定时检测当前账号，并自定义候选账号池；仅在凭据失效、无权限、不可刷新或 Codex 额度明确耗尽时自动切换，不会因普通网络错误或模型拥堵误切。可选择切换后自动重启 Codex。
- 关闭窗口或点击最小化会释放主界面并转入系统托盘，只保留主进程定时任务；托盘可重新打开界面、立即检查账号、开关定时自动切换或彻底退出。
- 按 Codex++ 行为同步历史 rollout、SQLite 可见性与工作区路径，写入前预览、加锁、备份并支持失败回滚；允许 Codex 运行时修复，锁定文件会跳过并提示，完成后自动复检。
- 凭据使用 Electron `safeStorage` / Windows DPAPI 加密保存，renderer 与日志不接收 token。
- 打包版可直接检查 GitHub Release、下载最新安装包并退出覆盖安装。
- 应用启用 Windows 单实例锁；重复启动会聚焦已有窗口。安装或更新时会检测安装版和便携版进程，提示关闭后再覆盖文件。

## CPA 与 SubAPI 导入导出

| 格式 | 每账号一文件 | 多账号单文件 |
| --- | --- | --- |
| CPA / CLIProxyAPI | 标准扁平 `type: "codex"` JSON | ZIP，内部每账号一个标准 CPA JSON |
| SubAPI / Sub2API | 每个文件均为有效 `sub2api-data` v1 | 原生 `accounts[]` 合并 JSON |

CPA 本身不接受顶层账号数组，因此合并导出使用 ZIP，避免生成看似可用但 CPA 无法导入的非标准 JSON。

## 开发与验证

```powershell
npm install
npm run dev
npm run verify
npm run test:e2e
npm run package:win
```

构建产物位于 `release`：

- `Codex-Account-Switcher-Setup-0.5.1.exe`：安装版
- `Codex-Account-Switcher-Portable-0.5.1.exe`：便携版

## 默认路径

- 导入文件默认目录：上次选择的目录，新安装默认当前用户主目录
- 应用托管凭证库：安装版为安装目录下的 `aa`，便携版为 EXE 同目录下的 `aa`
- Codex 凭据：自动查找 `CODEX_HOME` 或当前用户 `.codex\auth.json`
- Codex 配置：与自动发现的凭据位于同一个 `.codex\config.toml`

找不到 `.codex` 时应用会提示选择或创建目录；目录存在但没有 `auth.json` 时，首次切换会原子创建。所有路径均可在设置中修改。导入目录仅作为文件选择器的默认位置，应用不会删除、重命名或覆盖任何外部源文件。

只有 access token、没有完整 `id_token` 与 `refresh_token` 的 CPA Team/K12 账号仍可检测额度、持久管理、导出和切换。切换器会写入 `auth_mode: "chatgptAuthTokens"`、以 access JWT 作为外部 ID token，并保留 workspace ID；该模式来自官方 Codex 的外部凭据实现，但不会持久刷新，切换后需重启 Codex。标准 OAuth 凭据仍由 Codex 正常自动刷新。

## 历史会话修复

修复操作只修改 `session_meta.payload.model_provider`、Codex SQLite `threads` 索引和相关工作区路径，不修改消息正文。Codex 运行时也可执行；被占用的文件会跳过并列出数量。应用在 `.codex\backups_state\account-switcher-provider-sync` 创建可审计备份，并在写入后重新扫描验证结果。

包含其他供应商 `encrypted_content` 的会话会显示警告；这类内容可能无法在不同供应商或账号间继续或压缩。
