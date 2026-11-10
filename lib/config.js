/**
 * Plugin configuration: a single JSON file under the DSH home directory.
 *
 * Secrets live here rather than in the profile's cordis.patch.yml because that
 * file is the user's, is often synced, and is edited by hand. The file is
 * created with 0600 and rewritten atomically.
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const TARGET_IDS = ['obsidian', 'siyuan', 'joplin', 'notion', 'yuque', 'ima']

const DEFAULT_CONFIG = {
  version: 1,
  defaultTarget: 'obsidian',
  targets: {
    // No preset folder: the user picks the vault and the folder themselves.
    obsidian: { vault: '', subdir: '', frontmatter: true },
    siyuan: { baseUrl: 'http://127.0.0.1:6806', token: '', notebook: '' },
    joplin: { baseUrl: 'http://127.0.0.1:41184', token: '', folder: '' },
    notion: { token: '', databaseId: '', titleProperty: 'Name' },
    yuque: { token: '', repoId: '', login: '', repoSlug: '' },
    // ima has a real OpenAPI for note creation; credentials come from
    // https://ima.qq.com/agent-interface. See lib/adapters/ima.js.
    ima: { clientId: '', apiKey: '', notebook: '' },
  },
}

/** `~/.dsh/note-save.json`, or `$DSH_HOME/note-save.json` when that is set. */
export function configPath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'note-save.json')
}

function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = base[key]
    out[key] = current !== null && typeof current === 'object' && !Array.isArray(current)
      ? merge(current, value)
      : value
  }
  return out
}

/** Read the merged configuration: defaults <- file <- the plugin row's config. */
export async function readConfig(rowConfig) {
  const path = configPath()
  let fromFile = {}
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') fromFile = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`${path} 无法读取：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ...merge(merge(DEFAULT_CONFIG, fromFile), rowConfig ?? {}), configPath: path }
}

/** Merge-write one target's settings; leaves every other key untouched. */
export async function writeTargetConfig(target, patch) {
  if (!TARGET_IDS.includes(target)) throw new Error(`未知目标：${target}`)
  const path = configPath()
  let current = {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') current = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const next = merge(current, { targets: { [target]: patch ?? {} } })
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => {})
  return next
}
