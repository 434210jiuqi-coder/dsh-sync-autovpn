/**
 * dsh-sync-autovpn/workspace —— 工作区同步的「去重 + 瘦身」。
 *
 * 解决三件实测出来的浪费（2026-10-19 本机实测）：
 *  ① **同一个工作区被登记两遍**：两条记录指向同一目录 → 两个影子仓库、两轮 fetch/status/push，
 *     同样的 2101 个文件存两份（一份 88 MiB、一份 2.9 MiB）。去重后工作量直接减半。
 *  ② **把本机可再生的垃圾当内容上传**：`.kb/kb.sqlite`（4 MB 活数据库，每轮都在变）、
 *     `__pycache__/*.pyc`、两个安装包（66 MB + 15 MB）……这些进了同步历史就是每次都要多传的字节。
 *  ③ **推送被 3 分钟超时掐断**：chatsync 对 push/fetch 只给 180s，大包没传完就被杀，
 *     然后重试一次、再失败 → 留下「8 个提交推不上去」的积压。放宽到 10 分钟后一次能传完。
 *
 * 本模块只做纯逻辑与 git 只读/低风险操作；是否真的裁掉历史由 `trigger.js` 里的显式动作决定。
 *
 * @module dsh-sync-autovpn/workspace
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { log } from './log.js'

/**
 * 默认额外排除项。原则：**只排「本机可再生 / 到处都有副本」的东西**，不碰用户的正文内容。
 * 写成 gitignore 语法，直接进影子仓库的 `info/exclude`。
 */
export const DEFAULT_EXTRA_IGNORE = [
  // 字节码与缓存：每次跑 Python 都可能变
  '__pycache__/',
  '*.pyc',
  '*.pyo',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.cache/',
  '.venv/',
  'venv/',
  // 本地知识库索引（活数据库，几 MB 且每轮都变）
  '.kb/',
  '.kb-rag/',
  // 安装包/镜像：体积大、别处有副本
  '*.exe',
  '*.msi',
  '*.dmg',
  '*.pkg',
  '*.iso',
  // 依赖与构建产物
  'node_modules/',
  '.pnpm-store/',
  '.npm-cache/',
  'dist/',
  'build/',
  '*.xpi',
  // 临时文件与日志
  '*.log',
  '*.tmp',
  '*.bak-*',
  '~$*',
  '.DS_Store',
  'Thumbs.db',
]

