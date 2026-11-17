/**
 * dsh-skill-mcp-panel —— 技能来源归属（provenance）解析。
 *
 * 回答技能列表里每一行的「这个技能是从哪来的」。判定链按证据强度从高到低：
 *
 *   1. **本插件的安装记录**（`discover.json` 的 installs）
 *      —— 我们自己装的一定最准：repo / clawhub / skillsh 三类都带原始标识。
 *   2. **`.skills-lock.json`**（技能根下的锁文件，来自 skills.sh / skills CLI 生态）
 *      —— 按技能名查条目，取 `source`（owner/repo 或 URL）与 `skillPath`。
 *   3. **`_skillhub_meta.json` / `_meta.json`**（目录安装器写的市场元数据）
 *      —— 技能目录内的文件，取 `source` 字段。
 *   4. 都没有 → 返回 undefined，UI 只显示「来自哪个技能根」（D S H / 公共 Agent /
 *      工作区），这一层由技能根自身的 source 字段回答，不需要额外证据。
 *
 * 为什么不去猜：目录名、路径前缀都不可靠（用户可以把任何东西放进 skills/）。
 * 拿不到证据就不标来源，比标错更有用。
 */
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillOrigin } from "./discover-types.js";

/** 锁文件 / 元数据文件体积上限（正常只有几 KB）。 */
const MAX_JSON_BYTES = 1024 * 1024;

/** 缓存条目与总量上限：技能根可能很多，避免无界增长。 */
const MAX_CACHE_ENTRIES = 2048;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

interface Fingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
}

interface CachedJson {
  fingerprint: Fingerprint;
  value: unknown;
  bytes: number;
}

const jsonCache = new Map<string, CachedJson>();
let cacheBytes = 0;

function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;
}

function evict(file: string): void {
  const cached = jsonCache.get(file);
  if (cached !== undefined) {
    cacheBytes -= cached.bytes;
    jsonCache.delete(file);
  }
}

/**
 * 带指纹缓存的 JSON 读取。
 *
 * 为什么不用简单缓存：技能目录被外部工具改动很常见，缓存必须能自失效。
 * 这里在打开前后各取一次 stat，只有「打开期间文件没变」才写缓存——读到写一半的
 * 文件（另一个进程正在安装）不会污染缓存。
 */
async function readJson(file: string): Promise<unknown> {
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    evict(file);
    throw error;
  }
  if (!info.isFile() || info.size > MAX_JSON_BYTES) {
    evict(file);
    return null;
  }
  const cached = jsonCache.get(file);
  if (cached !== undefined && sameFile(cached.fingerprint, info)) {
    // 命中即刷新 LRU 顺序。
    jsonCache.delete(file);
    jsonCache.set(file, cached);
    return cached.value;
  }
  evict(file);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_JSON_BYTES) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > opened.size) return null;
    let value: unknown;
    try {
      value = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch {
      value = null;
    }
    const after = await handle.stat();
    const current = await stat(file).catch(() => null);
    if (current !== null && sameFile(opened, after) && sameFile(after, current)) {
      evict(file);
      while (jsonCache.size >= MAX_CACHE_ENTRIES || cacheBytes + length > MAX_CACHE_BYTES) {
        const oldest = jsonCache.keys().next().value;
        if (oldest === undefined) break;
        evict(oldest);
      }
      jsonCache.set(file, { fingerprint: after, value, bytes: length });
      cacheBytes += length;
    }
    return value;
  } finally {
    await handle.close();
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 锁文件索引：技能名 → 条目。 */
interface LockIndex {
  entries: Record<string, unknown>;
}

/** 读技能根下的 `.skills-lock.json`；缺失或损坏返回 null。 */
async function readLockIndex(rootPath: string): Promise<LockIndex | null> {
  try {
    const parsed = asObject(await readJson(join(rootPath, ".skills-lock.json")));
    const entries = asObject(parsed?.skills ?? parsed);
    return entries !== null ? { entries } : null;
  } catch {
    return null;
  }
}

/**
 * 从来源字符串里抽出规范化标识。
 * 支持 `owner/repo` 简写与完整 URL；拒绝带凭据、查询串、片段的地址。
 *
 * 关于 `githubShorthand`：只有当来源被**显式标注**为 GitHub（`sourceType: "github"`）
 * 或来源是完整 https URL 时，才生成可点击的 github.com 链接。未标注的 `owner/repo`
 * 仍然给出 label（用户能看懂是谁的仓库），但不编造 URL——它可能来自 GitLab、
 * 自建 Git 服务或任何别的地方，猜成 GitHub 会给出错误链接。
 */
function sourceInfo(raw: unknown, githubShorthand: boolean): { repo: string; label: string; url?: string } | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "" || value.length > 2048 || /[\x00-\x1f]/.test(value)) return null;

  // GitHub 简写：owner/repo
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    const repo = value.replace(/\.git$/i, "");
    if (repo.split("/").some((part) => part === "." || part === "..")) return null;
    return githubShorthand ? { repo, label: repo, url: "https://github.com/" + repo } : { repo, label: repo };
  }

  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
      return null;
    }
    const normalized = parsed.href.replace(/\/$/, "").replace(/\.git$/i, "");
    const repo = parsed.hostname + parsed.pathname.replace(/\/$/, "").replace(/\.git$/i, "");
    return { repo, label: repo, ...(parsed.protocol === "https:" ? { url: normalized } : {}) };
  } catch {
    return null;
  }
}

