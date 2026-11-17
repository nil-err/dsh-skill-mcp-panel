/**
 * dsh-skill-mcp-panel —— 目录（ClawHub / skills.sh）读取的共用工具。
 *
 * 移植自 @michengai/dsh-skills-manager 的 catalog-skill.ts，并按本仓约定拆分：
 *   - 本文件只放与具体目录无关的部分：错误构造、有界读取、固定 URL 抓取、
 *     标识符 / 路径校验、SKILL.md frontmatter 宽松解析、files JSON 校验。
 *   - 两个目录各自的端点拼装与导出签名在 catalog-clawhub.ts / catalog-skillsh.ts。
 *
 * 安全约束（两个目录一致）：
 *   - 端点写死在本仓代码里，调用方永远不能传 URL；
 *   - 所有响应都有字节上限与超时，错误一律带 statusCode + code。
 */
import { estimateTokens, truncateCatalogDescription } from "./token-count.js";
/** 文本类响应（详情 markdown / 搜索结果 JSON）上限。 */
export const MAX_TEXT_BYTES = 1 << 20;
/** 归档类响应（zip / files JSON 包）上限。 */
export const MAX_ARCHIVE_BYTES = 32 << 20;
/** 单个技能包最多文件数。 */
export const MAX_FILES = 1000;
/** 搜索词长度上限。 */
export const MAX_QUERY_LENGTH = 100;
/** 目录抓取的固定超时（毫秒）。 */
export const CATALOG_TIMEOUT_MS = 120_000;
/** owner / slug / skillId / repo 段：字母数字开头，只含字母数字与 `._-`，最长 128。 */
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** 技能包内的相对路径：不允许绝对路径、不允许任何 `..` 段。 */
export const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
/** 带 HTTP 语义的错误：statusCode + code 供上层直接映射响应。 */
export function catalogError(message, statusCode, code) {
    return Object.assign(new Error(message), { statusCode, code });
}
/** 只接受普通对象（非 null / 非数组）。 */
export function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** 只接受非负安全整数。 */
export function count(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
/** 标识符校验：不合法返回 undefined。 */
export function identifier(value) {
    return typeof value === "string" && IDENTIFIER.test(value) ? value : undefined;
}
/** 去空白后仍有内容且不超长的字符串；否则 undefined。 */
export function boundedString(value, maxLength) {
    if (typeof value !== "string")
        return undefined;
    const text = value.trim();
    return text && text.length <= maxLength ? text : undefined;
}
/** limit 参数校验：默认取 max，允许 1..max 的整数（也接受纯数字字符串）。 */
export function requestLimit(value, max) {
    if (value === undefined)
        return max;
    const number = typeof value === "string" && /^[0-9]{1,3}$/.test(value) ? Number(value) : value;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) {
        throw catalogError("目录查询 limit 无效", 400, "error.catalog.query");
    }
    return number;
}
function cancelledError() {
    return catalogError("目录技能请求已取消", 499, "error.catalog.cancelled");
}
function isTagged(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
/**
 * 有界读取响应体：先按 content-length 预检，再流式累计上限。
 * 超限取消 body 并抛 error.catalog.response(502)；被调用方取消则抛 error.catalog.cancelled(499)。
 */
export async function readBounded(response, limit, signal) {
    if (signal?.aborted) {
        await response.body?.cancel().catch(() => undefined);
        throw cancelledError();
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw catalogError("目录技能内容过大", 502, "error.catalog.response");
    }
    const reader = response.body?.getReader();
    if (!reader)
        return new Uint8Array();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            if (signal?.aborted)
                throw cancelledError();
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > limit)
                throw catalogError("目录技能内容过大", 502, "error.catalog.response");
            chunks.push(value);
        }
    }
    catch (error) {
        await reader.cancel().catch(() => undefined);
        if (signal?.aborted || isTagged(error, "error.catalog.cancelled"))
            throw cancelledError();
        if (isTagged(error, "error.catalog.response"))
            throw error;
        throw catalogError("目录技能响应无效或读取中断", 502, "error.catalog.response");
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
}
/** 合并“固定超时 + 调用方取消信号”；两者任一触发都会中止请求。 */
function combinedSignal(signal) {
    const timeoutSignal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
    if (!signal)
        return { combined: timeoutSignal, timeout: timeoutSignal };
    if (typeof AbortSignal.any === "function")
        return { combined: AbortSignal.any([timeoutSignal, signal]), timeout: timeoutSignal };
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    const onTimeout = () => controller.abort(timeoutSignal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });
    return { combined: controller.signal, timeout: timeoutSignal };
}
/**
 * 固定 URL 抓取：禁止重定向、固定超时；网络失败或非 2xx 一律 error.catalog.upstream(502)。
 *
 * 取消与超时必须分开归类：调用方取消 → 499，自身 120s 超时 → 502 upstream。
 * （合并信号里拿不到“是谁先 abort”，所以要把 timeout 信号单独留一份。）
 */
