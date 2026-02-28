import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLM-as-a-Judge MVP",
  description: "Generate with LLM, evaluate with Judge LLM"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router では layout.tsx でのフォント読み込みが正規の方法 */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=Noto+Sans+JP:wght@400;500;600;700;800;900&display=swap"
          rel="stylesheet"
        />
        <meta name="theme-color" content="#0b1120" />
      </head>
      <body>{children}</body>
    </html>
  );
}
