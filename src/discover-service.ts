/**
 * dsh-skill-mcp-panel —— 「发现技能」服务层（宿主半区）。
 *
 * 把三件事串起来：
 *   1. **Git 仓库订阅**：添加 → 抓取 → 扫技能 → 记订阅；技能按需安装到技能根。
 *   2. **第三方目录**（ClawHub / skills.sh）：搜索 → 详情 → 下载 → 安装。
 *   3. **来源归属**：安装时写安装记录；列表时按记录回填 `origin`。
 *
 * 与技能根的关系：安装最终落成与 `addSkill` 完全相同的磁盘布局
 * （`<root>/<name>/SKILL.md` + 资源文件），因此安装出来的技能和用户手工添加的
 * 技能在面板里没有区别，能被启停、迁移、删除；区别只在多一条安装记录。
 *
 * 不做的事（第一版明确砍掉，理由见各方法注释）：
 *   - 仓库批量预检 / 批量回滚 / 更新预览：上游靠一套独立的文件索引与备份目录实现，
 *     移植成本高于收益；这里只做「重新安装即更新」。
 *   - 安装失败自动重试：仓库抓取本身有退级链，再叠一层重试只会放大耗时。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  CATALOG_KINDS,
  LIMITS,
  type CatalogKind,
  type DiscoverInstall,
  type DiscoverRepository,
  type DiscoverState,
  type InstallRoot,
  type RepositorySkill,
  type SkillOrigin
} from "./discover-types.js";
import {
  directorySize,
  failure,
  fetchGitRepository,
  parseGitUrl,
  probeGitRemote,
  repositoryIdentity,
  tempCheckoutDir,
  type CodedError,
  type RepositorySource
} from "./discover-git.js";
import { readSkillPackage, scanRepositorySkills } from "./discover-scan.js";
import {
  emptyState,
  findInstall,
  forgetAtLocation,
  forgetInstall,
  installKey,
  installIndex,
  loadState,
  ownedIndex,
  recordInstall,
  removeRepository,
  saveState,
  upsertRepository
} from "./discover-store.js";
import type { CatalogDetail } from "./catalog-common.js";
import { loadClawHubPackage, readClawHubDetail, searchClawHub, listClawHub } from "./catalog-clawhub.js";
import { loadSkillshPackage, readSkillshDetail, searchSkillsh } from "./catalog-skillsh.js";
import { writeFileAtomic } from "./fs-utils.js";

/** 目标技能根解析结果。 */
export interface InstallTarget {
  root: InstallRoot;
  /** root=workspace 时的项目根。 */
  workspace?: string;
  /** 实际落地的技能文件夹绝对路径。 */
  path: string;
}

/** 安装结果。 */
export interface InstallResult {
  name: string;
  root: InstallRoot;
  workspace?: string;
  /** 落地的绝对路径。 */
  path: string;
  /** 是否覆盖了同来源的旧安装（即「更新」）。 */
  updated: boolean;
  /** 非阻断提示。 */
  warnings: string[];
}

/** 服务依赖（由网关注入，便于测试替身）。 */
export interface DiscoverDeps {
  /** `<dshHome>`。 */
  dshHome(): string;
  /** `<agentsHome>`。 */
  agentsHome(): string;
  /** 工作区路径归一化（解析到 git 项目根）。 */
  normalizeWorkspace(raw: string): Promise<string>;
  /** 已知工作区列表（用于把 workspace 路径换算成技能根）。 */
  listWorkspaces(): Promise<{ path: string; label: string }[]>;
  /** 技能名在某技能根里是否已存在（冲突检测）。 */
  skillExists(target: InstallTarget, name: string): Promise<boolean>;
}

/** 摘要工具：安装记录里的文件 hash。 */
function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 安装记录 id：来源 + 落地位置 + 名称的稳定摘要（同来源重装即更新同一条）。 */
function installId(kind: string, origin: string, root: InstallRoot, workspace: string | undefined, name: string): string {
  return sha256([kind, origin, root, workspace ?? "", name].join("\u0000")).slice(0, 32);
}

/** 把仓库来源拼成展示用标识。 */
function repoOrigin(source: RepositorySource): string {
  return source.owner + "/" + source.name;
}

/** 把仓库来源拼成可复用的规范化 URL（GitHub 用 https，本地路径原样）。 */
function repoUrl(source: RepositorySource): string {
  if (source.url !== undefined && source.url !== "") return source.url;
  return "https://github.com/" + source.owner + "/" + source.name;
}

