import "server-only";
import { getDomainPromptConfig } from "@/lib/config/domainPromptLoader";

export type ResumeSummaryPromptConfig = Awaited<
  ReturnType<typeof getDomainPromptConfig>
>;

export async function getResumeSummaryPromptConfig(): Promise<ResumeSummaryPromptConfig> {
  return getDomainPromptConfig("resume_summary");
}
