export type HeadingPattern = "chapter" | "section" | "paren";

export type SplitOptions =
  | {
      kind: "auto";
      /** 旧版固定模式；与 levels 二选一 */
      patterns?: HeadingPattern[];
      /** 多级分章：从高到低的级别单位，如 ["部","章","节"] */
      levels?: string[];
      /** 多级分章时是否把 (X) 标题作为最细层级 */
      paren?: boolean;
    }
  | { kind: "manual"; manualType: "text" | "regex"; feature: string };

export interface Chapter {
  title: string;
  lines: string[];
  startLine: number;
  /** 层级深度（0 = 前言/全文，1 = 最高级，多级分章时存在） */
  level?: number;
}

export type SplitResult =
  | { ok: true; chapters: Chapter[] }
  | { ok: false; error: string };

const NUM_CHARS = "〇零一二三四五六七八九十百千万亿0-9０-９";

const PATTERNS: Record<HeadingPattern, RegExp> = {
  chapter: /^第[〇零一二三四五六七八九十百千万亿0-9０-９]+[章回卷部篇]/u,
  section: /^第[〇零一二三四五六七八九十百千万亿0-9０-９]+节/u,
  paren: /^[（(][〇零一二三四五六七八九十百千万亿0-9０-９]+[）)]/u,
};

const EMPTY_FEATURE_ERROR = "请输入检索特征文本";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 为每个级别单位构造标题正则：^第<数字><单位>，且单位后不能紧跟另一个
 * 汉字（避免把「第三部门」误判为「第三部」标题）。
 */
function buildLevelRegexes(units: string[]): RegExp[] {
  return units
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .map(
      (u) =>
        new RegExp(
          `^第[${NUM_CHARS}]+${escapeRegExp(u)}(?![一-鿿㐀-䶿])`,
          "u"
        )
    );
}

/** 返回标题层级（1 = 最高级），非标题返回 0 */
function matchHeadingLevel(
  trimmed: string,
  regexes: RegExp[],
  paren: boolean
): number {
  for (let i = 0; i < regexes.length; i++) {
    if (regexes[i].test(trimmed)) return i + 1;
  }
  if (paren && PATTERNS.paren.test(trimmed)) return regexes.length + 1;
  return 0;
}

function splitByLevels(text: string, units: string[], paren: boolean): SplitResult {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const regexes = buildLevelRegexes(units);

  const chapters: Chapter[] = [];
  const stack: Chapter[] = [];
  const preamble: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const level = trimmed.length > 0 ? matchHeadingLevel(trimmed, regexes, paren) : 0;
    if (level > 0) {
      while (stack.length >= level) stack.pop();
      const node: Chapter = { title: trimmed, lines: [], startLine: i, level };
      chapters.push(node);
      stack.push(node);
    } else if (stack.length === 0) {
      if (trimmed.length > 0) preamble.push(lines[i]);
    } else {
      stack[stack.length - 1].lines.push(lines[i]);
    }
  }

  if (chapters.length === 0) {
    return {
      ok: true,
      chapters: [{ title: "全文", lines, startLine: 0, level: 0 }],
    };
  }
  if (preamble.length > 0) {
    chapters.unshift({ title: "前言", lines: preamble, startLine: 0, level: 0 });
  }
  return { ok: true, chapters };
}

function isHeadingLine(trimmed: string, options: SplitOptions, regex?: RegExp): boolean {
  if (trimmed.length === 0) return false;
  if (options.kind === "auto") {
    return (options.patterns ?? []).some((p) => PATTERNS[p].test(trimmed));
  }
  if (options.manualType === "text") {
    return trimmed.includes(options.feature);
  }
  return regex !== undefined && regex.test(trimmed);
}

export function splitChapters(text: string, options: SplitOptions): SplitResult {
  // 多级分章路径
  if (options.kind === "auto" && options.levels !== undefined) {
    return splitByLevels(text, options.levels, options.paren ?? false);
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let regex: RegExp | undefined;
  if (options.kind === "manual" && options.feature.length === 0) {
    return { ok: false, error: EMPTY_FEATURE_ERROR };
  }
  if (options.kind === "manual" && options.manualType === "regex") {
    try {
      regex = new RegExp(options.feature);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `正则表达式无效：${message}` };
    }
  }

  const headings: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (isHeadingLine(trimmed, options, regex)) headings.push(i);
  }

  if (headings.length === 0) {
    return { ok: true, chapters: [{ title: "全文", lines, startLine: 0 }] };
  }

  const chapters: Chapter[] = [];
  const preamble = lines.slice(0, headings[0]).filter((l) => l.trim().length > 0);
  if (preamble.length > 0) {
    chapters.push({ title: "前言", lines: preamble, startLine: 0 });
  }

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i];
    const end = i + 1 < headings.length ? headings[i + 1] : lines.length;
    chapters.push({
      title: lines[start].trim(),
      lines: lines.slice(start + 1, end),
      startLine: start,
    });
  }

  return { ok: true, chapters };
}
