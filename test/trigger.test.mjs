/**
 * dsh-sync-autovpn 自测：不碰本机 Clash、不联网，用假引擎 + 假代理服务验证触发层。
 *
 * 跑法：`node test/trigger.test.mjs`（或 `npm test`）。退出码 0 = 全过。
 *
 * 覆盖：钩子挂载（_syncOnce / applyProxyEnv / flushSync）与幂等、开代理时机、返回值透传、
 * 空闲自动关、环境变量注入与还原、git 代理端口对齐、失败不阻断同步、并发只开一次、
 * 拿不到代理服务时的报错、命令行 git 识别与租约配对、退出冲刷只记账。
 *
 * 每个用例都有自己的假 chatsync 模块文件（同一进程里原型是共享的，共用一个文件会互相干扰）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { GIT_NET_CMD_RE, SyncTrigger, liveTriggers, portOf } from '../lib/trigger.js'

let failures = 0
function check(name, cond, extra = null) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL   ${name}${extra === null ? '' : '  ::  ' + JSON.stringify(extra)}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------------------------------------------------- 测试环境 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncvpn-test-'))
process.env.DSH_HOME = path.join(tmp, 'home') // 日志/状态写临时目录，别动用户真实目录
process.env.DSH_PROFILE_DIR = path.join(tmp, 'profile') // 不存在 → 逼它走 chatsyncPaths

const FAKE_SOURCE = `export const calls = []
export class SyncEngine {
  constructor() { this._gitEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890' } }
  async _syncOnce(reason, opts) {
    calls.push({ fn: '_syncOnce', reason, httpsProxy: process.env.HTTPS_PROXY ?? null })
    await new Promise((r) => setTimeout(r, 5))
    return { ok: true, reason, opts: opts ?? null }
  }
  applyProxyEnv(cfg) {
    const p = cfg?.proxy ?? ''
    this._gitEnv = { HTTPS_PROXY: p, HTTP_PROXY: p, ALL_PROXY: p }
    calls.push({ fn: 'applyProxyEnv', proxy: cfg?.proxy ?? null })
  }
  flushSync() { calls.push({ fn: 'flushSync' }); return 'flushed' }
}
`

let caseSeq = 0
/** 起一个独立用例：自己的假引擎模块 + 自己的假代理服务 + 已挂好钩子的 trigger。 */
async function setup({ provider = makeProvider(), config = {} } = {}) {
  const file = path.join(tmp, `sync-case-${++caseSeq}.js`)
  fs.writeFileSync(file, FAKE_SOURCE, 'utf8')
  const mod = await import(pathToFileURL(file).href)
  const trigger = new SyncTrigger({ config: { releaseIdleMinutes: 0, chatsyncPaths: [file], ...config } })
  trigger.provider = () => provider
  const patch = await trigger.patchChatsync()
  return { trigger, provider, mod, file, patch }
}

/** 假代理服务（接口与 dsh-clash-autovpn 的 clashAutovpn 服务一致）。 */
function makeProvider(overrides = {}) {
  const p = {
    active: false,
    tripped: false,
    proxyUrl: 'http://127.0.0.1:1080',
    node: { name: 'Fake-香港' },
    region: '香港',
    enableCalls: 0,
    disableCalls: 0,
    noteActivityCalls: 0,
    verifyCalls: 0,
    async enable() {
      p.enableCalls += 1
      p.active = true
      return { ok: true, node: 'Fake-香港', region: '香港', proxyUrl: p.proxyUrl }
    },
    async disable() {
      p.disableCalls += 1
      p.active = false
      return { ok: true, usage: { activationText: '1.0 MB' } }
    },
    status() {
      return {
        active: p.active,
        tripped: p.tripped,
        lastActivityAt: Date.now(),
        proxyUrl: p.proxyUrl,
        node: p.node,
        region: p.region,
        usage: { sessionText: '1.0 MB', budgetText: '1024 MB' },
      }
    },
    noteActivity() {
      p.noteActivityCalls += 1
    },
    async verifyAndMaybeSwitch() {
      p.verifyCalls += 1
      return { ok: true, ms: 42, switched: false }
    },
  }
  return Object.assign(p, overrides)
}

