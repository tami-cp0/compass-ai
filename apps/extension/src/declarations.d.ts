declare module "*.css" {
  const content: Record<string, string>
  export default content
}

// Plasmo inlines PLASMO_PUBLIC_* env vars at build time via static substitution.
// Plasmo generates .plasmo/process.env.d.ts on first dev/build, but declare here
// so types resolve even before that file exists.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly PLASMO_PUBLIC_WS_URL?: string
    readonly PLASMO_PUBLIC_HOST_MATCH?: string
    readonly NODE_ENV?: "development" | "production"
  }
}
declare const process: { env: NodeJS.ProcessEnv }