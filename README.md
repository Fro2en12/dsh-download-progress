# dsh-download-progress

> DSH web 插件：**下载进度面板**。URL 下载器、agent shell/SSH 传输追踪、工作区黑箱下载监控，全部汇聚到一个可拖拽的右下角浮窗，实时显示字节数、速度、百分比与预计剩余时间。

English: A DeepSeek Harness (DSH) web plugin that surfaces a draggable download-progress panel in the bottom-right corner of the web GUI. It tracks panel-started URL downloads, agent shell/SSH transfers, and any "black-box" file growth inside registered workspaces — with live bytes, speed, percentage and ETA.

## ⚠️ AI 产物声明

**本项目为 AI（DeepSeek 驱动的智能体）产物**：功能设计、架构选型、代码编写、测试与文档均由 AI 在对话中迭代完成，人工仅提供需求与验收反馈。

- 开发过程中经真机验证（下载器、SSH/shell 追踪、黑箱监控、拖拽交互均有实测记录），但边界情况无法穷尽，生产使用前请自行审阅与测试；
- 欢迎提交 Issue / Pull Request 修正问题或扩展能力；
- 本项目基于 MIT 协议开源，可自由使用、修改与分发。

## 功能特性

| 来源 | 图标 | 说明 |
|---|---|---|
| 面板下载器 | 🌐 | 面板输入 URL 下载，或让 agent 调用 `download_url` 工具。curl 后台执行，HEAD 预取 `Content-Length` 得到真实百分比；可在面板单独取消 |
| shell 下载追踪 | 💻 | 自动解析 `pwsh`/`bash` 工具命令中的 `curl -o` / `Invoke-WebRequest -OutFile` / `wget -O`，提取目标路径与 URL（含 HEAD 总大小）。小于 64 KB 的响应静默忽略 |
| SSH 传输追踪 | ⇩ / ⇧ | 自动追踪 `ssh_download`（字节/速度实时增长）与 `ssh_upload`（不定进度 + 源文件大小） |
| 黑箱下载监控 | 📥 | 每 1.5s 扫描 `workspaceRegistry` 中全部工作区的顶层：任何增长 ≥64 KB 的文件或新目录（git clone、BITS、变量路径下载等）都会被捕捉，最多并发追踪 3 个 |
| 拖拽面板 | — | 胶囊按钮与面板均可拖动（视口内自动夹取）、`↺` 一键复位；拖动与点击严格分离，不会误触 |

模型工具：

- `download_url` — 后台下载 URL 到工作区（`dest` 省略时按 URL 文件名存到工作区根目录，目标目录需已存在）
- `download_status` — 查询所有任务实时进度

## 安装

### 方式一：DSH 插件市场（推荐）

GUI 内打开插件市场，搜索 `dsh-download-progress`，一键安装。

### 方式二：dsh plugin add

```sh
dsh plugin --profile web add https://github.com/Fro2en12/dsh-download-progress
```

### 方式三：手动挂载

```sh
git clone https://github.com/Fro2en12/dsh-download-progress
# 编辑 profiles/web/cordis.patch.yml，在 plugins 后追加：
#   - insert:
#       - id: dsh-download-progress
#         name: 'dsh-download-progress'
```

安装后重启 `dsh web`，右下角出现 `⬇ 下载` 胶囊按钮即成功。

## 使用说明

- **手动下载**：点击胶囊展开面板，粘贴 `http(s)` 链接，可选填保存路径（绝对路径，或相对工作区根目录），回车或点「下载」；
- **自动追踪**：无需任何操作——agent 的 `ssh_download`/`ssh_upload`、`pwsh`/`bash` 里的 curl/iwr/wget、以及工作区中任何增长中的文件都会自动出现在列表；
- **取消**：仅面板发起的 URL 下载可取消；SSH/shell 传输请中断对应工具调用；
- **清理**：`✕` 移除单条记录，`清除` 清空全部已完成/失败记录；完成记录 10 分钟后自动回收（上限 40 条）。

## 架构

```
lib/index.js   Host 半部分（ESM，注入 webServer/timer）
  ├─ /api/download-progress/*  面板 RPC（state/download/cancel/dismiss/clear-finished）
  ├─ 工具注册                  download_url / download_status（ctx.tools.register）
  ├─ tools/execute|result      追踪 ssh_* 与 pwsh/bash 下载
  ├─ 轮询引擎（400ms）         文件大小采样 → 字节/速度/百分比/ETA + 静止判定
  └─ 工作区扫描（1500ms）      黑箱文件增长监控
lib/client.js  Client 半部分（AMD bundle，注入 slots）
  ├─ shell.overlay 注册        右下角浮窗（可拖拽）
  └─ fetch 轮询                500ms（面板展开）/ 2000ms（收起）刷新状态
```

### 关键机制与阈值

| 机制 | 说明 |
|---|---|
| 百分比 | 下载前 HEAD 请求解析 `Content-Length`；无总大小的任务显示字节+速度与流动进度条 |
| 速度 | 相邻采样差分，`0.6·旧 + 0.4·瞬时` 平滑 |
| 完成判定（shell） | 工具结束后文件大小连续稳定约 4s（10 个采样）才判完成；30s 兜底。防止后台任务/网络抖动被提前误判 |
| 完成判定（黑箱） | 连续 3 次扫描无增长 |
| 最小展示阈值 | shell 下载 <64 KB 静默不显示；黑箱增长 ≥64 KB 才上榜 |
| 并发上限 | 黑箱任务最多 3 个；总记录上限 40 条，完成 10 分钟后回收 |
| 生命周期 | 所有监听/轮询/路由/工具注册随插件 Fiber 卸载；停止插件会终止仍在运行的 curl 进程树 |

## 已知限制

- 下载引擎依赖 `curl`（Windows 10+ 自带；Linux/macOS 一般内置）；目标目录必须已存在；
- 无 `Content-Length` 的服务器（分块传输）只显示字节/速度，无百分比；
- 命令中的变量路径（`$env:...`、拼接变量）无法解析时由黑箱监控兜底，不提供百分比；
- 上传任务无法观测远端写入量，仅显示不定进度；
- 黑箱监控只扫描工作区顶层与新建目录（深度遍历按需进行，每个目录最多统计 500 个文件），嵌套在既有深层目录中的下载可能不被捕捉。

## 开发

无需构建：`lib/index.js`（ESM）与 `lib/client.js`（AMD bundle）即发布形态。

```sh
node --check lib/index.js   # host 语法检查
```

## License

MIT