const envProxy = () => (Object.prototype.hasOwnProperty.call(process.env, 'HTTPS_PROXY') ? process.env.HTTPS_PROXY : null)

/* ---------------------------------------------------------------- 1. 小工具 */

console.log('# 工具函数')
check("portOf('http://127.0.0.1:7890') = 7890", portOf('http://127.0.0.1:7890') === 7890)
check('portOf(空) = null', portOf('') === null)
check('认得出 git push', GIT_NET_CMD_RE.test('git push origin main'))
check('认得出带前缀的 git push', GIT_NET_CMD_RE.test('git -C D:\\repo push origin main'))
check('认得出 git clone', GIT_NET_CMD_RE.test('git clone https://github.com/a/b.git'))
check('认得出 gh repo view', GIT_NET_CMD_RE.test('gh repo view'))
check('git status 不触发', !GIT_NET_CMD_RE.test('git status --porcelain'))
check('git log 不触发', !GIT_NET_CMD_RE.test('git log --oneline -5'))

/* ---------------------------------------------------------------- 2. 挂钩子 */

console.log('# 挂 chatsync 钩子')
const c2 = await setup()
check('patchChatsync 成功', c2.patch.ok, c2.patch)
check(
  '三个方法都挂上',
  ['_syncOnce', 'applyProxyEnv', 'flushSync'].every((m) => c2.patch.methods.includes(m)),
  c2.patch.methods,
)
check('模块路径就是那个假引擎', c2.patch.modulePath === fs.realpathSync(c2.file), c2.patch.modulePath)
const c2again = await c2.trigger.patchChatsync()
check('重复调用是幂等的', c2again.ok === true && c2again.methods.length === 3, c2again.methods)
c2.trigger.dispose() // 用例之间必须清干净：活实例是共享的（模块级），留着会干扰后面所有用例

/* ---------------------------------------------------------------- 3. 开 → 关 */

console.log('# 同步前自动开代理 / 空闲后自动关')
const envBefore = envProxy()
const c3 = await setup()
const engine3 = new c3.mod.SyncEngine()
const result3 = await engine3._syncOnce('web-button')
check('_syncOnce 返回值原样透传', result3?.ok === true && result3?.reason === 'web-button', result3)
check('开代理发生在同步之前', c3.provider.enableCalls === 1, c3.provider.enableCalls)
const body3 = c3.mod.calls.find((c) => c.fn === '_syncOnce' && c.reason === 'web-button')
check('同步体内子进程已能拿到 HTTPS_PROXY', body3?.httpsProxy === 'http://127.0.0.1:1080', body3)
check('同步体执行时确实是我们开的代理', c3.trigger.weEnabled === true)
check('同步刚结束时还没关（留空闲窗口）', c3.provider.disableCalls === 0, c3.provider.disableCalls)
await sleep(80)
check('空闲窗口过后自动关代理', c3.provider.disableCalls === 1, c3.provider.disableCalls)
check('环境变量逐项还原', envProxy() === envBefore, envProxy())
check('租约已清空', c3.trigger.holds.size === 0)
check('验过目标站（verifyAfterEnable）', c3.provider.verifyCalls === 1, c3.provider.verifyCalls)
c3.trigger.dispose()

/* ---------------------------------------------------------------- 4. 端口对齐 */

