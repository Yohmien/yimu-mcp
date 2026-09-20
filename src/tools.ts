// 一木记账 MCP 工具：把网页端接口映射为 MCP 工具。
// 除标注「免鉴权」的工具外，均要求已持有 JWT（YIMU_TOKEN 配置或登录获得）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { YimuClient, YimuError } from "./api.ts";
import { renderQrPng, renderQrTerminal, saveQrPng } from "./qr.ts";
import { prune, projectEntity, sanitizeUser, roundMoney, fmtDate } from "./prune.ts";

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** MCP 内容块：文本或图片（图片供支持图片的 harness 直接展示） */
type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** 带图片的结果：text 为给人看的说明，image 为可选图片内容 */
interface QrResult {
  text: string;
  image?: { data: string; mimeType: string };
}

/** 统一输出：QrResult 渲染为 文本+图片 内容块；其余 JSON 序列化 */
const out = (v: unknown): { content: ContentBlock[] } => {
  if (
    v &&
    typeof v === "object" &&
    (v as Record<string, unknown>).image &&
    typeof (v as Record<string, unknown>).text === "string"
  ) {
    const r = v as QrResult;
    const content: ContentBlock[] = [{ type: "text", text: r.text }];
    if (r.image) content.push({ type: "image", data: r.image.data, mimeType: r.image.mimeType });
    return { content };
  }
  const data = prune(v);
  // 写操作服务端返回 result:null，prune 后为空；此时 text 必须是字符串，否则 MCP 客户端判定内容块非法
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 1);
  return { content: [{ type: "text", text: text === undefined ? "操作已完成（服务端未返回数据）" : text }] };
};

interface PropSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
}

/**
 * 内部 JSON-Schema 描述 → zod 形状（SDK registerTool 的 inputSchema 需要 zod schema 值）。
 * number 用 coerce 容忍 LLM 传字符串数字；object/array 开放结构，required 由缺省 optional 区分。
 * 声明 additionalProperties:false 时返回 .strict()，运行时同样拒绝未知键（与声明契约一致）。
 */
function toShape(desc: Record<string, unknown>): z.ZodType {
  const props = (desc.properties ?? {}) as Record<string, PropSchema>;
  const required = (desc.required as string[] | undefined) ?? [];
  const shape: Record<string, z.ZodType> = {};
  for (const [k, p] of Object.entries(props)) {
    let s: z.ZodType;
    switch (p.type) {
      case "number":
      case "integer":
        s = p.type === "integer" ? z.coerce.number().int() : z.coerce.number();
        break;
      case "boolean":
        s = z.boolean();
        break;
      case "object":
        s = z.record(z.string(), z.unknown());
        break;
      case "array":
        s = z.array(z.record(z.string(), z.unknown()));
        break;
      case "string":
        s = p.enum && p.enum.length >= 2 ? z.enum(p.enum as [string, ...string[]]) : z.string();
        break;
      default:
        s = z.unknown();
        break;
    }
    if (p.description) s = s.describe(p.description);
    if (!required.includes(k)) s = s.optional();
    shape[k] = s;
  }
  const obj = z.object(shape);
  return desc.additionalProperties === false ? obj.strict() : obj;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 免鉴权工具（登录/扫码/同步会话） */
  noAuth?: boolean;
  /** 破坏性写操作，交给 MCP 客户端单独提示确认 */
  destructive?: boolean;
  handler: Handler;
}

