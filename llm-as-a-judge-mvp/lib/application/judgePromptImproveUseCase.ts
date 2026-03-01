import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { AppError } from "@/lib/errors";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeJudgePromptWithGEPA } from "@/lib/infrastructure/ax/axGepaOptimizer";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";
import {
  GEPA_JUDGE_FAST_UI_BUDGET,
  GEPA_JUDGE_ULTRA_FAST_BUDGET
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  buildGepaCacheKey,
  clearGepaFailureCooldown,
  getCachedGepaResult,
  getGepaFailureCooldownReason,
  setGepaFailureCooldown,
  setCachedGepaResult
} from "@/lib/application/promptOptimization/gepaResultCache";

export interface JudgePromptImprovementResult {
  suggestion: string;
  analysisSummary: string;
  currentPrompt?: string;
  resultSource: "gepa" | "fallback" | "standard";
  degradedReason?: string;
}

export type JudgePromptImproveOptions = {
  llmProvider?: LLMProviderId;
  axMethod?: AxMethodId;
};

const GEPA_RECOVERABLE_ERROR_CODES = new Set([
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
  "PROVIDER_RESPONSE_INVALID"
]);

function canFallbackFromGepa(error: unknown): boolean {
  return error instanceof AppError && GEPA_RECOVERABLE_ERROR_CODES.has(error.code);
}

function toDegradedReason(error: unknown): string {
  if (error instanceof AppError) {
    return `${error.code}: ${error.exposeMessage}`;
  }
  if (error instanceof Error) return error.message;
  return "GEPA failure";
}

function buildJudgeGepaCachePayload(
  withJudgeResult: HumanFeedbackRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>
) {
  return {
    judgeInstruction: promptConfig.judgeInstruction,
    judgeRubric: promptConfig.judgeRubric,
    passThreshold: promptConfig.passThreshold,
    records: withJudgeResult.map((record) => ({
      id: record.id,
      userInput: record.userInput,
      generatedOutput: record.generatedOutput,
      judgeResult: record.judgeResult
        ? {
            score: record.judgeResult.score,
            reason: record.judgeResult.reason,
            pass: record.judgeResult.pass
          }
        : null,
      humanScore: record.humanScore,
      humanComment: record.humanComment ?? ""
    }))
  };
}

function mergeStageErrors(errors: unknown[]): string {
  return errors
    .map((error, index) => `stage${index + 1}: ${toDegradedReason(error)}`)
    .join(" | ");
}

