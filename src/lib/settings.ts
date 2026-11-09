/** 下载设置：并发线程数，持久化在 localStorage。 */

const THREADS_KEY = "epub-desktop.threads";

export const DEFAULT_THREADS = 5;
export const MIN_THREADS = 1;
export const MAX_THREADS = 16;

export function clampThreads(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_THREADS;
  return Math.min(MAX_THREADS, Math.max(MIN_THREADS, Math.floor(n)));
}

export function getThreads(): number {
  if (typeof window === "undefined") return DEFAULT_THREADS;
  const raw = window.localStorage.getItem(THREADS_KEY);
  if (raw === null) return DEFAULT_THREADS;
  const n = Number(raw);
  return Number.isFinite(n) ? clampThreads(n) : DEFAULT_THREADS;
}

/** 写入并返回规范化后的线程数。 */
export function setThreads(n: number): number {
  const value = clampThreads(n);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(THREADS_KEY, String(value));
  }
  return value;
}
