/**
 * dsh-skill-mcp-panel —— ClawHub 目录读取。
 *
 * 端点全部写死在下方常量里，调用方只能给标识符与 limit，不能传 URL。
 * 端点与 query 参数照抄上游 @michengai/dsh-skills-manager 的 catalogUrls：
 *   - 搜索：GET https://clawhub.ai/api/v1/search?q=<query>&limit=<n>
 *   - 榜单：GET https://clawhub.ai/api/v1/skills?sort=downloads&limit=<n>[&cursor=<c>]
 *   - 详情：GET https://clawhub.ai/api/v1/skills/<slug>/file?path=SKILL.md&owner=<owner>
 *   - 下载：GET https://clawhub.ai/api/v1/download?slug=<slug>&owner=<owner>
 *
 * 上游把 owner 字段叫 `ownerHandle`（列表项里也可能是嵌套的 `owner.handle`），
 * 本仓统一暴露为 `owner`，解析时两种形状都接受。
 */

import {
  MAX_ARCHIVE_BYTES,
  MAX_QUERY_LENGTH,
  MAX_TEXT_BYTES,
  catalogError,
  count,
  fetchFixed,
  fetchJson,
  identifier,
  readBounded,
  record,
  requestLimit,
  requireDetail,
  skillDocSummary,
  type CatalogDetail
} from "./catalog-common.js";

const SEARCH_URL = "https://clawhub.ai/api/v1/search";
const LIST_URL = "https://clawhub.ai/api/v1/skills";
const DOWNLOAD_URL = "https://clawhub.ai/api/v1/download";
/** 榜单排序固定为 downloads（上游也只接受这一个值）。 */
const LIST_SORT = "downloads";
const MAX_CURSOR_LENGTH = 4096;
/** 搜索单页最多 100 条。 */
const SEARCH_MAX_LIMIT = 100;
/** 榜单单页最多 10 条。 */
const LIST_MAX_LIMIT = 10;

export interface ClawHubStats {
  downloads?: number;
  installs?: number;
  stars?: number;
}

export interface ClawHubItem {
  owner: string;
  slug: string;
  displayName: string;
  summary: string;
  stats?: ClawHubStats;
}

/** 把一条列表/搜索结果规整成 ClawHubItem；标识符非法则丢弃。 */
function skillItem(value: unknown): ClawHubItem | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  const owner = candidate.ownerHandle ?? record(candidate.owner)?.handle;
  const slug = candidate.slug;
  const ownerId = identifier(owner);
  const slugId = identifier(slug);
  if (!ownerId || !slugId) return undefined;
  const item: ClawHubItem = {
    owner: ownerId,
    slug: slugId,
    displayName:
      typeof candidate.displayName === "string" && candidate.displayName && candidate.displayName.length <= 256
        ? candidate.displayName
        : slugId,
    summary: typeof candidate.summary === "string" && candidate.summary.length <= 8192 ? candidate.summary : ""
  };
  const stats = record(candidate.stats) ?? record(record(record(candidate.native)?.skill)?.stats);
  if (stats) {
    item.stats = {};
    for (const key of ["downloads", "installs", "stars"] as const) {
      const number = count(stats[key]);
      if (number !== undefined) item.stats[key] = number;
    }
  }
  return item;
}

/** 归一化搜索词：去空白，空串或超 100 字符按 400 拒绝。 */
function normalizeQuery(query: string): string {
  const normalized = typeof query === "string" ? query.trim() : "";
  if (!normalized || normalized.length > MAX_QUERY_LENGTH) {
    throw catalogError("目录搜索参数无效", 400, "error.catalog.query");
  }
  return normalized;
}

/** 校验 owner/slug，非法按 400 拒绝（详情与下载共用）。 */
function identity(owner: unknown, slug: unknown): { owner: string; slug: string } {
  const ownerId = identifier(owner);
  const slugId = identifier(slug);
  if (!ownerId || !slugId) throw catalogError("目录技能标识无效", 400, "error.catalog.identity");
  return { owner: ownerId, slug: slugId };
}

