import { describe, it, expect } from "vitest";
import { countWords } from "./wordcount";

describe("countWords", () => {
  it("空字符串为 0", () => {
    expect(countWords("")).toBe(0);
  });

  it("纯空白（空格/换行/制表符/全角空格）为 0", () => {
    expect(countWords(" \n\t　 \r\n")).toBe(0);
  });

  it("统计中文字数（忽略空白）", () => {
    expect(countWords("第一章 正文内容")).toBe(7);
  });

  it("多行文本：换行不计入字数", () => {
    expect(countWords("你好\n世界")).toBe(4);
  });

  it("中文标点计入字数", () => {
    expect(countWords("你好，世界！")).toBe(6);
  });

  it("字母与数字按字符计入", () => {
    expect(countWords("abc 123")).toBe(6);
  });
});
