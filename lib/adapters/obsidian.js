/**
 * Obsidian adapter: a vault is a directory, so a note is a `.md` file.
 *
 * This is the one target that needs no network, no token and no running app,
 * which is why it is the reference implementation of the adapter contract.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { safeFileName } from '../render.js'

/** How many `name N.md` suffixes to try before refusing a scribbled-out title. */
const MAX_COLLISION_SUFFIX = 1000

/**
 * Adapters receive the WHOLE plugin config, not one target's slice, so a
 * target can read cross-target settings when it needs to. Keep this the only
 * place that knows the shape.
 */
function cfgOf(config) {
  const target = config?.targets?.obsidian
  return target !== null && typeof target === 'object' ? target : {}
}

/**
 * Every vault Obsidian knows about, newest-registered first. The settings page
 * and the save panel both present this list so the user picks a vault instead
 * of typing a path.
 */
export async function listVaults(env) {
  const appData = process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
  const candidates = [
    join(appData, 'obsidian', 'obsidian.json'),
    join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
    join(homedir(), '.config', 'obsidian', 'obsidian.json'),
  ]
  for (const path of candidates) {
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      env?.logger?.warn?.(`dsh-note-save: 无法解析 ${path}`)
      continue
    }
    const vaults = parsed?.vaults
    if (vaults === null || typeof vaults !== 'object') continue
    return Object.entries(vaults)
      .map(([id, entry]) => ({
        id,
        path: typeof entry?.path === 'string' ? entry.path : '',
        name: typeof entry?.path === 'string' ? entry.path.split(/[\\/]/).filter(Boolean).pop() ?? entry.path : '',
        open: entry?.open === true,
        ts: typeof entry?.ts === 'number' ? entry.ts : 0,
      }))
      .filter((entry) => entry.path !== '')
      .sort((left, right) => right.ts - left.ts)
  }
  return []
}

/**
 * The vault Obsidian records. Used only as a fallback when nothing is
 * configured; the product path is the user choosing a vault explicitly.
 */
async function detectVault(env) {
  const vaults = await listVaults(env)
  const open = vaults.find((entry) => entry.open === true)
  return (open ?? vaults[0])?.path ?? ''
}

/** The configured vault, or the one Obsidian itself has open. */
async function vaultOf(cfg, env) {
  const configured = String(cfg.vault ?? '').trim()
  if (configured !== '') return { vault: configured, detected: false }
  const detected = await detectVault(env)
  return { vault: detected, detected: detected !== '' }
}

