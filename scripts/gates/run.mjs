#!/usr/bin/env node
/**
 * dsh-rider 门禁：机械检查 + 自证测试（每个门禁都有非法样例证明会拒绝）。
 *
 * 用法：node scripts/gates/run.mjs [--only <gate>]
 * 门禁清单（按改动面跑最窄证据）：
 *   package-json   package.json 形态（name/version/license/dsh.bundle.patch/main/files/deps）
 *   patch-yaml     cordis.patch.yml 可解析且结构正确（组合层 insert 行）
 *   patch-entries  insert 入口约束（仅 dsh-rider、不接受 config）
 *   entry          index.mjs Cordis entry 契约：模块导出 + 严格注入 +
 *                  apply() 注册的工具/提示段形状（自建依赖 stub，无需 node_modules）
 *   md-links       README/决策记录中的相对链接可解析
 *   decisions      决策记录格式（四段 + 封闭分类集合）
 *
 * 无外部依赖：YAML 用本文件内置的子集解析器（本仓库 patch 方言：序列/映射/
 * 引号标量/嵌套块/注释），含 @ 开头的裸标量拒绝（YAML 保留指示符坑）。
 * entry 门禁在仓库无 node_modules 时临时生成 ddg-kit / @deepseek-ai/dsh-tools
 * 的 stub 用于 import 与 apply() 校验，校验后删除（node_modules/ 已 gitignore）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CATEGORIES = new Set(["feature", "bug-fix", "simplification", "architecture", "process", "testing"]);
const ENTRY_KEYS = new Set(["id", "name", "config", "disabled"]);
// 本仓库组合层允许的 insert 入口（当前仅自身 Node half；后续能力扩展时追加）。
const ALLOWED_ENTRY_NAMES = new Set(["dsh-rider"]);
const ENTRY_INJECT_REQUIRED = ["tools", "systemPrompt", "llm", "attachments", "settings", "agentDefaultModel", "webServer"];
const SECTION_MIN_ORDER = 110; // 内置 dsh-tool-web 的 web_search 指引 order，必须在其后
// 本仓库注册的工具白名单：工具名 → 必填参数（参数级形状在 checkApply 内逐工具校验）。
const EXPECTED_TOOLS = {
  duckduckgo_search: { requiredParams: ["query"] },
  vision_understand: { requiredParams: ["image"] },
};

/* ----------------------------- YAML 子集解析器 ----------------------------- */

const yamlError = (lineNo, message) => new Error(`patch-yaml: 第 ${lineNo} 行 ${message}`);

function stripComment(line) {
  let quote = null;
  let out = "";
  for (const ch of line) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "#") {
      break;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseScalar(text, lineNo) {
  const t = text.trim();
  if (t.startsWith("'") || t.startsWith('"')) {
    const q = t[0];
    if (t.length < 2 || !t.endsWith(q)) throw yamlError(lineNo, `未闭合的引号标量：${t}`);
    return { value: t.slice(1, -1).replaceAll(`\\${q}`, q), quoted: true };
  }
  if (t.startsWith("@")) throw yamlError(lineNo, `以 @ 开头的裸标量必须加引号（YAML 保留指示符）：${t}`);
  return { value: t, quoted: false };
}

const KV_RE = /^([^:]+):\s*(.*)$/;

/** 子块缩进取下一行实际缩进（只要比父块深）；没有更深的行则无子块。 */
function childIndent(lines, pos, parentIndent) {
  const line = lines[pos.i];
  if (!line || line.indent <= parentIndent) return null;
  return line.indent;
}

function parseMap(lines, pos, indent, seenKeys) {
  const obj = {};
  while (pos.i < lines.length) {
    const line = lines[pos.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw yamlError(line.lineNo, `映射项非法的缩进（期望 ${indent}）`);
    const m = KV_RE.exec(line.content);
    if (!m) throw yamlError(line.lineNo, `映射行缺少冒号：${line.content}`);
    const key = m[1];
    if (seenKeys.has(key)) throw yamlError(line.lineNo, `重复键：${key}`);
    seenKeys.add(key);
    pos.i += 1;
    const rest = m[2].trim();
    if (rest === "") {
      const ci = childIndent(lines, pos, indent);
      obj[key] = ci === null ? null : parseNode(lines, pos, ci);
    } else {
      obj[key] = parseScalar(rest, line.lineNo).value;
    }
  }
  return obj;
}

function parseSeq(lines, pos, indent) {
  const arr = [];
  while (pos.i < lines.length) {
    const line = lines[pos.i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw yamlError(line.lineNo, `序列项非法的缩进（期望 ${indent}）`);
    const m = /^-\s*(.*)$/.exec(line.content);
    if (!m) throw yamlError(line.lineNo, `序列行缺少 - 前缀：${line.content}`);
    pos.i += 1;
    const rest = m[1].trim();
    if (rest === "") {
      const ci = childIndent(lines, pos, indent);
      arr.push(ci === null ? null : parseNode(lines, pos, ci));
      continue;
    }
    const kv = KV_RE.exec(rest);
    if (kv) {
      const seen = new Set([kv[1]]);
      const item = {};
      const value = kv[2].trim();
      if (value === "") {
        const ci = childIndent(lines, pos, indent);
        item[kv[1]] = ci === null ? null : parseNode(lines, pos, ci);
      } else {
        item[kv[1]] = parseScalar(value, line.lineNo).value;
      }
      // 该条目的其余键：任何比 - 行更深的映射行（name: / config: 等）
      while (pos.i < lines.length && lines[pos.i].indent > indent) {
        const cont = lines[pos.i];
        const cm = KV_RE.exec(cont.content);
        if (!cm) throw yamlError(cont.lineNo, `条目续行缺少冒号：${cont.content}`);
        if (seen.has(cm[1])) throw yamlError(cont.lineNo, `重复键：${cm[1]}`);
        seen.add(cm[1]);
        pos.i += 1;
        const rest2 = cm[2].trim();
        if (rest2 === "") {
          const ci = childIndent(lines, pos, indent);
          item[cm[1]] = ci === null ? null : parseNode(lines, pos, ci);
        } else {
          item[cm[1]] = parseScalar(rest2, cont.lineNo).value;
        }
      }
      arr.push(item);
      continue;
    }
    arr.push(parseScalar(rest, line.lineNo).value);
  }
  return arr;
}

function parseNode(lines, pos, indent) {
  if (pos.i >= lines.length) return null;
  const line = lines[pos.i];
  if (line.indent < indent) return null;
  if (line.indent > indent) throw yamlError(line.lineNo, `非法的缩进（期望 ${indent}）`);
  if (line.content.startsWith("-")) return parseSeq(lines, pos, indent);
  if (KV_RE.test(line.content)) return parseMap(lines, pos, indent, new Set());
  throw yamlError(line.lineNo, `无法解析的行：${line.content}`);
}

function parsePatchYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = stripComment(raw);
    if (!/^\s*$/.test(line)) {
      lines.push({ indent: /^\s*/.exec(line)[0].length, content: line.trim(), lineNo: index + 1 });
    }
  });
  const pos = { i: 0 };
  const value = parseNode(lines, pos, 0);
  if (pos.i < lines.length) throw yamlError(lines[pos.i].lineNo, "文件尾部存在未消费的行");
  return value;
}

/* ------------------------- patch 结构与入口约束校验 ------------------------- */

function checkPatchText(text) {
  const value = parsePatchYaml(text);
  const problems = [];
  if (!Array.isArray(value)) {
    problems.push("顶层必须是序列（组合层 patch 列表）");
    return problems;
  }
  value.forEach((patch, index) => {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      problems.push(`第 ${index + 1} 个 patch 不是映射`);
      return;
    }
    const keys = Object.keys(patch);
    if (keys.length !== 1 || keys[0] !== "insert") problems.push(`patch 只允许 insert 键，实际：${keys.join(", ")}`);
    if (!Array.isArray(patch.insert)) {
      problems.push("insert 必须是序列");
      return;
    }
    const ids = new Set();
    patch.insert.forEach((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        problems.push(`insert[${i}] 不是映射`);
        return;
      }
      for (const key of Object.keys(entry)) {
        if (!ENTRY_KEYS.has(key)) problems.push(`insert[${i}] 含未知键：${key}`);
      }
      if (typeof entry.id !== "string" || entry.id === "") problems.push(`insert[${i}] id 缺失或非字符串`);
      else if (ids.has(entry.id)) problems.push(`insert id 重复：${entry.id}`);
      ids.add(entry.id);
      if (typeof entry.name !== "string" || entry.name === "") problems.push(`insert[${i}] name 缺失或非字符串`);
      if (entry.config !== undefined && (typeof entry.config !== "object" || entry.config === null || Array.isArray(entry.config))) {
        problems.push(`insert[${i}] config 必须是映射`);
      }
    });
  });
  return problems;
}

