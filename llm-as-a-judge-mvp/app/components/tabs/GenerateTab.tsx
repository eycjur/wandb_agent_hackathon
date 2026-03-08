"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { MAX_USER_INPUT_CHARS } from "@/lib/config/app";
import { JUDGE_MODEL, TARGET_MODEL } from "@/lib/config/llm";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { EvaluationResult } from "@/lib/ui/evaluation";
import {
  shouldSyncEvaluationDraftWithGenerated,
  selectDomainSession,
  type DomainSessionState,
  type ProgressStage
} from "@/lib/ui/domainSession";
import { ProgressPanel, COMMON_PROGRESS_STEPS } from "@/app/components/ProgressPanel";
import type {
  DomainConfigResponse,
  ErrorCode,
  GenerateEvaluateErrorResponse,
  GenerateSuccessResponse
} from "@/lib/contracts/generateEvaluate";

const DOMAIN_LABELS: Record<DomainId, string> = {
  resume_summary: "職務要約",
  resume_detail: "職務経歴（詳細）",
  self_pr: "自己PR"
};

const DOMAIN_GENERATE_LABELS: Record<DomainId, string> = {
  resume_summary: "要約を生成",
  resume_detail: "職務経歴を生成",
  self_pr: "自己PRを生成"
};

const DOMAIN_OUTPUT_LABELS: Record<DomainId, string> = {
  resume_summary: "生成された職務経歴要約",
  resume_detail: "生成された職務経歴（詳細）",
  self_pr: "生成された自己PR"
};

const VALID_DOMAINS = ["resume_summary", "resume_detail", "self_pr"] as const;

function isDomainConfigResponse(data: unknown): data is DomainConfigResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as DomainConfigResponse;
  return (
    "domain" in data && VALID_DOMAINS.includes(d.domain) &&
    "rubricVersion" in data && typeof d.rubricVersion === "number" &&
    "passThreshold" in data && typeof d.passThreshold === "number" &&
    "samples" in data && Array.isArray(d.samples)
  );
}

function isGenerateSuccessResponse(data: unknown): data is GenerateSuccessResponse {
  if (typeof data !== "object" || data === null) return false;
  return "generatedOutput" in data && typeof (data as GenerateSuccessResponse).generatedOutput === "string";
}

function isErrorResponse(data: unknown): data is GenerateEvaluateErrorResponse {
  if (typeof data !== "object" || data === null || !("error" in data)) return false;
  const payload = (data as GenerateEvaluateErrorResponse).error;
  return typeof payload === "object" && payload !== null && "code" in payload && "message" in payload;
}

function formatError(errorResponse: GenerateEvaluateErrorResponse): string {
  const { code, message } = errorResponse.error;
  const guidanceMap: Partial<Record<ErrorCode, string>> = {
    PROVIDER_TIMEOUT: "時間をおいて再試行してください。",
    CONFIG_ERROR: "運用担当者に設定確認を依頼してください。",
    PROVIDER_RESPONSE_INVALID: "プロンプトや入力を見直して再実行してください。"
  };
  return guidanceMap[code as ErrorCode] ? `${message} ${guidanceMap[code as ErrorCode]}` : message;
}

function validateUserInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return "職務経歴入力は必須です。";
  if (trimmed.length > MAX_USER_INPUT_CHARS) return `職務経歴入力は${MAX_USER_INPUT_CHARS}文字以内で入力してください。`;
  return null;
}

type Props = {
  selectedDomain: DomainId;
  domainSessions: Record<DomainId, DomainSessionState<EvaluationResult>>;
  onPatchDomainSession: (domain: DomainId, patch: Partial<DomainSessionState<EvaluationResult>>) => void;
  onSwitchToEvaluate?: () => void;
  completedStepIndices: number[];
};

