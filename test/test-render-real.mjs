/**
 * 真实 React 渲染测试：用 react-dom/server 把面板每一页都真渲染一遍。
 *
 * 为什么必须存在：`test-panel-slots.mjs` 用桩 jsx（`{ type, props }` 普通对象），
 * 既不执行组件、也不校验 props 形状。于是「`jsxs(Fragment, null, children)`」
 * 这类错误——把 children 数组传给了 key 参数、props 传成 null——能全绿通过，
 * 而浏览器里 React 读 `props.children` 直接抛错，主窗口白屏。
 * 这个文件是那道闸门：真实 React + 真实 primitives 形状，形状错了立刻抛。
 *
 * 依赖：react / react-dom 由 `npm install --no-save` 提供（不进 package.json）。
 * 缺失时跳过并提示，不阻塞其它测试。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0;
let failed = 0;
function pass(name) {
  passed += 1;
  console.log("PASS  " + name);
}
function fail(name, error) {
  failed += 1;
  console.log("FAIL  " + name + "\n      " + (error && error.stack ? error.stack.split("\n").slice(0, 6).join("\n      ") : error));
}
function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

let React;
let ReactDOMServer;
let jsxRuntime;
try {
  React = (await import("react")).default;
  ReactDOMServer = await import("react-dom/server");
  jsxRuntime = await import("react/jsx-runtime");
} catch {
  console.log("SKIP  react / react-dom 未安装，跳过真实渲染测试");
  console.log("      安装方式：npm install --no-save react@18.3.1 react-dom@18.3.1");
  process.exit(0);
}

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let captured = null;
const storage = { value: null };
const sandbox = {
  console,
  document: { querySelector: () => null, createElement: () => ({ dataset: {}, textContent: "" }), head: { appendChild: () => {} } },
  localStorage: { getItem: () => storage.value, setItem: () => {} },
  window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } }
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "lib/client.js" });

// ── 宿主 primitives 桩：形状与真实库一致（都是 React 组件）───────────────
// 真实宿主导出的是组件（函数）；这里给最小可用替身，让真实 React 能渲染。
const IconStub = (props) => React.createElement("i", { "data-icon": "stub", ...props });
const MenuStub = (props) => React.createElement("div", { className: "stub-menu" }, props.children ?? null);
const ButtonStub = (props) => React.createElement("button", props, props.children ?? null);
const InputStub = (props) => React.createElement("input", props);
InputStub.TextArea = (props) => React.createElement("textarea", props);
const SegmentedTabsStub = (props) => React.createElement("div", { className: "stub-tabs" }, (props.items ?? []).map((item) => React.createElement("span", { key: item.value }, item.label)));
const primitivesStub = {
  Menu: MenuStub,
  Button: ButtonStub,
  Input: InputStub,
  SegmentedTabs: SegmentedTabsStub,
  Modal: (props) => React.createElement("div", { className: "stub-modal" }, props.children ?? null),
  Checkbox: (props) => React.createElement("input", { type: "checkbox", checked: props.checked === true }),
  IconSkillOutlineRegular: IconStub,
  IconChevronDownOutlineRegular: IconStub,
  IconChevronLeftOutlineRegular: IconStub,
  IconSearchOutlineRegular: IconStub,
  IconFolderOpenOutlineRegular: IconStub,
  IconPlusOutlineRegular: IconStub,
  IconSettingsOutlineRegular: IconStub,
  IconTrashOutlineRegular: IconStub,
  IconCopyOutlineRegular: IconStub,
  IconProjectAddOutlineRegular: IconStub
};

const requireStub = (specifier) => {
  if (specifier === "react") return React;
  if (specifier === "react/jsx-runtime") return jsxRuntime;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
  throw new Error("unexpected require: " + specifier);
};

// ── 桩宿主：字典 + 槽位账本 ────────────────────────────────────────────────
const dictionaries = new Map();
function makeContext(registrations) {
  return {
    effect: (fn) => {
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    get: () => undefined,
    on: () => () => {},
    locale: {
      register: (namespace, tables) => {
        dictionaries.set(namespace, tables);
        return () => {};
      },
      bind: (namespace) => (key, params) => {
        const tables = dictionaries.get(namespace) ?? { zh: {} };
        let text = (tables.zh ?? tables)[key];
        if (typeof text !== "string") return key;
        for (const [name, value] of Object.entries(params ?? {})) text = text.replace("{" + name + "}", String(value));
        return text;
      },
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 0 })
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      }
    },
    remote: { $mount: async () => undefined, $on: () => () => {} }
  };
}

/** 按给定「上次停留的页签」渲染主页面板，返回 HTML。 */
function renderPanel(tab) {
  storage.value = tab;
  const registrations = [];
  const freshModule = captured.factory(requireStub);
  freshModule.apply(makeContext(registrations));
  const panel = registrations.find((row) => row.options.name === "main");
  assert.ok(panel, "main 槽位必须注册");
  const props = { ...(panel.options.inject ?? {})() };
  return ReactDOMServer.renderToStaticMarkup(React.createElement(panel.component, props));
}

