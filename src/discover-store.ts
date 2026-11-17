/**
 * dsh-skill-mcp-panel —— 「发现技能」状态文件的读写与安装记录维护。
 *
 * 位置：`<dshHome>/skills/.system/skill-viewer/discover.json`（与 groups.json 同目录，
 * 在技能发现会跳过的 `.system` 区内）。
 *
 * 三条不变量：
 *   1. 读失败一律降级为空状态，绝不让「状态文件坏了」变成「页面打不开」；
 *      写失败必须上抛，让用户知道这次安装没被记住。
 *   2. 任何写都走原子替换（writeFileAtomic），并发写不会互相截断。
 *   3. 状态里只存可重建的元数据（订阅、提交号、文件摘要），技能正文永远在技能根里。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./fs-utils.js";
import {
  DISCOVER_VERSION,
  LIMITS,
  type DiscoverInstall,
  type DiscoverRepository,
  type DiscoverState,
  type RepositorySkill
} from "./discover-types.js";

/** 状态文件所在目录（与分组配置同目录）。 */
export function discoverRoot(dshHome: string): string {
  return join(dshHome, "skills", ".system", "skill-viewer");
}

/** 状态文件完整路径。 */
export function discoverFile(dshHome: string): string {
  return join(discoverRoot(dshHome), "discover.json");
}

