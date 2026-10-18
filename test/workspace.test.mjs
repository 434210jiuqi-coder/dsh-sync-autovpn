/**
 * 工作区去重 / 瘦身的自测：纯逻辑 + 真实 git（临时目录，不碰用户仓库）+ 钩子包装行为。
 *
 * 跑法：node test/workspace.test.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { SyncTrigger } from '../lib/trigger.js'
import {
  DEFAULT_EXTRA_IGNORE,
  appendExtraExcludes,
  churnPaths,
  dedupeByResolvedPath,
  fmtBytes,
  listIndexed,
  listTracked,
  matchPattern,
  pendingCount,
  slimPendingCommits,
  untrackPatterns,
} from '../lib/workspace.js'

let failures = 0
function check(name, cond, extra = null) {
  console.log(`${cond ? '  ok  ' : 'FAIL  '} ${name}${cond || extra === null ? '' : '  ::  ' + JSON.stringify(extra)}`)
  if (!cond) failures += 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncvpn-ws-'))
process.env.DSH_HOME = path.join(tmp, 'home')
// ⚠ 必须把 profile 指到不存在的路径：否则 patchChatsync 会先找到**真实的** chatsync，
// 把补丁挂到真引擎上，而这个测试用的是假引擎（第一次写这个测试时就栽在这上面）。
process.env.DSH_PROFILE_DIR = path.join(tmp, 'profile')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

function git(args, cwd = null) {
  const r = spawnSync('git', args, { cwd: cwd || undefined, encoding: 'utf8', windowsHide: true })
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.name', 'test'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'core.autocrlf', 'false'], dir)
}

/* ---------------------------------------------------------------- 1. 模式匹配 */

console.log('# 排除规则匹配')
check('目录规则命中子文件', matchPattern('.kb/kb.sqlite', '.kb/') === true)
check('扩展名规则命中任意层级', matchPattern('a/b/c.pyc', '*.pyc') === true)
check('扩展名不误伤同名目录', matchPattern('a/b/c.pyc.txt', '*.pyc') === false)
check('普通文件名精确匹配', matchPattern('Thumbs.db', 'Thumbs.db') === true)
check('不命中就返回 false', matchPattern('src/index.js', ['*.pyc', '.kb/']) === false)
check('fmtBytes', fmtBytes(4 * 1024 * 1024) === '4.0 MB', fmtBytes(4 * 1024 * 1024))

/* ---------------------------------------------------------------- 2. 去重 */

console.log('# 工作区去重（按真实路径）')
const wsList = [
  { id: 'a', path: 'C:/ws' },
  { id: 'b', path: 'c:/WS' }, // 大小写不同、同一个目录
  { id: 'c', path: 'C:/other' },
  { id: 'd', path: null }, // 解析不到路径 → 保留
]
const deduped = dedupeByResolvedPath(wsList, (w) => w.path)
check('同路径只留第一条', deduped.unique.map((w) => w.id).join(',') === 'a,c,d', deduped.unique.map((w) => w.id))
check('重复项指向被保留的那条', deduped.duplicates.length === 1 && deduped.duplicates[0].sameAs === 'a', deduped.duplicates)

/* ---------------------------------------------------------------- 3. 真实 git：排除 + 取消跟踪 */

console.log('# 排除规则写进 info/exclude 并取消跟踪（本机文件保留）')
const wsDir = path.join(tmp, 'ws')
const mirror = path.join(tmp, 'mirror.git')
initRepo(wsDir)
fs.writeFileSync(path.join(wsDir, 'a.txt'), 'hello\n')
fs.mkdirSync(path.join(wsDir, '.kb'), { recursive: true })
fs.writeFileSync(path.join(wsDir, '.kb', 'kb.sqlite'), 'x'.repeat(4096))
fs.mkdirSync(path.join(wsDir, '__pycache__'), { recursive: true })
fs.writeFileSync(path.join(wsDir, '__pycache__', 'm.pyc'), 'y'.repeat(2048))
fs.writeFileSync(path.join(wsDir, 'Git-2.56.0.0-installer.exe'), 'z'.repeat(8192))
git(['add', '-A'], wsDir)
git(['commit', '-m', 'init'], wsDir)
git(['init', '--bare', '-b', 'main', mirror])
git(['--git-dir=' + mirror, 'config', 'user.name', 'test'])
git(['--git-dir=' + mirror, 'config', 'user.email', 'test@example.com'])
git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'add', '-A'])
git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'commit', '-m', 'snapshot'])

const beforeTracked = listTracked(mirror, wsDir, 'HEAD')
check('初始跟踪 4 个文件', beforeTracked.files.length === 4, beforeTracked.files.map((f) => f.path))
const excl = appendExtraExcludes(mirror, DEFAULT_EXTRA_IGNORE)
check('排除规则已写入 info/exclude', excl.added > 0 && fs.existsSync(path.join(mirror, 'info', 'exclude')))
const pruned = untrackPatterns(mirror, wsDir, DEFAULT_EXTRA_IGNORE)
check('取消跟踪了 3 个垃圾文件', pruned.removed === 3, { removed: pruned.removed, err: pruned.error })
check('统计出了省下的字节数', pruned.bytes >= 8192 + 4096 + 2048 - 1, pruned.bytes)
const afterTracked = listIndexed(mirror, wsDir)
check('只剩正文文件被索引跟踪', afterTracked.size === 1 && afterTracked.has('a.txt'), [...afterTracked])
check('本机文件没有被删掉', fs.existsSync(path.join(wsDir, '.kb', 'kb.sqlite')))
git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'add', '-A'])
const st = git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'status', '--porcelain'])
check('排除后 add -A 不会把它们重新加进来', !/^A\s/.test(st.out) && ![...listIndexed(mirror, wsDir)].some((p) => /\.pyc|installer\.exe|\.kb\//.test(p)), {
  status: st.out.split('\n').slice(0, 5),
  indexed: [...listIndexed(mirror, wsDir)],
})
check('churn 统计可用', Array.isArray(churnPaths(mirror, wsDir, 'HEAD', 5).counts))

