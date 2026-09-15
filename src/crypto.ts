// 邮箱登录密码加密：网页端 getUserEmail 要求 AES-128-ECB 加密、十六进制大写提交，
// 密钥为固定 16 字节字符串 "YMJZWangHangZhou"，PKCS#7 填充。

import crypto from "node:crypto";

/** 登录密码加密密钥 */
const KEY = Buffer.from("YMJZWangHangZhou", "utf8");

/** 加密登录密码：AES-128-ECB(PKCS#7) + 大写十六进制 */
export function encryptPassword(plain: string): string {
  const cipher = crypto.createCipheriv("aes-128-ecb", KEY, null);
  cipher.setAutoPadding(true); // PKCS#7
  const out = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return out.toString("hex").toUpperCase();
}
