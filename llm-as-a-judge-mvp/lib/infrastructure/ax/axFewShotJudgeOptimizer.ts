/**
 * AxBootstrapFewShot による Judge 本番タスク最適化
 * 直接「判定タスク」を最適化し、チューニング後 instruction を返す
 */
import { ai, ax, AxAIGoogleGeminiModel, AxBootstrapFewShot } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL } from "@/lib/config/llm";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import {
  createAxOptimizerEventLogger,
  createAxProgressLogger,
  createAxMetricLogger,
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";

export interface FewShotJudgeOptimizationResult {
  suggestion: string;
  analysisSummary: string;
}

const JUDGE_FEWSHOT_MAX_DEMOS = 3;

type JudgeExample = {
  userInput: string;
  generatedOutput: string;
  score: number;
  reason: string;
  humanScore: number;
  passThreshold: number;
  humanComment?: string;
};

type JudgeDemoTrace = {
  userInput: string;
  generatedOutput: string;
  score: number;
  reason: string;
};

const AX_EXAMPLE_DISCLAIMER = `## Few-shot 例
最終的なユーザー入力より前の会話は、few-shot の例（デモ）です。
- User/Assistant の対話は、推論手順・出力形式の見本としてのみ提示しています。
- 例に含まれる固有名詞や事実は、現在のタスクの前提として扱わないでください。
- 実際のタスクは、最後の User メッセージから始まります。`;

const AX_EXAMPLE_SEPARATOR = `--- 例ここまで ---
上記は学習用の例です。例中の固有情報は無視してください。

実際のユーザー入力:`;

function normalizeForKey(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toTraceKey(userInput: string, generatedOutput: string): string {
  return `${normalizeForKey(userInput)}\0${normalizeForKey(generatedOutput)}`;
}

function getRecordKey(record: Pick<HumanFeedbackRecord, "userInput" | "generatedOutput">): string | null {
  const userInput = record.userInput?.trim();
  const generatedOutput = record.generatedOutput?.trim();
  if (!userInput || !generatedOutput) return null;
  return toTraceKey(userInput, generatedOutput);
}

function getTraceKey(trace: Record<string, unknown>): string | null {
  const userInput = typeof trace.userInput === "string" ? trace.userInput.trim() : "";
  const generatedOutput =
    typeof trace.generatedOutput === "string" ? trace.generatedOutput.trim() : "";
  if (!userInput || !generatedOutput) return null;
  return toTraceKey(userInput, generatedOutput);
}

function toHumanReason(comment?: string): string {
  const trimmed = comment?.trim();
  return trimmed && trimmed.length > 0
    ? trimmed
    : "人間評価スコアに整合する理由を返す";
}

function toSortedUniqueRecords(records: HumanFeedbackRecord[]): HumanFeedbackRecord[] {
  const sorted = [...records].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const byKey = new Map<string, HumanFeedbackRecord>();
  for (const record of sorted) {
    const key = getRecordKey(record);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, record);
  }
  return Array.from(byKey.values());
}

function buildHumanAlignedDemos(
  records: HumanFeedbackRecord[],
  optimizedDemos: unknown,
  programId: string,
  maxDemos: number
): {
  demos: Array<{ traces: JudgeDemoTrace[]; programId: string }>;
  selectedCount: number;
  matchedOptimizedCount: number;
} {
  const uniqueRecords = toSortedUniqueRecords(records);
  const recordByKey = new Map<string, HumanFeedbackRecord>();
  for (const record of uniqueRecords) {
    const key = getRecordKey(record);
    if (!key) continue;
    recordByKey.set(key, record);
  }

  const preferredKeys: string[] = [];
  const preferredSet = new Set<string>();
  if (Array.isArray(optimizedDemos)) {
    for (const demo of optimizedDemos) {
      const traces = (demo as { traces?: unknown }).traces;
      if (!Array.isArray(traces)) continue;
      for (const trace of traces) {
        if (!trace || typeof trace !== "object") continue;
        const key = getTraceKey(trace as Record<string, unknown>);
        if (!key || preferredSet.has(key)) continue;
        preferredSet.add(key);
        preferredKeys.push(key);
      }
    }
  }

  const selected: HumanFeedbackRecord[] = [];
  const selectedSet = new Set<string>();
  let matchedOptimizedCount = 0;

  for (const key of preferredKeys) {
    if (selected.length >= maxDemos) break;
    const record = recordByKey.get(key);
    if (!record || selectedSet.has(key)) continue;
    selected.push(record);
    selectedSet.add(key);
    matchedOptimizedCount += 1;
  }

  for (const record of uniqueRecords) {
    if (selected.length >= maxDemos) break;
    const key = getRecordKey(record);
    if (!key || selectedSet.has(key)) continue;
    selected.push(record);
    selectedSet.add(key);
  }

  const traces: JudgeDemoTrace[] = selected.map((record) => ({
    userInput: record.userInput,
    generatedOutput: record.generatedOutput,
    score: record.humanScore,
    reason: toHumanReason(record.humanComment)
  }));

  const demos =
    traces.length > 0
      ? [
          {
            programId,
            traces
          }
        ]
      : [];
  return {
    demos,
    selectedCount: traces.length,
    matchedOptimizedCount
  };
}

function buildPromptFromAxState(
  program: ReturnType<typeof ax>,
  optimizedDemos: unknown
): string {
  const sig = program.getSignature();
  const inputFields = sig.getInputFields().filter((f) => !f.isInternal);
  const outputFields = sig.getOutputFields().filter((f) => !f.isInternal);
  const inputNames = new Set(inputFields.map((f) => f.name));
  const outputNames = new Set(outputFields.map((f) => f.name));

  const traces: Record<string, unknown>[] = [];
  if (Array.isArray(optimizedDemos)) {
    for (const demo of optimizedDemos) {
      const t = (demo as { traces?: unknown }).traces;
      if (!Array.isArray(t)) continue;
      for (const trace of t) {
        if (!trace || typeof trace !== "object") continue;
        const obj = trace as Record<string, unknown>;
        const hasInput = Object.keys(obj).some((k) => inputNames.has(k));
        const hasOutput = Object.keys(obj).some((k) => outputNames.has(k));
        if (hasInput && hasOutput) traces.push(obj);
      }
    }
  }

  const formatBlock = (
    fields: Array<{ name: string; title: string }>,
    values: Record<string, unknown>,
    placeholder = false
  ): string =>
    fields
      .map((f) => {
        const v = values[f.name];
        const text =
          v == null
            ? (placeholder ? `<${f.name}>` : "")
            : typeof v === "string"
              ? v
              : JSON.stringify(v);
        return `${f.title}: ${text}`;
      })
      .join("\n");

  const parts: string[] = [];
  const description = sig.getDescription()?.trim();
  if (description) {
    parts.push(description);
  }
  parts.push(AX_EXAMPLE_DISCLAIMER);
  for (const trace of traces) {
    parts.push(`[user]\n${formatBlock(inputFields, trace)}`);
    parts.push(`[assistant]\n${formatBlock(outputFields, trace)}`);
  }
  parts.push(AX_EXAMPLE_SEPARATOR);
  parts.push(`[user]\n${formatBlock(inputFields, {}, true)}`);
  return parts.join("\n\n").trim();
}

export async function optimizeJudgePromptWithFewShot(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId
): Promise<FewShotJudgeOptimizationResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  if (withJudgeResult.length < 1) {
    return {
      suggestion:
        "AxBootstrapFewShot には Judge 評価済みの人間評価データが最低1件必要です。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
      analysisSummary: "データ不足（1件未満）"
    };
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY ?? "";
  if (!apiKey) {
    throw new AppError(
      500,
      "CONFIG_ERROR",
      "サーバー設定エラーが発生しました。",
      "GEMINI_API_KEY or GOOGLE_APIKEY is not set."
    );
  }

  const promptConfig = await getDomainPromptConfig(domain);
  const judgeProgram = ax(
    "userInput:string, generatedOutput:string -> score:number, reason:string",
    {
      description: promptConfig.judgeInstruction
    }
  );

  const studentAI = ai({
    name: "google-gemini",
    apiKey,
    config: {
      model: JUDGE_MODEL as AxAIGoogleGeminiModel,
      temperature: 0
    }
  });

  const examples: JudgeExample[] = withJudgeResult.slice(0, 12).map((record) => ({
    userInput: record.userInput,
    generatedOutput: record.generatedOutput,
    score: record.humanScore,
    reason: record.humanComment?.trim() || "人間評価と整合する理由を返す",
    humanScore: record.humanScore,
    passThreshold: promptConfig.passThreshold,
    humanComment: record.humanComment
  }));
  const logMetric = createAxMetricLogger(`judge-fewshot:${domain}`);

  const metricFn = (arg: Readonly<{ prediction: unknown; example: unknown }>): number => {
    const prediction = arg.prediction as { score?: unknown; reason?: unknown };
    const example = arg.example as JudgeExample;
    const predictedScore = Number(prediction.score);

    if (!Number.isFinite(predictedScore)) {
      logMetric(0);
      return 0;
    }

    const score = 1 - Math.min(1, Math.abs(predictedScore - example.humanScore) / 5);
    logMetric(score);
    return score;
  };

  const optimizer = new AxBootstrapFewShot({
    studentAI,
    options: {
      maxDemos: JUDGE_FEWSHOT_MAX_DEMOS,
      maxRounds: 2,
      earlyStoppingPatience: 2,
      verboseMode: true
    },
    onProgress: createAxProgressLogger(`judge-fewshot:${domain}`),
    optimizerLogger: createAxOptimizerEventLogger(`judge-fewshot:${domain}`),
    debugOptimizer: true,
    verbose: true
  });

  logAxOptimizationStart(`judge-fewshot:${domain}`, examples.length);
  const optimized = await optimizer.compile(judgeProgram, examples, metricFn, {
    maxIterations: 2,
    earlyStoppingPatience: 2,
    maxDemos: JUDGE_FEWSHOT_MAX_DEMOS
  });
  logAxOptimizationDone(`judge-fewshot:${domain}`, optimized.bestScore ?? 0);

  const optimizedDemos = optimized.demos ?? optimized.optimizedProgram?.demos ?? [];
  console.info(`[ax-opt][judge-fewshot:${domain}] demos=${optimizedDemos.length}`);

  const humanAligned = buildHumanAlignedDemos(
    withJudgeResult,
    optimizedDemos,
    judgeProgram.getId(),
    JUDGE_FEWSHOT_MAX_DEMOS
  );

  if (humanAligned.demos.length === 0) {
    throw new AppError(
      502,
      "PROVIDER_RESPONSE_INVALID",
      "Few-shot 用の人間評価デモを生成できませんでした。",
      "Human-aligned few-shot demos were empty."
    );
  }

  if (optimized.optimizedProgram) {
    judgeProgram.applyOptimization(optimized.optimizedProgram);
  }
  judgeProgram.setDemos(humanAligned.demos);

  const suggestion = buildPromptFromAxState(judgeProgram, humanAligned.demos);
  if (!suggestion) {
    throw new AppError(
      502,
      "PROVIDER_RESPONSE_INVALID",
      "Few-shot 最適化後のプロンプトを取得できませんでした。",
      "Failed to construct prompt snapshot from Ax program state."
    );
  }

  return {
    suggestion,
    analysisSummary: `AxBootstrapFewShot で判定タスクを最適化し、最終few-shotには人間評価スコアを反映しました。採用デモ: ${humanAligned.selectedCount}件（最適化候補一致: ${humanAligned.matchedOptimizedCount}件）。ベストスコア: ${(optimized.bestScore ?? 0).toFixed(2)}`
  };
}