/** 固定官方搜索端点，query 仅作为编码后的 q 参数。 */
export async function searchClawHub(
  query: string,
  options: { limit?: number } = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ items: ClawHubItem[] }> {
  const normalized = normalizeQuery(query);
  if (!record(options)) throw catalogError("目录搜索参数无效", 400, "error.catalog.query");
  const limit = requestLimit(options.limit, SEARCH_MAX_LIMIT);
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", normalized);
  url.searchParams.set("limit", String(limit));
  const payload = await fetchJson(url.toString(), fetchImpl, "ClawHub");
  if (!Array.isArray(payload.results)) throw catalogError("目录搜索响应无效", 502, "error.catalog.response");
  const items: ClawHubItem[] = [];
  for (const value of payload.results) {
    const candidate = record(value);
    // 上游语义：显式标注了别的来源就不属于 ClawHub。
    if (!candidate || (candidate.source !== undefined && candidate.source !== "clawhub")) continue;
    const item = skillItem(candidate);
    if (!item) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  return { items };
}

/** 固定官方榜单端点；不接受调用方 URL。 */
export async function listClawHub(
  options: { limit?: number; cursor?: string } = {},
  fetchImpl: typeof fetch = fetch
): Promise<{ items: ClawHubItem[]; nextCursor: string | null }> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw catalogError("目录查询参数无效", 400, "error.catalog.query");
  }
  const limit = requestLimit(options.limit, LIST_MAX_LIMIT);
  if (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor || options.cursor.length > MAX_CURSOR_LENGTH)) {
    throw catalogError("目录分页标识无效", 400, "error.catalog.query");
  }
  const url = new URL(LIST_URL);
  url.searchParams.set("sort", LIST_SORT);
  url.searchParams.set("limit", String(limit));
  if (options.cursor !== undefined) url.searchParams.set("cursor", options.cursor);
  const payload = await fetchJson(url.toString(), fetchImpl, "ClawHub");
  if (!Array.isArray(payload.items)) throw catalogError("目录榜单响应无效", 502, "error.catalog.response");
  const nextCursor = payload.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && (typeof nextCursor !== "string" || nextCursor.length > MAX_CURSOR_LENGTH)) {
    throw catalogError("目录分页响应无效", 502, "error.catalog.response");
  }
  const items: ClawHubItem[] = [];
  for (const value of payload.items) {
    const item = skillItem(value);
    if (!item) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  return { items, nextCursor: typeof nextCursor === "string" && nextCursor ? nextCursor : null };
}

/** 固定详情端点（取 SKILL.md 原文），解析出 name / description / body 与 ≈ token 数。 */
export async function readClawHubDetail(
  owner: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<CatalogDetail> {
  const ids = identity(owner, slug);
  const url = new URL(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(ids.slug)}/file`);
  url.searchParams.set("path", "SKILL.md");
  url.searchParams.set("owner", ids.owner);
  const response = await fetchFixed(url.toString(), fetchImpl, "text/markdown, text/plain", signal);
  const markdown = new TextDecoder().decode(await readBounded(response, MAX_TEXT_BYTES, signal));
  return requireDetail(skillDocSummary(markdown), `${ids.owner}/${ids.slug}`);
}

/** 固定下载端点：取 zip 原文并 base64 编码；技能名取自同目录详情。 */
export async function loadClawHubPackage(
  owner: string,
  slug: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<{ name: string; zipBase64: string }> {
  const ids = identity(owner, slug);
  const url = new URL(DOWNLOAD_URL);
  url.searchParams.set("slug", ids.slug);
  url.searchParams.set("owner", ids.owner);
  const response = await fetchFixed(url.toString(), fetchImpl, "application/zip", signal);
  const bytes = await readBounded(response, MAX_ARCHIVE_BYTES, signal);
  const detail = await readClawHubDetail(ids.owner, ids.slug, fetchImpl, signal);
  return { name: detail.name, zipBase64: Buffer.from(bytes).toString("base64") };
}
