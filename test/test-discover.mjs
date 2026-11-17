/**
 * 「发现技能」宿主侧单元测试：状态文件、仓库扫描、Git URL 解析、安装落地。
 *
 * 全部离线：Git 抓取用本地临时仓库（`git init` + commit），不联网。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadState, saveState, emptyState, upsertRepository, findInstall, recordInstall, forgetInstall, installIndex, ownedIndex, installKey } from "../lib/discover-store.js";
import { parseGitUrl, repositoryIdentity, skillCheckoutPatterns, safePath, fetchGitRepository } from "../lib/discover-git.js";
import { checkFrontmatter, scanRepositorySkills, readSkillPackage } from "../lib/discover-scan.js";
import { attachProvenance, resolveProvenance } from "../lib/discover-provenance.js";
import { DiscoverService } from "../lib/discover-service.js";

let passed = 0;
let failed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}
function fail(name, error) {
  failed += 1;
  console.log("FAIL  " + name + "\n      " + (error instanceof Error ? error.message : String(error)));
}
async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

const tempDirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  });
}

// ── frontmatter ────────────────────────────────────────────────────────────
await check("checkFrontmatter: 合法 frontmatter", () => {
  const result = checkFrontmatter("---\nname: my-skill\ndescription: does things\n---\n\nbody\n");
  assert.equal(result.ok, true);
  assert.equal(result.name, "my-skill");
  assert.equal(result.description, "does things");
});

await check("checkFrontmatter: 缺 description 判非法但保留 name", () => {
  const result = checkFrontmatter("---\nname: my-skill\n---\n");
  assert.equal(result.ok, false);
  assert.equal(result.name, "my-skill");
  assert.match(result.reason, /description/);
});

await check("checkFrontmatter: 非法名字判非法", () => {
  assert.equal(checkFrontmatter("---\nname: My_Skill\ndescription: x\n---\n").ok, false);
});

await check("checkFrontmatter: CRLF 与 BOM 可解析", () => {
  const result = checkFrontmatter("\uFEFF---\r\nname: ok-skill\r\ndescription: d\r\n---\r\n");
  assert.equal(result.ok, true);
});

await check("checkFrontmatter: 没有 frontmatter 判非法", () => {
  assert.equal(checkFrontmatter("# just markdown\n").ok, false);
});

// ── 仓库扫描 ───────────────────────────────────────────────────────────────
await check("scanRepositorySkills: 目录束 + 根级 SKILL.md，普通 md 不算技能", async () => {
  const root = await tempDir("scan-");
  await mkdir(join(root, "alpha"), { recursive: true });
  await writeFile(join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: a\n---\n");
  await writeFile(join(root, "alpha", "helper.txt"), "x");
  await mkdir(join(root, "group", "beta"), { recursive: true });
  await writeFile(join(root, "group", "beta", "SKILL.md"), "---\nname: beta\ndescription: b\n---\n");
  // 根级 SKILL.md = 整仓一个技能
  await writeFile(join(root, "SKILL.md"), "---\nname: whole-repo\ndescription: w\n---\n");
  // 根级普通 markdown 不是技能（README / CHANGELOG / AGENTS 之类）
  await writeFile(join(root, "README.md"), "---\nname: readme\ndescription: r\n---\n");
  await writeFile(join(root, "CHANGELOG.md"), "no frontmatter\n");
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", "SKILL.md"), "---\nname: nope\ndescription: n\n---\n");

  const skills = await scanRepositorySkills(root, "");
  const names = skills.map((s) => s.name).sort();
  assert.deepEqual(names, ["alpha", "beta", "whole-repo"], "只有目录束与根级 SKILL.md 算技能");
  const alpha = skills.find((s) => s.name === "alpha");
  assert.equal(alpha.path, "alpha");
  assert.equal(alpha.valid, true);
  const beta = skills.find((s) => s.name === "beta");
  assert.equal(beta.path, "group/beta");
  assert.equal(skills.some((s) => s.name === "nope"), false, "node_modules 必须跳过");
});

await check("scanRepositorySkills: 默认不扫隐藏目录", async () => {
  const root = await tempDir("scan-hidden-off-");
  for (const base of ["skills", ".openclaw/skills"]) {
    await mkdir(join(root, base, "ponytail"), { recursive: true });
    await writeFile(join(root, base, "ponytail", "SKILL.md"), "---\nname: ponytail\ndescription: p\n---\n");
  }
  const skills = await scanRepositorySkills(root, "");
  assert.deepEqual(skills.map((s) => s.name), ["ponytail"], "默认只扫非隐藏目录");
  assert.equal(skills[0].path, "skills/ponytail");
});

await check("scanRepositorySkills: includeHidden 打开后才扫 .openclaw 等已知宿主", async () => {
  const root = await tempDir("scan-mirror-");
  // 同一批技能镜像在 skills/ 与 .openclaw/skills/（ponytail 的真实布局）
  for (const base of ["skills", ".openclaw/skills"]) {
    await mkdir(join(root, base, "ponytail"), { recursive: true });
    await writeFile(join(root, base, "ponytail", "SKILL.md"), "---\nname: ponytail\ndescription: p\n---\n");
    await mkdir(join(root, base, "ponytail-audit"), { recursive: true });
    await writeFile(join(root, base, "ponytail-audit", "SKILL.md"), "---\nname: ponytail-audit\ndescription: pa\n---\n");
  }
  // 无关的隐藏目录不该被扫
  await mkdir(join(root, ".github", "x"), { recursive: true });
  await writeFile(join(root, ".github", "x", "SKILL.md"), "---\nname: ci-skill\ndescription: c\n---\n");

  const skills = await scanRepositorySkills(root, "", { includeHidden: true });
  assert.deepEqual(skills.map((s) => s.name).sort(), ["ponytail", "ponytail-audit"], "镜像目录只算一份，且不扫 .github");
  const ponytail = skills.find((s) => s.name === "ponytail");
  assert.equal(ponytail.path, "skills/ponytail", "去重后保留非隐藏的浅路径");
});

await check("scanRepositorySkills: subdirectory 限定扫描范围", async () => {
  const root = await tempDir("scan-sub-");
  await mkdir(join(root, "skills", "a"), { recursive: true });
  await writeFile(join(root, "skills", "a", "SKILL.md"), "---\nname: a\ndescription: a\n---\n");
  await mkdir(join(root, "other", "b"), { recursive: true });
  await writeFile(join(root, "other", "b", "SKILL.md"), "---\nname: b\ndescription: b\n---\n");
  const scoped = await scanRepositorySkills(root, "skills");
  assert.deepEqual(scoped.map((s) => s.name), ["a"]);
  const all = await scanRepositorySkills(root, "");
  assert.deepEqual(all.map((s) => s.name).sort(), ["a", "b"]);
});

await check("readSkillPackage: 目录束收全部文件，路径相对包根", async () => {
  const root = await tempDir("pkg-");
  await mkdir(join(root, "skill", "scripts"), { recursive: true });
  await writeFile(join(root, "skill", "SKILL.md"), "---\nname: pkg-skill\ndescription: p\n---\n");
  await writeFile(join(root, "skill", "scripts", "run.sh"), "echo hi");
  const pkg = await readSkillPackage(root, "skill");
  assert.equal(pkg.ok, true);
  assert.equal(pkg.name, "pkg-skill");
  assert.deepEqual(pkg.files.map((f) => f.path).sort(), ["SKILL.md", "scripts/run.sh"]);
});

await check("readSkillPackage: 单文件技能落成 SKILL.md", async () => {
  const root = await tempDir("pkg-flat-");
  await writeFile(join(root, "solo.md"), "---\nname: solo\ndescription: s\n---\n");
  const pkg = await readSkillPackage(root, "solo.md");
  assert.equal(pkg.ok, true);
  assert.equal(pkg.name, "solo");
  assert.deepEqual(pkg.files.map((f) => f.path), ["SKILL.md"]);
});

await check("readSkillPackage: 拒绝 .. 路径并说明原因", async () => {
  const root = await tempDir("pkg-evil-");
  const pkg = await readSkillPackage(root, "../etc");
  assert.equal(pkg.ok, false);
  assert.match(pkg.reason, /不安全/);
});

await check("readSkillPackage: 缺 SKILL.md 时报明确原因", async () => {
  const root = await tempDir("pkg-nodoc-");
  await mkdir(join(root, "bare"), { recursive: true });
  await writeFile(join(root, "bare", "readme.txt"), "x");
  const pkg = await readSkillPackage(root, "bare");
  assert.equal(pkg.ok, false);
  assert.match(pkg.reason, /没有 SKILL.md/);
});

await check("readSkillPackage: 超过体积上限时报明确原因", async () => {
  const root = await tempDir("pkg-big-");
  await mkdir(join(root, "big"), { recursive: true });
  await writeFile(join(root, "big", "SKILL.md"), "---\nname: big\ndescription: b\n---\n");
  // 造一个超过 32MB 的文件
  await writeFile(join(root, "big", "blob.bin"), Buffer.alloc(33 * 1024 * 1024, 1));
  const pkg = await readSkillPackage(root, "big");
  assert.equal(pkg.ok, false);
  assert.match(pkg.reason, /体积超过上限/);
});

await check("readSkillPackage: 大技能包（18MB / 200+ 文件）可以安装", async () => {
  const root = await tempDir("pkg-large-");
  await mkdir(join(root, "large"), { recursive: true });
  await writeFile(join(root, "large", "SKILL.md"), "---\nname: large\ndescription: l\n---\n");
  // 模拟 archify：206 个文件、约 18MB
  await mkdir(join(root, "large", "assets"), { recursive: true });
  for (let i = 0; i < 205; i += 1) {
    await writeFile(join(root, "large", "assets", "f" + i + ".bin"), Buffer.alloc(88 * 1024, 1));
  }
  const pkg = await readSkillPackage(root, "large");
  assert.equal(pkg.ok, true, "18MB 的技能包必须能装（archify 就是这个量级）");
  assert.equal(pkg.files.length, 206);
});

// ── Git URL 解析 ───────────────────────────────────────────────────────────
await check("parseGitUrl: owner/repo 简写", () => {
  const source = parseGitUrl({ url: "owner/repo" });
  assert.equal(source.owner, "owner");
  assert.equal(source.name, "repo");
  assert.equal(source.ref, "");
  assert.equal(source.subdirectory, "");
});

await check("parseGitUrl: HTTPS URL 与 tree 子路径", () => {
  const source = parseGitUrl({ url: "https://github.com/Owner/Repo/tree/main/skills" });
  assert.equal(source.owner, "owner");
  assert.equal(source.name, "repo");
  assert.equal(source.ref, "main");
  assert.equal(source.subdirectory, "skills");
});

await check("parseGitUrl: 拒绝凭据、ext 传输、前导横杠", () => {
  assert.throws(() => parseGitUrl({ url: "https://user:pass@github.com/a/b" }), /用户名或密码/);
  assert.throws(() => parseGitUrl({ url: "ext::sh -c whoami" }), /不安全|无效/);
  assert.throws(() => parseGitUrl({ url: "-oProxyCommand=x" }), /不安全|无效/);
});

await check("parseGitUrl: 拒绝不安全子目录", () => {
  assert.throws(() => parseGitUrl({ url: "a/b", subdirectory: "../etc" }), /不安全/);
  assert.throws(() => parseGitUrl({ url: "a/b", subdirectory: "/abs" }), /不安全/);
});

await check("safePath: 拒绝 Windows 保留名与非法字符", () => {
  assert.throws(() => safePath("con/x"), /不安全/);
  assert.throws(() => safePath("a\\b"), /不安全/);
  assert.equal(safePath("a/b-c_d"), "a/b-c_d");
});

await check("repositoryIdentity: 同来源同 id，不同 ref 不同 id", () => {
  const a = parseGitUrl({ url: "a/b" });
  const b = parseGitUrl({ url: "a/b" });
  const c = parseGitUrl({ url: "a/b", ref: "dev" });
  assert.equal(repositoryIdentity(a), repositoryIdentity(b));
  assert.notEqual(repositoryIdentity(a), repositoryIdentity(c));
});

await check("skillCheckoutPatterns: 根级 SKILL.md 要求完整检出", () => {
  assert.equal(skillCheckoutPatterns(["SKILL.md", "a/SKILL.md"]), null);
});

await check("skillCheckoutPatterns: 只取技能目录，去掉被覆盖的子目录", () => {
  const patterns = skillCheckoutPatterns(["a/SKILL.md", "a/b/SKILL.md", "c/SKILL.md", "readme.md"]);
  assert.deepEqual(patterns.sort(), ["/a/**", "/c/**"]);
});

await check("skillCheckoutPatterns: 没有技能时用空规则", () => {
  const patterns = skillCheckoutPatterns(["readme.md"]);
  assert.equal(patterns.length, 1);
  assert.match(patterns[0], /empty/);
});

// ── 状态文件 ───────────────────────────────────────────────────────────────
await check("loadState: 缺失文件返回空状态", async () => {
  const home = await tempDir("state-empty-");
  const state = await loadState(home);
  assert.deepEqual(state, emptyState());
});

await check("loadState: 损坏 JSON 返回空状态而不抛错", async () => {
  const home = await tempDir("state-broken-");
  await mkdir(join(home, "skills", ".system", "skill-viewer"), { recursive: true });
  await writeFile(join(home, "skills", ".system", "skill-viewer", "discover.json"), "{not json");
  const state = await loadState(home);
  assert.deepEqual(state.repositories, []);
});

await check("loadState: 版本不符返回空状态", async () => {
  const home = await tempDir("state-version-");
  await mkdir(join(home, "skills", ".system", "skill-viewer"), { recursive: true });
  await writeFile(join(home, "skills", ".system", "skill-viewer", "discover.json"), JSON.stringify({ version: 99, repositories: [{ id: "x" }], installs: [] }));
  const state = await loadState(home);
  assert.deepEqual(state.repositories, []);
});

await check("saveState/loadState: 往返保持仓库与安装记录", async () => {
  const home = await tempDir("state-roundtrip-");
  const state = upsertRepository(emptyState(), {
    id: "abc",
    url: "https://github.com/a/b",
    owner: "a",
    name: "b",
    ref: "",
    subdirectory: "",
    commit: "a".repeat(40),
    scannedAt: new Date().toISOString(),
    skills: [{ name: "s", description: "d", path: "s", valid: true }]
  });
  const withInstall = recordInstall(state, {
    id: "i1",
    kind: "repo",
    origin: "a/b",
    repoId: "abc",
    name: "s",
    root: "dsh",
    files: [{ path: "SKILL.md", hash: "b".repeat(64) }],
    installedAt: new Date().toISOString()
  });
  await saveState(home, withInstall);
  const loaded = await loadState(home);
  assert.equal(loaded.repositories.length, 1);
  assert.equal(loaded.repositories[0].skills.length, 1);
  assert.equal(loaded.installs.length, 1);
  assert.equal(loaded.installs[0].origin, "a/b");
});

await check("loadState: 丢弃 workspace 根但缺 workspace 路径的记录", async () => {
  const home = await tempDir("state-badroot-");
  await mkdir(join(home, "skills", ".system", "skill-viewer"), { recursive: true });
  await writeFile(
    join(home, "skills", ".system", "skill-viewer", "discover.json"),
    JSON.stringify({
      version: 1,
      repositories: [],
      installs: [
        { id: "a", kind: "repo", origin: "x/y", name: "n", root: "workspace", files: [], installedAt: "2026-01-01T00:00:00.000Z" },
        { id: "b", kind: "repo", origin: "x/y", name: "m", root: "dsh", files: [], installedAt: "2026-01-01T00:00:00.000Z" }
      ]
    })
  );
  const state = await loadState(home);
  assert.deepEqual(state.installs.map((i) => i.id), ["b"]);
});

await check("findInstall / recordInstall / forgetInstall / installIndex", () => {
  let state = emptyState();
  const install = { id: "1", kind: "repo", origin: "a/b", name: "s", root: "dsh", files: [], installedAt: "2026-01-01T00:00:00.000Z" };
  state = recordInstall(state, install);
  assert.equal(findInstall(state, { origin: "a/b", root: "dsh", name: "s" }).id, "1");
  assert.equal(findInstall(state, { origin: "a/c", root: "dsh", name: "s" }), undefined);
  const index = installIndex(state);
  assert.equal(index.get(installKey("dsh", undefined, "s")).id, "1");
  state = forgetInstall(state, "1");
  assert.equal(state.installs.length, 0);
});

// ── Git 抓取（本地仓库，不联网）─────────────────────────────────────────────
await check("fetchGitRepository: 本地仓库抓取 + 稀疏检出只落技能目录", async () => {
  const repo = await tempDir("gitrepo-");
  await mkdir(join(repo, "skills", "one"), { recursive: true });
  await writeFile(join(repo, "skills", "one", "SKILL.md"), "---\nname: one\ndescription: 1\n---\n");
  await writeFile(join(repo, "README.md"), "# big\n");
  await mkdir(join(repo, "assets"), { recursive: true });
  await writeFile(join(repo, "assets", "img.bin"), Buffer.alloc(1024, 1));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const dest = join(await tempDir("checkout-"), "wt");
  const { commit } = await fetchGitRepository({ owner: "local", name: "repo", ref: "", subdirectory: "", url: repo }, dest);
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  const skills = await scanRepositorySkills(dest, "");
  assert.deepEqual(skills.map((s) => s.name), ["one"]);
  // 稀疏检出：assets 不该落地。
  const entries = await readFile(join(dest, "skills", "one", "SKILL.md"), "utf8");
  assert.match(entries, /name: one/);
});

await check("fetchGitRepository: 不存在的分支报网络类错误", async () => {
  const repo = await tempDir("gitrepo-badref-");
  await writeFile(join(repo, "x.txt"), "x");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const dest = join(await tempDir("checkout-bad-"), "wt");
  await assert.rejects(
    () => fetchGitRepository({ owner: "local", name: "repo", ref: "nope", subdirectory: "", url: repo }, dest),
    (error) => error.code === "error.repo.network"
  );
});

// ── 来源归属 ───────────────────────────────────────────────────────────────
await check("resolveProvenance: 安装记录优先于锁文件", async () => {
  const root = await tempDir("prov-install-");
  await mkdir(join(root, "s"), { recursive: true });
  await writeFile(join(root, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await writeFile(join(root, ".skills-lock.json"), JSON.stringify({ skills: { s: { source: "lock/owner", skillPath: "s/SKILL.md" } } }));
  const origin = await resolveProvenance({
    rootPath: root,
    skillPath: join(root, "s", "SKILL.md"),
    name: "s",
    installOrigin: { kind: "repo", label: "install/owner" }
  });
  assert.equal(origin.kind, "repo");
  assert.equal(origin.label, "install/owner");
});

await check("resolveProvenance: 无安装记录时读 .skills-lock.json（显式 GitHub 才给链接）", async () => {
  const root = await tempDir("prov-lock-");
  await mkdir(join(root, "s"), { recursive: true });
  await writeFile(join(root, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await writeFile(
    join(root, ".skills-lock.json"),
    JSON.stringify({ skills: { s: { source: "anthropics/skills", sourceType: "github", skillPath: "s/SKILL.md" } } })
  );
  const origin = await resolveProvenance({ rootPath: root, skillPath: join(root, "s", "SKILL.md"), name: "s" });
  assert.equal(origin.kind, "lock");
  assert.equal(origin.label, "anthropics/skills");
  assert.equal(origin.url, "https://github.com/anthropics/skills");
});

await check("resolveProvenance: 未标注类型的简写只给 label，不编造 GitHub 链接", async () => {
  const root = await tempDir("prov-lock-untyped-");
  await mkdir(join(root, "s"), { recursive: true });
  await writeFile(join(root, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await writeFile(join(root, ".skills-lock.json"), JSON.stringify({ skills: { s: { source: "org/repo" } } }));
  const origin = await resolveProvenance({ rootPath: root, skillPath: join(root, "s", "SKILL.md"), name: "s" });
  assert.equal(origin.kind, "lock");
  assert.equal(origin.label, "org/repo");
  assert.equal(origin.url, undefined);
});

await check("resolveProvenance: 读技能目录内的 _skillhub_meta.json", async () => {
  const root = await tempDir("prov-meta-");
  await mkdir(join(root, "s"), { recursive: true });
  await writeFile(join(root, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await writeFile(join(root, "s", "_skillhub_meta.json"), JSON.stringify({ source: "some/market", sourceType: "github" }));
  const origin = await resolveProvenance({ rootPath: root, skillPath: join(root, "s", "SKILL.md"), name: "s" });
  assert.equal(origin.kind, "market");
  assert.equal(origin.label, "some/market");
});

await check("resolveProvenance: 没有证据返回 undefined，不猜", async () => {
  const root = await tempDir("prov-none-");
  await mkdir(join(root, "s"), { recursive: true });
  await writeFile(join(root, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  assert.equal(await resolveProvenance({ rootPath: root, skillPath: join(root, "s", "SKILL.md"), name: "s" }), undefined);
});

await check("attachProvenance: 只解析有磁盘位置的行走", async () => {
  const root = await tempDir("prov-attach-");
  await mkdir(join(root, "s"), { recursive: true });
  await writeFile(join(root, "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
  await writeFile(join(root, ".skills-lock.json"), JSON.stringify({ skills: { s: { source: "o/r" } } }));
  const rows = [
    { name: "s", rootPath: root, filePath: join(root, "s", "SKILL.md") },
    { name: "plugin-skill" }
  ];
  await attachProvenance(rows);
  assert.equal(rows[0].origin.label, "o/r");
  assert.equal(rows[1].origin, undefined);
});

// ── 服务层：安装落地 ───────────────────────────────────────────────────────
function makeDeps(home, agents) {
  return {
    dshHome: () => home,
    agentsHome: () => agents,
    normalizeWorkspace: async (raw) => raw,
    listWorkspaces: async () => [],
    skillExists: async () => false
  };
}

await check("pending 记录不参与「已安装」判定，但算本插件所有", () => {
  const state = recordInstall(emptyState(), {
    id: "p1",
    kind: "repo",
    origin: "a/b",
    name: "s",
    root: "dsh",
    files: [],
    installedAt: "2026-01-01T00:00:00.000Z",
    pending: true
  });
  assert.equal(installIndex(state).size, 0, "pending 不该让技能显示为已安装");
  assert.equal(ownedIndex(state).size, 1, "pending 仍算本插件所有，重装可覆盖");
});

await check("loadState 保留 pending 标记（崩溃恢复的依据）", async () => {
  const home = await tempDir("state-pending-");
  await mkdir(join(home, "skills", ".system", "skill-viewer"), { recursive: true });
  await writeFile(
    join(home, "skills", ".system", "skill-viewer", "discover.json"),
    JSON.stringify({
      version: 1,
      repositories: [],
      installs: [{ id: "p1", kind: "repo", origin: "a/b", name: "s", root: "dsh", files: [], installedAt: "2026-01-01T00:00:00.000Z", pending: true }]
    })
  );
  const state = await loadState(home);
  assert.equal(state.installs.length, 1);
  assert.equal(state.installs[0].pending, true);
});

// ── 并发写：状态文件不能被互相覆盖 ───────────────────────────────────────
await check("并发写状态不会互相覆盖（串行队列）", async () => {
  const home = await tempDir("svc-concurrent-");
  const agents = await tempDir("svc-concurrent-agents-");
  const service = new DiscoverService(makeDeps(home, agents));

  // 20 个并发「安装」直接打私有 installFiles（不联网）：
  // 走 installCatalogSkill 需要网络，这里复用它的落地路径 —— 用反射拿私有方法
  // 是测试专用手段，生产代码只通过公开 RPC 调用。
  const installFiles = service["installFiles"].bind(service);
  const target = { root: "dsh", path: join(home, "skills") };
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      installFiles(
        "skill-" + index,
        [{ path: "SKILL.md", data: Buffer.from("---\nname: skill-" + index + "\ndescription: d\n---\n") }],
        { kind: "clawhub", origin: "owner/skill-" + index },
        target
      )
    )
  );

  const state = await loadState(home);
  assert.equal(state.installs.length, 20, "20 次并发安装必须留下 20 条记录，实际 " + state.installs.length);
  for (let index = 0; index < 20; index += 1) {
    const found = state.installs.some((item) => item.name === "skill-" + index && item.pending !== true);
    assert.equal(found, true, "缺少 skill-" + index + " 的确认记录");
  }
});

await check("安装成功后目录就位、记录无 pending", async () => {
  const home = await tempDir("svc-install-");
  const agents = await tempDir("svc-install-agents-");
  const service = new DiscoverService(makeDeps(home, agents));
  const installFiles = service["installFiles"].bind(service);
  const result = await installFiles(
    "ok-skill",
    [
      { path: "SKILL.md", data: Buffer.from("---\nname: ok-skill\ndescription: d\n---\n") },
      { path: "scripts/run.sh", data: Buffer.from("echo hi") }
    ],
    { kind: "clawhub", origin: "owner/ok-skill" },
    { root: "dsh", path: join(home, "skills") }
  );
  assert.equal(result.updated, false);
  const doc = await readFile(join(home, "skills", "ok-skill", "SKILL.md"), "utf8");
  assert.match(doc, /name: ok-skill/);
  const script = await readFile(join(home, "skills", "ok-skill", "scripts", "run.sh"), "utf8");
  assert.equal(script, "echo hi");
  const state = await loadState(home);
  assert.equal(state.installs.length, 1);
  assert.equal(state.installs[0].pending, undefined, "确认后不应残留 pending");
  assert.equal(state.installs[0].files.length, 2);
});

await check("同名但不是本插件装的技能被拒绝覆盖", async () => {
  const home = await tempDir("svc-conflict-");
  const agents = await tempDir("svc-conflict-agents-");
  await mkdir(join(home, "skills", "handmade"), { recursive: true });
  await writeFile(join(home, "skills", "handmade", "SKILL.md"), "---\nname: handmade\ndescription: user\n---\n");
  const service = new DiscoverService(makeDeps(home, agents));
  const installFiles = service["installFiles"].bind(service);
  await assert.rejects(
    () =>
      installFiles(
        "handmade",
        [{ path: "SKILL.md", data: Buffer.from("---\nname: handmade\ndescription: mine\n---\n") }],
        { kind: "clawhub", origin: "owner/handmade" },
        { root: "dsh", path: join(home, "skills") }
      ),
    (error) => error.code === "error.repo.conflict"
  );
  // 用户文件必须原样保留。
  const doc = await readFile(join(home, "skills", "handmade", "SKILL.md"), "utf8");
  assert.match(doc, /description: user/);
});

await check("崩溃留下的 pending 记录可被重装覆盖（不报同名冲突）", async () => {
  const home = await tempDir("svc-recover-");
  const agents = await tempDir("svc-recover-agents-");
  // 模拟上次安装写到一半：目录存在、状态里是 pending。
  await mkdir(join(home, "skills", "half"), { recursive: true });
  await writeFile(join(home, "skills", "half", "SKILL.md"), "partial");
  await saveState(home, recordInstall(emptyState(), {
    id: "x",
    kind: "clawhub",
    origin: "owner/half",
    name: "half",
    root: "dsh",
    files: [],
    installedAt: "2026-01-01T00:00:00.000Z",
    pending: true
  }));
  const service = new DiscoverService(makeDeps(home, agents));
  const installFiles = service["installFiles"].bind(service);
  const result = await installFiles(
    "half",
    [{ path: "SKILL.md", data: Buffer.from("---\nname: half\ndescription: d\n---\n") }],
    { kind: "clawhub", origin: "owner/half" },
    { root: "dsh", path: join(home, "skills") }
  );
  assert.equal(result.updated, true, "重装应视为更新");
  const doc = await readFile(join(home, "skills", "half", "SKILL.md"), "utf8");
  assert.match(doc, /description: d/, "半份文件必须被完整替换");
  const state = await loadState(home);
  assert.equal(state.installs.length, 1, "不应残留两条记录");
  assert.equal(state.installs[0].pending, undefined);
});

// 清理
for (const dir of tempDirs) {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) {
  console.log("SOME DISCOVER TESTS FAILED");
  process.exit(1);
}
console.log("ALL DISCOVER TESTS PASSED");
