import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthState } from "./api.ts";

const AAD = Buffer.from("yimu-mcp-auth-v1", "utf8");

interface StoredRow {
  ciphertext: string;
  nonce: string;
  tag: string;
}

/** SQLite 中只保存 AES-256-GCM 密文；密钥只来自本机环境变量。 */
export class TokenStore {
  private readonly dbPath: string;
  private readonly key: Buffer | null;
  private db: DatabaseSync | null = null;

  constructor(dbPath: string, secret: string) {
    this.dbPath = dbPath;
    this.key = secret
      ? createHash("sha256").update(secret, "utf8").digest()
      : null;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  load(): AuthState | null {
    if (!this.key) return null;
    try {
      const db = this.database();
      const row = db
        .prepare("SELECT ciphertext, nonce, tag FROM auth_state WHERE id = 1")
        .get() as StoredRow | undefined;
      if (!row) return null;

      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(row.nonce, "base64"),
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(row.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const state = JSON.parse(plain) as Partial<AuthState>;
      if (typeof state.token !== "string" || !state.token) {
        throw new Error("saved auth state has no token");
      }
      return {
        token: state.token,
        userToken: typeof state.userToken === "string" ? state.userToken : "",
        userId: typeof state.userId === "string" ? state.userId : "",
      };
    } catch {
      this.note("已保存的登录状态无法解密，忽略本地登录状态");
      return null;
    }
  }

  save(state: AuthState): void {
    if (!this.key || !state.token) return;
    try {
      const db = this.database();
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(state), "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      db.prepare(
        "INSERT INTO auth_state (id, ciphertext, nonce, tag, updated_at) " +
          "VALUES (1, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext, " +
          "nonce=excluded.nonce, tag=excluded.tag, updated_at=excluded.updated_at",
      ).run(
        ciphertext.toString("base64"),
        nonce.toString("base64"),
        tag.toString("base64"),
        Date.now(),
      );
    } catch {
      this.note("登录状态保存失败，本次登录仍可继续但重启后需要重新登录");
    }
  }

  clear(): void {
    if (!this.key) return;
    try {
      this.database().prepare("DELETE FROM auth_state WHERE id = 1").run();
    } catch {
      this.note("已失效的本地登录状态清理失败");
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // 进程退出时忽略关闭错误。
    }
    this.db = null;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS auth_state (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), " +
        "ciphertext TEXT NOT NULL, " +
        "nonce TEXT NOT NULL, " +
        "tag TEXT NOT NULL, " +
        "updated_at INTEGER NOT NULL" +
        ")",
    );
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Windows 的文件权限由用户目录 ACL 保护。
    }
    return this.db;
  }

  private note(message: string): void {
    process.stderr.write("[yimu-mcp] " + message + "\n");
  }
}