/** 来源归属 → 展示用的 origin 字符串（安装记录里存这个）。 */
export function originLabel(origin: SkillOrigin): string {
  return origin.label;
}

/**
 * 发现技能服务。
 *
 * 所有方法都是「一次调用完成一件事」，不持有跨调用的内存状态（除了缓存）：
 * 状态全在 `discover.json` 里，进程重启不丢。
 */
export class DiscoverService {
  private readonly deps: DiscoverDeps;

  /**
   * 写操作串行队列。
   *
   * 为什么必须有：状态文件是「读全量 → 改 → 写全量」，两个并发安装各自读到
   * 同一份旧快照，后写的那个会把先写的记录整体覆盖掉——用户看到的现象是
   * 「刚装好的技能来源莫名消失」。这里把所有**会写状态**的操作排成一条链，
   * 保证每次读-改-写期间没有第二个写者。
   *
   * 为什么不用文件锁：本插件是单进程内的单例服务，进程内串行已经覆盖全部
   * 写者；跨进程场景（用户同时开两个 DSH）本来也不支持并发管理技能。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(deps: DiscoverDeps) {
    this.deps = deps;
  }

  /** 把一个写操作排进串行队列；前一个失败不影响后一个执行。 */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(operation, operation);
    // 队列本身不能因为某次失败而中断：吞掉错误只用于链式推进，调用方仍收到原错误。
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** 读状态（每次现读，保证与磁盘一致）。 */
  private state(): Promise<DiscoverState> {
    return loadState(this.deps.dshHome());
  }

  // ── 仓库订阅 ────────────────────────────────────────────────────────────

  /**
   * 添加（或更新）一个仓库订阅并立即扫描。
   *
   * 扫描成功才落订阅：扫不到的仓库留在列表里只会让用户反复点刷新。
   * 扫描失败时抛错，不写状态。
   */
  async addRepository(input: {
    url?: unknown;
    ref?: unknown;
    subdirectory?: unknown;
    includeHidden?: unknown;
  }): Promise<DiscoverRepository> {
    // 抓取耗时较长，放在队列外；只有「读状态 → 落订阅」这一段需要串行。
    const source = parseGitUrl(input);
    const includeHidden = input.includeHidden === true;
    const identity = repositoryIdentity(source);
    const id = sha256(identity).slice(0, 24);
    const state = await this.state();
    if (state.repositories.length >= LIMITS.maxRepositories && !state.repositories.some((repo) => repo.id === id)) {
      throw failure("最多只能订阅 " + LIMITS.maxRepositories + " 个仓库，请先移除不用的订阅", "error.repo.limit");
    }

    const scanned = await this.scanSource(source, id, includeHidden);
    const repository: DiscoverRepository = {
      id,
      url: repoUrl(source),
      owner: source.owner,
      name: source.name,
      ref: source.ref,
      subdirectory: source.subdirectory,
      ...(includeHidden ? { includeHidden: true } : {}),
      commit: scanned.commit,
      scannedAt: new Date().toISOString(),
      skills: scanned.skills
    };
    await this.serialize(async () => {
      // 队列内重新读一次状态：抓取期间别的写可能已经改了订阅列表。
      const current = await this.state();
      await saveState(this.deps.dshHome(), upsertRepository(current, repository));
    });
    return repository;
  }

  /** 重新扫描一个已订阅的仓库（拉最新提交并更新技能清单）。 */
  async refreshRepository(id: string): Promise<DiscoverRepository> {
    const state = await this.state();
    const existing = state.repositories.find((repo) => repo.id === id);
    if (existing === undefined) throw failure("仓库订阅不存在，请刷新列表", "error.repo.missing");
    const source: RepositorySource = {
      owner: existing.owner,
      name: existing.name,
      ref: existing.ref,
      subdirectory: existing.subdirectory,
      url: existing.url
    };
    let scanned: { commit: string; skills: RepositorySkill[] };
    try {
      scanned = await this.scanSource(source, id, existing.includeHidden === true);
    } catch (error) {
      // 刷新失败保留旧清单，只记错误：用户的技能列表不该因为一次网络故障清空。
      const failed: DiscoverRepository = {
        ...existing,
        error: error instanceof Error ? error.message : String(error),
        scannedAt: new Date().toISOString()
      };
      await this.serialize(() => saveState(this.deps.dshHome(), upsertRepository(state, failed)));
      throw error;
    }
    const repository: DiscoverRepository = {
      ...existing,
      commit: scanned.commit,
      scannedAt: new Date().toISOString(),
      skills: scanned.skills
    };
    delete repository.error;
    await this.serialize(async () => {
      const current = await this.state();
      await saveState(this.deps.dshHome(), upsertRepository(current, repository));
    });
    return repository;
  }