/** 一条 gitignore 风格的模式是否匹配某个相对路径（够用的子集：目录前缀 / `*.ext` / 含通配的名字）。 */
export function matchPattern(relPath, pattern) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '')
  let pat = String(pattern || '').trim().replace(/^\.\//, '')
  if (!pat || !p) return false
  pat = pat.replace(/\/+$/, '')
  if (!pat) return false
  if (!pat.includes('*')) return p === pat || p.startsWith(pat + '/')
  const toRe = (s) => new RegExp('^' + s.split('*').map((x) => x.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$', 'i')
  // ① 整条路径直接匹配（模式里带 / 的情形）；② 任何一段（目录名或文件名）匹配都算命中 ——
  // 这样 `_dshmarket-upgrade-*` 这种"带通配的目录名"才能把它下面的文件都算进来。
  if (pat.includes('/')) {
    const re = toRe(pat)
    if (re.test(p)) return true
    if (p.startsWith(pat + '/')) return true
  }
  const re = toRe(pat)
  return p.split('/').some((seg) => re.test(seg))
}

/** 命中任一模式就算「该排除」，返回命中的那条模式。 */
export function matchAny(relPath, patterns = []) {
  for (const pattern of patterns) if (matchPattern(relPath, pattern)) return pattern
  return null
}

/** 把路径列表按块切分（`git rm` 一次别塞太多参数）。 */
function chunk(list, size = 200) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** 按「真实路径」去重工作区登记；保留第一条，其余记为 duplicates。 */
export function dedupeByResolvedPath(workspaces, resolvePath) {
  const seen = new Map()
  const unique = []
  const duplicates = []
  for (const ws of Array.isArray(workspaces) ? workspaces : []) {
    let real = null
    try {
      real = resolvePath(ws)
    } catch {
      real = null
    }
    const key = real ? path.resolve(real).toLowerCase() : `id:${ws?.id}`
    if (!real) {
      unique.push(ws)
      continue
    }
    if (seen.has(key)) {
      duplicates.push({ id: ws?.id, title: ws?.title ?? null, path: real, sameAs: seen.get(key) })
      continue
    }
    seen.set(key, ws?.id)
    unique.push(ws)
  }
  return { unique, duplicates }
}

/** 跑一条 git（同步、带超时），返回 { ok, out, err, code }。 */
export function runGit(args, { timeoutMs = 60000, cwd = null, binary = false } = {}) {
  const res = spawnSync('git', args, {
    cwd: cwd || undefined,
    timeout: Math.max(1000, Number(timeoutMs) || 60000),
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    encoding: binary ? 'buffer' : 'utf8',
  })
  return {
    ok: res.status === 0,
    code: res.status,
    out: binary ? Buffer.from(res.stdout || []) : String(res.stdout || ''),
    err: binary ? Buffer.from(res.stderr || []) : String(res.stderr || ''),
    timedOut: res.error?.code === 'ETIMEDOUT',
  }
}

/** 影子仓库的 git 参数前缀。 */
function mirrorArgs(gitdir, realPath) {
  return ['--git-dir=' + gitdir, '--work-tree=' + realPath]
}

/**
 * 列出影子仓库某分支上被跟踪的文件与大小。
 * 用 `-z` + TAB 切分：路径里的空格/中文都不会把解析搞坏（实测 PowerShell 按空白切会炸）。
 */
export function listTracked(gitdir, realPath, rev = 'HEAD', { timeoutMs = 120000 } = {}) {
  const r = runGit([...mirrorArgs(gitdir, realPath), 'ls-tree', '-r', '-l', '-z', rev], { timeoutMs })
  if (!r.ok) return { ok: false, error: String(r.err || r.code).slice(0, 300), files: [] }
  const files = []
  for (const rec of String(r.out).split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const meta = rec.slice(0, tab).trim().split(/\s+/)
    const size = Number(meta[3])
    files.push({ size: Number.isFinite(size) ? size : 0, path: rec.slice(tab + 1) })
  }
  return { ok: true, files }
}

/** 最近 N 个提交里最常改动的路径（同一路径只记一次/提交）。 */
export function churnPaths(gitdir, realPath, rev = 'HEAD', commits = 10, { timeoutMs = 120000 } = {}) {
  const r = runGit(
    [...mirrorArgs(gitdir, realPath), 'log', '--name-only', '-z', '--pretty=format:', `-${Math.max(1, commits)}`, rev],
    { timeoutMs },
  )
  if (!r.ok) return { ok: false, counts: [] }
  const counts = new Map()
  for (const rec of String(r.out).split('\0')) {
    const p = rec.replace(/^\s+|\s+$/g, '')
    if (!p) continue
    counts.set(p, (counts.get(p) || 0) + 1)
  }
  return {
    ok: true,
    counts: [...counts.entries()].map(([p, n]) => ({ path: p, count: n })).sort((a, b) => b.count - a.count),
  }
}

/** 本地分支相对远端差几个提交（拿不到远端 ref 时返回 null）。 */
export function pendingCount(gitdir, realPath, branch) {
  const range = `refs/remotes/origin/${branch}..${branch}`
  const r = runGit([...mirrorArgs(gitdir, realPath), 'rev-list', '--count', range], { timeoutMs: 30000 })
  if (!r.ok) return null
  const n = Number(String(r.out).trim())
  return Number.isFinite(n) ? n : null
}

/** 本地分支相对远端改动的体量（用于回答「这一轮到底还要传多少」）。 */
export function pendingDiffStat(gitdir, realPath, branch) {
  const range = `refs/remotes/origin/${branch}..${branch}`
  const numstat = runGit([...mirrorArgs(gitdir, realPath), 'diff', '--numstat', '-z', range], { timeoutMs: 120000 })
  if (!numstat.ok) return { ok: false, files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const parts = String(numstat.out).split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i]
    if (!rec) continue
    const bits = rec.split('\t')
    if (bits.length < 3) continue
    files += 1
    const add = Number(bits[0])
    // 二进制文件 numstat 是 "-"，拿不到行数；这里只统计「路径数」，字节数另用 ls-tree 估
    if (Number.isFinite(add)) bytes += 0
  }
  void bytes
  return { ok: true, files }
}

/**
 * 把额外排除项**原样**写进影子仓库的 `info/exclude`。
 *
 * 为什么不走 chatsync 的 `workspaceExtraIgnore`：它给每条都补一个 `/`（把 `*.pyc` 变成
 * 「名为 *.pyc 的目录」），文件通配符会失效。我们直接写原文，目录/通配都生效。
 */
export function appendExtraExcludes(gitdir, patterns = []) {
  if (!patterns.length) return { ok: false, added: 0 }
  const exclPath = path.join(gitdir, 'info', 'exclude')
  try {
    fs.mkdirSync(path.dirname(exclPath), { recursive: true })
  } catch {
    /* 忽略 */
  }
  let current = ''
  try {
    current = fs.readFileSync(exclPath, 'utf8')
  } catch {
    current = ''
  }
  const have = new Set(current.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  const add = []
  for (const raw of patterns) {
    const line = String(raw || '').trim()
    if (!line || have.has(line)) continue
    have.add(line)
    add.push(line)
  }
  if (add.length === 0) return { ok: true, added: 0 }
  const next = current.endsWith('\n') || current === '' ? current : current + '\n'
  try {
    fs.writeFileSync(exclPath, next + add.join('\n') + '\n', 'utf8')
    return { ok: true, added: add.length }
  } catch (error) {
    log('warn', `写 info/exclude 失败（${gitdir}）：${String(error?.message || error)}`)
    return { ok: false, added: 0 }
  }
}

/** 索引里当前被跟踪的路径集合（`git rm --cached` 之后 HEAD 不变，但索引会变）。 */
export function listIndexed(gitdir, realPath, { timeoutMs = 60000 } = {}) {
  const r = runGit([...mirrorArgs(gitdir, realPath), 'ls-files', '-z'], { timeoutMs })
  if (!r.ok) return new Set()
  return new Set(String(r.out).split('\0').filter(Boolean))
}

/**
 * 让命中排除规则的已跟踪文件「不再跟踪」（`git rm --cached`，工作区文件不动）。
 *
 * 关键：**先自己按规则算出命中路径，再把路径交给 git**。
 * 直接把模式当 pathspec 传给 `git rm` 不靠谱——`_dshmarket-upgrade-*` 这种"带通配的目录名"
 * git 不当作目录 glob（实测漏掉了 180 个文件、4.5 MB）。
 */
export function untrackPatterns(gitdir, realPath, patterns = [], { timeoutMs = 180000 } = {}) {
  const list = (patterns || []).map((s) => String(s || '').trim()).filter(Boolean)
  if (!list.length) return { ok: true, removed: 0, bytes: 0, samples: [] }
  const head = listTracked(gitdir, realPath)
  const sizeOf = new Map(head.files.map((f) => [f.path, f.size]))
  const indexed = listIndexed(gitdir, realPath)
  const targets = [...indexed].filter((p) => matchAny(p, list))
  if (targets.length === 0) return { ok: true, removed: 0, bytes: 0, samples: [] }
  let failed = null
  for (const group of chunk(targets)) {
    const r = runGit([...mirrorArgs(gitdir, realPath), 'rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...group], {
      timeoutMs,
    })
    if (!r.ok) failed = String(r.err || r.code).slice(0, 200)
  }
  const after = listIndexed(gitdir, realPath)
  const removed = targets.filter((p) => !after.has(p))
  return {
    ok: failed === null || removed.length > 0,
    removed: removed.length,
    bytes: removed.reduce((sum, p) => sum + (sizeOf.get(p) || 0), 0),
    samples: removed.slice(0, 8),
    error: failed,
  }
}

/**
 * 把「还没推上去的本地提交」压成一个干净快照（`reset --soft origin/<branch>` + 重新提交）。
 *
 * 为什么值得：实测本机积压了 8 个提交、带着 2101 个文件（含 82 MB 安装包）。
 * 这些提交远端从来没有过，压掉不会影响任何已推送的历史；压完后要传的只剩「当前工作树
 * 相对远端的真正差异」，能少传一个数量级。**只动本地、只动未推送的部分。**
 */
export function slimPendingCommits(gitdir, realPath, branch, { commitMessage = 'dsh-chatsync: slim snapshot', timeoutMs = 180000 } = {}) {
  const before = pendingCount(gitdir, realPath, branch)
  if (before === null) return { ok: false, error: 'no-origin-ref', before: null }
  if (before === 0) return { ok: true, before: 0, after: 0, skipped: 'nothing-pending' }
  const reset = runGit([...mirrorArgs(gitdir, realPath), 'reset', '--soft', `refs/remotes/origin/${branch}`], { timeoutMs })
  if (!reset.ok) return { ok: false, error: String(reset.err || reset.code).slice(0, 200), before }
  const add = runGit([...mirrorArgs(gitdir, realPath), 'add', '-A'], { timeoutMs })
  if (!add.ok) return { ok: false, error: String(add.err || add.code).slice(0, 200), before }
  const st = runGit([...mirrorArgs(gitdir, realPath), 'status', '--porcelain'], { timeoutMs: 60000 })
  const dirty = st.ok && String(st.out).trim().length > 0
  if (dirty) {
    const commit = runGit([...mirrorArgs(gitdir, realPath), 'commit', '-m', `${commitMessage} (${new Date().toISOString()})`], {
      timeoutMs,
    })
    if (!commit.ok) return { ok: false, error: String(commit.err || commit.code).slice(0, 200), before }
  }
  const after = pendingCount(gitdir, realPath, branch)
  return { ok: true, before, after: after ?? null }
}

/** 影子仓库的绝对路径（与 chatsync 的 workspaceGitDir 保持一致）。 */
export function mirrorDirOf(dshHome, id) {
  return path.join(dshHome, 'workspace-repos', id + '.git')
}

/** 分支名（与 chatsync 的 workspaceBranchOf 保持一致）。 */
export function branchOf(cfg, id) {
  return String(cfg?.workspaceBranchPrefix || 'ws') + '/' + id
}

/** 体积格式化。 */
export function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
