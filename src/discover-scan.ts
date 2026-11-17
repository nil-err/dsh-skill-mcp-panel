/**
 * dsh-skill-mcp-panel —— 从仓库工作树里扫描技能清单。
 *
 * 与技能根扫描（skill-files.ts 的 collectSkillEntries）的区别：
 *   - 这里扫的是**刚抓下来的临时工作树**，不是用户技能根，因此不做启停态判定；
 *   - 目录含 SKILL.md 即视为一个技能包，**不再下钻**（包内 references/ 不是嵌套技能）；
 *   - 单文件 `.md` 只在根层算技能（与扁平提供方一致）；
 *   - frontmatter 必须合法（name 符合 kebab-case + description 非空）才标 `valid: true`，
 *     非法条目仍然列出但不可安装——用户需要看到「仓库里有这个东西但不合规范」。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RepositorySkill } from "./discover-types.js";
import { LIMITS } from "./discover-types.js";

/** 技能名规则：小写字母、数字与连字符。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 根级单文件技能只认 `SKILL.md`。
 *
 * `subdirectory` 指向仓库的某个子目录时，那个子目录就是「技能仓库根」，
 * 此时它自己的 `SKILL.md` 才是整仓技能。
 */
function isRootSkillDoc(fileName: string, subdirectory: string): boolean {
  return fileName === "SKILL.md" || (subdirectory !== "" && fileName === "SKILL.md");
}

/**
 * 递归时跳过的目录。
 *
 * 注意这里**不跳过所有隐藏目录**：不少技能仓库同时提供多套 Agent 布局，
 * 例如 ponytail 把同一批技能镜像在 `skills/` 与 `.openclaw/skills/` 下。
 * 一刀切跳过隐藏目录会漏掉只在 `.openclaw` 里发布的技能；真正该跳的是
 * 版本库元数据与依赖目录。
 *
 * 镜像目录带来的重复由 `scanRepositorySkills` 末尾按技能名去重解决。
 */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn", ".github"]);

/** 隐藏目录里值得继续下钻的（仅当订阅勾选了「包含隐藏目录」时才生效）。 */
const HIDDEN_SKILL_HOSTS = new Set([".openclaw", ".claude", ".agents", ".cursor"]);

/** 递归深度上限：防御符号链接环。 */
const MAX_RECURSE_DEPTH = 8;

/** frontmatter 校验结果。 */
export interface FrontmatterCheck {
  ok: boolean;
  name?: string;
  description?: string;
  reason?: string;
}

/**
 * 校验 SKILL.md 的 frontmatter。
 * 与宿主 dsh-skill-filesystem 的口径一致：`---` 之间是 YAML 映射，必须有 name 与 description。
 */
export function checkFrontmatter(raw: string): FrontmatterCheck {
  const text = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("---")) return { ok: false, reason: "缺少 frontmatter（文件应以 --- 开头）" };
  const firstEnd = text.indexOf("\n");
  if (firstEnd === -1) return { ok: false, reason: "frontmatter 未闭合" };
  const closing = text.indexOf("\n---", firstEnd + 1);
  const fmEnd = closing === -1 ? text.length : closing;
  const fm = text.slice(firstEnd + 1, fmEnd);
  let data: unknown;
  try {
    data = parseYaml(fm);
  } catch (error) {
    return { ok: false, reason: "frontmatter 不是合法的 YAML：" + (error instanceof Error ? error.message : String(error)) };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "frontmatter 必须是键值对（YAML 映射）" };
  }
  const record = data as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name === "") return { ok: false, reason: "frontmatter 缺少 name" };
  if (!SKILL_NAME_RE.test(name)) return { ok: false, reason: '技能名 "' + name + '" 不符合命名规则（仅小写字母、数字与连字符）' };
  const description = record.description;
  if (typeof description !== "string" || description.trim() === "") {
    return { ok: false, name, reason: "frontmatter 缺少 description" };
  }
  return { ok: true, name, description };
}

/**
 * 扫描一个已检出的仓库目录，返回技能清单。
 * @param root 工作树根
 * @param subdirectory 只扫该子目录（空串表示整仓）
 */
export async function scanRepositorySkills(
  root: string,
  subdirectory = "",
  options: { includeHidden?: boolean } = {}
): Promise<RepositorySkill[]> {
  const base = subdirectory === "" ? root : join(root, subdirectory);
  const baseInfo = await stat(base).catch(() => undefined);
  if (baseInfo === undefined || !baseInfo.isDirectory()) return [];
  const includeHidden = options.includeHidden === true;

  const skills: RepositorySkill[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_RECURSE_DEPTH || skills.length >= LIMITS.maxRepositorySkills) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skills.length >= LIMITS.maxRepositorySkills) return;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      // 隐藏目录**默认不扫**：多数隐藏目录是工具配置（.github/.vscode/.claude 缓存…），
      // 扫进去只会让清单里混进一堆用户并不想装的条目。只有订阅时显式勾选
      // 「包含隐藏目录」，才在已知会放技能的宿主目录（.openclaw/skills 等）里下钻。
      if (entry.name.startsWith(".") && !(includeHidden && HIDDEN_SKILL_HOSTS.has(entry.name))) continue;
      const full = join(dir, entry.name);
      const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && (await stat(full).catch(() => undefined))?.isDirectory() === true);
      if (isDirectory) {
        const doc = join(full, "SKILL.md");
        const docInfo = await stat(doc).catch(() => undefined);
        if (docInfo !== undefined && docInfo.isFile()) {
          // 技能包：收集后不下钻（包内 references/ scripts/ 属于包本身）。
          const relativePath = relative(root, full).split("\\").join("/");
          if (relativePath === "" || relativePath.startsWith("..")) continue;
          const check = checkFrontmatter(await readFile(doc, "utf8").catch(() => ""));
          skills.push({
            name: check.name ?? entry.name,
            description: check.description ?? "",
            path: relativePath,
            valid: check.ok,
            ...(check.ok ? {} : { reason: check.reason })
          });
        } else {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile() && depth === 0 && isRootSkillDoc(entry.name, subdirectory)) {
        // 根级「整仓即一个技能」：只认 SKILL.md，不认 README / CHANGELOG / AGENTS。
        //
        // 为什么必须限定文件名：仓库根目录下的 markdown 大多不是技能（README、CHANGELOG、
        // 贡献指南…），把它们当技能列出来会让清单里凭空多出几个「格式无效」的假条目，
        // 用户还会疑惑「这些我根本没想装」。上游也只认根级 SKILL.md。
        const relativePath = relative(root, full).split("\\").join("/");
        if (relativePath === "" || relativePath.startsWith("..")) continue;
        const check = checkFrontmatter(await readFile(full, "utf8").catch(() => ""));
        skills.push({
          name: check.name ?? entry.name.slice(0, -3),
          description: check.description ?? "",
          path: relativePath,
          valid: check.ok,
          ...(check.ok ? {} : { reason: check.reason })
        });
      }
    }
  };
  await walk(base, 0);
  return dedupeByName(skills);
}

