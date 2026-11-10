/**
 * Adapter registry.
 *
 * Each adapter owns one target system and satisfies the contract in SPEC.md.
 * This module only resolves a target id to an adapter and hands it the small
 * environment every adapter is allowed to use.
 */

import obsidian from './obsidian.js'
import ima from './ima.js'
import joplin from './joplin.js'
import notion from './notion.js'
import siyuan from './siyuan.js'
import yuque from './yuque.js'

const ADAPTERS = new Map(
  [obsidian, siyuan, joplin, notion, yuque, ima].map((adapter) => [adapter.id, adapter]),
)

export const TARGET_ORDER = ['obsidian', 'siyuan', 'joplin', 'notion', 'yuque', 'ima']

export function listAdapters() {
  return TARGET_ORDER.map((id) => ADAPTERS.get(id)).filter(Boolean)
}

export function adapterOf(id) {
  const adapter = ADAPTERS.get(id)
  if (adapter === undefined) throw new Error(`未知目标系统：${String(id)}`)
  return adapter
}

export function makeEnv(logger = console) {
  return { fetch: (...args) => globalThis.fetch(...args), logger }
}
