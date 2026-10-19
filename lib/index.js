/**
 * dsh-session-bg — Host 半
 *
 * 职责：
 * 1. 读 config.json（每次请求现读，改配置不用重启 DSH）：
 *    { "enabled": true, "sessions": { "<sessionId>": { "image": "D:\\...\\a.png", "dim": 0.35, "fit": "cover", "position": "center" } } }
 * 2. 暴露两个只读路由（仅本机回环可访问）：
 *    GET /api/dsh-session-bg/config         → 当前会话映射（图片转成带 mtime 的 URL）
 *    GET /api/dsh-session-bg/image?sid=...  → 该会话配置的图片字节（no-cache + ETag）
 * 3. 记录最近活跃会话到 current-session.json，供 bg.py --session current 使用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONFIG_FILE = path.join(ROOT, "config.json");
const SESSION_FILE = path.join(ROOT, "current-session.json");
const DEBUG_LOG = path.join(ROOT, "debug.log");
const PREFIX = "/api/dsh-session-bg";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

/** 读取并规范化配置；文件缺失/损坏时返回禁用状态，绝不抛出。 */
function readConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return { enabled: false, sessions: {} };
  }
  const sessions = {};
  const source = raw && typeof raw.sessions === "object" && raw.sessions !== null ? raw.sessions : {};
  for (const [sid, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object" || typeof sid !== "string" || sid === "") continue;
    const image = typeof entry.image === "string" ? entry.image.trim() : "";
    if (!image) continue;
    sessions[sid] = {
      image,
      dim: clamp(Number(entry.dim ?? 0.35), 0, 1),
      fit: entry.fit === "contain" || entry.fit === "repeat" ? entry.fit : "cover",
      position: typeof entry.position === "string" && entry.position.trim() !== "" ? entry.position.trim() : "center",
    };
  }
  return { enabled: raw?.enabled !== false, sessions };
}

/** 图片配置可以是绝对路径、相对本插件目录的路径，或 http(s)/data URL。 */
function resolveImagePath(image) {
  if (/^(?:https?:|data:)/i.test(image)) return null;
  return path.isAbsolute(image) ? image : path.resolve(ROOT, image);
}

function statFile(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "::ffff:7f00:1";
}

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

