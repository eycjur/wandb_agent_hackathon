import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { AppError } from "@/lib/errors";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeTargetPromptWithGEPA } from "@/lib/infrastructure/ax/axGepaTargetOptimizer";
import { optimizeTargetPromptWithFewShot } from "@/lib/infrastructure/ax/axFewShotTargetOptimizer";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import type { ImprovementMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";
import { getWeaveProjectId } from "@/lib/infrastructure/weave/weaveProjectId";
import {
  GEPA_TARGET_FAST_UI_BUDGET
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";

export interface TargetPromptImprovementResult {
  suggestion: string;
  analysisSummary: string;
  currentPrompt?: string;
  resultSource: "gepa" | "fallback" | "standard";
  degradedReason?: string;
}

export type TargetPromptImproveOptions = {
  llmProvider?: LLMProviderId;
  improvementMethod?: ImprovementMethodId;
};

const GEPA_RECOVERABLE_ERROR_CODES = new Set([
  "PROVIDER_TIMEOUT",
  "PROVIDER_ERROR",
  "PROVIDER_RESPONSE_INVALID"
]);

function canFallbackFromGepa(error: unknown): boolean {
  return error instanceof AppError && GEPA_RECOVERABLE_ERROR_CODES.has(error.code);
}

async function generateStandardTargetImprovement(
  records: EvaluationLogRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
  options: TargetPromptImproveOptions
): Promise<Pick<TargetPromptImprovementResult, "suggestion" | "analysisSummary">> {
  const examplesText = records
    .map(
      (r, i) =>
        `【例${i + 1}】
- 職務経歴入力: ${r.userInput.slice(0, 200)}${r.userInput.length > 200 ? "..." : ""}
- 生成出力: ${r.generatedOutput.slice(0, 300)}${r.generatedOutput.length > 300 ? "..." : ""}
- Judge 評価: スコア ${r.judgeResult.score}/${r.judgeResult.passThreshold}, ${r.judgeResult.pass ? "合格" : "不合格"}
- 理由: ${r.judgeResult.reason}`
    )
    .join("\n\n");

  const prompt = `あなたは LLM の生成プロンプトを改善する専門家です。

以下の「現在の生成プロンプト」と「Judge 評価ケース（合格データを含む）」を分析し、
生成品質を向上させるための改善案を提案してください。

## 現在の生成プロンプト（target.instruction_template）

${promptConfig.targetInstruction}

## 評価ルーブリック（Judge が参照する観点）

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 評価ケース（合格データを含む）

${examplesText}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の target.instruction_template にそのまま反映できる形で書いてください。

【分析サマリー】
（失敗パターンや不足していた観点を2〜3文で）

【改善案】
（target.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;

  const rawResponse = await generateTextForPromptImprovement(prompt, {
    llmProvider: options.llmProvider,
    improvementMethod: options.improvementMethod
  });

  const analysisMatch = rawResponse.match(/【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/);
  const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);

  const analysisSummary = analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした";
  const suggestion = suggestionMatch?.[1]?.trim() ?? rawResponse;

  return { suggestion, analysisSummary };
}

/**
 * 評価結果を分析し、生成プロンプトの改善案を LLM で生成する
 */
export async function generateTargetPromptImprovement(
  records: EvaluationLogRecord[],
  domain: DomainId,
  options: TargetPromptImproveOptions = {}
): Promise<TargetPromptImprovementResult> {
  if (records.length === 0) {
    return {
      suggestion:
        "不合格・低スコアの評価データがありません。生成・評価を実行してから再度お試しください。",
      analysisSummary: "分析対象なし",
      currentPrompt: undefined,
      resultSource: "standard"
    };
  }
  const promptConfig = await getDomainPromptConfig(domain);

  if (options.llmProvider === "ax" && options.improvementMethod === "gepa") {
    try {
      const gepaResult = await optimizeTargetPromptWithGEPA(
        records,
        domain,
        GEPA_TARGET_FAST_UI_BUDGET
      );
      return {
        ...gepaResult,
        currentPrompt: promptConfig.targetInstruction,
        resultSource: "gepa"
      };
    } catch (error) {
      if (!canFallbackFromGepa(error)) {
        throw error;
      }
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        502,
        "PROVIDER_ERROR",
        "GEPA 最適化に失敗しました。",
        error instanceof Error ? error.message : "GEPA failed."
      );
    }
  }

  if (options.llmProvider === "ax" && options.improvementMethod === "fewshot") {
    const fewShotResult = await optimizeTargetPromptWithFewShot(
      records,
      domain
    );
    return {
      ...fewShotResult,
      currentPrompt: promptConfig.targetInstruction,
      resultSource: "standard"
    };
  }

  if (options.improvementMethod === "meta") {
    if (!process.env.WANDB_API_KEY) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "Meta 改善を利用するには WANDB_API_KEY 環境変数を設定してください。"
      );
    }
    const projectId = await getWeaveProjectId();
    if (!projectId) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "Could not resolve W&B project ID. Set WANDB_ENTITY and WANDB_PROJECT env vars."
      );
    }
    const mcpPrompt = buildTargetMcpPrompt(domain, projectId, promptConfig);
    const rawResponse = await generateTextForPromptImprovement(mcpPrompt, {
      llmProvider: "gemini",
      improvementMethod: "meta"
    });
    const analysisMatch = rawResponse.match(/【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/);
    const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);
    return {
      suggestion: suggestionMatch?.[1]?.trim() ?? rawResponse,
      analysisSummary: analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした",
      currentPrompt: promptConfig.targetInstruction,
      resultSource: "standard"
    };
  }

  const standardResult = await generateStandardTargetImprovement(
    records,
    promptConfig,
    options
  );
  return {
    ...standardResult,
    currentPrompt: promptConfig.targetInstruction,
    resultSource: "standard"
  };
}

function buildTargetMcpPrompt(
  domain: DomainId,
  projectId: string,
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>
): string {
  return `あなたは LLM の生成プロンプトを改善する専門家です。W&B Weave の評価ログを MCP ツールで取得・分析し、target プロンプトの改善案を提案してください。

## 対象プロジェクト
W&B プロジェクト: **${projectId}**

## 分析手順
1. \`query_weave_traces_tool\` を使い、まず op_name が "judge_log" / "human_feedback_log" / "feedback" / "generate_evaluate" に関連する最新トレースを最大100件取得する（domain 条件は最初に固定しない）。
2. 取得したトレースの構造を確認し、domain が \`inputs.arg0.domain\` / \`inputs.domain\` / \`attributes.domain\` のどこに入っているかを特定する。
3. 手順2で特定したキーを使って domain="${domain}" のデータだけを抽出する。0件の場合は、domain フィールド欠損としてその旨を分析サマリーに明記する。
4. 不合格ケース（pass=false）や低スコアケースを優先して抽出し、失敗要因を分類する。
5. 失敗要因ごとに、現在の生成プロンプトで不足している指示（構造、具体性、網羅性、根拠提示など）を特定する。
6. 改善案を3つ作成し、抽出ケースへの適合性を比較して最も有効な案を1つ選ぶ。

## 現在の生成プロンプト（target.instruction_template）

${promptConfig.targetInstruction}

## 評価ルーブリック（Judge が参照する観点）

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の target.instruction_template にそのまま反映できる形で書いてください。
何らかの原因で分析サマリーと改善案を回答できない場合は、分析サマリーに理由を書いて、改善案には instruction_template をそのまま出力してください。

【分析サマリー】
（失敗パターン、根本原因、改善方針を簡潔に）

【改善案】
（target.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;
}
