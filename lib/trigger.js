/**
 * dsh-sync-autovpn/trigger —— 「同步一动就开代理、用完自动关」的触发层。
 *
 * 要解决的问题：DSH 的 GitHub 同步（@dpskk2/dsh-chatsync，侧栏「⟳ 同步」/ 设置→同步→立即同步 /
 * 自动同步）在本机是靠 `git push/pull` 直连 github.com 的。Clash 没开（或模式是 direct、节点是死的）
 * 时，上传会失败，而失败发生在**同步已经跑起来之后**——事后补救来不及，用户只看到「上传失败」。
 *
 * 所以这里做的是**事前**触发：在同步真正开始前把代理开起来，同步结束、确认没人再联网之后关掉。
 *
 * 三个入口：
 *   ① chatsync 的 `SyncEngine.prototype`（`_syncOnce` / `applyProxyEnv` / `flushSync`）——覆盖
 *      UI 按钮、自动同步、启动拉取、退出冲刷，全部走同一个引擎实例的方法，所以钩在原型上最稳；
 *   ② 命令行的 `git push/pull/fetch/clone`、`gh ...`（`tools/pre-execute`）——覆盖「让 DSH
 *      帮我在某仓库推一把」的场景；
 *   ③ 三个工具（`syncvpn_status` / `syncvpn_on` / `syncvpn_off`）——手动兜底与排查。
 *
 * **代理开关只借用 dsh-clash-autovpn 的实例**（`ctx.get('clashAutovpn')`，见该插件 README 的
 * 「单一实例原则」）：本模块自己绝不 new 一个 VpnManager，否则两份实例各记一份原始状态，
 * 关闭时会互相覆盖，留下「系统代理开着但没人管」。
 *
 * @module dsh-sync-autovpn/trigger
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHome, log, patchState, readState } from './log.js'
import {
  DEFAULT_EXTRA_IGNORE,
  appendExtraExcludes,
  branchOf,
  churnPaths,
  dedupeByResolvedPath,
  fmtBytes,
  listTracked,
  matchAny,
  mirrorDirOf,
  pendingCount,
  slimPendingCommits,
  untrackPatterns,
} from './workspace.js'

export const DEFAULT_CONFIG = {
  /** 总开关：false = 完全不挂钩子（插件等于只读状态工具）。 */
  enabled: true,
  /** 借用哪个代理服务（dsh-clash-autovpn ≥ 0.2.0 提供）。 */
  vpnService: 'clashAutovpn',
  /** 开代理、测速、验证都针对这个目标（GitHub 同步的实际出口）。 */
  syncTarget: 'https://github.com/',
  /** 选节点时优先地区（null = 用 dsh-clash-autovpn 的地区优先序）。 */
  region: null,
  /** 同步开始前自动开代理。 */
  armOnSync: true,
  /** 命令行 git push/pull/fetch/clone、gh … 之前也自动开代理。 */
  armOnShellGit: true,
  /** 同步结束后再空闲多少分钟才关代理（给同批的后续动作留窗口；0 = 立刻关）。 */
  releaseIdleMinutes: 1,
  /** 开完代理后实测一次目标站，不通就换节点。 */
  verifyAfterEnable: true,
  /** 把 chatsync 的 git 子进程代理对齐到 Clash 真实混合端口（写 dsh-sync.json 之外的内存副本）。 */
  alignSyncProxy: true,
  /** 给 DSH 子进程注入 HTTP(S)_PROXY / ALL_PROXY（git、gh、curl 靠它走代理）。 */
  injectProxyEnv: true,
  /** 挂着同步时多久碰一次「活动时间」，防止 dsh-clash-autovpn 的空闲关代理把同步掐了。 */
  heartbeatSeconds: 30,
  /**
   * 命令行租约的兜底上限（毫秒）。pre-execute 开了租约、post-execute 却没回来
   * （工具被取消、宿主异常）时，不能让租约永久挂着——那会让心跳一直续命，
   * dsh-clash-autovpn 的空闲关代理永远等不到，代理就这么开着烧流量（实测踩过一次）。
   */
  shellHoldTtlMs: 30 * 60 * 1000,
  /** 同步租约的兜底上限（默认 2 小时）：`_syncOnce` 的 finally 一定会归还，这只是引擎自己挂了时的保险。 */
  syncHoldTtlMs: 2 * 60 * 60 * 1000,
  /** 失败/异常时把提示注入下一轮上下文（正常情况不注入，避免噪声）。 */
  injectNotices: true,
  /**
   * 工作区去重：多条登记指向同一个真实目录时，一轮只同步一份。
   * 实测本机两条登记指向同一目录（一条路径还拼错了），于是同一份 2101 个文件被同步两遍。
   */
  dedupeWorkspaces: true,
  /**
   * 额外排除项（gitignore 语法，写进影子仓库的 info/exclude）。
   * 默认只排「本机可再生 / 到处都有副本」的东西：字节码、缓存、本地知识库索引、安装包、
   * 构建产物、临时文件 —— 不碰用户的正文内容。设为 [] 可完全关掉。
   */
  extraWorkspaceIgnore: [...DEFAULT_EXTRA_IGNORE],
  /**
   * push/fetch 的超时（秒）。0 = 沿用 chatsync 自带的 180 秒。
   * 默认 600：大包（几十 MB）在代理下 3 分钟传不完，超时被杀后只重试一次就失败，
   * 于是留下「一堆提交推不上去、每轮重传」的积压（实测踩过）。
   */
  syncOpTimeoutSeconds: 600,
  /**
   * 话题结束自动同步：`topicIdleSeconds` 秒内没有新的会话活动，就当作「这个话题聊完了」，
   * 自动跑一轮同步（走的是 chatsync 自己的入口，所以会经过本插件的「同步前开代理」）。
   * 判据是**活动 + 空闲**，不是某个具体事件：聊得越久越不会被中途触发。
   */
  autoSyncOnTopicEnd: true,
  /** 多久没有新活动算「话题结束」（秒）。默认 3 分钟。 */
  topicIdleSeconds: 180,
  /** 两次话题同步之间的最小间隔（秒），防止连续话题把同步打得太密。 */
  topicSyncMinIntervalSeconds: 600,
  /** 连续失败时的退避上限（秒）：每失败一次间隔翻倍，直到这个上限（默认 2 小时）。 */
  topicSyncMaxBackoffSeconds: 7200,
  /**
   * 话题同步怎么触发：
   *  · 'auto'   —— 优先直接调引擎（要至少成功跑过一轮同步才抓得到实例），否则走 HTTP 接口
   *  · 'engine' —— 只直接调引擎
   *  · 'route'  —— 只走宿主 HTTP 接口（等价于点「立即同步」按钮）
   */
  topicSyncTrigger: 'auto',
  /** 宿主 HTTP 接口地址（默认取环境变量 DSH_WEB_URL，如 http://127.0.0.1:19387）。 */
  topicSyncBaseUrl: '',
  /** 触发同步的接口路径（chatsync 0.20 的「立即同步」就是这个）。 */
  topicSyncRoute: '/dsh-sync/api/run',
  /** 单次话题同步的等待上限（毫秒）。整轮同步有可能跑很久，默认 2 小时。 */
  topicSyncTimeoutMs: 2 * 60 * 60 * 1000,
  /** chatsync 自己开着自动同步（dsh-sync.json 里 mode=auto）时让位，不重复触发。 */
  topicSyncYieldToChatsyncAuto: true,
  /** 一小时最多自动开几次（防故障空转）。 */
  maxArmsPerHour: 30,
  /** chatsync 包名（默认 @dpskk2/dsh-chatsync）。 */
  chatsyncPackage: '@dpskk2/dsh-chatsync',
  /** 额外搜索目录（一般不用填；自动按 DSH_PROFILE_DIR / ~/.dsh/profiles/* 找）。 */
  chatsyncPaths: [],
  /**
   * Clash 客户端没在跑时自动拉起来：填客户端 exe 的完整路径（含参数则整串交给 cmd /c）。
   * 空 = 不自动启动，只在日志里提示「请先启动 Clash」。
   * 例：clashLaunch: 'D:\\Program Files\\Clash Verge\\Clash Verge.exe'
   */
  clashLaunch: '',
  /** 启动客户端后等端口就绪的上限。 */
  clashLaunchWaitMs: 20000,
}

/** 会被我们临时接管的代理环境变量（保存原值、退出时逐项还原）。 */
const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']

/**
 * 钩子版本。宿主在插件文件变动时会**重新跑 apply()**（实测桌面宿主如此），于是进程里会同时存在
 * 多份 trigger 实例，而原型上的包装只可能有一份。三条纪律保证「多实例 = 一份行为」：
 *   ① 包装里永远通过 `currentTrigger()` 问「现在活着的是哪份」，绝不死抱创建时那一份；
 *   ② 包装带版本号，新版本能从 `__dshSyncVpnOriginal` 退回原始方法再重包（不叠罗汉）；
 *   ③ 命令行租约按 callId 记在**模块级**表里：多个实例看到同一次工具调用只会开一次代理。
 */
const HOOK_VERSION = 2
/**
 * 活实例注册表放在 **globalThis**，不放模块作用域。
 *
 * 原因（实测踩过）：宿主热重载会**重新 import 本模块**，于是模块级变量各算各的——
 * 原型上的包装（旧模块装的）会一直往旧模块的注册表里写引擎实例，而新模块的工具看到的是
 * 自己的空注册表：`engineCaptured: false`、租约挂在已卸载的实例上、30 分钟后靠 TTL 兜底。
 * 注册表本来就是"进程级事实"，就放在进程级。
 */
const REGISTRY = (globalThis.__dshSyncVpnRegistry ??= { triggers: new Set(), active: null, armedCalls: new Map() })
/** callId → { hold, owner }：一次工具调用只该有一个租约，不论进程里有几份实例。 */
const ARMED_CALLS = REGISTRY.armedCalls

/**
 * 「这个代理是我们开的吗」——**进程级**的一个事实，不放在实例上。
 *
 * 原因：宿主重跑 apply() 时可能正好卡在 enable() 的 await 中间，此时新实例还没拿到
 * "我开的"这个标记，旧实例又被卸载 → 谁都不认为代理是自己开的 → 空闲后没人关它
 * （实测踩过：会话用量一路涨到 500MB 而没人收尾）。所有权是进程级事实，就记在进程级。
 */
