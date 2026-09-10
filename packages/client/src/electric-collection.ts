import { ShapeStream } from "@electric-sql/client"

export interface ElectricCollectionConfig {
  electricUrl: string
  table: string
  key: string
  where?: string
}

export function electricCollectionOptions(config: ElectricCollectionConfig) {
  return {
    getKey: (item: any) => item[config.key],

    sync: (params: {
      collection: any
      begin: (options?: { immediate?: boolean }) => void
      write: (message: any) => void
      commit: () => void
      markReady: () => void
      truncate: () => void
    }) => {
      const { begin, write, commit, markReady, truncate } = params
      let stream: ShapeStream | null = null
      let destroyed = false

      function createStream() {
        if (destroyed) return

        stream = new ShapeStream({
          url: `${config.electricUrl}/v1/shape`,
          params: {
            table: config.table,
            ...(config.where ? { where: config.where } : {}),
          },
          onError: (error: any) => {
            const msg = String(error?.message ?? error)
            const is409 = error?.status === 409 || msg.includes("409")
            if (is409) {
              console.warn(`[electric] 409 for ${config.table}, resetting shape`)
              stream?.unsubscribeAll()
              truncate()
              // Recreate with a fresh stream after a short delay
              setTimeout(createStream, 500)
              return
            }
            // Rethrow non-409 errors
            throw error
          },
        })

        stream.subscribe((messages: any[]) => {
          if (messages.length === 0) return
          begin()
          for (const msg of messages) {
            if (msg.headers?.operation === "insert" || msg.headers?.operation === "update") {
              write({ type: msg.headers.operation, value: msg.value })
            } else if (msg.headers?.operation === "delete") {
              write({ type: "delete", key: msg.value?.[config.key] })
            }
          }
          commit()

          const upToDate = messages.some((m: any) => m.headers?.control === "up-to-date")
          if (upToDate) {
            markReady()
          }
        })
      }

      createStream()

      return () => {
        destroyed = true
        stream?.unsubscribeAll()
        stream = null
      }
    },
  }
}
