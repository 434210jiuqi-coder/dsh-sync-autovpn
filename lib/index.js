/**
 * dsh-sync-autovpn —— 「一按同步就自动开 Clash 代理，用完自动关」的 DSH 插件。
 *
 * 分工（谁负责什么，别混）：
 *   - `dsh-clash-autovpn`：代理本身的**开 / 关 / 逐项还原 / 计量 / 预算刹车**，以及「联网失败后
 *     判定是不是墙」。它是唯一持有代理实例的插件（`ctx.get('clashAutovpn')`）。
 *   - 本插件：只做**触发时机**。在 DSH 的 GitHub 同步（@dpskk2/dsh-chatsync）真正开始前把代理
 *     开起来，同步结束且空闲后关掉；命令行 `git push/pull/fetch/clone`、`gh …` 同理。
 *
 * 为什么值得单独做：同步失败是「事后」才知道的，而 chatsync 的 git 子进程只认它自己那套
 * proxy 环境变量。等失败了再开代理，这一轮上传已经黄了。事前触发才能把「上传失败」变成
 * 「慢一点但成功」。
 *
 * @module dsh-sync-autovpn
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DEFAULT_CONFIG, SyncTrigger } from './trigger.js'
import { log, logPath, pluginDir, readState, recentLog } from './log.js'

export const name = 'dsh-sync-autovpn'
export const inject = ['tools']

const VERSION = '0.1.0'

/**
 * 取 `@deepseek-ai/dsh-tools` 的 `defineTool`。
 *
 * 三层：① 具名导入（宿主的 loader 通常能解析 `@deepseek-ai/*`）；② 安装目录 asar 的绝对路径
 * （应对 profile 布局下裸名解析不到）；③ 兜底恒等函数 + warn（工具定义仍是合法对象，只是少了
 * 宿主侧校验/归一化）。
 */
async function resolveDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod?.defineTool === 'function') return mod.defineTool
  } catch (error) {
    log('warn', `具名导入 @deepseek-ai/dsh-tools 失败：${String(error?.message || error)}`)
  }
  const roots = []
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules'))
  }
  try {
    roots.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules'))
  } catch {
    /* 忽略 */
  }
  for (const root of roots) {
    const target = path.join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
    try {
      const mod = await import('file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20'))
      if (typeof mod?.defineTool === 'function') return mod.defineTool
    } catch {
      /* 试下一个 */
    }
  }
  log('warn', '拿不到宿主的 defineTool，降级为恒等函数（工具仍可注册，但缺少宿主侧 schema 校验）')
  return (definition) => definition
}

function jsonRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * 净化工具返回值成「无损 JSON」。宿主会校验工具结果必须能无损 JSON 化：任何 `undefined`
 * 字段都会让整次调用被拒收（"value is not lossless JSON"），所以每个出口都过一遍。
 */
