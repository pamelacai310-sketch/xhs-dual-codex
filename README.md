# 小红书收藏＋点赞 → Codex 项目

这是一个本机 Chrome 扩展和离线项目生成器，用于备份**自己账号当前可见**的“小红书收藏/赞过”索引与正文，再按主题整理为多个 Codex 工作目录。

版本：`1.0.2`

> 这是非官方个人归档工具，不隶属于小红书。网页接口和页面结构可能随时变化。请只处理自己有权查看和保存的内容，不要绕过验证、公开转载他人材料或高频请求。

## 从 GitHub 下载

推荐从本项目的 [Releases](https://github.com/pamelacai310-sketch/xhs-dual-codex/releases) 页面下载 `xhs-dual-codex-v<version>.zip`、同名 `.zip.sha256` 和 `.release.json`。GitHub 自动提供的 “Source code” 压缩包只是源码快照，不包含本工具生成的内部发布清单与配套校验文件。

如需开发，可克隆仓库后按本文“开发与验证”运行测试；日常安装仍建议使用 Releases 中经过打包器验证的版本。

## 解压前校验

下载 ZIP 与同名 `.zip.sha256` 后，先在两者所在目录运行：

```sh
LC_ALL=C shasum -a 256 -c xhs-dual-codex-v<version>.zip.sha256
```

它应显示 `OK`。校验值也必须来自你信任的交付位置；哈希只能确认字节一致，不能证明发布者身份。

## 最短使用流程

1. 解压本包。
2. 在 Chrome 地址栏打开 `chrome://extensions/`，开启右上角“开发者模式”。
3. 点击“加载未打包的扩展程序”。
4. 选择本包里的 **`extension` 文件夹**；打开该文件夹后应直接看到 `manifest.json`。
5. 在 Chrome 登录小红书网页版，进入自己的个人主页。
6. 分别打开“收藏”和“赞过”，每到一个栏目先刷新页面，再点扩展图标 →“开始采集并滚动”。
7. 等扩展自动停止。对每个小红书账号重复第 5–6 步。
8. 点“导出给 Codex（默认去敏）”，得到 `xhs-codex-sanitized-*.json`。
9. macOS：把一个或多个去敏 JSON 拖到 `builder/build-codex-projects.command`；Windows：拖到 `builder/build-codex-projects.cmd`。
10. 打开生成目录里的 `MASTER_INDEX.md`，再把 `projects/` 下不同主题目录分别交给 Codex。

扩展要求 Chrome 120 或更高版本。

当前网页通常使用 `?tab=fav` 表示收藏、`?tab=liked` 表示赞过。扩展也会根据真实列表接口判断，因此不依赖某一个固定标签名称。

## 它会生成什么

扩展把数据拆成三层，防止多账号互相覆盖：

- 笔记内容：按 `note_id` 全局去重。
- 账号栏目关系：按“账号 × 收藏/赞过 × note_id”分别保存。
- 采集记录：保存接口页数、游标、`has_more`、来源和停止原因等诊断信息。

项目生成器会合并多个 Chrome 配置文件导出的 JSON，移除敏感字段，再按 `builder/themes.json` 中的关键词分类。每个主题目录包含：

- `AGENTS.md`：Codex 在该主题中的长期规则。
- `sources/*.md`：逐篇去敏材料。
- `LEARNING_QUEUE.md`：待学习队列。
- `KNOWLEDGE.md`：Codex 持续沉淀的经验库。
- `README.md`：本主题材料索引。

这里的“学习”是把经验写入项目文件，**不是微调或永久训练模型参数**。只有默认去敏导出适合交给 Codex；“本机私密原始归档”含访问令牌，不能上传，也不能交给项目生成器。

## 怎样判断是否完整

扩展只在以下条件同时满足时，把**本次观察到的 API 游标链**标记为“完整”：

- 已核验账号和收藏/赞过栏目。
- 捕获到真实列表接口响应。
- 接口最终明确返回 `has_more: false`。
- 没有重复游标、账号切换、验证码、访问频繁或存储错误。

这个标记不保证平台账户历史库存绝对无缺漏：已删除、不可见、受限或平台未返回的内容仍可能缺失。仅从页面 DOM 扫描到链接、滚动后暂时不再出现新卡片，都只能标记“部分”。如果旧导出全部来自 DOM，或诊断仍显示 `has_more: true`，应视为不完整并用本版重新采集。

## 多账号与多个 Chrome 配置文件

- 同一 Chrome 配置文件内：逐个登录账号采集，扩展会按账号 ID 分开记录。
- 不同 Chrome 配置文件：每个配置文件各导出一个**去敏 JSON**，然后一次性把多个文件拖到项目生成器。
- 去敏文件用每个 Chrome 配置文件和账号各自持久的随机别名建立关系；它们不含真实小红书账号 ID，同一配置文件重复导出仍可合并，不同配置文件不会因都叫 `account-001` 而串库。
- 若扩展无法从个人页确认账号 ID，该次任务会标记“账号未核验”，不会自动与其他账号合并。

## 可选的正文补全

“开始低速补全”只处理弹窗中选定、且与当前已核验登录账号一致的一个栏目。它一次打开一个后台笔记标签页，采用低频分阶段检查，并在每篇完成后保存进度；浏览器或扩展后台暂停后可从未提交的条目继续。它必须由用户主动开始，也可以随时暂停。

- 先用少量数据测试。
- 出现安全验证、访问频繁、登录跳转或异常码时立即暂停。
- 不要尝试绕过验证码，也不要提高并发。
- 如果你主动切到扩展创建的标签页，任务会暂停且不会自动关闭该页。
- 为防止跨账号混入，不提供“一次补全全部账号”的模式；切换账号后要在对应个人主页重新选择栏目。

即使不补正文，标题、作者、链接等索引仍可导出；只是 Codex 能提炼的经验会比较有限。

## 隐私与权限

扩展权限限定为：

- `https://www.xiaohongshu.com/*`：只在小红书主站列表和详情页运行。
- `storage`：保存控制状态；笔记和账号栏目关系存入扩展自己的 IndexedDB。
- `alarms`：恢复低频正文补全队列。

扩展没有申请 Cookie、浏览历史、剪贴板、调试器、全站访问、网络拦截或外部消息权限。它不读取 Cookie，也不把数据发送到第三方服务器。

`xsec_token` 被当作敏感访问材料：只保存在账号栏目私密记录中；默认导出、诊断、Codex 项目和 Markdown 链接会按已知字段、已保存令牌值及常见编码模式尽力移除它。帖子正文仍是用户可见的原始材料，导出前应自行检查其中是否含私人信息。详见 [SECURITY.md](SECURITY.md)。

完成正文补全或私密备份后，可在扩展“清理”区域清除所选账号栏目的访问令牌，而不删除已经保存的标题与正文。

## 当前实现依据与限制

截至 2026-08-04，网页仍可观察到以下非公开接口：

- 收藏：`GET /api/sns/web/v2/note/collect/page`
- 赞过：`GET /api/sns/web/v1/note/like/page`
- 详情：`POST /api/sns/web/v1/feed`

这些是对当前网页 bundle 的逆向兼容观察，并非平台承诺的公开 API。扩展优先监听网页自己已签名的请求，不自行重放列表接口；接口变化后可能需要升级。

Chrome 实现采用两个 `document_start` 内容脚本：MAIN world 只观察匹配接口，并把账号自检响应投影为单个用户 ID；ISOLATED world 负责校验、标准化和传给后台。Fetch 响应使用 `clone()` 读取，不消耗网页自己的响应。

技术参考：[Chrome 内容脚本执行环境](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)、[Manifest `content_scripts`](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)、[扩展 Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[当前小红书用户页 bundle](https://fe-static.xhscdn.com/formula-static/xhs-pc-web/public/resource/js/async/User.50165359.js)。后一个链接只用于说明本版验证时观察到的网页实现，不构成稳定 API 文档。

已知限制：

- 本包无法在没有你的真实登录会话时完成实号端到端验证；安装后请确认诊断中的 XHR 或 Fetch 不为 0。
- 被删除、设为私密、失效或被平台限制访问的笔记可能无法补全。
- 页面和接口升级后，DOM 选择器、标签名称或响应字段可能变化。
- 本机项目文件并不代表模型推理一定在设备上完成；只把去敏后的内容交给 Codex。

## 开发与验证

扩展解析和权限测试：

```sh
node --test extension/tests/lib.test.js extension/tests/release-guards.test.js
```

项目生成器测试：

```sh
python3 -m unittest discover -s builder/tests -v
```

完整验证范围和人工实号检查见 [TESTING.md](TESTING.md)。

发布包同时附带 `.zip.sha256` 和 `.release.json`。在这三个文件位于同一目录时，可运行：

```sh
python3 xhs-dual-codex-v<version>/tools/package_release.py --verify /path/to/xhs-dual-codex-v<version>.zip
```

SHA-256 只能确认下载后的字节是否与发布值一致，不能证明发布者身份或替代代码审查。

## 合规提醒

登录后能查看内容，不等于拥有公开复制、传播或商业使用权。请限定为个人备份、私有研究和本地知识整理，并遵守小红书用户协议及适用法律。遇到安全验证或访问限制应停止，让用户在网页中人工处理；本工具不提供绕过机制。

平台规则：[小红书用户服务协议](https://agree.xiaohongshu.com/h5/terms/ZXXY20220331001/-1)。

## 开源许可证

本项目采用 [MIT License](LICENSE)。许可证只适用于本项目的软件代码和文档，不授予用户对所导出帖子内容的转载、传播或商业使用权。
