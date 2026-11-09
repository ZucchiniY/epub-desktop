"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { splitChapters, type Chapter } from "@/lib/splitter";
import {
  openTextFile,
  saveTextFile,
  chaptersToText,
  type LoadedFile,
} from "@/lib/fileio";
import { isTauri } from "@/lib/tauri";
import { countWords } from "@/lib/wordcount";
import WebDownloader, { type WebChapter } from "./WebDownloader";

function extractError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const marker = "Error invoking remote method";
  const i = raw.indexOf(marker);
  if (i < 0) return raw;
  const after = raw.slice(i + marker.length);
  const colon = after.indexOf(":");
  return colon >= 0 ? after.slice(colon + 1).trim() : raw;
}

/** 计算当前章节合并文本与原文件快照是否不同。 */
function computeDirty(file: LoadedFile | null, chapters: Chapter[]): boolean {
  if (!file) return false;
  return chaptersToText(chapters).trimEnd() !== file.text.trimEnd();
}

export default function EpubTool() {
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [source, setSource] = useState<"local" | "web">("local");
  const [levels, setLevels] = useState<string[]>(["部", "章", "节"]);
  const [paren, setParen] = useState(true);
  const [manualType, setManualType] = useState<"text" | "regex">("text");
  const [feature, setFeature] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);

  const dirty = computeDirty(file, chapters);

  // Cmd/Ctrl+S 触发保存
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [file, chapters]);

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

  async function handleSave() {
    if (!file || chapters.length === 0) {
      setToast("请先加载文件");
      return;
    }
    if (!dirty) {
      setToast("内容未修改");
      return;
    }
    const text = chaptersToText(chapters);
    setSaving(true);
    try {
      const savedPath = await saveTextFile(text, {
        name: file.name,
        path: file.path,
      });
      if (savedPath) {
        // 保存成功后用当前内容刷新"原文件快照"，使 dirty 归零
        setFile({ ...file, text });
        setToast("保存成功");
      }
    } catch (err) {
      setToast(extractError(err));
    } finally {
      setSaving(false);
    }
  }

  /** 网页下载完成回调：把 WebChapter 转成 Chapter，并入状态 */
  function handleWebLoaded(bookTitle: string, webChapters: WebChapter[]) {
    const ch: Chapter[] = webChapters.map((c, i) => ({
      title: c.title,
      lines: c.lines,
      startLine: i,
    }));
    setChapters(ch);
    setSelected(0);
    setFile({ name: bookTitle + ".txt", text: "" });
    setToast(`已加载 ${ch.length} 章：${bookTitle}`);
  }

  const current = chapters[selected];

  return (
    <div className="app">
      <header className="toolbar">
        <h1>TXT 分章导出 EPUB</h1>
        <span className="file-info">
          {file ? (
            <>
              {file.name}
              {dirty ? <span className="dirty-mark">•</span> : null} ·{" "}
              {chapters.length} 章
            </>
          ) : (
            "未加载文件"
          )}
        </span>
        <button className="btn" onClick={handleOpen}>
          打开文件
        </button>
        <button
          className="btn"
          onClick={handleSave}
          disabled={saving || !file || !dirty}
          title="Cmd/Ctrl+S"
        >
          {saving ? "保存中…" : dirty ? "保存" : "已保存"}
        </button>
        <button
          className="btn primary"
          onClick={handleExport}
          disabled={exporting}
        >
          {exporting ? "导出中…" : "导出 EPUB"}
        </button>
        <Link className="btn" href="/settings/">
          设置
        </Link>
      </header>

      <div className="body">
        <aside className="sidebar">
          {/* 来源切换 */}
          <div className="source-tabs">
            <button
              className={"source-tab" + (source === "local" ? " active" : "")}
              onClick={() => setSource("local")}
            >
              本地文件
            </button>
            <button
              className={"source-tab" + (source === "web" ? " active" : "")}
              onClick={() => setSource("web")}
            >
              网页下载
            </button>
          </div>

          {source === "web" ? (
            <WebDownloader active={source === "web"} onLoaded={handleWebLoaded} />
          ) : (
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
          )}

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
