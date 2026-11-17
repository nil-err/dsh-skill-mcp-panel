/**
 * dsh-skill-mcp-panel —— Git 仓库订阅的解析、抓取与技能扫描。
 *
 * 移植自 @michengai/dsh-skills-manager 的 repository-git.ts，做了三处收紧：
 *   1. 只保留本插件实际要用的能力（订阅 → 抓取 → 扫技能），去掉批量预检/回滚。
 *   2. 抓取一律走「部分克隆 + 稀疏检出」：先取提交与目录树，只把含 SKILL.md
 *      的目录写进工作树。服务端不支持过滤时逐级退化为浅克隆与完整检出。
 *   3. 所有子进程都禁掉凭据助手与终端交互：只支持公开仓库，避免 Git 弹窗把
 *      插件进程挂死。
 *
 * 安全边界（与上游一致，缺一不可）：
 *   - 仓库地址不接受用户名/密码、不接受 `::`（防 ext:: 传输）、不接受前导 `-`；
 *   - 稀疏检出规则里的目录名必须过 `safePath`：仓库里的目录名会直接进 Git；
 *   - 下载期就盯住暂存目录体积，超配额立刻杀进程，不等下载完再判断。
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { FETCH_LIMITS } from "./discover-types.js";

/** 带 code/statusCode 的错误（与插件其它模块的错误形状一致）。 */
export type CodedError = Error & { code?: string; statusCode?: number; params?: Record<string, unknown> };

/** 构造带错误码的失败。 */
export function failure(message: string, code = "error.repo.invalid", params?: Record<string, unknown>): CodedError {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
    ...(params !== undefined && typeof params === "object" && !Array.isArray(params) ? { params } : {})
  });
}

/** 仓库来源（规范化之后）。 */
export interface RepositorySource {
  owner: string;
  name: string;
  ref: string;
  subdirectory: string;
  /** 原始输入地址（本地路径或 URL）。 */
  url?: string;
}

/** 仓库来源输入（来自 UI）。 */
export interface RepositoryInput {
  url?: unknown;
  ref?: unknown;
  subdirectory?: unknown;
}

const MAX_URL_LENGTH = 2048;
const MAX_REF_LENGTH = 200;
const MAX_PATH_LENGTH = 512;
const MAX_PATH_SEGMENTS = 64;

/** 仓库内相对路径的安全校验：拒绝绝对路径、`..`、Windows 保留名与非法字符。 */
export function safePath(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH || (value === "" && !allowEmpty)) {
    throw failure("仓库路径无效");
  }
  if (value === "") return "";
  const parts = value.split("/");
  if (
    parts.length > MAX_PATH_SEGMENTS ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        /[\\:<>"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  ) {
    throw failure("仓库路径不安全");
  }
  return value;
}

/** 校验分支/标签名：只允许 Git ref 常见字符，拒绝 `..`、前导/尾随斜杠。 */
function safeRef(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_REF_LENGTH) throw failure("仓库分支无效");
  if (value === "") return "";
  if (!/^[a-zA-Z0-9_./-]+$/.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/")) {
    throw failure("仓库分支无效");
  }
  return value;
}

/**
 * 把用户输入解析成仓库来源。支持三种形态：
 *   1. GitHub 简写 `owner/repo`
 *   2. GitHub / 通用 HTTPS 仓库 URL（含 `tree/<ref>/<subdir>` 形式）
 *   3. 本地绝对路径（测试与私有磁盘用）
 */
