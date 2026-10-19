# Cloudflare 部署与迁移

项目可部署到 Cloudflare Workers，网页静态资源和三个后台接口放在同一个站点。千问继续提供语音及图片理解；无需在 Cloudflare 上运行大模型，也无需 GPU。

## 部署内容

| 内容 | 迁移方式 |
| --- | --- |
| 像素风首页、I SEE YOU 标题、设置和记录页面 | 继续使用原有构建结果与资源 |
| 场景选择、文字输入、摄像头预览与放大 | 保留原来的前端代码 |
| 连接检查 | `/api/access` |
| 千问实时语音连接 | `/api/realtime/sdp`，交换连接信息，实时媒体仍由浏览器与千问连接 |
| 图片理解、边生成边播报、位置证据 | `/api/vision`，保留普通与流式响应 |
| 物品记忆、历史对话、文字大小和声音偏好 | 继续保存在当前浏览器；不改存储键、不自动上传历史记录 |
| 路由和安全设置 | 在 Cloudflare 构建中生成 `_redirects` 和 `_headers`；后台接口也设置安全响应头 |
| 请求频率保护 | 使用 Cloudflare 的三个独立请求限制，保留原站每分钟 10/12/10 次限制 |

Cloudflare 不支持 `fetch` 的 `redirect: 'error'`。适配层使用 `manual` 并拒绝重定向，避免将千问密钥转发到其他地址。原来的 Netlify 函数仍可继续部署。

## 本地构建与部署

需要 Node.js 22 或更新版本。安装依赖后，部署工具版本由 `package-lock.json` 固定。

```sh
npm ci
npm run build:cloudflare
npx wrangler login
npm run deploy:cloudflare
```

`wrangler.jsonc` 中的 `account_id` 指向项目所有者的 Cloudflare 账号。其他人部署自己的副本时应换成自己的账号 ID 和项目名称。

在 Cloudflare 项目的设置中添加以下三个加密配置，或者用 `npx wrangler secret put 配置名称` 逐项输入。不要把配置值写进源代码、公开文件或聊天记录。

| 配置名称 | 填写内容 |
| --- | --- |
| `DASHSCOPE_API_KEY` | 原站使用的千问 API Key |
| `DASHSCOPE_WORKSPACE_ID` | 原站使用的业务空间 ID |
| `DASHSCOPE_REGION` | 原站使用的地域：`beijing` 或 `singapore` |

这些配置保存在运行环境中。构建不需要读取它们，网页包里也不包含它们。`/api/access` 只报告是否已配置，不能证明业务空间、模型权限或余额有效；需要实际测试图片与语音连接。

本地调试可创建被 Git 忽略的 `.dev.vars` 后执行 `npm run dev:cloudflare`。不要提交 `.dev.vars`、`.wrangler` 或日志。

## 关联 GitHub 自动更新

手动执行部署命令不会自动关联 GitHub。要让主分支更新后自动发布，需在 Cloudflare 当前 Worker 的设置中连接本 GitHub 仓库，生产分支选择 `main`，根目录为仓库根目录，构建命令为 `npm run build:cloudflare`，部署命令为 `npx wrangler deploy`。运行时密钥继续保留在 Worker 设置中，不需要复制到 GitHub。

连接后应检查一次主分支构建确实成功，不能把“代码已合并”视为“网站已更新”。

## 旧记录与旧入口

Netlify 和 Cloudflare 网址属于不同来源，浏览器不会自动共享物品记忆或对话。此次迁移已由项目所有者确认没有需要保留的旧记录，因此不转移历史数据。新站继续使用相同的本机保存方式；清除浏览器数据仍会清除记录。

旧的 `netlify.app` 域名属于 Netlify，无法直接搬到 Cloudflare。新入口需单独分享。旧站保留，后续是否关闭另行决定。

## 验证

```sh
node --test tests/cloudflare.test.mjs tests/web.test.mjs tests/conversation.test.mjs
```

本地检查覆盖连接配置、同站请求限制、请求频率保护、语音连接信息交换、图片结果、记忆位置证据、流式回答和拒绝重定向。已有四组浏览器检查覆盖界面、输入法、场景切换、记忆、历史对话与失败处理。

发布后还需检查新站的真实千问图片理解及实时连接，并用实际使用的手机网络验证访问。模拟检查不证明真实模型准确率、实际麦克风效果或全部网络环境可用。

参考：[Cloudflare 请求兼容性](https://developers.cloudflare.com/workers/runtime-apis/request/)、[静态资源配置](https://developers.cloudflare.com/workers/static-assets/binding/)、[GitHub 自动部署](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)。
