# Codex Account Switcher

Windows 本地 Codex 账号切换器。应用扫描账号文件、检测真实 Codex 请求能力与额度，安全切换 `auth.json` / `config.toml`，并可修复切换供应商后不可见的历史会话。

## 主要功能

- 扫描或导入 `.json`、`.txt`、`.js`，兼容嵌套 Codex、CLIProxyAPI、JSONL、键值文本和静态 JS 导出格式。
- 从 JWT 与文件字段提取邮箱、workspace 和过期时间，按 subject、邮箱与 workspace 去重。
- 按 CPA 流程先调用 Codex compact 做真实验证，401 时刷新并从头重试，再读取 `wham/usage`。
- 根据后端 `limit_window_seconds` 动态显示 5 小时、周额度及准确重置时间。
- 并发检测全部或选中账号，支持取消、实时进度和细分错误状态。
- 原子切换 `auth.json`，只管理 `config.toml` 指定顶层键，保留 custom provider 定义。
- 恢复上一个配置或最初保存的 API/代理模式。
- 按 Codex++ 行为同步历史 rollout、SQLite 可见性与工作区路径，写入前预览、加锁、备份并支持失败回滚。
- 凭据使用 Electron `safeStorage` / Windows DPAPI 加密保存，renderer 与日志不接收 token。

## 开发与验证

```powershell
npm install
npm run dev
npm run verify
npm run test:e2e
npm run package:win
```

构建产物位于 `release`：

- `Codex Account Switcher Setup 0.1.0.exe`：安装版
- `Codex Account Switcher 0.1.0.exe`：便携版

## 默认路径

- 账号目录：`E:\home\lee\.cli-proxy-api`
- Codex 凭据：`%USERPROFILE%\.codex\auth.json`
- Codex 配置：`%USERPROFILE%\.codex\config.toml`

所有路径均可在设置中修改。应用不会删除、重命名或覆盖源账号文件。

## 历史会话修复

修复操作只修改 `session_meta.payload.model_provider`、Codex SQLite `threads` 索引和相关工作区路径，不修改消息正文。应用要求官方 Codex / ChatGPT 完全退出后才能写入，并在 `.codex\backups_state\account-switcher-provider-sync` 创建可审计备份。

包含其他供应商 `encrypted_content` 的会话会显示警告；这类内容可能无法在不同供应商或账号间继续或压缩。