/** 锁文件条目 → 来源。 */
function fromLockEntry(value: unknown): SkillOrigin | undefined {
  const entry = asObject(value);
  if (entry === null) return undefined;
  const info = sourceInfo(entry.source, entry.sourceType === "github");
  if (info === null) return undefined;
  return { kind: "lock", label: info.repo, ...(info.url === undefined ? {} : { url: info.url }) };
}

/** 市场元数据（技能目录内的 `_skillhub_meta.json` / `_meta.json`）→ 来源。 */
async function fromMarketMeta(skillDir: string): Promise<SkillOrigin | undefined> {
  for (const name of ["_skillhub_meta.json", "_meta.json"]) {
    try {
      const metadata = asObject(await readJson(join(skillDir, name)));
      if (metadata === null) continue;
      const info = sourceInfo(metadata.source, metadata.sourceType === "github");
      if (info !== null) return { kind: "market", label: info.repo };
    } catch {
      // 试下一个证据文件
    }
  }
  return undefined;
}

/** 解析一次的输入。 */
export interface ProvenanceInput {
  /** 技能所在根目录的绝对路径。 */
  rootPath: string;
  /** 技能条目文件路径（目录束为 `<dir>/SKILL.md`）。 */
  skillPath: string;
  /** 技能名（与锁文件条目键比对）。 */
  name: string;
  /** frontmatter 里声明的名字（与 name 可能不同）。 */
  declaredName?: string;
  /** 本插件安装记录给出的来源（最高优先级，已由调用方查好）。 */
  installOrigin?: SkillOrigin;
}

/**
 * 解析一个技能的来源归属。
 *
 * 顺序：安装记录 → 锁文件 → 市场元数据 → 放弃。
 * 任何一步都不抛错：来源是「锦上添花」的信息，不能因为它让技能列表失败。
 */
export async function resolveProvenance(input: ProvenanceInput, lock?: LockIndex | null): Promise<SkillOrigin | undefined> {
  if (input.installOrigin !== undefined) return input.installOrigin;

  const index = lock === undefined ? await readLockIndex(input.rootPath) : lock;
  if (index !== null) {
    const entry = Object.hasOwn(index.entries, input.name)
      ? index.entries[input.name]
      : input.declaredName !== undefined && Object.hasOwn(index.entries, input.declaredName)
        ? index.entries[input.declaredName]
        : undefined;
    const resolved = fromLockEntry(entry);
    if (resolved !== undefined) return resolved;
  }

  // 目录束：元数据在技能目录里；单文件技能：在根目录里（与根级锁文件同一位置，
  // 此时 market meta 基本不会有，直接跳过）。
  const dir = dirname(input.skillPath);
  if (input.rootPath !== "" && dir === input.rootPath) return undefined;
  return fromMarketMeta(dir);
}

/**
 * 一条待解析来源的技能行（本插件技能列表的投影）。
 *
 * `rootPath` / `filePath` 由调用方从文件扫描结果里带过来：注册表行与文件行
 * 都需要知道「这个技能的文件实际在哪」，否则读不到锁文件与市场元数据。
 */
export interface ProvenanceRow {
  name: string;
  declaredName?: string;
  /** 技能所在根目录。 */
  rootPath?: string;
  /** 技能条目文件路径（目录束为 `<dir>/SKILL.md`）。 */
  filePath?: string;
  /** 本插件安装记录已给出的来源（最高优先级）。 */
  installOrigin?: SkillOrigin;
  /** 解析结果写回这里。 */
  origin?: SkillOrigin;
}

/**
 * 批量解析来源归属：同一根只读一次锁文件，并发度受控（16）。
 *
 * 缺失 `rootPath` 或 `filePath` 的行直接跳过（例如插件随包提供的技能、运行时
 * 注册的技能——它们没有磁盘上的技能根，谈「从哪装的」没有意义）。
 */
export async function attachProvenance(rows: ProvenanceRow[]): Promise<ProvenanceRow[]> {
  const lockByRoot = new Map<string, LockIndex | null>();
  const eligible = rows.filter((row) => typeof row.rootPath === "string" && row.rootPath !== "" && typeof row.filePath === "string" && row.filePath !== "");
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, eligible.length) }, async () => {
      while (next < eligible.length) {
        const row = eligible[next++];
        const rootPath = row.rootPath as string;
        try {
          if (!lockByRoot.has(rootPath)) lockByRoot.set(rootPath, await readLockIndex(rootPath));
          const origin = await resolveProvenance(
            {
              rootPath,
              skillPath: row.filePath as string,
              name: row.name,
              declaredName: row.declaredName,
              installOrigin: row.installOrigin
            },
            lockByRoot.get(rootPath) ?? null
          );
          if (origin !== undefined) row.origin = origin;
        } catch {
          // 来源解析失败不影响列表
        }
      }
    })
  );
  return rows;
}
