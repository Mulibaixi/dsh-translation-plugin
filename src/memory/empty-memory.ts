import type { MemoryPort } from '../shared/contracts.js'

export const emptyMemoryPort: MemoryPort = {
  async prepare(request) {
    return {
      id: `${request.sessionId}:empty:${request.epoch}`,
      epoch: request.epoch,
      items: [],
    }
  },
}
