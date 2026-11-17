/**
 * dsh-skill-mcp-panel —— skills.sh 目录读取。
 *
 * 端点写死：
 *   - 搜索：GET https://skills.sh/api/search?q=<query>
 *   - 详情：GET https://skills.sh/api/download/<owner>/<repo>/<skillId>
 *   - 下载：同上（skills.sh 的详情与下载是同一个端点，返回 files JSON）
 *
 * `source` 必须是恰好两段 `owner/repo`，`skillId` 是单段标识符；
 * 三段或带 `..` 的输入一律 400，绝不拼进 URL 路径。
 */
import { MAX_ARCHIVE_BYTES, MAX_FILES, MAX_QUERY_LENGTH, MAX_TEXT_BYTES, SAFE_PATH, boundedString, catalogError, count, fetchFixed, identifier, parseFilesJson, readBounded, record, requireDetail, skillDocSummary } from "./catalog-common.js";
const SEARCH_URL = "https://skills.sh/api/search";
const DOWNLOAD_PREFIX = "https://skills.sh/api/download";
/** 搜索最多返回多少条（上游 MAX_RESULTS）。 */
const MAX_RESULTS = 100;
/** source 必须是恰好 `owner/repo` 两段合法标识符。 */
function sourceParts(source) {
    if (typeof source !== "string")
        return undefined;
    const parts = source.split("/");
    if (parts.length !== 2)
        return undefined;
    const [owner, repo] = parts;
    if (!identifier(owner) || !identifier(repo))
        return undefined;
    return { owner, repo, source };
}
/** 校验 source + skillId，非法按 400 拒绝。 */
function identity(source, skillId) {
    const parts = sourceParts(source);
    const id = identifier(skillId);
    if (!parts || !id)
        throw catalogError("目录技能标识无效", 400, "error.catalog.identity");
    return { ...parts, skillId: id };
}
/** skills.sh 的下载端点（详情与下载共用）。 */
function downloadUrl(owner, repo, skillId) {
    return `${DOWNLOAD_PREFIX}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(skillId)}`;
}
/** 通过固定的官方搜索端点查询目录，只返回受校验字段。 */
export async function searchSkillsh(query, fetchImpl = fetch) {
    const normalized = typeof query === "string" ? query.trim() : "";
    if (!normalized || normalized.length > MAX_QUERY_LENGTH) {
        throw catalogError("搜索词不能为空且不能超过 100 个字符", 400, "error.catalog.query");
    }
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", normalized);
    const response = await fetchFixed(url.toString(), fetchImpl, "application/json");
    let payload;
    try {
        payload = JSON.parse(Buffer.from(await readBounded(response, MAX_TEXT_BYTES)).toString("utf8"));
    }
    catch (error) {
        if (error instanceof Error && "code" in error)
            throw error;
        throw catalogError("skills.sh 返回了无效的搜索结果", 502, "error.catalog.response");
    }
    const object = record(payload);
    if (!object || !Array.isArray(object.skills)) {
        throw catalogError("skills.sh 返回了无效的搜索结果", 502, "error.catalog.response");
    }
    const items = [];
    const seen = new Set();
    for (const candidate of object.skills) {
        const entry = record(candidate);
        if (!entry)
            continue;
        const parts = sourceParts(entry.source);
        const skillId = identifier(entry.skillId);
        const name = boundedString(entry.name, 256);
        const id = boundedString(entry.id, 768) || (parts && skillId ? `${parts.source}/${skillId}` : undefined);
        if (!parts || !skillId || !name || !id || seen.has(id))
            continue;
        const item = { id, source: parts.source, skillId, name };
        const installs = count(entry.installs);
        if (installs !== undefined)
            item.installs = installs;
        items.push(item);
        seen.add(id);
        if (items.length >= MAX_RESULTS)
            break;
    }
    return { items };
}
/** 固定详情端点：取 files JSON，用其中的 SKILL.md 解析 name / description / body。 */
export async function readSkillshDetail(source, skillId, fetchImpl = fetch, signal) {
    const ids = identity(source, skillId);
    const response = await fetchFixed(downloadUrl(ids.owner, ids.repo, ids.skillId), fetchImpl, "application/json", signal);
    const payload = parseFilesJson(await readBounded(response, MAX_ARCHIVE_BYTES, signal));
    const document = payload.files.find((file) => file.path === "SKILL.md");
    if (!document)
        throw catalogError("目录技能说明无效", 502, "error.catalog.response");
    return requireDetail(skillDocSummary(document.contents), `${ids.source}/${ids.skillId}`);
}
/**
 * 固定下载端点：把 files JSON 展开成 base64 条目。
 * 每个路径必须是安全相对路径，且包里必须含 SKILL.md。
 */
export async function loadSkillshPackage(source, skillId, fetchImpl = fetch, signal) {
    const ids = identity(source, skillId);
    const response = await fetchFixed(downloadUrl(ids.owner, ids.repo, ids.skillId), fetchImpl, "application/json", signal);
    const payload = parseFilesJson(await readBounded(response, MAX_ARCHIVE_BYTES, signal));
    if (!Array.isArray(payload.files) || !payload.files.length || payload.files.length > MAX_FILES) {
        throw catalogError("目录技能文件无效或过多", 502, "error.catalog.response");
    }
    const entries = payload.files.map((file) => {
        if (typeof file.path !== "string" || !SAFE_PATH.test(file.path) || typeof file.contents !== "string") {
            throw catalogError("目录技能包含非法文件路径", 502, "error.catalog.response");
        }
        return { path: file.path, dataBase64: Buffer.from(file.contents, "utf8").toString("base64") };
    });
    const document = entries.find((entry) => entry.path === "SKILL.md");
    if (!document)
        throw catalogError("目录技能缺少 SKILL.md", 502, "error.catalog.response");
    const detail = skillDocSummary(Buffer.from(document.dataBase64, "base64").toString("utf8"));
    if (!detail.name)
        throw catalogError("目录技能说明无效", 502, "error.catalog.response");
    return { name: detail.name, entries };
}
