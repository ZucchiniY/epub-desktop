import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TXT 分章导出 EPUB",
  description: "将 TXT 文档分章节并导出为 EPUB",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