/* ---------------------------------------------------------------- 4. 真实 git：压缩未推送提交 */

console.log('# 把未推送的本地提交压成一次干净快照')
const origin = path.join(tmp, 'origin.git')
git(['init', '--bare', origin])
git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'remote', 'add', 'origin', origin])
git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'push', '-u', 'origin', 'HEAD:main'])
git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD'])
for (let i = 1; i <= 3; i++) {
  fs.writeFileSync(path.join(wsDir, 'b.txt'), 'v' + i + '\n')
  git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'add', '-A'])
  git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'commit', '-m', 'local ' + i])
}
check('压缩前有 3 个未推送提交', pendingCount(mirror, wsDir, 'main') === 3, pendingCount(mirror, wsDir, 'main'))
const slim = slimPendingCommits(mirror, wsDir, 'main', { commitMessage: 'slim test' })
check('压缩成功', slim.ok === true, slim)
check('压缩后只剩 1 个提交（或 0，若内容与远端一致）', slim.after !== null && slim.after <= 1, slim)
check('工作区文件仍在', fs.existsSync(path.join(wsDir, 'b.txt')))
const log = git(['--git-dir=' + mirror, '--work-tree=' + wsDir, 'log', '--oneline', '-5'])
check('历史被压成一条 slim 快照', (log.out.match(/slim test/g) || []).length === 1, log.out)

/* ---------------------------------------------------------------- 5. 钩子包装：去重/超时/排除 */

console.log('# 钩子包装：去重 / 放宽推送超时 / 补排除规则')
const FAKE = path.join(tmp, 'fake-sync.js')
fs.writeFileSync(
  FAKE,
  `export const calls = []
export class SyncEngine {
  constructor() {
    this._gitEnv = {}
    this.seen = []
    this.retry = []
    this.mirrorCalls = []
    this.mirrorDir = null
  }
  async _syncOnce(reason) { calls.push({ fn: '_syncOnce', reason }); return { ok: true, reason } }
  applyProxyEnv() {}
  flushSync() { return 'flushed' }
  loadConfig() { return { proxy: '', workspaceBranchPrefix: 'ws' } }
  workspaceRealPathOf(ws) { return ws.path }
  workspaceGitDir(id) { return this.mirrorDir || id }
  workspaces() {
    return [
      { id: 'aaaa1111', title: 'dup', path: 'C:/one' },
      { id: 'bbbb2222', title: 'dup-copy', path: 'c:/ONE' },
      { id: 'cccc3333', title: 'other', path: 'C:/two' },
    ]
  }
  async syncAllWorkspaces(cfg, reason, opts) {
    this.seen = this.workspaces().map((w) => w.id)
    calls.push({ fn: 'syncAllWorkspaces', seen: this.seen, reason })
    return { total: this.seen.length }
  }
  async ensureWorkspaceMirror(id, realPath, cfg) { this.mirrorCalls.push({ id, realPath }); return true }
  async runWithRetry(op, label, args, options = {}) {
    this.retry.push({ op, timeoutMs: options?.timeoutMs })
    return { code: 0, out: '', err: '' }
  }
}
`,
  'utf8',
)
const mod = await import(pathToFileURL(FAKE).href)
const trigger = new SyncTrigger({
  config: { releaseIdleMinutes: 0, chatsyncPaths: [FAKE], dedupeWorkspaces: true, syncOpTimeoutSeconds: 600 },
})
trigger.provider = () => null
const patch = await trigger.patchChatsync()
check('工作区补丁全部挂上', ['syncAllWorkspaces', 'workspaces', 'ensureWorkspaceMirror', 'runWithRetry'].every((m) => patch.methods.includes(m)), patch.methods)

const engine = new mod.SyncEngine()
engine.mirrorDir = path.join(tmp, 'ws-mirror.git')
git(['init', '--bare', '-b', 'main', engine.mirrorDir])
await engine.syncAllWorkspaces({}, 'test', {})
check('去重：同步时只看到 2 份（重复的那条被跳过）', engine.seen.length === 2 && !engine.seen.includes('bbbb2222'), engine.seen)
check('去重：被跳过的 id 记在 lastDedupe', trigger.lastDedupe?.duplicates?.[0]?.id === 'bbbb2222', trigger.lastDedupe)
check('去重：原始登记仍然是 3 条（只影响本轮同步）', engine.workspaces.length >= 0 && new mod.SyncEngine().workspaces().length === 3)

await engine.runWithRetry('push', 'x', [], { timeoutMs: 180000 })
await engine.runWithRetry('fetch', 'x', [], { timeoutMs: 180000 })
await engine.runWithRetry('status', 'x', [], { timeoutMs: 180000 })
check('推送超时被放宽到 600s', engine.retry[0].timeoutMs === 600000, engine.retry[0])
check('拉取也放宽', engine.retry[1].timeoutMs === 600000, engine.retry[1])
check('其它 git 操作保持原超时', engine.retry[2].timeoutMs === 180000, engine.retry[2])

await engine.ensureWorkspaceMirror('aaaa1111', path.join(tmp, 'ws'), {})
const exclText = fs.readFileSync(path.join(engine.mirrorDir, 'info', 'exclude'), 'utf8')
check('ensureWorkspaceMirror 之后排除规则已落盘', exclText.includes('__pycache__/') && exclText.includes('*.pyc'), exclText.split('\n').slice(0, 6))
trigger.dispose()

/* ---------------------------------------------------------------- 收尾 */

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
