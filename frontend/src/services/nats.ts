/**
 * bioFlow NATS Service — MIT License
 *
 * Handles WebSocket connection to NATS, JSON-based RPC calls,
 * and pub/sub streaming for chat and notebook events.
 */

import { connect, type NatsConnection, type Subscription, StringCodec, JSONCodec } from 'nats.ws'
import type { ConnectionConfig, NATSMessage, NATSResponse, StreamMessage } from '@/types'

const sc = StringCodec()
const jc = JSONCodec()

export type StreamCallback = (msg: StreamMessage) => void

class NATSService {
  private nc: NatsConnection | null = null
  private config: ConnectionConfig | null = null
  private subscriptions = new Map<string, Subscription>()
  private _connected = false
  private _reconnecting = false

  get connected(): boolean {
    return this._connected
  }

  get reconnecting(): boolean {
    return this._reconnecting
  }

  get serviceSubject(): string {
    if (!this.config) throw new Error('Not configured')
    const base = `pantheon.service.${this.config.serviceId}`
    return this.config.subjectPrefix ? `${this.config.subjectPrefix}.${base}` : base
  }

  streamSubject(streamId: string): string {
    if (!this.config) throw new Error('Not configured')
    const base = `pantheon.stream.${streamId}`
    return this.config.subjectPrefix ? `${this.config.subjectPrefix}.${base}` : base
  }

  async connect(config: ConnectionConfig): Promise<void> {
    this.config = config

    const opts: Record<string, unknown> = {
      servers: config.url,
      pingInterval: 20_000,
      maxPingOut: 3,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      timeout: 10_000,
    }
    if (config.token) {
      opts.user = 'agent'
      opts.pass = config.token
    }

    this.nc = await connect(opts as Parameters<typeof connect>[0])
    this._connected = true
    this._reconnecting = false

    // Monitor connection status
    ;(async () => {
      if (!this.nc) return
      for await (const s of this.nc.status()) {
        switch (s.type) {
          case 'disconnect':
            this._connected = false
            this._reconnecting = true
            break
          case 'reconnect':
            this._connected = true
            this._reconnecting = false
            break
          case 'error':
            console.warn('[NATS] error:', s.data)
            break
        }
      }
    })()
  }

  async disconnect(): Promise<void> {
    for (const sub of this.subscriptions.values()) {
      sub.unsubscribe()
    }
    this.subscriptions.clear()

    if (this.nc) {
      await this.nc.drain()
      this.nc = null
    }
    this._connected = false
    this._reconnecting = false
  }

  /**
   * JSON-based RPC: send a NATSMessage to the chatroom service and get a response.
   */
  async invoke(method: string, parameters: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<unknown> {
    if (!this.nc) throw new Error('Not connected')

    const msg: NATSMessage = {
      method,
      parameters,
      correlation_id: crypto.randomUUID(),
    }

    const payload = sc.encode(JSON.stringify(msg))
    const resp = await this.nc.request(this.serviceSubject, payload, { timeout: timeoutMs })
    const result: NATSResponse = JSON.parse(sc.decode(resp.data))

    if (result.error) {
      throw new Error(result.error)
    }
    return result.result
  }

  /**
   * Subscribe to a stream subject (e.g. chat_<chat_id>) and call the callback for each message.
   */
  subscribe(streamId: string, callback: StreamCallback): string {
    if (!this.nc) throw new Error('Not connected')

    const subject = this.streamSubject(streamId)
    const sub = this.nc.subscribe(subject)
    const subId = `${streamId}_${Date.now()}`
    this.subscriptions.set(subId, sub)

    // Process messages in background
    ;(async () => {
      for await (const msg of sub) {
        try {
          const data = JSON.parse(sc.decode(msg.data)) as StreamMessage
          callback(data)
        } catch (e) {
          console.warn('[NATS] Failed to parse stream message:', e)
        }
      }
    })()

    return subId
  }

  unsubscribe(subId: string): void {
    const sub = this.subscriptions.get(subId)
    if (sub) {
      sub.unsubscribe()
      this.subscriptions.delete(subId)
    }
  }

  /**
   * Convenience: call a toolset method via the chatroom's proxy_toolset.
   */
  async proxyToolset(methodName: string, args: Record<string, unknown> = {}, toolsetName?: string): Promise<unknown> {
    const params: Record<string, unknown> = {
      method_name: methodName,
      args,
    }
    if (toolsetName) params.toolset_name = toolsetName
    return this.invoke('proxy_toolset', params)
  }
}

// Singleton
export const natsService = new NATSService()
