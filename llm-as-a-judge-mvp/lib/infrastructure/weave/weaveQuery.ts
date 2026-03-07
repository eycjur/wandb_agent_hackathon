/**
 * Weave Trace API からログを取得する
 * https://docs.wandb.ai/weave/cookbooks/weave_via_service_api
 *
 * 注意: project_id は weave.init() と一致させる必要がある。
 * weave SDK は entity/project 形式を使用するため、getWeaveProjectId() で取得する。
 */

import type { EvaluationSourceType } from "@/lib/contracts/generateEvaluate";
import { getWeaveProjectId } from "./weaveProjectId";

const TRACE_API_BASE = "https://trace.wandb.ai";

export type HumanFeedbackFromWeave = {
  id: string;
  domain: string;
  humanScore: number;
  judgeScore?: number;
  agreeWithJudge?: boolean;
  humanComment?: string;
  userInput?: string;
  generatedOutput?: string;
  sourceType?: EvaluationSourceType;
  judgeResult?: { score: number; reason: string; pass: boolean };
  createdAt: string;
};

/**
 * human_feedback_log のトレースを Weave から取得
 * query を使うと空になることがあるため、全トレース取得後にクライアント側でフィルタ
 */
export async function fetchHumanFeedbackFromWeave(options: {
  domain?: string;
  limit?: number;
}): Promise<HumanFeedbackFromWeave[]> {
  const apiKey = process.env.WANDB_API_KEY;
  if (!apiKey) {
    throw new Error("WANDB_API_KEY is not set.");
  }

  const projectId = await getWeaveProjectId();
  if (!projectId) {
    throw new Error("Weave project_id is not available.");
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const body = {
    project_id: projectId,
    filter: { trace_roots_only: true },
    limit: Math.min(limit * 5, 100),
    offset: 0,
    sort_by: [{ field: "started_at", direction: "desc" }],
    include_feedback: false
  };

  try {
    const res = await fetch(`${TRACE_API_BASE}/calls/stream_query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("[weaveQuery] stream_query failed:", res.status, errText);
      throw new Error(`Trace API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    const results: HumanFeedbackFromWeave[] = [];

    for (const line of lines) {
      try {
        const call = JSON.parse(line) as {
          id?: string;
          op_name?: string;
          inputs?: Record<string, unknown> | string;
          started_at?: string;
        };
        if (!call.op_name?.includes("human_feedback_log")) continue;
        const rawInputs = typeof call.inputs === "object" && call.inputs !== null
          ? (call.inputs as Record<string, unknown>)
          : {};
        // Weave は op の第1引数を inputs.arg0 に格納する
        const inputs = (rawInputs.arg0 as Record<string, unknown>) ?? rawInputs;
        const domain = String(inputs.domain ?? "resume_summary");
        if (options.domain && domain !== options.domain) continue;

        if (results.length >= limit) break;

        results.push({
          id: call.id ?? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          domain: domain || "resume_summary",
          humanScore: Number(inputs.humanScore ?? 0),
          judgeScore: inputs.judgeScore != null ? Number(inputs.judgeScore) : undefined,
          agreeWithJudge: inputs.agreeWithJudge as boolean | undefined,
          humanComment: inputs.humanComment as string | undefined,
          userInput: inputs.userInput as string | undefined,
          generatedOutput: inputs.generatedOutput as string | undefined,
          sourceType: inputs.sourceType as EvaluationSourceType | undefined,
          judgeResult: inputs.judgeResult as { score: number; reason: string; pass: boolean } | undefined,
          createdAt: call.started_at ?? new Date().toISOString()
        });
      } catch {
        // skip malformed lines
      }
    }

    return results;
  } catch (err) {
    console.warn("[weaveQuery] fetchHumanFeedbackFromWeave error:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export type JudgeLogFromWeave = {
  id: string;
  domain: string;
  score: number;
  pass: boolean;
  passThreshold: number;
  rubricVersion: number;
  userInput?: string;
  generatedOutput?: string;
  sourceType?: EvaluationSourceType;
  reason?: string;
  createdAt: string;
};

/** 同じ入力（userInput + generatedOutput）で人間評価と Judge 評価をマージ */
function mergeJudgeIntoHumanFeedback(
  humanRecords: HumanFeedbackFromWeave[],
  judgeRecords: JudgeLogFromWeave[]
): HumanFeedbackFromWeave[] {
  const judgeByKey = new Map<string, JudgeLogFromWeave>();
  for (const j of judgeRecords) {
    const key = `${j.domain}\0${(j.userInput ?? "").trim()}\0${(j.generatedOutput ?? "").trim()}`;
    const existing = judgeByKey.get(key);
    if (!existing || new Date(j.createdAt) > new Date(existing.createdAt)) {
      judgeByKey.set(key, j);
    }
  }
  return humanRecords.map((h) => {
    const key = `${h.domain}\0${(h.userInput ?? "").trim()}\0${(h.generatedOutput ?? "").trim()}`;
    const judge = judgeByKey.get(key);
    if (!judge || h.judgeResult != null) return h;
    return {
      ...h,
      judgeResult: {
        score: judge.score,
        reason: judge.reason ?? "",
        pass: judge.pass
      },
      judgeScore: judge.score
    };
  });
}

/**
 * 人間評価を取得し、同じ入力の Judge 評価とマージして返す
 */
export async function fetchHumanFeedbackWithJudgeMerged(options: {
  domain?: string;
  limit?: number;
}): Promise<HumanFeedbackFromWeave[]> {
  const [humanRecords, judgeRecords] = await Promise.all([
    fetchHumanFeedbackFromWeave(options),
    fetchJudgeLogsFromWeave({
      ...options,
      limit: (options.limit ?? 50) * 2
    })
  ]);
  return mergeJudgeIntoHumanFeedback(humanRecords, judgeRecords);
}

/**
 * judge_log のトレースを Weave から取得
 * query を使うと空になることがあるため、全トレース取得後にクライアント側でフィルタ
 */
export async function fetchJudgeLogsFromWeave(options: {
  domain?: string;
  limit?: number;
}): Promise<JudgeLogFromWeave[]> {
  const apiKey = process.env.WANDB_API_KEY;
  if (!apiKey) {
    throw new Error("WANDB_API_KEY is not set.");
  }

  const projectId = await getWeaveProjectId();
  if (!projectId) {
    throw new Error("Weave project_id is not available.");
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);

  const body = {
    project_id: projectId,
    filter: { trace_roots_only: true },
    limit: Math.min(limit * 5, 100),
    offset: 0,
    sort_by: [{ field: "started_at", direction: "desc" }],
    include_feedback: false
  };

  try {
    const res = await fetch(`${TRACE_API_BASE}/calls/stream_query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("[weaveQuery] stream_query judge_log failed:", res.status, errText);
      throw new Error(`Trace API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const text = await res.text();
    const lines = text.trim().split("\n").filter(Boolean);
    const results: JudgeLogFromWeave[] = [];

    for (const line of lines) {
      try {
        const call = JSON.parse(line) as {
          id?: string;
          op_name?: string;
          inputs?: Record<string, unknown> | string;
          started_at?: string;
        };
        if (!call.op_name?.includes("judge_log")) continue;
        const rawInputs = typeof call.inputs === "object" && call.inputs !== null
          ? (call.inputs as Record<string, unknown>)
          : {};
        // Weave は op の第1引数を inputs.arg0 に格納する
        const inputs = (rawInputs.arg0 as Record<string, unknown>) ?? rawInputs;

        const domain = String(inputs.domain ?? "resume_summary");
        if (options.domain && domain !== options.domain) continue;

        if (results.length >= limit) break;

        results.push({
          id: call.id ?? `jl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          domain: domain || "resume_summary",
          score: Number(inputs.score ?? 0),
          pass: Boolean(inputs.pass),
          passThreshold: Number(inputs.passThreshold ?? 4),
          rubricVersion: Number(inputs.rubricVersion ?? 1),
          userInput: inputs.userInput as string | undefined,
          generatedOutput: inputs.generatedOutput as string | undefined,
          sourceType: inputs.sourceType as EvaluationSourceType | undefined,
          reason: inputs.reason as string | undefined,
          createdAt: call.started_at ?? new Date().toISOString()
        });
      } catch {
        // skip malformed lines
      }
    }

    return results;
  } catch (err) {
    console.warn("[weaveQuery] fetchJudgeLogsFromWeave error:", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
