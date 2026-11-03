import { describe, it, expect } from "vitest";
import { splitChapters, type Chapter, type SplitResult } from "./splitter";

function okChapters(result: SplitResult): Chapter[] {
  if (!result.ok) {
    throw new Error(`预期成功，实际失败：${result.error}`);
  }
  return result.chapters;
}

describe("splitChapters 自动模式", () => {
  it("中文数字标题：第一章/第二章，startLine 正确", () => {
    const chapters = okChapters(
      splitChapters("第一章\n正文A\n第二章\n正文B", { kind: "auto", patterns: ["chapter"] })
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe("第一章");
    expect(chapters[0].lines).toEqual(["正文A"]);
    expect(chapters[0].startLine).toBe(0);
    expect(chapters[1].title).toBe("第二章");
    expect(chapters[1].lines).toEqual(["正文B"]);
    expect(chapters[1].startLine).toBe(2);
  });

  it("阿拉伯数字标题：第1章/第2章", () => {
    const chapters = okChapters(
      splitChapters("第1章\n内容A\n第2章\n内容B", { kind: "auto", patterns: ["chapter"] })
    );
    expect(chapters).toHaveLength(2);
    expect(chapters.map((c) => c.title)).toEqual(["第1章", "第2章"]);
  });

  it("全角数字标题：第０１章", () => {
    const chapters = okChapters(
      splitChapters("第０１章\n内容", { kind: "auto", patterns: ["chapter"] })
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("第０１章");
  });

  it("节标题：第1节/第2节", () => {
    const chapters = okChapters(
      splitChapters("第1节\n内容A\n第2节\n内容B", { kind: "auto", patterns: ["section"] })
    );
    expect(chapters).toHaveLength(2);
    expect(chapters.map((c) => c.title)).toEqual(["第1节", "第2节"]);
  });

  it("括号标题：（一）（二）、(1)(2)、（3）（4）", () => {
    const cases: Array<[string, string[]]> = [
      ["（一）\n内容A\n（二）\n内容B", ["（一）", "（二）"]],
      ["(1)\n内容A\n(2)\n内容B", ["(1)", "(2)"]],
      ["（3）\n内容A\n（4）\n内容B", ["（3）", "（4）"]],
    ];
    for (const [text, titles] of cases) {
      const chapters = okChapters(
        splitChapters(text, { kind: "auto", patterns: ["paren"] })
      );
      expect(chapters.map((c) => c.title)).toEqual(titles);
    }
  });

  it("混合标题：第一章/第3节/（三），patterns 为全部三类", () => {
    const chapters = okChapters(
      splitChapters("第一章\n第3节\n（三）\n内容", {
        kind: "auto",
        patterns: ["chapter", "section", "paren"],
      })
    );
    expect(chapters).toHaveLength(3);
    expect(chapters.map((c) => c.title)).toEqual(["第一章", "第3节", "（三）"]);
  });

  it("模式子集：仅启用 chapter 时其余标题行作为内容", () => {
    const chapters = okChapters(
      splitChapters("第一章\n第3节\n（三）\n内容", { kind: "auto", patterns: ["chapter"] })
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("第一章");
    expect(chapters[0].lines).toEqual(["第3节", "（三）", "内容"]);
  });

  it("前言：第一个标题前的非空内容归入「前言」", () => {
    const chapters = okChapters(
      splitChapters("楔子\n\n第一章\n正文", { kind: "auto", patterns: ["chapter"] })
    );
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe("前言");
    expect(chapters[0].lines).toEqual(["楔子"]);
    expect(chapters[1].title).toBe("第一章");
  });

  it("无标题匹配 → 全文（含 patterns 为空数组）", () => {
    const byText = okChapters(
      splitChapters("一些普通内容\n更多内容", {
        kind: "auto",
        patterns: ["chapter", "section", "paren"],
      })
    );
    expect(byText).toHaveLength(1);
    expect(byText[0].title).toBe("全文");
    expect(byText[0].lines).toEqual(["一些普通内容", "更多内容"]);

    const byEmptyPatterns = okChapters(
      splitChapters("内容", { kind: "auto", patterns: [] })
    );
    expect(byEmptyPatterns).toHaveLength(1);
    expect(byEmptyPatterns[0].title).toBe("全文");
  });
});

describe("splitChapters 手工模式", () => {
  it("特征文本：feature=卷", () => {
    const chapters = okChapters(
      splitChapters("第一卷 序章\n内容A\n第二卷 终章\n内容B", {
        kind: "manual",
        manualType: "text",
        feature: "卷",
      })
    );
    expect(chapters).toHaveLength(2);
    expect(chapters.map((c) => c.title)).toEqual(["第一卷 序章", "第二卷 终章"]);
  });

  it("正则：^第.+卷", () => {
    const chapters = okChapters(
      splitChapters("第一卷 序章\n内容A\n第二卷 终章\n内容B", {
        kind: "manual",
        manualType: "regex",
        feature: "^第.+卷",
      })
    );
    expect(chapters).toHaveLength(2);
    expect(chapters.map((c) => c.title)).toEqual(["第一卷 序章", "第二卷 终章"]);
  });

  it("非法正则 → ok:false 且 error 含「无效」", () => {
    const result = splitChapters("内容", {
      kind: "manual",
      manualType: "regex",
      feature: "[",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("无效");
    }
  });

  it("空特征 → ok:false", () => {
    const textResult = splitChapters("内容", { kind: "manual", manualType: "text", feature: "" });
    expect(textResult.ok).toBe(false);

    const regexResult = splitChapters("内容", { kind: "manual", manualType: "regex", feature: "" });
    expect(regexResult.ok).toBe(false);
  });
});

describe("splitChapters 多级分章（levels）", () => {
  it("两级 部/章：部 level 1、章 level 2，部无正文时 lines 为空", () => {
    const text = "第一部 风起\n第一章 启程\n正文A\n第二章 归途\n正文B";
    const chapters = okChapters(
      splitChapters(text, { kind: "auto", levels: ["部", "章"] })
    );
    expect(chapters.map((c) => c.title)).toEqual([
      "第一部 风起",
      "第一章 启程",
      "第二章 归途",
    ]);
    expect(chapters.map((c) => c.level)).toEqual([1, 2, 2]);
    expect(chapters[0].lines).toEqual([]);
    expect(chapters[1].lines).toEqual(["正文A"]);
    expect(chapters[2].lines).toEqual(["正文B"]);
    expect(chapters[1].startLine).toBe(1);
  });

  it("三级 部/章/节：层级深度依次为 1/2/3", () => {
    const chapters = okChapters(
      splitChapters("第一部\n第一章\n第一节\n内容", {
        kind: "auto",
        levels: ["部", "章", "节"],
      })
    );
    expect(chapters.map((c) => c.level)).toEqual([1, 2, 3]);
    expect(chapters[2].lines).toEqual(["内容"]);
  });

  it("新部开始时旧章出栈：跨部章节层级正确", () => {
    const text = "第一部\n第一章\nA\n第二章\nB\n第二部\n第三章\nC";
    const chapters = okChapters(
      splitChapters(text, { kind: "auto", levels: ["部", "章"] })
    );
    expect(chapters.map((c) => c.title)).toEqual([
      "第一部",
      "第一章",
      "第二章",
      "第二部",
      "第三章",
    ]);
    expect(chapters.map((c) => c.level)).toEqual([1, 2, 2, 1, 2]);
    expect(chapters[4].lines).toEqual(["C"]);
  });

  it("部标题与其后第一章之间的直接正文归入部节点", () => {
    const chapters = okChapters(
      splitChapters("第一部 风起\n部简介内容\n第一章\n章内容", {
        kind: "auto",
        levels: ["部", "章"],
      })
    );
    expect(chapters[0].lines).toEqual(["部简介内容"]);
    expect(chapters[1].lines).toEqual(["章内容"]);
  });

  it("自定义级别单位：卷/章", () => {
    const chapters = okChapters(
      splitChapters("第一卷 序卷\n第一章\nA", {
        kind: "auto",
        levels: ["卷", "章"],
      })
    );
    expect(chapters.map((c) => c.title)).toEqual(["第一卷 序卷", "第一章"]);
    expect(chapters.map((c) => c.level)).toEqual([1, 2]);
  });

  it("paren 作为最细层级：部/章 + (X) → level 3", () => {
    const chapters = okChapters(
      splitChapters("第一部\n第一章\n（一）\n内容", {
        kind: "auto",
        levels: ["部", "章"],
        paren: true,
      })
    );
    expect(chapters.map((c) => c.level)).toEqual([1, 2, 3]);
  });

  it("无 levels 仅启用 paren 时括号标题为 level 1", () => {
    const chapters = okChapters(
      splitChapters("（一）\nA\n（二）\nB", {
        kind: "auto",
        levels: [],
        paren: true,
      })
    );
    expect(chapters.map((c) => c.level)).toEqual([1, 1]);
  });

  it("paren 关闭时括号标题行作为普通内容", () => {
    const chapters = okChapters(
      splitChapters("第一部\n（一）\n内容", {
        kind: "auto",
        levels: ["部"],
        paren: false,
      })
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("第一部");
    expect(chapters[0].lines).toEqual(["（一）", "内容"]);
  });

  it("边界：'第三部门' 不识别为部标题（unit 后紧跟汉字）", () => {
    const chapters = okChapters(
      splitChapters("第三部门负责此事\n普通内容", {
        kind: "auto",
        levels: ["部"],
      })
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("全文");
  });

  it("阿拉伯数字与带标点标题：第1部 / 第二节：细节", () => {
    const chapters = okChapters(
      splitChapters("第1部 起源\n第二节：细节\n内容", {
        kind: "auto",
        levels: ["部", "节"],
      })
    );
    expect(chapters.map((c) => c.title)).toEqual(["第1部 起源", "第二节：细节"]);
    expect(chapters.map((c) => c.level)).toEqual([1, 2]);
  });

  it("前言为 level 0", () => {
    const chapters = okChapters(
      splitChapters("楔子\n第一部\n第一章\nA", {
        kind: "auto",
        levels: ["部", "章"],
      })
    );
    expect(chapters[0].title).toBe("前言");
    expect(chapters[0].level).toBe(0);
    expect(chapters[0].lines).toEqual(["楔子"]);
  });

  it("空 unit 被忽略；无任何标题时返回全文", () => {
    const chapters = okChapters(
      splitChapters("普通内容", { kind: "auto", levels: [""], paren: false })
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("全文");
    expect(chapters[0].level).toBe(0);
  });
});

describe("splitChapters 其他", () => {
  it("CRLF 归一化：\\r\\n → \\n", () => {
    const chapters = okChapters(
      splitChapters("第一章\r\n正文", { kind: "auto", patterns: ["chapter"] })
    );
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("第一章");
    expect(chapters[0].lines).toEqual(["正文"]);
  });
});
