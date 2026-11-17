/**
 * 目录（ClawHub / skills.sh）读取的回归测试。
 *
 * 全部用注入的假 fetch，不联网。每个用例对应一条硬约束：
 * 端点写死、标识符校验、字节上限、错误码映射、包路径安全。
 */
import assert from "node:assert/strict";
import { readBounded } from "../lib/catalog-common.js";
import { listClawHub, loadClawHubPackage, readClawHubDetail, searchClawHub } from "../lib/catalog-clawhub.js";
import { loadSkillshPackage, readSkillshDetail, searchSkillsh } from "../lib/catalog-skillsh.js";

let passed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}

// 硬保证：整个测试文件不得发起任何真实网络请求。
// 所有用例都注入假 fetchImpl；若哪一处漏传，就会撞到这个陷阱而立即失败。
globalThis.fetch = async () => {
  throw new Error("测试禁止真实网络请求：请注入假 fetchImpl");
};

/** 期望抛错：断言 statusCode + code。 */
async function rejects(fn, statusCode, code, name) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.statusCode, statusCode, `${name}: statusCode 应为 ${statusCode}，实际 ${error.statusCode}`);
    assert.equal(error.code, code, `${name}: code 应为 ${code}，实际 ${error.code}`);
    pass(name);
    return error;
  }
  assert.fail(`${name}: 期望抛错但成功返回`);
}

function bytesResponse(bytes, { status = 200, contentType = "application/octet-stream", headers = {} } = {}) {
  return new Response(bytes, { status, headers: { "content-type": contentType, ...headers } });
}

function jsonResponse(value, options = {}) {
  return bytesResponse(Buffer.from(JSON.stringify(value), "utf8"), { contentType: "application/json", ...options });
}

/** 记录每次调用的 URL 与 init，再交给 handler 决定返回。 */
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 只回应一次，之后抛错（防止隐藏的第二次请求悄悄通过）。 */
function once(response) {
  let used = false;
  return () => {
    assert.equal(used, false, "不该发起第二次请求");
    used = true;
    return response;
  };
}

const SKILL_MD = [
  "---",
  "name: demo-skill",
  "description: 一个用于测试的目录技能说明",
  "---",
  "",
  "# Demo",
  "",
  "正文内容。"
].join("\n");

// ── 1. ClawHub 搜索 ────────────────────────────────────────────────────────

{
  const fetchImpl = recorder(once(jsonResponse({
    results: [
      { ownerHandle: "alice", slug: "skill-one", displayName: "Skill One", summary: "第一个", stats: { downloads: 12, installs: 3, stars: 1 } },
      { owner: { handle: "bob" }, slug: "skill-two", displayName: "", summary: "x".repeat(9000), source: "clawhub" },
      { ownerHandle: "carol", slug: "skill-three", source: "elsewhere" },
      { ownerHandle: "bad/owner", slug: "skill-four" },
      { ownerHandle: "dave", slug: "bad slug" },
      { ownerHandle: "erin", slug: "skill-five" }
    ]
  })));
  const result = await searchClawHub("  hello world  ", { limit: 3 }, fetchImpl);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(
    fetchImpl.calls[0].url,
    "https://clawhub.ai/api/v1/search?q=hello+world&limit=3",
    "搜索端点与 query 参数必须与上游一致"
  );
  assert.equal(fetchImpl.calls[0].init.redirect, "error");
  assert.equal(fetchImpl.calls[0].init.headers.accept, "application/json");
  assert.equal(result.items.length, 3, "limit=3 应截断到 3 条");
  assert.deepEqual(result.items[0], {
    owner: "alice",
    slug: "skill-one",
    displayName: "Skill One",
    summary: "第一个",
    stats: { downloads: 12, installs: 3, stars: 1 }
  });
  // 嵌套 owner.handle 被接受；displayName 空则回落 slug；超长 summary 被丢弃
  assert.equal(result.items[1].owner, "bob");
  assert.equal(result.items[1].displayName, "skill-two");
  assert.equal(result.items[1].summary, "");
  // source 不是 clawhub 的被丢弃，所以第三条来自 erin
  assert.equal(result.items[2].slug, "skill-five");
  pass("ClawHub 搜索：正常返回、丢弃非法 slug/owner 与非 clawhub 来源、按 limit 截断");
}

