window.__ModuleLoader__.load({
  id: "dsh-session-bg",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    try {
      const CONFIG_URL = "api/dsh-session-bg/config";
      const ATTR = "data-dsh-session-bg";
      const SURFACE_ATTR = "data-dsh-sbg-surface";
      const REFRESH_MS = 15000;
      const WATCH_MS = 1000;

      const state = {
        config: null,
        fetchedAt: 0,
        inflight: null,
        sid: null,
        surface: null,
        url: "",
        probed: false,
        warned: {},
      };

      function warnOnce(key, error) {
        if (state.warned[key]) return;
        state.warned[key] = true;
        console.warn("[session-bg]", key, error || "");
      }

      function ensureStyle() {
        try {
          if (document.querySelector("style[data-dsh-session-bg-style]")) return;
          const style = document.createElement("style");
          style.setAttribute("data-dsh-session-bg-style", "");
          style.textContent = `
html[${ATTR}] [${SURFACE_ATTR}] {
  background-image:
    linear-gradient(var(--dsh-sbg-dim, transparent), var(--dsh-sbg-dim, transparent)),
    var(--dsh-sbg-image) !important;
  background-size: var(--dsh-sbg-fit, cover), var(--dsh-sbg-fit, cover) !important;
  background-position: var(--dsh-sbg-position, center), var(--dsh-sbg-position, center) !important;
  background-repeat: no-repeat, no-repeat !important;
  background-attachment: local, local !important;
}
`;
          (document.head ?? document.documentElement).appendChild(style);
        } catch {
          /* 注入样式失败时静默 */
        }
      }

      /** 对话栏根节点：多级回退，优先带 [data-phase] 的会话根。 */
      function chatSurface() {
        const pick = [
          () => {
            const scroll = document.querySelector("[data-conversation-scroll]");
            return scroll ? scroll.closest("[data-phase]") ?? scroll : null;
          },
          () => {
            const scroll = document.querySelector("[data-conversation-scroll]");
            if (!scroll) return null;
            let node = scroll.parentElement;
            for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
              if (node.getAttribute && node.getAttribute("data-phase")) return node;
            }
            return null;
          },
          () => {
            const column = document.querySelector('[class*="centerCol"]');
            if (!column) return null;
            return column.querySelector("[data-conversation-scroll]")?.closest("[data-phase]") ?? column;
          },
          () => document.body,
        ];
        for (const fn of pick) {
          try {
            const el = fn();
            if (el) return el;
          } catch {
            /* 换下一个候选 */
          }
        }
        return null;
      }

      /**
       * 一次性探针：Host 的 image 计数就是信号。
       * 命中正常表面 → 不打（只有预取 1 次）；只命中 body → +4；没找到 → +8。
       */
      function probe(surface) {
        if (state.probed) return;
        state.probed = true;
        const extra = !surface ? 8 : surface === document.body ? 4 : 0;
        for (let i = 0; i < extra; i += 1) {
          try {
            fetch(new URL(`api/dsh-session-bg/image?sid=__probe_${i}`, document.baseURI).href, {
              cache: "no-store",
            }).catch(() => {});
          } catch {
            /* 忽略 */
          }
        }
      }

      function clear() {        try {
          const html = document.documentElement;
          html.removeAttribute(ATTR);
          html.style.removeProperty("--dsh-sbg-image");
          html.style.removeProperty("--dsh-sbg-dim");
          html.style.removeProperty("--dsh-sbg-fit");
          html.style.removeProperty("--dsh-sbg-position");
          for (const el of document.querySelectorAll(`[${SURFACE_ATTR}]`)) {
            el.removeAttribute(SURFACE_ATTR);
          }
          state.surface = null;
          state.url = "";
        } catch {
          /* 忽略 */
        }
      }

      function apply(sessionId) {
        try {
          ensureStyle();
          const cfg = state.config;
          const entry =
            cfg && cfg.enabled !== false && sessionId && cfg.sessions
              ? cfg.sessions[sessionId]
              : undefined;
          if (!entry || typeof entry.image !== "string" || entry.image === "") {
            clear();
            return;
          }
          const url = new URL(entry.image, document.baseURI).href;
          const dim = typeof entry.dim === "number" ? Math.min(1, Math.max(0, entry.dim)) : 0.35;
          const fit = entry.fit === "contain" || entry.fit === "repeat" ? entry.fit : "cover";
          const position =
            typeof entry.position === "string" && entry.position !== "" ? entry.position : "center";
          const html = document.documentElement;
          html.style.setProperty("--dsh-sbg-image", `url("${url.replace(/["\\]/g, "\\$&")}")`);
          html.style.setProperty("--dsh-sbg-dim", `rgba(0, 0, 0, ${dim})`);
          html.style.setProperty("--dsh-sbg-fit", fit);
          html.style.setProperty("--dsh-sbg-position", position);
          html.setAttribute(ATTR, sessionId);

          const surface = chatSurface();
          if (surface) {
            if (state.surface && state.surface !== surface) {
              try {
                state.surface.removeAttribute(SURFACE_ATTR);
              } catch {
                /* 旧节点已卸载 */
              }
            }
            if (!surface.hasAttribute(SURFACE_ATTR)) surface.setAttribute(SURFACE_ATTR, "");
            state.surface = surface;
          } else {
            warnOnce("no-surface", "conversation surface not found");
          }

          // 预取：即使根节点还没挂上，也让图片先进入缓存并让 Host 端计数可见。
          if (state.url !== url) {
            state.url = url;
            try {
              const img = new Image();
              img.decoding = "async";
              img.src = url;
            } catch {
              /* 预取失败不影响背景 */
            }
          }
          probe(surface);
        } catch (error) {
          warnOnce("apply", error);
        }
      }

      function fetchConfig(force) {
        const now = Date.now();
        if (!force && state.config && now - state.fetchedAt < 10000) {
          return Promise.resolve(state.config);
        }
        if (state.inflight) return state.inflight;
        const url = new URL(CONFIG_URL, document.baseURI).href;
        state.inflight = fetch(url, { credentials: "same-origin", cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)
          .then((config) => {
            state.inflight = null;
            state.fetchedAt = Date.now();
            state.config = config && typeof config === "object" ? config : null;
            return state.config;
          });
        return state.inflight;
      }

      /** 当前主视图的会话 id：uiWorkspace 为主，浏览器地址与会话根节点 dom 为辅。 */
      function resolveSessionId(ctx) {
        try {
          const ws = ctx && ctx.uiWorkspace;
          const ref = ws && ws.mainReference;
          if (ref && typeof ref.sessionId === "string" && ref.sessionId !== "") return ref.sessionId;
          const st = ws && ws.state;
          const stRef = st && st.mainReference;
          if (stRef && typeof stRef.sessionId === "string" && stRef.sessionId !== "") return stRef.sessionId;
          if (typeof ws?.currentSessionId === "string" && ws.currentSessionId !== "") return ws.currentSessionId;
        } catch {
          /* 忽略 */
        }
        try {
          const hit = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(
            location.href,
          );
          if (hit) return hit[0];
        } catch {
          /* 忽略 */
        }
        return "";
      }

      function applyPlugin(ctx) {
        ensureStyle();
        let disposed = false;
        let lastTickAt = 0;

        const run = (force) => {
          const sid = resolveSessionId(ctx);
          if (!sid) {
            if (state.sid !== "") {
              state.sid = "";
              clear();
            }
            return Promise.resolve();
          }
          const changed = sid !== state.sid;
          state.sid = sid;
          if (!changed && !force) return Promise.resolve();
          return fetchConfig(changed || force).then(() => {
            if (!disposed) apply(sid);
          });
        };

        run(true);

        // 1 秒看一次会话是否切换（只读本地状态，不发网络请求）。
        const watcher = setInterval(() => {
          const sid = resolveSessionId(ctx);
          if (sid && sid !== state.sid) run(true);
          lastTickAt = Date.now();
        }, WATCH_MS);
        if (watcher && typeof watcher.unref === "function") watcher.unref();

        // 15 秒刷新一次配置（改 config.json 后自动生效）。
        const refresher = setInterval(() => {
          run(true);
        }, REFRESH_MS);
        if (refresher && typeof refresher.unref === "function") refresher.unref();

        const onVisibility = () => {
          if (document.visibilityState === "visible") run(true);
        };
        document.addEventListener("visibilitychange", onVisibility);

        if (ctx && typeof ctx.on === "function") {
          ctx.on?.("dispose", () => {
            disposed = true;
            clearInterval(watcher);
            clearInterval(refresher);
            document.removeEventListener("visibilitychange", onVisibility);
            clear();
          });
        }
      }

      exports.apply = applyPlugin;
      exports.inject = ["uiWorkspace"];
    } catch (error) {
      console.warn("[session-bg] client bundle failed:", error);
      exports.apply = () => {};
      exports.inject = [];
    }
    return module.exports;
  },
});
