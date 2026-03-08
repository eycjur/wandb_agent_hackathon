"use client";

import { useEffect, useRef, useState } from "react";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type {
  EvaluationSourceTypeId,
  HumanFeedbackRecord,
  DomainConfigResponse,
  ErrorCode,
  GenerateEvaluateErrorResponse,
  JudgeSuccessResponse
} from "@/lib/contracts/generateEvaluate";
import type { EvaluationResult } from "@/lib/ui/evaluation";
import {
  deriveEvaluationSourceType,
  selectDomainSession,
  type DomainSessionState,
  type ProgressStage
} from "@/lib/ui/domainSession";
import { ProgressPanel, COMMON_PROGRESS_STEPS } from "@/app/components/ProgressPanel";

const SCORE_GUIDE_BY_DOMAIN: Record<DomainId, readonly string[]> = {
  resume_summary: [
    "5: 採用判断に十分使える高品質な要約",
    "4: 実務利用可能だが軽微な改善余地あり",
    "3: 要点はあるが情報不足または曖昧さが残る",
    "2: 採用判断に必要な情報が不足",
    "1: 重要情報の欠落が大きい",
    "0: 要約として成立していない"
  ],
  resume_detail: [
    "5: 構造化・数値化が十分で採用判断に使える",
    "4: 実務利用可能だが軽微な改善余地あり",
    "3: 一部曖昧な表現や数値不足が残る",
    "2: 実績の数値化が十分でない",
    "1: 構造・形式が不十分",
    "0: 職務経歴として成立していない"
  ],
  self_pr: [
    "5: 採用担当に十分アピールできる高品質な自己PR",
    "4: 実務利用可能だが軽微な改善余地あり",
    "3: 根拠や具体性にやや不足",
    "2: 曖昧な表現が多く説得力が弱い",
    "1: 専門性が伝わりにくい",
    "0: 自己PRとして成立していない"
  ]
};

const DOMAIN_LABELS: Record<DomainId, string> = {
  resume_summary: "職務要約",
  resume_detail: "職務経歴（詳細）",
  self_pr: "自己PR"
};

const DOMAIN_JUDGE_LABELS: Record<DomainId, string> = {
  resume_summary: "要約を評価",
  resume_detail: "職務経歴を評価",
  self_pr: "自己PRを評価"
};

const DOMAIN_DRAFT_OUTPUT_LABELS: Record<DomainId, string> = {
  resume_summary: "評価対象の職務要約",
  resume_detail: "評価対象の職務経歴（詳細）",
  self_pr: "評価対象の自己PR"
};

const VALID_DOMAINS = ["resume_summary", "resume_detail", "self_pr"] as const;

const SOURCE_TYPE_LABELS: Record<EvaluationSourceTypeId, string> = {
  generated: "生成結果",
  generated_edited: "生成結果を編集",
  manual: "手入力 / 貼り付け"
};

type Props = {
  selectedDomain: DomainId;
  domainSessions: Record<DomainId, DomainSessionState<EvaluationResult>>;
  onPatchDomainSession: (domain: DomainId, patch: Partial<DomainSessionState<EvaluationResult>>) => void;
  onLoadingChange?: (loading: boolean) => void;
  completedStepIndices: number[];
};