function jsonSafe(value) {
  if (value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return { name: value.name, message: String(value.message || value) }
  if (typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  return String(value)
}

export async function apply(ctx, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(config || {}) }
  const defineTool = await resolveDefineTool()

  /** 待注入下一轮上下文的提示（只在失败/异常时产生，避免噪声）。 */
  const pendingNotices = []
  const pushNotice = (text) => {
    if (!text || merged.injectNotices === false) return
    pendingNotices.push(String(text))
    while (pendingNotices.length > 3) pendingNotices.shift()
    log('info', `提示待注入：${String(text).slice(0, 160)}`)
  }

  const trigger = new SyncTrigger({ config: merged, ctx, onNotice: pushNotice })

  /* ------------------------------------------------------------ 生命周期 */

  try {
    ctx.effect(
      () => () => {
        try {
          trigger.dispose()
        } catch (error) {
          log('warn', `卸载清理失败：${String(error?.message || error)}`)
        }
      },
      'dsh-sync-autovpn: cleanup',
    )
  } catch (error) {
    log('warn', `注册清理钩子失败：${String(error?.message || error)}`)
  }

  // 挂钩子：装载后异步做，失败只告警（宿主启动流程不能被我们拖住或打断）
  if (merged.enabled !== false) {
    trigger
      .patchChatsync()
      .then((patch) => {
        if (!patch.ok) {
          pushNotice(
            `〔dsh-sync-autovpn〕没能挂上 chatsync 的同步钩子（${patch.error}）——` +
              `点「同步」时不会自动开代理，但命令行的 git/gh 仍会被本插件事前接管。`,
          )
        }
      })
      .catch((error) => log('warn', `挂 chatsync 钩子异常：${String(error?.message || error)}`))
  } else {
    log('info', '插件已禁用（config.enabled=false）：只保留状态/手动工具，不挂钩子')
  }

  /* ------------------------------------------------------------ 钩子 */

  try {
    ctx.on('session/event', () => {
      try {
        trigger.noteTopicActivity('session')
      } catch (error) {
        log('warn', `session/event 处理异常（忽略）：${String(error?.message || error)}`)
      }
    })
    log('info', '会话活动监听已挂载（session/event）→ 话题结束自动同步用')
  } catch (error) {
    log('warn', `挂载 session/event 失败（话题结束自动同步将缺少活动信号）：${String(error?.message || error)}`)
  }

  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        trigger.noteTopicActivity('tool')
        if (trigger.shellGitReason(exec)) await trigger.armForShell(exec)
      } catch (error) {
        log('warn', `pre-execute 处理异常（放行）：${String(error?.message || error)}`)
      }
      return await next()
    })
    log('info', '命令行联网动作监听已挂载（tools/pre-execute）')
  } catch (error) {
    log('warn', `挂载 pre-execute 失败：${String(error?.message || error)}`)
  }

  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decided = (await next()) ?? { kind: 'accept' }
      try {
        trigger.noteTopicActivity('tool')
        trigger.releaseForShell(exec)
        const drained = pendingNotices.splice(0, pendingNotices.length)
        if (drained.length === 0) return decided
        return {
          ...decided,
          additionalContexts: [
            ...(Array.isArray(decided?.additionalContexts) ? decided.additionalContexts : []),
            ...drained.map((text) => ({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: String(text).slice(0, 900) }],
              source: { kind: 'dsh-sync-autovpn' },
            })),
          ],
        }
      } catch (error) {
        log('warn', `post-execute 处理异常（放行）：${String(error?.message || error)}`)
      }
      return decided
    })
    log('info', '工具收尾监听已挂载（tools/post-execute）')
  } catch (error) {
    log('warn', `挂载 post-execute 失败：${String(error?.message || error)}`)
  }

  /* ------------------------------------------------------------ 工具面 */

  const statusTool = defineTool({
    name: 'syncvpn_status',
    description:
      'Show whether GitHub sync / git-push automation is currently holding the Clash proxy open, whether the chatsync ' +
      'hook is attached, the shared VPN provider state, injected proxy env vars and recent plugin log lines. ' +
      'Read-only.',
    parameters: {
      includeLog: { type: 'boolean', description: 'Include the last few plugin log lines (default true).' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      const status = trigger.status()
      return {
        version: VERSION,
        ...status,
        provider: trigger.providerState(),
        // 宿主 ctx 到底给了哪些注册/取用能力（这是「服务接线」能不能走的实测依据）
        ctxApi: (() => {
          const out = {}
          for (const key of ['get', 'set', 'provide', 'accessor', 'mixin', 'inject', 'plugin', 'effect', 'on']) {
            out[key] = typeof ctx?.[key]
          }
          return out
        })(),
        pluginDir: pluginDir(),
        stateFile: path.join(pluginDir(), 'state.json'),
        logFile: logPath(),
        persisted: readState(),
        ...(args?.includeLog === false ? {} : { recentLog: recentLog(12) }),
      }
    },
    timeoutMs: 15000,
  })

  const onTool = defineTool({
    name: 'syncvpn_on',
    description:
      'Turn the Clash proxy on **before** a network action that must not fail (e.g. you are about to run git push ' +
      'yourself, or the user asks to pre-arm the proxy for an upcoming sync). Optionally verify a target through the ' +
      'proxy. Reuses the shared dsh-clash-autovpn instance; call syncvpn_off when done.',
    parameters: {
      target: { type: 'string', description: 'URL to open/verify through the proxy (default: https://github.com/).' },
      reason: { type: 'string', description: 'Free-form reason recorded in the log.' },
      region: { type: 'string', description: 'Preferred node region, e.g. 香港 / 日本 / 美国.' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      if (args?.region) trigger.config.region = String(args.region)
      const hold = await trigger.acquire(`tool:${args?.reason || 'manual'}`, {
        kind: 'manual',
        target: args?.target || merged.syncTarget,
      })
      return {
        holdId: hold.id,
        weEnabled: hold.weEnabled,
        enable: hold.enable || null,
        error: hold.error || null,
        verify: hold.verify || null,
        provider: trigger.providerState(),
      }
    },
    timeoutMs: 120000,
  })

  const offTool = defineTool({
    name: 'syncvpn_off',
    description:
      'Turn the Clash proxy off and restore everything that was changed (Clash mode, node selections, Windows system ' +
      'proxy, DSH egress policy), releasing any holds this plugin is keeping. Use it after a manual syncvpn_on, or when ' +
      'the user explicitly asks to stop using the VPN.',
    parameters: {
      reason: { type: 'string', description: 'Free-form reason recorded in the log.' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      const released = []
      for (const [id, hold] of [...trigger.holds.entries()]) {
        if (hold.kind !== 'manual') continue
        trigger.release(hold)
        released.push(id)
      }
      trigger.shellHolds.clear()
      trigger.orphanShellHolds.length = 0
      trigger.cancelRelease()
      const provider = trigger.provider()
      if (!provider) return { released, disabled: false, error: trigger.providerState().reason || '拿不到代理服务' }
      const status = trigger.safeStatus()
      if (!status?.active) {
        trigger.weEnabled = false
        trigger.restoreEnv()
        return { released, disabled: false, already: true }
      }
      try {
        const result = await provider.disable({ reason: `tool:syncvpn_off:${args?.reason || 'manual'}` })
        trigger.stopHeartbeat()
        trigger.restoreEnv()
        trigger.weEnabled = false
        return { released, disabled: true, result }
      } catch (error) {
        return { released, disabled: false, error: String(error?.message || error) }
      }
    },
    timeoutMs: 120000,
  })

  const selftestTool = defineTool({
    name: 'syncvpn_selftest',
    description:
      'Check the plumbing without changing anything permanent: is the chatsync sync hook attached, is the shared VPN ' +
      'provider available, does the Clash mixed port match the proxy configured in dsh-sync.json, and is github.com:443 ' +
      'reachable directly? Returns hints for whatever is missing.',
    parameters: {},
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async () => ({ version: VERSION, ...(await trigger.selftest()), recentLog: recentLog(8) }),
    timeoutMs: 60000,
  })

  const topicTool = defineTool({
    name: 'syncvpn_topic',
    description:
      'Inspect or drive the "sync when a topic is finished" feature: a topic counts as finished after topicIdleSeconds with no ' +
      'new session activity, then one sync round is triggered automatically (through the same entry as the ⟳ Sync button, so ' +
      'the Clash proxy is opened beforehand). action=status shows the schedule and the last result; action=now forces one ' +
      'round right now (still honouring the guards: min interval, no sync already running, chatsync auto mode).',
    parameters: {
      action: { type: 'string', description: "One of: 'status' (default), 'now'." },
      includeLog: { type: 'boolean', description: 'With action=status: include the last few plugin log lines (default true).' },
    },
    output: { schema: { type: 'json' }, render: jsonRender },
    execute: async (args) => {
      const action = String(args?.action || 'status')
      if (action === 'now') {
        // 先确认有"活动"可同步：手动触发时把脏标记置上，再跳过空闲等待直接跑
        trigger.topic.dirty = true
        const result = await trigger.runTopicSync('manual')
        return { action, ...result, state: trigger.status().topicSync }
      }
      if (action !== 'status') throw new Error(`未知 action：${action}（可用：status / now）`)
      return {
        action,
        version: VERSION,
        state: trigger.status().topicSync,
        provider: trigger.providerState(),
        persisted: readState(),
        ...(args?.includeLog === false ? {} : { recentLog: recentLog(8) }),
      }
    },
    timeoutMs: 2 * 60 * 60 * 1000,
  })

  const tools = [statusTool, onTool, offTool, selftestTool, topicTool]
  for (const tool of tools) {
    try {
      // 统一在出口净化一次（见 jsonSafe 的注释：一个 undefined 字段就会让整次调用被拒收）
      const raw = tool.execute
      tool.execute = async (args, exec) => jsonSafe(await raw(args, exec))
      ctx.tools.register(tool)
    } catch (error) {
      log('error', `注册工具 ${tool?.name} 失败：${String(error?.message || error)}`)
    }
  }

  log(
    'info',
    `dsh-sync-autovpn ${VERSION} 已加载：注册 ${tools.length} 个工具` +
      `（同步前开代理=${merged.armOnSync === false ? '关' : '开'}，命令行 git 前开代理=${merged.armOnShellGit === false ? '关' : '开'}，` +
      `话题结束自动同步=${merged.autoSyncOnTopicEnd === false ? '关' : `开（空闲 ${merged.topicIdleSeconds}s，最小间隔 ${merged.topicSyncMinIntervalSeconds}s）`}，` +
      `空闲 ${merged.releaseIdleMinutes} 分钟关，借用的代理服务='${merged.vpnService}'）`,
  )

  // 便于自动化测试与排查：只读用途
  try {
    globalThis.__dshSyncAutovpn = trigger
  } catch {
    /* 忽略 */
  }
}
