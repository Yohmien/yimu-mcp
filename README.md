# yimu-mcp

一木记账（yimubill.com）的 MCP 服务：把一木记账网页版的能力封装成 AI 可调用的工具，
在支持 MCP 的客户端里就能直接读写你的账本。

## 能做什么

- **三种登录方式**：扫码登录（推荐，手机一扫即可）、邮箱密码登录、直接配置登录令牌
- **看账**：全量/增量同步账单、按账本分页查询、账单总数、删除记录
- **管账**：新增、更新、删除账单、资产、账本、标签、转账、借贷、分类、报销、退款、附件
- **辅助能力**：一句话记账解析（「午饭 35」自动识别金额和分类）、对象存储凭证、通用接口请求
- **扫码方便**：二维码直接显示在对话或终端里，不用打开图片文件

## 快速开始

需要 Node ≥ 23.4 或 Bun ≥ 1.x。

安装（发布到 npm 后可用）：

```bash
npm install -g @powercess/yimu-mcp
yimu-mcp        # 启动 MCP 服务
```

本地开发：

```bash
npm install && npm run build   # Node
# 或
bun install && bun run dev      # Bun，直接运行，无需构建
```

## 配置

所有设置通过环境变量提供，账号信息不进仓库：

| 环境变量 | 说明 |
|---|---|
| `YIMU_TOKEN` | 登录令牌 JWT（登录后获得） |
| `YIMU_USER_ID` | 用户 ID（部分接口需要，登录后自动获取） |
| `YIMU_BASE_URL` | 服务地址，默认 `https://yimubill.com/api` |
| `YIMU_QR_DIR` | 二维码保存目录，默认系统临时目录 |

令牌可从一木记账网页版浏览器开发者工具里复制请求头 `token` 的值。

## 接入 MCP 客户端

全局安装后：

```json
{
  "mcpServers": {
    "yimu": {
      "command": "yimu-mcp",
      "env": { "YIMU_TOKEN": "你的JWT" }
    }
  }
}
```

仓库本地方式（`command` 指向可执行文件）：`node` + `dist/index.js`，或 `bun` + `src/index.ts`（无需构建）。

## 登录

1. **扫码登录（推荐）**：调用 `login_qr_start`，二维码直接显示在对话或终端里；
   手机打开一木记账 App，首页 → 更多 → 扫一扫，扫完调用 `login_qr_poll` 等待登录结果。
2. **邮箱密码登录**：调用 `login_email`，填邮箱和密码即可，密码加密传输。
3. **JWT 直配**：在环境变量里配好 `YIMU_TOKEN`，启动即已登录。

## 工具一览

- **登录与账号**：`login_qr_start` `login_qr_poll` `login_email` `get_me` `auth_status`
- **查询**：`sync_pull`（全量同步）、`get_bill_count`（账单总数）、`get_book_bills`（账本账单分页）、
  `get_assets`（资产）、`get_currency`（币种）、`get_category_info`（分类）、
  `get_share_accounts`（共享账本）、`get_account_members`（账本成员）、`get_delete_history`（删除记录）
- **记账**：`save_bill` / `save_bills`（单条/批量新增或更新）、`delete_bill`（删除）
- **其他实体**：`save_asset` `save_account_book` `save_tag` `save_transfer` `save_lend`
  `save_parent_category` `save_child_category` `save_reimbursement` `save_refund`
  `save_bill_file` `save_bill_import` `save_asset_history`（对应删除用 `delete_*`）
- **辅助**：`parse_bill_text`（一句话记账解析）、`get_sts`（对象存储凭证）、
  `api_request`（通用请求，可覆盖全部接口）

## License

MIT
