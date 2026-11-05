"use client";

import { useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/tauri";
import { countWords } from "@/lib/wordcount";

type CatalogChapter = { title: string; url: string };

type Catalog = { book_title: string; chapters: CatalogChapter[] };

/** scrape_chapter 返回：章节名（h3.j_chapterName）+ 正文纯文本 */
type ChapterContent = { title: string; content: string };

type FailedChapter = { title: string; url: string; reason: string };

export type WebChapter = { title: string; lines: string[]; level?: number };

interface Props {
  /** 抓取完成后回调，把章节数据交给父组件 */
  onLoaded: (bookTitle: string, chapters: WebChapter[]) => void;
  /** 当前是否启用（tab 切换） */
  active: boolean;
}

/** 每抓取 N 章重写一次 epub（epub 不支持真正追加，只能整包重写） */
const REWRITE_EVERY = 5;

/** 文件名清理：去掉路径分隔符与非法字符。 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\n\r\t]/g, "_").trim();
  return cleaned || "未命名";
}

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const marker = "Error invoking remote method";
  const i = raw.indexOf(marker);
  if (i < 0) return raw;
  const after = raw.slice(i + marker.length);
  const colon = after.indexOf(":");
  return colon >= 0 ? after.slice(colon + 1).trim() : raw;
}

export default function WebDownloader({ onLoaded, active }: Props) {
  const [url, setUrl] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedChapter[]>([]);
  const abortRef = useRef(false);

  useEffect(() => () => { abortRef.current = true; }, []);

  async function handleParse() {
    if (!isTauri()) {
      setError("请在桌面应用中使用网页抓取");
      return;
    }
    if (!url.trim()) {
      setError("请输入目录页地址");
      return;
    }
    setError(null);
    setCatalog(null);
    setSavedPath(null);
    setFailed([]);
    setParsing(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const cat: Catalog = await invoke("scrape_catalog", { url: url.trim() });
      if (!cat.chapters.length) {
        setError("未识别到任何章节链接");
      } else {
        setCatalog(cat);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setParsing(false);
    }
  }

  async function handleDownload() {
    if (!catalog || downloading) return;
    if (!isTauri()) {
      setError("请在桌面应用中使用网页抓取");
      return;
    }

    const { open, message } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择保存文件夹",
    });
    if (typeof dir !== "string") return;

    const { invoke } = await import("@tauri-apps/api/core");
    const path = `${dir}/${safeFileName(catalog.book_title)}.epub`;

    setError(null);
    setFailed([]);
    setSavedPath(null);
    setDownloading(true);
    setProgress({ done: 0, total: catalog.chapters.length });
    abortRef.current = false;

    const chapters: WebChapter[] = [];
    const failures: FailedChapter[] = [];
    let written = 0;

    // 把已抓到的章节整体写入 epub（覆盖写）
    const flush = async () => {
      await invoke("generate_epub", {
        path,
        title: catalog.book_title,
        author: null,
        chapters: chapters.map((c) => ({
          title: c.title,
          content: c.lines.join("\n"),
        })),
      });
      written = chapters.length;
    };

    try {
      // 1) 先创建空白 epub
      await invoke("generate_epub", {
        path,
        title: catalog.book_title,
        author: null,
        chapters: [],
      });
      setSavedPath(path);

      // 2) 顺序逐章抓取，边抓边写
      for (let i = 0; i < catalog.chapters.length; i++) {
        if (abortRef.current) break;
        const ref = catalog.chapters[i];
        try {
          const got = await invoke<ChapterContent>("scrape_chapter", {
            url: ref.url,
          });
          const title = (got.title || "").trim() || ref.title;
          chapters.push({ title, lines: got.content.split("\n") });
        } catch (e) {
          failures.push({ title: ref.title, url: ref.url, reason: errText(e) });
        }
        setProgress({ done: i + 1, total: catalog.chapters.length });
        setFailed([...failures]);
        if (chapters.length - written >= REWRITE_EVERY) {
          await flush();
        }
      }

      // 3) 收尾写盘
      if (chapters.length > written) await flush();

      if (chapters.length === 0) {
        setError("所有章节抓取失败，已保留空白 epub 文件");
      } else {
        onLoaded(catalog.book_title, chapters);
      }

      // 4) 完成提示：路径 + 成功/失败统计
      const lines = [
        `保存位置：${path}`,
        `成功 ${chapters.length} 章，失败 ${failures.length} 章`,
      ];
      if (failures.length) {
        lines.push("", "失败章节（前 10 条）：");
        failures.slice(0, 10).forEach((f) => lines.push(`· ${f.title}`));
      }
      await message(lines.join("\n"), {
        title: "抓取完成",
        kind: failures.length ? "warning" : "info",
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setDownloading(false);
    }
  }

  function handleStop() {
    abortRef.current = true;
  }

  if (!active) return null;

  return (
    <div className="split-controls">
      <div className="level-hint">从目录页地址下载小说章节</div>
      <input
        type="url"
        className="text-input"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://www.example.com/book/1234/"
        disabled={parsing || downloading}
      />
      <button
        className="btn"
        onClick={handleParse}
        disabled={parsing || !url.trim()}
      >
        {parsing ? "解析中…" : "解析目录"}
      </button>

      {error && <div className="download-error">{error}</div>}

      {catalog && (
        <>
          <div className="catalog-summary">
            书籍：{catalog.book_title} · {catalog.chapters.length} 章
          </div>
          <div className="catalog-preview">
            {catalog.chapters.slice(0, 15).map((c, i) => (
              <div key={i} className="catalog-item" title={c.url}>
                {i + 1}. {c.title}
              </div>
            ))}
            {catalog.chapters.length > 15 && (
              <div className="catalog-more">
                …还有 {catalog.chapters.length - 15} 章
              </div>
            )}
          </div>

          {savedPath && (
            <div className="catalog-summary">保存位置：{savedPath}</div>
          )}

          {failed.length > 0 && (
            <div className="failed-list">
              <div className="failed-title">
                抓取失败 {failed.length} 章
              </div>
              {failed.slice(0, 20).map((f, i) => (
                <div key={i} className="failed-item" title={f.reason}>
                  {f.title}
                </div>
              ))}
              {failed.length > 20 && (
                <div className="catalog-more">…还有 {failed.length - 20} 章失败</div>
              )}
            </div>
          )}

          {downloading ? (
            <>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    width: `${
                      progress.total
                        ? Math.round((progress.done / progress.total) * 100)
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="progress-text">
                {progress.done} / {progress.total}
              </div>
              <button className="btn" onClick={handleStop}>
                停止
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={handleDownload}>
              选择文件夹并开始抓取
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** 计算当前抓取状态的总字数 */
export function totalWords(chapters: WebChapter[]): number {
  return chapters.reduce(
    (sum, c) => sum + countWords(c.lines.join("\n")),
    0
  );
}
