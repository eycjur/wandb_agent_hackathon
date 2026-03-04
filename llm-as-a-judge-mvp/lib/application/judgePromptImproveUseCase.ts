import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { AppError } from "@/lib/errors";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeJudgePromptWithGEPA } from "@/lib/infrastructure/ax/axGepaOptimizer";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type { AxMethodId, LLMProviderId } from "@/lib/contracts/generateEvaluate";
import { getWeaveProjectId } from "@/lib/infrastructure/weave/weaveProjectId";
import {
  GEPA_JUDGE_FAST_UI_BUDGET,
  GEPA_JUDGE_ULTRA_FAST_BUDGET
} from "@/lib/application/promptOptimization/gepaRuntimeConfig";
import {
  buildGepaCacheKey,
  clearGepaFailureCooldown,
  getCachedGepaResult,
  getGepaFailureCooldownReason,
  setCachedGepaResult,
  setGepaFailureCooldown
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

function mergeStageErrors(errors: unknown[]): string {
  return errors
    .map((error, index) => `stage${index + 1}: ${toDegradedReason(error)}`)
    .join(" | ");
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

function parseImprovementResponse(rawResponse: string): Pick<
  JudgePromptImprovementResult,
  "suggestion" | "analysisSummary"
> {
  const analysisMatch = rawResponse.match(/【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/);
  const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);
  return {
    suggestion: suggestionMatch?.[1]?.trim() ?? rawResponse,
    analysisSummary: analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした"
  };
}

async function generateStandardJudgeImprovement(
  withJudgeResult: HumanFeedbackRecord[],
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
  options: JudgePromptImproveOptions
): Promise<Pick<JudgePromptImprovementResult, "suggestion" | "analysisSummary">> {
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
  return parseImprovementResponse(rawResponse);
}

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

  if (options.llmProvider === "gemini") {
    if (!process.env.WANDB_API_KEY) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "Gemini プロバイダを利用するには WANDB_API_KEY 環境変数を設定してください。"
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
    const mcpPrompt = buildMcpPrompt(domain, projectId, promptConfig);
    const rawResponse = await generateTextForPromptImprovement(mcpPrompt, {
      llmProvider: "gemini"
    });
    const parsed = parseImprovementResponse(rawResponse);
    return {
      ...parsed,
      currentPrompt: promptConfig.judgeInstruction,
      resultSource: "standard"
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

/**
 * W&B MCP Server 経由で Gemini が Weave データを自律取得するためのプロンプトを構築する。
 * データをプロンプトに埋め込む代わりに、MCP ツールでの取得を指示する。
 */
function buildMcpPrompt(
  domain: DomainId,
  projectId: string,
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>
): string {
  return `あなたは LLM の評価プロンプト（Judge）を改善する専門家です。Judgeプロンプトを多数改善した経験があり、LLMの評価傾向と人間の感覚の乖離を体系的に分析することが得意です。
W&B Weave に保存された評価データを MCP ツールで取得・分析し、Judge プロンプトの改善案を提案してください。

## 対象プロジェクト
W&B プロジェクト: **${projectId}**

## 分析手順
1. \`query_weave_traces_tool\` を使い、domain が "${domain}" かつ op_name に "human_feedback_log" を含むトレースを最大100件取得する。
2. 取得されたトレースのキーや値から、どのキーに人間の評価、LLMの評価が記録されているか特定する
3. 取得したトレースのスコア差の分布（最小・最大・平均・中央値・分散）や人間の評価とLLMの評価の違いを分析し、トレースから得られるドメイン知識や一般的な知識、人間・LLMの評価傾向に基づいて「乖離」とみなす基準を自身で設定する。
   その基準と選定理由を分析サマリーに明記する。
4. 抽出したケースを以下の観点で分類・分析する:
   - LLMが過大評価するパターン（どんな出力特徴が高スコアを引き起こすか）
   - LLMが過小評価するパターン（どんな出力特徴が低スコアを引き起こすか）
   - ルーブリックの特定項目への偏重（一部観点だけで総合判断している疑い）
   - LLMが自己矛盾、ハルシネーションしているパターン（そもそも評価LLMが正しく動作していない疑い）
5. 上記のケースを以下の優先順で選ぶ:
   a) 各パターン（過大/過小/偏重）の発生頻度を集計する
   b) 頻度が高いパターンほど多くサンプルを抽出する（例：頻度50% → 5件、30% → 3件、20% → 2件）
   c) 各パターン内では、スコア差が大きいケースを優先する
6. 現在の Judgeプロンプトを分析し、手順5のサンプリング結果のような結果を招いた根本原因を特定する
7. 特定した根本原因と分析結果をもとに、Judgeプロンプトをどのように改善すべきか提案する
8. 改善案を生成・評価する:
   a) 手順7の改善方針に対応する改善案を3つ生成する
   b) 各改善案を、手順5で抽出したサンプリングケースに適用し、同じJudge LLMで再評価する
   c) 各改善案の「スコア差分布の改善度」を比較する（手順3で設定した乖離基準に基づいて、スコア差が縮小したか測定）
   d) 手順3の「乖離」を最も小さくするもの1つを改善案として出力する

## 現在の Judge プロンプト（instruction_template）

${promptConfig.judgeInstruction}

## 現在のルーブリック

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の judge.instruction_template にそのまま反映できる形で書いてください。
何らかの原因で分析サマリーと改善案を回答できない場合は、分析サマリーに理由を書いて、改善案には instruction_template をそのまま出力してください。

【分析サマリー】
（乖離基準とその設定根拠、観点別の乖離パターンを複数列挙して分析する。Judge プロンプトのどの部分が原因かも特定する）

【改善案】
（judge.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;
}
