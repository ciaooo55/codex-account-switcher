# Codex Account Switcher

Windows 本地 Codex 账号切换器。应用扫描账号文件、检测真实 Codex 请求能力与额度，安全切换 `auth.json` / `config.toml`，并可修复切换供应商后不可见的历史会话。

## 主要功能

- 递归扫描或导入 `.json`、`.jsonl`、`.txt`、`.js`、`.mjs`、`.cjs`、`.zip`，兼容嵌套 Codex、CPA 扁平凭据、SubAPI `accounts[].credentials`、对象数组、包装对象、键值文本和静态 JS 导出格式。
- 支持直接粘贴混有 Markdown 代码块或说明文字的凭据内容，清洗后提取有效账号。
- 手动导入的源文件会原样归档到应用数据目录的 `imports` 文件夹，保留扩展名且不修改原文件。
- 从 JWT 与文件字段提取邮箱、workspace 和过期时间，按 subject、邮箱与 workspace 去重。
- 按 CPA 流程先调用 Codex compact 做真实验证，401 时刷新并从头重试，再读取 `wham/usage`。
- 根据后端 `limit_window_seconds` 动态显示 5 小时、周额度及准确重置时间。
- 并发检测全部或选中账号，支持取消；账号开始检测时整行显示动画，每完成一个账号立即显示状态、额度、重置时间和刷新时间。
- 按完整账号行显示有效、额度耗尽、无权限、失效、不可刷新、模型、网络和文件状态配色。
- 一键导出 CPA 或 SubAPI：每账号一个文件，或 CPA 多账号 ZIP / SubAPI 原生多账号 JSON。
- 原子切换 `auth.json`，只管理 `config.toml` 指定顶层键，保留 custom provider 定义。
- 恢复上一个配置或最初保存的 API/代理模式。
- 按 Codex++ 行为同步历史 rollout、SQLite 可见性与工作区路径，写入前预览、加锁、备份并支持失败回滚。
- 凭据使用 Electron `safeStorage` / Windows DPAPI 加密保存，renderer 与日志不接收 token。
- 打包版可直接检查 GitHub Release、下载最新安装包并退出覆盖安装。

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

- `Codex-Account-Switcher-Setup-0.2.0.exe`：安装版
- `Codex-Account-Switcher-Portable-0.2.0.exe`：便携版

## 默认路径

- 账号目录：`E:\home\lee\.cli-proxy-api`
- Codex 凭据：`%USERPROFILE%\.codex\auth.json`
- Codex 配置：`%USERPROFILE%\.codex\config.toml`

所有 Codex 路径均可在设置中修改。应用不会删除、重命名或覆盖源账号文件；手动导入只会在应用数据目录额外保存一份托管副本。

## 历史会话修复

修复操作只修改 `session_meta.payload.model_provider`、Codex SQLite `threads` 索引和相关工作区路径，不修改消息正文。应用要求官方 Codex / ChatGPT 完全退出后才能写入，并在 `.codex\backups_state\account-switcher-provider-sync` 创建可审计备份。

包含其他供应商 `encrypted_content` 的会话会显示警告；这类内容可能无法在不同供应商或账号间继续或压缩。
