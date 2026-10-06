# 后端接手文档 2026-10-06

## 本日范围

修复线上 v0.7.2 实例真实命中的新建存档缺陷链，以及让它无法自愈的状态机缺口。
所有改动直接落在本地 `main`，未创建分支。

## 改了什么

### 1. gameloader 指针自愈（`saves.go`、`lifecycle.go`）

**现象**：用户新建存档后，`junimohost.gameloader.json` 被 JunimoServer 写成
`EM_3935490074948765276`，而真实存档目录是
`鹈鹕镇第一人民_3935490074948765276`。面板自己的读取路径有
`suffixMatchSaveDir` 兜底（所以 UI 显示正确），但**磁盘文件从未被修正**。
JunimoServer 不做后缀匹配，重启时找不到该目录，于是**静默新建了一个农场**，
产生第二个存档。

**修复**：

- 新增 `RepairGameloaderPointer(dataDir) (string, bool, error)`：
  指针指向的目录不存在、且恰好有一个目录共享同一个尾部 `_<uniqueID>` 时，
  用 `writeGameloaderPointer` 回写真实目录名；歧义或无法解析时保持原样。
- `lifecycle.go` 的 `doStart` 在 `docker compose up` 之前调用它，best-effort，
  失败只记 job 日志，不阻断启动。

**影响**：所有启动路径（普通启动、重启、新建存档启动）都会在开服前修正指针。
新建存档路径下旧指针指向仍存在的旧存档，因此是 no-op。

### 2. Control 身份校验：后缀容错 + 有界 settle 窗口（`new_game_durability.go`）

**现象**：`new_game_control_identity_mismatch` 在 `/newgame` 返回后**同一秒**就
判失败，而游戏在 ~1 秒后成功建档并生成邀请码。任务失败使实例进入
`new_game_recovery_required`，而 Control 的身份证据随后被重启冲掉，事务再也无法收敛。

**修复**：

- 新增 `sameGameSaveIdentity` / `saveUniqueIDSuffix`：完全相等，或两侧共享同一个
  纯数字 `_<uniqueID>` 后缀时视为同一世界。用于 `inspectNewGameControlDurability`
  的 `SaveID`、`CustomizationSaveID`、`FarmCaveChoiceSaveID` 和 `players.json`
  的 `SaveID` 四处比较（与 `saves.go` 既有的后缀兜底保持一致）。
- `newGameControlDurabilityWaitOptions` 增加 `IdentitySettleWindow`；默认
  `newGameControlIdentitySettleWindow = 90s`（0 用默认值，负值恢复旧的快速失败）。
  在窗口内，既不属于目标也不属于旧基线的 `save-loaded` 快照按"Control 尚未发布
  新身份"重试；窗口耗尽后仍然是终态失败，绝不放过错误的存档。

**安全性**：`new-game-control` 的等待只是推迟判定，save-now 命令仍然只在全部身份与
定制校验通过后才发出，因此不会保存一个定制错误的世界。

## 影响哪些接口 / 文件

| 文件 | 变化 |
| --- | --- |
| `backend/internal/games/stardew_junimo/saves.go` | 新增 `RepairGameloaderPointer` |
| `backend/internal/games/stardew_junimo/lifecycle.go` | `doStart` 前置指针修复 |
| `backend/internal/games/stardew_junimo/new_game_durability.go` | 身份后缀容错、settle 窗口、新常量 |
| `backend/internal/games/stardew_junimo/saves_test.go` | 3 个指针修复用例 |
| `backend/internal/games/stardew_junimo/new_game_durability_test.go` | 身份比较 6 例、瞬时/持续不匹配各 1 例 |

对外 HTTP 接口**没有变化**，错误码集合也没有新增。

## 如何验证

```bash
# 定点回归
go -C backend test ./internal/games/stardew_junimo/ -count=1 \
  -run "TestRepairGameloaderPointer|TestSameGameSaveIdentity|TestWaitForNewGameControlDurability"
# 全量
go -C backend test ./... -count=1
```

端到端复现路径（真实 Docker）：

1. 造一个指针 `X_<uid>` 而目录是 `Y_<uid>` 的实例。
2. 启动 → 日志出现"已修正新存档指针（JunimoServer 写入了错误的农场名前缀）"，
   `Saves/` 目录数量不变（**这正是修复前会多出一个世界的地方**）。
3. 另造一个 Control 先写外来 `saveId`、30ms 后写目标 `saveId` 的场景 →
   等待函数应在 settle 窗口内收敛而不是立即失败。

### 3. 新建存档不再继承旧存档角色（`saves.go`、`lifecycle.go`）

**现象**：新建的存档不是全新的空档，而是**继承了上一个存档的 farmhand 角色**。
实测两个存档的 `<farmhands>` 对比：

| | 旧档 `EM_<uid>` | 新档 `<farmName>_<uid>` |
| --- | --- | --- |
| EeiMoo | `mp=2456427634486916985`，money=504，home=FarmHouseb37d1e14 | **同一个 mp、同一 money、同一 home** |
| 云钰 | `mp=3218377211705406547`，money=504，home=FarmHouse243917f6 | **同一个 mp、同一 money、同一 home** |
| Server | `mp=3784890483723811648`，money=504，home=FarmHouse3a4fef76 | **同一个 mp、同一 money、同一 home** |
| 空位 | Axe `mp=-5091830112777305997`，money=500 | 3 个全新 Axe，money=500 |

同时新档出现指向旧档 FarmHouse 的孤儿 farmhand，JunimoServer 只能靠
`Healed lobby-homed farmhand` 逻辑勉强安置。

