import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { AppError } from "@/lib/errors";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeTargetPromptWithGEPA } from "@/lib/infrastructure/ax/axGepaTargetOptimizer";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";
import {
  GEPA_TARGET_FAST_UI_BUDGET,
  GEPA_TARGET_ULTRA_FAST_BUDGET
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  buildGepaCacheKey,
  clearGepaFailureCooldown,
  getCachedGepaResult,
  getGepaFailureCooldownReason,
  setGepaFailureCooldown,
  setCachedGepaResult
} from "@/lib/application/promptOptimization/gepaResultCache";

export interface TargetPromptImprovementResult {
  suggestion: string;
  analysisSummary: string;
  resultSource: "gepa" | "fallback" | "standard";
  degradedReason?: string;
}

export type TargetPromptImproveOptions = {
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

function buildTargetGepaCachePayload(
  failedRecords: EvaluationLogRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>
) {
  return {
    targetInstruction: promptConfig.targetInstruction,
    judgeRubric: promptConfig.judgeRubric,
    records: failedRecords.map((record) => ({
      id: record.id,
      userInput: record.userInput,
      generatedOutput: record.generatedOutput,
      score: record.judgeResult.score,
      reason: record.judgeResult.reason,
      passThreshold: record.judgeResult.passThreshold
    }))
  };
}

function mergeStageErrors(errors: unknown[]): string {
  return errors
    .map((error, index) => `stage${index + 1}: ${toDegradedReason(error)}`)
    .join(" | ");
}

async function generateStandardTargetImprovement(
  failedRecords: EvaluationLogRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
  options: TargetPromptImproveOptions
): Promise<Pick<TargetPromptImprovementResult, "suggestion" | "analysisSummary">> {
  const examplesText = failedRecords
    .map(
      (r, i) =>
        `【例${i + 1}】
- 職務経歴入力: ${r.userInput.slice(0, 200)}${r.userInput.length > 200 ? "..." : ""}
- 生成出力: ${r.generatedOutput.slice(0, 300)}${r.generatedOutput.length > 300 ? "..." : ""}
- Judge 評価: スコア ${r.judgeResult.score}/${r.judgeResult.passThreshold}, 不合格
- 理由: ${r.judgeResult.reason}`
    )
    .join("\n\n");

  const prompt = `あなたは LLM の生成プロンプトを改善する専門家です。

以下の「現在の生成プロンプト」と「Judge で不合格・低評価だったケース」を分析し、
生成品質を向上させるための改善案を提案してください。

## 現在の生成プロンプト（target.instruction_template）

${promptConfig.targetInstruction}

## 評価ルーブリック（Judge が参照する観点）

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 不合格・低評価だったケース

${examplesText}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の target.instruction_template にそのまま反映できる形で書いてください。

【分析サマリー】
（失敗パターンや不足していた観点を2〜3文で）

【改善案】
（target.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;

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
 * 不合格・低スコアの評価結果を分析し、生成プロンプトの改善案を LLM で生成する
 */
export async function generateTargetPromptImprovement(
  failedRecords: EvaluationLogRecord[],
  domain: DomainId,
  options: TargetPromptImproveOptions = {}
): Promise<TargetPromptImprovementResult> {
  if (failedRecords.length === 0) {
    return {
      suggestion:
        "不合格・低スコアの評価データがありません。生成・評価を実行してから再度お試しください。",
      analysisSummary: "分析対象なし",
      resultSource: "standard"
    };
  }
  const promptConfig = await getDomainPromptConfig(domain);

  if (options.llmProvider === "ax" && options.axMethod === "gepa") {
    const cacheKey = buildGepaCacheKey(
      "target",
      domain,
      buildTargetGepaCachePayload(failedRecords, promptConfig)
    );
    const cached = getCachedGepaResult<
      Pick<TargetPromptImprovementResult, "suggestion" | "analysisSummary">
    >(cacheKey);
    if (cached) {
      return { ...cached, resultSource: "gepa" };
    }
    const cooldownReason = getGepaFailureCooldownReason(cacheKey);
    if (cooldownReason) {
      const fallbackResult = await generateStandardTargetImprovement(
        failedRecords,
        promptConfig,
        options
      );
      return {
        ...fallbackResult,
        resultSource: "fallback",
        degradedReason: `cooldown-skip: ${cooldownReason}`
      };
    }

    const stageErrors: unknown[] = [];
    for (const budget of [GEPA_TARGET_FAST_UI_BUDGET, GEPA_TARGET_ULTRA_FAST_BUDGET]) {
      try {
        const gepaResult = await optimizeTargetPromptWithGEPA(
          failedRecords,
          domain,
          budget
        );
        setCachedGepaResult(cacheKey, {
          suggestion: gepaResult.suggestion,
          analysisSummary: gepaResult.analysisSummary
        });
        clearGepaFailureCooldown(cacheKey);
        return { ...gepaResult, resultSource: "gepa" };
      } catch (error) {
        if (!canFallbackFromGepa(error)) {
          throw error;
        }
        stageErrors.push(error);
      }
    }

    const fallbackResult = await generateStandardTargetImprovement(
      failedRecords,
      promptConfig,
      options
    );
    const mergedStageErrors = mergeStageErrors(stageErrors);
    setGepaFailureCooldown(cacheKey, mergedStageErrors);
    return {
      ...fallbackResult,
      resultSource: "fallback",
      degradedReason: mergedStageErrors
    };
  }

  const standardResult = await generateStandardTargetImprovement(
    failedRecords,
    promptConfig,
    options
  );
  return { ...standardResult, resultSource: "standard" };
}
