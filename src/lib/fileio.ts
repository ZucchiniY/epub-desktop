import { isTauri } from "./tauri";
import { decodeText } from "./encoding";

export interface LoadedFile {
  /** 文件名（basename） */
  name: string;
  /** 原文件路径（Tauri 打开时有值；浏览器降级为 undefined） */
  path?: string;
  /** 原始全文（打开时快照），用于脏计算 */
  text: string;
}

export async function openTextFile(): Promise<LoadedFile | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const selected = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (typeof selected !== "string") return null;
    const bytes = await readFile(selected);
    return {
      name: selected.split(/[\\/]/).pop() ?? selected,
      path: selected,
      text: decodeText(bytes),
    };
  }
  return new Promise<LoadedFile | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({
        name: file.name,
        text: decodeText(bytes),
      });
    };
    input.click();
  });
}

/**
 * 将文本保存为 .txt 文件。
 * - Tauri：弹出 save 对话框让用户选择位置（避免静默覆盖）；
 * - 浏览器：触发浏览器下载。
 */
export async function saveTextFile(
  text: string,
  defaults: { name: string; path?: string }
): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const target = await save({
      defaultPath: defaults.name.endsWith(".txt")
        ? defaults.name
        : defaults.name + ".txt",
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (typeof target !== "string") return null;
    const encoder = new TextEncoder();
    await writeFile(target, encoder.encode(text));
    return target;
  }
  // 浏览器降级
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaults.name.endsWith(".txt")
    ? defaults.name
    : defaults.name + ".txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return "browser-download";
}

/** 将章节列表合并为可再次分章的 TXT：每段 title 独立一行 + 内容段。 */
export function chaptersToText(chapters: { title: string; lines: string[] }[]): string {
  const parts: string[] = [];
  for (const c of chapters) {
    parts.push(c.title);
    if (c.lines.length > 0) parts.push(c.lines.join("\n"));
  }
  return parts.join("\n") + (parts.length ? "\n" : "");
}
