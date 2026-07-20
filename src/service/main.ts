#!/usr/bin/env node
import { loadConfig } from './config.js'
import { createService } from './runner.js'

/**
 * The service entry point.
 *
 * Shutdown is graceful and bounded: SIGINT/SIGTERM stop the loops, close the
 * HTTP server and close SQLite. A second signal, or a shutdown that overruns
 * the grace period, exits immediately, because a container that ignores
 * SIGTERM gets SIGKILLed anyway and losing the clean close is worse than
 * exiting a few seconds early.
 */

const GRACE_MS = 15_000

async function main(): Promise<void> {
  const config = loadConfig()
  const service = createService({ config })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      service.logger.warn('second signal received, exiting now', { signal })
      process.exit(1)
    }
    shuttingDown = true
    service.logger.info('shutdown signal received', { signal })
    const timer = setTimeout(() => {
      service.logger.error('graceful shutdown timed out, exiting', { graceMs: GRACE_MS })
      process.exit(1)
    }, GRACE_MS)
    timer.unref()
    service
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        service.logger.error('shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        process.exit(1)
      })
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    service.logger.error('unhandled rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    })
  })
  process.on('uncaughtException', (error: Error) => {
    service.logger.error('uncaught exception, shutting down', { error })
    shutdown('uncaughtException')
  })

  await service.start()
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ level: 'error', message: `hood-alerts failed to start: ${message}` }))
  process.exit(1)
})
