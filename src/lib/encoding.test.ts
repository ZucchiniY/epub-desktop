import { describe, expect, it } from "vitest";
import { decodeText } from "./encoding";

describe("decodeText", () => {
  it("解码合法的 UTF-8 字节", () => {
    const bytes = new Uint8Array([0xe7, 0xac, 0xac, 0xe4, 0xb8, 0x80, 0xe7, 0xab, 0xa0]);
    expect(decodeText(bytes)).toBe("第一章");
  });

  it("GBK 编码的中文回退解码成功（第一章）", () => {
    const bytes = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
    expect(decodeText(bytes)).toBe("第一章");
  });

  it("GBK 编码的中文回退解码成功（测试文本）", () => {
    const bytes = new Uint8Array([0xb2, 0xe2, 0xca, 0xd4, 0xce, 0xc4, 0xb1, 0xbe]);
    expect(decodeText(bytes)).toBe("测试文本");
  });

  it("空字节数组返回空字符串", () => {
    expect(decodeText(new Uint8Array(0))).toBe("");
  });
});
