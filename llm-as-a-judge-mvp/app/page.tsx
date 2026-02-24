"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { MAX_USER_INPUT_CHARS } from "@/lib/config/app";
import { JUDGE_MODEL, TARGET_MODEL } from "@/lib/config/llm";
import type {
  DomainConfigResponse,
  ErrorCode,
  GenerateEvaluateErrorResponse,
  GenerateSuccessResponse,
  JudgeSuccessResponse
} from "@/lib/contracts/generateEvaluate";

type ProgressStage =
  | "idle"
  | "input_accepted"
  | "generating"
  | "generated"
  | "judging"
  | "done"
  | "failed_generating"
  | "failed_judging";

type StepState = "pending" | "active" | "done" | "failed";
type MainTab = "generation" | "evaluation";

type EvaluationResult = {
  domain: "resume_summary";
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  userInput: string;
  generatedOutput: string;
  score: number;
  reason: string;
  createdAt: string;
};

const PROGRESS_STEPS: Array<{
  key: "input_accepted" | "generating" | "generated" | "judging" | "done";
  label: string;
}> = [
    { key: "input_accepted", label: "Input accepted" },
    { key: "generating", label: "Generating summary" },
    { key: "generated", label: "Summary generated" },
    { key: "judging", label: "Judging summary" },
    { key: "done", label: "Completed" }
  ];

const SCORE_GUIDE = [
  "5: 採用判断に十分使える高品質な要約",
  "4: 実務利用可能だが軽微な改善余地あり",
  "3: 要点はあるが情報不足または曖昧さが残る",
  "2: 採用判断に必要な情報が不足",
  "1: 重要情報の欠落が大きい",
  "0: 要約として成立していない"
] as const;

