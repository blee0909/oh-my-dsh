/** Client Session object layer, Agent scopes, and Remote lifecycle wiring. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import { typertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionControlStream, type SessionControlStream } from './transport.ts'
import { ClientSessions } from './sessions/service.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import type {} from '../remote-events.ts'

export {
  createSessionControlStream,
  SessionEventStream,
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './transport.ts'
export type {
  ClientSessionPageRequest,
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from './transport.ts'
export { createScope, scopeOf } from './scope.ts'
export type { AgentContext, AgentScopeHandle } from './scope.ts'
export { SessionCreateError, SessionForkError } from './sessions/service.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
export type {
  SessionListPhase,
  SessionListSnapshot,
  SessionSearchResultItem,
  SessionProjectionSnapshot,
} from './sessions/manager.ts'
export type { Session } from './sessions/session.ts'
export type {
  ProjectionsBaseline,
  ProjectionValueStore,
  SessionProjectionMap,
  UseProjection,
} from './sessions/projection-store.ts'
export type {
  BeginSubmissionInput,
  ISession,
  PendingSubmissionRetirement,
  ProjectionsFace,
  SessionFace,
  SubmissionHandle,
} from './contract/session.ts'
export type {
  ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from './contract/sessions.ts'
export { MutableSessionEventSource } from './contract/events.ts'
export type {
  AssistantLiveChunkEvent,
  SessionAssistantSettlementEntry,
  SessionEventChange,
  SessionEventLike,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from './contract/events.ts'
export type {
  OpenState,
  PendingSubmission,
  PendingSubmissionAttachment,
  PendingSubmissionFileAttachment,
  PendingSubmissionImage,
  PendingSubmissionImageAttachment,
  PendingSubmissionPlacement,
  PromptError,
  SessionSnapshot,
} from './contract/snapshot.ts'

/** Consumer-owned reference labels; extend this map through the package's canonical /client entry. */
export interface SessionReferenceSourceMap {
  /** Temporary Client Controller work, including fork-title preparation. */
  controllerOperation: unknown
  /** A Client Gateway invocation's synchronous Context ownership. */
  gateway: unknown
}

/** Declaration-merge-extensible labels carried by independent Client references. */
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client Session object layer and Agent scope owner. */
    sessions: import('./contract/sessions.ts').ISessions
  }
}

/** Required Remote and Context projection services. */
export const inject = [
  'connection',
  'fileUpload',
  'typert',
  'remote',
  'remote.commands',
  'remote.session',
  'remote.subagents',
]

/**
 * Install Client Session state and its reconnecting control stream.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const remotes = ctx.remote as unknown as SessionRemotes
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = new ClientSessions(ctx, remotes)
  ctx.remote.$on('api-session/added', (summary) => { sessions.handleSessionAdded(summary) })
  ctx.remote.$on('api-session/removed', (sessionId) => { sessions.handleSessionRemoved(sessionId) })
  ctx.remote.$on('api-session/status', (sessionId, running) => {
    sessions.handleSessionStatus(sessionId, running)
  })
  ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
    sessions.handleSessionActivity(sessionId, updatedAt)
  })
  ctx.remote.$on('api-session/error', (sessionId, message) => {
    sessions.handleSessionError(sessionId, message)
  })

  let control: SessionControlStream | undefined
  let controlDisposed = false
  let controlDead = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const startControl = (): void => {
    if (controlDisposed) return
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    if (control !== undefined && !controlDead) {
      control.restart()
      control.start()
      return
    }
    if (control !== undefined) {
      void control.dispose()
    }
    controlDead = false
    control = createSessionControlStream(remotes, {
      accept: (frame) => { sessions.handleControlFrame(frame) },
      failed: (error) => {
        controlDead = true
        console.error('[session-controller] control stream failed:', error)
        void sessions.refresh()
        if (!controlDisposed && connection.generation.getSnapshot() !== undefined) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (!controlDisposed && controlDead && connection.generation.getSnapshot() !== undefined) {
              startControl()
            }
          }, 1000)
        }
      },
    })
    control.start()
  }

  const connected = (): void => {
    if (connection.generation.getSnapshot() === undefined) return
    // A ready control baseline may arrive before Cordis delivers connection/reset.
    sessions.handleConnected()
    startControl()
  }
  ctx.effect(() => connection.generation.subscribe(connected), 'session-controller.client.generation')
  connected()
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.sessionOf(candidate)?.sessionId,
    resolve: (sessionId) => {
      const reference = sessions.retainAgentScope(sessionId)
      return typertOwnedValue(reference.binding.ctx, () => { reference.release() })
    },
  })
  ctx.effect(() => async () => {
    controlDisposed = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    await control?.dispose()
  }, 'session-controller.client.control')

  if (typeof document !== 'undefined') {
    const onVisibilityChange = (): void => {
      if (!document.hidden && connection.generation.getSnapshot() !== undefined) {
        void sessions.refresh()
        if (controlDead) startControl()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    ctx.effect(() => () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }, 'session-controller.client.visibility')
  }

  if (typeof window !== 'undefined') {
    const onFocus = (): void => {
      if (connection.generation.getSnapshot() !== undefined) {
        void sessions.refresh()
        if (controlDead) startControl()
      }
    }
    window.addEventListener('focus', onFocus)
    ctx.effect(() => () => {
      window.removeEventListener('focus', onFocus)
    }, 'session-controller.client.focus')
  }
}
