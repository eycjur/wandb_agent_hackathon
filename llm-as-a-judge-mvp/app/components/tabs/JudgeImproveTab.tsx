"use client";

import { useEffect, useState } from "react";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { ImprovementMethodId } from "@/lib/contracts/generateEvaluate";
import { ProgressPanel, COMMON_PROGRESS_STEPS } from "@/app/components/ProgressPanel";
import { PromptDiffView } from "@/app/components/PromptDiffView";
import { ExpandableTextCell } from "@/app/components/ExpandableTextCell";
import {
  HelpTooltip,
  GEPA_PARAM_TOOLTIPS,
  FEWSHOT_PARAM_TOOLTIPS,
  LOG_LEVEL_TOOLTIP
} from "@/app/components/HelpTooltip";
import type { LogLevelId } from "@/lib/contracts/generateEvaluate";

type ImprovementResult = {
  suggestion: string;
  currentPrompt?: string;
  resultSource: "gepa" | "standard";
  degradedReason?: string;
  optimizationLog?: string[];
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
  const [improvementMethod, setImprovementMethod] = useState<ImprovementMethodId>("meta");
  const [improvement, setImprovement] = useState<ImprovementResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingElapsedMs, setLoadingElapsedMs] = useState(0);
  const [publishLoading, setPublishLoading] = useState(false);
  const [error, setError] = useState("");
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
  const [wandbConfigured, setWandbConfigured] = useState(false);
  const [weaveData, setWeaveData] = useState<WeaveHumanFeedbackRecord[] | null>(null);
  const [weaveDataLoading, setWeaveDataLoading] = useState(false);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [gepaMaxIterations, setGepaMaxIterations] = useState(2);
  const [gepaNumTrials, setGepaNumTrials] = useState(3);
  const [gepaEarlyStoppingTrials, setGepaEarlyStoppingTrials] = useState(1);
  const [gepaTimeoutSeconds, setGepaTimeoutSeconds] = useState(0);
  const [gepaMaxExamples, setGepaMaxExamples] = useState(6);
  const [fewShotMaxDemos, setFewShotMaxDemos] = useState(3);
  const [fewShotMaxRounds, setFewShotMaxRounds] = useState(2);
  const [fewShotDemoThreshold, setFewShotDemoThreshold] = useState(0.5);
  const [fewShotTimeoutSeconds, setFewShotTimeoutSeconds] = useState(0);
  const [logLevel, setLogLevel] = useState<LogLevelId | "">("");
  const improvementMethodDescription =
    improvementMethod === "meta"
      ? "LLMで改善プロンプトを作成します。"
      : improvementMethod === "fewshot"
        ? "実ログ例を使って改善プロンプトを調整します。"
        : "GEPAでスコア一致・合否一致・理由品質を最適化します。";

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
      const records = (data.records ?? []) as WeaveHumanFeedbackRecord[];
      setWeaveData(records);
      setSelectedRecordIds(records.map((r) => r.id));
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
          selectedRecordIds,
          llmProvider: "ax",
          improvementMethod,
          ...(improvementMethod === "gepa" && {
            gepaBudget: {
              maxIterations: gepaMaxIterations,
              numTrials: gepaNumTrials,
              earlyStoppingTrials: gepaEarlyStoppingTrials,
              maxExamples: gepaMaxExamples,
              ...(gepaTimeoutSeconds > 0 && {
                compileTimeoutMs: gepaTimeoutSeconds * 1000
              })
            }
          }),
          ...(improvementMethod === "fewshot" && {
            fewShotBudget: {
              maxDemos: fewShotMaxDemos,
              maxRounds: fewShotMaxRounds,
              demoThreshold: fewShotDemoThreshold,
              ...(fewShotTimeoutSeconds > 0 && {
                compileTimeoutMs: fewShotTimeoutSeconds * 1000
              })
            }
          }),
          ...(logLevel !== "" && { logLevel })
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (data as { error?: { message?: string } })?.error?.message ??
          `改善案の生成に失敗しました（${res.status}）`;
        throw new Error(msg);
      }
      setImprovement({
        suggestion: data.suggestion,
        currentPrompt: data.currentPrompt,
        resultSource: data.resultSource,
        degradedReason: data.degradedReason,
        optimizationLog: data.optimizationLog
      });
      onImprovementGenerated?.();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "改善案の生成に失敗しました";
      setError(msg);
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
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg =
          (data as { error?: { message?: string } })?.error?.message ??
          `Weave への反映に失敗しました（${res.status}）`;
        throw new Error(msg);
      }
      setPublishMessage((data as { message?: string })?.message ?? "Weave に反映しました");
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Weave への反映に失敗しました";
      setError(msg);
    } finally {
      setPublishLoading(false);
    }
  };

  const getJudgeImproveStatusMessage = (): string => {
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
    if (improvement) return "改善案が生成されました。Weave に反映するか、コピーしてご利用ください。";
    if (weaveData === null) return "まず「Weave からデータを取得」を押してデータを取得してください。";
    if (selectedRecordIds.length === 0) return "利用データを1件以上選択してください。";
    if (weaveData.length === 0) return "取得したデータがありません。手動評価を蓄積してから再度取得してください。";
    return `データを取得しました（選択 ${selectedRecordIds.length}/${weaveData.length} 件）。「改善案を生成」を押してください。`;
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
          disabled={loading || !wandbConfigured || weaveData === null || selectedRecordIds.length === 0}
          title={
            !wandbConfigured
              ? "まず W&B を設定してください"
              : weaveData === null
                ? "まず「Weave からデータを取得」を実行してください"
                : selectedRecordIds.length === 0
                  ? "利用データを1件以上選択してください"
                : undefined
          }
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
          {weaveData.length > 0 && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={selectedRecordIds.length === weaveData.length}
                onChange={(event) => {
                  if (event.target.checked) {
                    setSelectedRecordIds(weaveData.map((r) => r.id));
                  } else {
                    setSelectedRecordIds([]);
                  }
                }}
              />
              全件選択（{selectedRecordIds.length}/{weaveData.length}）
            </label>
          )}
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
                    <th style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>利用</th>
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
                      <td style={{ padding: "8px 12px" }}>
                        <input
                          type="checkbox"
                          checked={selectedRecordIds.includes(r.id)}
                          onChange={(event) => {
                            setSelectedRecordIds((prev) => {
                              if (event.target.checked) {
                                if (prev.includes(r.id)) return prev;
                                return [...prev, r.id];
                              }
                              return prev.filter((id) => id !== r.id);
                            });
                          }}
                        />
                      </td>
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
          {improvement.optimizationLog != null &&
            improvement.optimizationLog.length > 0 && (
              <details className="optimizationLogDetails" style={{ marginTop: 16 }}>
                <summary style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  改善ログ（{improvement.optimizationLog.length} 件）
                  <button
                    type="button"
                    className="subtleButton"
                    style={{ fontSize: "0.78rem", padding: "4px 8px" }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const text = improvement.optimizationLog!.join("\n");
                      void navigator.clipboard.writeText(text);
                    }}
                  >
                    コピー
                  </button>
                </summary>
                <pre className="optimizationLogContent">
                  {improvement.optimizationLog.join("\n")}
                </pre>
              </details>
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
        <div className="logLevelParams" style={{ marginTop: 16 }}>
          <h4 style={{ marginBottom: 8, fontSize: "0.9rem" }}>ログレベル</h4>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ minWidth: 140 }}>
              レベル:
              <HelpTooltip text={LOG_LEVEL_TOOLTIP} />
            </span>
            <select
              value={logLevel}
              onChange={(e) =>
                setLogLevel((e.target.value || "") as LogLevelId | "")
              }
              style={{ minWidth: 120 }}
            >
              <option value="">未指定</option>
              <option value="off">off</option>
              <option value="error">error</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
          </label>
        </div>
        {improvementMethod === "fewshot" && (
          <div className="fewShotParams" style={{ marginTop: 16 }}>
            <h4 style={{ marginBottom: 8, fontSize: "0.9rem" }}>Few-shot パラメータ</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  maxDemos:
                  <HelpTooltip text={FEWSHOT_PARAM_TOOLTIPS.maxDemos} />
                </span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={fewShotMaxDemos}
                  onChange={(e) =>
                    setFewShotMaxDemos(Math.min(8, Math.max(1, Number(e.target.value) || 3)))
                  }
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  maxRounds:
                  <HelpTooltip text={FEWSHOT_PARAM_TOOLTIPS.maxRounds} />
                </span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={fewShotMaxRounds}
                  onChange={(e) =>
                    setFewShotMaxRounds(Math.min(10, Math.max(1, Number(e.target.value) || 2)))
                  }
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  demoThreshold:
                  <HelpTooltip text={FEWSHOT_PARAM_TOOLTIPS.demoThreshold} />
                </span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.1}
                  value={fewShotDemoThreshold}
                  onChange={(e) =>
                    setFewShotDemoThreshold(
                      Math.min(1, Math.max(0, Number(e.target.value) || 0.5))
                    )
                  }
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  timeout:
                  <HelpTooltip text={FEWSHOT_PARAM_TOOLTIPS.compileTimeoutSeconds} />
                </span>
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={fewShotTimeoutSeconds}
                  onChange={(e) =>
                    setFewShotTimeoutSeconds(Math.max(0, Number(e.target.value) || 0))
                  }
                  style={{ width: 60 }}
                />
              </label>
            </div>
          </div>
        )}
        {improvementMethod === "gepa" && (
          <div className="gepaParams" style={{ marginTop: 16 }}>
            <h4 style={{ marginBottom: 8, fontSize: "0.9rem" }}>GEPA パラメータ</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  maxIterations:
                  <HelpTooltip text={GEPA_PARAM_TOOLTIPS.maxIterations} />
                </span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={gepaMaxIterations}
                  onChange={(e) => setGepaMaxIterations(Number(e.target.value) || 2)}
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  numTrials:
                  <HelpTooltip text={GEPA_PARAM_TOOLTIPS.numTrials} />
                </span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={gepaNumTrials}
                  onChange={(e) => setGepaNumTrials(Number(e.target.value) || 3)}
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  earlyStoppingTrials:
                  <HelpTooltip text={GEPA_PARAM_TOOLTIPS.earlyStoppingTrials} />
                </span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={gepaEarlyStoppingTrials}
                  onChange={(e) =>
                    setGepaEarlyStoppingTrials(Number(e.target.value) || 1)
                  }
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  maxExamples:
                  <HelpTooltip text={GEPA_PARAM_TOOLTIPS.maxExamples} />
                </span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={gepaMaxExamples}
                  onChange={(e) =>
                    setGepaMaxExamples(Math.min(50, Math.max(1, Number(e.target.value) || 6)))
                  }
                  style={{ width: 60 }}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ minWidth: 140 }}>
                  timeout:
                  <HelpTooltip text={GEPA_PARAM_TOOLTIPS.compileTimeoutSeconds} />
                </span>
                <input
                  type="number"
                  min={0}
                  max={600}
                  value={gepaTimeoutSeconds}
                  onChange={(e) =>
                    setGepaTimeoutSeconds(Math.max(0, Number(e.target.value) || 0))
                  }
                  style={{ width: 60 }}
                />
              </label>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
