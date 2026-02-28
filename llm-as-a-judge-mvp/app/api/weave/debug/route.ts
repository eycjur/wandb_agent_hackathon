/**
 * Weave の状態を確認する診断用 API
 * 保存・取得がうまくいかない場合の調査に使用
 */
import { NextResponse } from "next/server";
import { getWeaveProjectId } from "@/lib/infrastructure/weave/weaveProjectId";
import {
  fetchHumanFeedbackFromWeave,
  fetchJudgeLogsFromWeave,
} from "@/lib/infrastructure/weave/weaveQuery";
import { isWeaveConfigured } from "@/lib/infrastructure/weave/weaveClient";

const TRACE_API_BASE = "https://trace.wandb.ai";

/** op_names フィルタなしで全トレースを取得（診断用） */
async function fetchAllTracesRaw(projectId: string, limit = 20): Promise<{ op_names: string[]; total: number }> {
  const apiKey = process.env.WANDB_API_KEY;
  if (!apiKey) return { op_names: [], total: 0 };

  const body = {
    project_id: projectId,
    filter: { trace_roots_only: true },
    limit,
    offset: 0,
    sort_by: [{ field: "started_at", direction: "desc" }],
    include_feedback: false,
  };

  const res = await fetch(`${TRACE_API_BASE}/calls/stream_query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Trace API error: ${res.status} ${await res.text()}`);
  }

  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean);
  const opNames: string[] = [];
  for (const line of lines) {
    try {
      const call = JSON.parse(line) as { op_name?: string };
      if (call.op_name) opNames.push(call.op_name);
    } catch {
      // skip
    }
  }
  return { op_names: opNames, total: lines.length };
}

export async function GET() {
  if (!isWeaveConfigured()) {
    return NextResponse.json({
      configured: false,
      error: "WANDB_API_KEY が設定されていません",
    });
  }

  try {
    const projectId = await getWeaveProjectId();
    if (!projectId) {
      return NextResponse.json({
        configured: true,
        projectId: null,
        error: "project_id の取得に失敗しました（W&B API の defaultEntity 取得失敗の可能性）",
      });
    }

    const [humanFeedbackCount, judgeLogsCount, allTraces] = await Promise.all([
      fetchHumanFeedbackFromWeave({ limit: 100 }).then((r) => r.length),
      fetchJudgeLogsFromWeave({ limit: 100 }).then((r) => r.length),
      fetchAllTracesRaw(projectId).catch((e) => ({ op_names: [] as string[], total: 0, error: String(e) })),
    ]);

    const allTracesData =
      "error" in allTraces
        ? { rawQueryError: allTraces.error }
        : {
            totalTraces: allTraces.total,
            opNamesFound: [...new Set(allTraces.op_names)],
          };

    const countsZero = humanFeedbackCount === 0 && judgeLogsCount === 0;
    let hint: string | undefined;
    if (countsZero) {
      if ("rawQueryError" in allTracesData) {
        hint = `Trace API エラー: ${allTracesData.rawQueryError}`;
      } else if (allTracesData.totalTraces === 0) {
        hint =
          "プロジェクトにトレースが0件です。Generate → Judge → 手動評価の順で実行すると Weave に保存されます。W&B ダッシュボードでプロジェクトが存在するか確認してください。";
      } else {
        const expected = ["judge_log", "human_feedback_log"];
        const found = allTracesData.opNamesFound;
        hint = `トレースは ${allTracesData.totalTraces} 件ありますが、期待する op (${expected.join(", ")}) が見つかりません。実際の op: ${found.join(", ") || "(なし)"}`;
      }
    }

    const judgeLogsWithDomain = await fetchJudgeLogsFromWeave({
      domain: "resume_summary",
      limit: 20
    });

    return NextResponse.json({
      configured: true,
      projectId,
      env: {
        WANDB_PROJECT: process.env.WANDB_PROJECT ?? "(未設定→resume-assistant)",
        WANDB_ENTITY: process.env.WANDB_ENTITY ?? "(未設定→APIから取得)",
      },
      counts: {
        humanFeedback: humanFeedbackCount,
        judgeLogs: judgeLogsCount,
        judgeLogsWithDomainResumeSummary: judgeLogsWithDomain.length,
      },
      diagnostic: allTracesData,
      hint,
    });
  } catch (error) {
    console.error("[/api/weave/debug] error:", error);
    return NextResponse.json(
      {
        configured: true,
        error: error instanceof Error ? error.message : "不明なエラー",
      },
      { status: 500 }
    );
  }
}
