import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions, type EntryFailurePredicate } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []
  public tolerateEntryFailures?: boolean | EntryFailurePredicate

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  get effectiveTolerateEntryFailures(): boolean | EntryFailurePredicate {
    return this.tolerateEntryFailures ?? this.tree.tolerateEntryFailures ?? false
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const entry: Entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry) return
    entry.fiber?.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    if (this.ctx.fiber.uid === null) return
    const oldConfig = this.data as EntryOptions[]
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))

    const policy = this.effectiveTolerateEntryFailures
    const isTolerated = (options: EntryOptions, error: unknown): boolean => {
      if (typeof policy === 'function') return policy(options, error)
      return Boolean(policy)
    }

    const createdIds: string[] = []
    const fatalFailures: unknown[] = []

    // update inner plugins
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    for (const id of ids) {
      if (this.ctx.fiber.uid === null) return
      if (newMap[id]) {
        const options = newMap[id]
        try {
          await this.create(options)
          createdIds.push(options.id ?? String(id))
        } catch (error) {
          if (this.ctx.fiber.uid === null) return
          if (policy && isTolerated(options, error)) {
            this.context.emit('loader/entry-failed', options, error)
            this.ctx.logger.error(error)
          } else {
            fatalFailures.push(error)
          }
        }
      } else {
        this.remove(id)
      }
    }

    if (this.ctx.fiber.uid === null) return

    if (fatalFailures.length > 0) {
      for (const id of createdIds.reverse()) {
        if (!oldMap[id]) {
          try { this.remove(id, true) } catch {}
        }
      }
      for (const options of oldConfig) {
        try { await this.create(options) } catch {}
      }
      this.data = oldConfig
      if (fatalFailures.length === 1) throw fatalFailures[0]
      throw new AggregateError(fatalFailures, 'loader entries failed to apply')
    }

    this.data = config
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', (config) => {
      this.update(config)
    })
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
