"use client";

import { useEffect, useState } from "react";
import { splitChapters, type Chapter } from "@/lib/splitter";
import { openTextFile, type LoadedFile } from "@/lib/fileio";
import { isTauri } from "@/lib/tauri";
import { countWords } from "@/lib/wordcount";

function extractError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const marker = "Error invoking remote method";
  const i = raw.indexOf(marker);
  if (i < 0) return raw;
  const after = raw.slice(i + marker.length);
  const colon = after.indexOf(":");
  return colon >= 0 ? after.slice(colon + 1).trim() : raw;
}

export default function EpubTool() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [levels, setLevels] = useState<string[]>(["部", "章", "节"]);
  const [paren, setParen] = useState(true);
  const [manualType, setManualType] = useState<"text" | "regex">("text");
  const [feature, setFeature] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // 自动分章：加载文件或层级配置变化时重新分章
  useEffect(() => {
    if (!file || mode !== "auto") return;
    const result = splitChapters(file.text, { kind: "auto", levels, paren });
    if (result.ok) {
      setChapters(result.chapters);
      setSelected(0);
    }
  }, [file, mode, levels, paren]);

  // toast 定时消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleOpen() {
    try {
      const loaded = await openTextFile();
      if (!loaded) return;
      setFile(loaded);
      setChapters([]);
      setSelected(0);
    } catch {
      setToast("打开文件失败");
    }
  }

  function updateLevel(index: number, value: string) {
    setLevels((prev) => prev.map((u, i) => (i === index ? value : u)));
  }

  function removeLevel(index: number) {
    setLevels((prev) => prev.filter((_, i) => i !== index));
  }

  function addLevel() {
    setLevels((prev) => [...prev, ""]);
  }

  function reSplitAuto() {
    if (!file) return;
    const result = splitChapters(file.text, { kind: "auto", levels, paren });
    if (result.ok) {
      setChapters(result.chapters);
      setSelected(0);
    }
  }

  function applyManual() {
    if (!file) return;
    const result = splitChapters(file.text, {
      kind: "manual",
      manualType,
      feature,
    });
    if (result.ok) {
      setChapters(result.chapters);
      setSelected(0);
    } else {
      setToast(result.error);
    }
  }

  async function handleExport() {
    if (!isTauri()) {
      setToast("请在桌面应用中导出 EPUB");
      return;
    }
    if (!file || chapters.length === 0) {
      setToast("请先加载文件并完成分章");
      return;
    }
    const base = file.name.replace(/\.txt$/i, "");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await save({
      defaultPath: base + ".epub",
      filters: [{ name: "EPUB 电子书", extensions: ["epub"] }],
    });
    if (!path) return;
    setExporting(true);
    try {
      await invoke("generate_epub", {
        path,
        title: base,
        author: null,
        chapters: chapters.map((c) => ({
          title: c.title,
          content: c.lines.join("\n"),
        })),
      });
      setToast("EPUB 导出成功");
    } catch (err) {
      setToast(extractError(err));
    } finally {
      setExporting(false);
    }
  }

  function updateChapterContent(index: number, content: string) {
    setChapters((prev) =>
      prev.map((c, i) => (i === index ? { ...c, lines: content.split("\n") } : c))
    );
  }

  const current = chapters[selected];

  return (
    <div className="app">
      <header className="toolbar">
        <h1>TXT 分章导出 EPUB</h1>
        <span className="file-info">
          {file ? `${file.name} · ${chapters.length} 章` : "未加载文件"}
        </span>
        <button className="btn" onClick={handleOpen}>
          打开文件
        </button>
        <button
          className="btn primary"
          onClick={handleExport}
          disabled={exporting}
        >
          {exporting ? "导出中…" : "导出 EPUB"}
        </button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="split-controls">
            <div className="mode-row">
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "auto"}
                  onChange={() => setMode("auto")}
                />{" "}
                自动分章
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "manual"}
                  onChange={() => setMode("manual")}
                />{" "}
                手工分章
              </label>
            </div>

            {mode === "auto" ? (
              <>
                <div className="level-editor">
                  <div className="level-hint">拆分层级（第X…，由高到低）</div>
                  {levels.map((unit, idx) => (
                    <div className="level-row" key={idx}>
                      <span className="level-prefix">第X</span>
                      <input
                        type="text"
                        className="level-input text-input"
                        value={unit}
                        onChange={(e) => updateLevel(idx, e.target.value)}
                        placeholder="部 / 章 / 节"
                        maxLength={4}
                      />
                      <button
                        type="button"
                        className="level-del"
                        onClick={() => removeLevel(idx)}
                        title="删除该层级"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn level-add"
                    onClick={addLevel}
                  >
                    + 添加层级
                  </button>
                  <label className="paren-toggle">
                    <input
                      type="checkbox"
                      checked={paren}
                      onChange={(e) => setParen(e.target.checked)}
                    />{" "}
                    识别 (X) 标题（最细层级）
                  </label>
                </div>
                <button className="btn" onClick={reSplitAuto}>
                  重新分章
                </button>
              </>
            ) : (
              <>
                <div className="radio-group">
                  <label>
                    <input
                      type="radio"
                      name="manualType"
                      checked={manualType === "text"}
                      onChange={() => setManualType("text")}
                    />{" "}
                    特征文本检索
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="manualType"
                      checked={manualType === "regex"}
                      onChange={() => setManualType("regex")}
                    />{" "}
                    正则表达式
                  </label>
                </div>
                <input
                  type="text"
                  className="text-input"
                  value={feature}
                  onChange={(e) => setFeature(e.target.value)}
                  placeholder={manualType === "text" ? "如：卷" : "如：^第.+卷"}
                />
                <button className="btn" onClick={applyManual}>
                  应用分章
                </button>
              </>
            )}
          </div>

          <div className="chapter-list">
            {chapters.map((c, i) => (
              <button
                key={i}
                className={
                  "chapter-item" + (i === selected ? " active" : "")
                }
                style={{ paddingLeft: 16 + (c.level ?? 0) * 16 }}
                onClick={() => setSelected(i)}
              >
                <span className="chapter-name">
                  {i + 1}. {c.title}
                </span>
                <span className="chapter-words">
                  {countWords(c.lines.join("\n"))} 字
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="content">
          {current ? (
            <>
              <h2>{current.title}</h2>
              <textarea
                className="content-text"
                value={current.lines.join("\n")}
                onChange={(e) => updateChapterContent(selected, e.target.value)}
                spellCheck={false}
                placeholder="可在此直接修改或添加文本…"
              />
            </>
          ) : (
            <p className="empty-state">
              {file ? "请应用分章以查看章节内容" : "打开一个 TXT 文件开始分章"}
            </p>
          )}
        </main>
      </div>

      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
