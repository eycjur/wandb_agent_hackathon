declare module "weave" {
  export function init(projectName: string): Promise<WeaveClient>;
  export function op<T>(fn: (arg: T) => T | Promise<T>, options?: { name?: string }): (arg: T) => Promise<T>;

  export class StringPrompt {
    constructor(params: { content: string; name?: string; description?: string });
    content: string;
    format(values?: Record<string, unknown>): string;
  }

  interface WeaveClient {
    publish(obj: unknown, objId?: string): Promise<{ uri: string }>;
    get(ref: unknown): Promise<unknown>;
  }
}
