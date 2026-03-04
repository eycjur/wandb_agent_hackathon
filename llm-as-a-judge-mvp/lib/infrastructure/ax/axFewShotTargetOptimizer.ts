/**
 * AxBootstrapFewShot による生成本番タスク最適化
 * 直接「生成タスク」を最適化し、チューニング後 instruction を返す
 */
import { ai, ax, AxAIGoogleGeminiModel, AxBootstrapFewShot } from "@ax-llm/ax";
import { AppError } from "@/lib/errors";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { JUDGE_MODEL, TARGET_MODEL } from "@/lib/config/llm";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import {
  createAxOptimizerEventLogger,
  createAxProgressLogger,
  createAxMetricLogger,
  logAxOptimizationDone,
  logAxOptimizationStart
} from "@/lib/application/promptOptimization/axOptimizationLogger";

export interface FewShotTargetOptimizationResult {
  suggestion: string;
  analysisSummary: string;
}

type TargetExample = {
  userInput: string;
  generatedOutput: string;
};

const AX_EXAMPLE_DISCLAIMER = `## Few-shot 例
最終的なユーザー入力より前の会話は、few-shot の例（デモ）です。
- User/Assistant の対話は、推論手順・出力形式の見本としてのみ提示しています。
- 例に含まれる固有名詞や事実は、現在のタスクの前提として扱わないでください。
- 実際のタスクは、最後の User メッセージから始まります。`;

const AX_EXAMPLE_SEPARATOR = `--- 例ここまで ---
上記は学習用の例です。例中の固有情報は無視してください。

実際のユーザー入力:`;

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

export async function optimizeTargetPromptWithFewShot(
  records: EvaluationLogRecord[],
  domain: DomainId
): Promise<FewShotTargetOptimizationResult> {
  const usableRecords = records.filter(
    (r) => r.userInput.trim().length > 0 && r.generatedOutput.trim().length > 0
  );
  if (usableRecords.length < 1) {
    return {
      suggestion:
        "AxBootstrapFewShot には評価ログが最低1件必要です。生成・評価を実行してから再度お試しください。",
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
  const generatorProgram = ax("userInput:string -> generatedOutput:string", {
    description: promptConfig.targetInstruction
  });
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
      model: TARGET_MODEL as AxAIGoogleGeminiModel,
      temperature: 0.2
    }
  });
  const judgeAI = ai({
    name: "google-gemini",
    apiKey,
    config: {
      model: JUDGE_MODEL as AxAIGoogleGeminiModel,
      temperature: 0
    }
  });

  const examples: TargetExample[] = usableRecords.slice(0, 12).map((record) => ({
    userInput: record.userInput,
    generatedOutput: record.generatedOutput
  }));
  const logMetric = createAxMetricLogger(`target-fewshot:${domain}`);
  const judgeCache = new Map<string, number>();

  const metricFn = async (arg: Readonly<{ prediction: unknown; example: unknown }>): Promise<number> => {
    const prediction = arg.prediction as { generatedOutput?: unknown };
    const example = arg.example as TargetExample;
    const predicted = typeof prediction.generatedOutput === "string" ? prediction.generatedOutput.trim() : "";
    if (!predicted) {
      logMetric(0);
      return 0;
    }
    const cacheKey = `${example.userInput}:::${predicted}`;
    const cached = judgeCache.get(cacheKey);
    if (cached != null) {
      logMetric(cached);
      return cached;
    }

    try {
      const judgeResult = await judgeProgram.forward(
        judgeAI,
        { userInput: example.userInput, generatedOutput: predicted },
        { stream: false }
      );
      const judgeScore = Number(judgeResult.score);
      if (!Number.isFinite(judgeScore)) {
        console.warn(
          `[ax-opt][target-fewshot:${domain}] metric_error=non_finite_score score=${String(judgeResult.score)}`
        );
      }
      const metricScore = Number.isFinite(judgeScore)
        ? Math.max(0, Math.min(1, judgeScore / 5))
        : 0;
      judgeCache.set(cacheKey, metricScore);
      logMetric(metricScore);
      return metricScore;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[ax-opt][target-fewshot:${domain}] metric_error=judge_eval_failed detail=${detail}`
      );
      logMetric(0);
      return 0;
    }
  };

  const optimizer = new AxBootstrapFewShot({
    studentAI,
    options: {
      maxDemos: 3,
      maxRounds: 2,
      earlyStoppingPatience: 2,
      verboseMode: true
    },
    onProgress: createAxProgressLogger(`target-fewshot:${domain}`),
    optimizerLogger: createAxOptimizerEventLogger(`target-fewshot:${domain}`),
    debugOptimizer: true,
    verbose: true
  });

  logAxOptimizationStart(`target-fewshot:${domain}`, examples.length);
  const optimized = await optimizer.compile(generatorProgram, examples, metricFn, {
    maxIterations: 2,
    earlyStoppingPatience: 2,
    maxDemos: 3
  });
  logAxOptimizationDone(`target-fewshot:${domain}`, optimized.bestScore ?? 0);

  const optimizedDemos = optimized.demos ?? optimized.optimizedProgram?.demos ?? [];
  console.info(`[ax-opt][target-fewshot:${domain}] demos=${optimizedDemos.length}`);

  if (optimizedDemos.length === 0) {
    throw new AppError(
      502,
      "PROVIDER_RESPONSE_INVALID",
      "Few-shot 最適化で有効なデモを生成できませんでした。",
      "AxBootstrapFewShot produced zero demos."
    );
  }

  if (optimized.optimizedProgram) {
    generatorProgram.applyOptimization(optimized.optimizedProgram);
  } else {
    generatorProgram.setDemos(optimizedDemos);
  }

  const suggestion = buildPromptFromAxState(generatorProgram, optimizedDemos);
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
    analysisSummary: `AxBootstrapFewShot で生成タスクを直接最適化しました。Axの適用ロジック（applyOptimization/setDemos）に従ってプロンプトを取得しています。ベストスコア: ${(optimized.bestScore ?? 0).toFixed(2)}`
  };
}
