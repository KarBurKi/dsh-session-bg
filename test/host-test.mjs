/**
 * Host 半自测：不需要启动 DSH。
 * 运行：ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>" test/host-test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONFIG = path.join(ROOT, "config.json");
const FIXTURE = path.join(HERE, "fixture.png");

const routes = [];
const fakeServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
};
const ctx = {
  on() {},
  inject(_deps, callback) {
    callback({ get: () => fakeServer, effect: (fn) => fn() });
  },
};
apply(ctx);

const configRoute = routes.find((route) => route.path.endsWith("/config"));
const imageRoute = routes.find((route) => route.path.endsWith("/image"));
assert.ok(configRoute, "config route registered");
assert.ok(imageRoute, "image route registered");

function makeRequest(url, overrides = {}) {
  return {
    method: overrides.method ?? "GET",
    url,
    headers: { host: "127.0.0.1:8147", ...(overrides.headers ?? {}) },
    socket: { remoteAddress: overrides.address ?? "127.0.0.1" },
  };
}

function makeResponse() {
  const chunks = [];
  const state = { status: 0, headers: {} };
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.writeHead = (status, headers = {}) => {
    state.status = status;
    state.headers = headers;
    return res;
  };
  res.pipeInto = () => res;
  res.result = () => ({
    status: state.status,
    headers: state.headers,
    body: Buffer.concat(chunks),
    text: Buffer.concat(chunks).toString("utf8"),
  });
  return res;
}

function waitDone(res) {
  return res.writableFinished ? Promise.resolve() : new Promise((resolve) => res.once("finish", resolve));
}

const original = fs.readFileSync(CONFIG, "utf8");
try {
  fs.copyFileSync(FIXTURE, path.join(ROOT, "_fixture.png"));
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({
      enabled: true,
      sessions: {
        abc: { image: "_fixture.png", dim: 0.5, fit: "contain" },
        missing: { image: "_no_such_file.png" },
      },
    }),
  );

  // 1) 回环请求拿到会话映射，且缺失文件的会话被剔除
  {
    const res = makeResponse();
    configRoute.handler(makeRequest("/api/dsh-session-bg/config"), res);
    const payload = JSON.parse(res.result().text);
    assert.equal(payload.enabled, true);
    assert.ok(payload.sessions.abc, "abc present");
    assert.equal(payload.sessions.missing, undefined, "missing file session dropped");
    assert.match(payload.sessions.abc.image, /^api\/dsh-session-bg\/image\?sid=abc&v=\d+$/);
    assert.equal(payload.sessions.abc.dim, 0.5);
    assert.equal(payload.sessions.abc.fit, "contain");
  }

  // 2) 非回环请求被拒绝
  {
    const res = makeResponse();
    configRoute.handler(makeRequest("/api/dsh-session-bg/config", { address: "10.0.0.5" }), res);
    assert.equal(res.result().status, 403);
  }

  // 3) 未知 sid 404
  {
    const res = makeResponse();
    imageRoute.handler(makeRequest("/api/dsh-session-bg/image?sid=nope"), res);
    await waitDone(res);
    assert.equal(res.result().status, 404);
  }

  // 4) 已知 sid 返回图片字节 + ETag
  {
    const res = makeResponse();
    imageRoute.handler(makeRequest("/api/dsh-session-bg/image?sid=abc"), res);
    await waitDone(res);
    const out = res.result();
    assert.equal(out.status, 200);
    assert.equal(out.headers["Content-Type"], "image/png");
    assert.ok(out.body.length > 0, "image bytes served");
    assert.ok(out.headers.ETag, "etag present");
    // 5) If-None-Match 命中 → 304
    const res2 = makeResponse();
    imageRoute.handler(
      makeRequest("/api/dsh-session-bg/image?sid=abc", { headers: { "if-none-match": out.headers.ETag } }),
      res2,
    );
    await waitDone(res2);
    assert.equal(res2.result().status, 304);
  }

  console.log("host-test: all assertions passed");
} finally {
  fs.writeFileSync(CONFIG, original);
  try {
    fs.unlinkSync(path.join(ROOT, "_fixture.png"));
  } catch {}
}