function checkInsertText(text) {
  const value = parsePatchYaml(text);
  const problems = [];
  if (!Array.isArray(value)) return ["顶层必须是序列（组合层 patch 列表）"];
  for (const patch of value) {
    if (!Array.isArray(patch.insert)) continue;
    for (const entry of patch.insert) {
      if (typeof entry !== "object" || entry === null) continue;
      if (!ALLOWED_ENTRY_NAMES.has(entry.name)) {
        problems.push(`insert ${entry.id}：未知入口 ${entry.name}（允许：${[...ALLOWED_ENTRY_NAMES].join(", ")}）`);
      }
      if (entry.config !== undefined) problems.push(`insert ${entry.id}：入口不接受 config（能力逻辑在 index.mjs）`);
    }
  }
  return problems;
}

/* --------------------------- entry 依赖 stub --------------------------- */

const DDG_KIT_STUB_PKG = '{"name":"ddg-kit","version":"0.0.0-stub","type":"module","main":"index.js","exports":{".":"./index.js"}}';
const DDG_KIT_STUB_JS = [
  "export const SafeSearchType = { STRICT: 0, MODERATE: -1, OFF: -2 };",
  "export const SearchTimeType = {};",
  "export class DdgError extends Error { constructor(code, message) { super(message); this.code = code; } }",
  "export function createDdgClient() { return { search: async () => { throw new Error('ddg-kit stub'); } }; }",
  "export function search() { throw new Error('ddg-kit stub'); }",
  "export function searchNews() { throw new Error('ddg-kit stub'); }",
].join("\n");
const DSH_TOOLS_STUB_PKG = '{"name":"@deepseek-ai/dsh-tools","version":"0.0.0-stub","type":"module","main":"index.js","exports":{".":"./index.js"}}';
const DSH_TOOLS_STUB_JS = "export function defineTool(options) { return options; }\n";
const DSH_LLM_STUB_PKG = '{"name":"@deepseek-ai/dsh-llm","version":"0.0.0-stub","type":"module","main":"index.js","exports":{".":"./index.js"}}';
const DSH_LLM_STUB_JS = "export function createUserMessage(input) { return { id: 'msg-stub', ...input }; }\n";
const DSH_SETTINGS_STUB_PKG = '{"name":"@deepseek-ai/dsh-settings","version":"0.0.0-stub","type":"module","main":"index.js","exports":{".":"./index.js"}}';
const DSH_SETTINGS_STUB_JS = "export function settingsNamespace(value) { return value; }\n";
const SCHEMASTERY_STUB_PKG = '{"name":"@deepseek-ai/schemastery","version":"0.0.0-stub","type":"module","main":"index.js","exports":{".":"./index.js"}}';
const SCHEMASTERY_STUB_JS = "const string = () => ({ __type: 'string' });\nconst number = () => ({ __type: 'number' });\nexport default { object: (shape) => ({ __shape: shape }), string, number };\n";

/** 仓库无 node_modules 时生成最小 stub（运行后删除）。 */
function ensureEntryStubs() {
  const created = [];
  const writeStub = (rel, pkgJson, js) => {
    const dir = join(ROOT, "node_modules", rel);
    if (existsSync(dir)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), pkgJson);
    writeFileSync(join(dir, "index.js"), js);
    created.push(join(ROOT, "node_modules"));
  };
  writeStub("ddg-kit", DDG_KIT_STUB_PKG, DDG_KIT_STUB_JS);
  writeStub("@deepseek-ai/dsh-tools", DSH_TOOLS_STUB_PKG, DSH_TOOLS_STUB_JS);
  writeStub("@deepseek-ai/dsh-llm", DSH_LLM_STUB_PKG, DSH_LLM_STUB_JS);
  writeStub("@deepseek-ai/dsh-settings", DSH_SETTINGS_STUB_PKG, DSH_SETTINGS_STUB_JS);
  writeStub("@deepseek-ai/schemastery", SCHEMASTERY_STUB_PKG, SCHEMASTERY_STUB_JS);
  return created;
}

