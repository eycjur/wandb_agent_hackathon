"use client";

import { diffLines } from "diff";

/**
 * プロンプトの前後比較（差分を色付けして表示）
 * 左: 現在 → 削除=赤、変更なし=グレー
 * 右: 改善案 → 追加=緑、変更なし=グレー
 */
type Props = {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
};

export function PromptDiffView({ before, after, beforeLabel = "現在のプロンプト", afterLabel = "改善案" }: Props) {
  const diff = diffLines(before, after);

  type Row = { left: string; right: string; leftStyle: "removed" | "unchanged" | "empty"; rightStyle: "added" | "unchanged" | "empty" };
  const rows: Row[] = [];

  for (const part of diff) {
    const lines = (part.value || "").split("\n").filter((l, i, arr) => i < arr.length - 1 || l !== "");
    for (const line of lines) {
      if (part.removed) {
        rows.push({ left: line, right: "", leftStyle: "removed", rightStyle: "empty" });
      } else if (part.added) {
        rows.push({ left: "", right: line, leftStyle: "empty", rightStyle: "added" });
      } else {
        rows.push({ left: line, right: line, leftStyle: "unchanged", rightStyle: "unchanged" });
      }
    }
  }

  const cellStyle = (style: Row["leftStyle"] | Row["rightStyle"]) => {
    if (style === "removed")
      return { backgroundColor: "rgba(239, 68, 68, 0.15)", borderLeft: "3px solid rgb(239, 68, 68)" };
    if (style === "added")
      return { backgroundColor: "rgba(34, 197, 94, 0.15)", borderLeft: "3px solid rgb(34, 197, 94)" };
    if (style === "unchanged") return { color: "var(--text-muted)" };
    return {};
  };

  return (
    <div className="promptDiffView" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0, minWidth: 0, border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <div style={{ borderRight: "1px solid var(--border)" }}>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: "0.9rem", color: "var(--text-muted)" }}>
            {beforeLabel}
          </div>
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 320,
              overflow: "auto",
              fontFamily: "ui-monospace, monospace",
              lineHeight: 1.6
            }}
          >
            {rows.map((r, i) => (
              <span key={i} style={{ display: "block", padding: "0 4px", ...cellStyle(r.leftStyle) }}>
                {r.leftStyle === "removed" ? "- " : r.leftStyle === "unchanged" ? "  " : ""}
                {r.left || "\u00A0"}
              </span>
            ))}
          </pre>
        </div>
        <div>
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: "0.9rem", color: "var(--text-muted)" }}>
            {afterLabel}
          </div>
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 320,
              overflow: "auto",
              fontFamily: "ui-monospace, monospace",
              lineHeight: 1.6
            }}
          >
            {rows.map((r, i) => (
              <span key={i} style={{ display: "block", padding: "0 4px", ...cellStyle(r.rightStyle) }}>
                {r.rightStyle === "added" ? "+ " : r.rightStyle === "unchanged" ? "  " : ""}
                {r.right || "\u00A0"}
              </span>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
