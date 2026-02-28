import "server-only";

import type { DomainId, DomainPromptConfig } from "./domainPromptLoader.types";
import { DOMAIN_PROMPT_CONFIGS } from "./domainPromptConfigs";
import { fetchPromptFromWeave, isWeavePromptConfigured } from "@/lib/infrastructure/weave/promptManager";

export type { DomainId, DomainPromptConfig } from "./domainPromptLoader.types";

export const SUPPORTED_DOMAINS: DomainId[] = [
  "resume_summary",
  "resume_detail",
  "self_pr"
];

const CACHE_TTL_MS = 30_000; // Weave 取得時は 30 秒キャッシュ（改善反映後すぐ使えるように）
const cache = new Map<
  DomainId,
  { config: DomainPromptConfig; expiresAt: number; fromWeave: boolean }
>();

export async function getDomainPromptConfig(domain: DomainId): Promise<DomainPromptConfig> {
  const now = Date.now();
  const cached = cache.get(domain);
  if (cached && (cached.expiresAt > now || !cached.fromWeave)) {
    return cached.config;
  }

  const baseConfig = DOMAIN_PROMPT_CONFIGS[domain];
  if (!baseConfig) {
    throw new Error(`Unknown domain: ${domain}`);
  }

  let config: DomainPromptConfig = { ...baseConfig };
  let fromWeave = false;

  if (isWeavePromptConfigured()) {
    const [judgeFromWeave, targetFromWeave] = await Promise.all([
      fetchPromptFromWeave(domain, "judge"),
      fetchPromptFromWeave(domain, "target")
    ]);
    if (judgeFromWeave) {
      config = { ...config, judgeInstruction: judgeFromWeave };
      fromWeave = true;
    }
    if (targetFromWeave) {
      config = { ...config, targetInstruction: targetFromWeave };
      fromWeave = true;
    }
  }

  cache.set(domain, {
    config,
    expiresAt: fromWeave ? now + CACHE_TTL_MS : Number.POSITIVE_INFINITY,
    fromWeave
  });

  // Weave にプロンプトを publish（非同期、失敗しても無視）
  if (!fromWeave) {
    import("@/lib/infrastructure/weave/promptManager")
      .then(({ publishPromptToWeave }) =>
        publishPromptToWeave({
          domain: baseConfig.domain,
          rubricVersion: baseConfig.rubricVersion,
          targetInstruction: baseConfig.targetInstruction,
          judgeInstruction: baseConfig.judgeInstruction
        })
      )
      .catch((err) => console.warn("[domainPromptLoader] weave publish skipped:", err));
  }

  return config;
}
