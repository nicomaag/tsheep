/**
 * Commands waiting for a person.
 *
 * Silence never means yes: a timeout, a closed window, a client that hangs up
 * all end as refused. Each pending command has one slot here; the renderer
 * answers it by entry id, and anything that arrives after the slot is gone is
 * ignored rather than applied to whatever is asked next.
 */
import type { ApprovalAnswer } from '@shared/types'

type Slot = { settle: (answer: ApprovalAnswer) => void; timer: NodeJS.Timeout }

const pending = new Map<string, Slot>()

export function askApproval(entryId: string, timeoutMs: number): Promise<ApprovalAnswer> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(entryId)
      resolve({ allow: false, reason: 'Nobody answered in time; the command was not run.' })
    }, timeoutMs)
    pending.set(entryId, {
      timer,
      settle: (answer) => {
        clearTimeout(timer)
        pending.delete(entryId)
        resolve(answer)
      },
    })
  })
}

/** Returns whether anything was still waiting on this entry. */
export function answerApproval(entryId: string, answer: ApprovalAnswer): boolean {
  const slot = pending.get(entryId)
  if (!slot) return false
  slot.settle(answer)
  return true
}

export function refuseAll(reason: string): void {
  for (const slot of pending.values()) slot.settle({ allow: false, reason })
}
