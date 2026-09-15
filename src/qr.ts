// 二维码工具：渲染/保存登录二维码、终端直显、从图片识别二维码内容。
// 扫码会话由服务端下发 sessionId，二维码内容为 `login:<sessionId>`。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import jsQR from "jsqr";

/** 默认二维码保存目录：系统临时目录下的 yimu-mcp 子目录 */
export function defaultQrDir(): string {
  return path.join(os.tmpdir(), "yimu-mcp");
}

/** 生成二维码 PNG */
export async function renderQrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { type: "png", margin: 2, width: 320, errorCorrectionLevel: "M" });
}

/**
 * 生成终端二维码文本。
 * utf8：半块字符（▀▄█），无 ANSI 转义，任何等宽终端/聊天界面可直接显示；
 * ansi：ANSI 彩色半块，Windows Terminal 等支持 VT 的终端显示更好（带转义码）。
 */
export async function renderQrTerminal(text: string, mode: "utf8" | "ansi" = "utf8"): Promise<string> {
  return QRCode.toString(text, { type: mode === "ansi" ? "terminal" : "utf8", small: true });
}

/** 生成二维码 PNG 并保存到目录，返回文件路径 */
export async function saveQrPng(text: string, dir: string, name: string): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, await renderQrPng(text));
  return file;
}

/** 从 PNG 图片文件识别二维码，返回其文本内容；未识别到抛错 */
export async function recognizeQrImage(file: string): Promise<string> {
  const png = PNG.sync.read(fs.readFileSync(file));
  const data = new Uint8ClampedArray(png.data);
  const code = jsQR(data, png.width, png.height);
  if (!code || !code.data) throw new Error(`未从图片识别到二维码: ${file}`);
  return code.data;
}
