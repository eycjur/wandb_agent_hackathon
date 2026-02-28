import { NextResponse } from "next/server";
import {
  WandbStatusResponseSchema,
  WandbDashboardResponseSchema
} from "@/lib/contracts/generateEvaluate";
import {
  isWeaveConfigured,
  getWeaveDashboardUrl
} from "@/lib/infrastructure/weave/weaveLogger";

export async function GET() {
  const configured = isWeaveConfigured();
  const dashboardUrl = getWeaveDashboardUrl();
  const response = WandbStatusResponseSchema.parse({ configured });
  const fullResponse = WandbDashboardResponseSchema.parse({
    ...response,
    dashboardUrl: configured ? dashboardUrl : null
  });
  return NextResponse.json(fullResponse, { status: 200 });
}
