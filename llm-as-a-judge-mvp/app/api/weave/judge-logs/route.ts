/**
 * Weave から Judge 評価ログを取得する API
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchJudgeLogsFromWeave } from "@/lib/infrastructure/weave/weaveQuery";
import { isWeaveConfigured } from "@/lib/infrastructure/weave/weaveClient";

export async function GET(request: NextRequest) {
  if (!isWeaveConfigured()) {
    return NextResponse.json(
      { error: { code: "WEAVE_NOT_CONFIGURED", message: "WANDB_API_KEY が設定されていません。" } },
      { status: 400 }
    );
  }

  const { searchParams } = new URL(request.url);
  const domain = searchParams.get("domain") ?? undefined;
  const limitParam = searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10), 1), 100) : 50;

  const validDomains = ["resume_summary", "resume_detail", "self_pr"] as const;
  const domainFilter =
    domain && validDomains.includes(domain as (typeof validDomains)[number])
      ? (domain as (typeof validDomains)[number])
      : undefined;

  try {
    const records = await fetchJudgeLogsFromWeave({ domain: domainFilter, limit });
    return NextResponse.json({ records }, { status: 200 });
  } catch (error) {
    console.error("[/api/weave/judge-logs] GET error:", error);
    const msg = error instanceof Error ? error.message : "Weave からの取得に失敗しました。";
    return NextResponse.json(
      { error: { code: "INTERNAL_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
