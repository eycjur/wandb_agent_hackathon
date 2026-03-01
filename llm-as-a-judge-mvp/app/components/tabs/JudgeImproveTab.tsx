"use client";

import { useEffect, useState } from "react";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";
import { ProgressPanel, COMMON_PROGRESS_STEPS } from "@/app/components/ProgressPanel";
import { PromptDiffView } from "@/app/components/PromptDiffView";
import { ExpandableTextCell } from "@/app/components/ExpandableTextCell";

type ImprovementResult = {
  suggestion: string;
  analysisSummary: string;
  currentPrompt?: string;
};

type Props = {
  selectedDomain: DomainId;
  completedStepIndices: number[];
  onImprovementGenerated?: () => void;
};

type WeaveHumanFeedbackRecord = {
  id: string;
  domain: string;
  humanScore: number;
  judgeScore?: number;
  humanComment?: string;
  userInput?: string;
  generatedOutput?: string;
  judgeResult?: { score: number; reason: string; pass: boolean };
  createdAt: string;
};

export function JudgeImproveTab({ selectedDomain, completedStepIndices, onImprovementGenerated }: Props) {
  const [llmProvider, setLlmProvider] = useState<LLMProviderId>("ax");
  const [axMethod, setAxMethod] = useState<AxMethodId>("few-shot");
  const [improvement, setImprovement] = useState<ImprovementResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [error, setError] = useState("");
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [wandbConfigured, setWandbConfigured] = useState(false);
  const [weaveData, setWeaveData] = useState<WeaveHumanFeedbackRecord[] | null>(null);
  const [weaveDataLoading, setWeaveDataLoading] = useState(false);

  const handleFetchWeaveData = async () => {
    setWeaveDataLoading(true);
    setError("");
    setWeaveData(null);
    try {
      const res = await fetch(`/api/weave/human-feedback?domain=${selectedDomain}&limit=20`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error?.message ?? "Weave からの取得に失敗しました");
      }
      const data = await res.json();
      setWeaveData(data.records ?? []);
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

  const handleGenerate = async () => {
    setLoading(true);
    setImprovement(null);
    setError("");
    setPublishMessage(null);
    try {
      const res = await fetch("/api/judge-prompt/improve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: selectedDomain,
          feedbackLimit: 10,
          llmProvider,
          axMethod
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message ?? "改善案の生成に失敗しました");
      }
      setImprovement({
        suggestion: data.suggestion,
        analysisSummary: data.analysisSummary,
        currentPrompt: data.currentPrompt
      });
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
          type: "judge",
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

  const getJudgeImproveStatusMessage = (): string => {
    if (loading) return "改善案を生成中です...";
    if (error) return error;
    if (publishMessage) return "Weave に反映しました。";
    if (improvement) return "改善案が生成されました。Weave に反映するか、コピーしてご利用ください。";
    if (llmProvider === "gemini") {
      return "Gemini はデータを自動取得して改善案を生成します。「改善案を生成」を押してください。";
    }
    if (weaveData === null) return "まず「Weave からデータを取得」を押してデータを取得してください。";
    if (weaveData.length === 0) return "取得したデータがありません。手動評価を蓄積してから再度取得してください。";
    return "データを取得しました。「改善案を生成」を押して Judge プロンプトの改善案を生成します。";
  };

  return (
    <div className="promptImproveLayout">
      <section className="panel" aria-labelledby="judge-improve-title">
        <h2 id="judge-improve-title">Judge プロンプト改善</h2>
      <p className="hintText">
        Weave から手動評価ログを取得し、LLM で Judge プロンプトの改善案を生成します。
      </p>

      <div className="inputActions" style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
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
          onClick={handleGenerate}
          disabled={loading || (llmProvider !== "gemini" && weaveData === null)}
          title={llmProvider !== "gemini" && weaveData === null ? "まず「Weave からデータを取得」を実行してください" : undefined}
        >
          {loading ? "生成中..." : "改善案を生成"}
        </button>
      </div>

      {weaveData !== null && (
        <div className="weaveDataPanel" style={{ marginTop: 16 }}>
          <h3>Weave から取得したデータ（{weaveData.length} 件）</h3>
          {weaveData.length === 0 ? (
            <p className="hintText">
              データがありません。
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
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>人間</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>Judge</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>生成出力</th>
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>コメント</th>
                  </tr>
                </thead>
                <tbody>
                  {weaveData.map((r) => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                        {new Date(r.createdAt).toLocaleString("ja-JP")}
                      </td>
                      <td style={{ padding: "8px 12px" }}>{r.domain}</td>
                      <td style={{ padding: "8px 12px" }}>{r.humanScore}</td>
                      <td style={{ padding: "8px 12px" }}>
                        {r.judgeResult != null ? r.judgeResult.score : r.judgeScore ?? "—"}
                      </td>
                      <td style={{ padding: "8px 12px", maxWidth: 200 }}>
                        <ExpandableTextCell text={r.generatedOutput} maxWidth={200} />
                      </td>
                      <td style={{ padding: "8px 12px", maxWidth: 150 }}>
                        <ExpandableTextCell text={r.humanComment} maxWidth={150} />
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
        <p className="errorBanner" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      ) : null}

      {improvement && (
        <div className="improvementResult">
          <h3>分析サマリー</h3>
          <p>{improvement.analysisSummary}</p>
          {improvement.currentPrompt != null && improvement.currentPrompt !== "" ? (
            <>
              <h3>前後比較</h3>
              <PromptDiffView
                before={improvement.currentPrompt}
                after={improvement.suggestion}
                beforeLabel="現在の Judge プロンプト"
                afterLabel="改善案"
              />
              {wandbConfigured && (
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="primaryButton"
                    onClick={handlePublishToWeave}
                    disabled={publishLoading}
                  >
                    {publishLoading ? "反映中..." : "Weave に反映"}
                  </button>
                  {publishMessage && (
                    <p className="syncSuccessMessage" style={{ marginTop: 8 }}>
                      {publishMessage}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <h3>改善案</h3>
              <pre className="improvementSuggestion">{improvement.suggestion}</pre>
              {wandbConfigured && (
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="primaryButton"
                    onClick={handlePublishToWeave}
                    disabled={publishLoading}
                  >
                    {publishLoading ? "反映中..." : "Weave に反映"}
                  </button>
                  {publishMessage && (
                    <p className="syncSuccessMessage" style={{ marginTop: 8 }}>
                      {publishMessage}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <ProgressPanel
        steps={COMMON_PROGRESS_STEPS}
        completedStepIndices={completedStepIndices}
        statusMessage={getJudgeImproveStatusMessage()}
        error={error || undefined}
      />
      </section>

      <aside className="promptImproveOptions" role="group" aria-label="最適化手法オプション">
        <h3>最適化手法</h3>
        <div className="domainSelectorButtons">
          <button
            type="button"
            className={`domainButton ${llmProvider === "ax" ? "active" : ""}`}
            onClick={() => setLlmProvider("ax")}
            aria-pressed={llmProvider === "ax"}
          >
            ax
          </button>
          <button
            type="button"
            className={`domainButton ${llmProvider === "gemini" ? "active" : ""}`}
            onClick={() => setLlmProvider("gemini")}
            aria-pressed={llmProvider === "gemini"}
          >
            Gemini
          </button>
        </div>
        {llmProvider === "ax" && (
          <div className="axMethodRow">
            <span className="domainSelectorLabel">方法:</span>
            <div className="domainSelectorButtons">
              <button
                type="button"
                className={`domainButton ${axMethod === "signature" ? "active" : ""}`}
                onClick={() => setAxMethod("signature")}
                aria-pressed={axMethod === "signature"}
              >
                ゼロショット
              </button>
              <button
                type="button"
                className={`domainButton ${axMethod === "few-shot" ? "active" : ""}`}
                onClick={() => setAxMethod("few-shot")}
                aria-pressed={axMethod === "few-shot"}
              >
                Few-shot
              </button>
              <button
                type="button"
                className={`domainButton ${axMethod === "gepa" ? "active" : ""}`}
                onClick={() => setAxMethod("gepa")}
                aria-pressed={axMethod === "gepa"}
              >
                GEPA
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