/**
 * 按技能名去重。
 *
 * 为什么需要：同一个技能常被仓库镜像到多套 Agent 布局里（`skills/x` 与
 * `.openclaw/skills/x`）。两处内容一样，列两遍只会让用户以为要装两次。
 *
 * 保留哪一份：路径更浅、且不含隐藏段的优先——`skills/x` 比
 * `.openclaw/skills/x` 更接近仓库作者的主布局，也更适合作为安装来源展示。
 */
function dedupeByName(skills: RepositorySkill[]): RepositorySkill[] {
  const best = new Map<string, RepositorySkill>();
  const rank = (path: string): number => {
    const segments = path.split("/");
    const hidden = segments.some((segment) => segment.startsWith(".")) ? 100 : 0;
    return hidden + segments.length;
  };
  for (const skill of skills) {
    const current = best.get(skill.name);
    if (current === undefined) {
      best.set(skill.name, skill);
      continue;
    }
    // 合法条目优先于非法条目；同等合法时取更浅/非隐藏的那份。
    if (current.valid !== skill.valid) {
      if (skill.valid) best.set(skill.name, skill);
      continue;
    }
    if (rank(skill.path) < rank(current.path)) best.set(skill.name, skill);
  }
  return [...best.values()];
}

/**
 * 读取仓库里某个技能包的全部文件（用于安装）。
 * 目录束只收包内文件；单文件技能只有那一个 `.md`。
 *
 * 安全：所有相对路径都重新校验，拒绝绝对路径与 `..`（抓下来的仓库不可信）。
 */
export type SkillPackageResult =
  | { ok: true; name: string; files: { path: string; data: Buffer }[] }
  | { ok: false; reason: string };

export async function readSkillPackage(
  root: string,
  skillPath: string
): Promise<SkillPackageResult> {
  const normalized = skillPath.split("\\").join("/").replace(/\/$/, "");
  if (normalized === "" || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === ".")) {
    return { ok: false, reason: "技能路径不安全：" + skillPath };
  }
  const absolute = join(root, normalized);
  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined) return { ok: false, reason: "技能目录不存在（可能仓库已更新，请刷新后重试）" };

  if (info.isFile()) {
    if (!normalized.endsWith(".md")) return { ok: false, reason: "单文件技能必须是 .md 文件" };
    const data = await readFile(absolute);
    const check = checkFrontmatter(data.toString("utf8"));
    if (!check.ok || check.name === undefined) return { ok: false, reason: "SKILL.md 格式不符合要求：" + (check.reason ?? "frontmatter 无效") };
    // 单文件技能落成 `<name>/SKILL.md`，与目录束的布局统一。
    return { ok: true, name: check.name, files: [{ path: "SKILL.md", data }] };
  }

  const files: { path: string; data: Buffer }[] = [];
  let totalBytes = 0;
  /** 超出护栏时记下具体是哪条，供上层原样报给用户。 */
  let skipReason: string | undefined;
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (skipReason !== undefined) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipReason !== undefined) return;
      if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      const childInfo = await stat(full).catch(() => undefined);
      if (childInfo === undefined) continue;
      if (childInfo.isDirectory()) {
        await walk(full, childRel);
        continue;
      }
      if (!childInfo.isFile()) continue;
      if (files.length >= LIMITS.maxInstallFiles) {
        skipReason = "技能包文件数超过上限（" + LIMITS.maxInstallFiles + " 个）";
        return;
      }
      totalBytes += childInfo.size;
      if (totalBytes > LIMITS.maxInstallBytes) {
        const limitMb = Math.round(LIMITS.maxInstallBytes / (1024 * 1024));
        skipReason = "技能包体积超过上限（" + limitMb + "MB）";
        return;
      }
      files.push({ path: childRel, data: await readFile(full) });
    }
  };
  await walk(absolute, "");
  if (skipReason !== undefined) return { ok: false, reason: skipReason };
  const doc = files.find((file) => file.path === "SKILL.md");
  if (doc === undefined) return { ok: false, reason: "技能包里没有 SKILL.md" };
  const check = checkFrontmatter(doc.data.toString("utf8"));
  if (!check.ok || check.name === undefined) return { ok: false, reason: "SKILL.md 格式不符合要求：" + (check.reason ?? "frontmatter 无效") };
  return { ok: true, name: check.name, files };
}
