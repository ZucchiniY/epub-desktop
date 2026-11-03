import { isTauri } from "./tauri";
import { decodeText } from "./encoding";

export interface LoadedFile {
  name: string;
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
      resolve({ name: file.name, text: decodeText(bytes) });
    };
    input.click();
  });
}
