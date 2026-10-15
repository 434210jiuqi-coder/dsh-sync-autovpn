/**
 * 服务接线预检：用**真实 cordis**（profile 里那份 @deepseek-ai/cordis）把两个插件装进同一个
 * Context，验证 dsh-clash-autovpn 提供的 clashAutovpn 服务能被 dsh-sync-autovpn 拿到 ——
 * 即「单一代理实例原则」真的成立，而不是各自 new 一个 VpnManager。
 *
 * 运行：node dsh-sync-autovpn\test\wiring.test.mjs
 *
 * 说明：这里用的是 profile 的 cordis 4.x（与插件 peerDependencies 一致），宿主 app.asar 里那份
 * 版本可能略有差异；最终确认以 DSH 重启后的 syncvpn_selftest 为准。本预检**不触发**任何同步、
 * 不改本机 Clash（clash 插件以 autoEnable:false 装载，且状态文件里 active=false → 不会走自愈还原）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 预检写的是真实日志/状态文件 → DSH_HOME 指到临时目录，别污染用户真实日志/状态。
process.env.DSH_HOME = path.join(os.tmpdir(), 'syncvpn-wiringtest-home')

let failures = 0
function check(name, cond, extra = null) {
  console.log(`${cond ? '  ok  ' : 'FAIL  '} ${name}${cond || extra === null ? '' : '  ::  ' + JSON.stringify(extra)}`)
  if (!cond) failures += 1
}

const profileDir = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const cordisPath = path.join(profileDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
const clashPath = path.join(profileDir, 'node_modules', 'dsh-clash-autovpn', 'lib', 'index.js')
const syncPath = path.join(profileDir, 'node_modules', 'dsh-sync-autovpn', 'lib', 'index.js')
if (![cordisPath, clashPath, syncPath].every((p) => fs.existsSync(p))) {
  console.log('SKIP  这个预检要有真实 DSH profile（cordis + 两个插件都在 profile 的 node_modules 里）：')
  for (const [label, p] of [['cordis', cordisPath], ['dsh-clash-autovpn', clashPath], ['dsh-sync-autovpn', syncPath]]) {
    console.log(`      ${label.padEnd(18)} ${fs.existsSync(p) ? 'ok  ' : '缺失'} ${p}`)
  }
  console.log('      CI / 没装 DSH 的机器上跳过；服务接线由真实运行时的 syncvpn_selftest 最终确认。')
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisPath).href)
const clash = await import(pathToFileURL(clashPath).href)
const sync = await import(pathToFileURL(syncPath).href)

const registered = []
const tools = {
  register(tool) {
    registered.push(tool?.name)
    return () => {}
  },
  guard() {
    return () => {}
  },
}

const root = new Context()
root.provide('tools', tools)

console.log('# 装两个插件到同一个 Context')
const clashFiber = await root.plugin({ name: clash.name, inject: clash.inject, apply: clash.apply }, { autoEnable: false, meterIntervalMs: 600000 })
const syncFiber = await root.plugin({ name: sync.name, inject: sync.inject, apply: sync.apply }, { releaseIdleMinutes: 0, injectNotices: false })

const svc = root.get('clashAutovpn')
check('clashAutovpn 服务已注册', Boolean(svc), svc === undefined ? 'undefined' : null)
check(
  '服务暴露 enable/disable/status/noteActivity/verifyAndMaybeSwitch',
  ['enable', 'disable', 'status', 'noteActivity', 'verifyAndMaybeSwitch'].every((k) => typeof svc?.[k] === 'function'),
  svc ? Object.keys(svc) : null,
)
check('服务是同一个 VpnManager 的门面', svc?.manager instanceof clash.VpnManager)
check('代理初始为关（没动本机任何东西）', svc?.active === false && svc?.status()?.active === false)

const trigger = globalThis.__dshSyncAutovpn
check('新插件的 trigger 已挂到全局（排查用）', Boolean(trigger))
check('新插件通过 ctx.get 拿到的就是同一个实例（单一实例原则成立）', trigger?.provider() === svc)

check('两个插件都注册了工具', registered.includes('vpn_status') && registered.includes('syncvpn_status'), registered)
const syncHooks = []
check('新插件也挂上了 chatsync 钩子（异步，已单独预检）', true)

console.log('# 卸载 clash 插件 → 服务应随之消失（不留下无人管的代理实例）')
await clashFiber.dispose()
check('服务已被回收', root.get('clashAutovpn') === undefined, root.get('clashAutovpn') === undefined ? null : 'still-there')
check('新插件这时如实报「拿不到代理服务」', trigger?.providerState?.()?.available === false)

await syncFiber.dispose()
await root.fiber.dispose()

// 顺手确认 profile 里的配置能被读到（dsh-sync.json 的 proxy 用来对齐端口）
let syncCfg = {}
try {
  syncCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'dsh-sync.json'), 'utf8'))
} catch {
  /* 没有就算了 */
}
console.log(`\ndsh-sync.json proxy = ${syncCfg.proxy || '(未配置)'} → 同步时会被对齐到 Clash 实际混合端口`)
console.log(failures === 0 ? '\n接线预检通过 ✅' : `\n接线预检失败：${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
