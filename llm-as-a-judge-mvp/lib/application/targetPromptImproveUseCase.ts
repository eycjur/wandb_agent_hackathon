import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { AppError } from "@/lib/errors";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeTargetPromptWithGEPA } from "@/lib/infrastructure/ax/axGepaTargetOptimizer";
import { optimizeTargetPromptWithFewShot } from "@/lib/infrastructure/ax/axFewShotTargetOptimizer";
import type { EvaluationLogRecord } from "@/lib/infrastructure/evaluationLogStore";
import type {
  ImprovementMethodId,
  LLMProviderId,
  GepaBudgetOverrides,
  FewShotBudgetOverrides,
  LogLevelId
} from "@/lib/contracts/generateEvaluate";
import {
  withLogLevelContext,
  getDebugLogCollector
} from "@/lib/promptOptimizer/logLevel";
import { getWeaveProjectId } from "@/lib/infrastructure/weave/weaveProjectId";
import {
  GEPA_TARGET_FAST_UI_BUDGET,
  mergeGepaBudgetWithOverrides
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";

export interface TargetPromptImprovementResult {
  suggestion: string;
  currentPrompt?: string;
  resultSource: "gepa" | "standard";
  degradedReason?: string;
  /** GEPA 実行時の最適化ログ（resultSource=gepa 時のみ） */
  optimizationLog?: string[];
}

export type TargetPromptImproveOptions = {
  llmProvider?: LLMProviderId;
  improvementMethod?: ImprovementMethodId;
  gepaBudget?: GepaBudgetOverrides;
  fewShotBudget?: FewShotBudgetOverrides;
  logLevel?: LogLevelId;
};

async function generateStandardTargetImprovement(
  failedRecords: EvaluationLogRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
  options: TargetPromptImproveOptions
): Promise<Pick<TargetPromptImprovementResult, "suggestion">> {
  const examplesText = failedRecords
    .map(
      (r, i) =>
        `【例${i + 1}】
- 職務経歴入力: ${r.userInput.slice(0, 200)}${r.userInput.length > 200 ? "..." : ""}
- 生成出力: ${r.generatedOutput.slice(0, 300)}${r.generatedOutput.length > 300 ? "..." : ""}
- Judge 評価: スコア ${r.judgeResult.score}/${r.judgeResult.passThreshold}, 判定 ${r.judgeResult.pass ? "合格" : "不合格"}
- 理由: ${r.judgeResult.reason}`
    )
    .join("\n\n");

  const prompt = `あなたは LLM の生成プロンプトを改善する専門家です。

以下の「現在の生成プロンプト」と「Judge 評価ログ」を分析し、
生成品質を向上させるための改善案を提案してください。

## 現在の生成プロンプト（target.instruction_template）

${promptConfig.targetInstruction}

## 評価ルーブリック（Judge が参照する観点）

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## Judge 評価ログ

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

  const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);
  const suggestion = suggestionMatch?.[1]?.trim() ?? rawResponse;

  return { suggestion };
}

/**
 * Judge の評価結果を分析し、生成プロンプトの改善案を LLM で生成する
 */
export async function generateTargetPromptImprovement(
  failedRecords: EvaluationLogRecord[],
  domain: DomainId,
  options: TargetPromptImproveOptions = {}
): Promise<TargetPromptImprovementResult> {
  if (failedRecords.length === 0) {
    return {
      suggestion:
        "評価データがありません。生成・評価を実行してから再度お試しください。",
      currentPrompt: undefined,
      resultSource: "standard"
    };
  }
  const promptConfig = await getDomainPromptConfig(domain);

  const runWithLogLevel = async <T extends { optimizationLog?: string[] }>(
    fn: () => Promise<T>
  ): Promise<T> => {
    if (!options.logLevel) return fn();
    return withLogLevelContext(options.logLevel, async () => {
      const result = await fn();
      const debugLogs = getDebugLogCollector();
      if (debugLogs?.length && options.logLevel === "debug") {
        const base = result?.optimizationLog ?? [];
        return {
          ...result,
          optimizationLog: [...base, "", "[debug] LLM calls:", ...debugLogs]
        } as T;
      }
      return result;
    });
  };

  if (options.llmProvider === "ax" && options.improvementMethod === "gepa") {
    const budget = mergeGepaBudgetWithOverrides(
      GEPA_TARGET_FAST_UI_BUDGET,
      options.gepaBudget
    );
    const gepaResult = await runWithLogLevel(() =>
      optimizeTargetPromptWithGEPA(failedRecords, domain, budget)
    );
    return {
      ...gepaResult,
      currentPrompt: promptConfig.targetInstruction,
      resultSource: "gepa"
    };
  }

  if (options.llmProvider === "ax" && options.improvementMethod === "fewshot") {
    const fewShotResult = await runWithLogLevel(() =>
      optimizeTargetPromptWithFewShot(
        failedRecords,
        domain,
        options.fewShotBudget
      )
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
    const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);
    return {
      suggestion: suggestionMatch?.[1]?.trim() ?? rawResponse,
      currentPrompt: promptConfig.targetInstruction,
      resultSource: "standard"
    };
  }

  const standardResult = await generateStandardTargetImprovement(
    failedRecords,
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
4. 評価ログを抽出し、課題パターンを分類する。
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
