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
/** 状态文件版本号。 */
export const DISCOVER_VERSION = 1;
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
};
/** 仓库扫描的抓取配额。 */
export const FETCH_LIMITS = {
    /** 检出后工作树体积上限。 */
    maxBytes: 2 * 1024 * 1024 * 1024,
    /** 抓取期间临时体积上限（含 Git 对象）。 */
    maxTransientBytes: 5 * 1024 * 1024 * 1024,
    /** 整次抓取超时。 */
    timeoutMs: 900_000
};
/** 目录来源的固定标识。 */
export const CATALOG_KINDS = ["clawhub", "skillsh"];
