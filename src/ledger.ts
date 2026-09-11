import { ApiError } from './fedspend.ts'
import type { Entry, Ledger } from './gateway.ts'
export type Transaction = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void>; delete(key: string): Promise<unknown> }
export type Storage = Transaction & { transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> }
export function createLedger(storage: Storage, now = () => Date.now()): Ledger {
  return {
    get: key => storage.get<Entry>(`request:${key}`),
    claim: (key, fingerprint, proof) => storage.transaction(async tx => {
      const existing = await tx.get<Entry>(`request:${key}`)
      if (existing && (existing.fingerprint !== fingerprint || existing.proof !== proof || existing.state === 'settling' || existing.state === 'complete' || existing.lease_until > now())) return { acquired: false, entry: existing }
      const entry: Entry = { ...(existing ?? { fingerprint, proof, state: 'preparing', created_at: new Date(now()).toISOString() }), owner: crypto.randomUUID(), lease_until: now() + 60000 }
      await tx.put(`request:${key}`, entry)
      return { acquired: true, entry }
    }),
    put: (key, owner, entry) => storage.transaction(async tx => {
      const existing = await tx.get<Entry>(`request:${key}`)
      if (!existing || existing.owner !== owner) throw new ApiError(409, 'Request lease was replaced; retry the original proof')
      await tx.put(`request:${key}`, entry)
    }),
    delete: (key, owner) => storage.transaction(async tx => {
      const existing = await tx.get<Entry>(`request:${key}`)
      if (existing?.owner === owner && existing.state !== 'settling' && existing.state !== 'complete') await tx.delete(`request:${key}`)
    }),
  }
}
