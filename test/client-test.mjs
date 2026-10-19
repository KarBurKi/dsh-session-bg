/**
 * Client 半自测：用假 DOM/React 驱动手写 bundle，验证"随 sessionId 打标记/清标记"的逻辑。
 * 运行：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/client-test.mjs
 */
import assert from "node:assert/strict";

const attrs = {};
const styleProps = {};
const surfaceAttrs = {};
let styleInjected = null;
let surfaceEl = null;

function makeElement(tag) {
  return {
    tagName: tag,
    attrs: {},
    children: [],
    textContent: "",
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

const html = makeElement("html");
html.style = {
  setProperty(name, value) {
    styleProps[name] = value;
  },
  removeProperty(name) {
    delete styleProps[name];
  },
};
html.setAttribute = (name, value) => {
  attrs[name] = value;
};
html.removeAttribute = (name) => {
  delete attrs[name];
};

const head = { children: [], appendChild(child) { this.children.push(child); } };

const scrollPort = {
  closest() {
    return surfaceEl;
  },
};

const documentStub = {
  documentElement: html,
  head,
  baseURI: "http://127.0.0.1:8147/",
  visibilityState: "visible",
  createElement(tag) {
    return makeElement(tag);
  },
  querySelector(selector) {
    if (selector === "style[data-dsh-session-bg-style]") {
      return head.children.find((child) => "data-dsh-session-bg-style" in child.attrs) ?? null;
    }
    if (selector === "[data-conversation-scroll]") return scrollPort;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === "[data-dsh-sbg-surface]") {
      return [surfaceEl].filter((el) => el && "data-dsh-sbg-surface" in el.attrs);
    }
    return [];
  },
  addEventListener() {},
  removeEventListener() {},
};

surfaceEl = makeElement("div");
surfaceEl.removeAttribute = (name) => {
  delete surfaceAttrs[name];
};
surfaceEl.setAttribute = (name, value) => {
  surfaceAttrs[name] = value;
};
Object.defineProperty(surfaceEl, "attrs", {
  get: () => surfaceAttrs,
});

const config = {
  enabled: true,
  sessions: {
    s1: { image: "api/dsh-session-bg/image?sid=s1&v=123", dim: 0.4, fit: "contain", position: "top" },
  },
};

let fetchCount = 0;
let requestedUrl = "";
globalThis.window = {};
globalThis.document = documentStub;
globalThis.fetch = async (url) => {
  fetchCount += 1;
  requestedUrl = url;
  return { ok: true, json: async () => config };
};

let captured = null;
window.__ModuleLoader__ = {
  load(definition) {
    captured = definition;
  },
};

await import("../lib/client.js");
assert.ok(captured, "bundle registered");
assert.equal(captured.id, "dsh-session-bg");

const reactStub = {
  useEffect(fn) {
    captured.cleanup = fn() ?? null;
  },
};

let component = null;
const moduleExports = captured.factory((name) => {
  if (name === "react") return reactStub;
  if (name === "react/jsx-runtime") return {};
  throw new Error(`unexpected require ${name}`);
});
assert.equal(typeof moduleExports.apply, "function");
assert.deepEqual(moduleExports.inject, ["slots"]);

const registrations = [];
const fakeCtx = {
  slots: {
    inject(seat, callback) {
      registrations.push(seat);
      callback();
    },
    register(options, Component) {
      registrations.push(options);
      component = Component;
      return () => {};
    },
  },
};
moduleExports.apply(fakeCtx);
assert.deepEqual(registrations[0], "conversation.session.header.actions");
assert.equal(registrations[1].id, "session-bg");
assert.ok(component, "component registered");
assert.ok(head.children.some((child) => "data-dsh-session-bg-style" in child.attrs), "style injected");

component({ sessionId: "s1" });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.match(requestedUrl, /^http:\/\/127\.0\.0\.1:8147\/api\/dsh-session-bg\/config$/);
assert.equal(attrs["data-dsh-session-bg"], "s1");
assert.match(styleProps["--dsh-sbg-image"], /api\/dsh-session-bg\/image\?sid=s1&v=123/);
assert.equal(styleProps["--dsh-sbg-dim"], "rgba(0, 0, 0, 0.4)");
assert.equal(styleProps["--dsh-sbg-fit"], "contain");
assert.equal(styleProps["--dsh-sbg-position"], "top");
assert.ok("data-dsh-sbg-surface" in surfaceAttrs, "surface tagged");

captured.cleanup?.();
assert.equal(attrs["data-dsh-session-bg"], undefined);
assert.equal(styleProps["--dsh-sbg-image"], undefined);
assert.ok(!("data-dsh-sbg-surface" in surfaceAttrs), "surface untagged");

console.log("client-test: all assertions passed");
process.exit(0);
