/**
 * The deployable hosted service: durable SQLite state, a restart-safe block
 * cursor, an outbox with retries, health and metrics endpoints, structured
 * logging and graceful shutdown.
 *
 * @packageDocumentation
 */

export { loadConfig } from './config.js'
export type { ServiceConfig } from './config.js'

export { AlertStore } from './store.js'
export type { OutboxRow, OutboxStatus, StoreMetrics } from './store.js'

export { createDispatcher } from './dispatcher.js'
export type { Dispatcher, DispatcherOptions, FlushStats, PollStats } from './dispatcher.js'

export { createHttpServer, renderMetrics } from './http.js'
export type { HealthState, HttpServerOptions } from './http.js'

export { createLogger, createSilentLogger, LEVELS } from './logger.js'
export type { Logger, LoggerOptions, LogFields, LogLevel } from './logger.js'

export { createService, VERSION } from './runner.js'
export type { AlertService, CreateServiceOptions } from './runner.js'

export { decode, decodeEvent, encode, encodeEvent } from './codec.js'