async function generateStandardJudgeImprovement(
  withJudgeResult: HumanFeedbackRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
  options: JudgePromptImproveOptions
): Promise<Pick<JudgePromptImprovementResult, "suggestion" | "analysisSummary">> {
  // 乖離が大きいケースを優先（スコア差が2以上）
  const withDiscrepancy = withJudgeResult
    .map((r) => ({
      ...r,
      scoreDiff: Math.abs(r.humanScore - (r.judgeResult?.score ?? r.humanScore))
    }))
    .filter((r) => r.scoreDiff >= 2)
    .sort((a, b) => b.scoreDiff - a.scoreDiff);

  const recordsToAnalyze =
    withDiscrepancy.length >= 3 ? withDiscrepancy.slice(0, 5) : withJudgeResult.slice(0, 5);

  const examplesText = recordsToAnalyze
    .map(
      (r, i) =>
        `【例${i + 1}】
- 生成出力: ${r.generatedOutput.slice(0, 300)}${r.generatedOutput.length > 300 ? "..." : ""}
- Judge 評価: スコア ${r.judgeResult!.score}, 理由: ${r.judgeResult!.reason}
- 人間評価: スコア ${r.humanScore}${r.humanComment ? `, コメント: ${r.humanComment}` : ""}`
    )
    .join("\n\n");

  const prompt = `あなたは LLM の評価プロンプト（Judge）を改善する専門家です。

以下の「現在の Judge プロンプト」と「人間評価との乖離があるケース」を分析し、
Judge の評価が人間の感覚に近づくための改善案を提案してください。

## 現在の Judge プロンプト（instruction_template）

${promptConfig.judgeInstruction}

## 現在のルーブリック

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 人間評価との乖離があるケース

${examplesText}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の judge.instruction_template にそのまま反映できる形で書いてください。

【分析サマリー】
（乖離のパターンや原因を2〜3文で）

【改善案】
（judge.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;

  const rawResponse = await generateTextForPromptImprovement(prompt, {
    llmProvider: options.llmProvider,
    axMethod: options.axMethod
  });

  const analysisMatch = rawResponse.match(/【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/);
  const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);

  const analysisSummary = analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした";
  const suggestion = suggestionMatch?.[1]?.trim() ?? rawResponse;

  return { suggestion, analysisSummary };
}

/**
 * 人間評価に基づいて Judge プロンプトの改善案を LLM で生成する
 * 乖離が大きいケース（Judge と人間のスコア差が 2 以上）を優先的に分析
 */
export async function generateJudgePromptImprovement(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId,
  options: JudgePromptImproveOptions = {}
): Promise<JudgePromptImprovementResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  const promptConfig = await getDomainPromptConfig(domain);

  if (withJudgeResult.length === 0) {
    return {
      suggestion: "Judge 評価済みの人間評価データがありません。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
      analysisSummary: "分析対象なし",
      currentPrompt: promptConfig.judgeInstruction,
      resultSource: "standard"
    };
  }

  if (options.llmProvider === "ax" && options.axMethod === "gepa") {
    const cacheKey = buildGepaCacheKey(
      "judge",
      domain,
      buildJudgeGepaCachePayload(withJudgeResult, promptConfig)
    );
    const cached = getCachedGepaResult<
      Pick<JudgePromptImprovementResult, "suggestion" | "analysisSummary">
    >(cacheKey);
    if (cached) {
      return {
        ...cached,
        currentPrompt: promptConfig.judgeInstruction,
        resultSource: "gepa"
      };
    }
    const cooldownReason = getGepaFailureCooldownReason(cacheKey);
    if (cooldownReason) {
      const fallbackResult = await generateStandardJudgeImprovement(
        withJudgeResult,
        promptConfig,
        options
      );
      return {
        ...fallbackResult,
        currentPrompt: promptConfig.judgeInstruction,
        resultSource: "fallback",
        degradedReason: `cooldown-skip: ${cooldownReason}`
      };
    }

    const stageErrors: unknown[] = [];
    for (const budget of [GEPA_JUDGE_FAST_UI_BUDGET, GEPA_JUDGE_ULTRA_FAST_BUDGET]) {
      try {
        const gepaResult = await optimizeJudgePromptWithGEPA(
          feedbackRecords,
          domain,
          budget
        );
        setCachedGepaResult(cacheKey, {
          suggestion: gepaResult.suggestion,
          analysisSummary: gepaResult.analysisSummary
        });
        clearGepaFailureCooldown(cacheKey);
        return {
          ...gepaResult,
          currentPrompt: promptConfig.judgeInstruction,
          resultSource: "gepa"
        };
      } catch (error) {
        if (!canFallbackFromGepa(error)) {
          throw error;
        }
        stageErrors.push(error);
      }
    }

    const fallbackResult = await generateStandardJudgeImprovement(
      withJudgeResult,
      promptConfig,
      options
    );
    const mergedStageErrors = mergeStageErrors(stageErrors);
    setGepaFailureCooldown(cacheKey, mergedStageErrors);
    return {
      ...fallbackResult,
      currentPrompt: promptConfig.judgeInstruction,
      resultSource: "fallback",
      degradedReason: mergedStageErrors
    };
  }
  const standardResult = await generateStandardJudgeImprovement(
    withJudgeResult,
    promptConfig,
    options
  );
  return {
    ...standardResult,
    currentPrompt: promptConfig.judgeInstruction,
    resultSource: "standard"
  };
}
