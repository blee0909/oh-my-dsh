import { Context, Service } from '@deepseek-ai/cordis'
import { isNullable } from '@deepseek-ai/cosmokit'
import { Entry, type EntryOptions, type EntryFailurePredicate } from './entry.ts'
import { EntryTree } from './tree.ts'
import { EntryValidationError, formatIssues, formatLocation, relocate, validateOptions, type Issue } from './utils.ts'

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

  get effectiveTolerateEntryFailures(): boolean | EntryFailurePredicate | undefined {
    return this.tolerateEntryFailures ?? this.tree.tolerateEntryFailures
  }

  /**
   * Create or replace the entry for `options`. Invalid options reject with `EntryValidationError` and dispose any entry already registered under their id.
   * @returns The full entry id.
   */
  async create(options: Omit<EntryOptions, 'id'>) {
    const issues = validateOptions(options, EntryTree.sep)
    if (issues.length) throw this._reject(options as EntryOptions, issues)
    const id = this.tree.ensureId(options)
    const entry: Entry = this.tree.store[id] ??= new Entry(this.ctx.loader)
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    await entry.update(options, true, true)
    return entry.id
  }

  /**
   * Stack frames for an entry of this group, followed by those of the owning entries.
   * @param id - Tree-local entry id.
   * @returns Frames that point at the entries' source positions.
   */
  getOuterStack(id: string): string[] {
    const location = this.tree.getLocation(id, [])
    const frames = location ? [`    at ${id} (${formatLocation(location)})`] : []
    return [...frames, ...this.ctx.fiber.entry?.getOuterStack() ?? []]
  }

  private _reject(options: EntryOptions, issues: Issue[]) {
    const error = new EntryValidationError(issues)
    const id = options?.id
    if (isNullable(id)) return error
    // unregistered first, so the disposal is not taken for a self-dispose
    const entry = this.tree.store[id]
    if (entry) {
      delete this.tree.store[id]
      entry.fiber?.dispose()
      this.context.emit('loader/partial-dispose', entry, entry.options, false)
    }
    const frames = this.getOuterStack(id)
    if (!frames.length) return error
    const locate = (path: PropertyKey[]) => this.tree.getLocation(id, path)
    relocate(error, formatIssues('invalid entry options', issues, locate), frames)
    return error
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry || entry.parent !== this) return
    // Unregister before disposal so Loader can distinguish removal from self-disposal.
    delete this.tree.store[id]
    entry.fiber?.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    if (this.ctx.fiber.uid === null) return
    const oldConfig = this.data as EntryOptions[]
    const oldMap = Object.fromEntries(oldConfig.map(options => [options?.id, options]))
    // non-objects are rejected by `create`
    const newMap = Object.fromEntries(config.map(options => [options?.id ?? Symbol('anonymous'), options]))

    const policy = this.effectiveTolerateEntryFailures
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]

    if (policy === undefined) {
      this.data = config
      await Promise.all(ids.map(async (id) => {
        if (newMap[id]) {
          await this.create(newMap[id]).catch((error) => {
            this.ctx.logger.error(error)
          })
        } else {
          this.remove(id)
        }
      }))
      return
    }

    const isTolerated = (options: EntryOptions, error: unknown): boolean => {
      if (typeof policy === 'function') return policy(options, error)
      return Boolean(policy)
    }

    const createdIds: string[] = []
    const fatalFailures: unknown[] = []

    for (const id of ids) {
      if (this.ctx.fiber.uid === null) return
      if (newMap[id]) {
        const options = newMap[id]
        try {
          await this.create(options)
          createdIds.push(options.id ?? String(id))
        } catch (error) {
          if (this.ctx.fiber.uid === null) return
          if (isTolerated(options, error)) {
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
    ctx.on('internal/update', config => this.update(config))
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