/** 只放行本机 GUI 的请求，拒绝跨站与远程访问。 */
function isAllowed(req) {
  try {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
    if (typeof req.headers.host !== "string") return false;
    const hostUrl = new URL("http://" + req.headers.host);
    if (!isLoopbackHostname(hostUrl.hostname)) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

/** 路由统一入口：校验来源、方法，捕获异常。 */
function guard(req, res, handler) {
  if (!isAllowed(req)) {
    writeJson(res, 403, { error: "forbidden" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    handler(req, res);
  } catch (error) {
    try {
      if (!res.headersSent) writeJson(res, 500, { error: String(error?.message ?? error) });
      else res.end();
    } catch {
      /* 忽略响应失败 */
    }
  }
}

function configView() {
  const cfg = readConfig();
  const out = { enabled: cfg.enabled, sessions: {} };
  if (!cfg.enabled) return out;
  for (const [sid, entry] of Object.entries(cfg.sessions)) {
    const file = resolveImagePath(entry.image);
    let url = entry.image;
    if (file !== null) {
      const st = statFile(file);
      if (st === null) continue;
      url = `api/dsh-session-bg/image?sid=${encodeURIComponent(sid)}&v=${Math.round(st.mtimeMs)}`;
    }
    out.sessions[sid] = { image: url, dim: entry.dim, fit: entry.fit, position: entry.position };
  }
  return out;
}

function serveImage(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sid = url.searchParams.get("sid") ?? "";
  const cfg = readConfig();
  const entry = cfg.enabled ? cfg.sessions[sid] : undefined;
  if (!entry) {
    res.writeHead(404).end();
    return;
  }
  const file = resolveImagePath(entry.image);
  if (file === null) {
    res.writeHead(302, { Location: entry.image }).end();
    return;
  }
  const st = statFile(file);
  if (st === null) {
    res.writeHead(404).end();
    return;
  }
  const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  };
  const ifNoneMatch = req.headers["if-none-match"];
  if (typeof ifNoneMatch === "string") {
    const hit = ifNoneMatch.split(",").some((value) => {
      const token = value.trim().replace(/^W\//, "");
      return token === etag || token === "*";
    });
    if (hit) {
      res.writeHead(304, headers).end();
      return;
    }
  }
  res.writeHead(200, { ...headers, "Content-Length": String(st.size) });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) writeJson(res, 500, { error: "read failed" });
    else res.destroy();
  });
  stream.pipe(res);
}

let lastSessionJson = "";

/** 运行期计数，用于确认浏览器端是否真的在用（GET /api/dsh-session-bg/state）。 */
const metrics = { config: 0, image: 0, lastConfigAt: "", lastImageAt: "", lastUserAgent: "" };

function noteRequest(kind, req) {
  metrics[kind] += 1;
  const now = new Date().toISOString();
  if (kind === "config") metrics.lastConfigAt = now;
  else metrics.lastImageAt = now;
  const ua = req?.headers?.["user-agent"];
  if (typeof ua === "string" && ua !== "") metrics.lastUserAgent = ua;
}

/** 记录当前会话，供 CLI（bg.py --session current）使用。 */
function recordSession(session, event) {
  try {
    const id =
      (session && typeof session.id === "string" && session.id) ||
      (event && event.data && typeof event.data.sessionId === "string" && event.data.sessionId) ||
      (session && session.meta && typeof session.meta.sessionId === "string" && session.meta.sessionId) ||
      "";
    if (id === "") return;
    const title =
      (session && typeof session.title === "string" && session.title) ||
      (session && session.meta && typeof session.meta.title === "string" && session.meta.title) ||
      "";
    const snapshot = {
      id,
      title,
      cwd: (session && typeof session.cwd === "string" && session.cwd) || "",
      updatedAt: new Date().toISOString(),
    };
    const text = JSON.stringify(snapshot, null, 2);
    if (text === lastSessionJson) return;
    lastSessionJson = text;
    fs.writeFileSync(SESSION_FILE, text + "\n");
  } catch {
    /* 记录失败不影响对话 */
  }
}

/** 打包一页/一条插件：注册路由与当前会话跟踪。 */
export function apply(ctx) {
  try {
    ctx.on("session/event", recordSession);
  } catch {
    /* session/event 不可用时忽略 */
  }
  try {
    ctx.inject(["webServer"], (web) => {
      try {
        const server = typeof web.get === "function" ? web.get("webServer") : undefined;
        if (!server || typeof server.register !== "function") return;
        web.effect(
          () =>
            server.register({
              kind: "exact",
              path: `${PREFIX}/config`,
              handler: (req, res) =>
                guard(req, res, () => {
                  noteRequest("config", req);
                  writeJson(res, 200, configView());
                }),
            }),
          "session-bg: config route",
        );
        web.effect(
          () =>
            server.register({
              kind: "exact",
              path: `${PREFIX}/image`,
              handler: (req, res) =>
                guard(req, res, () => {
                  noteRequest("image", req);
                  serveImage(req, res);
                }),
            }),
          "session-bg: image route",
        );
        web.effect(
          () =>
            server.register({
              kind: "exact",
              path: `${PREFIX}/state`,
              handler: (req, res) =>
                guard(req, res, () => {
                  let current = null;
                  try {
                    current = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
                  } catch {
                    current = null;
                  }
                  const cfg = readConfig();
                  writeJson(res, 200, {
                    enabled: cfg.enabled,
                    sessions: Object.keys(cfg.sessions),
                    current,
                    metrics,
                  });
                }),
            }),
          "session-bg: state route",
        );
        web.effect(
          () =>
            server.register({
              kind: "exact",
              path: `${PREFIX}/debug`,
              handler: (req, res) =>
                guard(req, res, () => {
                  try {
                    const url = new URL(req.url ?? "/", "http://localhost");
                    const msg = (url.searchParams.get("msg") ?? "").slice(0, 2000);
                    if (msg) fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
                  } catch {
                    /* 写日志失败不影响响应 */
                  }
                  res.writeHead(204).end();
                }),
            }),
          "session-bg: debug route",
        );
      } catch (error) {
        console.warn("[session-bg] route registration failed:", error);
      }
    });
  } catch (error) {
    console.warn("[session-bg] webServer unavailable:", error);
  }
}