export function parseGitUrl(input: RepositoryInput = {}): RepositorySource {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw failure("仓库参数必须是对象");
  if (input.ref !== undefined && typeof input.ref !== "string") throw failure("仓库分支必须是字符串");
  if (input.subdirectory !== undefined && typeof input.subdirectory !== "string") throw failure("仓库子目录必须是字符串");

  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (raw === "" || raw.length > MAX_URL_LENGTH || /[%?#\s]/.test(raw)) throw failure("仓库地址无效");
  if (raw.startsWith("-") || raw.includes("::")) throw failure("仓库地址不安全");
  // 只支持公开仓库：URL 里带账号密码一律拒绝，避免把凭据写进状态文件。
  if (/@/.test(raw)) throw failure("仓库地址不能包含用户名或密码");
  const isLocalPath = raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw);
  if (!isLocalPath && /\\/.test(raw)) throw failure("仓库地址无效");

  // 本地目录：owner 取父目录名、name 取自身名，仅用于展示与去重。
  if (isLocalPath) {
    const normalized = raw.replace(/\\/g, "/").replace(/\/$/, "");
    const parts = normalized.split("/");
    const name = (parts.pop() || "").replace(/\.git$/, "").toLowerCase();
    const owner = (parts.pop() || "local").toLowerCase();
    if (name === "" || name === "." || name === "..") throw failure("仓库名称无效");
    return { owner, name, ref: safeRef(input.ref), subdirectory: safePath(input.subdirectory || "", true), url: raw };
  }

  // GitHub 简写 owner/repo
  if (!raw.includes("://")) {
    const parts = raw.replace(/\/$/, "").split("/");
    if (parts.length !== 2) throw failure("请输入公开 Git 仓库地址或 owner/repo");
    const owner = (parts[0] || "").toLowerCase();
    const name = (parts[1] || "").replace(/\.git$/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(owner) || !/^[a-z0-9_.-]{1,100}$/.test(name) || name === "." || name === "..") {
      throw failure("请输入公开 Git 仓库地址或 owner/repo");
    }
    return { owner, name, ref: safeRef(input.ref), subdirectory: safePath(input.subdirectory || "", true) };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw failure("仓库地址无效");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw failure("仅支持 HTTP 或 HTTPS 协议的 Git 仓库地址");
  }
  if (parsed.username !== "" || parsed.password !== "") throw failure("仓库地址不能包含用户名或密码");
  if (parsed.hostname === "" || parsed.hostname.startsWith("-")) throw failure("仓库地址无效");

  // 从 `tree/<ref>/<subdir>` 一类 UI 链接里解出分支与子目录。
  let pathname = parsed.pathname;
  let extractedRef = "";
  let extractedSubdirectory = "";
  const treeMarkers = ["/-/tree/", "/-/blob/", "/src/branch/", "/src/tag/", "/tree/"];
  for (const marker of treeMarkers) {
    const index = pathname.indexOf(marker);
    if (index === -1) continue;
    const rest = pathname.slice(index + marker.length);
    pathname = pathname.slice(0, index);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      extractedRef = decodeURIComponent(rest);
    } else {
      extractedRef = decodeURIComponent(rest.slice(0, slash));
      extractedSubdirectory = decodeURIComponent(rest.slice(slash + 1));
    }
    break;
  }

  pathname = pathname.replace(/\/$/, "");
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) throw failure("仓库地址无效");
  const name = (segments[segments.length - 1] || "").replace(/\.git$/, "").toLowerCase();
  if (name === "" || name === "." || name === "..") throw failure("仓库名称无效");
  const ownerSegments = segments.slice(0, -1);
  const owner = (ownerSegments.length > 0 ? ownerSegments.join("/") : parsed.hostname).toLowerCase();

  return {
    owner,
    name,
    ref: safeRef(input.ref !== undefined && input.ref !== "" ? input.ref : extractedRef),
    subdirectory: safePath(input.subdirectory !== undefined && input.subdirectory !== "" ? input.subdirectory : extractedSubdirectory, true),
    url: raw
  };
}

/** 解析后来源的稳定标识（用于订阅 id 与去重）。 */
export function repositoryIdentity(source: RepositorySource): string {
  return JSON.stringify({ owner: source.owner, name: source.name, ref: source.ref, subdirectory: source.subdirectory });
}

// ── Git 子进程 ────────────────────────────────────────────────────────────

interface RunGitOptions {
  timeoutMs?: number;
  input?: string;
  /** 下载/检出期间盯住该目录体积，超配额立刻杀进程。 */
  quota?: { dir: string; limit: number };
}