export async function fetchFixed(url, fetchImpl, accept, signal) {
    if (signal?.aborted)
        throw cancelledError();
    const { combined, timeout } = combinedSignal(signal);
    let response;
    try {
        response = await fetchImpl(url, { headers: { accept }, redirect: "error", signal: combined });
    }
    catch (error) {
        const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        if (signal?.aborted || (aborted && !timeout.aborted))
            throw cancelledError();
        throw catalogError("目录技能暂时无法读取", 502, "error.catalog.upstream");
    }
    if (!response.ok)
        throw catalogError("目录技能暂时无法读取", 502, "error.catalog.upstream");
    return response;
}
/** 抓取并解析 JSON 对象响应；label 用于错误文案（ClawHub / skills.sh）。 */
export async function fetchJson(url, fetchImpl, label, signal) {
    const response = await fetchFixed(url, fetchImpl, "application/json", signal);
    let payload;
    try {
        payload = JSON.parse(Buffer.from(await readBounded(response, MAX_TEXT_BYTES, signal)).toString("utf8"));
    }
    catch (error) {
        if (isTagged(error, "error.catalog.cancelled"))
            throw error;
        if (isTagged(error, "error.catalog.response"))
            throw error;
        throw catalogError(`${label} 响应不是有效 JSON`, 502, "error.catalog.response");
    }
    const object = record(payload);
    if (!object)
        throw catalogError(`${label} 响应结构无效`, 502, "error.catalog.response");
    return object;
}
/**
 * 校验 skills.sh 的 `files` JSON 包（保留上游校验：数组、每项 path+contents 字符串、数量上限）。
 */
export function parseFilesJson(bytes) {
    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        throw catalogError("目录技能返回了无效 JSON", 502, "error.catalog.response");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw catalogError("目录技能文件无效", 502, "error.catalog.response");
    }
    const files = payload.files;
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) {
        throw catalogError("目录技能文件无效或过多", 502, "error.catalog.response");
    }
    for (const file of files) {
        if (!file || typeof file !== "object" || Array.isArray(file) || typeof file.path !== "string" || typeof file.contents !== "string") {
            throw catalogError("目录技能文件无效", 502, "error.catalog.response");
        }
    }
    return { files: files };
}
// ── SKILL.md frontmatter 宽松解析（对齐上游 parseSkillDoc）──────────────────
//
// 与 src/skill-files.ts 的 parseFrontmatter 有意不同：那个用于本地技能列表，
// 会把不合 kebab-case 的名字判为「不是技能」；目录里的技能名是第三方数据，
// 不能因为命名风格不同就整条 502，因此这里保留上游的宽松语义。
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
/** 解 YAML 标量：双引号走 JSON、单引号去引号并把 '' 还原成 '。 */
function decodeYamlScalar(value) {
    const s = String(value == null ? "" : value).trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
        try {
            const parsed = JSON.parse(s);
            if (typeof parsed === "string")
                return parsed;
        }
        catch {
            /* 保留无法解析的原始内容 */
        }
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'")
        return s.slice(1, -1).replace(/''/g, "'");
    return s;
}
/**
 * 解析 SKILL.md 的 frontmatter，返回 name / description / body。
 * 只识别顶层 `key: value`，支持 `>` / `|` 块标量（缩进嵌套字段不进 map）。
 */
export function parseCatalogSkillDoc(text) {
    const src = stripBom(String(text));
    const lines = src.split(/\r?\n/);
    const map = Object.create(null);
    let body = src;
    if (lines.length > 0 && lines[0].trim() === "---") {
        let end = -1;
        for (let i = 1; i < lines.length; i++) {
            if (lines[i].trim() === "---") {
                end = i;
                break;
            }
        }
        if (end >= 0) {
            for (let i = 1; i < end; i++) {
                const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
                if (!match)
                    continue;
                const block = /^([>|])(?:([1-9])[-+]?|[-+]([1-9])?)?\s*$/.exec(match[2]);
                if (block) {
                    const content = [];
                    while (i + 1 < end && (/^\s/.test(lines[i + 1]) || lines[i + 1] === "")) {
                        i++;
                        content.push(lines[i]);
                    }
                    const explicitIndentation = block[2] || block[3];
                    const indentation = explicitIndentation
                        ? Number(explicitIndentation)
                        : content
                            .filter((line) => line.trim() !== "")
                            .reduce((min, line) => Math.min(min, (/^\s*/.exec(line) || [""])[0].length), Infinity);
                    const normalized = content.map((line) => Number.isFinite(indentation) ? line.slice(Math.min(indentation, line.length)) : line);
                    map[match[1]] =
                        block[1] === ">"
                            ? normalized.join(" ").replace(/\s+/g, " ").trim()
                            : explicitIndentation
                                ? normalized.join("\n").replace(/^\n+|\n+$/g, "")
                                : normalized.join("\n").trim();
                }
                else {
                    map[match[1]] = decodeYamlScalar(match[2]);
                }
            }
            body = lines.slice(end + 1).join("\n");
        }
    }
    return { name: map.name, description: map.description, body };
}
/** 把 markdown 摘要成目录详情字段（含 ≈ token 估算），与上游 skillDocSummary 同形。 */
export function skillDocSummary(markdown) {
    const parsed = parseCatalogSkillDoc(markdown);
    const name = parsed.name?.trim();
    const description = parsed.description?.trim();
    return {
        name,
        description,
        body: parsed.body,
        descriptionTokens: estimateTokens(truncateCatalogDescription(description || "")),
        bodyTokens: estimateTokens(parsed.body)
    };
}
/** 详情必需字段：name 与 description 缺一不可，否则视为目录数据无效。 */
export function requireDetail(summary, origin) {
    if (!summary.name || !summary.description) {
        throw catalogError("目录技能说明无效", 502, "error.catalog.response");
    }
    return {
        name: summary.name,
        description: summary.description,
        body: summary.body,
        origin,
        descriptionTokens: summary.descriptionTokens,
        bodyTokens: summary.bodyTokens
    };
}
