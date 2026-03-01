/**
 * Weave 用の project_id を取得
 * weave.init() と Trace API クエリで同じ project_id を使う必要がある。
 * weave SDK は entity/project 形式を使用するため、取得時も同じ形式にする。
 */

const WANDB_GRAPHQL = "https://api.wandb.ai/graphql";
const VIEWER_QUERY = `
query DefaultEntity {
  viewer {
    username
    defaultEntity {
      name
    }
  }
}
`;

let cachedProjectId: string | null = null;

async function fetchDefaultEntity(apiKey: string): Promise<string> {
  const res = await fetch(WANDB_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
    },
    body: JSON.stringify({ query: VIEWER_QUERY }),
  });
  if (!res.ok) {
    throw new Error(`W&B API error: ${res.status} ${await res.text()}`);
  }
  const result = await res.json();
  const entity =
    result?.data?.viewer?.defaultEntity?.name ?? result?.data?.viewer?.username;
  if (!entity) {
    throw new Error("Could not get default entity from W&B API");
  }
  return entity;
}

/**
 * Weave の Trace API クエリで使用する project_id を取得する。
 * WANDB_ENTITY が設定されていれば entity/project、未設定なら W&B API から
 * デフォルト entity を取得して entity/project 形式で返す。
 */
export async function getWeaveProjectId(): Promise<string | null> {
  const apiKey = process.env.WANDB_API_KEY;
  if (!apiKey) return null;

  if (cachedProjectId) return cachedProjectId;

  const project = process.env.WANDB_PROJECT ?? "resume-assistant";
  const entityEnv = process.env.WANDB_ENTITY?.trim();

  if (entityEnv) {
    cachedProjectId = `${entityEnv}/${project}`;
    return cachedProjectId;
  }

  try {
    const entity = await fetchDefaultEntity(apiKey);
    cachedProjectId = `${entity}/${project}`;
    return cachedProjectId;
  } catch (err) {
    console.warn("[weaveProjectId] fetchDefaultEntity failed:", err);
    return null;
  }
}

/**
 * 同期的に project_id を返す（WANDB_ENTITY が設定されている場合のみ）。
 * 未設定の場合は null を返し、呼び出し側で getWeaveProjectId() を使う必要がある。
 */
export function getWeaveProjectIdSync(): string | null {
  const apiKey = process.env.WANDB_API_KEY;
  if (!apiKey) return null;

  const project = process.env.WANDB_PROJECT ?? "resume-assistant";
  const entityEnv = process.env.WANDB_ENTITY?.trim();

  if (entityEnv) {
    return `${entityEnv}/${project}`;
  }
  return null;
}