let OWNED_ENABLE = false

/** 当前"活着且最新"的 trigger（插件重载后就是新那份）。 */
function currentTrigger(fallback = null) {
  const active = REGISTRY.active
  if (active && !active.disposed) return active
  for (const candidate of REGISTRY.triggers) {
    if (!candidate.disposed) return candidate
  }
  return fallback
}

/** 进程内所有活着的 trigger（排查多实例问题用）。 */
export function liveTriggers() {
  return [...REGISTRY.triggers].filter((t) => !t.disposed)
}

/** 释放某个 callId 的租约（不论它属于哪一份实例）。 */
function releaseArmedCall(callId) {
  const entry = ARMED_CALLS.get(callId)
  if (!entry) return false
  ARMED_CALLS.delete(callId)
  entry.owner.release(entry.hold)
  return true
}

/**
 * 给某个方法挂（或升级）包装：带版本号，能从 `proto[originalKey]` 退回真身再重包，
 * 插件被宿主重跑 apply 时不会叠罗汉。旧包装没留原件时**不动它**（等重启生效）。
 */
function rewrap(proto, name, version, makeWrapper, originalKey) {
  const cur = proto[name]
  if (typeof cur !== 'function') return false
  if (cur.__dshSyncVpn && cur.__dshSyncVpnVersion === version) return true // 已是最新
  let original = proto[originalKey]
  if (!cur.__dshSyncVpn) {
    original = cur
    proto[originalKey] = cur
  } else if (typeof original !== 'function') {
    log('warn', `${name} 上留着旧版包装但没有原件可退回，跳过升级（重启后生效）`)
    return false
  }
  const wrapped = makeWrapper(original)
  wrapped.__dshSyncVpn = true
  wrapped.__dshSyncVpnVersion = version
  proto[name] = wrapped
  return true
}

/** 会跑 shell 的工具名（与 dsh-clash-autovpn 保持一致）。 */
export const SHELL_TOOL_RE = /^(pwsh|bash|terminal|shell|bash_local|pwsh_local)$/i

/**
 * 命令行里出现这些就当「要连 GitHub/外网」。
 *
 * 刻意**宁滥勿缺**：`git -C D:\repo push`、`git -c http.proxy= push origin main` 这类前缀都要能认出来，
 * 而 `git log --grep push` 这种误判的代价只是白开一次代理（十秒级流量），漏判的代价才是本插件要
 * 修的那个 bug（推送失败）。所以这里用「git 之后 120 字符内出现 push/fetch/... 」的宽松判定。
 */
export const GIT_NET_CMD_RE =
  /(?:\bgit\b[^\n|;&]{0,120}?\b(?:clone|fetch|pull|push|ls-remote)\b)|(?:\bgit\b[^\n|;&]{0,120}?\bremote\s+(?:update|show)\b)|(?:\bgh\b\s+(?:repo|api|auth|pr|release|workflow|gist)\b)/i

/** 目标站 → 根 URL（测速用；深层页面容易 404）。 */
function testUrlFor(target) {
  try {
    const u = new URL(String(target))
    return `${u.protocol}//${u.host}/`
  } catch {
    return DEFAULT_CONFIG.syncTarget
  }
}

/** 读 dsh-sync.json（chatsync 的配置文件），失败给空对象。 */
export function readSyncConfig() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, 'dsh-sync.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 从 http://127.0.0.1:7890 这类字符串里取端口；取不到返回 null。 */
export function portOf(url) {
  const m = /:(\d{2,5})(?:\/|$)/.exec(String(url || ''))
  const port = m ? Number(m[1]) : NaN
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

function isListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!port) return resolve(false)
    const socket = net.connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 通用 TCP 探测（自检用：判断某个 host:port 直连能不能握上手）。 */
export function probeTcp(host, port, timeoutMs = 4000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (ok, error) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        /* 忽略 */
      }
      resolve({ host, port, ok, ms: Date.now() - started, error: error ? String(error?.code || error?.message || error) : null })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, 'ETIMEDOUT'))
    socket.once('error', (error) => finish(false, error))
  })
}

/**
 * 触发层。
 */
export class SyncTrigger {
  /**
   * @param {object} options
   * @param {object} [options.config] 已合并的配置
   * @param {object} [options.ctx] cordis 上下文（用来取代理服务与挂工具）
   * @param {(text: string) => void} [options.onNotice] 需要用户可见的提示
   */
  constructor({ config = {}, ctx = null, onNotice = () => {} } = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(config || {}) }
    this.ctx = ctx
    this.onNotice = onNotice

    /** chatsync 钩子状态。 */
    this.patch = { attempted: false, ok: false, modulePath: null, methods: [], error: null, appliedAt: null }

    /** 当前持有的「代理租约」。 */
    this.holds = new Map()
    this.seq = 0
    this.weEnabled = false
    this.releaseTimer = null
    this.heartbeatTimer = null

    /** 环境变量接管记录。 */
    this.envSaved = null
    this.envUrl = null
    this.envSkipped = false

    this.armTimes = []
    this.alignments = 0
    this.launchCount = 0
    this.lastSync = null
    this.lastEnable = null
    this.lastError = null
    this.lastExitFlush = null
    this._inflight = null
    /** 最近一轮工作区去重的结果（谁被跳过了）。 */
    this.lastDedupe = null

    /** 话题结束自动同步的状态。 */
    this.topic = { dirty: false, lastActivityAt: null, lastSource: null, lastAt: null, nextAt: null, inFlight: false, lastResult: null, skipped: null, failStreak: 0 }
    this.topicTimer = null
    /** 抓到过的 chatsync 引擎实例（跑过一轮同步之后就有），用于直接触发同步。 */
    this.lastEngine = null
    /** 测试注入点；生产用全局 fetch。 */
    this.fetchImpl = null

    /** shell 租约按工具调用 id 记账。 */
    this.shellHolds = new Map()
    this.orphanShellHolds = []

    this.disposed = false
    // 本份实例成为「当前活着的」：后加载的覆盖先加载的，钩子永远指向最新的那份
    REGISTRY.triggers.add(this)
    REGISTRY.active = this
    if (REGISTRY.triggers.size > 1) {
      log('info', `检测到 ${REGISTRY.triggers.size} 份 trigger 实例（宿主重跑 apply），钩子统一走最新那份`)
    }

