"use client";

import { useState } from "react";

const TRUNCATE_LEN = 80;

type Props = {
  text: string | undefined | null;
  maxWidth?: number;
  emptyLabel?: string;
};

export function ExpandableTextCell({ text, maxWidth = 200, emptyLabel = "—" }: Props) {
  const [showModal, setShowModal] = useState(false);
  const displayText = text?.trim() ?? "";
  const isLong = displayText.length > TRUNCATE_LEN;
  const truncated = isLong ? `${displayText.slice(0, TRUNCATE_LEN)}…` : displayText;

  if (!displayText) {
    return <span style={{ color: "var(--text-muted)" }}>{emptyLabel}</span>;
  }

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={() => isLong && setShowModal(true)}
        onKeyDown={(e) => isLong && (e.key === "Enter" || e.key === " ") && setShowModal(true)}
        style={{
          display: "block",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth,
          cursor: isLong ? "pointer" : "default",
          color: isLong ? "var(--link-color, #0066cc)" : undefined,
          textDecoration: isLong ? "underline" : undefined,
          textDecorationStyle: "dotted"
        }}
        title={isLong ? "クリックで全文表示" : undefined}
      >
        {truncated}
      </span>
      {showModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="全文表示"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.5)",
            padding: 24
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 24,
              maxWidth: "min(90vw, 600px)",
              maxHeight: "80vh",
              overflow: "auto",
              boxShadow: "0 4px 20px rgba(0,0,0,0.15)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: "0.9rem",
                lineHeight: 1.5
              }}
            >
              {displayText}
            </pre>
            <button
              type="button"
              className="subtleButton"
              style={{ marginTop: 16 }}
              onClick={() => setShowModal(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </>
  );
}
