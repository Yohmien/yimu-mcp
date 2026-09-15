// jsqr 类型覆盖：包内 index.d.ts 用 ESM 语法但包本身是 CJS（无 type:module），
// NodeNext 下默认/命名空间导入均被解析为模块命名空间导致不可调用；此处给出最小正确签名。
declare module "jsqr" {
  export interface QRCode {
    data: string;
  }
  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
  ): QRCode | null;
}