// ── 测试 ───────────────────────────────────────────────────────────────────

check("技能页可真实渲染", () => {
  const html = renderPanel("skills");
  assert.ok(html.length > 0);
  assert.match(html, /SKV_page/);
  assert.match(html, /SKV_section/);
});

check("三个页签都渲染出来", () => {
  const html = renderPanel("skills");
  const tabs = [...html.matchAll(/class="SKV_tab"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["技能", "发现技能", "MCP"]);
});

/**
 * 关键回归：发现页必须能真实渲染。
 *
 * 历史事故：发现页的 `<Fragment>` 写成 `jsxs(Fragment, null, children)`，
 * 桩测试全绿、真实 React 抛 "props is null"，主窗口白屏。
 */
check("发现技能页可真实渲染（历史白屏回归）", () => {
  const html = renderPanel("discover");
  assert.ok(html.length > 0, "发现页渲染出空内容");
  assert.match(html, /DSC_section/, "发现页必须渲染自己的外壳");
  assert.match(html, /DSC_subtabs/, "发现页必须渲染子来源页签");
  assert.match(html, /Git 仓库/, "子来源页签必须含 Git 仓库");
  assert.match(html, /ClawHub/);
  assert.match(html, /skills\.sh/);
});

check("发现页仓库视图渲染出添加按钮与安装位置选择器", () => {
  const html = renderPanel("discover");
  assert.match(html, /DSC_dest/, "必须有安装位置选择器");
  assert.match(html, /DSH skills/);
  assert.match(html, /Shared Agent/);
  assert.match(html, /添加仓库/, "必须有添加仓库入口");
});

check("发现页与 MCP 页同宽（不再退回 760px 窄列）", () => {
  // 事故现象：点「发现技能」后整页突然变窄变小。根因是 cssShell 只给
  // skills / mcp 两个 tab 定义了整宽规则，discover 走了默认的窄列居中。
  const styleText = [...String(source).matchAll(/SKV_page\[data-tab=discover\]/g)].length;
  assert.ok(styleText > 0, "产物里必须有针对 discover 页签的整宽样式");
  const shell = source.match(/SKV_page\[data-tab=skills\][^{]*\{[^}]*align-items:stretch[^}]*\}/);
  assert.ok(shell !== null, "整宽外壳规则必须存在");
  assert.match(shell[0], /discover/, "整宽外壳必须覆盖 discover 页签");
});

check("MCP 页可真实渲染", () => {
  const html = renderPanel("mcp");
  assert.ok(html.length > 0);
  assert.match(html, /MCP_section/);
});

/**
 * 这一条是这次事故的**根因守卫**：扫描产物里所有 Fragment 调用，
 * 断言第二个参数（props）不是 null/undefined。
 *
 * 用正则而不是 AST：产物是 tsc 输出的固定形状，正则足够且不引依赖。
 */
check("产物里没有 jsxs(Fragment, null, ...) 这类错形调用", () => {
  const bad = [...source.matchAll(/jsxs?\)?\s*\(\s*react_jsx_runtime\.Fragment\s*,\s*(null|undefined)\s*,/g)];
  assert.equal(bad.length, 0, "发现 " + bad.length + " 处把 null 当 props 传给 Fragment 的调用");
});

check("产物里所有 Fragment 调用的 props 都是对象字面量", () => {
  const calls = [...source.matchAll(/react_jsx_runtime\.Fragment\s*,\s*(\{[^}]*\}|null|undefined)/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, "应当存在 Fragment 调用");
  for (const props of calls) {
    assert.notEqual(props, "null", "Fragment 的 props 不能是 null");
    assert.notEqual(props, "undefined", "Fragment 的 props 不能是 undefined");
    assert.match(props, /^\{/, "Fragment 的 props 必须是对象");
  }
});

console.log("\n" + passed + " passed, " + failed + " failed");
if (failed > 0) {
  console.log("SOME RENDER TESTS FAILED");
  process.exit(1);
}
console.log("ALL REAL RENDER TESTS PASSED");
