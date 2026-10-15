# dsh-sync-autovpn

**GitHub 同步一开跑，就先把 Clash 代理打开；同步跑完、空闲下来，再自动关掉并逐项还原。**

它是给 [@dpskk2/dsh-chatsync](https://www.npmjs.com/package/@dpskk2/dsh-chatsync)（DSH 侧栏「⟳ 同步」／设置→同步→立即同步／自动同步）配的**事前**保险：那些同步在本机是靠 `git push/pull` 连 github.com 的，代理没开（或 Clash 是 direct 模式、节点是死的）时上传会失败——而失败发生在同步**跑起来之后**，事后补救已经晚了，用户只看到「上传失败」。本插件把开代理这一步挪到同步开始**之前**。

代理的开关本身不在这里实现：**唯一持有代理实例的是 [`dsh-clash-autovpn`](../dsh-clash-autovpn)**（开/关/逐项还原/计量/预算刹车）。本插件只负责「什么时候借、什么时候还」。

---

## 它怎么知道「同步要开始了」

三个入口，覆盖能想到的所有触发方式：

| 入口 | 挂在哪 | 覆盖的场景 |
| --- | --- | --- |
| `SyncEngine.prototype._syncOnce` | chatsync 的真实引擎原型（`lib/sync.js`） | 侧栏「⟳ 同步」按钮、设置页「立即同步」、自动同步定时器、启动拉取 —— 它们最终都调这一个方法 |
| `SyncEngine.prototype.applyProxyEnv` | 同上 | 把 chatsync 给 git 子进程的代理**对齐到 Clash 真实混合端口**（`dsh-sync.json` 里端口写错是同步失败的常见原因；只改内存副本，不动你的配置文件） |
| `SyncEngine.prototype.flushSync` | 同上 | 退出冲刷是**同步**函数（`spawnSync`），来不及 await 开代理 —— 只能如实记一笔「这一轮可能没走代理」（本地提交仍在，下次同步会补上） |
| `tools/pre-execute` 的 shell 命令 | 宿主工具钩子 | 命令行里的 `git push/pull/fetch/clone/ls-remote`、`gh …`：在命令**执行前**开代理，并把 `HTTP(S)_PROXY` 注入 DSH 子进程环境（git/gh/curl 靠它走代理） |

挂钩子用的是**运行时原型包装**（`attach`），不是改 chatsync 的代码：chatsync 升级覆盖文件也不会被本插件改坏；代价是它如果改掉这三个方法名，钩子会挂不上——那时日志会明确写「没找到可装载的 chatsync lib/sync.js」或「三个候选方法都不存在」。

---

## 与 dsh-clash-autovpn 的关系（重要）

**单一实例原则**：本插件**绝不**自己 `new VpnManager()`。两份实例各记一份「原始状态」，关闭时会互相覆盖，典型后果是系统代理被留在开着没人管。

取用顺序（`trigger.provider()`）：

1. `ctx.get('clashAutovpn')` —— dsh-clash-autovpn ≥ 0.2.0 用 `ctx.provide()` 注册的服务（正路）；
2. `ctx.clashAutovpn` —— 少数宿主只 mixin 了 accessor；
3. `globalThis.__dshClashAutovpn` —— 该插件一直会挂的兜底全局。

三条都拿不到就**不开代理**（如实报错、不假装成功），同步照常跑，只是没有代理加速。

> 装之前请确认 `dsh-clash-autovpn` 已升级到 **0.2.0 或更高**（0.1.0 没有 `clashAutovpn` 服务，但它挂的 `globalThis` 兜底仍然可用）。

---

## 安装

### 路线 A：从 GitHub 装（跨机推荐）

```powershell
$dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add github:434210jiuqi-coder/dsh-clash-autovpn    # 先装被借用的那个
& $dsh plugin --profile desktop add github:434210jiuqi-coder/dsh-sync-autovpn
```

装完在 `cordis.patch.yml` 里加条目（**必须**是 `- insert:` 形式，见下），再**重启 DSH**。
这条路的好处：受管于 pnpm，`package.json` 与锁文件会随 DSH 同步一起走，第二台电脑只需
`dsh plugin --profile desktop install`。

### 路线 B：从工作区联接（本机开发用，改完即生效）

插件源码放在工作区里时，用目录联接挂进 profile（等价于 pnpm 对 `file:` 依赖做的软链，但不动 lockfile）：

```powershell
# ① 接入 profile 的模块解析
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sync-autovpn" `
  -Target (Join-Path $PWD 'dsh-sync-autovpn')

# ② 编辑 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml，追加（**必须**是 - insert: 形式）
```

```yaml
- insert:
    - id: dsh-sync-autovpn
      name: 'dsh-sync-autovpn'
      config:
        # 可选：Clash 客户端不在运行时自动拉起（填本机实际路径）
        clashLaunch: 'D:\Program Files\Clash Verge\Clash Verge.exe'
```

> ⚠ `- insert:` 不能省。宿主 `dsh-app-boot` 的 `applyEntryPatches` 语义：带 `insert` = 新增条目；**不带 insert** 的 `- id/name` 只是「覆盖已存在的 id」，新 id 在 bundle 层找不到就 warn 并**静默跳过**（dsh-clash-autovpn 首次安装时就踩过这个坑）。

改完 **重启 DSH**（服务端插件不像客户端插件那样热更新源码）。

---

## 配置

覆盖方式：在 profile 的 `cordis.patch.yml` 里给 `insert` 那项加 `config`（见上）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。`false` = 完全不挂钩子，只留状态/手动工具 |
| `vpnService` | `clashAutovpn` | 借用哪个服务名 |
| `syncTarget` | `https://github.com/` | 开代理、测速、验证都针对它（会取根 URL 做测速地址） |
| `region` | `null` | 选节点优先地区；`null` = 用 dsh-clash-autovpn 的地区优先序 |
| `armOnSync` | `true` | 同步开始前自动开代理 |
| `armOnShellGit` | `true` | 命令行 git/gh 前自动开代理（并注入代理环境变量） |
| `releaseIdleMinutes` | `1` | 同步结束后**再空闲多久**才关代理（给同批后续动作留窗口；`0` = 立刻关） |
| `verifyAfterEnable` | `true` | 开完代理实测一次目标站，不通就换节点 |
| `alignSyncProxy` | `true` | 把 chatsync 的 git 代理对齐到 Clash 真实混合端口（只改内存副本） |
| `injectProxyEnv` | `true` | 给 DSH 子进程注入 `HTTP(S)_PROXY`/`ALL_PROXY`。**已设好就不接管**，而且只还原自己写过的键（见下） |
| `heartbeatSeconds` | `30` | 挂着同步期间多久碰一次「活动时间」，防止 dsh-clash-autovpn 的空闲关代理把同步掐了 |
| `shellHoldTtlMs` | `1800000` | 命令行租约的兜底上限：pre-execute 开了租约、post-execute 没回来（工具被取消/宿主异常）时，超时自动释放——否则心跳会一直给代理续命，空闲关代理永远等不到 |
| `syncHoldTtlMs` | `7200000` | 同步租约的兜底上限（正常路径用不到：`_syncOnce` 的 finally 一定归还），防同步引擎自身异常时代理被永久占住 |
| `injectNotices` | `true` | 失败/异常时把提示注入下一轮上下文（正常情况不注入，避免噪声） |
| `maxArmsPerHour` | `30` | 一小时最多自动开几次（防故障空转） |
| `chatsyncPackage` | `@dpskk2/dsh-chatsync` | 包名（找 `lib/sync.js` 用） |
| `chatsyncPaths` | `[]` | 额外搜索路径（一般不用填；自动按 `DSH_PROFILE_DIR`、`~/.dsh/profiles/*`、`.pnpm` 布局找） |
| `clashLaunch` | `''` | Clash 客户端不在运行时的拉起命令（exe 全路径或整串命令）；空 = 不拉起，只在日志里提示 |
| `clashLaunchWaitMs` | `20000` | 拉起后等端口就绪的上限 |

### 代理环境变量为什么这么小心

`dsh-clash-autovpn` 开代理时本来就会写 `process.env.HTTP_PROXY/HTTPS_PROXY/ALL_PROXY`（见它的 `lib/egress.js`），关代理时逐项还原。所以本插件：

- **已经设成同一个代理就不接管**（否则只是在还原时和它抢同一批变量）；
- 真的接管了，**还原只动自己写过的值**：某个键期间被别人改成别的值，就不碰它——宁可留一个不属于我们的值，也不覆盖别人的状态。

这样不会出现「代理已关、`HTTPS_PROXY` 还指着一个没人监听的端口」这种最难受的残留（那会让之后每一次 `git push` 都连不上）。

---

## 工具

| 工具 | 用途 |
| --- | --- |
| `syncvpn_status(includeLog?)` | 现在有没有同步在持有代理、钩子挂上没挂上、共享代理实例从哪条路拿到的、环境变量接管情况、最近日志 |
| `syncvpn_selftest()` | 自检：钩子 / 代理服务 / `dsh-sync.json` 端口 vs Clash 实际混合端口 / 端口有没有在听 / github.com:443 直连通不通 —— 只读，不改任何东西 |
| `syncvpn_on(target?, reason?, region?)` | **手动**先开代理（你要自己 `git push`、或用户说「先开着」）。返回 `holdId` |
| `syncvpn_off(reason?)` | 关代理并逐项还原（释放本插件持有的所有租约；等价于 `vpn_disable`） |

---

## 换第二台电脑：插件怎么跟着走

dsh-chatsync 的同步边界（见 `~/.dsh/.gitignore`）决定了「什么会自动过去、什么要手工补」：

| 东西 | 会不会跟着同步 | 说明 |
| --- | --- | --- |
| `profiles/<p>/cordis.patch.yml` | ✅ | loader 条目与配置都在这里面 |
| `profiles/<p>/package.json` + `pnpm-lock.yaml` | ✅ | 市场插件的依赖清单与锁定版本 |
| `settings.yaml` / 会话 / 附件 / 技能 | ✅ | 主数据 |
| 工作区里的文件（含本地插件源码） | ✅ | 走 `workspace-repos/` 里的影子仓库；**排除** `.git` 与 `node_modules` |
| `**/node_modules/`、`.pnpm-store/` | ❌ | 插件**代码本体**不跟着走 |
| 目录联接（junction） | ❌ | 机器本地的东西 |
| `storages/workspace-local-paths.json` | ❌ | 工作区位置是本机私事 |

所以第二台电脑「第一次同步完成」之后跑一次：

```powershell
# 工作区根目录下（脚本本身会跟着工作区同步过去）
pwsh -File .\setup-dsh-plugins.ps1 -DryRun   # 先看它要做什么
pwsh -File .\setup-dsh-plugins.ps1           # 建联接 + 补 loader 条目 + dsh plugin install
```

它做四件事（幂等，可反复跑；已存在的联接/条目一律不删不改）：

1. 扫工作区里带 `dsh.bundle.patch` 的包 → 认定为「本地插件」；
2. 给每个本地插件在 `profiles/<p>/node_modules/<name>` 重建目录联接；
3. 检查 `cordis.patch.yml` 有没有对应的 `- insert:` 条目，缺了就补（改前自动备份）；
4. 跑 `dsh plugin --profile <p> install` 把市场插件按 `package.json`+锁文件装出来。

跑完**完全退出 DSH 再启动**，然后 `syncvpn_selftest` 确认钩子与代理服务都挂上。

> 机器专属值会被同步过去，落地到另一台机器就是错的：`clashLaunch`（例如别人机器上
> `D:\...\Clash for Windows.exe`）、`mcp-origin` 里的绝对用户目录等。脚本会体检并提醒；
> 本插件对不存在的 `clashLaunch` 只会记一条 warn 后跳过，不会报错。

**更省心的另一条路**：把本地插件推到 GitHub，改成市场安装
（`dsh plugin --profile desktop add github:<你>/dsh-sync-autovpn`，就像这台机器上的
`dsh-notebook-studio`、`dsh-pubmed` 那样）。这样 `package.json` 一同步，第二台电脑只要
`install` 就行，不用维护联接与 patch 条目；代价是改代码要走「提交→推送→update」。

---

## 验证

```powershell
# ① 三个预检（不碰本机 Clash、不联网跑同步）
node dsh-sync-autovpn\test\trigger.test.mjs                     # 触发层单测（假引擎 + 假代理）
$env:DSH_PROFILE_DIR="$env:USERPROFILE\.dsh\profiles\desktop"
node dsh-sync-autovpn\test\wiring.test.mjs                      # 真实 cordis：服务接线（单一实例）
node dsh-sync-autovpn\test\plugin-load.mjs                      # 装载预检 + 真实 SyncEngine 实例上包一次
```

② 重启 DSH 后，让助手（或你自己）跑 `syncvpn_selftest`：`ready: true`、`chatsync.ok: true`、`vpnService.source` 告诉你是从服务还是全局兜底拿到的代理。

③ 点一次侧栏「⟳ 同步」，然后看：

```
%USERPROFILE%\.dsh\sync-autovpn\sync-autovpn.log   # 本插件：什么时候借、什么时候还
%USERPROFILE%\.dsh\clash-autovpn\autovpn.log       # 代理本身：选了哪个节点、模式、系统代理、还原
```

预期：同步开始前一行「已为「sync:web-button」开启代理：节点「…」」，同步结束 + 空闲 1 分钟后一行「已自动关闭代理」。

④ 想在不点同步的情况下验证真机链路：`syncvpn_on(target="https://github.com/")` → 在 DSH 里跑一条 `git ls-remote https://github.com/git/git.git HEAD`（应当 2 秒内出结果，且 `$env:HTTPS_PROXY` 是本机代理）→ `syncvpn_off()`。**用完一定记得关**（`syncvpn_off` 会逐项还原，包括系统代理与 Clash 模式）。

---

## 已知限制

- **退出冲刷（`flushSync`）来不及开代理**：它是同步函数，走 `spawnSync`，无法 await 一次开代理（那要几秒）。所以「直接关掉 DSH 触发的最后一推」在没有代理时可能失败——数据已经在本地提交，下一次同步会补上。要稳，就在关 DSH 前点一次「⟳ 同步」。
- **自动同步模式（每 N 分钟）**：每一轮都会开一次、空闲后再关一次。嫌开关太勤就把 `releaseIdleMinutes` 调大（比如 5），或干脆只用「立即同步」。
- **跟着 chatsync 的方法名走**：`_syncOnce` / `applyProxyEnv` / `flushSync` 是 0.20.0 的实现。它改实现时本插件会挂不上（日志会写清楚），需要跟着更新。
- **不做「判定是不是墙」**：那是 dsh-clash-autovpn 的 `vpn_diagnose`。本插件是「同步要来了就先开」，判断依据是时机，不是诊断结论。
- **Clash 本体不在运行时**：只要配了 `clashLaunch` 才会尝试拉起（等端口就绪再重试一次 enable）；不配就只能在日志里提示「请先启动 Clash」。

---

## 安全边界

- 不改 chatsync 的任何文件，只在运行时包三个原型方法。
- 不改 `dsh-sync.json`、不改 git 全局配置；`alignSyncProxy` 只写 chatsync 内存里的 `_gitEnv`。
- 环境变量遵守「不接管别人的、不覆盖别人的」两条规则（见上）。
- 关代理走 dsh-clash-autovpn 的 `disable()`，由它逐项还原（Clash 模式 / 各节点组选择 / 系统代理 / DSH 出站策略）。
- 同步如果失败（chatsync 返回 `error`），本插件**不重试**、不反复开关代理，只记录并用 `injectNotices` 把原因送到下一轮上下文。
