declare module 'cloudflare:workers' {
  export const env: Record<string, string>
}

interface CloudflareBindings {
  PUBLIC_BASE_URL: string
  MPP_RECIPIENT: string
  MPP_CURRENCY: string
  TEMPO_TESTNET: string
  MPP_SECRET_KEY: string
}