export function EvaluateTabContent({
  selectedDomain,
  domainSessions,
  onPatchDomainSession,
  onLoadingChange,
  completedStepIndices
}: Props) {
  const [requestError, setRequestError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressStage, setProgressStage] = useState<ProgressStage>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [domainConfig, setDomainConfig] = useState<DomainConfigResponse | null>(null);
  const [humanScore, setHumanScore] = useState<number | null>(null);
  const [humanComment, setHumanComment] = useState("");
  const [feedbackSubmitStatus, setFeedbackSubmitStatus] = useState<
    "idle" | "submitting" | "success" | "error"
  >("idle");
  const [humanFeedbackList, setHumanFeedbackList] = useState<HumanFeedbackRecord[]>([]);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const inFlightRef = useRef(false);

  const session = selectDomainSession(domainSessions, selectedDomain);
  const generatedOutput = session.generatedOutput;
  const generatedForInput = session.generatedForInput;
  const evaluationDraftUserInput = session.evaluationDraftUserInput;
  const evaluationDraftOutput = session.evaluationDraftOutput;
  const currentResult = session.currentResult;
  const previousResult = session.previousResult;
  const derivedSourceType = deriveEvaluationSourceType(session);
  const normalizedDraftUserInput = normalizeEvaluationText(evaluationDraftUserInput);
  const normalizedDraftOutput = normalizeEvaluationText(evaluationDraftOutput);
  const hasDraftToJudge =
    normalizedDraftUserInput.length > 0 && normalizedDraftOutput.length > 0;
  const hasGeneratedResult =
    generatedOutput.trim().length > 0 && generatedForInput.trim().length > 0;
  const isCurrentResultStale = currentResult
    ? normalizeEvaluationText(currentResult.userInput) !== normalizedDraftUserInput ||
      normalizeEvaluationText(currentResult.generatedOutput) !== normalizedDraftOutput
    : false;
  const canSubmitHumanFeedback =
    humanScore !== null &&
    !loading &&
    feedbackSubmitStatus !== "submitting" &&
    hasDraftToJudge &&
    !isCurrentResultStale;

  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  useEffect(() => {
    setProgressStage(session.progressStage);
    setRequestError(session.requestError);
  }, [session.progressStage, session.requestError]);

  useEffect(() => {
    if (!loading) return;
    const startAt = Date.now();
    const intervalId = setInterval(() => setElapsedMs(Date.now() - startAt), 1000);
    return () => clearInterval(intervalId);
  }, [loading]);

  useEffect(() => {
    if (progressStage === "done") resultHeadingRef.current?.focus();
  }, [progressStage]);

  useEffect(() => {
    const loadDomainConfig = async () => {
      try {
        const response = await fetch(
          `/api/domain-config?domain=${encodeURIComponent(selectedDomain)}`,
          { cache: "no-store" }
        );
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (isDomainConfigResponse(data)) setDomainConfig(data);
      } catch {
        // ignore
      }
    };
    void loadDomainConfig();
  }, [selectedDomain]);

  useEffect(() => {
    if (currentResult) {
      setHumanScore(null);
      setHumanComment("");
      setFeedbackSubmitStatus("idle");
    }
  }, [currentResult]);

  useEffect(() => {
    setFeedbackSubmitStatus((prev) =>
      prev === "submitting" || prev === "idle" ? prev : "idle"
    );
  }, [evaluationDraftUserInput, evaluationDraftOutput, selectedDomain]);

  useEffect(() => {
    const loadFeedbackList = async () => {
      try {
        const res = await fetch(
          `/api/human-feedback?domain=${selectedDomain}&limit=10`
        );
        if (!res.ok) return;
        const data: { records?: HumanFeedbackRecord[] } = await res.json();
        if (data?.records && Array.isArray(data.records)) {
          setHumanFeedbackList(data.records);
        }
      } catch {
        // ignore
      }
    };
    void loadFeedbackList();
  }, [selectedDomain, feedbackSubmitStatus]);

  const runJudgeOnly = async () => {
    if (inFlightRef.current) return;

    if (!hasDraftToJudge) {
      const message = "評価対象の文章を入力するか、生成結果を読み込んでください。";
      setRequestError(message);
      setProgressStage("idle");
      onPatchDomainSession(selectedDomain, {
        progressStage: "idle",
        requestError: message
      });
      return;
    }

    const domainToJudge = selectedDomain;
    const sourceType = derivedSourceType;
    setRequestError("");
    setLoading(true);
    setElapsedMs(0);
    setProgressStage("judging");
    onPatchDomainSession(domainToJudge, {
      progressStage: "judging",
      requestError: ""
    });
    inFlightRef.current = true;

    try {
      const judgeResponse = await fetch("/api/judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userInput: normalizedDraftUserInput,
          generatedOutput: normalizedDraftOutput,
          domain: domainToJudge,
          sourceType
        })
      });

      let judgeData: unknown;
      try {
        judgeData = await judgeResponse.json();
      } catch {
        throw new Error("サーバー応答の解析に失敗しました。");
      }

      if (!judgeResponse.ok) {
        if (isErrorResponse(judgeData)) {
          throw new Error(formatError(judgeData));
        }
        throw new Error("処理に失敗しました。");
      }

      if (!isJudgeSuccessResponse(judgeData)) {
        throw new Error("サーバー応答形式が不正です。");
      }

      const nextResult: EvaluationResult = {
        domain: judgeData.domain,
        rubricVersion: judgeData.rubricVersion,
        passThreshold: judgeData.passThreshold,
        pass: judgeData.pass,
        userInput: normalizedDraftUserInput,
        generatedOutput: normalizedDraftOutput,
        sourceType,
        score: judgeData.score,
        reason: judgeData.reason,
        createdAt: new Date().toISOString()
      };

      const previousForDomain =
        domainSessions[domainToJudge].currentResult ??
        domainSessions[domainToJudge].previousResult;
      setProgressStage("done");
      onPatchDomainSession(domainToJudge, {
        previousResult: previousForDomain,
        currentResult: nextResult,
        progressStage: "done",
        requestError: ""
      });
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "不明なエラーが発生しました。";
      setRequestError(message);
      setProgressStage("failed_judging");
      onPatchDomainSession(domainToJudge, {
        progressStage: "failed_judging",
        requestError: message
      });
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleJudge = async () => {
    await runJudgeOnly();
  };

  const handleLoadGeneratedDraft = () => {
    if (!hasGeneratedResult) return;
    setRequestError("");
    setHumanScore(null);
    setHumanComment("");
    setFeedbackSubmitStatus("idle");
    onPatchDomainSession(selectedDomain, {
      evaluationDraftUserInput: generatedForInput,
      evaluationDraftOutput: generatedOutput,
      evaluationDraftSeedUserInput: generatedForInput,
      evaluationDraftSeedOutput: generatedOutput,
      hasPendingGeneratedDraft: false,
      requestError: ""
    });
  };

  const handleClearEvaluationDraft = () => {
    setRequestError("");
    setHumanScore(null);
    setHumanComment("");
    setFeedbackSubmitStatus("idle");
    onPatchDomainSession(selectedDomain, {
      evaluationDraftUserInput: "",
      evaluationDraftOutput: "",
      evaluationDraftSeedUserInput: "",
      evaluationDraftSeedOutput: "",
      requestError: ""
    });
  };

  const handleSubmitHumanFeedback = async () => {
    if (!canSubmitHumanFeedback || humanScore === null) return;

    const feedbackUserInput = isCurrentResultStale
      ? normalizedDraftUserInput
      : currentResult?.userInput ?? normalizedDraftUserInput;
    const feedbackOutput = isCurrentResultStale
      ? normalizedDraftOutput
      : currentResult?.generatedOutput ?? normalizedDraftOutput;
    const feedbackSourceType = isCurrentResultStale
      ? derivedSourceType
      : currentResult?.sourceType ?? derivedSourceType;

    setFeedbackSubmitStatus("submitting");
    try {
      const res = await fetch("/api/human-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain: selectedDomain,
          userInput: feedbackUserInput,
          generatedOutput: feedbackOutput,
          sourceType: feedbackSourceType,
          judgeResult: currentResult && !isCurrentResultStale
            ? {
                score: currentResult.score,
                reason: currentResult.reason,
                pass: currentResult.pass
              }
            : undefined,
          humanScore,
          humanComment: humanComment.trim() || undefined
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "送信に失敗しました");
      }
      setFeedbackSubmitStatus("success");
      setHumanScore(null);
      setHumanComment("");
    } catch (e) {
      setFeedbackSubmitStatus("error");
      setRequestError(
        e instanceof Error ? e.message : "評価の送信に失敗しました"
      );
    }
  };

  const canJudge = !loading && hasDraftToJudge;
  const scoreDelta =
    currentResult && previousResult
      ? currentResult.score - previousResult.score
      : null;
  const idleMessage = session.hasPendingGeneratedDraft
    ? "新しい生成結果があります。「直近の生成結果を読み込む」で評価対象へ反映できます。"
    : "評価対象の文章を入力するか、生成結果を読み込んでください。";

  const progressPanel = (
    <ProgressPanel
      steps={COMMON_PROGRESS_STEPS}
      completedStepIndices={completedStepIndices}
      statusMessage={buildStatusMessage(
        progressStage,
        loading,
        Math.floor(elapsedMs / 1000),
        DOMAIN_LABELS[selectedDomain],
        DOMAIN_JUDGE_LABELS[selectedDomain],
        idleMessage
      )}
      error={requestError || undefined}
    />
  );

  const outputDomain = selectedDomain;
  const draftPanel = (
    <article
      className="panel resultCard outputCard"
      aria-busy={loading && progressStage === "judging"}
    >
      <div className="cardHeader">
        <h2 ref={resultHeadingRef} tabIndex={-1}>
          評価対象
        </h2>
      </div>
      <div className="humanFeedbackForm">
        <div className="scoreInputRow">
          <span className="scoreInputLabel">現在の入力元:</span>
          <span className={`passBadge ${derivedSourceType === "manual" ? "neutral" : "pass"}`}>
            {SOURCE_TYPE_LABELS[derivedSourceType]}
          </span>
        </div>
        <div className="inlineActions">
          <button
            type="button"
            className="subtleButton"
            onClick={handleLoadGeneratedDraft}
            disabled={!hasGeneratedResult}
          >
            直近の生成結果を読み込む
          </button>
          <button
            type="button"
            className="subtleButton"
            onClick={handleClearEvaluationDraft}
            disabled={!hasDraftToJudge}
          >
            入力をクリア
          </button>
        </div>
        <p className="hintText">
          生成結果を読み込んで編集するか、外部で作成した文章を貼り付けて評価できます。
        </p>
        {session.hasPendingGeneratedDraft ? (
          <p className="evaluateHint">
            新しい生成結果があります。必要なら「直近の生成結果を読み込む」で反映してください。
          </p>
        ) : null}
        <div className="commentRow">
          <label htmlFor="evaluation-draft-user-input">元の職務経歴入力</label>
          <textarea
            id="evaluation-draft-user-input"
            value={evaluationDraftUserInput}
            onChange={(event) =>
              onPatchDomainSession(selectedDomain, {
                evaluationDraftUserInput: event.target.value,
                requestError: ""
              })
            }
            placeholder="候補者の職務経歴テキストを入力してください"
            rows={7}
            className="commentTextarea"
          />
        </div>
        <div className="commentRow">
          <label htmlFor="evaluation-draft-output">
            {DOMAIN_DRAFT_OUTPUT_LABELS[outputDomain]}
          </label>
          <textarea
            id="evaluation-draft-output"
            value={evaluationDraftOutput}
            onChange={(event) =>
              onPatchDomainSession(selectedDomain, {
                evaluationDraftOutput: event.target.value,
                requestError: ""
              })
            }
            placeholder={`評価したい${DOMAIN_LABELS[outputDomain]}を入力してください`}
            rows={10}
            className="commentTextarea"
          />
        </div>
      </div>
      {hasGeneratedResult ? (
        <details className="previousResult">
          <summary>直近の生成結果を表示</summary>
          <p className="hintText">元の職務経歴入力</p>
          <pre>{generatedForInput}</pre>
          <p className="hintText">{DOMAIN_DRAFT_OUTPUT_LABELS[outputDomain]}</p>
          <pre>{generatedOutput}</pre>
        </details>
      ) : null}
      {previousResult ? (
        <details className="previousResult">
          <summary>前回評価した文章を表示</summary>
          <p className="hintText">入力元: {SOURCE_TYPE_LABELS[previousResult.sourceType]}</p>
          <pre>{previousResult.generatedOutput}</pre>
        </details>
      ) : null}
    </article>
  );

  const evaluationPanel = (
    <article className="panel resultCard scoreCard">
      <h2>評価結果（自動評価）</h2>
      {loading && progressStage === "judging" ? (
        <ScoreSkeleton />
      ) : (
        <>
          <div className="scoreBlock">
            <p className="scoreLabel">Score</p>
            <p className="scoreValue">{currentResult ? currentResult.score : "-"}</p>
            {scoreDelta !== null ? (
              <p className={`scoreDelta ${scoreDelta >= 0 ? "up" : "down"}`}>
                前回比: {scoreDelta >= 0 ? "+" : ""}
                {scoreDelta}
              </p>
            ) : null}
            {currentResult ? (
              <p className={`passBadge ${currentResult.pass ? "pass" : "fail"}`}>
                判定:{" "}
                {currentResult.pass ? "合格（実務投入可能）" : "要改善"}
              </p>
            ) : (
              <p className="passBadge neutral">判定: 未評価</p>
            )}
            <p className="thresholdText">
              合格ライン: score {">="}{" "}
              {currentResult
                ? currentResult.passThreshold
                : domainConfig?.passThreshold ?? 4}
            </p>
            <p className="thresholdText">
              Domain: {currentResult?.domain ?? outputDomain} / Rubric v
              {currentResult?.rubricVersion ??
                domainConfig?.rubricVersion ??
                1}
            </p>
            <p className="thresholdText">
              入力元:{" "}
              {currentResult
                ? SOURCE_TYPE_LABELS[currentResult.sourceType]
                : SOURCE_TYPE_LABELS[derivedSourceType]}
            </p>
          </div>
          <div>
            <p className="scoreLabel">Reason</p>
            <p>{currentResult?.reason || "未評価"}</p>
          </div>
          {isCurrentResultStale ? (
            <p className="evaluateHint">
              編集中の内容はまだ評価していません。再度「{DOMAIN_JUDGE_LABELS[selectedDomain]}
              」を実行してください。
            </p>
          ) : null}
        </>
      )}
      <div className="scoreGuide" aria-label="score rubric guide">
        <p className="scoreGuideTitle">
          {DOMAIN_LABELS[outputDomain]} Score Guide
        </p>
        <ul>
          {SCORE_GUIDE_BY_DOMAIN[outputDomain].map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </article>
  );

  return (
    <section className="evaluationView" aria-busy={loading}>
      <div className="evaluateAction">
        <button
          className="subtleButton"
          type="button"
          onClick={handleLoadGeneratedDraft}
          disabled={!hasGeneratedResult}
        >
          直近の生成結果を読み込む
        </button>
        <button
          className="primaryButton"
          type="button"
          onClick={handleJudge}
          disabled={!canJudge}
        >
          {loading && progressStage === "judging"
            ? "Judging..."
            : DOMAIN_JUDGE_LABELS[selectedDomain]}
        </button>
        {!hasDraftToJudge && (
          <p className="evaluateHint">
            評価対象の文章を入力するか、生成結果を読み込んでください。
          </p>
        )}
      </div>

      <div className="evaluationSplit">
        {draftPanel}
        {evaluationPanel}
      </div>

      {hasDraftToJudge && (
        <section
          className="panel humanFeedbackPanel"
          aria-labelledby="human-feedback-title"
        >
          <h2 id="human-feedback-title">手動評価（人間フィードバック）</h2>
          <p className="hintText">
            評価対象の文章に対するあなたの評価です。Judge の結果に対する評価ではありません。自動評価の前でも送信できます。送信すると Judge プロンプトの改善に活用され、Weave に保存されます。
          </p>
          <div className="humanFeedbackForm">
            <div className="scoreInputRow">
              <span className="scoreInputLabel">評価対象の文章への人間スコア:</span>
              <div className="scoreButtons" role="group" aria-label="人間評価スコア">
                {[0, 1, 2, 3, 4, 5].map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`scoreButton ${humanScore === s ? "active" : ""}`}
                    onClick={() => setHumanScore(s)}
                    aria-pressed={humanScore === s}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <div className="commentRow">
              <label htmlFor="human-comment">コメント（任意）</label>
              <textarea
                id="human-comment"
                value={humanComment}
                onChange={(e) => setHumanComment(e.target.value)}
                placeholder="評価対象の文章に対するコメントがあれば入力"
                rows={2}
                className="commentTextarea"
              />
            </div>
            {isCurrentResultStale ? (
              <p className="evaluateHint">
                Judge 実行後に内容が編集されています。人間評価を送る前に、現在の内容で再評価してください。
              </p>
            ) : null}
            <button
              type="button"
              className="primaryButton"
              onClick={handleSubmitHumanFeedback}
              disabled={!canSubmitHumanFeedback}
            >
              {feedbackSubmitStatus === "submitting"
                ? "送信中..."
                : feedbackSubmitStatus === "success"
                  ? "送信しました"
                  : "評価を送信"}
            </button>
          </div>
        </section>
      )}

      {humanFeedbackList.length > 0 && (
        <details className="panel humanFeedbackList">
          <summary>最近の人間評価一覧</summary>
          <ul className="feedbackList">
            {humanFeedbackList.map((r) => (
              <li key={r.id} className="feedbackItem">
                <span className="feedbackMeta">
                  {r.domain} | 人間: {r.humanScore}
                  {r.judgeResult != null ? ` / Judge: ${r.judgeResult.score}` : ""}
                  {` / 入力元: ${SOURCE_TYPE_LABELS[r.sourceType]}`}
                </span>
                {r.humanComment && (
                  <span className="feedbackComment">{r.humanComment}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {progressPanel}
    </section>
  );
}

function isJudgeSuccessResponse(data: unknown): data is JudgeSuccessResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as JudgeSuccessResponse;
  return (
    "domain" in data &&
    "rubricVersion" in data &&
    "passThreshold" in data &&
    "pass" in data &&
    "score" in data &&
    "reason" in data &&
    VALID_DOMAINS.includes(d.domain) &&
    typeof d.rubricVersion === "number" &&
    Number.isInteger(d.rubricVersion) &&
    d.rubricVersion > 0 &&
    typeof d.passThreshold === "number" &&
    Number.isInteger(d.passThreshold) &&
    d.passThreshold >= 0 &&
    d.passThreshold <= 5 &&
    typeof d.pass === "boolean" &&
    typeof d.score === "number" &&
    Number.isInteger(d.score) &&
    d.score >= 0 &&
    d.score <= 5 &&
    d.pass === (d.score >= d.passThreshold) &&
    typeof d.reason === "string" &&
    d.reason.length > 0
  );
}

function isDomainConfigResponse(data: unknown): data is DomainConfigResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as DomainConfigResponse;
  if (
    !("domain" in data) ||
    !VALID_DOMAINS.includes(d.domain) ||
    !("rubricVersion" in data) ||
    typeof d.rubricVersion !== "number" ||
    !Number.isInteger(d.rubricVersion) ||
    d.rubricVersion <= 0 ||
    !("passThreshold" in data) ||
    typeof d.passThreshold !== "number" ||
    !Number.isInteger(d.passThreshold) ||
    d.passThreshold < 0 ||
    d.passThreshold > 5 ||
    !("samples" in data) ||
    !Array.isArray(d.samples)
  )
    return false;
  return d.samples.every(
    (sample) =>
      typeof sample === "object" &&
      sample !== null &&
      "title" in sample &&
      "input" in sample &&
      typeof sample.title === "string" &&
      sample.title.length > 0 &&
      typeof sample.input === "string" &&
      sample.input.length > 0
  );
}

function isErrorResponse(
  data: unknown
): data is GenerateEvaluateErrorResponse {
  if (typeof data !== "object" || data === null || !("error" in data))
    return false;
  const payload = (data as GenerateEvaluateErrorResponse).error;
  if (typeof payload !== "object" || payload === null) return false;
  return (
    "code" in payload &&
    "message" in payload &&
    typeof payload.code === "string" &&
    typeof payload.message === "string"
  );
}

function formatError(errorResponse: GenerateEvaluateErrorResponse): string {
  const { code, message } = errorResponse.error;
  const guidanceMap: Partial<Record<ErrorCode, string>> = {
    PROVIDER_TIMEOUT: "時間をおいて再試行してください。",
    CONFIG_ERROR: "運用担当者に設定確認を依頼してください。",
    PROVIDER_RESPONSE_INVALID:
      "プロンプトや入力を見直して再実行してください。"
  };
  const guidance = guidanceMap[code as ErrorCode];
  return guidance ? `${message} ${guidance}` : message;
}

function normalizeEvaluationText(value: string): string {
  return value.trim();
}

function buildStatusMessage(
  stage: ProgressStage,
  loading: boolean,
  elapsedSeconds: number,
  domainLabel: string,
  judgeLabel: string,
  idleMessage: string
): string {
  if (loading && stage === "generating")
    return `${domainLabel}を生成中です（${elapsedSeconds}秒経過）`;
  if (loading && stage === "judging")
    return `${domainLabel}を評価中です（${elapsedSeconds}秒経過）`;
  if (stage === "generated")
    return `${domainLabel}が完了しました。「${judgeLabel}」を押して評価を実行してください。`;
  if (stage === "done")
    return `${domainLabel}と評価が完了しました。結果を確認してください。`;
  if (stage === "failed_generating")
    return `${domainLabel}の生成に失敗しました。エラー内容を確認してください。`;
  if (stage === "failed_judging")
    return `${domainLabel}の評価に失敗しました。エラー内容を確認してください。`;
  if (stage === "input_accepted") return "職務経歴入力を受け付けました。";
  return idleMessage;
}

function ScoreSkeleton() {
  return (
    <div className="skeletonWrap" aria-hidden="true">
      <div className="skeletonCircle" />
      <div className="skeletonLine w80" />
      <div className="skeletonLine w65" />
    </div>
  );
}
