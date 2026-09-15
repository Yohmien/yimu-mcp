// 配置归一化：命令行参数 > 环境变量 > yimu.config.json > 默认值，写入 CONFIG。
// 另负责 CLI 模式（--help/--version/--print-config/--doctor/--qr）。
// 注意：非 CLI 模式绝不能往 stdout 写任何东西——stdout 是 MCP 的 JSON-RPC 通道，诊断走 stderr。

import fs from "node:fs";
import path from "node:path";
import { defaultQrDir } from "./qr.ts";

/** 服务版本：运行时读 package.json，避免各处硬编码导致漂移 */
export const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface Setting {
  /** 归一化后的字段名 */
  key: "token" | "userToken" | "userId" | "baseUrl" | "timeoutMs" | "qrDir";
  /** 环境变量名 */
  env: string;
  /** 配置文件键名 */
  file: string;
  /** 默认值 */
  def: string;
  /** 是否敏感（--print-config 不打印明文） */
  secret?: boolean;
}

const SETTINGS: Setting[] = [
  { key: "token", env: "YIMU_TOKEN", file: "token", def: "", secret: true },
  { key: "userToken", env: "YIMU_USER_TOKEN", file: "userToken", def: "", secret: true },
  { key: "userId", env: "YIMU_USER_ID", file: "userId", def: "" },
  { key: "baseUrl", env: "YIMU_BASE_URL", file: "baseUrl", def: "https://yimubill.com/api" },
  { key: "timeoutMs", env: "YIMU_TIMEOUT", file: "timeoutMs", def: "30000" },
  { key: "qrDir", env: "YIMU_QR_DIR", file: "qrDir", def: "" },
];

export const RESOLVED: Record<string, { env: string; value: string; source: "arg" | "env" | "file" | "default" }> = {};

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else flags.set(a.slice(2), "true");
    }
  }
}
const booleans: Record<string, true> = {
  help: true,
  h: true,
  version: true,
  v: true,
  "print-config": true,
  doctor: true,
  qr: true,
};
const hasFlag = (n: string): boolean => flags.has(n);
const flagValue = (n: string): string => flags.get(n) ?? "";

/** 供其他模块判断本次启动带了哪些命令行选项 */
export const CLI = { has: hasFlag, value: flagValue };

/** 配置文件：--config / YIMU_CONFIG 指定，或当前目录的 yimu.config.json */
function loadConfigFile(): { path: string; data: Record<string, unknown> } | null {
  const p = flagValue("config") || process.env.YIMU_CONFIG || path.join(process.cwd(), "yimu.config.json");
  try {
    return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function note(msg: string): void {
  process.stderr.write(`[yimu-mcp] ${msg}\n`);
}
function fail(msg: string): never {
  note(`错误：${msg}`);
  process.exit(1);
}
function printOut(v: string): void {
  process.stdout.write(`${v}\n`);
}

function fromFile(cfg: { data: Record<string, unknown> } | null, s: Setting): string {
  const v = cfg?.data?.[s.file];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

const cfg = loadConfigFile();
for (const s of SETTINGS) {
  let value = "";
  let source: "arg" | "env" | "file" | "default" = "default";
  if (hasFlag(s.key)) {
    value = flagValue(s.key);
    source = "arg";
  } else if (process.env[s.env]) {
    value = process.env[s.env]!;
    source = "env";
  } else {
    const f = fromFile(cfg, s);
    if (f) {
      value = f;
      source = "file";
    } else {
      value = s.def;
      source = "default";
    }
  }
  RESOLVED[s.key] = { env: s.env, value, source };
}

export const CONFIG = {
  token: RESOLVED.token.value,
  userToken: RESOLVED.userToken.value,
  userId: RESOLVED.userId.value,
  baseUrl: RESOLVED.baseUrl.value.replace(/\/+$/, ""),
  timeoutMs: Math.max(1000, Number(RESOLVED.timeoutMs.value) || 30000),
  qrDir: RESOLVED.qrDir.value || defaultQrDir(),
};

export { cfg as CONFIG_FILE };

function sourcesText(): string {
  return SETTINGS.map((s) => {
    const r = RESOLVED[s.key];
    const shown = s.secret ? (r.value ? "******（已设置）" : "（未设置）") : r.value;
    return `  ${s.key.padEnd(9)} = ${shown}   来源: ${r.source} (${r.env})`;
  }).join("\n");
}

// ---------------- CLI 模式 ----------------

if (hasFlag("help") || hasFlag("h")) {
  printOut(`一木记账 MCP 服务器 v${SERVER_VERSION}
用法: yimu-mcp [--token=JWT] [--user-id=12345] [--base-url=...] [--timeout-ms=30000] [--config=文件] [--help|--version|--print-config|--doctor|--qr]

参数/环境变量/配置文件（优先级从高到低）：
  --token / YIMU_TOKEN         账号 JWT（登录后获得；扫码/邮箱登录工具会更新它）
  --user-id / YIMU_USER_ID     用户 ID（部分接口路径参数需要；登录后可自动获取）
  --base-url / YIMU_BASE_URL   API 基址，默认 https://yimubill.com/api
  --timeout-ms / YIMU_TIMEOUT  请求超时毫秒，默认 30000
  --config / YIMU_CONFIG       配置文件路径，默认 ./yimu.config.json

二维码目录（扫码登录）：
  --qr-dir / YIMU_QR_DIR       二维码图片保存目录，默认系统临时目录下 yimu-mcp/（可用 --qr-dir 或 YIMU_QR_DIR 覆盖）

独立模式（不起 MCP 服务）：
  --qr                         生成扫码登录会话，把 session_id 与 UTF-8 二维码直接打印到终端后退出；
                               用一木记账 App 扫码后，在 MCP 客户端调用 login_qr_poll(session_id, timeout) 等待登录
                               （二维码 2 分钟有效）

配置文件示例（yimu.config.json）：
  { "token": "<JWT>", "userId": 123456, "qrDir": "C:/temp/yimu-qr" }

MCP 工具：auth_status / login_qr_start / login_qr_poll / login_qr_recognize / login_email / get_me /
sync_start / sync_end / sync_pull / get_delete_history / get_bill_count /
get_book_bills / get_book_last_time / get_share_accounts / get_assets /
get_account_members / get_account_delete_history / get_currency / get_category_info /
save_bill / save_bills / delete_bill / save_asset / delete_asset /
save_account_book / delete_account_book / save_tag / delete_tag /
save_transfer / delete_transfer / save_lend / delete_lend /
save_parent_category / delete_parent_category / save_child_category / delete_child_category /
save_reimbursement / delete_reimbursement / save_refund / delete_refund /
save_bill_file / delete_bill_file / save_bill_import / save_asset_history / delete_asset_history /
parse_bill_text / get_sts / api_request`);
  process.exit(0);
}

if (hasFlag("version") || hasFlag("v")) printOut(SERVER_VERSION);

if (hasFlag("print-config")) {
  printOut(`配置文件: ${cfg?.path ?? "（未找到）"}
${sourcesText()}`);
  process.exit(0);
}

// --doctor：自检后退出，不起服务
if (hasFlag("doctor")) {
  printOut(`一木记账 MCP v${SERVER_VERSION} 自检`);
  printOut(sourcesText());
  process.exit(0);
}

// 非 CLI 模式：若带未知 -- 选项且非布尔开关，提醒但不阻断
for (const [k] of flags) {
  if (!(k in booleans) && !SETTINGS.some((s) => s.key === k) && k !== "config" && k !== "http") {
    note(`未知选项 --${k}（忽略）`);
  }
}
