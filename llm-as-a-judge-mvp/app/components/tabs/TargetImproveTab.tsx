"use client";

import { useEffect, useState } from "react";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { ImprovementMethodId } from "@/lib/contracts/generateEvaluate";
import { ProgressPanel, COMMON_PROGRESS_STEPS } from "@/app/components/ProgressPanel";
import { ExpandableTextCell } from "@/app/components/ExpandableTextCell";
import { PromptDiffView } from "@/app/components/PromptDiffView";
import type { TargetPromptImproveResponse } from "@/lib/contracts/generateEvaluate";

function isTargetImproveResponse(data: unknown): data is TargetPromptImproveResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as TargetPromptImproveResponse;
  return (
    typeof d.suggestion === "string" &&
    typeof d.analysisSummary === "string" &&
    (d.resultSource === "gepa" ||
      d.resultSource === "fallback" ||
      d.resultSource === "standard")
  );
}

type Props = {
  selectedDomain: DomainId;
  completedStepIndices: number[];
  onImprovementGenerated?: () => void;
};

type WeaveJudgeLogRecord = {
  id: string;
  domain: string;
  score: number;
  pass: boolean;
  passThreshold: number;
  rubricVersion: number;
  userInput?: string;
  generatedOutput?: string;
  reason?: string;
  createdAt: string;
};

function isTargetImproveCandidate(record: WeaveJudgeLogRecord): boolean {
  return !record.pass || record.score < record.passThreshold;
}

