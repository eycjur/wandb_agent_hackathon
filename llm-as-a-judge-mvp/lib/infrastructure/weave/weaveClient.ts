/**
 * Weave クライアント（共有）
 * WANDB_API_KEY が設定され、weave パッケージがインストールされている場合に動作。
 *
 * project_id は Trace API クエリと一致させるため、getWeaveProjectId を使用する。
 * WANDB_ENTITY 未設定時は weave.init(project) に任せ、SDK がデフォルト entity を解決する。
 */

import { getWeaveProjectId } from "./weaveProjectId";

export type WeaveClient = {
  publish: (obj: unknown, objId?: string) => Promise<{ uri: string }>;
  get: (ref: unknown) => Promise<{ content?: string } | null>;
};

let weaveClient: WeaveClient | null | undefined = undefined;

export async function getWeaveClient(): Promise<WeaveClient | null> {
  if (!process.env.WANDB_API_KEY) return null;
  if (weaveClient !== undefined) return weaveClient;
  try {
    const projectId = await getWeaveProjectId();
    if (!projectId) {
      weaveClient = null;
      return null;
    }
    const weave = await import(/* @vite-ignore */ "weave");
    const client = await weave.init(projectId);
    weaveClient = client as WeaveClient;
    return weaveClient;
  } catch {
    weaveClient = null;
    return null;
  }
}

export function isWeaveConfigured(): boolean {
  return Boolean(process.env.WANDB_API_KEY);
}

/**
 * W&B ダッシュボードの URL
 */
export function getWeaveDashboardUrl(): string | null {
  if (!process.env.WANDB_API_KEY) return null;
  const project = process.env.WANDB_PROJECT ?? "resume-assistant";
  const entity = process.env.WANDB_ENTITY?.trim();
  if (entity) {
    return `https://wandb.ai/${encodeURIComponent(entity)}/${encodeURIComponent(project)}`;
  }
  return "https://wandb.ai";
}
