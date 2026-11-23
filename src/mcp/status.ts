/**
 * dsh-skill-mcp-panel —— MCP 行运行时状态读取（loader entry + 工具计数）。
 */
const FIBER_PHASE: Record<number, string | null> = {
  0: "pending",
  1: "loading",
  2: "active",
  3: "failed",
  4: null,
  5: "unloading"
};

export type McpFiberPhase = "pending" | "loading" | "active" | "failed" | "unloading" | null;

export function fiberPhaseOf(state: number | undefined | null): McpFiberPhase {
  if (typeof state !== "number") return null;
  const phase = FIBER_PHASE[state];
  return phase === undefined ? null : phase as McpFiberPhase;
}

export function getLoaderEntry(ctx: any, id: string): any | undefined {
  const loader = (ctx as any).loader;
  if (loader === undefined || typeof loader.entries !== "function") return undefined;
  // Patch rows use IDs local to the profile include; loader entry.id can include its ancestry.
  const profileTree = ctx.fiber?.entry?.parent?.tree;
  let localEntry;
  for (const entry of loader.entries()) {
    const inProfile = profileTree !== undefined && entry.parent?.tree === profileTree;
    if (entry.id === id && (inProfile || profileTree === undefined || id.includes(":"))) return entry;
    if (inProfile && entry.options?.id === id) localEntry = entry;
  }
  return localEntry;
}

export function loaderEntries(ctx: any): any[] {
  const loader = (ctx as any).loader;
  if (loader === undefined || typeof loader.entries !== "function") return [];
  return [...loader.entries()];
}

export function mcpToolCount(ctx: any, serverName: string): number {
  const tools = (ctx as any).tools;
  if (tools === undefined || typeof tools.schemas !== "function") return 0;
  const prefix = `mcp__${serverName}__`;
  const schemas = tools.schemas();
  return Array.isArray(schemas) ? schemas.filter((schema) => typeof schema?.name === "string" && schema.name.startsWith(prefix)).length : 0;
}

const delay = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * 写入 patch 后轮询 loader，直到 entry 满足 predicate 或超时。
 * 默认 3s；每 200ms 查一次。
 */
export async function waitForLoaderState(ctx: any, id: string, predicate: (entry: any) => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entry = getLoaderEntry(ctx, id);
    if (entry !== undefined && predicate(entry)) return true;
    if (entry === undefined && predicate(undefined)) return true;
    await delay(200);
  }
  return false;
}
