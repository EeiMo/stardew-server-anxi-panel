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

## 下一步注意事项

- `IdentitySettleWindow` 目前只由等待函数套默认值，`new_game_lifecycle.go` 的调用点
  未显式传参。若将来需要按实例调参，应在那里显式传值而不是改默认常量。
- 指针自愈只在 `doStart` 生效。若将来新增其它启动入口（例如定时计划直接拉起
  compose），必须复用 `RepairGameloaderPointer`，否则会重新打开"静默新建农场"。
- 上游 JunimoServer 仍会写错误的农场名前缀；本修复是兜底，不是根因修复。
