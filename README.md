# yimu-mcp

一木记账（yimubill.com）的 MCP 服务：把一木记账网页版的能力封装成 AI 可调用的工具，
在支持 MCP 的客户端里就能直接读写你的账本。

## 能做什么

- **三种登录方式**：扫码登录（推荐，手机一扫即可）、邮箱密码登录、直接配置登录令牌
- **看账**：全量/增量同步账单、按账本分页查询、账单总数、删除记录
- **管账**：新增、更新、删除账单、资产、账本、标签、转账、借贷、分类、报销、退款、附件
- **辅助能力**：一句话记账解析（「午饭 35」自动识别金额和分类）
- **扫码方便**：二维码直接显示在对话或终端里，不用打开图片文件

## 快速开始

需要 Node ≥ 23.4 或 Bun ≥ 1.x。

安装（使用个人 fork）：

```bash
git clone https://github.com/Yohmien/yimu-mcp.git
cd yimu-mcp
npm ci --ignore-scripts
npm run build
```

Codex 直接使用构建后的 `dist/index.js`，无需全局安装 npm 包。

本地验证：

```bash
npm run build                 # Node
# 或
bun install && bun run dev      # Bun，直接运行，无需构建
```

## 配置

所有设置通过环境变量提供，账号信息不进仓库：

| 环境变量 | 说明 |
|---|---|
| `YIMU_TOKEN` | 登录令牌 JWT（登录后获得，优先级最高） |
| `YIMU_EMAIL` / `YIMU_PASSWORD` | 账号邮箱/密码（可选：未配 TOKEN 时启动自动登录；`login_email` 只从这里读取密码） |
| `YIMU_USER_ID` | 用户 ID（部分接口需要，登录后自动获取） |
| `YIMU_BASE_URL` | API 地址，默认 `https://yimubill.com/api`；只允许官方 HTTPS 地址或本地回环地址 |
| `YIMU_QR_DIR` | 二维码保存目录，默认系统临时目录 |
| `YIMU_TOKEN_DB` | 加密登录状态数据库路径，默认 `~/.codex/mcp/yimu-mcp/auth.sqlite` |
| `YIMU_TOKEN_STORE_KEY` | AES-256-GCM 密钥；未配置时不持久化 JWT |

优先使用扫码登录；如使用 `YIMU_TOKEN`，只通过本地环境变量传入，不要写入 Codex 配置文件或聊天内容。

## 接入 MCP 客户端

Codex 配置（`~/.codex/config.toml`）：

```toml
[mcp_servers.yimu]
command = "node"
args = ["C:/Users/你的用户名/.codex/mcp/yimu-mcp/dist/index.js"]
env_vars = ["YIMU_TOKEN", "YIMU_USER_ID", "YIMU_TOKEN_STORE_KEY"]
default_tools_approval_mode = "writes"
```

只有本地环境中已设置的变量才会传给服务；不要把 `YIMU_TOKEN_STORE_KEY` 的实际值写入 Codex 配置或仓库。写入和删除工具应始终由 Codex 请求确认。

### 固定登录流程（Codex）

1. 设置 `YIMU_TOKEN_STORE_KEY` 后完全退出并重启 Codex，使 `yimu` MCP 进程继承该环境变量。
2. 在 Codex 对话中调用固定工具 `login_qr_start`，扫描返回的二维码。
3. 调用 `login_qr_poll`（传入 `session_id`，`timeout` 可设为 120）完成登录。
4. 登录成功后服务自动将令牌加密保存到 `YIMU_TOKEN_DB`；以后重启 Codex 会自动恢复。

整个流程由已注册的 `yimu` MCP 服务完成，不需要临时 Node/Python 文件或手工复制 JWT。

## 登录

1. **扫码登录（推荐）**：调用 `login_qr_start`，二维码直接显示在对话或终端里；
   手机打开一木记账 App，首页 → 更多 → 扫一扫，扫完调用 `login_qr_poll` 等待登录结果。
2. **邮箱密码登录**：调用 `login_email`，可传邮箱；密码只从环境变量 `YIMU_PASSWORD` 读取，
   MCP 不接收密码参数，也不会返回 JWT。
3. **JWT 直配**：在环境变量里配好 `YIMU_TOKEN`，启动即已登录。

> 配了 `YIMU_EMAIL` / `YIMU_PASSWORD` 而未配 TOKEN 时，服务启动会自动登录获取 JWT，
> AI 即可直接读写账本；令牌过期后随时调 `login_email`（无参）重新登录。
> 配置 `YIMU_TOKEN_STORE_KEY` 后，登录状态会以 AES-256-GCM 密文保存到 SQLite；未配置密钥时只保留在内存。
> 三种方式互不影响：二维码/邮箱登录获得的 JWT 会覆盖配置值并更新本地密文。

## 安全说明

- 密码仅从环境变量读取，提交时 AES-128-ECB 加密，不落盘、不进入 MCP 参数；`--print-config` 不打印凭据明文。
- 登录成功只返回 `token_set` 和用户 ID，JWT 保留在服务进程内存中，不进入模型上下文。
- SQLite 只保存 AES-256-GCM 密文、随机 nonce 和认证标签；`YIMU_TOKEN_STORE_KEY` 不写入数据库、仓库或 Codex 配置。
- 令牌收到 401/403 或明确失效响应时会清除内存状态和本地密文；丢失密钥只能重新扫码登录。
- API 基址固定限制为 `https://yimubill.com` 或本地回环地址，且请求不跟随重定向，避免 token 被转发到其他主机。
- 不提供通用 API、STS 凭证或任意本地图片读取工具；写入/删除工具带有 MCP 权限提示标记。

## 工具一览

- **登录与账号**：`login_qr_start` `login_qr_poll` `login_email` `get_me` `auth_status`
- **查询**：`sync_pull`（增量同步，默认返回摘要：计数/收支合计/最近明细/分类Top）、`get_bill_count`（账单总数）、
  `get_book_bills`（账本账单分页，精简账单+收支小计）、
  `get_assets`（资产，仅业务字段）、`get_asset_modules`（资产/定期/理财/借贷/预算定向摘要）、`get_currency`（币种）、`get_category_info`（分类）、
  `get_share_accounts`（共享账本）、`get_account_members`（账本成员）、`get_delete_history`（删除记录）
- **记账**：`save_bill` / `save_bills`（单条/批量新增或更新）、`delete_bill`（删除）
- **其他实体**：`save_asset` `save_account_book` `save_tag` `save_transfer` `save_lend`
  `save_parent_category` `save_child_category` `save_reimbursement` `save_refund`
  `save_bill_file` `save_bill_import` `save_asset_history`（对应删除用 `delete_*`）
- **辅助**：`parse_bill_text`（一句话记账解析）

## License

MIT