{
  const fetchImpl = recorder(once(jsonResponse({ results: [] })));
  await rejects(() => searchClawHub("", {}, fetchImpl), 400, "error.catalog.query", "ClawHub 搜索：空 query 抛 400 error.catalog.query");
  await rejects(() => searchClawHub("   ", {}, fetchImpl), 400, "error.catalog.query", "ClawHub 搜索：纯空白 query 抛 400");
  await rejects(() => searchClawHub("x".repeat(101), {}, fetchImpl), 400, "error.catalog.query", "ClawHub 搜索：超过 100 字符抛 400");
  assert.equal(fetchImpl.calls.length, 0, "参数非法时不得发请求");
}

{
  const fetchImpl = recorder(once(jsonResponse({ error: "boom" }, { status: 500 })));
  await rejects(() => searchClawHub("react", {}, fetchImpl), 502, "error.catalog.upstream", "ClawHub 搜索：上游 500 抛 502 error.catalog.upstream");
}

{
  const fetchImpl = recorder(once(bytesResponse(Buffer.from("<html>not json</html>", "utf8"), { contentType: "text/html" })));
  await rejects(() => searchClawHub("react", {}, fetchImpl), 502, "error.catalog.response", "ClawHub 搜索：响应体不是 JSON 抛 502 error.catalog.response");
}

{
  // results 不是数组
  const fetchImpl = recorder(once(jsonResponse({ results: { nope: true } })));
  await rejects(() => searchClawHub("react", {}, fetchImpl), 502, "error.catalog.response", "ClawHub 搜索：results 非数组抛 502");
}

// 默认 limit=100 且端点带 limit=100
{
  const fetchImpl = recorder(once(jsonResponse({ results: [] })));
  await searchClawHub("react", {}, fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://clawhub.ai/api/v1/search?q=react&limit=100");
  pass("ClawHub 搜索：默认 limit=100 并写进 URL");
}

// ── 1b. ClawHub 榜单（端点与 cursor）──────────────────────────────────────

{
  const fetchImpl = recorder(once(jsonResponse({
    items: [{ ownerHandle: "alice", slug: "one" }, { ownerHandle: "bob", slug: "two" }],
    nextCursor: "cursor-2"
  })));
  const page = await listClawHub({ limit: 5, cursor: "abc" }, fetchImpl);
  assert.equal(
    fetchImpl.calls[0].url,
    "https://clawhub.ai/api/v1/skills?sort=downloads&limit=5&cursor=abc",
    "榜端点与 sort/limit/cursor 参数必须与上游一致"
  );
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, "cursor-2");
  pass("ClawHub 榜单：端点/排序/cursor 与上游一致，nextCursor 透传");
}

