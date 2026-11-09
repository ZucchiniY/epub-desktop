"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  DEFAULT_THREADS,
  MAX_THREADS,
  MIN_THREADS,
  getThreads,
  setThreads,
} from "@/lib/settings";

export default function SettingsPage() {
  const [threads, setThreadsState] = useState(DEFAULT_THREADS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setThreadsState(getThreads());
  }, []);

  function handleSave(n: number) {
    setThreadsState(setThreads(n));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>设置</h1>
        <span className="file-info" />
        <Link className="btn" href="/">
          返回
        </Link>
      </header>

      <div className="settings-body">
        <div className="settings-row">
          <label htmlFor="threads">下载线程数</label>
          <input
            id="threads"
            type="number"
            className="text-input settings-input"
            min={MIN_THREADS}
            max={MAX_THREADS}
            value={threads}
            onChange={(e) => setThreadsState(Number(e.target.value))}
          />
          <button className="btn primary" onClick={() => handleSave(threads)}>
            {saved ? "已保存" : "保存"}
          </button>
          <button className="btn" onClick={() => handleSave(DEFAULT_THREADS)}>
            恢复默认
          </button>
        </div>
        <div className="level-hint">
          同时抓取的章节数，范围 {MIN_THREADS}–{MAX_THREADS}，默认{" "}
          {DEFAULT_THREADS}。线程过多可能被站点限流。
        </div>
      </div>
    </div>
  );
}