    this.persisted = readState()
  }

  /* ------------------------------------------------------------ 代理服务 */

  /**
   * 取共享的代理实例。三条路，按可靠性排序：
   *   ① cordis 服务（`ctx.get('clashAutovpn')`）—— 宿主支持 `ctx.provide` 时的正路；
   *   ② 声明式属性（`ctx.clashAutovpn`）—— 少数宿主只 mixin 了 accessor；
   *   ③ `globalThis.__dshClashAutovpn` —— 实测桌面宿主的 ctx 没有 `provide`，这条是**现役主路**；
   * 三条都没有就返回 null（按「开不了代理」处理，绝不自建实例）。
   */
  provider() {
    const name = String(this.config.vpnService || 'clashAutovpn')
    try {
      const svc = this.ctx?.get?.(name)
      if (svc && typeof svc.enable === 'function') {
        this._providerSource = `ctx.get('${name}')`
        return svc
      }
    } catch (error) {
      log('warn', `ctx.get('${name}') 失败：${String(error?.message || error)}`)
    }
    try {
      const prop = this.ctx?.[name]
      if (prop && typeof prop.enable === 'function') {
        this._providerSource = `ctx.${name}`
        return prop
      }
    } catch {
      /* 忽略 */
    }
    const globalRef = globalThis.__dshClashAutovpn
    if (globalRef && typeof globalRef.enable === 'function') {
      this._providerSource = 'globalThis.__dshClashAutovpn'
      return globalRef
    }
    this._providerSource = null
    return null
  }

  providerState() {
    const provider = this.provider()
    if (!provider) {
      return {
        available: false,
        source: null,
        reason: `拿不到代理服务（ctx.get('${this.config.vpnService}') / ctx.${this.config.vpnService} / globalThis.__dshClashAutovpn 都为空）`,
      }
    }
    try {
      return { available: true, source: this._providerSource, ...provider.status() }
    } catch (error) {
      return { available: true, source: this._providerSource, error: String(error?.message || error) }
    }
  }

  safeStatus() {
    try {
      return this.provider()?.status?.() ?? null
    } catch {
      return null
    }
  }

  /* ------------------------------------------------------ chatsync 钩子 */

  /** 可能的 chatsync sync.js 位置（按 profile 目录 + 配置补充）。 */
  candidateSyncModulePaths() {
    const out = []
    const pkg = String(this.config.chatsyncPackage || '@dpskk2/dsh-chatsync')
    const rel = path.join('node_modules', ...pkg.split('/'), 'lib', 'sync.js')

    const profiles = []
    if (process.env.DSH_PROFILE_DIR) profiles.push(process.env.DSH_PROFILE_DIR)
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    try {
      const root = path.join(home, 'profiles')
      for (const entry of fs.readdirSync(root)) profiles.push(path.join(root, entry))
    } catch {
      /* 没有 profiles 目录就算了 */
    }

    for (const dir of profiles) {
      if (!dir) continue
      out.push(path.join(dir, rel))
      // pnpm 布局下包体可能只存在于 .pnpm 里
      try {
        const pnpm = path.join(dir, 'node_modules', '.pnpm')
        for (const entry of fs.readdirSync(pnpm)) {
          if (entry.startsWith(pkg.replace('/', '+') + '@')) out.push(path.join(pnpm, entry, 'node_modules', ...pkg.split('/'), 'lib', 'sync.js'))
        }
      } catch {
        /* 没有 .pnpm 就算了 */
      }
    }
    for (const extra of [].concat(this.config.chatsyncPaths || [])) {
      if (typeof extra === 'string' && extra.trim()) out.push(extra.trim())
    }
    return [...new Set(out)]
  }

  /** 找到 chatsync 的引擎模块并挂钩子（幂等；失败只告警，不影响宿主）。 */
  async patchChatsync() {
    if (this.patch.ok) return this.patch
    this.patch.attempted = true
    const tried = []
    for (const candidate of this.candidateSyncModulePaths()) {
      let real = candidate
      try {
        real = fs.realpathSync(candidate)
      } catch {
        continue
      }
      try {
        const mod = await import(pathToFileURL(real).href)
        const Engine = mod?.SyncEngine
        if (typeof Engine !== 'function') throw new Error('sync.js 没有导出 SyncEngine')
        const methods = this.attach(Engine)
        Object.assign(this.patch, { ok: true, modulePath: real, methods, error: null, appliedAt: Date.now() })
        log('info', `已挂上 chatsync 钩子：${real}（${methods.join(' / ') || '无可挂方法'}）`)
        return this.patch
      } catch (error) {
        tried.push(`${candidate} → ${String(error?.message || error)}`)
      }
    }
    this.patch.error = `没找到可装载的 chatsync lib/sync.js。试过：${tried.join('；') || '(候选路径都不存在)'}`
    log('warn', this.patch.error)
    return this.patch
  }

  /**
   * 把钩子挂到 SyncEngine 原型上。
   *
   * - `_syncOnce`：真正的同步主体（`syncOnce` 只是加进程锁的外壳，`_syncOnce` 被
   *   `syncOnce` 与兼容包装共同调用）→ 开代理 / 关代理就挂这里。
   * - `applyProxyEnv`：chatsync 用 dsh-sync.json 里的 proxy 给 git 子进程造环境变量；
   *   这里把它对齐到 Clash 真实混合端口（端口写错是同步失败的常见原因，且不改用户配置）。
   * - `flushSync`：退出冲刷是**同步**函数（spawnSync），来不及 await 开代理，只能如实记一笔。
   */
  attach(Engine) {
    const proto = Engine?.prototype
    if (!proto) throw new Error('SyncEngine 上没有 prototype')
    const trigger = this
    const applied = []
    const already = []

    // 旧版本包装（或本进程上一次 apply 留下的）先退回原始方法，再按当前版本重包：
    // 宿主会重跑 apply()，如果不这样做，钩子会一直握在最早那份实例手里（实测踩过：
    // 代理开起来了，但那份实例已被卸载 → 租约没人还 → 空闲关代理永远等不到）。
    if (proto._syncOnce?.__dshSyncVpn && proto._syncOnce.__dshSyncVpnVersion !== HOOK_VERSION && proto.__dshSyncVpnOriginal) {
      log('info', `钩子版本升级：${proto._syncOnce.__dshSyncVpnVersion ?? 1} → ${HOOK_VERSION}，退回原始方法后重包`)
      proto._syncOnce = proto.__dshSyncVpnOriginal
    }
    if (proto.applyProxyEnv?.__dshSyncVpn && proto.applyProxyEnv.__dshSyncVpnVersion !== HOOK_VERSION && proto.__dshSyncVpnOriginalApply) {
      proto.applyProxyEnv = proto.__dshSyncVpnOriginalApply
    }
    if (proto.flushSync?.__dshSyncVpn && proto.flushSync.__dshSyncVpnVersion !== HOOK_VERSION && proto.__dshSyncVpnOriginalFlush) {
      proto.flushSync = proto.__dshSyncVpnOriginalFlush
    }

    if (typeof proto._syncOnce === 'function' && !proto._syncOnce.__dshSyncVpn) {
      const orig = proto._syncOnce
      proto.__dshSyncVpnOriginal = orig
      const wrapped = async function (...args) {
        const reason = String(args?.[0] ?? 'sync')
        // 永远用「现在活着的那份」：宿主重跑 apply 后也照样指得到
        const live = currentTrigger(trigger)
        // 顺手记住引擎实例：话题结束自动同步可以直接调它（比走 HTTP 更稳，不怕本地环回被代理绕）
        try {
          live.lastEngine = this
        } catch {
          /* 忽略 */
        }
        const hold = await live.acquire(`sync:${reason}`, { kind: 'sync', target: live.config.syncTarget })
        try {
          return await orig.apply(this, args)
        } finally {
          live.release(hold)
        }
      }
      wrapped.__dshSyncVpn = true
      wrapped.__dshSyncVpnVersion = HOOK_VERSION
      proto._syncOnce = wrapped
      applied.push('_syncOnce')
    } else if (typeof proto._syncOnce === 'function') {
      already.push('_syncOnce')
    }

    if (typeof proto.applyProxyEnv === 'function' && !proto.applyProxyEnv.__dshSyncVpn) {
      const orig = proto.applyProxyEnv
      proto.__dshSyncVpnOriginalApply = orig
      const wrapped = function (...args) {
        const result = orig.apply(this, args)
        try {
          currentTrigger(trigger).alignGitEnv(this)
        } catch (error) {
          log('warn', `对齐 git 代理失败（忽略）：${String(error?.message || error)}`)
        }
        return result
      }
      wrapped.__dshSyncVpn = true
      wrapped.__dshSyncVpnVersion = HOOK_VERSION
      proto.applyProxyEnv = wrapped
      applied.push('applyProxyEnv')
    } else if (typeof proto.applyProxyEnv === 'function') {
      already.push('applyProxyEnv')
    }

    if (typeof proto.flushSync === 'function' && !proto.flushSync.__dshSyncVpn) {
      const orig = proto.flushSync
      proto.__dshSyncVpnOriginalFlush = orig
      const wrapped = function (...args) {
        try {
          const live = currentTrigger(trigger)
          const status = live.safeStatus()
          live.lastExitFlush = { at: Date.now(), vpnActive: Boolean(status?.active) }
          if (!status?.active) {
            log('warn', '退出冲刷(flushSync)运行时代理没开：这一轮上传可能失败（本地提交仍在，下次同步会补上）')
          }
        } catch {
          /* 忽略 */
        }
        return orig.apply(this, args)
      }
      wrapped.__dshSyncVpn = true
      wrapped.__dshSyncVpnVersion = HOOK_VERSION
      proto.flushSync = wrapped
      applied.push('flushSync')
    } else if (typeof proto.flushSync === 'function') {
      already.push('flushSync')
    }

    // 无论本次是否重包主钩子，都把「只读捕获钩子」补齐：让引擎实例在**第一次有人问状态**时就到手，
    // 不必等跑完一轮同步（否则话题同步只能退到 HTTP 那条路，而宿主进程里未必有 DSH_WEB_URL）。
    const captured = this.attachEngineCaptures(proto)
    // 工作区侧的三个补丁：去重 / 排除规则 / 推送超时
    const wsApplied = this.attachWorkspacePatches(proto)

    // 三个方法一个都不存在 = chatsync 换了实现，得让人知道；全部都已被挂过 = 幂等重入，按成功返回
    if (applied.length === 0 && already.length === 0 && captured.length === 0 && wsApplied.applied.length === 0) {
      throw new Error('三个候选方法都不存在（chatsync 版本可能变了）')
    }
    if (applied.length === 0) log('info', `主钩子已存在（${already.join(' / ')}），本次跳过重复包装`)
    const all = [...new Set([...applied, ...captured.map((n) => `capture:${n}`), ...wsApplied.applied])]
    return all.length ? all : already
  }

  /**
   * 工作区侧的补丁（去重 / 排除 / 超时）—— 这三件事直接决定「每轮同步要传多少」。
   */
  attachWorkspacePatches(proto) {
    const trigger = this
    const applied = []

    // ① 去重：`syncAllWorkspaces` 执行期间，`workspaces()` 只返回"每个真实路径的第一条登记"
    if (
      rewrap(
        proto,
        'syncAllWorkspaces',
        HOOK_VERSION,
        (orig) =>
          async function (cfg, reason, opts = {}) {
            const live = currentTrigger(trigger)
            if (live?.config?.dedupeWorkspaces === false) return orig.call(this, cfg, reason, opts)
            let allow = null
            try {
              const all = this.workspaces()
              const resolved = (ws) =>
                typeof this.workspaceRealPathOf === 'function' ? this.workspaceRealPathOf(ws, cfg) : ws?.path
              const result = dedupeByResolvedPath(all, resolved)
              if (result.duplicates.length > 0) {
                allow = new Set(result.unique.map((w) => w.id))
                live.lastDedupe = {
                  at: Date.now(),
                  kept: result.unique.length,
                  duplicates: result.duplicates.map((d) => ({ id: d.id, sameAs: d.sameAs, path: d.path })),
                }
                log(
                  'info',
                  `工作区去重：跳过 ${result.duplicates.length} 条重复登记（${result.duplicates
                    .map((d) => String(d.id).slice(0, 8))
                    .join(', ')} 与更早的登记指向同一目录），本轮只同步 ${result.unique.length} 份`,
                )
              }
            } catch (error) {
              log('warn', `工作区去重准备失败（按原样同步）：${String(error?.message || error)}`)
            }
            const previous = live?._dedupeAllow
            if (live) live._dedupeAllow = allow
            try {
              return await orig.call(this, cfg, reason, opts)
            } finally {
              if (live) live._dedupeAllow = previous ?? null
            }
          },
        '__dshSyncVpnOriginalSyncAll',
      )
    ) {
      applied.push('syncAllWorkspaces')
    }

    if (
      rewrap(
        proto,
        'workspaces',
        HOOK_VERSION,
        (orig) =>
          function (...args) {
            const all = orig.apply(this, args)
            const allow = currentTrigger(trigger)?._dedupeAllow
            if (!allow || !Array.isArray(all)) return all
            return all.filter((ws) => allow.has(ws.id))
          },
        '__dshSyncVpnOriginalWorkspaces',
      )
    ) {
      applied.push('workspaces')
    }

    // ② 排除规则：chatsync 会给每条 workspaceExtraIgnore 补 "/"（把 *.pyc 变成目录名），
    //    所以这里在它写完 exclude 之后，把我们的模式**原样**补进去。
    if (
      rewrap(
        proto,
        'ensureWorkspaceMirror',
        HOOK_VERSION,
        (orig) =>
          async function (id, realPath, cfg) {
            const ok = await orig.call(this, id, realPath, cfg)
            const live = currentTrigger(trigger)
            const patterns = live?.config?.extraWorkspaceIgnore
            if (!ok || !Array.isArray(patterns) || patterns.length === 0) return ok
            try {
              const gitdir =
                typeof this.workspaceGitDir === 'function' ? this.workspaceGitDir(id) : mirrorDirOf(dshHome(), id)
              const result = appendExtraExcludes(gitdir, patterns)
              if (result.added > 0) log('info', `工作区 ${String(id).slice(0, 8)} 已补 ${result.added} 条排除规则`)
            } catch (error) {
              log('warn', `写工作区排除规则失败：${String(error?.message || error)}`)
            }
            return ok
          },
        '__dshSyncVpnOriginalEnsureMirror',
      )
    ) {
      applied.push('ensureWorkspaceMirror')
    }

    // ③ 推送/拉取超时：只放宽、不收紧
    if (
      rewrap(
        proto,
        'runWithRetry',
        HOOK_VERSION,
        (orig) =>
          async function (op, label, args, options = {}) {
            const live = currentTrigger(trigger)
            const seconds = Number(live?.config?.syncOpTimeoutSeconds)
            let next = options
            if (seconds > 0 && (op === 'push' || op === 'fetch')) {
              const want = seconds * 1000
              if (!(Number(options?.timeoutMs) >= want)) next = { ...options, timeoutMs: want }
            }
            return orig.call(this, op, label, args, next)
          },
        '__dshSyncVpnOriginalRunWithRetry',
      )
    ) {
      applied.push('runWithRetry')
    }

    return { applied }
  }

  /**
   * 只用**只读方法**抓引擎实例：`loadConfig` / `workspaces` / `sessionActivity` 会被 /api/status、
   * 侧栏状态卡、会话活动探测反复调用，所以挂上它们之后引擎实例很快就到手。
   * 不改任何行为，只记一句 `lastEngine = this`。
   */
  attachEngineCaptures(proto) {
    const trigger = this
    const captured = []
    for (const name of ['loadConfig', 'workspaces', 'sessionActivity']) {
      const orig = proto[name]
      if (typeof orig !== 'function' || orig.__dshSyncVpnCapture) continue
      const wrapped = function (...args) {
        try {
          currentTrigger(trigger).lastEngine = this
        } catch {
          /* 忽略 */
        }
        return orig.apply(this, args)
      }
      wrapped.__dshSyncVpnCapture = true
      proto[name] = wrapped
      captured.push(name)
    }
    if (captured.length > 0) log('info', `已挂引擎捕获钩子（${captured.join(' / ')}）：话题同步可直接调引擎`)
    return captured
  }

  /**
   * 把 chatsync 给 git 子进程的代理环境对齐到实际混合端口。
   * 只在代理确实开着时改，且只改内存里的 `_gitEnv`（不动 dsh-sync.json）。
   */
  alignGitEnv(engine) {
    if (!this.config.alignSyncProxy) return
    const status = this.safeStatus()
    if (!status?.active || !status?.proxyUrl) return
    const env = engine?._gitEnv
    if (!env || typeof env !== 'object') return
    const want = String(status.proxyUrl)
    const before = env.HTTPS_PROXY || env.https_proxy || '(空)'
    if (before === want && env.HTTP_PROXY === want && env.ALL_PROXY === want) return
    for (const key of PROXY_KEYS) env[key] = want
    this.alignments += 1
    log('info', `已把 chatsync 的 git 代理对齐到 ${want}（原值 ${before}）`)
  }

  /* ------------------------------------------------------ 租约 / 开关 */

  /**
   * 开始一次「需要代理」的动作：确保代理开着并持有租约。
   * @returns {Promise<object>} 租约（含是否已开、验证结果、失败原因）
   */
  async acquire(reason, { kind = 'sync', target = null } = {}) {
    const id = `${kind}#${++this.seq}`
    const hold = { id, kind, reason, target: target || this.config.syncTarget, startedAt: Date.now(), weEnabled: false, owner: this }
    this.holds.set(id, hold)
    this.cancelRelease()
    this.startHeartbeat()

    if (this.config.enabled === false) {
      hold.skipped = '插件已禁用（config.enabled=false）'
      return hold
    }
    if (kind === 'sync' && this.config.armOnSync === false) {
      hold.skipped = '同步前开代理已关闭（config.armOnSync=false）'
      return hold
    }

    try {
      hold.enable = await this.ensureVpn(hold)
      if (hold.enable?.weEnabled) hold.weEnabled = true
      const status = this.safeStatus()
      if (status?.active) this.injectEnv(status.proxyUrl)
    } catch (error) {
      hold.error = String(error?.message || error)
      this.lastError = hold.error
      log('error', `为「${reason}」开代理失败：${hold.error}`)
      this.notice(
        `〔dsh-sync-autovpn〕同步开始前自动开代理失败：${hold.error}。` +
          `这一轮同步仍会跑，但很可能因网络失败——若失败了请先确认 Clash 客户端在运行。`,
      )
    }
    return hold
  }

  /** 结束租约；最后一个租约结束后按空闲窗口安排关代理。 */
  release(hold) {
    if (!hold) return
    // 租约记在「创建它的那份实例」上；别份实例（重载后的新实例）来还账就转交回去
    if (hold.owner && hold.owner !== this) return hold.owner.release(hold)
    if (!this.holds.has(hold.id)) return
    this.holds.delete(hold.id)
    hold.endedAt = Date.now()

    if (hold.kind === 'sync') {
      this.lastSync = {
        reason: hold.reason,
        startedAt: hold.startedAt,
        endedAt: hold.endedAt,
        durationMs: hold.endedAt - hold.startedAt,
        startedByUs: hold.weEnabled,
        error: hold.error || null,
        verify: hold.verify || null,
      }
      this.persisted = patchState({ lastSync: this.lastSync })
      if (hold.error) this.notice(`〔dsh-sync-autovpn〕本轮同步没能用上代理：${hold.error}`)
      // 刚同步过：话题同步的"脏"标记清掉，最小间隔从这一轮算起
      this.topic.dirty = false
      this.topic.lastAt = Date.now()
    }

    // 别份实例还挂着租约（多实例并存时很常见）→ 不能因为"我这份空了"就安排关代理
    if (this.holds.size === 0) {
      const others = liveTriggers().filter((other) => other !== this && other.holds.size > 0)
      if (others.length > 0) {
        log('info', `本份租约已还清，但还有 ${others.length} 份实例挂着租约，关代理交给它们`)
        return
      }
      // ⚠ 关键：租约都还清了就**必须停掉心跳**。心跳的职责是"租约在身时别被空闲逻辑关掉"，
      // 如果它继续跑，就会自己刷新 dsh-clash-autovpn 的 lastActivityAt，于是 tryRelease 里的
      // 空闲检查永远不通过 —— 代理再也关不掉（实测踩过：整轮同步结束后 1 分钟并没有关）。
      this.stopHeartbeat()
      this.scheduleRelease()
    }
  }

  scheduleRelease(delayMs = null) {
    this.cancelRelease()
    const idleMs = Math.max(0, Number(this.config.releaseIdleMinutes) || 0) * 60000
    const wait = delayMs == null ? idleMs : Math.max(1000, delayMs)
    const timer = setTimeout(() => {
      this.releaseTimer = null
      this.tryRelease().catch((error) => log('warn', `关代理收尾失败：${String(error?.message || error)}`))
    }, wait)
    if (typeof timer.unref === 'function') timer.unref()
    this.releaseTimer = timer
  }

  cancelRelease() {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
  }

  /** 租约都还清了 → 空闲够了就关代理（别人还在联网就不关，交给对方/空闲逻辑）。 */
  async tryRelease() {
    if (this.holds.size > 0) return { skipped: 'still-held' }
    const provider = this.provider()
    if (!provider) {
      this.restoreEnv()
      return { skipped: 'no-provider' }
    }
    const status = this.safeStatus()
    const idleMs = Math.max(0, Number(this.config.releaseIdleMinutes) || 0) * 60000
    const lastActivity = Number(status?.lastActivityAt) || 0
    if (status?.active && idleMs > 0 && Date.now() - lastActivity < idleMs) {
      // 别人（另一个工具调用）刚联网 → 再等一会儿
      this.scheduleRelease(idleMs - (Date.now() - lastActivity) + 1000)
      return { skipped: 'busy', retryInMs: idleMs - (Date.now() - lastActivity) + 1000 }
    }

    this.stopHeartbeat()
    this.restoreEnv()
    this.persisted = patchState({ lastSync: this.lastSync })
    if (!status?.active) {
      // 代理已经不在开了 → 所有权这件事跟着归零，免得下次误以为"是我们开的"
      OWNED_ENABLE = false
      this.weEnabled = false
      return { already: true }
    }
    if (!OWNED_ENABLE && !this.weEnabled) {
      // 代理不是我们开的 → 不越权关（由 dsh-clash-autovpn 自己的空闲逻辑关）
      return { skipped: 'not-ours' }
    }
    try {
      const result = await provider.disable({ reason: 'sync-autovpn:idle' })
      const usage = result?.usage || result?.status?.usage || null
      log('info', `同步结束且空闲 ${this.config.releaseIdleMinutes} 分钟，已自动关闭代理${usage ? `（本轮 ${usage.activationText || '?'}）` : ''}`)
      this.weEnabled = false
      OWNED_ENABLE = false
      return { disabled: true, usage }
    } catch (error) {
      log('warn', `自动关代理失败：${String(error?.message || error)}`)
      return { error: String(error?.message || error) }
    }
  }

  /** 同步可能跑几分钟；期间不断续「活动时间」，免得被空闲逻辑中途关掉。 */
  startHeartbeat() {
    if (this.heartbeatTimer) return
    const seconds = Math.max(10, Number(this.config.heartbeatSeconds) || 30)
    const timer = setInterval(() => {
      try {
        this.provider()?.noteActivity?.()
        this.sweepStaleHolds()
      } catch {
        /* 忽略 */
      }
    }, seconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    this.heartbeatTimer = timer
  }

  /**
   * 兜底释放「没人来还」的租约：
   *  · 命令行租约：post-execute 丢失（工具被取消、宿主异常）时按 TTL 释放；
   *  · 同步租约：`_syncOnce` 的 finally 一定会归还，但如果同步引擎自己挂了（进程内异常路径），
   *    这里给一个很宽的上限（默认 2 小时）兜底，避免代理被永久占住。
   */
  sweepStaleHolds(now = Date.now()) {
    const shellTtl = Math.max(60_000, Number(this.config.shellHoldTtlMs) || 30 * 60 * 1000)
    const syncTtl = Math.max(shellTtl, Number(this.config.syncHoldTtlMs) || 2 * 60 * 60 * 1000)
    for (const hold of [...this.holds.values()]) {
      const ttl = hold.kind === 'sync' ? syncTtl : shellTtl
      if (now - hold.startedAt < ttl) continue
      log('warn', `租约「${hold.reason}」挂了 ${Math.round((now - hold.startedAt) / 60000)} 分钟没人归还，按超时释放（兜底，正常路径不该走到这里）`)
      if (hold.callId) {
        this.shellHolds.delete(hold.callId)
        ARMED_CALLS.delete(hold.callId)
      }
      this.release(hold)
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /* ------------------------------------------------------ 开代理本体 */

  rateOk(now = Date.now()) {
    const limit = Math.max(1, Number(this.config.maxArmsPerHour) || 30)
    this.armTimes = this.armTimes.filter((t) => now - t < 3600_000)
    return this.armTimes.length < limit
  }

  async ensureVpn(hold) {
    if (this._inflight) return this._inflight
    this._inflight = (async () => {
      const provider = this.provider()
      if (!provider) {
        throw new Error(
          `拿不到代理服务。请确认 dsh-clash-autovpn 已升级到 ≥ 0.2.0 并装载` +
            `（它会 ctx.provide('${this.config.vpnService}') 并兜底挂 globalThis.__dshClashAutovpn），或检查本插件配置 vpnService`,
        )
      }

      const before = provider.status()
      if (before?.active) {
        provider.noteActivity?.()
        return { already: true, node: before.node?.name ?? null, region: before.region ?? null, proxyUrl: before.proxyUrl ?? null, weEnabled: false }
      }
      OWNED_ENABLE = false // 代理是关着的：此刻没有任何"我们开的"所有权
      if (before?.tripped) {
        throw new Error(
          `代理被 dsh-clash-autovpn 的流量预算暂停了（${before?.usage?.sessionText ?? '?'} / ${before?.usage?.budgetText ?? '?'}）。` +
            `需要用户明确同意后才能继续（vpn_budget action=continue）。`,
        )
      }
      if (!this.rateOk()) throw new Error(`自动开代理过于频繁（近一小时已达上限 ${this.config.maxArmsPerHour} 次），本轮跳过`)

      const target = testUrlFor(hold.target || this.config.syncTarget)
      let enabled = null
      try {
        enabled = await provider.enable({ reason: `sync-autovpn:${hold.reason}`, target, region: this.config.region || null })
      } catch (error) {
        // 常见失败：Clash 客户端根本没在跑 → 按配置尝试拉起来再试一次
        const launched = await this.launchClashIfConfigured()
        if (!launched) throw error
        enabled = await provider.enable({ reason: `sync-autovpn:${hold.reason}:after-launch`, target, region: this.config.region || null })
      }
      if (!enabled || enabled.ok === false) throw new Error(enabled?.message || 'enable() 没有成功')

      this.weEnabled = true
      OWNED_ENABLE = true
      this.armTimes.push(Date.now())

      if (this.config.verifyAfterEnable) {
        try {
          hold.verify = await provider.verifyAndMaybeSwitch(target, { reason: 'sync-pre-flight' })
        } catch (error) {
          hold.verify = { error: String(error?.message || error) }
        }
        if (hold.verify && hold.verify.ok === false && hold.verify.error) {
          this.notice(`〔dsh-sync-autovpn〕代理已开，但实测 ${target} 仍不通：${hold.verify.error}`)
        }
      }

      const status = provider.status()
      this.lastEnable = {
        at: Date.now(),
        reason: hold.reason,
        node: status?.node?.name ?? null,
        region: status?.region ?? null,
        proxyUrl: status?.proxyUrl ?? null,
      }
      this.persisted = patchState({ lastEnable: this.lastEnable })
      log(
        'info',
        `已为「${hold.reason}」开启代理：节点「${status?.node?.name ?? '?'}」（${status?.region ?? '?'}），代理 ${status?.proxyUrl ?? '?'}`,
      )
      return {
        already: false,
        node: status?.node?.name ?? null,
        region: status?.region ?? null,
        delayMs: status?.delayMs ?? null,
        proxyUrl: status?.proxyUrl ?? null,
        weEnabled: true,
      }
    })()
    try {
      return await this._inflight
    } finally {
      this._inflight = null
    }
  }

  /** 配置了 clashLaunch 且端口确实没在听 → 拉起客户端并等端口就绪。 */
  async launchClashIfConfigured() {
    const command = String(this.config.clashLaunch || '').trim()
    if (!command) return false

    const syncCfg = readSyncConfig()
    const port = portOf(syncCfg.proxy) || 7890
    if (await isListening(port)) {
      log('info', `Clash 端口 ${port} 已在监听，无需拉起客户端`)
      return true
    }

    try {
      // 纯 exe 路径（哪怕带空格）直接 spawn 最稳；带参数/管道的整串交给 cmd /c start。
      const looksLikePlainPath = /\.exe"?$/i.test(command) && !/["'|&]/.test(command)
      if (looksLikePlainPath && !fs.existsSync(command.replace(/^"|"$/g, ''))) {
        log('warn', `配置的 Clash 客户端路径不存在：${command}`)
        return false
      }
      const child = looksLikePlainPath
        ? spawn(command.replace(/^"|"$/g, ''), [], { detached: true, stdio: 'ignore' })
        : spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', command], { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref?.()
      this.launchCount += 1
      log('info', `已尝试启动 Clash 客户端：${command}`)
    } catch (error) {
      log('warn', `启动 Clash 客户端失败：${String(error?.message || error)}`)
      return false
    }

    const deadline = Date.now() + Math.max(3000, Number(this.config.clashLaunchWaitMs) || 20000)
    const startedAt = Date.now()
    while (Date.now() < deadline) {
      if (await isListening(port)) {
        log('info', `Clash 端口 ${port} 已就绪（等了 ${Math.round((Date.now() - startedAt) / 1000)}s）`)
        await sleep(1200) // 核心刚起来，控制口/节点还差一口气
        return true
      }
      await sleep(700)
    }
    log('warn', `等了 ${this.config.clashLaunchWaitMs}ms，Clash 端口 ${port} 仍未监听`)
    return false
  }

  /* ------------------------------------------------------ 子进程代理环境 */

  /**
   * 给 DSH 的子进程注入代理环境变量（git / gh / curl / npm 靠它走代理）。
   *
   * 两条克制规则（都是踩过坑之后加的）：
   *  ① **别人已经设好就不接管**：dsh-clash-autovpn 开代理时本来就会写
   *     `process.env.HTTPS_PROXY` 等（见它的 lib/egress.js），实测那一刻 HTTPS_PROXY
   *     已经是本机代理地址。这时我们再"接管"一次毫无收益，只会在还原时和它抢同一批变量。
   *  ② **还原只动自己写过的值**：某个键的当前值已经不等于我们写的值，说明期间有别人改过它，
   *     这时**不碰**——宁可留一个不属于我们的值，也不要覆盖别人的状态。
   */
  injectEnv(proxyUrl) {
    if (this.config.injectProxyEnv === false) return
    const url = String(proxyUrl || '').trim()
    if (!/^https?:\/\//i.test(url)) return

    if (!this.envSaved) {
      const current = process.env.HTTPS_PROXY || process.env.https_proxy || null
      if (current === url) {
        this.envSkipped = true
        log('info', `子进程代理环境变量已经是 ${url}（dsh-clash-autovpn 开代理时设的），本插件不重复接管`)
        return
      }
      const saved = {}
      for (const key of PROXY_KEYS) {
        saved[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null
      }
      this.envSaved = saved
      this.envUrl = url
      log('info', `已记录子进程代理环境变量原值（原 HTTPS_PROXY=${saved.HTTPS_PROXY === null ? '(未设)' : saved.HTTPS_PROXY}）`)
    }
    for (const key of PROXY_KEYS) process.env[key] = url
  }

  /** 逐项还原子进程代理环境变量（只还原仍是我们写的那些键）。 */
  restoreEnv() {
    this.envSkipped = false
    if (!this.envSaved) return
    const saved = this.envSaved
    const url = this.envUrl
    this.envSaved = null
    this.envUrl = null
    const touched = []
    for (const key of PROXY_KEYS) {
      const current = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : null
      if (current !== url) continue // 期间被别人改过 → 不碰
      const value = saved[key]
      try {
        if (value === null || value === undefined) delete process.env[key]
        else process.env[key] = value
        touched.push(key)
      } catch {
        /* 忽略 */
      }
    }
    if (touched.length) log('info', `已还原子进程代理环境变量：${touched.join(', ')}`)
  }

  /* ------------------------------------------------------ 话题结束自动同步 */

  /** 这个功能开不开（总开关 / 本功能开关 / 是否已卸载）。 */
  topicSyncEnabled() {
    return this.config.enabled !== false && this.config.autoSyncOnTopicEnd !== false && !this.disposed
  }

  /**
   * 记一次「会话还有动静」。会话事件可能来得很密（流式输出），所以这里做了节流：
   * 只有把截止时间往后推 >5 秒才真的重排定时器，否则只更新"最后一次活动"。
   */
  noteTopicActivity(source = 'session') {
    if (!this.topicSyncEnabled()) return
    const now = Date.now()
    this.topic.lastActivityAt = now
    this.topic.lastSource = source
    this.topic.dirty = true
    const idleMs = Math.max(1, Number(this.config.topicIdleSeconds) || 180) * 1000
    if (this.topicTimer && this.topic.nextAt && now + idleMs - this.topic.nextAt < 5000) {
      this.topic.nextAt = now + idleMs // 节流：不重排，只把"应触发时刻"往后推
      return
    }
    this.scheduleTopicSync()
  }

  scheduleTopicSync(delayMs = null) {
    if (!this.topicSyncEnabled()) return
    this.cancelTopicSync()
    const idleMs = Math.max(1, Number(this.config.topicIdleSeconds) || 180) * 1000
    const wait = delayMs == null ? idleMs : Math.max(1000, delayMs)
    const timer = setTimeout(() => {
      this.topicTimer = null
      this.runTopicSync('topic-end').catch((error) => log('warn', `话题结束同步失败：${String(error?.message || error)}`))
    }, wait)
    if (typeof timer.unref === 'function') timer.unref()
    this.topicTimer = timer
    this.topic.nextAt = Date.now() + wait
  }

  cancelTopicSync() {
    if (this.topicTimer) {
      clearTimeout(this.topicTimer)
      this.topicTimer = null
    }
  }

  /** 到点跑一轮：一串守卫都过了才真的触发，触发前先按老规矩把代理开起来。 */
  async runTopicSync(reason = 'topic-end', { force = false } = {}) {
    this.topic.skipped = null
    if (!this.topicSyncEnabled()) return { skipped: 'disabled' }
    if (this.topic.inFlight) return { skipped: 'in-flight' }
    if (!this.topic.dirty) return { skipped: 'no-activity' }

    const now = Date.now()
    // 失败退避：连续失败时间隔翻倍（600s → 1200s → … 直到 topicSyncMaxBackoffSeconds），
    // 免得同步一直失败还每 10 分钟重试一次，把机器和流量都拖住。
    const baseGap = Math.max(0, Number(this.config.topicSyncMinIntervalSeconds) || 600) * 1000
    const maxBackoff = Math.max(baseGap, (Number(this.config.topicSyncMaxBackoffSeconds) || 7200) * 1000)
    const failStreak = Math.max(0, Number(this.topic.failStreak) || 0)
    const gap = Math.min(maxBackoff, baseGap * Math.pow(2, failStreak))
    if (!force && this.topic.lastAt && now - this.topic.lastAt < gap) {
      this.topic.skipped = 'too-soon'
      this.scheduleTopicSync(gap - (now - this.topic.lastAt) + 1000)
      return { skipped: 'too-soon', retryInMs: gap - (now - this.topic.lastAt) + 1000, failStreak }
    }
    if (force && this.topic.lastAt && now - this.topic.lastAt < gap) {
      log('info', `手动触发话题同步：跳过最小间隔/退避（本来还要等 ${Math.round((gap - (now - this.topic.lastAt)) / 1000)}s）`)
    }

    // 有同步正在跑（不论哪一份实例握着租约）→ 让它跑完再说
    const syncBusy = liveTriggers().some((t) => [...t.holds.values()].some((h) => h.kind === 'sync')) || this.topic.inFlight
    if (syncBusy) {
      this.topic.skipped = 'sync-running'
      this.scheduleTopicSync()
      return { skipped: 'sync-running' }
    }

    // chatsync 自己开着周期自动同步 → 让位，别双份推
    if (this.config.topicSyncYieldToChatsyncAuto !== false) {
      const syncCfg = readSyncConfig()
      if (String(syncCfg.mode || 'manual') === 'auto' && syncCfg.enabled !== false) {
        this.topic.dirty = false
        this.topic.skipped = 'chatsync-auto'
        log('info', '话题结束：chatsync 自己开着自动同步（mode=auto），本插件让位不重复触发')
        return { skipped: 'chatsync-auto' }
      }
    }

    this.topic.inFlight = true
    this.topic.dirty = false
    this.topic.lastAt = now
    const hold = await this.acquire(`topic-end:${reason}`, { kind: 'topic', target: this.config.syncTarget })
    try {
      const outcome = await this.triggerChatsyncSync()
      const result = outcome?.result ?? null
      const hasErrors = Boolean(result && (result.error || result.workspaces?.errors?.length))
      const summary = result?.summary || (result?.error ? `错误: ${result.error}` : null)
      this.topic.lastResult = {
        at: Date.now(),
        via: outcome?.via || null,
        ok: !hasErrors && Boolean(result),
        summary: summary || null,
        error: result?.error || null,
        workspaceErrors: result?.workspaces?.errors?.length || 0,
        armError: hold?.error || null,
      }
      this.topic.failStreak = hasErrors || hold?.error ? failStreak + 1 : 0
      // 有错就保留「还有东西没同步出去」的标记，配合退避等下一轮再试；成功了才清
      if (hasErrors || hold?.error) this.topic.dirty = true
      this.persisted = patchState({ lastTopicSync: this.topic.lastResult })
      log(
        'info',
        `话题结束自动同步完成（经 ${outcome?.via || '?'}）：${summary || (hasErrors ? '有错误' : 'ok')}` +
          `${hold?.error ? `；注意这轮没能先开代理：${hold.error}` : ''}`,
      )
      if (hasErrors || hold?.error) {
        this.notice(
          `〔dsh-sync-autovpn〕话题结束自动同步有异常：${hold?.error ? `先开代理失败(${hold.error})；` : ''}` +
            `${result?.error ? `同步错误=${result.error}；` : ''}` +
            `${result?.workspaces?.errors?.length ? `工作区失败 ${result.workspaces.errors.length} 个` : ''}`.replace(/；$/, ''),
        )
      }
      return { ok: !hasErrors, via: outcome?.via, result }
    } catch (error) {
      const message = String(error?.message || error)
      this.topic.failStreak = failStreak + 1
      this.topic.dirty = true // 没同步成 → 保留标记，等下一轮（退避后）再试
      this.topic.lastResult = { at: Date.now(), ok: false, error: message, armError: hold?.error || null }
      this.persisted = patchState({ lastTopicSync: this.topic.lastResult })
      log('warn', `话题结束自动同步没能跑起来：${message}`)
      this.notice(`〔dsh-sync-autovpn〕话题结束想自动同步，但没能跑起来：${message}。需要的话手动点一次「⟳ 同步」。`)
      return { ok: false, error: message }
    } finally {
      this.topic.inFlight = false
      this.release(hold)
    }
  }

  /**
   * 宿主 web 服务的基地址，按可靠性排：
   *  ① 配置 `topicSyncBaseUrl`
   *  ② 环境变量 `DSH_WEB_URL`（⚠ 实测桌面宿主**进程内没有**这个变量：它只被注入 shell 子进程）
   *  ③ `ctx.get('webServer')` 服务（字段名随实现可能是 port / server.address().port / url）
   */
  webBaseUrl() {
    const configured = String(this.config.topicSyncBaseUrl || '').trim()
    if (configured) return configured
    const fromEnv = String(process.env.DSH_WEB_URL || '').trim()
    if (fromEnv) return fromEnv
    try {
      const ws = this.ctx?.get?.('webServer')
      if (ws) {
        const port = Number(
          ws.port ??
            (typeof ws.server?.address === 'function' ? ws.server.address()?.port : 0) ??
            (typeof ws.address === 'function' ? ws.address()?.port : 0),
        )
        if (Number.isInteger(port) && port > 0) return `http://${ws.host || '127.0.0.1'}:${port}`
        if (typeof ws.url === 'string' && /^https?:\/\//i.test(ws.url)) return ws.url
      }
    } catch (error) {
      log('warn', `读 webServer 服务失败：${String(error?.message || error)}`)
    }
    return ''
  }

  /** 真正去踢一脚 chatsync：优先直接调引擎，其次走宿主 HTTP 接口。 */
  async triggerChatsyncSync() {
    const mode = String(this.config.topicSyncTrigger || 'auto')
    if (mode === 'engine' || mode === 'auto') {
      const engine = this.lastEngine
      if (engine && typeof engine.syncOnce === 'function') {
        const result = await engine.syncOnce('topic-end', { forceCommit: true })
        return { via: 'engine', result }
      }
      if (mode === 'engine') throw new Error('还没抓到 chatsync 引擎实例，改用 topicSyncTrigger=route 或等一轮同步')
    }

    const base = this.webBaseUrl()
    if (!base) {
      throw new Error(
        '不知道宿主 web 地址：DSH_WEB_URL 在宿主进程里是空的、webServer 服务也没给出端口；' +
          '请把 topicSyncBaseUrl 配成宿主的监听地址（如 http://127.0.0.1:19387）',
      )
    }
    const url = new URL(String(this.config.topicSyncRoute || '/dsh-sync/api/run'), base).href
    const fetchImpl = this.fetchImpl || globalThis.fetch
    if (typeof fetchImpl !== 'function') throw new Error('当前 Node 没有全局 fetch，无法走 HTTP 触发（可用 topicSyncTrigger=engine）')

    const controller = new AbortController()
    const timeoutMs = Math.max(30000, Number(this.config.topicSyncTimeoutMs) || 2 * 60 * 60 * 1000)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      })
      const text = await res.text().catch(() => '')
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        /* 非 JSON 就留原文片段 */
      }
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}${text ? `：${String(text).slice(0, 160)}` : ''}` +
            `（若状态是 502，多半是本地环回被送进了代理——本插件会保证回环直连，见 README「已知限制」）`,
        )
      }
      return { via: 'route', result: json }
    } finally {
      clearTimeout(timer)
    }
  }

  /* ------------------------------------------------------ 命令行 git 钩子 */

  shellGitReason(exec) {
    const name = String(exec?.name || '')
    if (!SHELL_TOOL_RE.test(name)) return null
    let text = ''
    try {
      text = typeof exec?.arguments === 'string' ? exec.arguments : JSON.stringify(exec?.arguments ?? {})
    } catch {
      text = ''
    }
    return GIT_NET_CMD_RE.test(text) ? text.slice(0, 160) : null
  }

  /** shell 里跑 git push/pull… → 开始租约（按调用 id 记账，post-execute 归还）。 */
  async armForShell(exec) {
    if (this.config.enabled === false || this.config.armOnShellGit === false) return null
    const snippet = this.shellGitReason(exec)
    if (!snippet) return null
    const callId = exec?.callId || exec?.id || null
    // 多份实例都会收到同一次 pre-execute：按 callId 去重，只开一次代理、只记一个租约
    if (callId && ARMED_CALLS.has(callId)) {
      log('info', `这次工具调用已有租约（callId=${callId}，多半是另一份实例挂的），跳过重复开代理`)
      return null
    }
    const hold = await this.acquire(`shell-git:${exec?.name || 'shell'}`, { kind: 'shell', target: this.config.syncTarget })
    hold.callId = callId
    if (callId) {
      this.shellHolds.set(callId, hold)
      ARMED_CALLS.set(callId, { hold, owner: this })
    } else {
      this.orphanShellHolds.push(hold)
    }
    log('info', `检测到命令行联网动作，已在执行前开代理：${snippet}`)
    return hold
  }

  /** 归还 shell 租约（不论租约挂在哪一份实例上）。 */
  releaseForShell(exec) {
    const callId = exec?.callId || exec?.id || null
    if (callId) {
      if (releaseArmedCall(callId)) return true
      return false
    }
    const orphan = this.orphanShellHolds.shift()
    if (orphan) {
      this.release(orphan)
      return true
    }
    return false
  }

  /* ------------------------------------------------------ 工作区体检 / 瘦身 */

  /** 体检与瘦身动作共用：拿到引擎、配置和登记表。 */
  workspaceContext() {
    const engine = this.lastEngine
    if (!engine || typeof engine.workspaces !== 'function') {
      return { ok: false, error: '还没抓到 chatsync 引擎实例：先跑一轮同步，或调一次 syncvpn_status 触发状态查询' }
    }
    let cfg = {}
    try {
      cfg = typeof engine.loadConfig === 'function' ? engine.loadConfig() : {}
    } catch {
      cfg = {}
    }
    let all = []
    try {
      all = engine.workspaces()
    } catch (error) {
      return { ok: false, error: `读取工作区登记失败：${String(error?.message || error)}` }
    }
    const resolved = (ws) =>
      typeof engine.workspaceRealPathOf === 'function' ? engine.workspaceRealPathOf(ws, cfg) : ws?.path
    return { ok: true, engine, cfg, all: Array.isArray(all) ? all : [], resolved }
  }

  /**
   * 工作区同步体检：谁在重复、谁在撑体积、还有多少没推上去。
   * 只读，不改任何东西。
   */
  auditWorkspaces({ topN = 8, commits = 10 } = {}) {
    const ctx = this.workspaceContext()
    if (!ctx.ok) return ctx
    const patterns = Array.isArray(this.config.extraWorkspaceIgnore) ? this.config.extraWorkspaceIgnore : []
    const { unique, duplicates } = dedupeByResolvedPath(ctx.all, ctx.resolved)
    const duplicateOf = new Map(duplicates.map((d) => [d.id, d.sameAs]))
    const dshHomePath = dshHome()
    const reports = []
    let uniqueTrackedFiles = 0
    let uniqueTrackedBytes = 0
    for (const ws of ctx.all) {
      const real = ctx.resolved(ws)
      const gitdir = mirrorDirOf(dshHomePath, ws.id)
      const isDuplicate = duplicateOf.has(ws.id)
      const base = {
        id: ws.id,
        title: ws.title ?? null,
        path: real || null,
        duplicateOf: duplicateOf.get(ws.id) ?? null,
        branch: branchOf(ctx.cfg, ws.id),
        mirrorDir: gitdir,
      }
      if (!real || !fs.existsSync(gitdir)) {
        reports.push({ ...base, error: real ? 'mirror-missing' : 'no-path' })
        continue
      }
      const tracked = listTracked(gitdir, real, base.branch)
      const files = tracked.ok ? tracked.files : []
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
      const ignored = files
        .map((f) => ({ f, pattern: matchAny(f.path, patterns) }))
        .filter((x) => x.pattern)
      const ignoredBytes = ignored.reduce((sum, x) => sum + x.f.size, 0)
      if (!isDuplicate) {
        uniqueTrackedFiles += files.length
        uniqueTrackedBytes += totalBytes
      }
      reports.push({
        ...base,
        trackedFiles: files.length,
        trackedBytes: totalBytes,
        trackedText: fmtBytes(totalBytes),
        pendingCommits: pendingCount(gitdir, real, base.branch),
        ignoredTrackedFiles: ignored.length,
        ignoredTrackedBytes: ignoredBytes,
        ignoredTrackedText: fmtBytes(ignoredBytes),
        ignoredSamples: ignored.slice(0, 6).map((x) => ({ path: x.f.path, pattern: x.pattern, text: fmtBytes(x.f.size) })),
        biggest: [...files]
          .sort((a, b) => b.size - a.size)
          .slice(0, Math.max(1, topN))
          .map((f) => ({ path: f.path, bytes: f.size, text: fmtBytes(f.size) })),
        churn: churnPaths(gitdir, real, base.branch, commits).counts.slice(0, Math.max(1, topN)),
        error: tracked.ok ? null : tracked.error,
      })
    }

    const uniqueReports = reports.filter((r) => !r.duplicateOf && !r.error)
    const pendingTotal = uniqueReports.reduce((sum, r) => sum + (Number(r.pendingCommits) || 0), 0)
    const ignoredTotalBytes = uniqueReports.reduce((sum, r) => sum + (Number(r.ignoredTrackedBytes) || 0), 0)
    const hints = []
    if (duplicates.length > 0) {
      hints.push(
        `有 ${duplicates.length} 条重复登记指向同一目录（${duplicates
          .map((d) => `${String(d.id).slice(0, 8)} → 同 ${String(d.sameAs).slice(0, 8)}`)
          .join('；')}）。本插件每轮只同步其中一份；` +
          `彻底解决请在「设置 → 同步 → 工作区」里删掉多余那条登记。`,
      )
    }
    if (ignoredTotalBytes > 0) {
      hints.push(
        `去重后仍有 ${fmtBytes(ignoredTotalBytes)} 命中排除规则的文件在被跟踪。执行 syncvpn_audit action=prune ` +
          `可以把它们从索引里摘掉（本机文件保留），下一次同步只推「删除记录」，之后不再上传它们。`,
      )
    }
    if (pendingTotal > 0) {
      hints.push(
        `还有 ${pendingTotal} 个本地提交没推上去（每轮同步都会重试）。执行 syncvpn_audit action=slim ` +
          `会把它们压成一次干净快照（只丢弃**从未推送过**的本地提交，工作区文件不动），要传的量通常能小一个数量级。`,
      )
    }
    for (const r of uniqueReports) {
      const big = r.biggest?.[0]
      if (big && big.bytes >= 10 * 1024 * 1024) {
        hints.push(`最大单文件 ${big.path}（${big.text}）：这类二进制每改一次就是一次完整上传，考虑留在本机或用单独仓库管理。`)
        break
      }
    }

    return {
      ok: true,
      workspaces: reports,
      duplicates,
      totals: {
        registered: ctx.all.length,
        unique: unique.length,
        duplicates: duplicates.length,
        trackedFiles: uniqueTrackedFiles,
        trackedText: fmtBytes(uniqueTrackedBytes),
        pendingCommits: pendingTotal,
        ignoredTrackedText: fmtBytes(ignoredTotalBytes),
      },
      config: {
        dedupeWorkspaces: this.config.dedupeWorkspaces !== false,
        extraWorkspaceIgnore: patterns,
        syncOpTimeoutSeconds: this.config.syncOpTimeoutSeconds,
      },
      hints,
    }
  }

  /**
   * 让「命中排除规则、但仍在被跟踪」的文件不再上传（`git rm --cached`，本机文件不动）。
   * 下一次同步会提交并推送这些删除记录 —— 之后这些路径不再产生上传。
   */
  async pruneWorkspaceIgnores() {
    const ctx = this.workspaceContext()
    if (!ctx.ok) return ctx
    const patterns = Array.isArray(this.config.extraWorkspaceIgnore) ? this.config.extraWorkspaceIgnore : []
    if (patterns.length === 0) return { ok: false, error: 'extraWorkspaceIgnore 为空，没有可裁的规则' }
    const results = []
    for (const ws of ctx.all) {
      const real = ctx.resolved(ws)
      const gitdir = mirrorDirOf(dshHome(), ws.id)
      if (!real || !fs.existsSync(gitdir)) {
        results.push({ id: ws.id, skipped: real ? 'mirror-missing' : 'no-path' })
        continue
      }
      const branch = branchOf(ctx.cfg, ws.id)
      appendExtraExcludes(gitdir, patterns) // 先确保规则生效，否则下一次 add -A 会把它们又加回来
      const r = untrackPatterns(gitdir, real, patterns)
      results.push({
        id: ws.id,
        branch,
        untrackedFiles: r.removed,
        untrackedBytes: r.bytes,
        untrackedText: fmtBytes(r.bytes),
        error: r.error || null,
      })
      log('info', `工作区 ${String(ws.id).slice(0, 8)}：取消跟踪 ${r.removed} 个命中排除规则的文件（${fmtBytes(r.bytes)}）`)
    }
    const bytes = results.reduce((sum, r) => sum + (Number(r.untrackedBytes) || 0), 0)
    const files = results.reduce((sum, r) => sum + (Number(r.untrackedFiles) || 0), 0)
    return {
      ok: true,
      action: 'prune',
      results,
      untrackedFiles: files,
      untrackedText: fmtBytes(bytes),
      note: '本机文件不会被删除；下一次同步会把这些删除记录提交并推送。',
    }
  }

  /**
   * 把「从未推送过」的本地提交压成一次干净快照，通常能少传一个数量级。
   * 先按排除规则摘掉垃圾，再 reset --soft 到远端 + 重新提交；远端已推送的历史不受影响。
   */
  async slimWorkspaceBranches() {
    const ctx = this.workspaceContext()
    if (!ctx.ok) return ctx
    const patterns = Array.isArray(this.config.extraWorkspaceIgnore) ? this.config.extraWorkspaceIgnore : []
    const results = []
    for (const ws of ctx.all) {
      const real = ctx.resolved(ws)
      const gitdir = mirrorDirOf(dshHome(), ws.id)
      if (!real || !fs.existsSync(gitdir)) {
        results.push({ id: ws.id, skipped: real ? 'mirror-missing' : 'no-path' })
        continue
      }
      const branch = branchOf(ctx.cfg, ws.id)
      if (patterns.length) {
        appendExtraExcludes(gitdir, patterns)
        untrackPatterns(gitdir, real, patterns)
      }
      const r = slimPendingCommits(gitdir, real, branch, {
        commitMessage: `dsh-chatsync: slim snapshot [${path.basename(real) || ws.id}]`,
      })
      results.push({ id: ws.id, branch, ...r })
      if (r.ok) {
        log('info', `工作区 ${String(ws.id).slice(0, 8)}：本地未推送提交 ${r.before} → ${r.after}（压成一次干净快照）`)
      } else {
        log('warn', `工作区 ${String(ws.id).slice(0, 8)}：压缩失败 ${r.error || ''}`)
      }
    }
    return {
      ok: results.every((r) => r.ok || r.skipped),
      action: 'slim',
      results,
      note: '只压「从未推送过」的本地提交；工作区文件不动，已推送的远端历史不动。下一次同步只需推这一份快照。',
    }
  }

  /* ------------------------------------------------------ 提示 / 状态 */

  notice(text) {
    if (!text || this.config.injectNotices === false) return
    this.onNotice(text)
  }

  status() {
    return {
      version: null, // 由 index.js 填
      enabled: this.config.enabled !== false,
      config: {
        vpnService: this.config.vpnService,
        syncTarget: this.config.syncTarget,
        releaseIdleMinutes: this.config.releaseIdleMinutes,
        armOnSync: this.config.armOnSync !== false,
        armOnShellGit: this.config.armOnShellGit !== false,
        alignSyncProxy: this.config.alignSyncProxy !== false,
        injectProxyEnv: this.config.injectProxyEnv !== false,
        clashLaunch: this.config.clashLaunch || '',
      },
      chatsync: {
        ok: this.patch.ok,
        attempted: this.patch.attempted,
        modulePath: this.patch.modulePath,
        methods: this.patch.methods,
        error: this.patch.error,
        appliedAt: this.patch.appliedAt,
      },
      holds: [...this.holds.values()].map((h) => ({ id: h.id, kind: h.kind, reason: h.reason, startedAt: h.startedAt, weEnabled: h.weEnabled, error: h.error || null })),
      // 宿主重跑 apply() 会让进程里出现多份实例：这里如实报告，便于排查「钩子握在哪一份手里」
      instances: liveTriggers().map((t) => ({
        isActive: currentTrigger(null) === t,
        holds: t.holds.size,
        weEnabled: t.weEnabled,
        heartbeat: Boolean(t.heartbeatTimer),
        releaseTimer: Boolean(t.releaseTimer),
      })),
      hookVersion: HOOK_VERSION,
      armedCalls: [...ARMED_CALLS.keys()],
      /** 话题结束自动同步的状态。 */
      topicSync: {
        enabled: this.topicSyncEnabled(),
        dirty: this.topic.dirty,
        inFlight: this.topic.inFlight,
        lastActivityAt: this.topic.lastActivityAt,
        lastActivitySource: this.topic.lastSource,
        lastSyncAt: this.topic.lastAt,
        nextCheckAt: this.topic.nextAt,
        timerArmed: Boolean(this.topicTimer),
        lastResult: this.topic.lastResult,
        skipped: this.topic.skipped,
        failStreak: this.topic.failStreak,
        engineCaptured: Boolean(this.lastEngine),
        config: {
          autoSyncOnTopicEnd: this.config.autoSyncOnTopicEnd !== false,
          idleSeconds: this.config.topicIdleSeconds,
          minIntervalSeconds: this.config.topicSyncMinIntervalSeconds,
          maxBackoffSeconds: this.config.topicSyncMaxBackoffSeconds,
          trigger: this.config.topicSyncTrigger,
        },
      },
      providerSource: this.provider() ? this._providerSource : null,
      weEnabled: this.weEnabled,
      envInjected: Boolean(this.envSaved),
      envSkipped: Boolean(this.envSkipped),
      envKeys: this.envSaved ? Object.fromEntries(PROXY_KEYS.map((k) => [k, process.env[k] ?? null])) : null,
      alignments: this.alignments,
      launchCount: this.launchCount,
      lastEnable: this.lastEnable,
      lastSync: this.lastSync,
      lastExitFlush: this.lastExitFlush,
      lastError: this.lastError,
      /** 工作区侧的现状：去重 + 排除规则 + 推送超时。 */
      workspaceSync: {
        dedupeWorkspaces: this.config.dedupeWorkspaces !== false,
        lastDedupe: this.lastDedupe,
        extraWorkspaceIgnore: Array.isArray(this.config.extraWorkspaceIgnore) ? this.config.extraWorkspaceIgnore : [],
        syncOpTimeoutSeconds: this.config.syncOpTimeoutSeconds,
      },
    }
  }

  /** 自检：钩子挂上了吗 / 代理服务在不在 / 端口对不对 / 目标直连通不通。 */
  async selftest() {
    const hints = []
    const patch = this.patch.ok ? this.patch : await this.patchChatsync()
    if (!patch.ok) hints.push(`chatsync 钩子没挂上：${patch.error || '未知原因'} —— 同步不会自动开代理`)

    const provider = this.provider()
    const providerState = this.providerState()
    if (!provider) {
      hints.push(`拿不到代理服务：请确认 dsh-clash-autovpn ≥ 0.2.0 已装载（它会 provide '${this.config.vpnService}'，并兜底挂 globalThis.__dshClashAutovpn）`)
    } else if (this._providerSource !== `ctx.get('${this.config.vpnService}')`) {
      hints.push(
        `代理实例是从「${this._providerSource}」拿到的（本机宿主的 ctx 没有提供 ctx.provide）。功能不受影响；` +
          `若哪天两个插件不再同进程，就要回头看这条。`,
      )
    }

    const syncCfg = readSyncConfig()
    const syncPort = portOf(syncCfg.proxy)
    const providerPort = portOf(providerState?.proxyUrl)
    const listenPort = providerPort || syncPort || 7890
    const listening = await isListening(listenPort)
    if (!listening) hints.push(`代理端口 ${listenPort} 没有在监听：Clash 客户端/核心没在跑`)
    if (this.config.alignSyncProxy !== false && syncPort && providerPort && syncPort !== providerPort) {
      hints.push(`dsh-sync.json 里的 proxy 端口是 ${syncPort}，Clash 实际混合端口是 ${providerPort} —— 本插件会在同步前自动对齐（不会改你的配置文件）`)
    }
    // 直连 GitHub 的粗判据（只看 TCP 握手；DNS 污染/中间设备会在 TLS 阶段才暴露，
    // 所以这一项「通」不代表 push 一定成功，「不通」则基本可以确定必须走代理）。
    const githubDirect = await probeTcp('github.com', 443, 4000)

    return {
      ready: patch.ok && Boolean(provider) && listening,
      hints,
      chatsync: { ok: patch.ok, modulePath: patch.modulePath, methods: patch.methods, error: patch.error },
      vpnService: {
        name: this.config.vpnService,
        available: Boolean(provider),
        source: this._providerSource || null,
        active: Boolean(providerState?.active),
        node: providerState?.node?.name ?? null,
        proxyUrl: providerState?.proxyUrl ?? null,
      },
      ports: { syncConfigProxy: syncCfg.proxy || null, syncConfigPort: syncPort, clashMixedPort: providerPort, listeningPort: listenPort, listening },
      githubDirectTcp: githubDirect,
      config: this.status().config,
    }
  }

  /* ------------------------------------------------------ 生命周期 */

  /**
   * 卸载（插件重载 / DSH 退出）。
   *
   * 关键在**交接**：宿主重跑 apply() 会先卸载旧实例再装新实例。旧实例手里可能正握着
   * 一次同步的租约（包装是在它那时被调用的），如果直接清空，租约就成了孤儿——
   * 没人还 → 关代理的定时器永远不排 → 代理一直开着（实测踩过：会话用量一路涨到 500MB）。
   * 所以：有接任者就把租约与 callId 记账移交给它；**只有真的没人接**（进程在退出）时
   * 才主动关代理还原。
   */
  dispose() {
    this.disposed = true
    this.cancelRelease()
    this.cancelTopicSync()
    this.stopHeartbeat()
    this.restoreEnv()
    REGISTRY.triggers.delete(this)
    if (REGISTRY.active === this) {
      REGISTRY.active = [...REGISTRY.triggers].filter((t) => !t.disposed).pop() ?? null
    }
    const heir = currentTrigger(null)

    const moved = []
    if (heir) {
      for (const [id, hold] of this.holds) {
        hold.owner = heir
        heir.holds.set(id, hold)
        moved.push(id)
      }
      for (const entry of ARMED_CALLS.values()) {
        if (entry.owner === this) entry.owner = heir
      }
      if (this.weEnabled) {
        heir.weEnabled = true // 代理是"我们这边"开的，接任者要继续负责关它
      }
      // 话题同步的排期也要交接：否则卸载那一刻的"脏"活动就丢了
      heir.topic.dirty = this.topic.dirty || heir.topic.dirty
      heir.topic.lastActivityAt = this.topic.lastActivityAt || heir.topic.lastActivityAt
      heir.topic.lastAt = this.topic.lastAt || heir.topic.lastAt
      heir.topic.lastResult = this.topic.lastResult || heir.topic.lastResult
      heir.topic.failStreak = Math.max(Number(heir.topic.failStreak) || 0, Number(this.topic.failStreak) || 0)
      if (!this.lastEngine) {
        /* 没抓到引擎就算了，接任者自己会在下一轮同步时抓到 */
      } else if (!heir.lastEngine) {
        heir.lastEngine = this.lastEngine
      }
      if (heir.topic.dirty) heir.scheduleTopicSync()
      if (moved.length > 0) heir.startHeartbeat()
    }
    this.holds.clear()
    this.shellHolds.clear()
    this.orphanShellHolds.length = 0

    if (moved.length > 0) {
      log('info', `卸载交接：把 ${moved.length} 个租约移交给新的实例（${moved.join(', ')}）`)
    }

    if (!heir && (this.weEnabled || OWNED_ENABLE)) {
      this.weEnabled = false
      try {
        const provider = this.provider()
        if (!provider || !this.safeStatus()?.active) {
          OWNED_ENABLE = false // 代理已经不在开了（别人关的/自己掉了），所有权跟着归零
        } else {
          Promise.resolve(provider.disable({ reason: 'sync-autovpn:dispose' }))
            .then(() => {
              OWNED_ENABLE = false
              log('info', '卸载时代理仍开着且是本站开的 → 已关闭并逐项还原')
            })
            .catch((error) => log('warn', `卸载时关代理失败：${String(error?.message || error)}`))
        }
      } catch (error) {
        log('warn', `卸载时检查代理状态失败：${String(error?.message || error)}`)
      }
    }
    return { handedOver: moved.length, hadHeir: Boolean(heir) }
  }
}
