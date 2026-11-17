/**
 * dsh-skill-mcp-panel —— 「发现技能」的数据契约（宿主与客户端共用的唯一来源）。
 *
 * 这一层只放类型与常量，不含 IO，方便被 host、client 与测试同时引用。
 *
 * 设计取舍（与 @michengai/dsh-skills-manager 的差异）：
 *   - 上游把「仓库订阅」「安装记录」「目录安装记录」拆成三套结构并各有历史包袱；
 *     这里统一成一份 `DiscoverState`，安装记录用 `kind` 区分来源，读一次就能
 *     回答「这个技能是从哪装的」。
 *   - 状态文件跟分组配置放在同一个隐藏目录（`.system/skill-viewer/`），
 *     都在技能发现会跳过的 `.system` 区内，不会污染技能目录。
 */

/** 技能安装的目标根。workspace 需同时给出 workspace 路径。 */
export type InstallRoot = "dsh" | "agents" | "workspace";

/** 一次仓库订阅（Git 仓库）。 */
export interface DiscoverRepository {
  /** 由规范化后的仓库来源算出的稳定 id（sha256 前 24 位）。 */
  id: string;
  /** 原始输入（owner/repo 或完整 URL）。 */
  url: string;
  owner: string;
  name: string;
  /** 分支/标签；空串表示默认分支。 */
  ref: string;
  /** 只扫描该子目录；空串表示整仓。 */
  subdirectory: string;
  /**
   * 是否把隐藏目录里的技能也算进来（默认 false）。
   *
   * 有些仓库把同一批技能镜像到 `.openclaw/skills/` 之类的隐藏目录；默认不扫，
   * 避免清单里混进用户不想装的条目。需要时由订阅时显式勾选。
   */
  includeHidden?: boolean;
  /** 上次扫描到的提交；未扫描为 null。 */
  commit: string | null;
  /** 上次扫描完成时间（ISO）；未扫描为 null。 */
  scannedAt: string | null;
  /** 上次扫描失败原因；成功时不存在。 */
  error?: string;
  /** 扫描出的技能清单。 */
  skills: RepositorySkill[];
}

/** 仓库里扫到的一个技能。 */
export interface RepositorySkill {
  name: string;
  description: string;
  /** 仓库内的相对路径（目录束为 `a/b`，单文件为 `a/b.md`）。 */
  path: string;
  /** frontmatter 是否合法。非法条目不可安装。 */
  valid: boolean;
  /** 校验失败原因。 */
  reason?: string;
}

/** 一次安装记录：把某个技能落到某个技能根。 */
export interface DiscoverInstall {
  id: string;
  /** 来源类别。 */
  kind: "repo" | "clawhub" | "skillsh";
  /** 来源标识：repo 为 `owner/repo`，clawhub 为 `owner/slug`，skillsh 为 `source/skillId`。 */
  origin: string;
  /** kind=repo 时对应的仓库订阅 id。 */
  repoId?: string;
  /** 来源地址（repo 为规范化 URL）。 */
  url?: string;
  /** 安装时固定的提交（repo 来源）。 */
  commit?: string;
  /** 落地的技能名（目录名 / 文件名主干）。 */
  name: string;
  root: InstallRoot;
  /** root=workspace 时的项目根路径。 */
  workspace?: string;
  /** 落地文件的相对路径 + 内容 sha256，用于更新与卸载校验。 */
  files: { path: string; hash: string }[];
  installedAt: string;
  /**
   * 意图态：记录已写盘但文件尚未确认就位（安装进行中，或上次安装中途崩溃）。
   *
   * 为什么要这个字段：状态与文件系统是两次独立的写，中间必有崩溃窗口。
   * 先写意图再落地文件，重启后能区分「装了一半」与「装好了」——
   * 前者不当作已安装（列表不显示、来源不生效），但**视为本插件所有**，
   * 于是重装可以直接覆盖，不会撞上「同名技能已存在」的假冲突。
   */
  pending?: boolean;
}

/** 状态文件根结构。 */
export interface DiscoverState {
  version: 1;
  repositories: DiscoverRepository[];
  installs: DiscoverInstall[];
}

/** 来源归属（技能行上展示的「这个技能从哪来」）。 */
export type SkillOrigin =
  | { kind: "repo"; label: string; url?: string; commit?: string }
  | { kind: "clawhub"; label: string }
  | { kind: "skillsh"; label: string }
  | { kind: "lock"; label: string; url?: string }
  | { kind: "market"; label: string };

/** 状态文件版本号。 */
export const DISCOVER_VERSION = 1 as const;

/** 护栏：单仓技能数、订阅数、安装记录数、文件数与体积上限。 */
export const LIMITS = {
  /** 最多订阅多少个仓库。 */
  maxRepositories: 30,
  /** 单仓最多扫出多少技能。 */
  maxRepositorySkills: 500,
  /** 最多保留多少条安装记录。 */
  maxInstalls: 2000,
  /** 单次安装最多文件数。 */
  maxInstallFiles: 1000,
  /**
   * 单次安装总字节上限。
   *
   * 为什么从 8MB 提到 32MB：真实技能包会带示例工程、素材与二进制（archify 就
   * 有 18MB / 206 个文件，canvas-design 6MB / 83 个文件）。8MB 这条线原本是
   * 照抄 addSkill 的上传护栏，但「从仓库安装」走的是本地磁盘到本地磁盘，
   * 不经过浏览器上传，没必要用那么紧的额度。
   */
  maxInstallBytes: 32 * 1024 * 1024,
  /** 状态文件读取上限。 */
  maxStateBytes: 16 * 1024 * 1024,
  /** 目录详情正文上限。 */
  maxDetailBytes: 1 * 1024 * 1024
} as const;

/** 仓库扫描的抓取配额。 */
export const FETCH_LIMITS = {
  /** 检出后工作树体积上限。 */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /** 抓取期间临时体积上限（含 Git 对象）。 */
  maxTransientBytes: 5 * 1024 * 1024 * 1024,
  /** 整次抓取超时。 */
  timeoutMs: 900_000
} as const;

/** 目录来源的固定标识。 */
export const CATALOG_KINDS = ["clawhub", "skillsh"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];
