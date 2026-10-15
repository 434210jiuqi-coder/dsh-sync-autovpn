/**
 * 装载前预检：按宿主将要使用的那条解析路径（profile 的 node_modules 联接）真正 import 插件入口，
 * 用**真实** defineTool（从 asar 取）+ mock ctx 调一次 apply()，断言：工具与钩子都注册成功、
 * chatsync 的同步钩子确实挂上了真实的 lib/sync.js、工具结果能无损 JSON 化。
 *
 * 运行（在 profile 目录下解析联接；profile 不存在会自动 SKIP）：
 *   $env:DSH_PROFILE_DIR="$env:USERPROFILE\.dsh\profiles\desktop"; node dsh-sync-autovpn\test\plugin-load.mjs
 *
 * 注意：这个预检只 import + 打原型钩子，**不会**触发任何同步/联网动作（fake provider 也不存在），
 * 唯一的外部动作是 syncvpn_selftest 里对 github.com:443 的一次 TCP 握手探测。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 预检写的是真实日志/状态文件，这里把 DSH_HOME 指到临时目录：别把测试痕迹混进用户真实日志，
// 也别让预检的假 provider 写脏 ~/.dsh/sync-autovpn/state.json。profile 解析仍走 DSH_PROFILE_DIR。
// 但 dsh-sync.json 原样拷一份进临时 home，好让「端口对齐」这类以真实配置为前提的检查仍然有效。
process.env.DSH_HOME = path.join(os.tmpdir(), 'syncvpn-loadtest-home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })
try {
  fs.copyFileSync(path.join(os.homedir(), '.dsh', 'dsh-sync.json'), path.join(process.env.DSH_HOME, 'dsh-sync.json'))
} catch {
  /* 没有真实配置就算了 */
}

const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const chatsyncDir = path.join(profileDir, 'node_modules', '@dpskk2', 'dsh-chatsync')
if (!fs.existsSync(profileDir) || !fs.existsSync(chatsyncDir)) {
  console.log(`SKIP  这个预检要有真实 DSH 环境（profile + @dpskk2/dsh-chatsync）：`)
  console.log(`      profile    = ${profileDir}`)
  console.log(`      chatsync   = ${chatsyncDir}`)
  console.log('      CI / 没装 DSH 的机器上跳过；逻辑正确性由 test/trigger.test.mjs 覆盖。')
  process.exit(0)
}
process.chdir(profileDir)

const registered = []
const hooks = []
const effects = []

const mockCtx = {
  tools: {
    register(tool) {
      registered.push(tool)
      return () => {}
    },
  },
  on(event, fn) {
    hooks.push({ event, fn })
    return () => {}
  },
  get() {
    return undefined // 预检里不给 clashAutovpn 服务：验证「没有代理服务也要能装、且如实报错」
  },
  effect(callback) {
    effects.push(callback())
    return () => {}
  },
}

console.log('cwd =', process.cwd())
console.log('解析入口：', await import.meta.resolve('dsh-sync-autovpn'))

const mod = await import('dsh-sync-autovpn')
console.log('导出：', Object.keys(mod).join(', '))
console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))

await mod.apply(mockCtx, {
  releaseIdleMinutes: 0,
  injectNotices: false, // 预检不产生待注入提示
})

const toolNames = registered.map((t) => t?.name).sort()
const expected = ['syncvpn_off', 'syncvpn_on', 'syncvpn_selftest', 'syncvpn_status', 'syncvpn_topic']
const okTools = JSON.stringify(toolNames) === JSON.stringify(expected)
const okHooks =
  hooks.some((h) => h.event === 'tools/pre-execute') &&
  hooks.some((h) => h.event === 'tools/post-execute') &&
  hooks.some((h) => h.event === 'session/event') // 话题结束自动同步的活动信号
const okEffect = effects.length === 1

const trigger = globalThis.__dshSyncAutovpn
// 插件自己是在装载时**异步**挂钩子的（不阻塞宿主启动），所以这里显式等一次再断言；
// 顺带验证 patchChatsync 的幂等（第二次调用不该重复包装）。
const patch = await trigger.patchChatsync()
const patchOk = Boolean(patch?.ok)
const hookSummary = `${patch?.modulePath || '(未挂上)'} → ${(patch?.methods || []).join(' / ') || patch?.error || ''}`

console.log(`\n注册工具 (${registered.length})：${toolNames.join(', ')}`)
console.log(`钩子：${hooks.map((h) => h.event).join(', ')} | effect：${effects.length}`)
console.log(`chatsync 钩子：${hookSummary}`)

for (const tool of registered) {
  if (typeof tool.description !== 'string' || tool.description.length < 20) console.log(`  ⚠ ${tool.name} 描述过短`)
  if (typeof tool.execute !== 'function') console.log(`  ⚠ ${tool.name} 缺少 execute`)
  if (tool.output?.schema === undefined) console.log(`  ⚠ ${tool.name} 缺少 output.schema`)
}

// 工具出口必须能无损 JSON 化（宿主硬校验）
let okJson = false
let statusSummary = ''
try {
  const statusTool = registered.find((t) => t.name === 'syncvpn_status')
  const noLog = await statusTool.execute({ includeLog: false }, {})
  const withLog = await statusTool.execute({ includeLog: true }, {})
  const lossless = (v) => JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)
  okJson = lossless(noLog) && lossless(withLog)
  statusSummary =
    `钩子=${noLog.chatsync?.ok} 方法=${(noLog.chatsync?.methods || []).join('/')} 代理服务可用=${noLog.provider?.available}` +
    ` 持租约=${noLog.holds?.length ?? 0} 日志行=${withLog.recentLog?.length ?? 0}`
} catch (error) {
  statusSummary = `调用失败：${String(error?.message || error)}`
}