console.log('# git 子进程代理对齐到真实混合端口')
const c4 = await setup()
await c4.trigger.acquire('align-check', { kind: 'manual' })
const engine4 = new c4.mod.SyncEngine()
engine4.applyProxyEnv({ proxy: 'http://127.0.0.1:9999' }) // dsh-sync.json 里写错的端口
check('端口被改成代理实际端口', engine4._gitEnv.HTTPS_PROXY === 'http://127.0.0.1:1080', engine4._gitEnv)
check(
  'HTTP_PROXY / ALL_PROXY 一并改写',
  engine4._gitEnv.HTTP_PROXY === 'http://127.0.0.1:1080' && engine4._gitEnv.ALL_PROXY === 'http://127.0.0.1:1080',
)
check('对齐次数有记账', c4.trigger.alignments === 1, c4.trigger.alignments)

// 代理没开时不许乱改（别人的直连配置要保持原样）
c4.provider.active = false
const engine4b = new c4.mod.SyncEngine()
engine4b.applyProxyEnv({ proxy: 'http://127.0.0.1:9999' })
check('代理关着时不动别人的代理设置', engine4b._gitEnv.HTTPS_PROXY === 'http://127.0.0.1:9999', engine4b._gitEnv)
c4.trigger.dispose()

/* ---------------------------------------------------------------- 5. 已开不重开 */

console.log('# 代理已经开着 → 不重复开')
const activeProvider = makeProvider({ active: true })
const c5 = await setup({ provider: activeProvider })
const hold5 = await c5.trigger.acquire('already-on', { kind: 'manual' })
check('识别为 already', hold5.enable?.already === true, hold5.enable)
check('没有再调用 enable', activeProvider.enableCalls === 0)
c5.trigger.release(hold5)
c5.trigger.cancelRelease()
check('不越权关别人开的代理', (await c5.trigger.tryRelease()).skipped === 'not-ours')
check('也没真的去调 disable', activeProvider.disableCalls === 0, activeProvider.disableCalls)
c5.trigger.dispose()

/* ---------------------------------------------------------------- 6. 失败不阻断 */

console.log('# 开代理失败不能拖垮同步')
const badProvider = makeProvider({
  async enable() {
    badProvider.enableCalls += 1
    throw new Error('控制口未发现')
  },
})
const c6 = await setup({ provider: badProvider })
const engine6 = new c6.mod.SyncEngine()
const result6 = await engine6._syncOnce('web-button')
check('同步仍然跑完并返回结果', result6?.ok === true, result6)
check('失败被记下来', /控制口未发现/.test(String(c6.trigger.lastError || '')), c6.trigger.lastError)
check('失败时不谎报「我们开的代理」', c6.trigger.weEnabled === false)
check('失败时不会去 disable', badProvider.disableCalls === 0)
check('lastSync 里带失败原因', /控制口未发现/.test(String(c6.trigger.lastSync?.error || '')), c6.trigger.lastSync)
c6.trigger.dispose()

/* ---------------------------------------------------------------- 7. 并发 */

console.log('# 并发同步只开一次代理')
const c7 = await setup()
const engine7 = new c7.mod.SyncEngine()
const pA = engine7._syncOnce('a')
const pB = engine7._syncOnce('b')
check('挂起期间心跳已开（防同步中途被空闲逻辑关掉）', c7.trigger.heartbeatTimer !== null)
await Promise.all([pA, pB])
check('enable 只调了一次', c7.provider.enableCalls === 1, c7.provider.enableCalls)
await sleep(80)
check('两个租约都还清后才关', c7.provider.disableCalls === 1, c7.provider.disableCalls)
c7.trigger.dispose()

/* ---------------------------------------------------------------- 8. 没有代理服务 */

console.log('# 拿不到代理服务时的报错')
const c8 = await setup()
c8.trigger.provider = () => null
const hold8 = await c8.trigger.acquire('no-provider', { kind: 'manual' })
check('报错点名 dsh-clash-autovpn', /dsh-clash-autovpn/.test(String(hold8.error || '')), hold8.error)
c8.trigger.dispose()

/* ---------------------------------------------------------------- 9. 命令行 git */

