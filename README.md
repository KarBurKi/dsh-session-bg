# dsh-session-bg

给 DSH Web GUI 的**对话栏**按 `sessionId` 配独立背景图：切换会话就换背景，不重启 DSH。

## 原理

- **Host 半**（`lib/index.js`）：只读 `config.json`，暴露两个本机路由
  - `GET /api/dsh-session-bg/config` — 返回 `sessionId -> { image, dim, fit, position }` 映射（图片路径转成带 mtime 的 URL，换图自动失效）
  - `GET /api/dsh-session-bg/image?sid=...` — 只发送该会话配置的那张图（ETag / no-cache）
  - 同时在 `session/event` 里把最近活跃会话写进 `current-session.json`，供 `bg.py --session current`
- **Client 半**（`lib/client.js`）：不再依赖插槽 props（新版 DSH 的 `conversation.session.header.actions` 只传空对象），改成每秒读一次 `ctx.uiWorkspace.mainReference.sessionId` 拿当前会话 id，切会话立即换图，15 秒刷新一次配置；给对话栏根节点打 `data-dsh-sbg-surface` 标记，背景规则写成 `html[data-dsh-session-bg] [data-dsh-sbg-surface]` 并加 `!important`，压过宿主自己同权重的底板背景。未配置的会话恢复原样。
- **调试**：`GET /api/dsh-session-bg/debug?msg=...` 往 `debug.log` 追加一行；客户端首次挂载会自报挂载点、尺寸、计算出来的 `background-image` 和屏幕中心点上的元素，用来区分「没挂上」和「挂上了但被盖住」。

## 0.1.2 变更

- 会话 id 改从 `ctx.uiWorkspace.mainReference.sessionId` 读：旧版靠 `conversation.session.header.actions` 插槽的 props，新版宿主渲染该插槽时只传 `{}`，拿不到 id，于是「有配置、有请求、就是不上图」。
- 背景规则提到 `html[data-dsh-session-bg] [data-dsh-sbg-surface]` 并加 `!important`，避免被宿主同类选择器（`.root[data-phase]`）压掉。
- 挂载点多级回退：`[data-conversation-scroll]` 的 `[data-phase]` 祖先 → 最近的 `data-phase` 祖先 → `[class*=centerCol]` → `body`。
- 新增图片预取（先缓存再挂背景）与 `/api/dsh-session-bg/debug` 诊断路由。

## 用法

```bash
cd <home>\.dsh\plugins\dsh-session-bg

# 给"当前打开的会话"设置背景（最常用）
python bg.py set --session current --image "D:\pics\heroine.png"

# 指定某个 sessionId
python bg.py set --session <sessionId> --image "D:\pics\another.png" --dim 0.5 --fit contain

python bg.py list          # 查看映射
python bg.py current       # 查看最近活跃会话
python bg.py clear --session current
python bg.py clear --all
python bg.py disable       # 临时全局关掉
```

改完配置：GUI 里切换一次会话，或停留 15 秒（跟踪器每 15 秒拉一次配置），即可看到变化。

## 生效与验证

- 插件首次加入 profile 后，**刷新一次 GUI 页面（F5）即可**，不需要重启 DSH（已实测：`/api/dsh-session-bg/config` 与页面内图片请求都正常）。
- 改 `config.json` 后无需重启：切换会话或等 15 秒自动生效。
- Host 自检：`GET /api/dsh-session-bg/state` 返回最近 config/image 请求计数、最近活跃会话与已配置会话列表（该路由在插件加载后可用）。
- 离线自测：`test/host-test.mjs`（路由/白名单/ETag）、`test/client-test.mjs`（假 DOM 验证按 sessionId 打标记与清理）。

## 配置格式（config.json）

```json
{
  "enabled": true,
  "sessions": {
    "<sessionId>": {
      "image": "D:\\pics\\heroine.png",
      "dim": 0.35,
      "fit": "cover",
      "position": "center"
    }
  }
}
```

- `image`：本机绝对路径，或相对插件目录的路径，或 `http(s)://` / `data:` URL
- `dim`：0~1，黑色压暗层不透明度（默认 0.35，保证文字可读）
- `fit`：`cover` / `contain` / `repeat`
- `position`：`background-position` 值

## 注意

- 只监听回环地址（127.0.0.1 / localhost），远程设备访问不会拿到图片。
- 背景画在会话根节点（整个对话栏，含消息区与输入区）上；输入框、气泡保留自身底色。
- 皮肤（skin-center）设置的全局壁纸仍然生效，只是被本会话背景覆盖在对话栏区域。
- 停用：`python bg.py disable`，或把 `enabled` 改成 `false`。