/** 实体字段说明（字段名来自服务端数据快照；未知实体注明） */
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** 实体字段说明（字段名来自服务端快照 schemas.json；未知实体注明） */
const SCHEMA_HINTS: Record<string, string> = {
  Bill:
    "billId 主键；cost 金额（元）；time 记账时间(ms)；billType 记录方式（1快捷/2手动/3导入/4周期/5自动/6模板）；" +
    "parentCategoryId/childCategoryId 分类（收支由分类决定）；" +
    "remark 备注；assetId 账户；bookId 账本；tags 标签（数组或 JSON 字符串均可）；recordTime 记录时间；" +
    "reimbursement/reimbursementEnd 报销；notIntoTotal/notIntoBudget 不计收支/预算；currencyInfo 币种；userId/updateTime 自动填充",
  Asset:
    "assetId 主键；assetName 名称；assetType 类型；assetNumber 余额；totalQuota 总额度；intoTotalAsset 计入总资产；" +
    "hide 隐藏；bookId 账本；currency 币种；remark/simpleName/cardCode/positionWeight 可选；userId/updateTime 自动填充",
  Transfer: "transferId 主键；cost 金额；serviceCharge 手续费；time 时间；fromAssetId/toAssetId 转出/转入账户；toCost 到账金额；billId 关联账单；remark 备注",
  Lend: "lendId 主键；type 类型（借出/借入）；number 金额；interest 利息；outTime/inTime 借出/归还时间；assetId 关联账户；repaymentAssetId 还款账户；remark 备注",
  ParentCategory: "categoryId 主键；categoryName 名称；iconUrl 图标；positionWeight 排序；hide 隐藏；categoryType 类型",
  ChildCategory: "categoryId 主键；categoryName 名称；iconUrl 图标；parentCategoryId 所属一级分类；positionWeight 排序；hide 隐藏；categoryType 类型",
  Refund: "refundId 主键；billId 关联账单；refundNum 退款金额；refundInfos 退款明细（JSON）",
  BillFile: "fileId 主键；billId 关联账单；remotePath 远程路径；fileName 文件名；fileSize 大小；transferId/lendId 可选",
  AssetHistory: "assetHistoryId 主键；assetId 账户；time 时间；currentNum 变动后余额；changeNum 变动额；changeContent 变动说明",
  Tag: "tag 字段无快照数据；至少携带 tagId/tagName 与 userId，其余按服务端契约传递",
  AccountBook: "accountBookId 主键；bookName 账本名；bookType 账本类型；shareUsers 共享用户；字段按服务端契约传递",
  Reimbursement: "reimbursement 无快照数据；携带 billId/remark/金额字段与 userId，按服务端契约传递",
  BillImport: "billImport 导入记录；无快照数据，按服务端契约传递",
  StockAsset:
    "stockAssetId 主键；name 名称；code 代码（场外基金形如 of539002，场内为证券代码）；assetType 持仓类型（20 基金，其余按服务端枚举）；" +
    "groupName 分组；primeCost 持仓成本价；primeNum 持仓份额；intoTotalAsset 计入总资产；upDownToTotal 计入涨跌；monetary 货币型；" +
    "positionWeight 排序；historyIncome 历史收益；remark 备注；userId/updateTime 自动填充",
  StockInfo:
    "stockInfoId 主键；stockAssetId 所属持仓；type 方向（2 买入、1 卖出）；cost 确认净值；num 确认份额；totalCost 金额（净值×份额）；" +
    "serviceCharge 手续费；doTime 买入/卖出时间(ms)；endTime 确认时间(ms)；assetId 付款/收款账户（0 表示无账户）；" +
    "infoStatus 状态（0 已确认、1 待确认、2 失败）；autoIncome 自动计入收益；billId 关联账单；remark 备注；" +
    "stockInfoId 为主键且需客户端生成，缺失时服务端返回 success 却不落库；userId/updateTime 自动填充",
};

/** 同步数据摘要：计数 + 收支合计 + 最近10笔 + 分类Top + 资产（面向 AI 分析，避免全量实体淹没上下文） */
function summarizeSync(d: Record<string, unknown>): unknown {
  const bills = Array.isArray(d.Bill) ? (d.Bill as Record<string, unknown>[]) : [];
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v)) counts[k] = v.length;
  let income = 0;
  let expense = 0;
  const byCat = new Map<number, { count: number; expense: number; income: number }>();
  for (const b of bills) {
    const cost = typeof b.cost === "number" && Number.isFinite(b.cost) ? b.cost : Number(b.cost) || 0;
    const inc = Number(b.parentCategoryId) === 9; // 系统收入根分类（与网页端一致）
    if (inc) income += cost;
    else expense += cost;
    const cid = Number(b.parentCategoryId) || 0;
    const e = byCat.get(cid) ?? { count: 0, expense: 0, income: 0 };
    e.count += 1;
    if (inc) e.income += cost;
    else e.expense += cost;
    byCat.set(cid, e);
  }
  const topCategories = [...byCat.entries()]
    .map(([id, v]) => ({ parentCategoryId: id, count: v.count, expense: roundMoney(v.expense), income: roundMoney(v.income) }))
    .sort((x, y) => Number(y.expense) + Number(y.income) - (Number(x.expense) + Number(x.income)))
    .slice(0, 10);
  const recentBills = [...bills]
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))
    .slice(0, 10)
    .map((b) => ({
      billId: b.billId,
      cost: roundMoney(b.cost),
      date: fmtDate(b.time),
      parentCategoryId: b.parentCategoryId,
      childCategoryId: b.childCategoryId,
      remark: b.remark,
      assetId: b.assetId,
    }));
  const assets = Array.isArray(d.Asset)
    ? d.Asset.map((x) => projectEntity("Asset", (x ?? {}) as Record<string, unknown>))
    : [];
  return prune({
    syncTime: d.syncTime,
    counts,
    totals: { income: roundMoney(income), expense: roundMoney(expense), bills: bills.length },
    recentBills,
    topCategories,
    assets,
  });
}

/** 资产账户类型（与网页端枚举一致） */
const ASSET_TYPE_LABELS: Record<string, string> = {
  "1": "资金账户",
  "2": "信用卡",
  "3": "充值账户",
  "4": "投资理财",
  "5": "二手货物",
  "6": "借出",
  "7": "借入",
  "8": "贷款",
  "9": "报销",
};

