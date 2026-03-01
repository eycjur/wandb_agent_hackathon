import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeTargetPromptWithGEPA } from "@/lib/infrastructure/ax/axGepaTargetOptimizer";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";

export interface TargetPromptImprovementResult {
  suggestion: string;
  analysisSummary: string;
}

export type TargetPromptImproveOptions = {
  llmProvider?: LLMProviderId;
  axMethod?: AxMethodId;
};

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
      analysisSummary: "分析対象なし"
    };
  }

  if (options.llmProvider === "ax" && options.axMethod === "gepa") {
    return optimizeTargetPromptWithGEPA(failedRecords, domain);
  }

  const promptConfig = await getDomainPromptConfig(domain);

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