/** 杀整棵子进程树（Git 会派生 index-pack / fetch-pack 等子进程）。 */
function killProcessTree(child: ChildProcess): void {
  if (typeof child.pid !== "number") return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      return;
    } catch {
      child.kill("SIGKILL");
      return;
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** 把 Git 的英文 stderr 归类成本插件的错误码与中文提示。 */
function mapGitError(stderr: string): CodedError {
  const low = stderr.toLowerCase();
  if (
    low.includes("could not read username") ||
    low.includes("terminal prompts disabled") ||
    low.includes("authentication failed") ||
    low.includes("permission denied")
  ) {
    return failure("Git 仓库需要鉴权或无权访问，请确认仓库公开可访问", "error.repo.network");
  }
  if (
    low.includes("couldn't find remote ref") ||
    low.includes("unknown revision") ||
    low.includes("not found") ||
    low.includes("does not appear to be a git repository")
  ) {
    return failure("Git 仓库或分支不存在", "error.repo.network");
  }
  if (
    low.includes("could not resolve host") ||
    low.includes("connection refused") ||
    low.includes("network is unreachable") ||
    low.includes("timed out") ||
    low.includes("failed to connect")
  ) {
    return failure("无法连接到 Git 仓库，请检查网络或加速地址", "error.repo.network");
  }
  const line = stderr.trim().split("\n").pop() || "";
  return failure(line !== "" ? "Git 请求失败: " + line : "Git 请求失败，请检查网络或仓库地址", "error.repo.network");
}

/** 执行一次 Git 命令；带超时、配额看门狗与进程树清理。 */
function runGit(args: string[], cwd: string, options: RunGitOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c", "protocol.ext.allow=never",
        "-c", "core.symlinks=false",
        "-c", "core.autocrlf=false",
        // 技能目录层级深时，Windows 默认 260 字符上限会让检出直接失败。
        "-c", "core.longpaths=true",
        "-c", "advice.detachedHead=false",
        // 只支持公开仓库：禁用凭据助手，避免凭据管理器弹窗把插件进程挂死。
        "-c", "credential.helper=",
        "-c", "http.lowSpeedLimit=1000",
        "-c", "http.lowSpeedTime=30",
        ...args
      ],
      {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "echo",
          LC_ALL: "C",
          LANGUAGE: "C"
        },
        stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32"
      }
    );

    let stdout = "";
    let stderr = "";
    let killed = false;

    if (options.input !== undefined && child.stdin !== null) {
      // Git 在读到输入前就退出（例如不认识该子命令）时会 EPIPE，不能让它变成未捕获异常。
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }

    let measuring = false;
    const quota = options.quota;
    const watchdog =
      quota === undefined
        ? undefined
        : setInterval(() => {
            if (measuring || killed) return;
            measuring = true;
            directorySize(quota.dir).then(
              (size) => {
                measuring = false;
                if (killed || size <= quota.limit) return;
                killed = true;
                killProcessTree(child);
                reject(failure("仓库临时下载体积过大（包含 Git 历史对象）", "error.repo.transientTooLarge", { limit: quota.limit, actual: size }));
              },
              () => {
                measuring = false;
              }
            );
          }, 800);
    const stopWatchdog = () => {
      if (watchdog !== undefined) clearInterval(watchdog);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      killed = true;
      stopWatchdog();
      killProcessTree(child);
      reject(failure("Git 请求超时，请检查网络后重试", "error.repo.network"));
    }, timeoutMs);

    child.on("error", (error: unknown) => {
      clearTimeout(timer);
      stopWatchdog();
      if (killed) return;
      const code = (error as { code?: string })?.code;
      if (code === "ENOENT") {
        reject(failure("未检测到 Git 命令行工具，请先安装 Git 后重试", "error.repo.noGit"));
      } else {
        reject(failure("无法启动 Git: " + (error as Error).message, "error.repo.network"));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      stopWatchdog();
      if (killed) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(mapGitError(stderr || stdout));
    });
  });
}

/** 递归统计目录体积（跳过符号链接，避免环路）。 */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const info = await fs.lstat(full).catch(() => undefined);
        if (info !== undefined) total += info.size;
      }
    }
  };
  await walk(dir);
  return total;
}

async function rmWithRetry(target: string, retries = 10, delay = 50): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      const code = (error as { code?: string })?.code;
      if (i === retries - 1 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** 磁盘预检的固定下限：配额再大也要留够余量再开跑。 */
const DISK_PREFLIGHT_BYTES = 256 << 20;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
}

/** statfs 不可用的平台跳过预检，不因此阻断仓库功能。 */
async function ensureDiskSpace(dir: string, requiredBytes: number): Promise<void> {
  let free: number;
  try {
    const stats = await fs.statfs(dir);
    free = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return;
  }
  if (!Number.isFinite(free) || free >= requiredBytes) return;
  throw failure("磁盘剩余空间不足（剩余 " + formatBytes(free) + "，至少需要 " + formatBytes(requiredBytes) + "）", "error.repo.disk", {
    available: free,
    required: requiredBytes
  });
}

/** 仓库里一个技能都没有时用的规则：匹配不到任何路径，避免为「没有技能」下载整库。 */
const EMPTY_CHECKOUT_PATTERN = "/.dsh-skill-mcp-panel-empty/**";
const SKILL_DOC_SUFFIX = "/SKILL.md";

/** 目录名里的 [ ] 在检出规则里是字符类，必须转义成字面量。 */
function checkoutPatternFor(directory: string): string {
  return "/" + directory.replace(/[[\]]/g, "\\$&") + "/**";
}