function removeEntryStubs(created) {
  for (const dir of [...new Set(created)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** 模块导出契约 + 严格注入检查。 */
function checkEntryModule(mod, src) {
  const problems = [];
  if (typeof mod.name !== "string" || mod.name === "") problems.push("entry 未导出 name（非空字符串）");
  if (!Array.isArray(mod.inject) || !mod.inject.every((item) => typeof item === "string")) {
    problems.push("entry 未导出 inject（字符串数组）");
  }
  if (typeof mod.apply !== "function") problems.push("entry 未导出 apply（函数）");
  if (src !== undefined) {
    for (const service of ENTRY_INJECT_REQUIRED) {
      if (src.includes(`ctx.${service}`) && !(mod.inject ?? []).includes(service)) {
        problems.push(`entry 使用 ctx.${service} 但 inject 未声明 ${service}（0811 严格注入）`);
      }
    }
  }
  return problems;
}

/** 执行 apply() 并校验注册的工具与提示段形状。 */
function checkApply(mod) {
  const problems = [];
  if (typeof mod.apply !== "function") {
    problems.push("entry 未导出 apply（函数）");
    return problems;
  }
  const tools = [];
  const sections = [];
  const fakeCtx = {
    on: () => {},
    tools: { register: (tool) => { tools.push(tool); } },
    systemPrompt: { section: (section) => { sections.push(section); } },
    settings: { register: () => ({ get: () => ({}) }) },
    llm: { listProviders: async () => [], listModels: async () => [], resolveModelInfo: async () => ({}), stream: async function* () {} },
    attachments: { imageLimits: { maxImageBytes: 1 }, saveImage: async () => ({}), readImage: async () => ({}) },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
  };
  mod.apply(fakeCtx);
  if (tools.length === 0) {
    problems.push("apply() 未注册任何工具");
  } else {
    for (const tool of tools) {
      if (typeof tool.name !== "string" || tool.name === "") problems.push("工具缺少 name");
      if (typeof tool.description !== "string" || tool.description === "") problems.push(`工具 ${tool.name} 缺少 description`);
      const expected = EXPECTED_TOOLS[tool.name];
      if (!expected) {
        problems.push(`工具 ${tool.name} 不在白名单（${Object.keys(EXPECTED_TOOLS).join(", ")}）——新增工具须同步门禁`);
        continue;
      }
      // parameters 是作者层「隐式属性映射」，由 dsh-tools 的 defineTool 在加载时编译为
      // JSON schema（见 @deepseek-ai/dsh-tools 的 parameterSchemaSpecToJsonSchema）。这里只校验
      // 作者层形状——禁止把编译后形态 { type:'object', properties, required:[] } 直接当 parameters
      // （这正是 plugin tree 加载报 parameters.type must be a value schema object 的根因）。
      const params = tool.parameters;
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        problems.push(`工具 ${tool.name} parameters 必须是属性映射对象`);
      } else {
        for (const key of expected.requiredParams) {
          if (params[key] === undefined) problems.push(`工具 ${tool.name} parameters 缺少 ${key} 属性`);
        }
        for (const [key, spec] of Object.entries(params)) {
          if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
            problems.push(`工具 ${tool.name} parameters.${key} 必须是 value schema 对象（不是 ${typeof spec}）`);
          } else if (typeof spec.type !== "string" || spec.type === "") {
            problems.push(`工具 ${tool.name} parameters.${key} 缺少 type`);
          }
        }
        for (const key of expected.requiredParams) {
          if (params[key] !== undefined && params[key].required !== true) {
            problems.push(`工具 ${tool.name} parameters.${key} 必须声明 required: true`);
          }
        }
      }
      if (tool.output?.schema?.type !== "object") problems.push(`工具 ${tool.name} output.schema 必须是 object-rooted`);
      else if (typeof tool.output.schema.additionalProperties !== "boolean") problems.push(`工具 ${tool.name} output.schema.additionalProperties 必须显式声明 true/false`);
      if (typeof tool.execute !== "function") problems.push(`工具 ${tool.name} 缺少 execute`);
    }
  }
  if (sections.length === 0) {
    problems.push("apply() 未注册系统提示段（工具选择指引）");
  } else {
    for (const section of sections) {
      if (typeof section.name !== "string" || section.name === "") problems.push("提示段缺少 name");
      if (!Number.isFinite(section.order) || section.order <= SECTION_MIN_ORDER) problems.push(`提示段 order 必须大于 ${SECTION_MIN_ORDER}（内置 web_search 指引），实际 ${section.order}`);
      if (typeof section.text !== "string" || section.text === "") problems.push("提示段 text 为空");
    }
  }
  return problems;
}

/* ---------------------------------- 门禁 ---------------------------------- */

const gate = (name, checkRepo, selfTest) => ({ name, checkRepo, selfTest });

const packageJsonGate = gate(
  "package-json",
  () => {
    const raw = readFileSync(join(ROOT, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const problems = [];
    for (const key of ["name", "version", "license", "type"]) {
      if (typeof pkg[key] !== "string" || pkg[key] === "") problems.push(`package.json#${key} 缺失或非字符串`);
    }
    const patch = pkg.dsh?.bundle?.patch;
    if (typeof patch !== "string") problems.push("package.json#dsh.bundle.patch 缺失或非字符串（bundle 声明）");
    else if (!existsSync(join(ROOT, patch))) problems.push(`dsh.bundle.patch 指向的文件不存在：${patch}`);
    if (typeof pkg.dsh?.client?.platform !== "string" || pkg.dsh.client.platform === "") {
      problems.push("package.json#dsh.client.platform 缺失或非字符串（client bundle 声明）");
    }
    if (typeof pkg.exports?.["./client"] !== "string") problems.push("package.json#exports[\"./client\"] 缺失（client bundle 路径）");
    else if (!existsSync(join(ROOT, pkg.exports["./client"]))) problems.push(`exports["./client"] 指向的文件不存在：${pkg.exports["./client"]}`);
    for (const [label, entryPath] of [["main", pkg.main], ["exports[\".\"]", pkg.exports?.["."]]]) {
      if (typeof entryPath !== "string" || entryPath === "") problems.push(`package.json#${label} 缺失或非字符串（Cordis 入口）`);
      else if (!existsSync(join(ROOT, entryPath))) problems.push(`package.json#${label} 指向的文件不存在：${entryPath}`);
    }
    if (typeof pkg.dependencies?.["ddg-kit"] !== "string") problems.push("package.json#dependencies.ddg-kit 缺失（搜索实现依赖）");
    if (!Array.isArray(pkg.files)) problems.push("package.json#files 缺失（npm 发布清单）");
    return problems;
  },
  () => {
    const check = (text) => {
      const pkg = JSON.parse(text);
      if (typeof pkg.dsh?.bundle?.patch !== "string") throw new Error("no bundle patch");
      if (typeof pkg.dsh?.client?.platform !== "string") throw new Error("no client platform");
      if (typeof pkg.main !== "string" || !existsSync(join(ROOT, pkg.main))) throw new Error("no main");
      if (typeof pkg.dependencies?.["ddg-kit"] !== "string") throw new Error("no ddg-kit dep");
    };
    const problems = [];
    try {
      check('{ "name": ');
      problems.push("非法 JSON 未被拒绝");
    } catch {}
    try {
      check(JSON.stringify({ name: "x", version: "0.1.0", license: "MIT", type: "module", files: [], dsh: { bundle: { patch: "./cordis.patch.yml" }, client: { platform: "web" } }, main: "./index.mjs" }));
      problems.push("无 ddg-kit 依赖的包未被拒绝");
    } catch {}
    return problems;
  },
);

const patchYamlGate = gate(
  "patch-yaml",
  () => checkPatchText(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8")),
  () => {
    const problems = [];
    for (const [label, text, expect] of [
      ["未加引号的 @name", "- insert:\n    - id: x\n      name: @deepseek-ai/dsh-mcp-client\n", true],
      ["顶层是映射", "insert:\n  - id: x\n", true],
      ["缺 id", "- insert:\n    - name: 'x'\n", true],
      ["重复 id", "- insert:\n    - id: x\n      name: 'a'\n    - id: x\n      name: 'b'\n", true],
      ["合法 patch", "- insert:\n    - id: dsh-rider\n      name: 'dsh-rider'\n", false],
    ]) {
      let problems2;
      try {
        problems2 = checkPatchText(text);
      } catch (error) {
        problems2 = [`解析错误：${error.message}`];
      }
      if (expect && problems2.length === 0) problems.push(`非法样例未被拒绝（${label}）`);
      if (!expect && problems2.length > 0) problems.push(`合法样例被误拒（${label}）：${problems2.join("; ")}`);
    }
    return problems;
  },
);

const patchEntriesGate = gate(
  "patch-entries",
  () => checkInsertText(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8")),
  () => {
    const problems = [];
    for (const [label, text, expect] of [
      ["未知入口", "- insert:\n    - id: x\n      name: 'other-pkg'\n", true],
      ["入口带 config", "- insert:\n    - id: dsh-rider\n      name: 'dsh-rider'\n      config:\n        foo: 1\n", true],
      ["合法入口", "- insert:\n    - id: dsh-rider\n      name: 'dsh-rider'\n", false],
    ]) {
      let problems2;
      try {
        problems2 = checkInsertText(text);
      } catch (error) {
        problems2 = [`解析错误：${error.message}`];
      }
      if (expect && problems2.length === 0) problems.push(`非法入口未被拒绝（${label}）`);
      if (!expect && problems2.length > 0) problems.push(`合法入口被误拒（${label}）：${problems2.join("; ")}`);
    }
    return problems;
  },
);

const entryGate = gate(
  "entry",
  async () => {
    const created = ensureEntryStubs();
    try {
      const src = readFileSync(join(ROOT, "index.mjs"), "utf8");
      const mod = await import(pathToFileURL(join(ROOT, "index.mjs")).href);
      return [...checkEntryModule(mod, src), ...checkApply(mod)];
    } finally {
      removeEntryStubs(created);
    }
  },
  async () => {
    const problems = [];
    const fixtures = [
      ["合法 entry", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\nexport function apply(ctx) {\n  ctx.tools.register({ name: "duckduckgo_search", description: "d", parameters: { query: { type: "string", required: true } }, output: { schema: { type: "object", additionalProperties: false } }, execute: async () => ({}) });\n  ctx.systemPrompt.section({ name: "s", order: 115, text: "t" });\n}', false],
      ["parameters 误用编译后形态", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\nexport function apply(ctx) {\n  ctx.tools.register({ name: "duckduckgo_search", description: "d", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, output: { schema: { type: "object", additionalProperties: false } }, execute: async () => ({}) });\n  ctx.systemPrompt.section({ name: "s", order: 115, text: "t" });\n}', true],
      ["缺 apply", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\n', true],
      ["inject 缺 systemPrompt", 'export const name = "x";\nexport const inject = ["tools"];\nexport function apply(ctx) { ctx.systemPrompt.section({ name: "s", order: 115, text: "t" }); }', true],
      ["工具名不符", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\nexport function apply(ctx) { ctx.tools.register({ name: "wrong_tool", description: "d", parameters: { query: { type: "string", required: true } }, output: { schema: { type: "object", additionalProperties: false } }, execute: async () => ({}) }); }', true],
      ["vision 缺 image 参数", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\nexport function apply(ctx) { ctx.tools.register({ name: "vision_understand", description: "d", parameters: { prompt: { type: "string" } }, output: { schema: { type: "object", additionalProperties: false } }, execute: async () => ({}) });\n  ctx.systemPrompt.section({ name: "s", order: 115, text: "t" }); }', true],
      ["vision 参数缺 required", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\nexport function apply(ctx) { ctx.tools.register({ name: "vision_understand", description: "d", parameters: { image: { type: "string" } }, output: { schema: { type: "object", additionalProperties: false } }, execute: async () => ({}) });\n  ctx.systemPrompt.section({ name: "s", order: 115, text: "t" }); }', true],
      ["提示段 order 不够高", 'export const name = "x";\nexport const inject = ["tools", "systemPrompt"];\nexport function apply(ctx) { ctx.systemPrompt.section({ name: "s", order: 100, text: "t" }); }', true],
    ];
    for (const [label, src, expect] of fixtures) {
      const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
      const problems2 = [...checkEntryModule(mod, src), ...checkApply(mod)];
      if (expect && problems2.length === 0) problems.push(`非法 entry 未被拒绝（${label}）`);
      if (!expect && problems2.length > 0) problems.push(`合法 entry 被误拒（${label}）：${problems2.join("; ")}`);
    }
    return problems;
  },
);

/* -------------------------- vision-execute 门禁 -------------------------- */

const VISION_PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 用给定服务行为构造 fake ctx，apply 后取出 vision_understand 工具。 */
function makeVisionHarness(overrides) {
  const registeredTools = [];
  const sections = [];
  const ctx = {
    on: () => {},
    tools: { register: (tool) => { registeredTools.push(tool); } },
    systemPrompt: { section: (section) => { sections.push(section); } },
    settings: { register: () => ({ get: () => overrides.settingsValue ?? {} }) },
    attachments: {
      imageLimits: {
        maxImageBytes: 10 * 1024 * 1024,
        maxImagesPerMessage: 8,
        maxMessageImageBytes: 10 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
      },
      saveImage: overrides.saveImage ?? (async (input) => ({
        attachmentId: "a1",
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 1,
        height: 1,
        name: input.name,
      })),
      readImage: async (ref) => ({ ref, data: new Uint8Array() }),
    },
    llm: {
      listProviders: () => overrides.providers ?? [{ id: "openai", name: "OpenAI" }],
      listModels: async (provider) => (overrides.models ?? [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o", inputModalities: ["text", "image"] },
      ]).filter((model) => model.provider === provider),
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ["text", "image"] }),
      stream: overrides.stream ?? (async function* () {
        yield { type: "text-delta", index: 0, text: "a yellow cat on a sofa" };
        yield { type: "finish", index: 0, reason: { kind: "stop" } };
      }),
    },
    agentDefaultModel: { currentSelection: () => overrides.defaultModel ?? { provider: "deepseek-official", model: "deepseek-v4-flash" } },
  };
  return { ctx, registeredTools, sections };
}

/** apply 一次并执行 vision_understand.execute。 */
async function runVisionTool(mod, overrides, args) {
  const { ctx, registeredTools } = makeVisionHarness(overrides);
  mod.apply(ctx);
  const tool = registeredTools.find((tool2) => tool2.name === "vision_understand");
  if (!tool) throw new Error("apply() 未注册 vision_understand");
  return tool.execute(args, { signal: new AbortController().signal });
}

/** 成功结果形状断言。 */
function assertVisionSuccess(result, problems, label) {
  if (result.provider !== "openai" || result.model !== "gpt-4o") {
    problems.push(`${label}：provider/model 解析错误（${result.provider}/${result.model}）`);
  }
  if (typeof result.text !== "string" || result.text.trim() === "") problems.push(`${label}：未返回文本`);
  if (result.image?.width !== 1 || result.image?.height !== 1) problems.push(`${label}：image 元数据缺失`);
}

/** 断言 thunk 抛错且错误信息匹配。 */
async function expectVisionThrow(thunk, pattern, problems, label) {
  try {
    await thunk();
    problems.push(`失败路径（${label}）未抛错`);
  } catch (error) {
    if (!pattern.test(error.message)) problems.push(`失败路径（${label}）错误信息不符：${error.message}`);
  }
}

const visionExecuteGate = gate(
  "vision-execute",
  async () => {
    const created = ensureEntryStubs();
    try {
      const mod = await import(pathToFileURL(join(ROOT, "index.mjs")).href);
      const problems = [];
      // 成功路径 1：自动发现声明 image 模态的模型
      try {
        const { ctx, registeredTools } = makeVisionHarness({});
        mod.apply(ctx);
        const tool = registeredTools.find((t) => t.name === "vision_understand");
        const result = await tool.execute({ image: VISION_PNG_1PX, prompt: "what is this?" }, { signal: new AbortController().signal });
        assertVisionSuccess(result, problems, "自动发现");
        const rendered = tool.output.render({ image: VISION_PNG_1PX }, result);
        if (!Array.isArray(rendered) || rendered[0]?.type !== "text" || !String(rendered[0].text).includes("yellow cat")) {
          problems.push(`自动发现：render 投影未包含视觉描述（${JSON.stringify(rendered)}）`);
        }
      } catch (error) {
        problems.push(`成功路径（自动发现）抛错：${error.message}`);
      }
      // 成功路径 2：显式 provider/model（无视觉模型可发现时信任用户）
      try {
        const result = await runVisionTool(mod, { models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }] }, { image: VISION_PNG_1PX, provider: "openai", model: "gpt-4o" });
        if (result.provider !== "openai" || result.model !== "gpt-4o") problems.push(`显式指定解析错误：${result.provider}/${result.model}`);
      } catch (error) {
        problems.push(`成功路径（显式指定）抛错：${error.message}`);
      }
      // 成功路径 3：settings 指定（信任用户，跳过模态过滤）
      try {
        const result = await runVisionTool(
          mod,
          { models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }], settingsValue: { visionProvider: "openai", visionModel: "gpt-4o" } },
          { image: VISION_PNG_1PX },
        );
        if (result.provider !== "openai" || result.model !== "gpt-4o") problems.push(`settings 指定解析错误：${result.provider}/${result.model}`);
      } catch (error) {
        problems.push(`成功路径（settings 指定）抛错：${error.message}`);
      }
      // 失败路径
      await expectVisionThrow(() => runVisionTool(mod, { models: [] }, { image: VISION_PNG_1PX }), /未发现/, problems, "无视觉模型");
      await expectVisionThrow(() => runVisionTool(mod, {}, { image: VISION_PNG_1PX, provider: "openai" }), /同时提供/, problems, "provider 缺 model");
      await expectVisionThrow(() => runVisionTool(mod, {}, { image: "C:/nonexistent/x.bmp" }), /不支持的图片格式/, problems, "bmp mediaType");
      await expectVisionThrow(() => runVisionTool(mod, {}, { image: "Z:/no/such/file.png" }), /读取本地图片失败/, problems, "本地路径不存在");
      await expectVisionThrow(
        () => runVisionTool(mod, { stream: async function* () { yield { type: "finish", index: 0, reason: { kind: "error", failure: { code: "X", message: "boom" } } }; } }, { image: VISION_PNG_1PX }),
        /boom/,
        problems,
        "error finish",
      );
      return problems;
    } finally {
      removeEntryStubs(created);
    }
  },
  async () => {
    const problems = [];
    const p1 = [];
    assertVisionSuccess({ provider: "openai", model: "gpt-4o", text: "", image: { width: 1, height: 1 } }, p1, "坏样例");
    if (p1.length === 0) problems.push("自证失败：空文本坏样例未被成功断言拒绝");
    const p2 = [];
    await expectVisionThrow(async () => {}, /x/, p2, "坏样例");
    if (p2.length === 0) problems.push("自证失败：永不抛错的坏样例未被拒绝");
    return problems;
  },
);

/* -------------------------- upload-execute 门禁 -------------------------- */

/** 构造 fake IncomingMessage：真实 Readable（缓冲语义，晚注册监听也能收到 body，
 *  对齐 Node http 请求流的背压行为——不会因 handler 先 await 其他操作而丢 data/end）。 */
function makeFakeReq(body, method, headers, url) {
  const chunk = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  const req = Readable.from(chunk);
  req.method = method;
  req.headers = headers ?? {};
  if (url !== undefined) req.url = url;
  return req;
}

/** 构造 fake ServerResponse：收集 statusCode / headers / body。 */
function makeFakeRes() {
  const res = { statusCode: 200, headers: {}, body: "" };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.end = (chunk) => { res.body = String(chunk ?? ""); };
  return res;
}

/** apply 后捕获 webServer 注册的路由；settings.get 返回给定值。 */
function makeUploadHarness(settingsValue) {
  const registered = [];
  const ctx = {
    effect: (fn) => { fn(); },
    on: () => {},
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
    settings: { register: () => ({ get: () => settingsValue ?? {} }) },
    llm: { listProviders: async () => [], listModels: async () => [], resolveModelInfo: async () => ({}), stream: async function* () {} },
    attachments: { imageLimits: { maxImageBytes: 1 }, saveImage: async () => ({}), readImage: async () => ({}) },
    agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) },
    webServer: { register: (route) => { registered.push(route); return () => {}; } },
  };
  return { ctx, registered };
}

/** 取出指定路径的 handler；未注册直接抛错。 */
function routeHandler(registered, path, label) {
  const route = registered.find((r) => r.path === path);
  if (!route || typeof route.handler !== "function") throw new Error(`${label}: 未注册 ${path} 路由`);
  return route.handler;
}

/** 一次调用：返回 {status, body}。url 可选（GET query 用）。 */
async function callUpload(handler, { method = "POST", body, headers, url } = {}) {
  const res = makeFakeRes();
  await handler(makeFakeReq(body, method, headers, url), res);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.statusCode, body: parsed, raw: res.body };
}

const stashExecuteGate = gate(
  "stash-execute",
  async () => {
    const created = ensureEntryStubs();
    const tmp = mkdtempSync(join(tmpdir(), "dsh-rider-stash-gate-"));
    // 隔离全局索引：DSH_HOME 指向临时目录（防污染真实 ~/.dsh/attachments-index.json）
    const savedDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = tmp;
    const workspace = join(tmp, "workspace");
    mkdirSync(workspace, { recursive: true });
    const sid = "sess-1";
    try {
      const mod = await import(pathToFileURL(join(ROOT, "index.mjs")).href);
      const problems = [];
      const { ctx, registered } = makeUploadHarness({ uploadMaxBytes: 0 });
      mod.apply(ctx);
      const stash = routeHandler(registered, "/api/dsh-rider-stash", "stash-execute");
      const restage = routeHandler(registered, "/api/dsh-rider-stash/restage", "stash-execute");
      const read = routeHandler(registered, "/api/dsh-rider-stash/read", "stash-execute");
      const uploadsDir = join(workspace, ".dsh", "uploads");
      const post = (payload) => callUpload(stash, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
      const del = (payload) => callUpload(stash, { method: "DELETE", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
      const listStash = () => callUpload(stash, { method: "GET", url: `/api/dsh-rider-stash?sessionId=${sid}` });
      const readStash = (relPath) => callUpload(read, {
        method: "GET",
        url: `/api/dsh-rider-stash/read?cwd=${encodeURIComponent(workspace)}&relPath=${encodeURIComponent(relPath)}`,
      });

      // 成功路径：中文文件名 + 内容落盘到 workspace/.dsh/uploads + pending
      const hello = "hello from stash gate";
      const up = await post({ cwd: workspace, sessionId: sid, name: "报告.txt", dataBase64: Buffer.from(hello, "utf8").toString("base64") });
      if (up.status !== 200 || up.body?.ok !== true) {
        problems.push(`stash 成功路径失败：HTTP ${up.status} ${up.raw}`);
      } else {
        const file = up.body.file;
        if (!file.relPath.startsWith(".dsh/uploads/")) problems.push(`relPath 不在 uploads 下：${file.relPath}`);
        if (file.name !== "报告.txt") problems.push(`文件名清洗错误：${file.name}`);
        if (file.size !== Buffer.byteLength(hello)) problems.push(`size 错误：${file.size}`);
        const stored = readFileSync(join(workspace, file.relPath));
        if (stored.toString("utf8") !== hello) problems.push("落盘内容不一致");
        // 列表（pending 真相源）
        const list = await listStash();
        if (list.status !== 200 || !Array.isArray(list.body?.files) || list.body.files.length !== 1 || list.body.files[0].relPath !== file.relPath) {
          problems.push(`列表路径失败：HTTP ${list.status} ${list.raw}`);
        }
        // 读回（预览）
        const readBack = await readStash(file.relPath);
        if (readBack.status !== 200 || Buffer.from(readBack.body?.dataBase64 ?? "", "base64").toString("utf8") !== hello) {
          problems.push(`read 路径失败：HTTP ${readBack.status} ${readBack.raw}`);
        }
        // 单删
        const del1 = await del({ cwd: workspace, sessionId: sid, relPath: file.relPath });
        if (del1.status !== 200 || del1.body?.removed !== true) problems.push(`单删路径失败：HTTP ${del1.status} ${del1.raw}`);
        if (existsSync(join(workspace, file.relPath))) problems.push("单删未清除磁盘文件");
        // 清空
        await post({ cwd: workspace, sessionId: sid, name: "a.txt", dataBase64: Buffer.from("a").toString("base64") });
        await post({ cwd: workspace, sessionId: sid, name: "b.txt", dataBase64: Buffer.from("b").toString("base64") });
        const clear = await del({ cwd: workspace, sessionId: sid, clear: true });
        if (clear.status !== 200 || clear.body?.cleared !== true) problems.push(`清空路径失败：HTTP ${clear.status} ${clear.raw}`);
        const after = await listStash();
        if (after.body?.files?.length !== 0) problems.push(`清空后列表非空：${after.raw}`);
      }

      // 失败路径：相对 cwd / 不存在的目录
      const badCwd = await post({ cwd: "relative/path", sessionId: sid, name: "x.txt", dataBase64: Buffer.from("x").toString("base64") });
      if (badCwd.status !== 500) problems.push(`相对 cwd 未被拒绝：HTTP ${badCwd.status} ${badCwd.raw}`);
      const noDir = await post({ cwd: join(tmp, "nope"), sessionId: sid, name: "x.txt", dataBase64: Buffer.from("x").toString("base64") });
      if (noDir.status !== 400) problems.push(`不存在目录未被 400 拒绝：HTTP ${noDir.status} ${noDir.raw}`);
      // 空内容
      const empty = await post({ cwd: workspace, sessionId: sid, name: "e.txt", dataBase64: "" });
      if (empty.status !== 400) problems.push(`空内容未被 400 拒绝：HTTP ${empty.status} ${empty.raw}`);
      // 大小上限：1MB 上限拒 2MB
      const small = makeUploadHarness({ uploadMaxBytes: 1 });
      mod.apply(small.ctx);
      const smallStash = routeHandler(small.registered, "/api/dsh-rider-stash", "stash-execute");
      const tooLarge = await callUpload(smallStash, {
        method: "POST",
        body: JSON.stringify({ cwd: workspace, sessionId: sid, name: "big.bin", dataBase64: Buffer.alloc(2 * 1024 * 1024, 7).toString("base64") }),
        headers: { "content-type": "application/json" },
      });
      if (tooLarge.status !== 413) problems.push(`超限未被 413 拒绝：HTTP ${tooLarge.status} ${tooLarge.raw}`);
      // 路径穿越：relPath 含 ..
      const evilDel = await del({ cwd: workspace, sessionId: sid, relPath: ".dsh/uploads/../escape.txt" });
      if (evilDel.status !== 500) problems.push(`穿越 relPath 未被拒绝：HTTP ${evilDel.status} ${evilDel.raw}`);
      const evilRestage = await callUpload(restage, {
        method: "POST",
        body: JSON.stringify({ cwd: workspace, sessionId: sid, relPath: ".dsh/uploads/..\\x" }),
        headers: { "content-type": "application/json" },
      });
      if (evilRestage.status !== 500) problems.push(`restage 穿越未被拒绝：HTTP ${evilRestage.status} ${evilRestage.raw}`);
      // 文件名清洗：路径分隔 + 保留字符 → 白名单替换
      const evilName = await post({ cwd: workspace, sessionId: sid, name: "..\\..\\evil:name?.txt", dataBase64: Buffer.from("x").toString("base64") });
      if (evilName.status !== 200 || evilName.body?.file?.name.includes("..") || evilName.body?.file?.name.includes(":")) {
        problems.push(`非法文件名未被清洗：${evilName.raw}`);
      }
      // restage：本地已存在 → 重新挂载
      const restageRes = await callUpload(restage, {
        method: "POST",
        body: JSON.stringify({ cwd: workspace, sessionId: sid, relPath: evilName.body.file.relPath }),
        headers: { "content-type": "application/json" },
      });
      if (restageRes.status !== 200 || restageRes.body?.ok !== true) problems.push(`restage 本地路径失败：${restageRes.raw}`);
      // restage：本地缺失 + 索引命中 → 跨项目迁移
      const otherWorkspace = join(tmp, "other-ws");
      mkdirSync(otherWorkspace, { recursive: true });
      const otherUp = await post({ cwd: otherWorkspace, sessionId: "sess-2", name: "migrate.txt", dataBase64: Buffer.from("migrate me", "utf8").toString("base64") });
      const migrated = await callUpload(restage, {
        method: "POST",
        body: JSON.stringify({ cwd: workspace, sessionId: sid, relPath: otherUp.body.file.relPath }),
        headers: { "content-type": "application/json" },
      });
      if (migrated.status !== 200 || migrated.body?.ok !== true) problems.push(`restage 跨项目迁移失败：${migrated.raw}`);
      if (!existsSync(join(workspace, otherUp.body.file.relPath))) problems.push("跨项目迁移未复制文件到当前工作区");

      // pre-step 注入纯函数：enter+已认领 → 注入 + 消费
      const claimed = [{ id: "u1" }];
      const decision = { kind: "enter", messages: [{ id: "u1" }, { id: "a1" }] };
      const folded = mod.foldPendingAttachments(decision, { messages: claimed }, [{ relPath: ".dsh/uploads/x.txt", name: "x.txt", size: 3 }]);
      if (!folded.consumed) problems.push("pre-step 注入未被消费");
      if (folded.decision.messages.length !== 3) problems.push(`pre-step 注入消息数错误：${folded.decision.messages.length}`);
      const noteText = folded.decision.messages[0]?.content?.[0]?.text ?? "";
      if (!noteText.includes(".dsh/uploads/x.txt")) problems.push("注入消息缺少附件路径");
      if (folded.decision.messages[0]?.source?.kind !== "user") problems.push("注入消息 source 应为 user");
      // reject / 无认领消息 / 空暂存 → 不消费
      const r1 = mod.foldPendingAttachments({ kind: "reject", messages: [] }, { messages: claimed }, [{ relPath: "p", name: "n", size: 1 }]);
      if (r1.consumed) problems.push("reject 决策不应消费暂存");
      const r2 = mod.foldPendingAttachments({ kind: "enter", messages: [{ id: "u1" }] }, { messages: [] }, [{ relPath: "p", name: "n", size: 1 }]);
      if (r2.consumed) problems.push("无认领消息不应消费暂存");
      const r3 = mod.foldPendingAttachments({ kind: "enter", messages: [{ id: "u1" }] }, { messages: claimed }, []);
      if (r3.consumed) problems.push("空暂存不应消费");

      // 405
      const badMethod = await callUpload(stash, { method: "PUT", body: "x" });
      if (badMethod.status !== 405) problems.push(`PUT 未被 405 拒绝：HTTP ${badMethod.status}`);

      return problems;
    } finally {
      removeEntryStubs(created);
      if (savedDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedDshHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  async () => {
    const problems = [];
    const res = makeFakeRes();
    if (res.statusCode !== 200 || typeof res.end !== "function") problems.push("自证失败：fake res 形状错误");
    const req = makeFakeReq(Buffer.from("hi"), "POST", {});
    let got = false;
    req.on("data", (chunk) => { if (Buffer.isBuffer(chunk) && chunk.toString() === "hi") got = true; });
    await new Promise((resolve2) => { req.on("end", resolve2); });
    if (!got) problems.push("自证失败：fake req 未推送 body");
    return problems;
  },
);

/* -------------------------- client bundle 门禁 -------------------------- */

const CLIENT_PATH = join(ROOT, "client", "index.js");
// 平台静态词白名单（对齐 dsh-client-web getStaticModules 的 seed 表）——
// client bundle 只允许 require 这些词，跨插件值 import 被 client-modules 禁止。
const CLIENT_REQUIRE_ALLOWED = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-web-react",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-attachment",
  "@deepseek-ai/dsh-client-schema-form",
]);

/** client bundle 机械检查：注册通道、require 白名单、导出契约。 */
function checkClientBundleText(text) {
  const problems = [];
  if (!/window\.__ModuleLoader__\.load\(\{/.test(text)) {
    problems.push("client bundle 缺少 window.__ModuleLoader__.load 包装（client-modules 注册通道）");
  }
  if (!/factory:\s*\(require\)\s*=>/.test(text)) {
    problems.push("client bundle 的 load 缺少 factory(require) 工厂");
  }
  for (const match of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!CLIENT_REQUIRE_ALLOWED.has(match[1])) {
      problems.push(`client bundle require 了白名单外的模块：${match[1]}（跨插件值 import 被禁止）`);
    }
  }
  if (!/exports\.name\s*=\s*["']dsh-rider["']/.test(text)) problems.push("client bundle 未导出 name 'dsh-rider'");
  if (!/exports\.inject\s*=/.test(text)) problems.push("client bundle 未导出 inject（服务注入声明）");
  if (!/exports\.apply\s*=/.test(text)) problems.push("client bundle 未导出 apply");
  return problems;
}

/** 平台静态词 stub：vm 沙箱的 require 解析面（白名单外的 spec 直接抛错）。 */
function makeClientRequireStubs() {
  const modules = {
    "react": {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (init) => [typeof init === "function" ? init() : init, () => {}],
      useEffect: () => {},
      useRef: (init) => ({ current: typeof init === "function" ? init() : init }),
      useCallback: (fn) => fn,
    },
    "react/jsx-runtime": {},
    "react-dom": { createPortal: (node) => node },
    "@deepseek-ai/dsh-client-ui-slots": { resolveSlotLabel: (label) => (typeof label === "function" ? label() : label) },
    "@deepseek-ai/dsh-client-ui-primitives": {
      Button: (props) => ({ __component: "Button", props }),
      Input: (props) => ({ __component: "Input", props }),
    },
  };
  return (spec) => {
    if (!(spec in modules)) throw new Error(`client-execute: 白名单外 require：${spec}`);
    return modules[spec];
  };
}

/** 自建路由的 fetch stub：模拟 Node half 的 /api/dsh-rider-vision GET/POST。
 *  返回可控的 resolved/user 两层，POST 时按 update/reset 更新。 */
function makeVisionFetchStub() {
  const state = { resolved: { visionProvider: "", visionModel: "", visionPrompt: "" }, user: {}, calls: [] };
  return {
    fetch: async (url, opts) => {
      state.calls.push({ url, method: opts?.method ?? "GET", body: opts?.body });
      const method = opts?.method ?? "GET";
      // 图片理解路由：返回假描述（语义正确，门禁不渲染卡片但 stub 应识别该 URL）。
      if (typeof url === "string" && url.includes("/understand")) {
        return { ok: true, json: async () => ({ ok: true, provider: "stub", model: "stub-vision", text: "(stub) a test image", note: undefined }) };
      }
      // 模态声明路由：GET 返回空 survey（无 llm-pi-ai 模型），POST 返回成功。
      if (typeof url === "string" && url.includes("/declare")) {
        if (method === "GET") return { ok: true, json: async () => ({ ok: true, models: [], visionProvider: "", visionModel: "" }) };
        const decBody = JSON.parse(opts?.body ?? "{}");
        return { ok: true, json: async () => ({ ok: true, provider: decBody.provider || "stub", model: decBody.model || "stub", removed: decBody.remove === true, input: decBody.remove === true ? undefined : ["text", "image"], restartRequired: true }) };
      }
      // 文件暂存路由：GET 空列表 / DELETE 成功 / POST 返回 stub 文件。
      if (typeof url === "string" && url.includes("/api/dsh-rider-stash/restage")) {
        return { ok: true, json: async () => ({ ok: true, file: { relPath: ".dsh/uploads/260816-120000-r.txt", size: 4 } }) };
      }
      if (typeof url === "string" && url.includes("/api/dsh-rider-stash/read")) {
        return { ok: true, json: async () => ({ ok: true, dataBase64: "c3R1Yg==", size: 4 }) };
      }
      if (typeof url === "string" && url.includes("/api/dsh-rider-stash")) {
        if (method === "GET") return { ok: true, json: async () => ({ ok: true, files: [] }) };
        if (method === "DELETE") return { ok: true, json: async () => ({ ok: true, cleared: true }) };
        return { ok: true, json: async () => ({ ok: true, file: { relPath: ".dsh/uploads/260816-120000-stub.txt", name: "stub.txt", size: 4 } }) };
      }
      // GET：返回当前 resolved/user 快照。
      if (method === "GET") {
        return { ok: true, json: async () => ({ ok: true, resolved: { ...state.resolved }, user: { ...state.user } }) };
      }
      // POST：按 body 更新状态，返回新快照。
      const body = JSON.parse(opts?.body ?? "{}");
      if (body.reset === true) {
        state.user = {};
        state.resolved = { visionProvider: "", visionModel: "", visionPrompt: "" };
      } else if (body.update && typeof body.update === "object") {
        for (const [field, value] of Object.entries(body.update)) {
          if (value === "") delete state.user[field];
          else state.user[field] = value;
        }
        state.resolved = { visionProvider: "", visionModel: "", visionPrompt: "", ...state.user };
      }
      return { ok: true, json: async () => ({ ok: true, resolved: { ...state.resolved }, user: { ...state.user } }) };
    },
    state,
  };
}

/** 最小 document stub：installDropzone 的遮罩 DOM 创建在 vm 沙箱内可用。 */
function makeDocumentStub() {
  const makeEl = () => {
    const el = {
      style: { cssText: "" },
      dataset: {},
      children: [],
      append(...kids) { for (const kid of kids) this.children.push(kid); },
      appendChild(child) { this.children.push(child); return child; },
      insertBefore(child, ref) {
        const at = ref === null ? this.children.length : this.children.indexOf(ref);
        if (at < 0) this.children.push(child);
        else this.children.splice(at, 0, child);
        return child;
      },
      addEventListener() {},
      removeEventListener() {},
      remove() {},
    };
    return el;
  };
  return {
    body: makeEl(),
    createElement: () => makeEl(),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
  };
}

/** 在 vm 沙箱执行 client bundle，返回 factory 产物与 load 记录。fetchStub 注入 globalThis。 */
function loadClientBundle(code, fetchStub) {
  let handoff = null;
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { handoff = h; } },
      addEventListener() {},
      removeEventListener() {},
    },
    document: makeDocumentStub(),
    console,
  };
  if (fetchStub !== undefined) sandbox.fetch = fetchStub;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "client/index.js" });
  if (handoff === null) throw new Error("client-execute: bundle 未调用 __ModuleLoader__.load");
  if (handoff.id !== "dsh-rider") throw new Error(`client-execute: load id 应为 dsh-rider，实际 ${handoff.id}`);
  return handoff.factory(makeClientRequireStubs());
}

/** 跑 client apply(fakeCtx)，返回注册记录。controller 构造时异步 refresh（fetch GET）。 */
function runClientApply(mod) {
  const localeRegistrations = [];
  const slotRegistrations = [];
  const slotInjections = [];
  const fakeCtx = {
    effect: (fn) => { fn(); },
    locale: {
      register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }); },
      bind: (ns) => (key) => localeRegistrations.find((r) => r.ns === ns)?.dicts.zh?.[key] ?? key,
    },
    // 会话注册表 stub：cwd 解析器（stash 落盘位置）冒烟用。
    sessions: {
      list: {
        getSnapshot: () => ({
          current: "sess-1",
          byId: { "sess-1": { id: "sess-1", cwd: "C:\\ws\\sess-1" } },
        }),
      },
    },
    slots: {
      // 真实 slots.inject 的 callback 可返回单 entry（箭头函数 `() => register(...)`，
      // 对齐官方 example 与 plugin-registry）或可迭代（generator/array）。fakeCtx 兼容两种。
      inject: (key, callback) => {
        const result = callback();
        const entries = (result != null && typeof result[Symbol.iterator] === "function") ? result : [result];
        for (const entry of entries) if (entry) slotInjections.push({ key, entry });
      },
      register: (opts, component) => { const entry = { opts, component }; slotRegistrations.push(entry); return entry; },
    },
  };
  mod.apply(fakeCtx);
  return { localeRegistrations, slotRegistrations, slotInjections };
}

/** 等待 flush（controller 的异步 refresh/save 完成）。 */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const clientBundleGate = gate(
  "client-bundle",
  () => checkClientBundleText(readFileSync(CLIENT_PATH, "utf8")),
  () => {
    const problems = [];
    const bad1 = "window.ModuleLoader.load({ id: 'x', factory: (require) => {} });\n";
    if (checkClientBundleText(bad1).length === 0) problems.push("自证失败：无 __ModuleLoader__ 包装的样例未被拒绝");
    const bad2 = "window.__ModuleLoader__.load({ id: 'dsh-rider', factory: (require) => {\n  require('@deepseek-ai/dsh-client-ui-settings-plugins');\n  exports.name = 'dsh-rider'; exports.inject = []; exports.apply = () => {};\n  return module.exports;\n} });\n";
    const problems2 = checkClientBundleText(bad2);
    if (problems2.length === 0 || !problems2.some((p) => p.includes("白名单外"))) {
      problems.push("自证失败：白名单外 require 的样例未被拒绝");
    }
    return problems;
  },
);

const clientExecuteGate = gate(
  "client-execute",
  async () => {
    const problems = [];
    const stub = makeVisionFetchStub();
    let mod;
    try {
      mod = loadClientBundle(readFileSync(CLIENT_PATH, "utf8"), stub.fetch);
    } catch (error) {
      return [`client bundle 执行失败：${error.message}`];
    }
    if (mod.name !== "dsh-rider") problems.push(`client 导出 name 不符：${mod.name}`);
    if (!Array.isArray(mod.inject) || !["slots", "locale", "sessions"].every((s) => mod.inject.includes(s))) {
      problems.push(`client inject 未声明全部服务（slots/locale/sessions）：${JSON.stringify(mod.inject)}`);
    }
    if (mod.inject.includes("settingsScope")) problems.push("client inject 不应再声明 settingsScope（已改自建路由）");
    if (typeof mod.apply !== "function") return [...problems, "client 未导出 apply"];
    const { localeRegistrations, slotRegistrations, slotInjections } = runClientApply(mod);
    // controller 构造时异步 refresh（fetch GET），flush 后 loading 应回 false。
    await flushMicrotasks();
    const locale = localeRegistrations.find((r) => r.ns === "dsh-rider");
    if (!locale || !locale.dicts.zh || !locale.dicts.en) problems.push("locale 未注册 dsh-rider 中英字典");
    else for (const key of ["title", "description", "visionProvider", "visionModel", "visionPrompt", "save", "reset", "overridden", "loading", "loadFailed", "composerCaptureToggle", "composerCaptureHint", "composerTitle", "composerFailed", "declareTitle", "declareDesc", "declareModelLabel", "declareStatus", "declareDeclared", "declareNotDeclared", "declareBtn", "declareRemoveBtn", "declareDoing", "declareDone", "declareRemoved", "declareFailed", "declareNoVisionModel", "composerUploadToggle", "composerUploadHint", "uploadMaxMBLabel", "uploadMaxMBHint", "attachTitle", "attachStaging", "attachStashFailed", "attachTooLarge", "attachNoCwd", "attachRemove", "attachCopyRef", "attachRefCopied", "attachClear", "attachClearing", "attachRestaged", "attachButton", "dropTitle", "dropSub"]) {
      if (typeof locale.dicts.zh[key] !== "string" || typeof locale.dicts.en[key] !== "string") problems.push(`locale 字典缺键：${key}`);
    }
    const page = slotRegistrations.find((r) => r.opts?.name === "settings.section" && r.opts?.id === "dsh-rider");
    if (!page) {
      problems.push("未注册 settings.section / dsh-rider 设置页");
    } else {
      const face = page.opts.inject();
      const store = face.hooks?.riderVisionCard;
      if (!store || typeof store.getSnapshot !== "function" || typeof store.subscribe !== "function") {
        problems.push("设置页 inject 缺 hooks.riderVisionCard（getSnapshot/subscribe）");
      } else {
        const initial = store.getSnapshot();
        if (initial.loading === true) problems.push(`设置页初始 loading 应为 false（fetch 后）：${JSON.stringify(initial)}`);
        if (initial.loadFailed === true) problems.push(`设置页初始 loadFailed 应为 false：${JSON.stringify(initial)}`);
        if (initial.visionModel?.text !== "" || initial.visionProvider?.text !== "") problems.push("设置页初始字段文本应为空");
        if (initial.dirty !== false) problems.push("设置页初始 dirty 应为 false");
        // 编辑 → 保存
        face.edit("visionModel", "gpt-4o");
        const staged = store.getSnapshot();
        if (staged.visionModel?.text !== "gpt-4o" || staged.visionModel?.overridden !== true || staged.dirty !== true) {
          problems.push(`编辑后设置页状态异常：${JSON.stringify(staged)}`);
        }
        await face.save();
        await flushMicrotasks();
        const saved = store.getSnapshot();
        if (saved.visionModel?.text !== "gpt-4o" || saved.visionModel?.overridden !== true) {
          problems.push(`保存后设置页状态异常：${JSON.stringify(saved)}`);
        }
        const postCall = stub.state.calls.find((c) => c.method === "POST");
        if (!postCall) problems.push("保存未发起 POST 请求");
        // 清除（重置）→ 保存
        face.resetField("visionModel");
        if (store.getSnapshot().visionModel?.text !== "") problems.push("重置后草稿文本应为空");
        await face.save();
        await flushMicrotasks();
        const cleared = store.getSnapshot();
        if (cleared.visionModel?.text !== "" || cleared.visionModel?.overridden !== false) {
          problems.push(`清除保存后设置页状态异常：${JSON.stringify(cleared)}`);
        }
        // 丢弃
        face.edit("visionProvider", "openai");
        face.discard();
        const discarded = store.getSnapshot();
        if (discarded.dirty !== false || discarded.visionProvider?.text !== "") problems.push(`丢弃后设置页状态异常：${JSON.stringify(discarded)}`);
      }
      // 三个挂载点：settings.section（设置页）+ conversation.input.dock（粘贴捕获/附件卡片）
      // + conversation.input.left（回形针按钮）。
      const injectedKeys = slotInjections.map((s) => s.key).sort();
      const expectedKeys = ["conversation.input.dock", "conversation.input.left", "settings.section"];
      if (injectedKeys.length !== 3 || !expectedKeys.every((k) => injectedKeys.indexOf(k) >= 0)) {
        problems.push(`slots.inject 应挂载 settings.section 与 conversation.input.dock/left：${JSON.stringify(slotInjections)}`);
      }
      const dock = slotRegistrations.find((r) => r.opts && r.opts.name === "conversation.input.dock" && r.opts.id === "dsh-rider-composer-vision");
      if (!dock) problems.push("未注册 conversation.input.dock / dsh-rider-composer-vision（composer 粘贴捕获）");
      else if (typeof dock.component !== "function") problems.push("dock entry component 不是函数（应为 ComposerVisionDock）");
      const left = slotRegistrations.find((r) => r.opts && r.opts.name === "conversation.input.left" && r.opts.id === "dsh-rider-attach");
      if (!left) problems.push("未注册 conversation.input.left / dsh-rider-attach（回形针按钮）");
      else if (typeof left.component !== "function") problems.push("left entry component 不是函数（应为 AttachButton）");
    }
    return problems;
  },
  async () => {
    const problems = [];
    // 自证：白名单外 require 的 bundle 必须被沙箱拒绝
    const bad = "window.__ModuleLoader__.load({ id: 'dsh-rider', factory: (require) => {\n  require('@deepseek-ai/dsh-client-ui-settings-plugins');\n  exports.name = 'dsh-rider'; exports.inject = []; exports.apply = () => {};\n  return module.exports;\n} });\n";
    try {
      loadClientBundle(bad);
      problems.push("自证失败：白名单外 require 的 bundle 未被沙箱拒绝");
    } catch {}
    const noLoad = "module.exports = { name: 'dsh-rider', inject: [], apply: () => {} };\n";
    try {
      loadClientBundle(noLoad);
      problems.push("自证失败：未调用 __ModuleLoader__.load 的 bundle 未被沙箱拒绝");
    } catch {}
    return problems;
  },
);

const mdLinksGate = gate(
  "md-links",
  () => {
    const problems = [];
    const mds = [];
    for (const dir of [".", "decisions/implemented"]) {
      const full = join(ROOT, dir);
      if (!existsSync(full)) continue;
      for (const name of readdirSync(full)) {
        if (name.endsWith(".md") && statSync(join(full, name)).isFile()) mds.push(join(full, name));
      }
    }
    for (const file of mds) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target))) problems.push(`${relative(ROOT, file)} 的链接无法解析：${target}`);
      }
    }
    return problems;
  },
  () => {
    const problems = [];
    const sample = "# x\n\n[决策记录](decisions/implemented/2026-08-14-duckduckgo-mcp-bundle.md)\n";
    if (!/[决策记录]/.test(sample)) problems.push("自证样例自身失效");
    return problems;
  },
);

