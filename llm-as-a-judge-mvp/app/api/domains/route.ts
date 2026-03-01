import { NextResponse } from "next/server";
import { SUPPORTED_DOMAINS } from "@/lib/config/domainPromptLoader";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import { DomainsListResponseSchema } from "@/lib/contracts/generateEvaluate";

const DOMAIN_LABELS: Record<DomainId, string> = {
  resume_summary: "職務要約",
  resume_detail: "職務経歴（詳細）",
  self_pr: "自己PR"
};

export async function GET() {
  const domains = SUPPORTED_DOMAINS.map((id) => ({
    id,
    label: DOMAIN_LABELS[id]
  }));

  const response = DomainsListResponseSchema.parse({ domains });
  return NextResponse.json(response, { status: 200 });
}