/**
 * 把仓库文件清单换算成稀疏检出规则，只覆盖含 SKILL.md 的技能目录。
 * 根级 SKILL.md 代表技能包含整库文件，返回 null 表示必须完整检出。
 */
export function skillCheckoutPatterns(paths: string[], subdirectory = ""): string[] | null {
  const collected: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path === "") continue;
    if (path === "SKILL.md") return null;
    if (!path.endsWith(SKILL_DOC_SUFFIX)) continue;
    const directory = path.slice(0, -SKILL_DOC_SUFFIX.length);
    if (directory === "") continue;
    if (subdirectory !== "" && directory !== subdirectory && !directory.startsWith(subdirectory + "/")) continue;
    safePath(directory);
    collected.push(directory);
  }
  if (collected.length === 0) return [EMPTY_CHECKOUT_PATTERN];
  const directories = [...new Set(collected)].sort();
  return directories
    .filter((directory) => !directories.some((other) => other !== directory && directory.startsWith(other + "/")))
    .map(checkoutPatternFor);
}

/** 清单来自目录树对象，部分克隆下不触发任何 blob 下载。 */
async function listTreePaths(destinationDir: string, revision: string, timeoutMs: number): Promise<string[]> {
  const { stdout } = await runGit(["ls-tree", "-r", "-z", "--name-only", "--", revision], destinationDir, { timeoutMs });
  return stdout.split("\0").filter(Boolean);
}

/** 老版本 Git 可能连 sparse-checkout 子命令都没有，因此只回退配置与规则文件。 */
async function clearSparseCheckout(destinationDir: string, timeoutMs: number): Promise<void> {
  for (const key of ["core.sparseCheckout", "core.sparseCheckoutCone"]) {
    await runGit(["config", "--unset-all", key], destinationDir, { timeoutMs }).catch(() => undefined);
  }
  await fs.rm(join(destinationDir, ".git", "info", "sparse-checkout"), { force: true }).catch(() => undefined);
}

/** 目录树自带大小，只有 blob 已在本地时才可读；部分克隆下 `-l` 会触发逐个拉取，不能走这条路。 */
async function sumTreeBlobBytes(destinationDir: string, revision: string, timeoutMs: number): Promise<number> {
  const { stdout } = await runGit(["ls-tree", "-r", "-l", "-z", "--", revision], destinationDir, { timeoutMs });
  let total = 0;
  for (const record of stdout.split("\u0000")) {
    const size = /^\d{6} blob [0-9a-f]{40,64}\s+(\d+)\t/.exec(record);
    if (size !== null) total += Number(size[1]);
  }
  return total;
}

/**
 * 抓取一个仓库到 `destinationDir`，返回固定的提交号。
 *
 * 策略：`fetch --depth 1 --filter=blob:none` → 读目录树 → 用稀疏检出只落技能目录
 * → `checkout FETCH_HEAD`。任一步不被服务端/本地 Git 支持就退化为浅克隆、再退化为完整克隆。
 */
