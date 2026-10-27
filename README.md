# 泛读 · Reading Cards

**先自己想，再和 AI 讨论。** 一个本地运行、以 Markdown 为底稿的极简论文阅读卡片工具。

Local-first reading cards for active learning. Write your own understanding, link a Zotero paper, and optionally discuss it with Codex. No mandatory AI, no automatic summaries in your notes, no hosted service.

## 为什么做这个

泛读时容易卡在一个术语、一个图，或“不知道作者为什么这样分析问题”。这个工具不替你读论文，而是把你自己的理解、讨论和待补知识放在一起，让下次继续阅读时有地方接上。

每张卡片只有四个可留空的问题：

1. 它在解决什么问题？
2. 作者怎么分析这个问题？
3. 大概怎么做？
4. 我卡在哪里？

## 功能

- 卡片 / Markdown / 预览三种视图，自动保存、草稿恢复、版本冲突保护。
- 按领域分类与搜索；文件可手动重命名，也可根据题目生成名字。
- 只读搜索本机 Zotero，人工选择论文及 PDF，可跳到指定 PDF 页。
- 可选网页聊天：复用本机 Codex CLI 的 ChatGPT 登录，不填写 API Key。
- 一键“检查我的理解”：先保存，再附上当前题目、四块正文、可用论文文本与最近讨论。
- “结束本次讨论并更新回顾”：整理讨论主题、澄清内容、遗留问题和下次起点；保留旧版本及完整聊天。
- 所有卡片共用一个待补知识索引；是否已掌握由你勾选，不为每个术语新建一篇笔记。

AI 不会自动改写你的阅读正文。

## 快速开始

需要 **Node.js 22 或更高版本**。没有第三方运行依赖，也不需要构建。

```sh
git clone https://github.com/Unik-lif/reading-cards.git
cd reading-cards
npm start
```

打开 <http://127.0.0.1:4317/>。笔记默认保存到项目的 `data/notes/`，已被 Git 忽略。

macOS 也可以双击 `打开阅读卡片.command`；使用期间保留启动窗口。初版主要在 macOS 验证；其他平台可尝试 `npm start`，Zotero/Codex 的外部链接与平台支持可能不同。

### 可选：论文绑定

启动 Zotero，在设置的高级选项中允许此计算机上的其他应用与 Zotero 通信。点击“绑定论文”搜索个人文库，由你确认条目和附件；两者不是同一个编号。

接口不可用时可粘贴 Zotero 原生链接。群组库支持手动链接，但搜索和全文索引仅支持本机个人文库。

### 可选：网页讨论

另外安装官方 [Codex CLI](https://github.com/openai/codex)，并自行完成 ChatGPT 登录。后端通过官方 [App Server](https://learn.chatgpt.com/docs/app-server) 接入，认证由 CLI 管理，不读取或复制凭据文件。适配曾在 CLI 0.160.1 上验证；接口升级后可能需要调整。

发送讨论会使用现有账号的模型、网络及额度，不是离线 AI，也不保证无限可用。没有 CLI 或网络仍可正常记笔记。当前只支持 ChatGPT 登录，不会自动切到收费 API Key 模式。

结束讨论后，主动点击“结束本次讨论并更新回顾”，等待出现“本次回顾已保存，可以关闭”再关机。它不是关机钩子，不会在退出时自动调用模型。未发送的草稿不参与整理，失败不会替换旧回顾。

### 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `READING_CARDS_DIR` | 项目内 `data/notes/` | 卡片与讨论保存目录 |
| `READING_CARDS_PORT` | `4317` | 本机监听端口 |
| `READING_CARDS_CODEX` | PATH 中的 `codex` | Codex 可执行文件路径 |

例如 macOS/Linux：

```sh
READING_CARDS_DIR="/absolute/path/to/reading-notes" READING_CARDS_PORT=4318 npm start
```

Finder 启动器使用默认端口 4317；自定义端口请从终端启动。默认端口已占用时，不要直接结束陌生进程，换一个端口即可。

## 数据与备份

```text
data/notes/
  YYYY-MM-DD 论文题目.md          # 你写的正文和关联元数据
  .discussions/
    <稳定卡片ID>.json             # 聊天、历次回顾和状态
```

正文是 UTF-8 Markdown，元数据使用兼容 YAML 的单行 JSON。旧文件缺少可选字段时不会批量重写；外部重命名保留 `id` 和 `type` 即可识别。

请备份整个数据目录，包括隐藏的 `.discussions/`。下载正文副本不包含聊天，需另点“下载讨论记录”导出 Markdown。浏览器草稿仅作尽力备份，磁盘保存结果才是依据。

不自动导入已有 Codex 聊天，也不读取其私有聊天数据库；可选保存旧对话深链接以便回看。

## 隐私与边界

- 网页后端只监听 `127.0.0.1`，校验 Host/Origin，不开放 CORS。**不要改成公网监听、反向代理或多人服务**；没有多用户认证。
- 普通笔记编辑不调用模型。点击发送时会交给 Codex：当前卡片、最近最多 20 条讨论（最多 60000 字符）、最新回顾和可用 PDF 索引文本（最多 150000 字符）。正文超过 80000 字符时拒绝发送，不静默截断。
- 整理回顾时发送旧回顾与新增聊天，最多 160000 字符；不主动重新读取论文核验，不把回顾当成用户已掌握的证明。
- Zotero 代理只向固定的本机接口发 GET，不接受任意代理地址。索引文本没有图像，可能缺少页码；扫描件、未索引 PDF 或离线时会标注缺少原文。
- 模型会话关闭命令执行、外部插件、Apps、浏览器、Hooks 及继承的 MCP 服务，并使用只读设置。但这不是经过安全审计的隔离产品，请勿将其当作运行恶意材料的强安全边界。
- 保存冲突不会覆盖外部版本，但没有跨进程文件锁；不要同时启动两个实例编辑同一目录。
- 突然断电可能丢失未落盘的流式输出。失败或中断的生成不会自动重发；旧回顾保留。
- Markdown 预览支持常用语法，不执行原始 HTML，不加载远程图片；复杂公式、表格和嵌套列表请用其他编辑器查看。

MIT 许可证只覆盖本仓库软件，不涵盖论文、Zotero、Codex 或任何模型服务。使用第三方服务需遵守其条款。本项目不隶属于 OpenAI 或 Zotero。

## 开发

```sh
npm test
```

测试在临时目录运行，覆盖保存、冲突、关联、重命名、聊天、回顾失败及恢复。测试不调用真实模型，不需要登录；测试文献编号和对话链接均为虚构夹具。

项目使用原生 Node.js HTTP 服务和原生浏览器 JavaScript：`server.mjs` 为入口，`store.mjs` 管理卡片，`discussions.mjs` 管理聊天与回顾，`codex.mjs` / `zotero.mjs` 是可选适配器，`dist/` 是可直接提供的前端源码，`templates/` 是空白卡片模板。

欢迎提交 issue 或 PR。附日志前请删除笔记、论文内容、本机路径、聊天记录和凭据。

## License

[MIT](LICENSE)
