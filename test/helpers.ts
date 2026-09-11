import type { Storage, Transaction } from '../src/ledger.ts'
export function memoryStorage(): Storage {
  const data = new Map<string, unknown>()
  let pending = Promise.resolve()
  const tx: Transaction = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key, value) => { data.set(key, structuredClone(value)) },
    delete: async key => { data.delete(key) },
  }
  return { ...tx, transaction: callback => {
    const result = pending.then(() => callback(tx))
    pending = result.then(() => {}, () => {})
    return result
  } }
}
export const query = { recipient: 'PALANTIR USG INC', recipient_uei: 'HNN4F9JZWDY8', start_date: '2024-01-01', end_date: '2026-09-11', award_types: 'contracts', limit: 10, page: 1 }
export const row = { 'Award ID': '123', 'Recipient Name': query.recipient, 'Recipient UEI': query.recipient_uei, 'Award Amount': 100, 'Start Date': '2024-01-01', 'End Date': '2027-01-01', 'Awarding Agency': 'Department of Defense', 'Awarding Sub Agency': 'Army', 'Award Type': null, Description: 'Example', generated_internal_id: 'CONT_AWD_123' }
export const config = { PUBLIC_BASE_URL: 'https://api.example.com', MPP_SECRET_KEY: 'testing-only-secret-with-more-than-32-bytes', MPP_RECIPIENT: '0x22e4490BF0393E0160F98733B1273Df3e61256e6', MPP_CURRENCY: '0x20c0000000000000000000000000000000000000', TEMPO_TESTNET: 'true', X402_ENABLED: 'false' }