const decisionsGate = gate(
  "decisions",
  () => {
    const dir = join(ROOT, "decisions", "implemented");
    const problems = [];
    if (!existsSync(dir)) return ["decisions/implemented 不存在"];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      for (const heading of ["## Problem", "## Decision", "## Alternatives considered", "## Consequences"]) {
        if (!text.includes(heading)) problems.push(`${name} 缺少 ${heading}`);
      }
      const category = /^- 分类：(.+)$/m.exec(text);
      if (!category) problems.push(`${name} 缺少「分类：」行`);
      else if (!CATEGORIES.has(category[1].trim())) problems.push(`${name} 分类不在封闭集合：${category[1]}`);
      if (!/^- 日期：\d{4}-\d{2}-\d{2}$/m.test(text)) problems.push(`${name} 缺少「日期：YYYY-MM-DD」行`);
    }
    return problems;
  },
  () => {
    const check = (text) => {
      for (const heading of ["## Problem", "## Decision", "## Alternatives considered", "## Consequences"]) {
        if (!text.includes(heading)) throw new Error(`missing ${heading}`);
      }
      const category = /^- 分类：(.+)$/m.exec(text)?.[1]?.trim();
      if (!category || !CATEGORIES.has(category)) throw new Error("bad category");
      if (!/^- 日期：\d{4}-\d{2}-\d{2}$/m.test(text)) throw new Error("bad date");
    };
    const good = "## Problem\nx\n## Decision\nx\n## Alternatives considered\nx\n## Consequences\nx\n- 日期：2026-08-14\n- 分类：feature\n";
    const problems = [];
    for (const [label, text, expect] of [
      ["缺段", good.replace("## Consequences", "## Missing"), true],
      ["分类越界", good.replace("- 分类：feature", "- 分类：whatever"), true],
      ["合法记录", good, false],
    ]) {
      try {
        check(text);
        if (expect) problems.push(`非法决策记录未被拒绝（${label}）`);
      } catch (error) {
        if (!expect) problems.push(`合法决策记录被误拒（${label}）：${error.message}`);
      }
    }
    return problems;
  },
);

/* ---------------------------------- 执行 ---------------------------------- */

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
let failed = 0;

for (const g of [packageJsonGate, patchYamlGate, patchEntriesGate, entryGate, visionExecuteGate, stashExecuteGate, clientBundleGate, clientExecuteGate, mdLinksGate, decisionsGate]) {
  if (only && g.name !== only) continue;
  const self = await g.selfTest();
  if (self.length > 0) {
    failed += 1;
    console.error(`✗ ${g.name}: 自证测试失败（门禁自身不可信）`);
    for (const p of self) console.error(`    - ${p}`);
    continue;
  }
  const problems = await g.checkRepo();
  if (problems.length > 0) {
    failed += 1;
    console.error(`✗ ${g.name}`);
    for (const p of problems) console.error(`    - ${p}`);
  } else {
    console.log(`✓ ${g.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} 个门禁失败`);
  process.exit(1);
}
console.log("\n全部门禁通过");
