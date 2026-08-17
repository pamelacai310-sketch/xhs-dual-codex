# Codex 项目生成器

这个目录把一个或多个小红书 JSON 导出合并、去重、脱敏并按主题整理为本地 Codex 项目。只需要 Python 3，不安装第三方包。

## 使用

macOS 可以把 JSON 文件或目录拖到 `build-codex-projects.command` 上，也可以双击后粘贴路径；带一层引号或 Finder 自动加入的反斜杠空格也能安全识别。Windows 可用 `build-codex-projects.cmd`。

命令行示例：

```sh
python3 build_codex_projects.py account-a.json account-b.json -o my-codex-projects
```

输入也可以是目录，程序会递归读取其中的 `.json` 文件，但会拒绝符号链接，避免越过所选目录读取其他文件。输出目录必须不存在或为空，以免覆盖已经整理的知识。

扩展导出必须选择 `sanitized` 模式，且 `schema_version`、`export_mode` 与匿名账号归属字段须符合当前精确契约。生成器会在任意嵌套层级拒绝 `private-archive`、旧版 `private-recovery` 及私密归档专用字段；请回到扩展重新导出可交给 Codex 的脱敏文件。普通、无扩展 schema 的旧 JSON 仍走兼容读取。

## 调整分类

直接编辑 `themes.json`：主题顺序也是分数相同时的优先顺序。分类会分别匹配标题、标签和正文，标签权重最高；没有命中关键词的材料会进入“待分类”。每篇材料只进入一个项目，避免 Codex 重复学习。`unclassified` 是系统保留的主题 ID，不能在自定义主题中使用。

## 输出

- `MASTER_INDEX.md`：全部项目与统计总索引。
- `AGENTS.md`：根目录的不可信数据边界与协作规则。
- `master_summary.json`：机器可读的脱敏统计。
- `projects/<主题>/AGENTS.md`：该项目的长期协作规则。
- `projects/<主题>/sources/SRC-*.md`：逐篇不可信来源材料，使用不透明编号。
- `projects/<主题>/LEARNING_QUEUE.md`：只包含不透明编号的学习队列。
- `projects/<主题>/KNOWLEDGE.md`：Codex 持续维护的经验库。

生成器按已知字段和编码模式执行白名单提取；链接中的身份令牌、Cookie、会话、签名 URL、策略参数、密码等已知能力型凭据会被移除，最多八层 HTML/百分号编码、嵌套链接和正文里的明显凭据赋值也会被遮蔽。来源标题、账号、标签、正文和链接全部按不可信数据处理，不会写入可信学习队列或项目指令。这是纵深防护，不是对任意未知秘密格式的绝对保证，因此仍应只输入 `sanitized` 导出或经人工确认的兼容 JSON。

输出先写入同目录下权限收紧的私有暂存目录，完成最终凭据审计后再原子发布；输出路径本身或任一父级若为符号链接会被拒绝。