/** 空状态。 */
export function emptyState(): DiscoverState {
  return { version: DISCOVER_VERSION, repositories: [], installs: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 40 ? value : null;
}

/** 校验并清洗一条仓库技能；非法条目直接丢弃（宁可少列，不可让 UI 拿到脏数据）。 */
function cleanSkill(value: unknown): RepositorySkill | undefined {
  if (!isObject(value)) return undefined;
  const name = str(value.name, 128);
  const path = str(value.path, 1024);
  if (name === undefined || name === "" || path === undefined) return undefined;
  const description = typeof value.description === "string" && value.description.length <= 8192 ? value.description : "";
  const valid = value.valid === true;
  const reason = typeof value.reason === "string" && value.reason.length <= 512 ? value.reason : undefined;
  return { name, description, path, valid, ...(reason === undefined ? {} : { reason }) };
}

/** 校验并清洗一条仓库订阅。 */
function cleanRepository(value: unknown): DiscoverRepository | undefined {
  if (!isObject(value)) return undefined;
  const id = str(value.id, 64);
  const url = str(value.url, 2048);
  const owner = str(value.owner, 128);
  const name = str(value.name, 128);
  if (id === undefined || url === undefined || owner === undefined || name === undefined) return undefined;
  const ref = typeof value.ref === "string" && value.ref.length <= 200 ? value.ref : "";
  const subdirectory = typeof value.subdirectory === "string" && value.subdirectory.length <= 512 ? value.subdirectory : "";
  const includeHidden = value.includeHidden === true;
  const commit = typeof value.commit === "string" && /^[a-f0-9]{40,64}$/.test(value.commit) ? value.commit : null;
  const skills = Array.isArray(value.skills)
    ? value.skills.slice(0, LIMITS.maxRepositorySkills).map(cleanSkill).filter((s): s is RepositorySkill => s !== undefined)
    : [];
  const error = typeof value.error === "string" && value.error.length <= 1024 ? value.error : undefined;
  return {
    id,
    url,
    owner,
    name,
    ref,
    subdirectory,
    ...(includeHidden ? { includeHidden: true } : {}),
    commit,
    scannedAt: isoOrNull(value.scannedAt),
    ...(error === undefined ? {} : { error }),
    skills
  };
}

/** 校验并清洗一条安装记录。 */
function cleanInstall(value: unknown): DiscoverInstall | undefined {
  if (!isObject(value)) return undefined;
  const id = str(value.id, 128);
  const kind = value.kind;
  const origin = str(value.origin, 512);
  const name = str(value.name, 128);
  const root = value.root;
  if (id === undefined || origin === undefined || name === undefined) return undefined;
  if (kind !== "repo" && kind !== "clawhub" && kind !== "skillsh") return undefined;
  if (root !== "dsh" && root !== "agents" && root !== "workspace") return undefined;
  const workspace = typeof value.workspace === "string" && value.workspace !== "" && value.workspace.length <= 1024 ? value.workspace : undefined;
  // workspace 根必须带工作区路径，否则记录无法定位落地位置。
  if (root === "workspace" && workspace === undefined) return undefined;
  const files = Array.isArray(value.files)
    ? value.files
        .slice(0, LIMITS.maxInstallFiles)
        .map((file) => {
          if (!isObject(file)) return undefined;
          const path = str(file.path, 1024);
          const hash = str(file.hash, 64);
          if (path === undefined || hash === undefined || !/^[a-f0-9]{64}$/.test(hash)) return undefined;
          return { path, hash };
        })
        .filter((f): f is { path: string; hash: string } => f !== undefined)
    : [];
  const installedAt = isoOrNull(value.installedAt) ?? new Date(0).toISOString();
  const repoId = str(value.repoId, 64);
  const url = str(value.url, 2048);
  const commit = typeof value.commit === "string" && /^[a-f0-9]{40,64}$/.test(value.commit) ? value.commit : undefined;
  return {
    id,
    kind,
    origin,
    ...(repoId === undefined ? {} : { repoId }),
    ...(url === undefined ? {} : { url }),
    ...(commit === undefined ? {} : { commit }),
    name,
    root,
    ...(workspace === undefined ? {} : { workspace }),
    files,
    installedAt,
    ...(value.pending === true ? { pending: true } : {})
  };
}

/**
 * 读取状态；文件缺失、损坏、超限或版本不符时返回空状态。
 * 绝不抛错：调用方（列表、安装）不应该因为状态文件问题而失败。
 */
export async function loadState(dshHome: string): Promise<DiscoverState> {
  let raw: string;
  try {
    const buffer = await readFile(discoverFile(dshHome));
    if (buffer.length > LIMITS.maxStateBytes) return emptyState();
    raw = buffer.toString("utf8");
  } catch {
    return emptyState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!isObject(parsed) || parsed.version !== DISCOVER_VERSION) return emptyState();
  const repositories = Array.isArray(parsed.repositories)
    ? parsed.repositories
        .slice(0, LIMITS.maxRepositories)
        .map(cleanRepository)
        .filter((r): r is DiscoverRepository => r !== undefined)
    : [];
  const installs = Array.isArray(parsed.installs)
    ? parsed.installs
        .slice(0, LIMITS.maxInstalls)
        .map(cleanInstall)
        .filter((i): i is DiscoverInstall => i !== undefined)
    : [];
  return { version: DISCOVER_VERSION, repositories, installs };
}

/** 原子写入状态；调用方负责先做容量校验。写失败上抛。 */
export async function saveState(dshHome: string, state: DiscoverState): Promise<void> {
  const payload = JSON.stringify({ version: DISCOVER_VERSION, repositories: state.repositories, installs: state.installs }, void 0, 2) + "\n";
  await writeFileAtomic(discoverFile(dshHome), payload);
}

/** 按仓库来源替换（或追加）一条订阅。 */
export function upsertRepository(state: DiscoverState, repo: DiscoverRepository): DiscoverState {
  const index = state.repositories.findIndex((item) => item.id === repo.id);
  const repositories = index === -1
    ? [...state.repositories, repo]
    : state.repositories.map((item, i) => (i === index ? repo : item));
  return { ...state, repositories };
}

/** 移除一条订阅（不动已安装的技能文件）。 */
export function removeRepository(state: DiscoverState, id: string): DiscoverState {
  return {
    ...state,
    repositories: state.repositories.filter((item) => item.id !== id),
    // 安装记录保留：卸载/更新仍要能定位落地位置与来源。
    installs: state.installs
  };
}

/** 找某（来源, 落地根, 工作区, 名称）对应的安装记录。 */
export function findInstall(
  state: DiscoverState,
  match: { origin: string; root: DiscoverInstall["root"]; workspace?: string; name: string }
): DiscoverInstall | undefined {
  return state.installs.find(
    (item) =>
      item.origin === match.origin &&
      item.root === match.root &&
      item.name === match.name &&
      (item.workspace ?? "") === (match.workspace ?? "")
  );
}

/** 写入（或覆盖）一条安装记录。 */
export function recordInstall(state: DiscoverState, install: DiscoverInstall): DiscoverState {
  const installs = state.installs.filter((item) => item.id !== install.id);
  return { ...state, installs: [...installs, install].slice(-LIMITS.maxInstalls) };
}

/**
 * 按落地位置清掉旧记录。
 *
 * 一个技能根里同一个名字只能有一份实体，所以「位置」才是安装记录的真实主键；
 * id 只是它的一种派生。重装前必须先清位置，否则一条崩溃留下的旧 id 记录会和
 * 新记录并存，列表里出现两条来源。
 */
export function forgetAtLocation(
  state: DiscoverState,
  location: { root: DiscoverInstall["root"]; workspace?: string; name: string }
): DiscoverState {
  const key = installKey(location.root, location.workspace, location.name);
  return {
    ...state,
    installs: state.installs.filter((item) => installKey(item.root, item.workspace, item.name) !== key)
  };
}

/** 删除一条安装记录（卸载后调用）。 */
export function forgetInstall(state: DiscoverState, id: string): DiscoverState {
  return { ...state, installs: state.installs.filter((item) => item.id !== id) };
}

/**
 * 来源归属查询表：按（落地根, 工作区, 技能名）索引安装记录。
 * 技能列表每行查一次，避免 O(行数 × 记录数)。
 */
export function installIndex(state: DiscoverState): Map<string, DiscoverInstall> {
  const map = new Map<string, DiscoverInstall>();
  for (const item of state.installs) {
    // pending 记录是「意图」不是「已安装」：不能让它把技能标成装好了。
    if (item.pending === true) continue;
    map.set(installKey(item.root, item.workspace, item.name), item);
  }
  return map;
}

/**
 * 本插件拥有的所有落地位置（含 pending）。
 *
 * 冲突判定要用这份而不是 installIndex：一次崩溃留下的 pending 记录说明
 * 目录里那半份文件是我们自己写的，重装应当直接覆盖，而不是报「同名技能已存在」。
 */
export function ownedIndex(state: DiscoverState): Map<string, DiscoverInstall> {
  const map = new Map<string, DiscoverInstall>();
  for (const item of state.installs) {
    map.set(installKey(item.root, item.workspace, item.name), item);
  }
  return map;
}

/** 索引键：落地根 + 工作区 + 技能名。 */
export function installKey(root: string, workspace: string | undefined, name: string): string {
  return root + "\u0000" + (workspace ?? "") + "\u0000" + name;
}
