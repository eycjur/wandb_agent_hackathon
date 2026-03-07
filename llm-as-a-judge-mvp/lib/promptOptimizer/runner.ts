/**
 * LLMプログラム実行ヘルパー。
 * 指定した instruction（プロンプト）と入力フィールドで Gemini を呼び出し、
 * 構造化 JSON として出力フィールドを取得する。
 */
import { GoogleGenAI, Type } from "@google/genai";
import type { Example, MetricFn, MetricScores } from "@/lib/promptOptimizer/types";
import { withLimit } from "@/lib/promptOptimizer/concurrencyLimiter";
import { isErrorEnabled } from "@/lib/promptOptimizer/logLevel";

/** メトリクス結果（number | Record）をスカラーに正規化 */
export function normalizeMetricResult(
  raw: number | MetricScores
): { scalar: number; vector?: MetricScores } {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { scalar: Math.max(0, Math.min(1, raw)) };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const vec = raw as MetricScores;
    const vals = Object.values(vec).filter((v) => Number.isFinite(Number(v)));
    const scalar =
      vals.length > 0
        ? vals.reduce((a, b) => a + Number(b), 0) / vals.length
        : 0;
    return {
      scalar: Math.max(0, Math.min(1, scalar)),
      vector: Object.fromEntries(
        Object.entries(vec).map(([k, v]) => [k, Math.max(0, Math.min(1, Number(v)))])
      )
    };
  }
  return { scalar: 0 };
}

/**
 * APIキーから Gemini クライアントを作成する。
 * apiKey 未指定時は GEMINI_API_KEY / GOOGLE_APIKEY 環境変数を使用。
 */
export function createGeminiClient(apiKey?: string): GoogleGenAI {
  const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_APIKEY ?? "";
  if (!key) {
    throw new Error(
      "プロンプト最適化には Gemini APIキーが必要です。" +
        " GEMINI_API_KEY 環境変数を設定するか、options.apiKey に渡してください。"
    );
  }
  return new GoogleGenAI({ apiKey: key });
}

/**
 * プログラムを実行する: instruction（プロンプト）と入力フィールドで LLM を呼び出し、
 * 出力フィールドを JSON として取得する。
 *
 * 出力は Gemini の responseSchema（JSON mode）で構造化されるため、
 * 解析エラーが発生しにくい。
 */
export async function runProgram(
  client: GoogleGenAI,
  model: string,
  instruction: string,
  inputs: Record<string, string>,
  outputFields: string[]
): Promise<Record<string, string>> {
  const inputStr = Object.entries(inputs)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const prompt = `${instruction}\n\nInput:\n${inputStr}`;

  const schema = {
    type: Type.OBJECT,
    properties: Object.fromEntries(outputFields.map((f) => [f, { type: Type.STRING }])),
    required: outputFields,
    propertyOrdering: outputFields
  };

  const response = await withLimit(() =>
    client.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: schema
      }
    })
  );

  const text = response.text ?? "{}";
  try {
    return JSON.parse(text) as Record<string, string>;
  } catch (err) {
    if (isErrorEnabled()) {
      console.warn(
        `[runProgram] JSON パース失敗 — ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return Object.fromEntries(outputFields.map((f) => [f, ""]));
  }
}

/**
 * Teacher モデルでテキストを生成する（反省・プロンプト改善案など）。
 * JSON モードではなく通常のテキスト生成を使用。
 */
export async function runTeacher(
  client: GoogleGenAI,
  model: string,
  prompt: string,
  temperature = 0.7
): Promise<string> {
  const response = await withLimit(() =>
    client.models.generateContent({
      model,
      contents: prompt,
      config: { temperature }
    })
  );
  return response.text?.trim() ?? "";
}

/** プロンプトを全トレーニング例で評価し、平均スコアと各予測を返す。複数例は並列評価。 */
export async function evaluatePrompt(
  client: GoogleGenAI,
  model: string,
  instruction: string,
  task: {
    inputFields: string[];
    outputFields: string[];
    examples: Example[];
    metric: MetricFn;
    initialPrompt?: string;
    cachedPredictions?: Array<Record<string, string> | undefined>;
  }
): Promise<{
  score: number;
  predictions: Array<{
    prediction: Record<string, string>;
    score: number;
    scores?: MetricScores;
    example: Example;
  }>;
  /** 多目的時: 各 example のスコアベクトル */
  scoresPerExample?: MetricScores[];
}> {
  const useCache =
    task.initialPrompt != null &&
    task.cachedPredictions != null &&
    instruction === task.initialPrompt;

  const results = await Promise.all(
    task.examples.map(async (example, i) => {
      try {
        const cached = useCache ? task.cachedPredictions?.[i] : undefined;
        const prediction =
          cached != null
            ? cached
            : await runProgram(
                client,
                model,
                instruction,
                example.inputs,
                task.outputFields
              );
        const raw = await task.metric(prediction, example);
        const { scalar, vector } = normalizeMetricResult(raw);
        return {
          prediction,
          score: scalar,
          scores: vector,
          example
        };
      } catch (err) {
        if (isErrorEnabled()) {
          console.warn(
            `[evaluatePrompt] 例の評価失敗 — ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return {
          prediction: Object.fromEntries(task.outputFields.map((f) => [f, ""])),
          score: 0,
          scores: undefined,
          example
        };
      }
    })
  );

  const total = results.reduce((s, r) => s + r.score, 0);
  const scoresPerExample =
    results.some((r) => r.scores != null) && results.every((r) => r.scores != null)
      ? results.map((r) => r.scores!)
      : undefined;

  return {
    score: results.length > 0 ? total / results.length : 0,
    predictions: results,
    scoresPerExample
  };
}

/** 配列からランダムに n 件サンプリングする */
export function sampleRandom<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return [...arr];
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