/** 同步接口分页主键：跨页合并同一条记录时保留 updateTime 最新者 */
const SYNC_PRIMARY_KEYS: Record<string, string> = {
  Asset: "assetId",
  StockAsset: "stockAssetId",
  StockInfo: "stockInfoId",
  AssetFixedDeposit: "fixedDepositId",
  Instalment: "instalmentId",
  // 月度总预算的 budgetId 恒为 0，只能用服务端行 id 去重
  Budget: "id",
  CategoryBudget: "categoryBudgetId",
  Transfer: "transferId",
  Lend: "lendId",
  Refund: "refundId",
};

/** 同步接口默认最大翻页数：服务端按 syncTime 游标分页，hasMoreData 为真时必须继续请求下一页 */
const SYNC_PAGE_LIMIT = 20;

/**
 * 客户端业务主键。一木记账的实体主键由客户端生成：POST 时缺少该字段服务端会返回 success 但不落库，
 * 因此新增理财流水必须自带 stockInfoId（与 App 行为一致）。
 */
function randomEntityId(): number {
  return 1_000_000_000 + Math.floor(Math.random() * 8_999_999_999);
}

interface SyncModules {
  /** 需要明细的模块：主键 → 记录 */
  modules: Record<string, Map<string, Record<string, unknown>>>;
  /** 全部模块的去重计数 */
  counts: Record<string, Set<string>>;
  syncTime: number;
  pages: number;
  hasMoreData: boolean;
}

/**
 * 分页拉取增量同步数据。服务端单页只返回部分记录（账单每页上限 1000 条），
 * 只取首页会漏掉绝大多数资产/理财数据，因此按 hasMoreData 持续翻页并按主键合并。
 */
async function collectSyncModules(client: YimuClient, userId: string, since: number, maxPages: number): Promise<SyncModules> {
  const modules: Record<string, Map<string, Record<string, unknown>>> = {};
  const counts: Record<string, Set<string>> = {};
  let time = since;
  let syncTime = since;
  let pages = 0;
  let hasMoreData = false;
  while (pages < maxPages) {
    const page = (await client.getUpdateDataPage(userId, time)) as Record<string, unknown> | null;
    if (!page || typeof page !== "object") break;
    pages += 1;
    for (const [key, value] of Object.entries(page)) {
      if (!Array.isArray(value)) continue;
      const primary = SYNC_PRIMARY_KEYS[key];
      const seen = (counts[key] ??= new Set());
      const bucket = primary ? (modules[key] ??= new Map()) : undefined;
      for (const raw of value) {
        const record = (raw ?? {}) as Record<string, unknown>;
        const id = String(record[primary ?? "id"] ?? `${key}:${seen.size}`);
        seen.add(id);
        if (!bucket) continue;
        const prev = bucket.get(id);
        if (!prev || num(record.updateTime, 0) >= num(prev.updateTime, 0)) bucket.set(id, record);
      }
    }
    hasMoreData = Boolean(page.hasMoreData);
    const next = num(page.syncTime, 0);
    if (!next || next <= time) break;
    time = next;
    syncTime = next;
    if (!hasMoreData) break;
  }
  return { modules, counts, syncTime, pages, hasMoreData };
}

/** 模块明细：按指定字段排序并投影业务字段 */
function moduleList(
  modules: Record<string, Map<string, Record<string, unknown>>>,
  key: string,
  sortKey: string,
  order: "asc" | "desc" = "desc",
): unknown[] {
  const dir = order === "asc" ? 1 : -1;
  return [...(modules[key]?.values() ?? [])]
    .sort((a, b) => dir * (num(a[sortKey], 0) - num(b[sortKey], 0)))
    .map((record) => projectEntity(key, record));
}

/** 账户列表：/asset/getAsset 返回完整账户，同步分页中的 Asset 仅作兜底 */
async function loadAssetList(
  client: YimuClient,
  userId: string,
  since: number,
  fallback: Map<string, Record<string, unknown>> | undefined,
): Promise<Record<string, unknown>[]> {
  try {
    const r = await client.getAsset(userId, since);
    if (Array.isArray(r) && r.length) return r as Record<string, unknown>[];
  } catch {
    // 接口不可用时退回同步分页数据，保证资产概览仍可读
  }
  return [...(fallback?.values() ?? [])];
}

