# Codex Account Switcher

Windows 本地 Codex 账号切换器。应用扫描账号文件、检测真实 Codex 请求能力与额度，安全切换 `auth.json` / `config.toml`，并可修复切换供应商后不可见的历史会话。

## 主要功能

- 递归扫描或导入单个文件、多个文件、整个文件夹，支持 `.json`、`.jsonl`、`.txt`、`.md`、`.js`、`.mjs`、`.cjs`、`.zip`，兼容一账号一文件、一文件多账号、嵌套 Codex、CPA 扁平凭据和 SubAPI `accounts[].credentials`。
- 支持直接粘贴混有 Markdown 代码块或说明文字的凭据内容，清洗后提取有效账号。
- 所有成功导入的源文件都会原样复制到 `%APPDATA%\Codex Account Switcher\aa`；外部源文件只参与一次导入，后续同步、管理和删除均以 `aa` 与加密凭据库为准。旧版 `imports` 会自动迁移。
- 从 JWT 与文件字段提取邮箱、workspace 和过期时间，按 subject、邮箱与 workspace 去重。
- 按 CPA 流程先读取 `wham/usage` 的完整额度与重置时间，再调用 Codex compact 做真实验证；401 时刷新并完整重试。
- 根据后端 `limit_window_seconds` 动态显示 5 小时、周额度及准确重置时间，并将“5 小时额度耗尽”和“周额度耗尽”保存为不同状态。
- 并发检测全部或选中账号，支持取消；检测中的账号使用稳定状态指示，每完成一个账号立即显示状态、额度、重置时间和刷新时间。
- 检测状态和额度结果持久保存到下次检测；支持按邮箱、workspace、计划、来源和错误搜索，并按账号状态筛选。
- 支持单选、全选和多选账号，删除前二次确认；删除会同步删除或重写 `aa` 中的托管文件，一文件多账号时只移除选中的账号，外部原始文件不受影响。
- 按完整账号行显示有效、额度耗尽、无权限、失效、不可刷新、模型、网络和文件状态配色。
- 一键导出 CPA 或 SubAPI：每账号一个文件，或 CPA 多账号 ZIP / SubAPI 原生多账号 JSON。
- 原子切换 `auth.json`，只管理 `config.toml` 指定顶层键，保留 custom provider 定义。
- 完整 OAuth 账号使用标准 `chatgpt` 登录；只有 access token 的 CPA/Team 账号可检测和导出，但会标记为“仅用于检测”，不会生成官方 Codex 无法读取的伪 `auth.json`。
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

- `Codex-Account-Switcher-Setup-0.4.0.exe`：安装版
- `Codex-Account-Switcher-Portable-0.4.0.exe`：便携版

## 默认路径

- 账号目录：`E:\home\lee\.cli-proxy-api`
- 应用托管凭证库：`%APPDATA%\Codex Account Switcher\aa`
- Codex 凭据：`%USERPROFILE%\.codex\auth.json`
- Codex 配置：`%USERPROFILE%\.codex\config.toml`

所有 Codex 路径均可在设置中修改。账号目录仅作为导入对话框的默认位置；应用不会删除、重命名或覆盖该目录及其他外部源文件。

只有 access token、没有完整 `id_token` 与 `refresh_token` 的 CPA/Team 账号可检测额度、持久管理和导出，但不能通过文件方式登录官方 Codex。官方 `auth.json` 切换只对完整 OAuth 凭据开放，完整凭据仍由 Codex 正常自动刷新。

## 历史会话修复

修复操作只修改 `session_meta.payload.model_provider`、Codex SQLite `threads` 索引和相关工作区路径，不修改消息正文。Codex 运行时也可执行；被占用的文件会跳过并列出数量。应用在 `.codex\backups_state\account-switcher-provider-sync` 创建可审计备份，并在写入后重新扫描验证结果。

包含其他供应商 `encrypted_content` 的会话会显示警告；这类内容可能无法在不同供应商或账号间继续或压缩。
