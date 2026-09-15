// 一木记账 API 客户端。
//
// 响应信封 {code, msg, result}（部分接口兼容 data）：
//   code===0 成功取 result；code===1 && msg==="no data" 成功无数据（null）；code===200 同步限流成功；
//   其余抛 YimuError(msg)。登录/扫码/查用户接口的顶层 token 自动刷新 JWT。

import { encryptPassword } from "./crypto.ts";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

/** 统一错误：HTTP 失败、业务码失败、网络异常 */
export class YimuError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "YimuError";
  }
}

/** 解析响应信封 → 业务结果；非成功抛 YimuError */
export function unwrapEnvelope(data: unknown): unknown {
  if (data === null || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  const code = d.code;
  if (code === 0) return (d.result !== undefined ? d.result : d.data) ?? null;
  if (code === 200) return (d.result !== undefined ? d.result : d.data) ?? d; // 同步限流接口：保留 syncCount/sessionId
  if (code === 1 && d.msg === "no data") return null;
  const msg = typeof d.msg === "string" && d.msg ? d.msg : `请求失败 (code=${String(code)})`;
  throw new YimuError(msg);
}

/** 账单归一化（app.js Fr() 移植） */
export function normalizeBill(bill: Record<string, unknown>): Record<string, unknown> {
  const s = { ...bill };
  if (typeof s.billId === "number" && s.billId > 2147483647) {
    s.billId = Math.floor(Math.random() * 2147483647);
  }
  if (Array.isArray(s.tags)) s.tags = JSON.stringify(s.tags);
  else if (s.tags === undefined || s.tags === null || s.tags === "") s.tags = "[]";
  if (!s.recordTime) s.recordTime = (s.updateTime as number | undefined) || Date.now();
  if (s.billShareInfo && typeof s.billShareInfo === "object") {
    s.billShareInfo = JSON.stringify(s.billShareInfo);
  }
  if (s.currencyInfo && typeof s.currencyInfo === "object") {
    s.currencyInfo = JSON.stringify(s.currencyInfo);
  }
  return s;
}

export interface YimuClientOptions {
  baseUrl: string;
  token?: string;
  userToken?: string;
  userId?: string | number;
  timeoutMs?: number;
  /** 测试注入点 */
  fetchImpl?: typeof fetch;
}

export class YimuClient {
  readonly baseUrl: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  /** 当前 JWT；登录/扫码/查用户成功后自动刷新（请求头 token 用） */
  token: string;
  /** userObjectToken（登录结果里的 token 字段，通常为邮箱）；getUserInfoById 表单用 */
  userToken: string;
  /** 当前用户 ID；登录成功后自动获取 */
  userId: string;

  constructor(opts: YimuClientOptions) {
    const u = new URL(opts.baseUrl);
    this.origin = u.origin;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token ?? "";
    this.userToken = opts.userToken ?? "";
    this.userId = opts.userId !== undefined ? String(opts.userId) : "";
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private pathToUrl(path: string): string {
    if (path.startsWith("/bookkeeping") || path.startsWith("bookkeeping")) {
      return `${this.origin}/${path.replace(/^\/+/, "")}`;
    }
    const p = path.replace(/^\/api\//, "/").replace(/^\//, "");
    return `${this.baseUrl}/${p}`;
  }

  /**
   * 核心请求。path 接受两种写法：`/user/getUserEmail`（相对 /api）或 `/api/user/getUserEmail`；
   * 同步限流接口写 `/bookkeeping/...`。返回解包后的业务结果。
   */
  async request(
    method: string,
    path: string,
    opts: {
      /** {key} 路径占位符 */
      params?: Record<string, string | number>;
      query?: Record<string, string | number>;
      /** JSON 请求体 */
      body?: unknown;
      /** 表单请求体（application/x-www-form-urlencoded） */
      form?: Record<string, string>;
      /** 不套用信封解包（如 getSts 返回原始体） */
      raw?: boolean;
    } = {},
  ): Promise<unknown> {
    let p = path;
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) p = p.replaceAll(`{${k}}`, String(v));
    }
    const url = new URL(this.pathToUrl(p));
    if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));

    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      referer: `${this.origin}/`,
      accept: "application/json, text/plain, */*",
    };
    if (this.token) headers.token = this.token;
    let body: string | undefined;
    if (opts.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(opts.form).toString();
      headers.origin = this.origin;
    } else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
      headers.origin = this.origin;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "follow",
      });
    } catch (e) {
      throw new YimuError(`网络请求失败: ${(e as Error).message}`, e);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new YimuError(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      const text = await res.text().catch(() => "");
      throw new YimuError(`响应不是 JSON: ${text.slice(0, 200)}`, e);
    }
    if (opts.raw) return data;
    // 登录/扫码/查用户接口的顶层 token 刷新 JWT
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d.token === "string" && d.token && /(getUserEmail|getScanLogin|getUserInfoById)/.test(path)) {
        this.token = d.token;
      }
    }
    return unwrapEnvelope(data);
  }

  // ---------------- 认证 ----------------

  async loginByEmail(email: string, password: string): Promise<unknown> {
    const r = await this.request("POST", "/user/getUserEmail", {
      form: { email, password: encryptPassword(password) },
    });
    this.rememberUser(r);
    return r;
  }

  /** 从用户对象提取 userId（登录/扫码返回的字段是 id）并记住；同时记录 userObjectToken */
  private rememberUser(u: unknown): void {
    if (!u || typeof u !== "object") return;
    const obj = u as Record<string, unknown>;
    const id = obj.userId ?? obj.id;
    if (typeof id === "number" || typeof id === "string") this.userId = String(id);
    if (typeof obj.token === "string" && obj.token) this.userToken = obj.token;
  }

  async getUserInfoById(userId: string | number): Promise<unknown> {
    return this.request("POST", "/user/getUserInfoById", {
      form: { userId: String(userId), token: this.userToken || this.token },
    });
  }

  async getUserInfoBatch(userIds: Array<string | number>): Promise<unknown> {
    return this.request("POST", "/user/getUserInfo", { body: userIds });
  }

  /** 创建扫码登录会话，返回 sessionId（QR 内容为 `login:${sessionId}`） */
  async addScanLogin(): Promise<string> {
    const r = (await this.request("POST", "/scanLogin/addScanLogin")) as unknown;
    if (typeof r !== "string" || !r) throw new YimuError("扫码登录会话创建失败");
    return r;
  }

  /** 轮询扫码登录状态；未扫/未成功返回 null，成功后返回用户对象（token 已刷新） */
  async getScanLogin(sessionId: string): Promise<Record<string, unknown> | null> {
    const r = (await this.request("GET", `/scanLogin/getScanLogin/{id}`, {
      params: { id: sessionId },
    })) as unknown;
    if (r && typeof r === "object") {
      this.rememberUser(r);
      return r as Record<string, unknown>;
    }
    return null;
  }

  // ---------------- 读取 ----------------

  getUpdateDataPage(userId: string | number, time: string | number): Promise<unknown> {
    return this.request("GET", "/updateTime/getUpdateDataPage/{userId}/{time}", {
      params: { userId, time },
    });
  }

  getDeleteHistory(userId: string | number, time: string | number): Promise<unknown> {
    return this.request("GET", "/deleteHistory/getDeleteHistory/{userId}/{time}", {
      params: { userId, time },
    });
  }

  getBillCount(userId: string | number): Promise<unknown> {
    return this.request("GET", "/bill/getBillCount/{userId}", { params: { userId } });
  }

  getAccountBillPage(userId: string | number, bookId: string | number, page: number): Promise<unknown> {
    return this.request("GET", "/bill/getAccountBillPage/{userId}/{bookId}/{page}", {
      params: { userId, bookId, page },
    });
  }

  getAccountLastTime(userId: string | number, bookId: string | number): Promise<unknown> {
    return this.request("GET", "/bill/getAccountLastTime/{userId}/{bookId}", { params: { userId, bookId } });
  }

  getShareAccount(userId: string | number): Promise<unknown> {
    return this.request("GET", "/accountBook/getShareAccount/{userId}", { params: { userId } });
  }

  getAccountMember(userId: string | number, bookId: string | number): Promise<unknown> {
    return this.request("GET", "/accountBook/getAccountMember/{userId}/{bookId}", { params: { userId, bookId } });
  }

  getAccountDeleteHistory(
    userId: string | number,
    ownerId: string | number,
    bookId: string | number,
    lastSyncTime: string | number,
  ): Promise<unknown> {
    return this.request("GET", "/accountBook/getAccountDeleteHistory/{userId}/{ownerId}/{bookId}/{lastSyncTime}", {
      params: { userId, ownerId, bookId, lastSyncTime },
    });
  }

  getAsset(userId: string | number, time: string | number): Promise<unknown> {
    return this.request("GET", "/asset/getAsset/{userId}/{time}", { params: { userId, time } });
  }

  getCurrencyData(userId: string | number): Promise<unknown> {
    return this.request("GET", "/currency/getCurrencyData/{userId}", { params: { userId } });
  }

  getCategoryInfo(userId: string | number): Promise<unknown> {
    return this.request("GET", "/icon/getCategoryInfo/{userId}", { params: { userId } });
  }

  /** 对象存储临时凭证：返回原始响应体（code/result 均保留） */
  async getSts(userId: string | number): Promise<unknown> {
    return this.request("GET", "/app/getSts/{userId}", { params: { userId }, raw: true });
  }

  async getStsNoVerify(): Promise<unknown> {
    return this.request("GET", "/app/getStsNoVerify/", { raw: true });
  }

  // ---------------- 写入 ----------------

  addOrUpdateBill(bill: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", "/bill/addOrUpdateBill", { body: normalizeBill(bill) });
  }

  /** 批量写账单：按 100 条一批，每批内 updateTime 递增（与网页端一致） */
  async addOrUpdateBillList(bills: Array<Record<string, unknown>>): Promise<unknown> {
    const CHUNK = 100;
    const results: unknown[] = [];
    let ts = Date.now();
    for (let i = 0; i < bills.length; i += CHUNK) {
      const chunk = bills.slice(i, i + CHUNK).map((b) => {
        ts += 1;
        return normalizeBill({ ...b, updateTime: ts });
      });
      const r = await this.request("POST", "/bill/addOrUpdateBillList", { body: chunk });
      if (Array.isArray(r)) results.push(...r);
      else results.push(r);
    }
    return results;
  }

  deleteBill(billId: string | number, userId?: string | number): Promise<unknown> {
    return this.request("POST", "/bill/deleteBill", {
      body: { billId, ...(userId !== undefined ? { userId } : {}) },
    });
  }

  /** 通用实体保存：POST /{domain}/{action} */
  addOrUpdateEntity(domain: string, action: string, body: unknown): Promise<unknown> {
    return this.request("POST", `/${domain}/${action}`, { body });
  }

  // ---------------- 同步限流会话 ----------------

  syncStart(): Promise<unknown> {
    return this.request("POST", "/bookkeeping/rateLimit/sync/start");
  }

  syncEnd(sessionId?: string): Promise<unknown> {
    return this.request("POST", "/bookkeeping/rateLimit/sync/end", {
      query: sessionId ? { sessionId } : {},
    });
  }

  // ---------------- 记账文本解析 ----------------

  parseBillText(userId: string | number, text: string): Promise<unknown> {
    return this.request("GET", "/bill/analysisBillInfoT/{userId}/{text}", {
      params: { userId, text: encodeURIComponent(text) },
    });
  }
}