export function registerYimuTools(
  server: McpServer,
  client: YimuClient,
  qrDir: string,
  creds: { email: string; password: string } = { email: "", password: "" },
): void {
  const requireAuth = (args: Record<string, unknown>): void => {
    if (!client.token) {
      throw new YimuError(
        `未登录：缺少 JWT。请配置 YIMU_TOKEN，或用 login_qr_start/login_qr_poll 扫码登录、login_email 邮箱登录。${args.user_id ? `当前 user_id=${args.user_id}` : ""}`,
      );
    }
  };
  const uid = (args: Record<string, unknown>): string => {
    const requested = str(args.user_id || args.userId);
    if (!client.userId) {
      if (requested) {
        throw new YimuError("无法确认当前登录用户 ID：请配置 YIMU_USER_ID 或先登录");
      }
      return "";
    }
    if (requested && requested !== client.userId) {
      throw new YimuError("user_id 必须与当前登录用户一致");
    }
    return client.userId;
  };
  const ownUser = (obj: Record<string, unknown>): Record<string, unknown> => {
    const id = uid({});
    if (!id) throw new YimuError("缺少当前登录用户 ID：请配置 YIMU_USER_ID 或先登录");
    obj.userId = Number(id) || id;
    return obj;
  };

  const tools: ToolDef[] = [
    // ---------------- 认证 ----------------
    {
      name: "auth_status",
      description: "查看登录状态（本地配置，不发请求）：是否持有 JWT、用户 ID、API 基址。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      noAuth: true,
      handler: async () => ({
        logged_in: Boolean(client.token),
        token_set: Boolean(client.token),
        user_id: client.userId || null,
        base_url: client.baseUrl,
        email_configured: Boolean(creds.email),
        password_configured: Boolean(creds.password),
      }),
    },
    {
      name: "login_qr_start",
      description:
        "创建扫码登录会话（免鉴权）。返回 session_id、qr_payload（login:<session_id>）与二维码图片：\n" +
        "1) 结果附带的 image 内容块可直接在支持图片的 harness 界面展示；\n" +
        "2) text 中内嵌 UTF-8 终端二维码（等宽字体直显，无需打开图片）；\n" +
        "3) 图片同时保存到二维码目录（--qr-dir / YIMU_QR_DIR，默认系统临时目录 yimu-mcp/），text 中给出完整路径；\n" +
        "4) 服务端同时把 ANSI 彩色二维码打印到 stderr（服务运行在终端里时控制台直接可见）。\n" +
        "二维码 2 分钟有效，用一木记账 App【首页】-【更多】-【扫一扫】扫描后调用 login_qr_poll 等待登录结果。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      noAuth: true,
      handler: async (): Promise<QrResult> => {
        const sessionId = await client.addScanLogin();
        const payload = `login:${sessionId}`;
        const file = await saveQrPng(payload, qrDir, `qr-${sessionId}.png`);
        const terminalQr = await renderQrTerminal(payload, "utf8");
        // ANSI 彩色版直接打 stderr：服务端跑在终端里时控制台立即可扫（stdout 是 JSON-RPC 通道，不能动）
        process.stderr.write(`\n[yimu-mcp] 扫码登录二维码（控制台直显，2 分钟有效）:\n${await renderQrTerminal(payload, "ansi")}\n`);
        return {
          text:
            `扫码登录二维码已生成。\n` +
            `session_id: ${sessionId}\n` +
            `qr_payload: ${payload}\n` +
            `二维码图片已保存到: ${file}\n` +
            `（请用一木记账 App【首页】-【更多】-【扫一扫】扫描，然后调用 login_qr_poll 等待登录；` +
            `二维码在下方，控制台折叠时可 ctrl+o 展开）\n` +
            `控制台二维码（UTF-8 半块字符，等宽字体直显）:\n${terminalQr}`,
          image: { data: (await renderQrPng(payload)).toString("base64"), mimeType: "image/png" },
        };
      },
    },
    {
      name: "login_qr_poll",
      description:
        "等待/轮询扫码登录结果（免鉴权）。timeout 秒内每 3 秒查询一次，用户扫码后返回 status=success 与用户对象（JWT 已自动保存）；" +
        "timeout=0 只查一次。默认 120 秒。",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "login_qr_start 返回的 session_id" },
          timeout: { type: "number", description: "等待秒数，0=只查一次；默认 120" },
        },
        required: ["session_id"],
        additionalProperties: false,
      },
      noAuth: true,
      handler: async (a) => {
        const sid = str(a.session_id);
        const timeout = num(a.timeout, 120);
        const deadline = Date.now() + timeout * 1000;
        for (;;) {
          const user = await client.getScanLogin(sid);
          if (user) return { status: "success", user: sanitizeUser(user), token_set: Boolean(client.token), user_id: client.userId || null };
          if (timeout === 0 || Date.now() >= deadline) {
            return { status: "pending", hint: "等待扫码或登录尚未完成；可再次调用本工具（传 timeout 秒数则自动等待）" };
          }
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 3000);
          await promise;
        }
      },
    },
    {
      name: "login_email",
      description:
        "邮箱密码登录（免鉴权）。密码只从环境变量 YIMU_PASSWORD 读取，不接受 MCP 参数，也不会返回 JWT。" +
        "邮箱缺省时使用环境变量 YIMU_EMAIL（未配置则报错）。" +
        "请优先使用扫码登录（更安全）。",
      inputSchema: {
        type: "object",
        properties: {
          email: { type: "string", description: "一木记账账号邮箱；缺省用环境变量 YIMU_EMAIL" },
        },
        additionalProperties: false,
      },
      noAuth: true,
      handler: async (a) => {
        const email = str(a.email) || creds.email;
        const password = creds.password;
        if (!email || !password) {
          throw new YimuError("缺少邮箱或密码：请在环境变量配置 YIMU_EMAIL/YIMU_PASSWORD，或使用扫码登录");
        }
        const user = await client.loginByEmail(email, password);
        return { user: sanitizeUser(user as Record<string, unknown>), token_set: Boolean(client.token), user_id: client.userId || null };
      },
    },
    {
      name: "get_me",
      description: "查询当前用户信息（POST /user/getUserInfoById）；响应顶层 token 会自动刷新 JWT。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string", description: "用户 ID，缺省用配置/登录值" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID：请传 user_id 或先登录");
        return sanitizeUser((await client.getUserInfoById(id)) as Record<string, unknown>);
      },
    },

    // ---------------- 读取 ----------------
    {
      name: "sync_pull",
      description:
        "增量拉取业务数据（GET /updateTime/getUpdateDataPage/{userId}/{time}）。" +
        "默认返回摘要：syncTime、各实体计数、收支合计、最近10笔、分类Top10、资产列表——适合 AI 快速分析账目；" +
        "需要完整明细时传 summary=false，各实体按业务字段精简返回（Bill 只含 billId/cost/日期/分类/备注等）。" +
        "time 为上次同步时间戳(ms)，缺省 0 表示全量。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "上次同步时间戳(ms)，0=全量" },
          summary: { type: "boolean", description: "默认 true：返回摘要；false 返回全部实体明细（已精简）" },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const t = a.time === undefined ? 0 : num(a.time, 0);
        const data = (await client.getUpdateDataPage(id, t)) as Record<string, unknown> | null;
        if (!data || typeof data !== "object") return data;
        if (a.summary !== false) return summarizeSync(data);
        const outData: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(data)) {
          outData[k] = Array.isArray(v) ? v.map((x) => projectEntity(k, (x ?? {}) as Record<string, unknown>)) : v;
        }
        return prune(outData);
      },
    },
    {
      name: "get_delete_history",
      description: "查询删除记录（GET /deleteHistory/getDeleteHistory/{userId}/{time}），time 缺省 0 全量。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "起始时间戳(ms)" },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getDeleteHistory(id, a.time === undefined ? 0 : num(a.time, 0));
      },
    },
    {
      name: "get_bill_count",
      description: "查询账单总数（GET /bill/getBillCount/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getBillCount(id);
      },
    },
    {
      name: "get_book_bills",
      description:
        "分页查询账本账单（GET /bill/getAccountBillPage/{userId}/{bookId}/{page}）。" +
        "返回 {syncTime, hasMoreData, billCount, totals:{income,expense}, bills:[精简账单]}；" +
        "账单只含 billId/cost/日期/分类/备注/账户等业务字段。page 从 0 起，按 hasMoreData 翻页。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          page: { type: "number", description: "页码，从 0 开始" },
          user_id: { type: "string", description: "账本所属用户 ID，缺省用当前用户" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const page = num(a.page, 0);
        const r = (await client.getAccountBillPage(id, str(a.book_id), page)) as Record<string, unknown> | null;
        if (!r || typeof r !== "object") return r;
        const bills = Array.isArray(r.Bill) ? (r.Bill as Record<string, unknown>[]) : [];
        let income = 0;
        let expense = 0;
        for (const b of bills) {
          const cost = typeof b.cost === "number" && Number.isFinite(b.cost) ? b.cost : Number(b.cost) || 0;
          if (Number(b.parentCategoryId) === 9) income += cost;
          else expense += cost;
        }
        return prune({
          syncTime: r.syncTime,
          hasMoreData: r.hasMoreData,
          page,
          billCount: bills.length,
          totals: { income: roundMoney(income), expense: roundMoney(expense) },
          bills: bills.map((b) => projectEntity("Bill", b)),
        });
      },
    },
    {
      name: "get_book_last_time",
      description: "查询账本最后同步时间戳(ms)（GET /bill/getAccountLastTime/{userId}/{bookId}），可作增量同步游标。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          user_id: { type: "string" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getAccountLastTime(id, str(a.book_id));
      },
    },
    {
      name: "get_share_accounts",
      description: "查询共享账本列表（GET /accountBook/getShareAccount/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getShareAccount(id);
      },
    },
    {
      name: "get_assets",
      description: "查询资产列表（GET /asset/getAsset/{userId}/{time}），time 为起始时间戳(ms)，缺省 0 全量；每个资产只保留业务字段（名称/余额/类型/分组）。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "起始时间戳(ms)" },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const r = await client.getAsset(id, a.time === undefined ? 0 : num(a.time, 0));
        return Array.isArray(r) ? r.map((x) => projectEntity("Asset", x)) : r;
      },
    },
    {
      name: "get_asset_modules",
      description:
        "查询资产与理财相关模块：按 syncTime 游标完整翻页拉取增量同步接口，返回全部资产账户（另以 GET /asset/getAsset 校正为完整账户列表）、" +
        "理财持仓 StockAsset、理财流水 StockInfo、定期/固定存款 AssetFixedDeposit、分期 Instalment、预算 Budget/CategoryBudget；" +
        "借贷、资产变动、转账、退款、报销等其他模块只返回去重数量，不返回完整账单与资产历史明细。",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "number", description: "起始时间戳(ms)，缺省 0 全量" },
          max_pages: { type: "number", description: `最大翻页数，缺省 ${SYNC_PAGE_LIMIT}；服务端分页未取完时 hasMoreData 为 true` },
          user_id: { type: "string" },
        },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const since = a.time === undefined ? 0 : num(a.time, 0);
        const maxPages = Math.min(Math.max(num(a.max_pages, SYNC_PAGE_LIMIT), 1), 100);
        const sync = await collectSyncModules(client, id, since, maxPages);
        const assets = await loadAssetList(client, id, since, sync.modules.Asset);
        const counts: Record<string, number> = {};
        for (const [key, seen] of Object.entries(sync.counts)) counts[key] = seen.size;
        const byType: Record<string, { count: number; total: number }> = {};
        let intoTotalAssetTotal = 0;
        for (const record of assets) {
          const kind = ASSET_TYPE_LABELS[String(record.assetType)] ?? `类型${String(record.assetType ?? "未知")}`;
          const entry = (byType[kind] ??= { count: 0, total: 0 });
          entry.count += 1;
          if (record.intoTotalAsset === true) {
            entry.total = roundMoney(entry.total + num(record.assetNumber, 0)) as number;
            intoTotalAssetTotal = roundMoney(intoTotalAssetTotal + num(record.assetNumber, 0)) as number;
          }
        }
        return prune({
          syncTime: sync.syncTime,
          pages: sync.pages,
          hasMoreData: sync.hasMoreData,
          counts,
          assetSummary: { count: assets.length, intoTotalAssetTotal, byType },
          modules: {
            Asset: assets.map((record) => projectEntity("Asset", record)),
            StockAsset: moduleList(sync.modules, "StockAsset", "positionWeight", "asc"),
            StockInfo: moduleList(sync.modules, "StockInfo", "doTime"),
            AssetFixedDeposit: moduleList(sync.modules, "AssetFixedDeposit", "startTime"),
            Instalment: moduleList(sync.modules, "Instalment", "inAssetTime"),
            Budget: moduleList(sync.modules, "Budget", "month", "asc"),
            CategoryBudget: moduleList(sync.modules, "CategoryBudget", "month", "asc"),
          },
        });
      },
    },
    {
      name: "get_account_members",
      description: "查询账本成员（GET /accountBook/getAccountMember/{userId}/{bookId}）。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          user_id: { type: "string" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getAccountMember(id, str(a.book_id));
      },
    },
    {
      name: "get_account_delete_history",
      description:
        "查询账本删除历史（GET /accountBook/getAccountDeleteHistory/{userId}/{ownerId}/{bookId}/{lastSyncTime}）。",
      inputSchema: {
        type: "object",
        properties: {
          book_id: { type: "string", description: "账本 ID" },
          owner_id: { type: "string", description: "账本所属用户 ID" },
          last_sync_time: { type: "number", description: "上次同步时间戳(ms)" },
          user_id: { type: "string" },
        },
        required: ["book_id"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getAccountDeleteHistory(id, str(a.owner_id || a.ownerId) || id, str(a.book_id), num(a.last_sync_time, 0));
      },
    },
    {
      name: "get_currency",
      description: "查询币种数据（GET /currency/getCurrencyData/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getCurrencyData(id);
      },
    },
    {
      name: "get_category_info",
      description: "查询分类信息（图标/预设分类，GET /icon/getCategoryInfo/{userId}）。",
      inputSchema: {
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.getCategoryInfo(id);
      },
    },

    // ---------------- 同步限流会话 ----------------
    {
      name: "sync_start",
      description:
        "开始同步限流会话（免鉴权，POST /bookkeeping/rateLimit/sync/start）。" +
        "批量写操作前先 start，全部完成后务必 sync_end 归还会话，避免触发限流。返回 {syncCount, sessionId}。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      noAuth: true,
      handler: async () => client.syncStart(),
    },
    {
      name: "sync_end",
      description: "结束同步限流会话（免鉴权，POST /bookkeeping/rateLimit/sync/end?sessionId=）。",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string", description: "sync_start 返回的 sessionId" } },
        additionalProperties: false,
      },
      noAuth: true,
      handler: async (a) => client.syncEnd(a.session_id ? str(a.session_id) : undefined),
    },

    // ---------------- 写入：账单 ----------------
    {
      name: "save_bill",
      description:
        "新增或更新账单（POST /bill/addOrUpdateBill，upsert：带 billId 为更新，缺省为新增）。" +
        "自动归一化：tags 数组→JSON 字符串、recordTime 缺省取 updateTime/当前时间、billId 超 int32 自动重生成。" +
        "bill 字段：\n" + SCHEMA_HINTS.Bill,
      inputSchema: {
        type: "object",
        properties: {
          bill: { type: "object", description: "账单对象，见描述字段说明" },
        },
        required: ["bill"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const b = a.bill as Record<string, unknown>;
        if (!b || typeof b !== "object") throw new YimuError("bill 必须是对象");
        ownUser(b);
        return client.addOrUpdateBill(b);
      },
    },
    {
      name: "save_bills",
      description:
        "批量新增/更新账单（POST /bill/addOrUpdateBillList）。自动按 100 条分批、每批 updateTime 递增（与网页端一致）。" +
        "bill 字段同 save_bill。",
      inputSchema: {
        type: "object",
        properties: {
          bills: { type: "array", items: { type: "object" }, description: "账单对象数组（自动分批）" },
        },
        required: ["bills"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const list = a.bills;
        if (!Array.isArray(list) || list.length === 0) throw new YimuError("bills 必须是非空数组");
        const bills = list.map((b) => ownUser((b ?? {}) as Record<string, unknown>));
        return client.addOrUpdateBillList(bills);
      },
    },
    {
      name: "delete_bill",
      description: "删除账单（POST /bill/deleteBill，按 billId 删除）。",
      inputSchema: {
        type: "object",
        properties: {
          bill_id: { type: "string", description: "账单 ID" },
          user_id: { type: "string" },
        },
        required: ["bill_id"],
        additionalProperties: false,
      },
      destructive: true,
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少当前登录用户 ID：请配置 YIMU_USER_ID 或先登录");
        return client.deleteBill(str(a.bill_id), id);
      },
    },

    // ---------------- 写入：理财买卖（份额×净值） ----------------
    {
      name: "save_stock_trade",
      description:
        "理财买入/卖出补充记账（POST /stockInfo/addOrUpdateStockInfo）。按「份额×净值」录入时只给 cost(确认净值) 与 num(确认份额)，自动计算 totalCost=净值×份额；" +
        "也可只给 total_cost 按总额方式录入。type=2 买入、1 卖出；带 stock_info_id 为更新已有流水。" +
        "新增时主键 stockInfoId 由工具生成（服务端缺少该字段会返回 success 但不落库）；info_status 缺省按录入方式取 0（按份额×净值）或 1（仅总额）。",
      inputSchema: {
        type: "object",
        properties: {
          stock_asset_id: { type: "number", description: "理财持仓 stockAssetId（必填）" },
          type: { type: "number", description: "2 买入 / 1 卖出（必填）" },
          cost: { type: "number", description: "确认净值（与 num 搭配时必填）" },
          num: { type: "number", description: "确认份额（与 cost 搭配时必填）" },
          total_cost: { type: "number", description: "金额；缺省按 cost×num 计算" },
          service_charge: { type: "number", description: "手续费，缺省 0" },
          trade_time: { type: "number", description: "买入/卖出日期时间戳(ms)，缺省当前时间" },
          confirm_time: { type: "number", description: "确认日期时间戳(ms)，缺省与买入日期相同" },
          asset_id: { type: "number", description: "付款/收款账户 assetId，缺省 0（无账户）" },
          remark: { type: "string", description: "备注" },
          auto_income: { type: "boolean", description: "是否自动计入收益" },
          stock_info_id: { type: "number", description: "流水主键；传则为更新" },
          info_status: { type: "number", description: "状态：0 已确认（缺省，按份额×净值录入时）、1 待确认（只给总额时缺省）" },
          user_id: { type: "string" },
        },
        required: ["stock_asset_id", "type"],
        additionalProperties: false,
      },
      destructive: true,
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        const stockAssetId = num(a.stock_asset_id, 0);
        if (!stockAssetId) throw new YimuError("缺少 stock_asset_id（理财持仓）");
        const type = num(a.type, 0);
        if (type !== 1 && type !== 2) throw new YimuError("type 只能是 2（买入）或 1（卖出）");
        const hasShares = a.cost !== undefined && a.num !== undefined;
        if (a.total_cost === undefined && !hasShares) {
          throw new YimuError("需要 total_cost，或同时提供 cost(净值) 与 num(份额) 以按份额×净值计算");
        }
        const cost = num(a.cost, 0);
        const shares = num(a.num, 0);
        const totalCost =
          a.total_cost === undefined ? (roundMoney(cost * shares) as number) : (roundMoney(a.total_cost) as number);
        const now = Date.now();
        const doTime = a.trade_time === undefined ? now : num(a.trade_time, now);
        const entity: Record<string, unknown> = {
          stockAssetId,
          type,
          num: shares,
          cost,
          totalCost,
          serviceCharge: a.service_charge === undefined ? 0 : roundMoney(a.service_charge),
          doTime,
          endTime: a.confirm_time === undefined ? doTime : num(a.confirm_time, doTime),
          assetId: a.asset_id === undefined ? 0 : num(a.asset_id, 0),
          remark: str(a.remark),
          autoIncome: a.auto_income === true,
          infoStatus: a.info_status === undefined ? (hasShares ? 0 : 1) : num(a.info_status, 1),
          billId: 0,
          updateTime: now,
        };
        if (a.stock_info_id === undefined) {
          entity.id = 0;
          entity.stockInfoId = randomEntityId();
        } else {
          entity.stockInfoId = num(a.stock_info_id, 0);
        }
        ownUser(entity);
        return client.addOrUpdateEntity("stockInfo", "addOrUpdateStockInfo", entity);
      },
    },
    // ---------------- 写入：其他实体（表驱动） ----------------
    ...Object.entries(ENTITY_ENDPOINTS).flatMap(([toolKey, ep]) => {
      const cap = ep.action; // 如 Asset
      const saveTool: ToolDef = {
        name: `save_${toolKey}`,
        description: `新增或更新${ep.label}（POST /${ep.domain}/addOrUpdate${cap}，upsert：带主键为更新）。entity 字段：${SCHEMA_HINTS[cap] ?? "按服务端契约传递"}`,
        inputSchema: {
          type: "object",
          properties: { entity: { type: "object", description: `${ep.label}对象` } },
          required: ["entity"],
          additionalProperties: false,
        },
        handler: async (a) => {
          requireAuth(a);
          const e = a.entity as Record<string, unknown>;
          if (!e || typeof e !== "object") throw new YimuError("entity 必须是对象");
          ownUser(e);
          return client.addOrUpdateEntity(ep.domain, `addOrUpdate${cap}`, e);
        },
      };
      const delTool: ToolDef = {
        name: `delete_${toolKey}`,
        description: `删除${ep.label}（POST /${ep.domain}/delete${cap}）。entity 需携带主键字段（${ep.pk}）与 userId。`,
        inputSchema: {
          type: "object",
          properties: { entity: { type: "object", description: `${ep.label}对象（含主键 ${ep.pk}）` } },
          required: ["entity"],
          additionalProperties: false,
        },
        destructive: true,
        handler: async (a) => {
          requireAuth(a);
          const e = a.entity as Record<string, unknown>;
          if (!e || typeof e !== "object") throw new YimuError("entity 必须是对象");
          ownUser(e);
          return client.addOrUpdateEntity(ep.domain, `delete${cap}`, e);
        },
      };
      return [saveTool, ...(ep.noDelete ? [] : [delTool])];
    }),

    // ---------------- 工具类 ----------------
    {
      name: "parse_bill_text",
      description: "解析记账原始文本（GET /bill/analysisBillInfoT/{userId}/{text}），返回结构化账单信息。",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "原始记账文本，如「午饭 25 元 餐饮」" },
          user_id: { type: "string" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      handler: async (a) => {
        requireAuth(a);
        const id = uid(a);
        if (!id) throw new YimuError("缺少用户 ID");
        return client.parseBillText(id, str(a.text));
      },
    },
  ];

  const READ_ONLY_TOOLS = new Set([
    "auth_status",
    "get_me",
    "sync_pull",
    "get_delete_history",
    "get_bill_count",
    "get_book_bills",
    "get_book_last_time",
    "get_share_accounts",
    "get_assets",
    "get_asset_modules",
    "get_account_members",
    "get_account_delete_history",
    "get_currency",
    "get_category_info",
    "parse_bill_text",
  ]);

  for (const t of tools) {
    const guard = async (
      args: unknown,
    ): Promise<{ content: ContentBlock[]; isError?: boolean }> => {
      try {
        const a = (args ?? {}) as Record<string, unknown>;
        if (!t.noAuth) requireAuth(a);
        return out(await t.handler(a));
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
    };
    server.registerTool(
      t.name,
      {
        title: t.name,
        description: t.description,
        inputSchema: toShape(t.inputSchema),
        annotations: {
          readOnlyHint: READ_ONLY_TOOLS.has(t.name),
          destructiveHint: t.destructive === true,
        },
      },
      guard,
    );
  }
}