console.log('# 命令行 git push 的事前接管')
const c9 = await setup()
const started = await c9.trigger.armForShell({ name: 'pwsh', callId: 'call-1', arguments: { command: 'git push origin main' } })
check('git push 会先开代理', c9.provider.enableCalls === 1 && Boolean(started))
check(
  'git status 不会开代理',
  (await c9.trigger.armForShell({ name: 'pwsh', callId: 'call-2', arguments: { command: 'git status' } })) === null,
)
check(
  '非 shell 工具不会开代理',
  (await c9.trigger.armForShell({ name: 'read', callId: 'call-3', arguments: { file: 'a git push b' } })) === null,
)
check('归还租约按 callId 配对', c9.trigger.releaseForShell({ callId: 'call-1' }) === true)
await sleep(80)
check('归还后按空闲关代理', c9.provider.disableCalls === 1, c9.provider.disableCalls)
c9.trigger.dispose()

/* ---------------------------------------------------------------- 10. flushSync */

console.log('# 退出冲刷（同步函数）只记账不阻断')
const c10 = await setup()
const engine10 = new c10.mod.SyncEngine()
const flushed = engine10.flushSync()
check('flushSync 返回值透传', flushed === 'flushed')
check('记下「冲刷时代理没开」这一事实', c10.trigger.lastExitFlush?.vpnActive === false, c10.trigger.lastExitFlush)
c10.trigger.dispose()

/* ---------------------------------------------------------------- 11. 开关 */

console.log('# 配置开关')
const disabled = await setup({ config: { enabled: false } })
const engine11 = new disabled.mod.SyncEngine()
await engine11._syncOnce('web-button')
check('enabled=false 时不动代理', disabled.provider.enableCalls === 0, disabled.provider.enableCalls)
check('但仍记账为 skipped', Object.keys(disabled.trigger.status()).length > 0)
disabled.trigger.dispose()

const noArm = await setup({ config: { armOnSync: false } })
const engine11b = new noArm.mod.SyncEngine()
await engine11b._syncOnce('web-button')
check('armOnSync=false 时同步不碰代理', noArm.provider.enableCalls === 0, noArm.provider.enableCalls)
noArm.trigger.dispose()

/* ---------------------------------------------------------------- 12. 租约兜底 */

console.log('# 租约兜底：post-execute 没回来也要能收场')
const cTtl = await setup({ config: { shellHoldTtlMs: 60000 } })
await cTtl.trigger.armForShell({ name: 'pwsh', callId: 'lost-1', arguments: { command: 'git push' } })
check('挂了一个 shell 租约', cTtl.trigger.holds.size === 1)
cTtl.trigger.sweepStaleHolds(Date.now() + 61000) // 模拟一分钟后扫描
check('超时后被兜底释放（心跳不再续命）', cTtl.trigger.holds.size === 0, cTtl.trigger.holds.size)
await sleep(80)
check('释放后按空闲关掉代理', cTtl.provider.disableCalls === 1, cTtl.provider.disableCalls)
cTtl.trigger.dispose()

console.log('# 卸载时若代理是我们开的 → 主动关掉并还原')
const cDispose = await setup()
await cDispose.trigger.acquire('dispose-check', { kind: 'manual' })
check('卸载前代理开着且是本插件开的', cDispose.provider.active === true && cDispose.trigger.weEnabled === true)
cDispose.trigger.dispose()
await sleep(30)
check('卸载时已请求关闭', cDispose.provider.disableCalls === 1, cDispose.provider.disableCalls)

console.log('# 卸载时若不是我们开的 → 不越权关')
const cForeign = await setup({ provider: makeProvider({ active: true }) })
await cForeign.trigger.acquire('foreign', { kind: 'manual' })
cForeign.trigger.dispose()
await sleep(30)
check('没去动别人开的代理', cForeign.provider.disableCalls === 0, cForeign.provider.disableCalls)

/* ---------------------------------------------------------------- 13. 环境变量克制规则 */

