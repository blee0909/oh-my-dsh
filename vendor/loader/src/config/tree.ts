import { composeError, Context } from '@deepseek-ai/cordis'
import { isNonNullable, type Dict } from '@deepseek-ai/cosmokit'
import { Entry, type EntryOptions, type EntryFailurePredicate } from './entry.ts'
import { EntryGroup } from './group.ts'

/** Mutable tree of loader entries. Persistence is supplied by subclasses. */
export abstract class EntryTree {
  static readonly sep = ':'

  public ctx: Context
  public enableLogs?: boolean
  public tolerateEntryFailures?: boolean | EntryFailurePredicate
  public root: EntryGroup
  public store: Dict<Entry> = Object.create(null)

  constructor(ctx: Context) {
    this.ctx = ctx.extend({ baseUrl: ctx.baseUrl })
    this.root = new EntryGroup(this.ctx, this)
    const entry = this.ctx.fiber.entry
    if (entry) entry.subtree = this
  }

  get context(): Context {
    return this.ctx
  }

  /** Iterate entries in this tree and any nested subtrees. */
  * entries(): Generator<Entry, void, void> {
    for (const entry of Object.values(this.store)) {
      yield entry
      if (!entry.subtree) continue
      yield* entry.subtree.entries()
    }
  }

  /** Return pending import and lifecycle tasks owned by this tree. */
  getTasks() {
    return [...this.entries()]
      .map(entry => entry._initTask || entry.fiber?.inertia)
      .filter(isNonNullable)
  }

  /**
   * Wait until this tree has no active import or lifecycle tasks.
   * @throws a settled fiber failure, or an aggregate when several fibers failed.
   */
  async await() {
    while (true) {
      const tasks = this.getTasks()
      if (tasks.length) {
        await Promise.allSettled(tasks)
        continue
      }
      const entries = [...this.entries()]
      const outcomes = await Promise.allSettled(
        entries.map(entry => entry._await()),
      )
      const rejected: { entry: Entry; reason: unknown }[] = []
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]!
        if (outcome.status === 'rejected') {
          rejected.push({ entry: entries[i]!, reason: outcome.reason })
        }
      }
      const policy = this.tolerateEntryFailures
      const fatalFailures: unknown[] = []
      for (const { entry, reason } of rejected) {
        const entryPolicy = entry.parent?.effectiveTolerateEntryFailures || policy
        const isTolerated = typeof entryPolicy === 'function' ? entryPolicy(entry.options, reason) : Boolean(entryPolicy)
        if (entryPolicy && isTolerated) {
          this.ctx.emit('loader/entry-failed', entry.options, reason)
          if (this.enableLogs) {
            this.ctx.logger?.warn?.(`[loader] tolerated entry await failure for ${entry.options.id} (${entry.options.name}):`, reason)
          }
        } else {
          fatalFailures.push(reason)
        }
      }
      if (fatalFailures.length === 1) throw fatalFailures[0]
      if (fatalFailures.length > 1) throw new AggregateError(fatalFailures, 'loader fibers failed')
      this.ctx.reflect.notify(['loader'])
      if (!this.getTasks().length) return
    }
  }

  ensureId(options: Partial<EntryOptions>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(16).slice(2, 10)
      } while (this.store[options.id])
    }
    return options.id!
  }

  /** Resolve an entry by id, including nested ids separated by `EntryTree.sep`. */
  resolve(id: string) {
    const parts = id.split(EntryTree.sep)
    let tree: EntryTree | undefined = this
    const final = parts.pop()!
    for (const part of parts) {
      tree = tree.store[part]?.subtree
      if (!tree) throw new Error(`cannot resolve entry ${id}`)
    }
    const entry = tree.store[final]
    if (!entry) throw new Error(`cannot resolve entry ${id}`)
    return entry
  }

  resolveGroup(id: string | null) {
    if (!id) return this.root
    const entry = this.resolve(id)
    if (!entry.subgroup) throw new Error(`entry ${id} is not a group`)
    return entry.subgroup
  }

  /** Create an entry in the root group or a nested group. */
  async create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    const id = await group.create(options)
    const entry = this.resolve(id)
    group.data.splice(position, 0, entry.options)
    group.tree.write()
    return id
  }

  /** Stop and remove an entry from its parent group. */
  async remove(id: string) {
    const entry = this.resolve(id)
    await entry.parent.remove(id)
    entry.parent.tree.write()
  }

  /** Update an entry and optionally move it to another group. */
  async update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.resolve(id)
    const source = entry.parent
    const sourceIndex = source.data.indexOf(entry.options)
    let target = source
    if (parent !== undefined) {
      target = this.resolveGroup(parent)
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      entry.parent = target
    }
    try {
      await entry.update(options, false, true)
    } catch (error) {
      if (parent !== undefined) {
        target.unlink(entry.options)
        source.data.splice(sourceIndex < 0 ? source.data.length : sourceIndex, 0, entry.options)
        entry.parent = source
        try {
          await entry.update({}, false, true)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back loader entry move ${id}`)
        }
      }
      throw error
    }
    source.tree.write()
    if (target !== source) target.tree.write()
  }

  /** Import a plugin module from a specifier or `cordis:` builtin. */
  import(name: string, getOuterStack?: () => string[]) {
    if (name.startsWith('cordis:')) {
      return this.ctx.loader.builtins[name.slice(7)]
    }
    return composeError(async (info) => {
      // ModuleJob.run
      // onImport.tracePromise.__proto__
      // internal.import
      info.offset += 3
      if (this.ctx.loader.internal) {
        return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
      } else if (name.startsWith('.')) {
        return await import(/* @vite-ignore */new URL(name, this.ctx.baseUrl).href)
      } else {
        return await import(/* @vite-ignore */name)
      }
    }, getOuterStack)
  }

  /** Persist current tree state. In-memory trees may implement this as a no-op. */
  abstract write(): void
}