// 没有代理服务时：syncvpn_on / syncvpn_off 必须给出人话错误，而不是崩
let okNoProvider = false
let noProviderSummary = ''
try {
  const onTool = registered.find((t) => t.name === 'syncvpn_on')
  const offTool = registered.find((t) => t.name === 'syncvpn_off')
  const onResult = await onTool.execute({ reason: 'preflight' }, {})
  const offResult = await offTool.execute({ reason: 'preflight' }, {})
  okNoProvider = /dsh-clash-autovpn/.test(String(onResult.error || '')) && offResult.disabled === false
  noProviderSummary = `on.error=${String(onResult.error || '').slice(0, 90)}…`
} catch (error) {
  noProviderSummary = `抛异常了（不该）：${String(error?.message || error)}`
}

// 自检工具：这一步会真的探一次 github.com:443（只 TCP 握手）
let selftestSummary = ''
try {
  const tool = registered.find((t) => t.name === 'syncvpn_selftest')
  const result = await tool.execute({}, {})
  selftestSummary =
    `ready=${result.ready} 钩子=${result.chatsync?.ok} 端口(配置/实际)=${result.ports?.syncConfigPort}/${result.ports?.clashMixedPort}` +
    ` 监听=${result.ports?.listening} 直连github=${result.githubDirectTcp?.ok}(${result.githubDirectTcp?.ms}ms)`
  console.log(`syncvpn_selftest：${selftestSummary}`)
  console.log(`  hints：${(result.hints || []).join(' | ') || '(无)'}`)
} catch (error) {
  selftestSummary = `调用失败：${String(error?.message || error)}`
}

/* ---------- 真实引擎实例：包装是不是真的拦在同步体之前 ---------- */

// 做法：先把这个**真实** SyncEngine 的 _syncOnce 换成 stub（不跑任何 git），再用插件的 attach
// 去包它，然后像一个真实实例那样调用一次 —— 验证「开代理 → 同步体 → 还租约」的顺序与透传。
// 只在预检进程里改原型，跑完立刻还原。
const { SyncEngine } = await import(pathToFileURL(patch.modulePath).href)
const originalSyncOnce = SyncEngine.prototype._syncOnce
const bodyLog = []
SyncEngine.prototype._syncOnce = async function (reason, opts) {
  bodyLog.push({ reason, httpsProxy: process.env.HTTPS_PROXY ?? null })
  return { stubbed: true, reason, opts: opts ?? null }
}

const fakeProvider = {
  active: false,
  proxyUrl: 'http://127.0.0.1:1080',
  node: { name: 'Fake-香港' },
  region: '香港',
  enableCalls: 0,
  disableCalls: 0,
  async enable() {
    fakeProvider.enableCalls += 1
    fakeProvider.active = true
    return { ok: true, node: 'Fake-香港' }
  },
  async disable() {
    fakeProvider.disableCalls += 1
    fakeProvider.active = false
    return { ok: true, usage: { activationText: 'noop' } }
  },
  status() {
    return {
      active: fakeProvider.active,
      lastActivityAt: Date.now(),
      proxyUrl: fakeProvider.proxyUrl,
      node: fakeProvider.node,
      region: fakeProvider.region,
      usage: { sessionText: '0 B', budgetText: '1024 MB' },
    }
  },
  noteActivity() {},
  async verifyAndMaybeSwitch() {
    return { ok: true, ms: 10 }
  },
}
trigger.provider = () => fakeProvider
trigger.config.releaseIdleMinutes = 0

const reAttached = trigger.attach(SyncEngine)
const realEngine = new SyncEngine(path.join(os.tmpdir(), 'syncvpn-loadtest-home'), {}, () => {})
const realResult = await realEngine._syncOnce('web-button')
await new Promise((resolve) => setTimeout(resolve, 80))
const okRealEngine =
  reAttached.includes('_syncOnce') &&
  realResult?.stubbed === true &&
  fakeProvider.enableCalls === 1 &&
  bodyLog[0]?.httpsProxy === 'http://127.0.0.1:1080' &&
  fakeProvider.disableCalls === 1
console.log(
  `真实引擎实例实测：包装=${reAttached.join('/')} 同步体拿到 HTTPS_PROXY=${bodyLog[0]?.httpsProxy ?? '(空)'} ` +
    `enable=${fakeProvider.enableCalls} disable=${fakeProvider.disableCalls} 返回值=${JSON.stringify(realResult)}`,
)
SyncEngine.prototype._syncOnce = originalSyncOnce // 还原，别把预检进程的状态带出去

const checks = [
  ['工具名齐备', okTools],
  ['pre/post-execute 钩子已挂', okHooks],
  ['卸载清理 effect 已注册', okEffect],
  ['chatsync 同步钩子真的挂上了', patchOk],
  ['syncvpn_status 结果可无损 JSON 化', okJson],
  ['没有代理服务时给出人话错误而非崩溃', okNoProvider],
  ['真实 SyncEngine 实例上：同步前开代理 / 同步体拿到代理 / 结束后还租约', okRealEngine],
]
console.log(`\nsyncvpn_status 实测：${statusSummary}`)
console.log(`无代理服务实测：${noProviderSummary}`)
let bad = 0
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) bad++
}
console.log(bad === 0 ? '\n装载预检通过 ✅' : `\n装载预检失败：${bad} 项`)
process.exit(bad === 0 ? 0 : 1)