/** 通用实体端点表：toolKey → 域/动作/主键/中文名 */
const ENTITY_ENDPOINTS: Record<string, { domain: string; action: string; pk: string; label: string; noDelete?: boolean }> = {
  asset: { domain: "asset", action: "Asset", pk: "assetId", label: "资产" },
  account_book: { domain: "accountBook", action: "AccountBook", pk: "accountBookId", label: "账本" },
  tag: { domain: "tag", action: "Tag", pk: "tagId", label: "标签" },
  transfer: { domain: "transfer", action: "Transfer", pk: "transferId", label: "转账" },
  lend: { domain: "lend", action: "Lend", pk: "lendId", label: "借贷" },
  parent_category: { domain: "parentCategory", action: "ParentCategory", pk: "categoryId", label: "一级分类" },
  child_category: { domain: "childCategory", action: "ChildCategory", pk: "categoryId", label: "二级分类" },
  reimbursement: { domain: "reimbursement", action: "Reimbursement", pk: "reimbursementId", label: "报销" },
  refund: { domain: "refund", action: "Refund", pk: "refundId", label: "退款" },
  bill_file: { domain: "billFile", action: "BillFile", pk: "fileId", label: "账单附件" },
  bill_import: { domain: "billImport", action: "BillImport", pk: "importId", label: "账单导入记录", noDelete: true },
  asset_history: { domain: "assetHistory", action: "AssetHistory", pk: "assetHistoryId", label: "资产变动记录" },
  stock_asset: { domain: "stockAsset", action: "StockAsset", pk: "stockAssetId", label: "理财持仓" },
  stock_info: { domain: "stockInfo", action: "StockInfo", pk: "stockInfoId", label: "理财流水" },
};
