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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CATEGORIES = new Set(["feature", "bug-fix", "simplification", "architecture", "process", "testing"]);
const ENTRY_KEYS = new Set(["id", "name", "config", "disabled"]);
// 本仓库组合层允许的 insert 入口（当前仅自身 Node half；后续能力扩展时追加）。
const ALLOWED_ENTRY_NAMES = new Set(["dsh-rider"]);
const ENTRY_INJECT_REQUIRED = ["tools", "systemPrompt"];
const SECTION_MIN_ORDER = 110; // 内置 dsh-tool-web 的 web_search 指引 order，必须在其后

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
    tools: { register: (tool) => { tools.push(tool); } },
    systemPrompt: { section: (section) => { sections.push(section); } },
  };
  mod.apply(fakeCtx);
  if (tools.length === 0) {
    problems.push("apply() 未注册任何工具");
  } else {
    for (const tool of tools) {
      if (typeof tool.name !== "string" || tool.name === "") problems.push("工具缺少 name");
      if (typeof tool.description !== "string" || tool.description === "") problems.push(`工具 ${tool.name} 缺少 description`);
      // parameters 是作者层「隐式属性映射」，由 dsh-tools 的 defineTool 在加载时编译为
      // JSON schema（见 @deepseek-ai/dsh-tools 的 parameterSchemaSpecToJsonSchema）。这里只校验
      // 作者层形状——禁止把编译后形态 { type:'object', properties, required:[] } 直接当 parameters
      // （这正是 plugin tree 加载报 parameters.type must be a value schema object 的根因）。
      const params = tool.parameters;
      if (typeof params !== "object" || params === null || Array.isArray(params)) {
        problems.push(`工具 ${tool.name} parameters 必须是属性映射对象`);
      } else {
        if (params.query === undefined) problems.push(`工具 ${tool.name} parameters 缺少 query 属性`);
        for (const [key, spec] of Object.entries(params)) {
          if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
            problems.push(`工具 ${tool.name} parameters.${key} 必须是 value schema 对象（不是 ${typeof spec}）`);
          } else if (typeof spec.type !== "string" || spec.type === "") {
            problems.push(`工具 ${tool.name} parameters.${key} 缺少 type`);
          }
        }
        if (params.query !== undefined && params.query.required !== true) problems.push(`工具 ${tool.name} parameters.query 必须声明 required: true`);
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
      if (typeof pkg.main !== "string" || !existsSync(join(ROOT, pkg.main))) throw new Error("no main");
      if (typeof pkg.dependencies?.["ddg-kit"] !== "string") throw new Error("no ddg-kit dep");
    };
    const problems = [];
    try {
      check('{ "name": ');
      problems.push("非法 JSON 未被拒绝");
    } catch {}
    try {
      check(JSON.stringify({ name: "x", version: "0.1.0", license: "MIT", type: "module", files: [], dsh: { bundle: { patch: "./cordis.patch.yml" } }, main: "./index.mjs" }));
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

for (const g of [packageJsonGate, patchYamlGate, patchEntriesGate, entryGate, mdLinksGate, decisionsGate]) {
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