console.log('# 代理环境变量：别人设好就不接管 / 别人改过就不覆盖')
// 这一段要求干净的起点：前面几个用例故意制造过注入/还原，这里显式清一下，免得互相干扰
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k]
const c12 = await setup()
process.env.HTTPS_PROXY = 'http://127.0.0.1:1080' // 与假 provider 的 proxyUrl 相同 = 上游插件已经设好
await c12.trigger.acquire('env-skip', { kind: 'manual' })
check('识别为「已经是这个代理」→ 不接管', c12.trigger.envSkipped === true && c12.trigger.envSaved === null, {
  skipped: c12.trigger.envSkipped,
  saved: c12.trigger.envSaved,
})
check('没有顺手写 ALL_PROXY', !Object.prototype.hasOwnProperty.call(process.env, 'ALL_PROXY'))
c12.trigger.restoreEnv()
check('跳过接管时也不动它', process.env.HTTPS_PROXY === 'http://127.0.0.1:1080', process.env.HTTPS_PROXY)
c12.trigger.dispose()

const c13 = await setup()
delete process.env.HTTPS_PROXY
await c13.trigger.acquire('env-own', { kind: 'manual' })
check('该接管时确实注入了', process.env.HTTPS_PROXY === 'http://127.0.0.1:1080', process.env.HTTPS_PROXY)
process.env.HTTPS_PROXY = 'http://127.0.0.1:9999' // 期间别人改成别的值
c13.trigger.restoreEnv()
check('别人改过的键不去覆盖', process.env.HTTPS_PROXY === 'http://127.0.0.1:9999', process.env.HTTPS_PROXY)
check('没有人碰过的键照常还原', !Object.prototype.hasOwnProperty.call(process.env, 'ALL_PROXY'), process.env.ALL_PROXY ?? null)
delete process.env.HTTPS_PROXY
c13.trigger.dispose()

/* ---------------------------------------------------------------- 14. 多实例（宿主重跑 apply） */

console.log('# 多实例：重载交接不让租约变孤儿')
const c14 = await setup()
const A = c14.trigger
// 模拟宿主重跑 apply：同进程里又出现一份新实例（A 仍然活着）
const B = new SyncTrigger({ config: { releaseIdleMinutes: 0, chatsyncPaths: [c14.file] } })
B.provider = () => c14.provider
const engine14 = new c14.mod.SyncEngine()
const sync14 = engine14._syncOnce('reload-test') // 钩子应解析到「当前活着的那份」= B
check('租约落在最新实例上（不是死抱创建时那份）', B.holds.size === 1 && A.holds.size === 0, { A: A.holds.size, B: B.holds.size })
B.dispose() // 宿主卸载新实例
check('卸载时把租约交接给仍活着的实例（不成孤儿）', A.holds.size === 1 && B.holds.size === 0, { A: A.holds.size, B: B.holds.size })
await sync14
await sleep(90)
check('同步结束后照样按空闲关代理', c14.provider.disableCalls === 1, c14.provider.disableCalls)
A.dispose()

console.log('# 多实例：同一次工具调用只开一次代理')
const c15 = await setup()
const A15 = c15.trigger
const B15 = new SyncTrigger({ config: { releaseIdleMinutes: 0, chatsyncPaths: [c15.file] } })
B15.provider = () => c15.provider
const call = { name: 'pwsh', callId: 'dup-1', arguments: { command: 'git push origin main' } }
const h1 = await A15.armForShell(call)
const h2 = await B15.armForShell(call)
check('两份实例看到同一次调用只开一次代理', c15.provider.enableCalls === 1 && Boolean(h1) && h2 === null, { enables: c15.provider.enableCalls, h2 })
check('归还交给任意一份实例都行', B15.releaseForShell({ callId: 'dup-1' }) === true)
await sleep(90)
check('归还后按空闲关代理', c15.provider.disableCalls === 1, c15.provider.disableCalls)
A15.dispose()
B15.dispose()
check('卸载后没有残留的活实例', liveTriggers().length === 0, liveTriggers().length)

/* ---------------------------------------------------------------- 收尾 */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