  /** 移除订阅（已安装的技能文件与安装记录都保留）。 */
  async removeRepository(id: string): Promise<{ removed: boolean }> {
    const state = await this.state();
    const exists = state.repositories.some((repo) => repo.id === id);
    if (!exists) return { removed: false };
    await this.serialize(async () => {
      const current = await this.state();
      await saveState(this.deps.dshHome(), removeRepository(current, id));
    });
    return { removed: true };
  }

  /** 抓取仓库并扫描技能清单（临时工作树用完即删）。 */
  private async scanSource(
    source: RepositorySource,
    id: string,
    includeHidden = false
  ): Promise<{ commit: string; skills: RepositorySkill[] }> {
    const checkout = tempCheckoutDir(tmpdir(), id);
    await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    try {
      const { commit } = await fetchGitRepository(source, checkout);
      const skills = await scanRepositorySkills(checkout, source.subdirectory, { includeHidden });
      return { commit, skills };
    } finally {
      await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── 仓库技能安装 ────────────────────────────────────────────────────────

  /**
   * 安装仓库里的某个技能。
   *
   * 流程：重新抓取该仓库（拿固定提交）→ 读技能包 → 落到目标技能根。
   * 为什么重新抓而不是用缓存的工作树：临时工作树用完就删，留着会占盘且要管失效；
   * 抓取本身有部分克隆，成本可接受。
   */
  async installRepositorySkill(input: {
    repoId?: unknown;
    skillPath?: unknown;
    root?: unknown;
    workspace?: unknown;
  }): Promise<InstallResult> {
    const repoId = typeof input.repoId === "string" ? input.repoId : "";
    const skillPath = typeof input.skillPath === "string" ? input.skillPath : "";
    if (repoId === "") throw failure("缺少仓库标识", "error.repo.invalid");
    if (skillPath === "") throw failure("缺少技能路径", "error.repo.invalid");

    const state = await this.state();
    const repository = state.repositories.find((repo) => repo.id === repoId);
    if (repository === undefined) throw failure("仓库订阅不存在，请刷新列表", "error.repo.missing");
    const skill = repository.skills.find((item) => item.path === skillPath);
    if (skill === undefined) throw failure("该技能不在仓库清单中，请刷新仓库", "error.repo.missing");
    if (!skill.valid) throw failure("技能格式不符合要求：" + (skill.reason ?? "frontmatter 无效"), "error.repo.invalid");

    const target = await this.resolveTarget(input.root, input.workspace);
    const source: RepositorySource = {
      owner: repository.owner,
      name: repository.name,
      ref: repository.ref,
      subdirectory: repository.subdirectory,
      url: repository.url
    };

    const checkout = tempCheckoutDir(tmpdir(), repository.id + "-install");
    await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    try {
      const { commit } = await fetchGitRepository(source, checkout);
      const pkg = await readSkillPackage(checkout, skillPath);
      // 原样上抛具体原因：用户需要知道是「文件缺失」「格式不符」还是「超上限」，
      // 一句笼统的「无法安装」只会让人反复重试。
      if (!pkg.ok) throw failure(pkg.reason, "error.repo.invalid");
      const result = await this.installFiles(pkg.name, pkg.files, {
        kind: "repo",
        origin: repoOrigin(source),
        repoId: repository.id,
        url: repoUrl(source),
        commit
      }, target);
      return result;
    } finally {
      await rm(checkout, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ── 第三方目录 ──────────────────────────────────────────────────────────

  /** 搜索目录。 */
  async searchCatalog(kind: unknown, query: unknown): Promise<{ items: any[] }> {
    if (!CATALOG_KINDS.includes(kind as CatalogKind)) throw failure("未知的目录来源", "error.catalog.identity");
    const text = typeof query === "string" ? query.trim() : "";
    if (kind === "clawhub") {
      const { items } = await searchClawHub(text);
      return { items };
    }
    const { items } = await searchSkillsh(text);
    return { items };
  }

  /** 目录榜单（只有 ClawHub 有）。 */
  async listCatalog(kind: unknown, cursor: unknown): Promise<{ items: any[]; nextCursor: string | null }> {
    if (kind !== "clawhub") return { items: [], nextCursor: null };
    const options: { limit?: number; cursor?: string } = {};
    if (typeof cursor === "string" && cursor !== "") options.cursor = cursor;
    return await listClawHub(options);
  }

  /** 目录技能详情。 */
  async catalogDetail(kind: unknown, input: { owner?: unknown; slug?: unknown; source?: unknown; skillId?: unknown }): Promise<CatalogDetail> {
    if (!CATALOG_KINDS.includes(kind as CatalogKind)) throw failure("未知的目录来源", "error.catalog.identity");
    if (kind === "clawhub") {
      const owner = typeof input.owner === "string" ? input.owner : "";
      const slug = typeof input.slug === "string" ? input.slug : "";
      if (owner === "" || slug === "") throw failure("目录技能标识无效", "error.catalog.identity");
      return await readClawHubDetail(owner, slug);
    }
    const source = typeof input.source === "string" ? input.source : "";
    const skillId = typeof input.skillId === "string" ? input.skillId : "";
    if (source === "" || skillId === "") throw failure("目录技能标识无效", "error.catalog.identity");
    return await readSkillshDetail(source, skillId);
  }

  /** 从目录安装技能。 */
  async installCatalogSkill(input: {
    kind?: unknown;
    owner?: unknown;
    slug?: unknown;
    source?: unknown;
    skillId?: unknown;
    root?: unknown;
    workspace?: unknown;
  }): Promise<InstallResult> {
    const kind = input.kind;
    if (!CATALOG_KINDS.includes(kind as CatalogKind)) throw failure("未知的目录来源", "error.catalog.identity");
    const target = await this.resolveTarget(input.root, input.workspace);

    if (kind === "clawhub") {
      const owner = typeof input.owner === "string" ? input.owner : "";
      const slug = typeof input.slug === "string" ? input.slug : "";
      if (owner === "" || slug === "") throw failure("目录技能标识无效", "error.catalog.identity");
      const detail = await readClawHubDetail(owner, slug);
      const pkg = await loadClawHubPackage(owner, slug);
      const files = await this.expandZip(pkg.zipBase64);
      if (files === undefined) throw failure("目录技能包无法解析", "error.catalog.response");
      return await this.installFiles(pkg.name !== "" ? pkg.name : detail.name, files, { kind: "clawhub", origin: owner + "/" + slug }, target);
    }

    const source = typeof input.source === "string" ? input.source : "";
    const skillId = typeof input.skillId === "string" ? input.skillId : "";
    if (source === "" || skillId === "") throw failure("目录技能标识无效", "error.catalog.identity");
    const detail = await readSkillshDetail(source, skillId);
    const pkg = await loadSkillshPackage(source, skillId);
    const files = pkg.entries.map((entry) => ({ path: entry.path, data: Buffer.from(entry.dataBase64, "base64") }));
    return await this.installFiles(pkg.name !== "" ? pkg.name : detail.name, files, { kind: "skillsh", origin: source + "/" + skillId }, target);
  }

  /** 解压 zip 成文件列表（路径安全由 installFiles 统一校验）。 */
  private async expandZip(zipBase64: string): Promise<{ path: string; data: Buffer }[] | undefined> {
    try {
      const { unzipSync } = await import("fflate");
      const bytes = Buffer.from(zipBase64, "base64");
      const entries = unzipSync(new Uint8Array(bytes));
      const files: { path: string; data: Buffer }[] = [];
      for (const [path, data] of Object.entries(entries)) {
        if (path.endsWith("/")) continue;
        files.push({ path, data: Buffer.from(data) });
        if (files.length > LIMITS.maxInstallFiles) return undefined;
      }
      return files;
    } catch {
      return undefined;
    }
  }

  // ── 安装落地 ────────────────────────────────────────────────────────────

  /** 解析安装目标技能根。 */
  /**
   * 解析安装目标技能根：只有两个目的地。
   *
   *   - `agents` → `<agentsHome>/skills`（Shared Skill，默认）
   *   - `dsh`    → `<dshHome>/skills`（DSH Skill）
   *
   * 默认取 Shared Skill：多个 Agent 共用，装一次到处能用，是「发现技能」最常见的
   * 意图。未识别的取值一律回落到它，而不是报错——UI 只发这两个值，回落到默认比
   * 让用户看到一句参数错误更合适。
   *
   * 项目级安装已下线（见 client 里 DISCOVER_DESTS 的注释）：装进某个项目根只在
   * 那条工作区链上可见，用户装完换个会话就找不到，应当走技能页的迁移/添加。
   */
  private async resolveTarget(rawRoot: unknown, _rawWorkspace: unknown): Promise<InstallTarget> {
    if (rawRoot === "dsh") return { root: "dsh", path: join(this.deps.dshHome(), "skills") };
    return { root: "agents", path: join(this.deps.agentsHome(), "skills") };
  }

  /**
   * 把一组文件落成一个技能目录，并写安装记录。
   *
   * 落地布局与 `addSkill` 一致：`<target.path>/<name>/` 下按原相对路径展开。
   * 覆盖语义：只有**同来源**的旧安装会被直接替换（视为更新）；其它情况遇到
   * 同名目录一律拒绝，绝不动用户手工放进去的技能。
   */
  private async installFiles(
    name: string,
    files: { path: string; data: Buffer }[],
    meta: Pick<DiscoverInstall, "kind" | "origin" | "repoId" | "url" | "commit">,
    target: InstallTarget
  ): Promise<InstallResult> {
    if (files.length === 0) throw failure("技能包为空，无法安装", "error.repo.invalid");
    if (files.length > LIMITS.maxInstallFiles) throw failure("技能包文件数超过上限（" + LIMITS.maxInstallFiles + "）", "error.repo.tooLarge");
    const totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
    if (totalBytes > LIMITS.maxInstallBytes) throw failure("技能包总大小超过上限（" + Math.round(LIMITS.maxInstallBytes / (1024 * 1024)) + "MB）", "error.repo.tooLarge");

    // 路径安全：绝对路径、`..`、空段一律拒绝（目录来源的文件名同样不可信）。
    for (const file of files) {
      const parts = file.path.split("/");
      if (file.path.startsWith("/") || parts.some((part) => part === "" || part === ".." || part === ".")) {
        throw failure("技能包包含非法文件路径：" + file.path, "error.repo.invalid");
      }
    }
    if (!files.some((file) => file.path === "SKILL.md")) throw failure("技能包缺少 SKILL.md", "error.repo.invalid");

    const destDir = join(target.path, name);
    const install: DiscoverInstall = {
      id: installId(meta.kind, meta.origin, target.root, target.workspace, name),
      kind: meta.kind,
      origin: meta.origin,
      ...(meta.repoId === undefined ? {} : { repoId: meta.repoId }),
      ...(meta.url === undefined ? {} : { url: meta.url }),
      ...(meta.commit === undefined ? {} : { commit: meta.commit }),
      name,
      root: target.root,
      ...(target.workspace === undefined ? {} : { workspace: target.workspace }),
      files: files.map((file) => ({ path: file.path, hash: sha256(file.data) })),
      installedAt: new Date().toISOString()
    };

    // ── 三态安装：意图 → 落地 → 确认 ──────────────────────────────────────
    //
    // 状态与文件系统是两次独立的写，中间必有崩溃窗口。顺序固定为：
    //   1. 写 pending 记录（意图）：崩溃在这里，目录还没动，重装直接覆盖；
    //   2. 写文件并改名就位：崩溃在这里，pending 记录仍在，重装能识别「是我自己
    //      装了一半」，不会报同名冲突；
    //   3. 清掉 pending（确认）：从这一刻起才算「已安装」，列表与来源才生效。
    const result = await this.serialize(async () => {
      const state = await this.state();
      const owned = ownedIndex(state).get(installKey(target.root, target.workspace, name));
      const confirmed = installIndex(state).get(installKey(target.root, target.workspace, name));
      const destExists = await stat(destDir).catch(() => undefined);

      if (destExists !== undefined && owned === undefined) {
        // 同名但不是我装的：拒绝覆盖，避免把用户手工技能冲掉。
        throw failure('目标位置已存在同名技能 "' + name + '"，请先移除或换个安装位置', "error.repo.conflict");
      }

      await mkdir(target.path, { recursive: true });
      // 1) 意图先落盘：先按位置清掉旧记录（同位置只能有一份），再写 pending。
      const intentBase = forgetAtLocation(state, { root: target.root, workspace: target.workspace, name });
      await saveState(this.deps.dshHome(), recordInstall(intentBase, { ...install, pending: true }));

      // 2) 文件落地：先写暂存目录再整体改名，中途失败不会留下半个技能
      const staging = join(target.path, ".dsh-discover-staging-" + process.pid + "-" + randomUUID().slice(0, 8));
      try {
        await mkdir(staging, { recursive: true });
        for (const file of files) {
          const full = join(staging, file.path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, file.data);
        }
        await rm(destDir, { recursive: true, force: true }).catch(() => undefined);
        await mkdir(dirname(destDir), { recursive: true });
        const { rename } = await import("node:fs/promises");
        await rename(staging, destDir);
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
        // 失败就把意图撤掉：留下一份 pending 会让下次重装误以为可以覆盖。
        await saveState(this.deps.dshHome(), forgetInstall(await this.state(), install.id)).catch(() => undefined);
        throw failure("写入技能文件失败：" + (error instanceof Error ? error.message : String(error)), "error.repo.installState");
      }

      // 3) 确认：清掉 pending，记录成为「已安装」
      const after = await this.state();
      await saveState(this.deps.dshHome(), recordInstall(after, install));

      return {
        name,
        root: target.root,
        ...(target.workspace === undefined ? {} : { workspace: target.workspace }),
        path: destDir,
        updated: confirmed !== undefined || owned !== undefined,
        warnings: [] as string[]
      };
    });

    return result;
  }

  // ── 来源归属查询 ────────────────────────────────────────────────────────

  /**
   * 技能列表用的来源查询：把安装记录索引成 (根, 工作区, 名称) → SkillOrigin。
   *
   * 根标识映射：
   *   - `<dshHome>/skills`      → root="dsh"，workspace=undefined
   *   - `<agentsHome>/skills`   → root="agents"，workspace=undefined
   *   - `<project>/.dsh/skills` → root="workspace"，workspace=<project>
   */
  async originLookup(): Promise<(input: { rootPath: string; workspace?: string; name: string }) => SkillOrigin | undefined> {
    const state = await this.state();
    const index = installIndex(state);
    const dshRoot = join(this.deps.dshHome(), "skills");
    const agentsRoot = join(this.deps.agentsHome(), "skills");
    return (input) => {
      let root: InstallRoot | undefined;
      if (resolve(input.rootPath) === resolve(dshRoot)) root = "dsh";
      else if (resolve(input.rootPath) === resolve(agentsRoot)) root = "agents";
      else root = "workspace";
      const record = index.get(installKey(root, root === "workspace" ? input.workspace : undefined, input.name));
      if (record === undefined) return undefined;
      return this.originFromInstall(record);
    };
  }

  /** 安装记录 → 展示用来源。 */
  originFromInstall(record: DiscoverInstall): SkillOrigin {
    if (record.kind === "repo") {
      return { kind: "repo", label: record.origin, ...(record.url === undefined ? {} : { url: record.url }), ...(record.commit === undefined ? {} : { commit: record.commit }) };
    }
    if (record.kind === "clawhub") return { kind: "clawhub", label: record.origin };
    return { kind: "skillsh", label: record.origin };
  }

  /** 列出所有安装记录（供 UI 显示「哪些技能是装来的」）。 */
  async installs(): Promise<DiscoverInstall[]> {
    return (await this.state()).installs;
  }

  /** 卸载一个「发现技能」装出来的技能：删除文件并清掉安装记录。 */
  async uninstall(input: { id?: unknown }): Promise<{ removed: boolean }> {
    const id = typeof input.id === "string" ? input.id : "";
    if (id === "") throw failure("缺少安装记录标识", "error.repo.invalid");
    const state = await this.state();
    const record = state.installs.find((item) => item.id === id);
    if (record === undefined) return { removed: false };
    const targetPath =
      record.root === "dsh"
        ? join(this.deps.dshHome(), "skills")
        : record.root === "agents"
          ? join(this.deps.agentsHome(), "skills")
          : join(record.workspace as string, ".dsh", "skills");
    const destDir = join(targetPath, record.name);
    await this.serialize(async () => {
      await rm(destDir, { recursive: true, force: true }).catch(() => undefined);
      const current = await this.state();
      await saveState(this.deps.dshHome(), forgetInstall(current, id));
    });
    return { removed: true };
  }
}

/** 从错误里取错误码（供网关投影成 wire 错误）。 */
export function errorCodeOf(error: unknown): string {
  const coded = error as CodedError | undefined;
  return typeof coded?.code === "string" ? coded.code : "error.repo.invalid";
}

/** 从错误里取 HTTP 风格状态码。 */
export function statusCodeOf(error: unknown): number {
  const coded = error as CodedError | undefined;
  return typeof coded?.statusCode === "number" ? coded.statusCode : 400;
}