{
  const fetchImpl = recorder(once(jsonResponse({ items: [], nextCursor: null })));
  const page = await listClawHub({}, fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://clawhub.ai/api/v1/skills?sort=downloads&limit=10");
  assert.equal(page.nextCursor, null);
  pass("ClawHub 榜单：默认 limit=10，nextCursor=null");
}

// ── 2. ClawHub 详情 ───────────────────────────────────────────────────────

{
  const fetchImpl = recorder(once(bytesResponse(Buffer.from(SKILL_MD, "utf8"), { contentType: "text/markdown" })));
  const detail = await readClawHubDetail("some-owner", "my-skill", fetchImpl);
  assert.equal(
    fetchImpl.calls[0].url,
    "https://clawhub.ai/api/v1/skills/my-skill/file?path=SKILL.md&owner=some-owner",
    "详情端点必须与上游 catalogUrls 逐字符一致"
  );
  assert.equal(fetchImpl.calls[0].init.headers.accept, "text/markdown, text/plain");
  assert.equal(detail.name, "demo-skill");
  assert.equal(detail.description, "一个用于测试的目录技能说明");
  assert.equal(detail.origin, "some-owner/my-skill");
  assert.ok(detail.body.includes("# Demo"), "body 应保留 frontmatter 之后的正文");
  assert.ok(!detail.body.startsWith("---"), "body 不应包含 frontmatter");
  assert.ok(detail.descriptionTokens > 0, "descriptionTokens 应为正数");
  assert.ok(detail.bodyTokens > 0, "bodyTokens 应为正数");
  pass("ClawHub 详情：端点正确，SKILL.md 解析出 name/description/body 与 token 估算");
}

{
  const noName = "---\ndescription: 只有描述\n---\n\n正文";
  const fetchImpl = recorder(once(bytesResponse(Buffer.from(noName, "utf8"))));
  await rejects(() => readClawHubDetail("owner", "slug", fetchImpl), 502, "error.catalog.response", "ClawHub 详情：缺少 name 抛 502");
}

{
  const noDescription = "---\nname: only-name\n---\n\n正文";
  const fetchImpl = recorder(once(bytesResponse(Buffer.from(noDescription, "utf8"))));
  await rejects(() => readClawHubDetail("owner", "slug", fetchImpl), 502, "error.catalog.response", "ClawHub 详情：缺少 description 抛 502");
}

{
  const fetchImpl = recorder(once(bytesResponse(Buffer.from(SKILL_MD, "utf8"))));
  await rejects(() => readClawHubDetail("bad owner", "slug", fetchImpl), 400, "error.catalog.identity", "ClawHub 详情：非法 owner 抛 400 error.catalog.identity");
  await rejects(() => readClawHubDetail("owner", "../escape", fetchImpl), 400, "error.catalog.identity", "ClawHub 详情：slug 含 ../ 抛 400");
  assert.equal(fetchImpl.calls.length, 0, "标识非法时不得发请求");
}

{
  const fetchImpl = recorder(once(bytesResponse(Buffer.from("nope"), { status: 404 })));
  await rejects(() => readClawHubDetail("owner", "slug", fetchImpl), 502, "error.catalog.upstream", "ClawHub 详情：上游 404 抛 502 upstream");
}

// ── 3. ClawHub 包 ─────────────────────────────────────────────────────────

{
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0xfe]);
  const fetchImpl = recorder((url) => {
    if (url.startsWith("https://clawhub.ai/api/v1/download")) return bytesResponse(ZIP, { contentType: "application/zip" });
    if (url.startsWith("https://clawhub.ai/api/v1/skills/my-skill/file")) {
      return bytesResponse(Buffer.from(SKILL_MD, "utf8"), { contentType: "text/markdown" });
    }
    throw new Error("未预期的 URL: " + url);
  });
  const pkg = await loadClawHubPackage("some-owner", "my-skill", fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://clawhub.ai/api/v1/download?slug=my-skill&owner=some-owner", "下载端点必须与上游一致");
  assert.equal(fetchImpl.calls[0].init.headers.accept, "application/zip");
  assert.equal(fetchImpl.calls[0].init.redirect, "error");
  assert.equal(pkg.name, "demo-skill");
  const decoded = Buffer.from(pkg.zipBase64, "base64");
  assert.deepEqual([...decoded.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "解码后应是 zip 魔数 PK\\x03\\x04");
  assert.deepEqual(decoded, ZIP, "base64 往返应还原原始字节");
  pass("ClawHub 包：下载端点正确，返回 base64 zip 且解码后是 PK\\x03\\x04");
}

// ── 4. skills.sh 搜索 ─────────────────────────────────────────────────────

{
  const fetchImpl = recorder(once(jsonResponse({
    skills: [
      { id: "vercel/ai/ai-sdk", source: "vercel/ai", skillId: "ai-sdk", name: "AI SDK", installs: 42 },
      { source: "vercel/ai", skillId: "no-id", name: "无 id 时回退拼接", installs: 0 },
      { source: "a/b/c", skillId: "three-parts", name: "三段 source 应丢弃" },
      { source: "justowner", skillId: "one-part", name: "一段 source 应丢弃" },
      { source: "owner/repo", skillId: "bad/skill", name: "非法 skillId 应丢弃" },
      { source: "owner/repo", skillId: "-leading-dash", name: "非法 skillId 应丢弃 2" },
      { source: "owner/repo", skillId: "neg", name: "负数 installs 丢弃", installs: -1 },
      { source: "owner/repo", skillId: "float", name: "小数 installs 丢弃", installs: 1.5 },
      { source: "owner/repo", skillId: "str", name: "字符串 installs 丢弃", installs: "7" },
      { source: "owner/repo", skillId: "dup", name: "重复 id 丢弃" },
      { source: "owner/repo", skillId: "dup", name: "重复 id 丢弃 2" }
    ]
  })));
  const result = await searchSkillsh("  react hooks ", fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://skills.sh/api/search?q=react+hooks", "搜索端点必须与上游一致");
  assert.equal(fetchImpl.calls[0].init.redirect, "error");
  const ids = result.items.map((item) => item.id);
  assert.deepEqual(ids, ["vercel/ai/ai-sdk", "vercel/ai/no-id", "owner/repo/neg", "owner/repo/float", "owner/repo/str", "owner/repo/dup"]);
  assert.equal(result.items[0].installs, 42);
  assert.equal(result.items[1].installs, 0, "installs=0 是合法非负整数，应保留");
  assert.equal(result.items[1].id, "vercel/ai/no-id", "缺 id 时回退为 source/skillId");
  for (const dropped of ["neg", "float", "str"]) {
    const item = result.items.find((entry) => entry.skillId === dropped);
    assert.equal(item.installs, undefined, `${dropped}: installs 非非负整数必须丢弃`);
  }
  assert.equal(result.items.filter((item) => item.skillId === "dup").length, 1, "重复 id 只保留第一条");
  pass("skills.sh 搜索：端点正确，source 必须恰好两段、非法 skillId 丢弃、installs 仅保留非负整数");
}

{
  const fetchImpl = recorder(once(jsonResponse({ skills: [] })));
  await rejects(() => searchSkillsh("", fetchImpl), 400, "error.catalog.query", "skills.sh 搜索：空 query 抛 400");
  await rejects(() => searchSkillsh("x".repeat(101), fetchImpl), 400, "error.catalog.query", "skills.sh 搜索：超过 100 字符抛 400");
  assert.equal(fetchImpl.calls.length, 0);
}

{
  const fetchImpl = recorder(once(jsonResponse({ skills: "nope" })));
  await rejects(() => searchSkillsh("react", fetchImpl), 502, "error.catalog.response", "skills.sh 搜索：skills 非数组抛 502");
}

{
  const fetchImpl = recorder(once(bytesResponse(Buffer.from("not json", "utf8"))));
  await rejects(() => searchSkillsh("react", fetchImpl), 502, "error.catalog.response", "skills.sh 搜索：非 JSON 抛 502");
}

{
  const fetchImpl = recorder(once(jsonResponse({}, { status: 503 })));
  await rejects(() => searchSkillsh("react", fetchImpl), 502, "error.catalog.upstream", "skills.sh 搜索：上游 503 抛 502 upstream");
}

// ── 5. skills.sh 详情与包 ─────────────────────────────────────────────────

{
  const fetchImpl = recorder(once(jsonResponse({
    files: [
      { path: "SKILL.md", contents: SKILL_MD },
      { path: "references/notes.md", contents: "笔记" }
    ]
  })));
  const detail = await readSkillshDetail("owner/repo", "skill-id", fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://skills.sh/api/download/owner/repo/skill-id", "详情端点必须与上游一致（与下载同一端点）");
  assert.equal(detail.name, "demo-skill");
  assert.equal(detail.origin, "owner/repo/skill-id");
  assert.equal(detail.description, "一个用于测试的目录技能说明");
  pass("skills.sh 详情：从 files JSON 的 SKILL.md 解析出 name/description");
}

{
  const fetchImpl = recorder(once(jsonResponse({ files: [{ path: "README.md", contents: "x" }] })));
  await rejects(() => readSkillshDetail("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 详情：包内缺 SKILL.md 抛 502");
}

{
  const fetchImpl = recorder(once(jsonResponse({ files: [] })));
  await rejects(() => readSkillshDetail("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 详情：files 空数组抛 502");
}

{
  const fetchImpl = recorder(once(jsonResponse({
    files: [
      { path: "SKILL.md", contents: SKILL_MD },
      { path: "nested/deep/file.txt", contents: "深层文件" }
    ]
  })));
  const pkg = await loadSkillshPackage("owner/repo", "skill-id", fetchImpl);
  assert.equal(fetchImpl.calls[0].url, "https://skills.sh/api/download/owner/repo/skill-id");
  assert.equal(pkg.name, "demo-skill");
  assert.equal(pkg.entries.length, 2);
  assert.equal(Buffer.from(pkg.entries[0].dataBase64, "base64").toString("utf8"), SKILL_MD, "entries 必须是 base64 编码的内容");
  assert.equal(pkg.entries[1].path, "nested/deep/file.txt");
  assert.equal(Buffer.from(pkg.entries[1].dataBase64, "base64").toString("utf8"), "深层文件");
  pass("skills.sh 包：正常返回 base64 entries 与 SKILL.md 派生的 name");
}

{
  const fetchImpl = recorder(once(jsonResponse({
    files: [
      { path: "../escape.md", contents: "逃逸" },
      { path: "SKILL.md", contents: SKILL_MD }
    ]
  })));
  await rejects(() => loadSkillshPackage("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 包：../ 路径被拒（502）");
}

{
  const fetchImpl = recorder(once(jsonResponse({
    files: [{ path: "a/../../b.md", contents: "x" }, { path: "SKILL.md", contents: SKILL_MD }]
  })));
  await rejects(() => loadSkillshPackage("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 包：路径中段的 .. 也被拒（502）");
}

{
  const fetchImpl = recorder(once(jsonResponse({
    files: [{ path: "/abs/path.md", contents: "x" }, { path: "SKILL.md", contents: SKILL_MD }]
  })));
  await rejects(() => loadSkillshPackage("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 包：绝对路径被拒（502）");
}

{
  const fetchImpl = recorder(once(jsonResponse({ files: [{ path: "README.md", contents: "x" }] })));
  await rejects(() => loadSkillshPackage("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 包：缺 SKILL.md 被拒（502）");
}

{
  const files = [];
  for (let index = 0; index < 1001; index += 1) files.push({ path: `f${index}.md`, contents: "x" });
  files[0] = { path: "SKILL.md", contents: SKILL_MD };
  const fetchImpl = recorder(once(jsonResponse({ files })));
  await rejects(() => loadSkillshPackage("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.response", "skills.sh 包：文件数超过 1000 被拒（502）");
}

{
  const fetchImpl = recorder(once(jsonResponse({ files: [{ path: "SKILL.md", contents: SKILL_MD }] })));
  await rejects(() => loadSkillshPackage("a/b/c", "skill-id", fetchImpl), 400, "error.catalog.identity", "skills.sh 包：source 三段抛 400");
  await rejects(() => loadSkillshPackage("owner/repo", "bad/skill", fetchImpl), 400, "error.catalog.identity", "skills.sh 包：非法 skillId 抛 400");
  await rejects(() => loadSkillshPackage("owner/..", "skill-id", fetchImpl), 400, "error.catalog.identity", "skills.sh 包：source 含 .. 抛 400");
  assert.equal(fetchImpl.calls.length, 0);
}

// ── 6. readBounded 上限与取消 ─────────────────────────────────────────────

{
  const response = bytesResponse(Buffer.from("x".repeat(64), "utf8"));
  await rejects(() => readBounded(response, 10), 502, "error.catalog.response", "readBounded：流式累计超限抛 502 error.catalog.response");
}

{
  const response = bytesResponse(Buffer.from("short", "utf8"), { headers: { "content-length": "999999" } });
  await rejects(() => readBounded(response, 10), 502, "error.catalog.response", "readBounded：content-length 预检超限抛 502");
}

{
  const response = bytesResponse(Buffer.from("ok", "utf8"));
  const controller = new AbortController();
  controller.abort();
  await rejects(() => readBounded(response, 10, controller.signal), 499, "error.catalog.cancelled", "readBounded：已取消的信号抛 499 error.catalog.cancelled");
}

{
  const bytes = Buffer.from("hello bounded", "utf8");
  const read = await readBounded(bytesResponse(bytes), 1024);
  assert.deepEqual(Buffer.from(read), bytes, "未超限时应完整返回字节");
  pass("readBounded：未超限时完整返回");
}

// ── 6b. 取消 vs 超时 vs 网络失败的分类 ───────────────────────────────────

{
  // 调用方取消：fetch 抛 AbortError，但 timeout 未触发 → 499
  const controller = new AbortController();
  const fetchImpl = async () => {
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  await rejects(
    () => readClawHubDetail("owner", "slug", fetchImpl, controller.signal),
    499,
    "error.catalog.cancelled",
    "fetchFixed：调用方取消 → 499（不是 502）"
  );
}

{
  // 网络故障（非 Abort）：→ 502 upstream
  const fetchImpl = async () => { throw new TypeError("fetch failed"); };
  await rejects(() => searchClawHub("react", {}, fetchImpl), 502, "error.catalog.upstream", "fetchFixed：网络故障 → 502 upstream");
}

{
  // 重定向被 redirect:"error" 拒绝时，fetch 抛错 → 502 upstream
  const fetchImpl = async () => { throw new TypeError("redirect mode is error"); };
  await rejects(() => readSkillshDetail("owner/repo", "skill-id", fetchImpl), 502, "error.catalog.upstream", "fetchFixed：重定向被拒 → 502 upstream");
}

// ── 7. 端点与上游 catalogUrls 逐字符一致 ─────────────────────────────────
{
  // 期望值硬编码自上游 catalogUrls 的构造方式，不是从实现里读出来的。
  const expectations = [
    ["https://clawhub.ai/api/v1/skills/my-skill/file?path=SKILL.md&owner=some-owner", (f) => readClawHubDetail("some-owner", "my-skill", f)],
    ["https://clawhub.ai/api/v1/download?slug=my-skill&owner=some-owner", (f) => loadClawHubPackage("some-owner", "my-skill", f)],
    ["https://skills.sh/api/download/owner/repo/skill-id", (f) => readSkillshDetail("owner/repo", "skill-id", f)],
    ["https://skills.sh/api/download/owner/repo/skill-id", (f) => loadSkillshPackage("owner/repo", "skill-id", f)]
  ];
  for (const [expected, run] of expectations) {
    const fetchImpl = recorder((url) => {
      if (url.endsWith("/file?path=SKILL.md&owner=some-owner")) return bytesResponse(Buffer.from(SKILL_MD, "utf8"));
      if (url === "https://clawhub.ai/api/v1/download?slug=my-skill&owner=some-owner") return bytesResponse(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      return jsonResponse({ files: [{ path: "SKILL.md", contents: SKILL_MD }] });
    });
    try {
      await run(fetchImpl);
    } catch (error) {
      // loadClawHubPackage 会连带请求详情，这里只关心首个 URL
      if (!String(error.message).includes("未预期")) throw error;
    }
    assert.equal(fetchImpl.calls[0].url, expected, "端点必须逐字符一致：" + expected);
    assert.equal(fetchImpl.calls[0].init.redirect, "error", "必须禁止重定向：" + expected);
  }
  pass("端点断言：4 个目录端点的 URL 与上游 catalogUrls 逐字符一致");
}

{
  // 特殊字符必须被 encodeURIComponent 编码，不能裸拼进路径
  const fetchImpl = recorder(once(bytesResponse(Buffer.from(SKILL_MD, "utf8"))));
  await readClawHubDetail("own.er_1", "skill.one_2", fetchImpl);
  assert.equal(
    fetchImpl.calls[0].url,
    "https://clawhub.ai/api/v1/skills/skill.one_2/file?path=SKILL.md&owner=own.er_1",
    "合法标识符字符应原样保留（不额外编码）"
  );
  pass("端点断言：合法标识符字符原样保留");
}

console.log(`\n${passed} PASS, 0 FAIL`);