export function TargetImproveTab({ selectedDomain, completedStepIndices, onImprovementGenerated }: Props) {
  const [improvementMethod, setImprovementMethod] = useState<ImprovementMethodId>("meta");
  const [improvement, setImprovement] = useState<TargetPromptImproveResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingElapsedMs, setLoadingElapsedMs] = useState(0);
  const [publishLoading, setPublishLoading] = useState(false);
  const [error, setError] = useState("");
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [wandbConfigured, setWandbConfigured] = useState(false);
  const [weaveData, setWeaveData] = useState<WeaveJudgeLogRecord[] | null>(null);
  const [weaveDataLoading, setWeaveDataLoading] = useState(false);
  const improvementMethodDescription =
    improvementMethod === "meta"
      ? "LLMで改善プロンプトを作成します。"
      : improvementMethod === "fewshot"
        ? "実ログ例を使って改善プロンプトを調整します。"
        : "GEPAで品質・改善幅・合格到達・形式適合を最適化します。";

  const handleFetchWeaveData = async () => {
    setWeaveDataLoading(true);
    setError("");
    setWeaveData(null);
    try {
      const res = await fetch(`/api/weave/judge-logs?domain=${selectedDomain}&limit=20`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message ?? "Weave からの取得に失敗しました");
      }
      const data = await res.json();
      const records = (data.records ?? []) as WeaveJudgeLogRecord[];
      setWeaveData(records.filter(isTargetImproveCandidate));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Weave からの取得に失敗しました");
    } finally {
      setWeaveDataLoading(false);
    }
  };

  useEffect(() => {
    const loadWandbStatus = async () => {
      try {
        const res = await fetch("/api/wandb-status");
        if (!res.ok) return;
        const data = await res.json();
        setWandbConfigured(Boolean(data?.configured));
      } catch {
        // ignore
      }
    };
    void loadWandbStatus();
  }, []);

  useEffect(() => {
    if (!loading) {
      setLoadingElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => {
      setLoadingElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => clearInterval(id);
  }, [loading]);

  const handleGenerateImprovement = async () => {
    setLoading(true);
    setImprovement(null);
    setError("");
    setPublishMessage(null);
    try {
      const res = await fetch("/api/target-prompt/improve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: selectedDomain,
          failedLimit: 10,
          llmProvider: "ax",
          improvementMethod
        })
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const err = data as { error?: { message?: string } };
        throw new Error(err?.error?.message ?? "改善案の生成に失敗しました");
      }
      if (!isTargetImproveResponse(data)) {
        throw new Error("サーバー応答形式が不正です");
      }
      setImprovement(data);
      onImprovementGenerated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "改善案の生成に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  const handlePublishToWeave = async () => {
    if (!improvement?.suggestion) return;
    setPublishLoading(true);
    setError("");
    setPublishMessage(null);
    try {
      const res = await fetch("/api/prompts/publish-improved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: selectedDomain,
          type: "target",
          promptContent: improvement.suggestion
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "Weave への反映に失敗しました");
      }
      setPublishMessage(data.message ?? "Weave に反映しました");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Weave への反映に失敗しました");
    } finally {
      setPublishLoading(false);
    }
  };

  const getTargetImproveStatusMessage = (): string => {
    if (loading) {
      const elapsedSec = Math.floor(loadingElapsedMs / 1000);
      if (improvementMethod === "fewshot") return `Few-shot 最適化中...（${elapsedSec}秒）`;
      if (improvementMethod === "gepa") return `GEPA 最適化中...（${elapsedSec}秒）`;
      return `メタプロンプト生成中...（${elapsedSec}秒）`;
    }
    if (error) return error;
    if (publishMessage) return "Weave に反映しました。";
    if (improvement?.resultSource === "gepa") {
      return "GEPA 最適化結果を取得しました。Weave に反映するか、コピーしてご利用ください。";
    }
    if (improvement?.resultSource === "fallback") {
      return "GEPA が失敗したため、通常生成で改善案を返しました。";
    }
    if (improvement) return "改善案が生成されました。Weave に反映するか、コピーしてご利用ください。";
    if (weaveData === null) return "まず「Weave からデータを取得」を押してデータを取得してください。";
    if (weaveData.length === 0) return "取得したデータがありません。評価を実行してから再度取得してください。";
    return "データを取得しました。「改善案を生成」を押して生成プロンプトの改善案を生成します。";
  };

  return (
    <div className="promptImproveLayout">
      <section className="panel promptImprovePanel">
        <h2>生成プロンプト改善</h2>
      <p className="hintText">
        評価ログから不合格・低スコアのケースを取得し、生成プロンプトの改善案を LLM で生成します。
      </p>

      <div className="improveActions" style={{ marginTop: "16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="subtleButton"
          onClick={handleFetchWeaveData}
          disabled={weaveDataLoading}
        >
          {weaveDataLoading ? "取得中..." : "Weave からデータを取得"}
        </button>
        <button
          type="button"
          className="primaryButton"
          onClick={handleGenerateImprovement}
          disabled={loading || weaveData === null}
          title={weaveData === null ? "まず「Weave からデータを取得」を実行してください" : undefined}
        >
          {loading
            ? improvementMethod === "fewshot"
              ? "Few-shot 最適化中..."
              : improvementMethod === "gepa"
                ? "GEPA 最適化中..."
                : "生成中..."
            : "改善案を生成"}
        </button>
      </div>

      {weaveData !== null && (
        <div className="weaveDataPanel" style={{ marginTop: 16 }}>
          <h3>Weave から取得したデータ（{weaveData.length} 件）</h3>
          {weaveData.length === 0 ? (
            <p className="hintText">
              改善対象データがありません（全件合格・高スコア）。
              <a href="/api/weave/debug" target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>
                Weave 状態を確認
              </a>
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="weaveDataTable" style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--border)", textAlign: "left" }}>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>日時</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>ドメイン</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>スコア</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>判定</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>理由</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>生成出力</th>
                  </tr>
                </thead>
                <tbody>
                  {weaveData.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                        {new Date(r.createdAt).toLocaleString("ja-JP")}
                      </td>
                      <td style={{ padding: "8px 12px" }}>{r.domain}</td>
                      <td style={{ padding: "8px 12px" }}>{r.score}</td>
                      <td style={{ padding: "8px 12px" }}>{r.pass ? "合格" : "不合格"}</td>
                      <td style={{ padding: "8px 12px", maxWidth: 200 }}>
                        <ExpandableTextCell text={r.reason} maxWidth={200} />
                      </td>
                      <td style={{ padding: "8px 12px", maxWidth: 200 }}>
                        <ExpandableTextCell text={r.generatedOutput} maxWidth={200} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {error ? (
        <p className="errorBanner" role="alert" style={{ marginTop: "16px" }}>
          {error}
        </p>
      ) : null}

      {improvement && (
        <div className="improvementResult">
          {improvement.resultSource === "fallback" && (
            <p className="hintText" style={{ marginBottom: "8px" }}>
              GEPA 実行に失敗したためフォールバック結果を表示しています。
              {improvement.degradedReason ? ` (${improvement.degradedReason})` : ""}
            </p>
          )}
          <h3>分析サマリー</h3>
          <p>{improvement.analysisSummary}</p>
          {improvement.currentPrompt != null && improvement.currentPrompt !== "" ? (
            <>
              <h3>前後比較</h3>
              <PromptDiffView
                before={improvement.currentPrompt}
                after={improvement.suggestion}
                beforeLabel="現在の生成プロンプト"
                afterLabel="改善案"
              />
            </>
          ) : (
            <>
              <h3>改善案（生成プロンプトに貼り付け）</h3>
              <pre className="improvementSuggestion">{improvement.suggestion}</pre>
            </>
          )}
          <div className="inlineActions" style={{ marginTop: "12px" }}>
            {wandbConfigured && (
              <button
                type="button"
                className="primaryButton"
                onClick={handlePublishToWeave}
                disabled={publishLoading}
              >
                {publishLoading ? "反映中..." : "Weave に反映"}
              </button>
            )}
            <button
              type="button"
              className="subtleButton"
              onClick={async () => {
                if (!improvement?.suggestion) return;
                try {
                  await navigator.clipboard.writeText(improvement.suggestion);
                } catch {
                  // ignore
                }
              }}
            >
              改善案をコピー
            </button>
          </div>
          {publishMessage && (
            <p className="syncSuccessMessage" style={{ marginTop: "10px" }}>
              {publishMessage}
            </p>
          )}
        </div>
      )}

      <ProgressPanel
        steps={COMMON_PROGRESS_STEPS}
        completedStepIndices={completedStepIndices}
        statusMessage={getTargetImproveStatusMessage()}
        error={error || undefined}
      />
      </section>

      <aside className="promptImproveOptions" role="group" aria-label="改善方式オプション">
        <h3>改善方式</h3>
        <div className="axMethodRow">
          <span className="domainSelectorLabel">方式:</span>
          <div className="domainSelectorButtons">
            <button
              type="button"
              className={`domainButton ${improvementMethod === "meta" ? "active" : ""}`}
              onClick={() => setImprovementMethod("meta")}
              aria-pressed={improvementMethod === "meta"}
            >
              メタプロンプト
            </button>
            <button
              type="button"
              className={`domainButton ${improvementMethod === "fewshot" ? "active" : ""}`}
              onClick={() => setImprovementMethod("fewshot")}
              aria-pressed={improvementMethod === "fewshot"}
            >
              Few-shot
            </button>
            <button
              type="button"
              className={`domainButton ${improvementMethod === "gepa" ? "active" : ""}`}
              onClick={() => setImprovementMethod("gepa")}
              aria-pressed={improvementMethod === "gepa"}
            >
              多目的最適化
            </button>
          </div>
          <p className="hintText" style={{ marginTop: 8 }}>
            {improvementMethodDescription}
          </p>
        </div>
      </aside>
    </div>
  );
}