export async function fetchGitRepository(
  source: RepositorySource,
  destinationDir: string,
  options: { maxBytes?: number; maxTransientBytes?: number; timeoutMs?: number } = {}
): Promise<{ commit: string }> {
  const maxBytes = options.maxBytes ?? FETCH_LIMITS.maxBytes;
  const maxTransientBytes = options.maxTransientBytes ?? FETCH_LIMITS.maxTransientBytes;
  const deadline = Date.now() + (options.timeoutMs ?? FETCH_LIMITS.timeoutMs);
  const remaining = (): number => {
    const remain = deadline - Date.now();
    if (remain <= 0) throw failure("Git 请求超时，请检查网络后重试", "error.repo.network");
    return remain;
  };
  const repoUrl = source.url !== undefined && /^https?:|^\//.test(source.url) ? source.url : "https://github.com/" + source.owner + "/" + source.name + ".git";
  const ref = source.ref !== "" && source.ref !== "HEAD" ? source.ref : "HEAD";

  await fs.mkdir(destinationDir, { recursive: true });
  await ensureDiskSpace(destinationDir, Math.min(maxTransientBytes, DISK_PREFLIGHT_BYTES));

  try {
    await runGit(["init", "-q"], destinationDir, { timeoutMs: remaining() });
    // 按需取回 blob 需要具名远端，因此这里不能用 `fetch <url>` 的无远端写法。
    await runGit(["remote", "add", "origin", repoUrl], destinationDir, { timeoutMs: remaining() });

    const refsToTry = ref === "HEAD" ? ["HEAD"] : ["refs/heads/" + ref, "refs/tags/" + ref, ref];
    let fetched = false;
    let filtered = false;
    let lastError: unknown;
    for (const candidate of refsToTry) {
      try {
        await runGit(["fetch", "--progress", "--depth", "1", "--no-tags", "--filter=blob:none", "--", "origin", candidate], destinationDir, {
          timeoutMs: remaining(),
          quota: { dir: destinationDir, limit: maxTransientBytes }
        });
        fetched = true;
        filtered = true;
        break;
      } catch (error) {
        lastError = error;
        try {
          await runGit(["fetch", "--progress", "--depth", "1", "--no-tags", "--", "origin", candidate], destinationDir, {
            timeoutMs: remaining(),
            quota: { dir: destinationDir, limit: maxTransientBytes }
          });
          fetched = true;
          break;
        } catch (second) {
          lastError = second;
          if (candidate === refsToTry[refsToTry.length - 1]) {
            try {
              await runGit(["fetch", "--progress", "--no-tags", "--", "origin", candidate], destinationDir, {
                timeoutMs: remaining(),
                quota: { dir: destinationDir, limit: maxTransientBytes }
              });
              fetched = true;
            } catch {
              throw second;
            }
          }
        }
      }
    }
    if (!fetched) throw lastError instanceof Error ? lastError : failure("Git 分支或标签不存在", "error.repo.network");

    const { stdout: commitOut } = await runGit(["rev-parse", "FETCH_HEAD^{commit}"], destinationDir, { timeoutMs: remaining() });
    const commit = commitOut.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw failure("无法解析仓库提交号", "error.repo.network");

    // 没命中过滤时 blob 已全在本地，可以在写工作树之前就把超限仓库挡掉。
    if (!filtered) {
      const bytes = await sumTreeBlobBytes(destinationDir, "FETCH_HEAD", remaining());
      if (bytes > maxBytes) throw failure("仓库超过大小限制", "error.repo.tooLarge", { limit: maxBytes, actual: bytes });
    }

    const patterns = skillCheckoutPatterns(await listTreePaths(destinationDir, "FETCH_HEAD", remaining()), source.subdirectory);
    if (patterns !== null) {
      try {
        // 规则经标准输入传入：技能目录很多时命令行长度会在 Windows 上先撑不住。
        await runGit(["sparse-checkout", "set", "--no-cone", "--stdin"], destinationDir, {
          timeoutMs: remaining(),
          input: patterns.join("\n") + "\n"
        });
      } catch (error) {
        const code = (error as CodedError)?.code;
        // Git 本身不可用必须原样上抛；只是不认识稀疏检出则清掉半写规则，退回完整检出。
        if (code === "error.repo.noGit" || code === "error.repo.network" || code === "error.repo.transientTooLarge") throw error;
        await clearSparseCheckout(destinationDir, remaining());
      }
    }

    await runGit(["checkout", "-q", "FETCH_HEAD"], destinationDir, {
      timeoutMs: remaining(),
      quota: { dir: destinationDir, limit: maxTransientBytes }
    });

    const rawSize = await directorySize(destinationDir);
    if (rawSize > maxTransientBytes) {
      throw failure("仓库临时下载体积过大（包含 Git 历史对象）", "error.repo.transientTooLarge", { limit: maxTransientBytes, actual: rawSize });
    }

    await rmWithRetry(join(destinationDir, ".git"));
    const totalSize = await directorySize(destinationDir);
    if (totalSize > maxBytes) throw failure("仓库超过大小限制", "error.repo.tooLarge", { limit: maxBytes, actual: totalSize });

    return { commit };
  } catch (error) {
    await rmWithRetry(destinationDir).catch(() => undefined);
    throw error;
  }
}

/** 探测远端可达性（不落盘）：用于「添加仓库」时的快速校验。 */
export async function probeGitRemote(repoUrl: string, options: { timeoutMs?: number } = {}): Promise<void> {
  try {
    await runGit(["ls-remote", "--heads", "-q", "--", repoUrl], process.cwd(), { timeoutMs: options.timeoutMs ?? 30_000 });
  } catch (error) {
    const coded = error as CodedError;
    // 保留缺 Git 的专用错误码：没装 Git 时要提示安装，而不是说仓库不存在。
    if (coded?.code === "error.repo.noGit") throw coded;
    throw failure(coded.message || "仓库无法访问或不存在，请检查地址或权限", "error.repo.network");
  }
}

/** 仓库抓取用的临时工作目录名（在系统临时目录下，抓完即删）。 */
export function tempCheckoutDir(baseTmp: string, id: string): string {
  return join(baseTmp, "dsh-skill-mcp-panel-repo-" + id.slice(0, 16));
}
