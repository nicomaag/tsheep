/** One place everything in main publishes to; the window and the MCP read from it. */
import { EventEmitter } from 'node:events'
import type { AppEvent } from '@shared/types'

class Bus extends EventEmitter {
  publish(event: AppEvent): void {
    this.emit('event', event)
  }
  onEvent(listener: (event: AppEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }
}

export const bus = new Bus()
bus.setMaxListeners(50)
