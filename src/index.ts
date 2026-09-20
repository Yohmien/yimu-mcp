#!/usr/bin/env node
// 一木记账 MCP 服务器入口（stdio 传输）。
// 首个 import 必须是 config.ts：它负责 CLI 模式（--help/--version/--print-config/--doctor/--qr）与配置归一化。
import { CONFIG, SERVER_VERSION, CLI } from "./config.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { YimuClient } from "./api.ts";
import { renderQrTerminal } from "./qr.ts";
import { TokenStore } from "./token-store.ts";
import { registerYimuTools } from "./tools.ts";

const server = new McpServer({ name: "yimu-mcp", version: SERVER_VERSION });

const tokenStore = new TokenStore(CONFIG.tokenDb, CONFIG.tokenStoreKey);
const savedAuth = tokenStore.load();
const client = new YimuClient({
  baseUrl: CONFIG.baseUrl,
  token: CONFIG.token || savedAuth?.token,
  userToken: CONFIG.userToken || savedAuth?.userToken,
  userId: CONFIG.userId || savedAuth?.userId,
  timeoutMs: CONFIG.timeoutMs,
  onAuthChanged: (state) => tokenStore.save(state),
  onAuthFailure: () => tokenStore.clear(),
});

if (!tokenStore.enabled) {
  process.stderr.write("[yimu-mcp] 未设置 YIMU_TOKEN_STORE_KEY，登录令牌仅保留在内存中\n");
} else if (client.token && (Boolean(CONFIG.token) || !savedAuth)) {
  tokenStore.save(client.getAuthState());
}
process.once("exit", () => tokenStore.close());

// --qr：控制台直显扫码登录（不起 MCP 服务）。生成会话并打印 session_id + UTF-8 二维码后退出；
// 扫码后由 MCP 客户端调用 login_qr_poll(session_id, timeout) 等待登录。
if (CLI.has("qr")) {
  const sessionId = await client.addScanLogin();
  const payload = `login:${sessionId}`;
  process.stdout.write(
    `session_id: ${sessionId}\n` +
      `qr_payload: ${payload}\n` +
      `请用一木记账 App【首页】-【更多】-【扫一扫】扫描（2 分钟有效），` +
      `然后在 MCP 客户端调用 login_qr_poll(session_id="${sessionId}") 等待登录。\n\n` +
      (await renderQrTerminal(payload, "utf8")) +
      "\n",
  );
  process.exit(0);
}

// 自动登录：未配 JWT 但配了邮箱/密码时，启动即登录获取 JWT（失败不阻断，AI 可随时调 login_email 重试）
if (!client.token && CONFIG.email && CONFIG.password) {
  try {
    await client.loginByEmail(CONFIG.email, CONFIG.password);
    process.stderr.write(`[yimu-mcp] 已用配置账号自动登录: userId=${client.userId}\n`);
  } catch (e) {
    process.stderr.write(`[yimu-mcp] 自动登录失败: ${(e as Error).message}（可调 login_email/login_qr_* 重试）\n`);
  }
}

registerYimuTools(server, client, CONFIG.qrDir, { email: CONFIG.email, password: CONFIG.password });

const transport = new StdioServerTransport();
await server.connect(transport);