export default function HomePage() {
  const [userInput, setUserInput] = useState("");
  const [inputError, setInputError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [loading, setLoading] = useState(false);
  const [progressStage, setProgressStage] = useState<ProgressStage>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [copyLabel, setCopyLabel] = useState("Copy output");
  const [downloadLabel, setDownloadLabel] = useState("Download .txt");
  const [activeMainTab, setActiveMainTab] = useState<MainTab>("generation");
  const [generatedOutput, setGeneratedOutput] = useState("");
  const [generatedForInput, setGeneratedForInput] = useState("");
  const [lastGeneratedInput, setLastGeneratedInput] = useState("");
  const [currentResult, setCurrentResult] = useState<EvaluationResult | null>(null);
  const [previousResult, setPreviousResult] = useState<EvaluationResult | null>(null);
  const [domainConfig, setDomainConfig] = useState<DomainConfigResponse | null>(null);

  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const requestErrorRef = useRef<HTMLParagraphElement | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!loading) {
      return;
    }

    const startAt = Date.now();
    const intervalId = setInterval(() => {
      setElapsedMs(Date.now() - startAt);
    }, 200);

    return () => {
      clearInterval(intervalId);
    };
  }, [loading]);

  useEffect(() => {
    if (progressStage === "done") {
      resultHeadingRef.current?.focus();
    }
  }, [progressStage]);

  useEffect(() => {
    if (requestError) {
      requestErrorRef.current?.focus();
    }
  }, [requestError]);

  useEffect(() => {
    const loadDomainConfig = async () => {
      try {
        const response = await fetch("/api/domain-config", {
          method: "GET",
          cache: "no-store"
        });
        if (!response.ok) {
          return;
        }

        const data: unknown = await response.json();
        if (isDomainConfigResponse(data)) {
          setDomainConfig(data);
        }
      } catch {
        // Domain config fetch failure should not block the core flow.
      }
    };

    void loadDomainConfig();
  }, []);

  const runGenerateOnly = async (rawInput: string) => {
    if (inFlightRef.current) {
      return;
    }

    const validationError = validateUserInput(rawInput);
    if (validationError) {
      setInputError(validationError);
      setProgressStage("idle");
      return;
    }

    const normalizedInput = rawInput.trim();
    setInputError("");
    setRequestError("");
    setLoading(true);
    setElapsedMs(0);
    setCopyLabel("Copy output");
    setDownloadLabel("Download .txt");
    setActiveMainTab("generation");
    setProgressStage("input_accepted");
    inFlightRef.current = true;

    try {
      setProgressStage("generating");
      const generateResponse = await fetch("/api/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ userInput: normalizedInput })
      });

      let generateData: unknown;
      try {
        generateData = await generateResponse.json();
      } catch {
        throw new Error("サーバー応答の解析に失敗しました。");
      }

      if (!generateResponse.ok) {
        if (isErrorResponse(generateData)) {
          throw new Error(formatError(generateData));
        }
        throw new Error("処理に失敗しました。");
      }

      if (!isGenerateSuccessResponse(generateData)) {
        throw new Error("サーバー応答形式が不正です。");
      }

      setGeneratedOutput(generateData.generatedOutput);
      setGeneratedForInput(normalizedInput);
      setLastGeneratedInput(normalizedInput);
      if (currentResult) {
        setPreviousResult(currentResult);
      }
      setCurrentResult(null);
      setProgressStage("generated");
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "不明なエラーが発生しました。";
      setRequestError(message);
      setProgressStage("failed_generating");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  const runJudgeOnly = async () => {
    if (inFlightRef.current) {
      return;
    }

    if (!generatedOutput || !generatedForInput) {
      setRequestError("先に要約を生成してください。");
      setProgressStage("idle");
      return;
    }

    setRequestError("");
    setLoading(true);
    setElapsedMs(0);
    setActiveMainTab("evaluation");
    setProgressStage("judging");
    inFlightRef.current = true;

    try {
      const judgeResponse = await fetch("/api/judge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          userInput: generatedForInput,
          generatedOutput
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
        userInput: generatedForInput,
        generatedOutput,
        score: judgeData.score,
        reason: judgeData.reason,
        createdAt: new Date().toISOString()
      };

      setPreviousResult(currentResult ?? previousResult);
      setCurrentResult(nextResult);
      setActiveMainTab("evaluation");
      setProgressStage("done");
    } catch (submitError) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : "不明なエラーが発生しました。";
      setRequestError(message);
      setProgressStage("failed_judging");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runGenerateOnly(userInput);
  };

  const handleJudge = async () => {
    await runJudgeOnly();
  };

  const handleRetry = async () => {
    if (!lastGeneratedInput) {
      return;
    }
    await runGenerateOnly(lastGeneratedInput);
  };

  const handleCopy = async () => {
    if (!generatedOutput) {
      return;
    }

    try {
      await navigator.clipboard.writeText(generatedOutput);
      setCopyLabel("Copied");
    } catch {
      setCopyLabel("Copy failed");
    }
  };

  const handleDownload = () => {
    if (!generatedOutput) {
      return;
    }

    const timestamp = currentResult?.createdAt ?? new Date().toISOString();
    const usedInput = generatedForInput || userInput.trim();
    const lines = [
      "# Resume Summary Evaluation Result",
      `Timestamp: ${timestamp}`,
      `Domain: ${currentResult?.domain ?? "resume_summary"}`,
      `Rubric Version: ${currentResult?.rubricVersion ?? (domainConfig?.rubricVersion ?? 1)}`,
      "",
      "## Resume Input",
      usedInput,
      "",
      "## Generated Resume Summary",
      generatedOutput,
      "",
      "## Judge"
    ];

    if (currentResult) {
      lines.push(
        `Score: ${currentResult.score}`,
        `Pass Threshold: ${currentResult.passThreshold}`,
        `Pass: ${currentResult.pass ? "YES" : "NO"}`,
        `Reason: ${currentResult.reason}`
      );
    } else {
      lines.push("未評価");
    }

    lines.push("");

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `resume-summary-eval-${Date.now()}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setDownloadLabel("Downloaded");
  };

  const handleTextareaKeyDown = async (
    event: KeyboardEvent<HTMLTextAreaElement>
  ) => {
    const submitShortcut = (event.metaKey || event.ctrlKey) && event.key === "Enter";
    if (!submitShortcut) {
      return;
    }

    event.preventDefault();
    await runGenerateOnly(userInput);
  };

  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  const canRetry = !loading && lastGeneratedInput.length > 0;
  const canJudge = !loading && generatedOutput.length > 0 && generatedForInput.length > 0;
  const scoreDelta =
    currentResult && previousResult ? currentResult.score - previousResult.score : null;

  const progressPanel = (
    <section className="panel progressPanel" aria-live="polite">
      <h2>Progress</h2>
      <ol>
        {PROGRESS_STEPS.map((step, index) => {
          const state = getStepState(progressStage, index);
          return (
            <li key={step.key} className={`stepItem step-${state}`}>
              <span className="stepDot" />
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>

      <p className="statusLine" aria-live="polite">
        {buildStatusMessage(progressStage, loading, elapsedSeconds)}
      </p>

      {requestError ? (
        <p
          ref={requestErrorRef}
          tabIndex={-1}
          className="errorBanner"
          role="alert"
          aria-live="assertive"
        >
          {requestError}
        </p>
      ) : (
        <p className="errorPlaceholder" aria-hidden="true" />
      )}
    </section>
  );

  const generationPanel = (
    <article
      className="panel resultCard outputCard"
      aria-busy={loading && progressStage === "generating"}
    >
      <div className="cardHeader">
        <h2 ref={resultHeadingRef} tabIndex={-1}>
          生成された職務経歴要約
        </h2>
        <div className="inlineActions">
          <button
            type="button"
            className="subtleButton"
            onClick={handleCopy}
            disabled={!generatedOutput}
          >
            {copyLabel}
          </button>
          <button
            type="button"
            className="subtleButton"
            onClick={handleDownload}
            disabled={!generatedOutput}
          >
            {downloadLabel}
          </button>
          <button
            type="button"
            className="subtleButton"
            onClick={handleRetry}
            disabled={!canRetry}
          >
            最後の入力で再生成
          </button>
        </div>
      </div>

      {loading && progressStage === "generating" ? (
        <OutputSkeleton />
      ) : (
        <pre>{generatedOutput || "まだ生成されていません。"}</pre>
      )}

      {previousResult ? (
        <details className="previousResult">
          <summary>前回の要約を表示</summary>
          <pre>{previousResult.generatedOutput}</pre>
        </details>
      ) : null}
    </article>
  );

  const evaluationPanel = (
    <article className="panel resultCard scoreCard">
      <h2>評価結果</h2>

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
                判定: {currentResult.pass ? "合格（実務投入可能）" : "要改善"}
              </p>
            ) : (
              <p className="passBadge neutral">判定: 未評価</p>
            )}
            <p className="thresholdText">
              合格ライン: score {">="}{" "}
              {currentResult ? currentResult.passThreshold : (domainConfig?.passThreshold ?? 4)}
            </p>
            <p className="thresholdText">
              Domain: {currentResult?.domain ?? "resume_summary"} / Rubric v
              {currentResult?.rubricVersion ?? (domainConfig?.rubricVersion ?? 1)}
            </p>
          </div>
          <div>
            <p className="scoreLabel">Reason</p>
            <p>{currentResult?.reason || "未評価"}</p>
          </div>
        </>
      )}

      <div className="scoreGuide" aria-label="score rubric guide">
        <p className="scoreGuideTitle">職務経歴要約 Score Guide</p>
        <ul>
          {SCORE_GUIDE.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </article>
  );

  return (
    <main className="shell">
      <header className="hero">
        <p className="kicker">Recruiting Assistant</p>
        <h1>職務経歴要約</h1>
        <p className="subtitle">
          職務経歴テキストを採用担当向け要約に変換し、必要に応じて実務利用可能性を評価します。
        </p>
      </header>

      <div className="mainTabs" role="tablist" aria-label="main view tabs">
        <button
          type="button"
          role="tab"
          id="tab-generation"
          aria-controls="panel-generation"
          aria-selected={activeMainTab === "generation"}
          className={`tabButton ${activeMainTab === "generation" ? "active" : ""}`}
          onClick={() => setActiveMainTab("generation")}
        >
          生成
        </button>
        <button
          type="button"
          role="tab"
          id="tab-evaluation"
          aria-controls="panel-evaluation"
          aria-selected={activeMainTab === "evaluation"}
          className={`tabButton ${activeMainTab === "evaluation" ? "active" : ""}`}
          onClick={() => setActiveMainTab("evaluation")}
        >
          評価
        </button>
      </div>

      {activeMainTab === "generation" ? (
        <section
          id="panel-generation"
          role="tabpanel"
          aria-labelledby="tab-generation"
          className="tabPanel"
        >
          <div className="workspace">
            <section className="panel compose" aria-labelledby="input-section-title">
              <h2 id="input-section-title">Input</h2>
              <form onSubmit={handleSubmit} aria-busy={loading}>
                <label htmlFor="user-input">職務経歴入力</label>
                <textarea
                  id="user-input"
                  value={userInput}
                  onChange={(event) => {
                    setUserInput(event.target.value);
                    if (inputError) {
                      setInputError("");
                    }
                  }}
                  onKeyDown={handleTextareaKeyDown}
                  placeholder="候補者の職務経歴テキストを入力してください"
                  maxLength={MAX_USER_INPUT_CHARS}
                  rows={10}
                  aria-invalid={Boolean(inputError)}
                  aria-describedby="input-help input-counter input-error"
                />

                <p id="input-help" className="hintText">
                  Shortcut: Ctrl/Cmd + Enter で要約を生成
                </p>

                <div className="sampleRow">
                  {(domainConfig?.samples ?? []).map((sample) => (
                    <button
                      key={sample.title}
                      type="button"
                      className="sampleButton"
                      onClick={() => setUserInput(sample.input)}
                      disabled={loading}
                    >
                      {sample.title}
                    </button>
                  ))}
                </div>

                <div className="counterRow">
                  <p id="input-counter" className="counter">
                    {userInput.length} / {MAX_USER_INPUT_CHARS}
                  </p>
                  <div className="inputActions">
                    <button className="primaryButton" type="submit" disabled={loading}>
                      {loading && progressStage === "generating"
                        ? "Generating..."
                        : "要約を生成"}
                    </button>
                  </div>
                </div>

                {inputError ? (
                  <p id="input-error" className="inputError" role="alert" aria-live="assertive">
                    {inputError}
                  </p>
                ) : (
                  <p id="input-error" className="inputErrorPlaceholder" aria-hidden="true" />
                )}
              </form>

              <details className="advanced">
                <summary>Advanced (固定設定)</summary>
                <dl>
                  <dt>Provider</dt>
                  <dd>Google Gemini</dd>
                  <dt>Target Model</dt>
                  <dd>{TARGET_MODEL}</dd>
                  <dt>Judge Model</dt>
                  <dd>{JUDGE_MODEL}</dd>
                  <dt>Judge Prompt</dt>
                  <dd>prompts/resume_summary.yml</dd>
                </dl>
              </details>
            </section>

            <div className="rightColumn">
              {generationPanel}
              {progressPanel}
            </div>
          </div>
        </section>
      ) : (
        <section
          id="panel-evaluation"
          role="tabpanel"
          aria-labelledby="tab-evaluation"
          className="tabPanel"
        >
          <section className="evaluationView" aria-busy={loading && progressStage === "judging"}>
            <div className="evaluateAction">
              <button
                className="primaryButton"
                type="button"
                onClick={handleJudge}
                disabled={!canJudge}
              >
                {loading && progressStage === "judging" ? "Judging..." : "要約を評価"}
              </button>
              {!generatedOutput && (
                <p className="evaluateHint">先に「生成」タブで要約を生成してください。</p>
              )}
            </div>
            <div className="evaluationSplit">
              {generationPanel}
              {evaluationPanel}
            </div>
            {progressPanel}
          </section>
        </section>
      )}
    </main>
  );
}

function validateUserInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return "職務経歴入力は必須です。";
  }
  if (trimmed.length > MAX_USER_INPUT_CHARS) {
    return `職務経歴入力は${MAX_USER_INPUT_CHARS}文字以内で入力してください。`;
  }
  return null;
}

function isGenerateSuccessResponse(data: unknown): data is GenerateSuccessResponse {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  return (
    "generatedOutput" in data &&
    typeof data.generatedOutput === "string" &&
    data.generatedOutput.length > 0
  );
}

function isJudgeSuccessResponse(data: unknown): data is JudgeSuccessResponse {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  return (
    "domain" in data &&
    "rubricVersion" in data &&
    "passThreshold" in data &&
    "pass" in data &&
    "score" in data &&
    "reason" in data &&
    data.domain === "resume_summary" &&
    typeof data.rubricVersion === "number" &&
    Number.isInteger(data.rubricVersion) &&
    data.rubricVersion > 0 &&
    typeof data.passThreshold === "number" &&
    Number.isInteger(data.passThreshold) &&
    data.passThreshold >= 0 &&
    data.passThreshold <= 5 &&
    typeof data.pass === "boolean" &&
    typeof data.score === "number" &&
    Number.isInteger(data.score) &&
    data.score >= 0 &&
    data.score <= 5 &&
    data.pass === (data.score >= data.passThreshold) &&
    typeof data.reason === "string" &&
    data.reason.length > 0
  );
}

function isErrorResponse(data: unknown): data is GenerateEvaluateErrorResponse {
  if (typeof data !== "object" || data === null || !("error" in data)) {
    return false;
  }

  const payload = data.error;
  if (typeof payload !== "object" || payload === null) {
    return false;
  }

  return (
    "code" in payload &&
    "message" in payload &&
    typeof payload.code === "string" &&
    typeof payload.message === "string"
  );
}

function isDomainConfigResponse(data: unknown): data is DomainConfigResponse {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  if (
    !("domain" in data) ||
    data.domain !== "resume_summary" ||
    !("rubricVersion" in data) ||
    typeof data.rubricVersion !== "number" ||
    !Number.isInteger(data.rubricVersion) ||
    data.rubricVersion <= 0 ||
    !("passThreshold" in data) ||
    typeof data.passThreshold !== "number" ||
    !Number.isInteger(data.passThreshold) ||
    data.passThreshold < 0 ||
    data.passThreshold > 5 ||
    !("samples" in data) ||
    !Array.isArray(data.samples)
  ) {
    return false;
  }

  return data.samples.every(
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

function formatError(errorResponse: GenerateEvaluateErrorResponse): string {
  const { code, message } = errorResponse.error;
  const guidanceMap: Partial<Record<ErrorCode, string>> = {
    PROVIDER_TIMEOUT: "時間をおいて再試行してください。",
    CONFIG_ERROR: "運用担当者に設定確認を依頼してください。",
    PROVIDER_RESPONSE_INVALID: "プロンプトや入力を見直して再実行してください。"
  };

  const guidance = guidanceMap[code];
  return guidance ? `${message} ${guidance}` : message;
}

function getStepState(stage: ProgressStage, stepIndex: number): StepState {
  const stageOrder: Array<
    "input_accepted" | "generating" | "generated" | "judging" | "done"
  > = [
      "input_accepted",
      "generating",
      "generated",
      "judging",
      "done"
    ];

  if (stage === "idle") {
    return "pending";
  }

  if (stage === "failed_generating") {
    if (stepIndex === 0) {
      return "done";
    }
    if (stepIndex === 1) {
      return "failed";
    }
    return "pending";
  }

  if (stage === "failed_judging") {
    if (stepIndex <= 2) {
      return "done";
    }
    if (stepIndex === 3) {
      return "failed";
    }
    return "pending";
  }

  if (stage === "done") {
    return "done";
  }

  const currentIndex = stageOrder.indexOf(stage);
  if (stepIndex < currentIndex) {
    return "done";
  }
  if (stepIndex === currentIndex) {
    return "active";
  }
  return "pending";
}

function buildStatusMessage(
  stage: ProgressStage,
  loading: boolean,
  elapsedSeconds: number
): string {
  if (loading && stage === "generating") {
    return `職務経歴要約を生成中です（${elapsedSeconds}秒経過）`;
  }

  if (loading && stage === "judging") {
    return `要約を評価中です（${elapsedSeconds}秒経過）`;
  }

  if (stage === "generated") {
    return "要約が完了しました。「要約を評価」を押して評価を実行してください。";
  }

  if (stage === "done") {
    return "要約と評価が完了しました。結果を確認してください。";
  }

  if (stage === "failed_generating") {
    return "要約生成に失敗しました。エラー内容を確認してください。";
  }

  if (stage === "failed_judging") {
    return "要約の評価に失敗しました。エラー内容を確認してください。";
  }

  if (stage === "input_accepted") {
    return "職務経歴入力を受け付けました。";
  }

  return "職務経歴入力後に「要約を生成」を押してください。";
}

function OutputSkeleton() {
  return (
    <div className="skeletonWrap" aria-hidden="true">
      <div className="skeletonLine w95" />
      <div className="skeletonLine w100" />
      <div className="skeletonLine w82" />
      <div className="skeletonLine w76" />
    </div>
  );
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