**根因（上游 JunimoServer）**：`GameCreatorService.CreateNewGameCore()` 跳过 vanilla
标题界面的 `ResetGameStateOnTitleScreen()`（该符号在整个 JunimoServer 仓库里只出现在
这行注释中），却只补偿了 `Game1.uniqueIDForThisGame` 的重掷，没有清理
`Game1.otherFarmers`。而 `/newgame` 是发往**已经加载了旧存档的同一个进程**的，
于是旧存档的 farmhand 对象在内存中存活，并在新档首次保存时被一起序列化。

**修复**：在 `doStart` 的新建存档分支、`ComposeRecreateServices` 之前做一次隔离：

1. `ClearGameloaderPointer`（`saves.go` 新增）删除 `junimohost.gameloader.json`。
   JunimoServer 的 `GameLoaderService.HasLoadableSave()` 在指针缺失时直接返回 false，
   **即使 `Saves/` 里仍有其它存档也不会加载**，因此这是唯一需要的开关；
2. 把 `newGameTx.record.CreationWriter` 强制为 `startup` 并持久化，使事务不再走
   `waitForHTTPNewGameBaseline` / `POST /newgame`，而是在空名册进程里由 JunimoServer
   启动建档。指针缺失本身也会让 `chooseNewGameCreationWriter` 选择 startup，第 2 步
   只是把已在内存中算出的选择对齐到磁盘事实。

**刻意不加显式停服**：`ComposeRecreateServices` 本就会强制重建容器，读到指针的一定是
全新进程，所以不需要额外的 `ComposeDown`。第一版实现额外调用了
`stopRuntimeServices`，结果破坏 5 个既有的失败延迟/回滚契约测试（多出一次
ComposeDown、失败阶段被改写成 `new_game_isolation_stop_failed`），已在提交前移除。
新增的隔离步骤只做两件幂等且可回滚的事，不引入新的停服语义。

**存档安全**：只删指针文件，**不移动也不删除任何存档目录**。改动前的指针原始字节早已
由事务快照保存在 `tx.record.Gameloader`，失败时由既有的 `restore_gameloader` 回滚步骤
原样还原；成功后由 JunimoServer 的 `SetCurrentGameAsSaveToLoad` 写入新档自己的指针。
`ComposeRecreateServices` 本来就强制重建容器，所以不存在"复用已加载旧世界的进程"。

**影响文件**：`saves.go`（新增 `ClearGameloaderPointer`，`DeleteAllSaves` 复用它）、
`lifecycle.go`（`doStart` 新建存档分支的隔离块）、`saves_test.go`（2 个用例）。

## 下一步注意事项

- `IdentitySettleWindow` 目前只由等待函数套默认值，`new_game_lifecycle.go` 的调用点
  未显式传参。若将来需要按实例调参，应在那里显式传值而不是改默认常量。
- 指针自愈只在 `doStart` 生效。若将来新增其它启动入口（例如定时计划直接拉起
  compose），必须复用 `RepairGameloaderPointer`，否则会重新打开"静默新建农场"。
- 上游 JunimoServer 仍会写错误的农场名前缀；本修复是兜底，不是根因修复。
- 同一处：新建存档的隔离只在 `doStart` 生效。任何绕过 `doStart` 直接发
  `settings newgame` 或直接 `POST /newgame` 的新入口都必须先清指针，否则会重新引入
  "新档继承旧档角色"。
- 上游 `CreateNewGameCore` 仍不清 `Game1.otherFarmers`；本修复是靠"启动时不加载任何
  存档"绕开内存残留。真正的上游修复应是在 `loadForNewGame()` 前显式清空它。

### 4. 面板自身更新检查来源可配置（`config.go`、`cmd/panel/main.go`、`web/handler.go`、`deploy/`）

**问题**：`updatecheck.defaultLatestReleaseURL` 硬编码为上游仓库
`api.github.com/repos/anxiyizhi/stardew-server-anxi-panel/releases/latest`，
`internal/config` 没有对应字段，`cmd/panel/main.go` 与 `internal/web/handler.go`
两个 `updatecheck.New` 调用点也都没有传 `LatestReleaseURL`。于是 fork 构建的面板仍然
把**上游**版本当成可用更新："版本详情 / 查看更新页"指向原作者的 Release；而
`internal/updater/images.go` 的受信镜像前缀同样是上游命名空间，点一次"一键升级"就会
用上游镜像覆盖 fork 构建。

**修复**：新增 `Config.ReleaseAPIURL`，来自环境变量 `PANEL_RELEASE_API_URL`，
**留空保持内置上游默认值**（不改变既有部署行为），两个调用点传入
`LatestReleaseURL`；`deploy/run.sh` 把该变量写进 `.env` 并在生成的 compose 中透传
（此前该变量只被安装脚本用来解析待拉取版本，从未进入面板容器），
`deploy/docker-compose.yml` 示例同步补注释。

**影响文件**：`internal/config/config.go`、`cmd/panel/main.go`、
`internal/web/handler.go`、`deploy/run.sh`、`deploy/docker-compose.yml`；
新增 `internal/config/release_api_url_test.go`（2 例）。

**验证**：`go build ./...`、`go vet`、`git bash -n deploy/run.sh` 通过；
`internal/config` 与 `internal/updatecheck` 全量用例通过。

**尚未处理（重要）**：`internal/updater/images.go` 的受信镜像前缀仍是上游命名空间
（`ghcr.io/anxiyizhi/...` 等）。只改 release 来源时，若 fork 未发布 GitHub Release，
更新检查会 404 并显示检查失败——这比"提示可升级到上游"更安全。但在把镜像发布到
fork 自己的仓库或让受信前缀可配置之前，**不要对 fork 构建使用面板内的一键升级**。