export function GenerateTab({ selectedDomain, domainSessions, onPatchDomainSession, onSwitchToEvaluate, completedStepIndices }: Props) {
  const [domainConfig, setDomainConfig] = useState<DomainConfigResponse | null>(null);
  const [userInput, setUserInput] = useState("");
  const [inputError, setInputError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [copyLabel, setCopyLabel] = useState("Copy output");
  const [downloadLabel, setDownloadLabel] = useState("Download .txt");
  const [progressStage, setProgressStage] = useState<ProgressStage>("idle");
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const inFlightRef = useRef(false);

  const session = selectDomainSession(domainSessions, selectedDomain);
  const generatedOutput = session.generatedOutput;
  const generatedForInput = session.generatedForInput;
  const generatedForDomain = selectedDomain;
  const lastGeneratedInput = session.lastGeneratedInput;
  const currentResult = session.currentResult;
  const previousResult = session.previousResult;

  useEffect(() => {
    setProgressStage(session.progressStage);
    setRequestError(session.requestError);
  }, [session.progressStage, session.requestError]);

  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    const intervalId = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 200);
    return () => clearInterval(intervalId);
  }, [loading]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/domain-config?domain=${encodeURIComponent(selectedDomain)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (isDomainConfigResponse(data)) setDomainConfig(data);
      } catch { /* ignore */ }
    };
    void load();
  }, [selectedDomain]);

  const runGenerateOnly = async (rawInput: string, domainOverride?: DomainId) => {
    if (inFlightRef.current) return;
    const validationError = validateUserInput(rawInput);
    if (validationError) {
      setInputError(validationError);
      return;
    }
    const domainToUse = domainOverride ?? selectedDomain;
    const normalizedInput = rawInput.trim();
    setInputError("");
    setRequestError("");
    setLoading(true);
    setElapsedMs(0);
    setProgressStage("input_accepted");
    onPatchDomainSession(domainToUse, { progressStage: "input_accepted", requestError: "" });
    inFlightRef.current = true;

    try {
      setProgressStage("generating");
      onPatchDomainSession(domainToUse, { progressStage: "generating", requestError: "" });
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userInput: normalizedInput,
          domain: domainToUse
        })
      });
      const generateData: unknown = await res.json();
      if (!res.ok) {
        if (isErrorResponse(generateData)) throw new Error(formatError(generateData));
        throw new Error("処理に失敗しました。");
      }
      if (!isGenerateSuccessResponse(generateData)) throw new Error("サーバー応答形式が不正です。");

      const generatedText = (generateData as GenerateSuccessResponse).generatedOutput;
      const currentSession = domainSessions[domainToUse];
      const previousForDomain =
        currentSession.currentResult ?? currentSession.previousResult;
      const shouldSyncDraft = shouldSyncEvaluationDraftWithGenerated(
        currentSession
      );
      setProgressStage("generated");
      onPatchDomainSession(domainToUse, {
        generatedOutput: generatedText,
        generatedForInput: normalizedInput,
        lastGeneratedInput: normalizedInput,
        currentResult: null,
        previousResult: previousForDomain,
        ...(shouldSyncDraft
          ? {
              evaluationDraftUserInput: normalizedInput,
              evaluationDraftOutput: generatedText,
              evaluationDraftSeedUserInput: normalizedInput,
              evaluationDraftSeedOutput: generatedText,
              hasPendingGeneratedDraft: false
            }
          : {
              hasPendingGeneratedDraft: true
            }),
        progressStage: "generated",
        requestError: ""
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "不明なエラーが発生しました。";
      setRequestError(message);
      setProgressStage("failed_generating");
      onPatchDomainSession(domainToUse, { progressStage: "failed_generating", requestError: message });
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await runGenerateOnly(userInput);
  };

  const handleRetry = async () => {
    if (lastGeneratedInput) await runGenerateOnly(lastGeneratedInput, selectedDomain);
  };

  const handleCopy = async () => {
    if (!generatedOutput) return;
    try {
      await navigator.clipboard.writeText(generatedOutput);
      setCopyLabel("Copied");
    } catch {
      setCopyLabel("Copy failed");
    }
  };

  const handleDownload = () => {
    if (!generatedOutput) return;
    const timestamp = currentResult?.createdAt ?? new Date().toISOString();
    const lines = [
      "# Resume Generation",
      `Timestamp: ${timestamp}`,
      `Domain: ${currentResult?.domain ?? selectedDomain}`,
      "",
      "## Input",
      generatedForInput || userInput.trim(),
      "",
      "## Output",
      generatedOutput
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resume-generation-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setDownloadLabel("Downloaded");
  };

  const handleTextareaKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      await runGenerateOnly(userInput);
    }
  };

  const canRetry = !loading && lastGeneratedInput.length > 0;

  const getGenerateStatusMessage = (): string => {
    if (loading && progressStage === "generating")
      return `${DOMAIN_LABELS[generatedForDomain]}を生成中です（${Math.floor(elapsedMs / 1000)}秒経過）`;
    if (requestError) return requestError;
    if (generatedOutput) return "生成が完了しました。評価タブで評価を実行できます。";
    if (progressStage === "generated") return "生成が完了しました。";
    return `職務経歴入力後に「${DOMAIN_GENERATE_LABELS[selectedDomain]}」を押してください。`;
  };

  return (
    <div className="workspace">
      <section className="panel compose" aria-labelledby="input-section-title">
        <h2 id="input-section-title">Input</h2>
        <form onSubmit={handleSubmit} aria-busy={loading}>
          <label htmlFor="user-input">職務経歴入力</label>
          <textarea
            id="user-input"
            value={userInput}
            onChange={(e) => {
              setUserInput(e.target.value);
              if (inputError) setInputError("");
            }}
            onKeyDown={handleTextareaKeyDown}
            placeholder="候補者の職務経歴テキストを入力してください"
            maxLength={MAX_USER_INPUT_CHARS}
            rows={10}
            aria-invalid={Boolean(inputError)}
          />
          <p className="hintText">Shortcut: Ctrl/Cmd + Enter で{DOMAIN_GENERATE_LABELS[selectedDomain]}</p>
          <div className="sampleRow">
            {(domainConfig?.samples ?? []).map((s) => (
              <button key={s.title} type="button" className="sampleButton" onClick={() => setUserInput(s.input)} disabled={loading}>
                {s.title}
              </button>
            ))}
          </div>
          <div className="counterRow">
            <p className="counter">{userInput.length} / {MAX_USER_INPUT_CHARS}</p>
            <div className="inputActions">
              <button className="primaryButton" type="submit" disabled={loading}>
                {loading && progressStage === "generating" ? "Generating..." : DOMAIN_GENERATE_LABELS[selectedDomain]}
              </button>
            </div>
          </div>
          {inputError && <p className="inputError" role="alert">{inputError}</p>}
        </form>
        <details className="advanced">
          <summary>Advanced</summary>
          <dl>
            <dt>Target Model</dt><dd>{TARGET_MODEL}</dd>
            <dt>Judge Model</dt><dd>{JUDGE_MODEL}</dd>
            <dt>Domain</dt><dd>{selectedDomain}</dd>
          </dl>
        </details>
      </section>

      <div className="rightColumn">
        <article className="panel resultCard outputCard" aria-busy={loading && progressStage === "generating"}>
          <div className="cardHeader">
            <h2 ref={resultHeadingRef} tabIndex={-1}>{DOMAIN_OUTPUT_LABELS[selectedDomain]}</h2>
            <div className="inlineActions">
              <button type="button" className="subtleButton" onClick={handleCopy} disabled={!generatedOutput}>{copyLabel}</button>
              <button type="button" className="subtleButton" onClick={handleDownload} disabled={!generatedOutput}>{downloadLabel}</button>
              <button type="button" className="subtleButton" onClick={handleRetry} disabled={!canRetry}>最後の入力で再生成</button>
              {generatedOutput && onSwitchToEvaluate && (
                <button type="button" className="subtleButton" style={{ marginLeft: 8 }} onClick={onSwitchToEvaluate}>
                  評価タブで評価する
                </button>
              )}
            </div>
          </div>
          {loading && progressStage === "generating" ? (
            <div className="skeletonWrap" aria-hidden="true">
              <div className="skeletonLine w95" /><div className="skeletonLine w100" /><div className="skeletonLine w82" /><div className="skeletonLine w76" />
            </div>
          ) : (
            <pre>{generatedOutput || `まだ${DOMAIN_LABELS[selectedDomain]}は生成されていません。`}</pre>
          )}
          {previousResult && (
            <details className="previousResult">
              <summary>前回の生成結果を表示</summary>
              <pre>{previousResult.generatedOutput}</pre>
            </details>
          )}
        </article>

        <ProgressPanel
          steps={COMMON_PROGRESS_STEPS}
          completedStepIndices={completedStepIndices}
          statusMessage={getGenerateStatusMessage()}
          error={requestError || undefined}
        />
      </div>
    </div>
  );
}
