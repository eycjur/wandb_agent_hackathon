import type { DomainId } from "@/lib/config/domainPromptLoader";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";
import { generateTextForPromptImprovement } from "@/lib/infrastructure/promptImproveGenerator";
import { optimizeJudgePromptWithGEPA } from "@/lib/infrastructure/ax/axGepaOptimizer";
import type { HumanFeedbackRecord } from "@/lib/infrastructure/humanFeedbackStore";
import type {
  AxMethodId,
  LLMProviderId,
} from "@/lib/contracts/generateEvaluate";
import { getWeaveProjectId } from "@/lib/infrastructure/weave/weaveProjectId";
import { AppError } from "@/lib/errors";

export interface JudgePromptImprovementResult {
  suggestion: string;
  analysisSummary: string;
  currentPrompt?: string;
}

export type JudgePromptImproveOptions = {
  llmProvider?: LLMProviderId;
  axMethod?: AxMethodId;
};

/**
 * 人間評価に基づいて Judge プロンプトの改善案を LLM で生成する
 * 乖離が大きいケース（Judge と人間のスコア差が 2 以上）を優先的に分析
 */
export async function generateJudgePromptImprovement(
  feedbackRecords: HumanFeedbackRecord[],
  domain: DomainId,
  options: JudgePromptImproveOptions = {},
): Promise<JudgePromptImprovementResult> {
  const withJudgeResult = feedbackRecords.filter((r) => r.judgeResult != null);
  const promptConfig = await getDomainPromptConfig(domain);

  if (withJudgeResult.length === 0) {
    return {
      suggestion:
        "Judge 評価済みの人間評価データがありません。自動評価を実行したうえで人間評価を蓄積してから再度お試しください。",
      analysisSummary: "分析対象なし",
      currentPrompt: promptConfig.judgeInstruction,
    };
  }

  if (options.llmProvider === "ax" && options.axMethod === "gepa") {
    const gepaResult = await optimizeJudgePromptWithGEPA(
      feedbackRecords,
      domain,
    );
    return { ...gepaResult, currentPrompt: promptConfig.judgeInstruction };
  }

  // gemini + WANDB_API_KEY → W&B MCP Server 経由で Gemini が Weave データを自律取得
  if (options.llmProvider === "gemini" && process.env.WANDB_API_KEY) {
    const projectId = await getWeaveProjectId();
    if (!projectId) {
      throw new AppError(
        500,
        "CONFIG_ERROR",
        "サーバー設定エラーが発生しました。",
        "Could not resolve W&B project ID. Set WANDB_ENTITY and WANDB_PROJECT env vars.",
      );
    }
    const mcpPrompt = buildMcpPrompt(domain, projectId, promptConfig);
    const rawResponse = await generateTextForPromptImprovement(mcpPrompt, {
      llmProvider: "gemini",
    });
    const analysisMatch = rawResponse.match(
      /【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/,
    );
    const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);
    return {
      suggestion: suggestionMatch?.[1]?.trim() ?? rawResponse,
      analysisSummary:
        analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした",
      currentPrompt: promptConfig.judgeInstruction,
    };
  }

  // 乖離が大きいケースを優先（スコア差が2以上）
  const withDiscrepancy = withJudgeResult
    .map((r) => ({
      ...r,
      scoreDiff: Math.abs(
        r.humanScore - (r.judgeResult?.score ?? r.humanScore),
      ),
    }))
    .filter((r) => r.scoreDiff >= 2)
    .sort((a, b) => b.scoreDiff - a.scoreDiff);

  const recordsToAnalyze =
    withDiscrepancy.length >= 3
      ? withDiscrepancy.slice(0, 5)
      : withJudgeResult.slice(0, 5);

  const examplesText = recordsToAnalyze
    .map(
      (r, i) =>
        `【例${i + 1}】
- 生成出力: ${r.generatedOutput.slice(0, 300)}${r.generatedOutput.length > 300 ? "..." : ""}
- Judge 評価: スコア ${r.judgeResult!.score}, 理由: ${r.judgeResult!.reason}
- 人間評価: スコア ${r.humanScore}${r.humanComment ? `, コメント: ${r.humanComment}` : ""}`,
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
    axMethod: options.axMethod,
  });

  // 【分析サマリー】と【改善案】をパース
  const analysisMatch = rawResponse.match(
    /【分析サマリー】\s*([\s\S]*?)(?=【改善案】|$)/,
  );
  const suggestionMatch = rawResponse.match(/【改善案】\s*([\s\S]*?)$/);

  const analysisSummary =
    analysisMatch?.[1]?.trim() ?? "分析結果を抽出できませんでした";
  const suggestion = suggestionMatch?.[1]?.trim() ?? rawResponse;

  return {
    suggestion,
    analysisSummary,
    currentPrompt: promptConfig.judgeInstruction,
  };
}

/**
 * W&B MCP Server 経由で Gemini が Weave データを自律取得するためのプロンプトを構築する。
 * データをプロンプトに埋め込む代わりに、MCP ツールでの取得を指示する。
 */
function buildMcpPrompt(
  domain: DomainId,
  projectId: string,
  promptConfig: Awaited<ReturnType<typeof getDomainPromptConfig>>,
): string {
  return `あなたは LLM の評価プロンプト（Judge）を改善する専門家です。
W&B Weave に保存された評価データを MCP ツールで取得・分析し、Judge プロンプトの改善案を提案してください。

## 対象プロジェクト
W&B プロジェクト: **${projectId}**

## 手順
1. \`query_weave_traces_tool\` を使い、op_name に "human_feedback_log" を含むトレースを取得する。取得されたデータを「人間の評価」と呼ぶ・
2. \`query_weave_traces_tool\` を使い、op_name に "judge_log" を含むトレースを取得する・取得されたデータを「LLMの評価」と呼ぶ。
3. domain が "${domain}" のデータに絞り込む
4. 「人間の評価」と「LLMの評価」が乖離しているものを特定する
5. 乖離パターンを分析し、以下の現在の Judge プロンプトと照合して改善案を提案する

## 現在の Judge プロンプト（instruction_template）

${promptConfig.judgeInstruction}

## 現在のルーブリック

${promptConfig.judgeRubric.map((r) => `- ${r}`).join("\n")}

## 出力形式

以下の形式で回答してください。改善案は具体的に、YAML の judge.instruction_template にそのまま反映できる形で書いてください。

【分析サマリー】
（乖離のパターンや原因を2〜3文で）

【改善案】
（judge.instruction_template の改善版テキスト。コードブロックは使わず、そのままコピペできる形で）`;
}
