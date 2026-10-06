# 前端接手文档 2026-10-06

## 本日范围

修复 v0.7.2 中两个"后端能力完好、前端没有可达路径"的状态机缺口。所有改动直接落在
本地 `main`，未创建分支。

## 改了什么

### 1. Steam 邀请码在 UI 中无法启用

**现象**：全新实例 `STEAM_INVITE_ENABLED=false` 时，总览页 / 服务器页 / 手机首页的
「Steam 邀请码」卡片整块不渲染，安装页也没有任何授权入口。唯一调用启用接口
`POST /api/instances/:id/steam-auth/login` 的 `useSteamAuthLogin` 只被这张被门禁挡住
的卡片使用，形成自锁。整套前端产物里"启用"二字出现 0 次。

**修复**：

- `steam-invite-state.ts`：`SteamInvitePresentation` 增加 `needsEnable`；
  未启用时返回 `{ text: '未启用', needsEnable: true, tone: 'muted' }`
  而不是空文案。
- `InviteCodeCard.tsx`：删除 `if (!enabled) return null`；未启用时对管理员渲染
  「启用」按钮（复用 `steamAuth.login()`），并给出停服提示。
- 移除三处调用点的 `steamInviteEnabled === true ? … : null` 门禁：
  `pages/OverviewPage.tsx`、`ServerSummaryCard.tsx`、`mobile/MobileHomePage.tsx`。

**保持不变的语义**：`shouldPollSteamInvite` 仍然要求 `steamInviteEnabled`，因此未启用
实例**不会**请求或轮询邀请码，只是卡片可见。

### 2. `error` 状态没有任何生命周期入口

**现象**：实例处于 `error` 时 `showStartControl` 为 false，停止 / 重启也不显示，页面只留
一句"请先完成安装或选择存档"，但没有任何按钮可以到达那两条路径。而实例的真实状态
`new_game_recovery_required` 的官方恢复方式恰恰就是"再次启动以恢复同一事务"。

**修复**：

- `useStardewLifecycleActions.ts`：`canStart` 增加 `state === 'error'` 分支
  （后端 start handler 本身会重新校验安装与存档，并返回具体冲突码）。
- `pages/ServerControlPage.tsx`：`showStartControl` 增加 `state === 'error'`；
  启动按钮 title 与状态提示文案针对 error 给出"可尝试启动恢复"的说明。

## 影响哪些接口 / 文件

| 文件 | 变化 |
| --- | --- |
| `frontend/src/games/stardew/steam-invite-state.ts` | 新增 `needsEnable` 字段与未启用文案 |
| `frontend/src/games/stardew/InviteCodeCard.tsx` | 取消自锁，新增启用按钮与提示 |
| `frontend/src/games/stardew/pages/OverviewPage.tsx` | 移除邀请码卡片门禁 |
| `frontend/src/games/stardew/ServerSummaryCard.tsx` | 移除邀请码卡片门禁 |
| `frontend/src/games/stardew/mobile/MobileHomePage.tsx` | 移除邀请码行门禁，新增启用/未启用按钮 |
| `frontend/src/games/stardew/useStardewLifecycleActions.ts` | `canStart` 允许 error 恢复 |
| `frontend/src/games/stardew/pages/ServerControlPage.tsx` | 显示启动按钮与恢复提示 |
| `frontend/scripts/test-install-state.ts` | 同步 `steamInvitePresentation` 新契约 |

未新增后端接口；未改变任何既有 API 调用签名。

## 如何验证

```bash
cd frontend
npx tsc -b                       # 类型检查
npm run test:install-state       # 邀请码 presentation 新契约
npm run test:lifecycle-action-state
npm run build                    # production build
```

全量前端状态回归（26 个 `test:*` 脚本）应全部通过。

真实页面验收要点：

1. `steamInviteEnabled=false` 的实例：总览 / 服务器 / 手机首页都应看到
   「Steam 邀请码：未启用」+ 管理员「启用」按钮；非管理员看到"请联系管理员"。
2. 服务器运行中时「启用」按钮禁用并提示先停服。
3. `state=error` 的实例：服务器页出现「启动」按钮，提示文案说明可尝试恢复。

## 下一步注意事项

- `needsEnable` 是必填字段，新增任何 `steamInvitePresentation` 返回分支都必须带上它。
- 手机端未启用时给了非管理员一个禁用按钮占位（而不是复制按钮），避免出现
  "可复制但永远为空"的误导交互；后续若要统一三端文案，改这一段即可。
- 卡片可见性不再等价于能力已启用。任何依赖"卡片存在 ⇒ 已启用"的新代码都必须改为
  读取 `presentation.needsEnable` / `steamInviteIsEnabled`。