export default {
  id: 'obsidian',
  label: 'Obsidian',

  async status(config, env) {
    const cfg = cfgOf(config)
    const { vault, detected } = await vaultOf(cfg, env)
    if (vault === '') {
      return {
        configured: false,
        detail: '未配置 vault 路径，且没有找到 Obsidian 的 vault 列表（打开一次 Obsidian，或手动设置 vault）',
      }
    }
    try {
      const info = await stat(vault)
      if (!info.isDirectory()) return { configured: false, detail: `vault 不是目录：${vault}` }
    } catch {
      return { configured: false, detail: `vault 不存在：${vault}` }
    }
    return { configured: true, detail: detected ? `${vault}（自动发现）` : vault }
  },

  /** Directories under the vault, one level deep, as save locations. */
  async options(config, env) {
    const cfg = cfgOf(config)
    const { vault } = await vaultOf(cfg, env)
    if (vault === '') return { locations: [], note: '未配置 vault 路径' }
    const root = resolve(vault)
    const subdir = String(cfg.subdir ?? '').trim()
    const locations = [{ id: '', label: '（vault 根目录）' }]
    if (subdir !== '') locations.push({ id: subdir, label: subdir })
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return { locations, note: `vault 无法列出：${root}` }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (entry.name === subdir) continue
      locations.push({ id: entry.name, label: entry.name })
    }
    return { locations }
  },

  /** The settings page renders these; keep the keys equal to cfgOf's reads. */
  fields: [
    {
      key: 'vault',
      label: '仓库（vault）',
      type: 'text',
      placeholder: '填写或浏览选择 vault 的绝对路径',
      required: true,
      secret: false,
      // Free typing plus the Host-native folder picker: a vault can live
      // anywhere, so a fixed list of "known vaults" would be a worse answer
      // than a text field with a 浏览… button.
      pick: 'directory',
      help: 'Obsidian 的 vault 就是一个普通文件夹。填它的绝对路径，或点「浏览…」直接选文件夹。',
    },
    {
      key: 'subdir',
      label: '默认子文件夹',
      type: 'text',
      placeholder: '例如 DSH（留空=仓库根目录）',
      required: false,
      secret: false,
      help: '保存时默认落到这个子文件夹；不存在会自动创建。保存面板里还可以临时改。',
    },
  ],

  /** Read-only probe: the vault must exist and be a directory we can list. */
  async test(config, env) {
    const cfg = cfgOf(config)
    const { vault, detected } = await vaultOf(cfg, env)
    if (vault === '') {
      return { ok: false, detail: '没有可用的 vault：请在上面的下拉里选一个，或填写路径。' }
    }
    const root = resolve(vault)
    try {
      const info = await stat(root)
      if (!info.isDirectory()) return { ok: false, detail: `${root} 不是文件夹。` }
    } catch {
      return { ok: false, detail: `找不到文件夹：${root}` }
    }
    let folders = 0
    try {
      const entries = await readdir(root, { withFileTypes: true })
      folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).length
    } catch {
      return { ok: false, detail: `文件夹存在但无法列出内容（权限？）：${root}` }
    }
    const subdir = String(cfg.subdir ?? '').trim()
    if (subdir !== '') {
      try {
        const target = resolve(root, subdir)
        const info = await stat(target)
        if (!info.isDirectory()) return { ok: false, detail: `已连通，但默认子文件夹不是文件夹：${subdir}` }
      } catch {
        return { ok: true, detail: `已连通：${root}（${folders} 个子文件夹）。默认子文件夹 ${subdir} 还不存在，保存时会自动创建。` }
      }
    }
    return {
      ok: true,
      detail: `已连通：${root}（${folders} 个子文件夹）${detected ? '，自动发现' : ''}`,
    }
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config)
    const { vault } = await vaultOf(cfg, env)
    if (vault === '') throw new Error('Obsidian：未配置 vault 路径，且没有找到 Obsidian 的 vault 列表')

    const root = resolve(vault)
    const location = String(opts?.location ?? '').trim()
    // Never escape the vault: resolve and re-check containment.
    const directory = location === '' ? root : resolve(root, location)
    if (directory !== root && !directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      throw new Error(`Obsidian：位置越出 vault：${location}`)
    }

    const base = safeFileName(note.title, 'note')
    await mkdir(directory, { recursive: true })

    const frontmatter = cfg.frontmatter === false
      ? ''
      : [
          '---',
          `title: ${JSON.stringify(String(note.title ?? ''))}`,
          `created: ${new Date().toISOString()}`,
          'source: deepseek-harness',
          '---',
          '',
        ].join('\n')
    const body = `${frontmatter}${note.markdown ?? ''}\n`

    // Collision policy: create the first free `name.md`, `name 2.md`, …
    // Every attempt is an EXCLUSIVE create (`wx` → O_CREAT|O_EXCL), so two
    // saves racing for the same title cannot both think the name is free: the
    // loser gets EEXIST and moves to the next suffix. A check-then-write pair
    // would leave a window where both saves overwrite each other.
    for (let index = 1; index <= MAX_COLLISION_SUFFIX; index += 1) {
      const target = join(directory, index === 1 ? `${base}.md` : `${base} ${index}.md`)
      try {
        await writeFile(target, body, { encoding: 'utf8', flag: 'wx' })
        return { ref: target, url: null, created: true }
      } catch (error) {
        if (error?.code === 'EEXIST') continue
        throw new Error(`Obsidian：写入 ${target} 失败（${error?.code ?? error?.message ?? '未知错误'}）`)
      }
    }
    throw new Error(`Obsidian：同名文件已经超过 ${MAX_COLLISION_SUFFIX} 个，拒绝继续追加：${base}.md`)
  },
}

/**
 * Direct subfolders of `subPath` inside `vaultPath`, for the folder picker.
 * Refuses to leave the vault, so a crafted path cannot browse the disk.
 */
export async function listFolders(vaultPath, subPath, env) {
  const root = resolve(String(vaultPath ?? '').trim())
  if (String(vaultPath ?? '').trim() === '') throw new Error('缺少 vault 路径')
  const relative = String(subPath ?? '').trim().replace(/^[\\/]+/, '')
  const directory = relative === '' ? root : resolve(root, relative)
  if (directory !== root && !directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new Error(`路径越出 vault：${subPath}`)
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`无法列出文件夹：${directory}（${error?.code ?? error?.message ?? '未知错误'}）`)
  }
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({
      name: entry.name,
      path: relative === '' ? entry.name : `${relative.replace(/\\/g, '/')}/${entry.name}`,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh'))
  return { path: relative.replace(/\\/g, '/'), folders }
}
