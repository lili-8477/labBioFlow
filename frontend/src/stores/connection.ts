import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { natsService } from '@/services/nats'
import type { ConnectionConfig } from '@/types'

export const useConnectionStore = defineStore('connection', () => {
  const url = ref('')
  const serviceId = ref('')
  const subjectPrefix = ref('')
  const token = ref('')
  const connected = ref(false)
  const connecting = ref(false)
  const error = ref('')
  const endpointServiceId = ref('')

  // Read config from URL query params on first load
  function loadFromUrl() {
    const params = new URLSearchParams(window.location.search)
    if (params.get('nats')) url.value = params.get('nats')!
    if (params.get('service')) serviceId.value = params.get('service')!
    if (params.get('prefix')) subjectPrefix.value = params.get('prefix')!
    if (params.get('token')) token.value = params.get('token')!
  }

  // Also load from localStorage
  function loadFromStorage() {
    const saved = localStorage.getItem('pantheon-connection')
    if (saved) {
      try {
        const cfg = JSON.parse(saved)
        if (!url.value && cfg.url) url.value = cfg.url
        if (!serviceId.value && cfg.serviceId) serviceId.value = cfg.serviceId
        if (!subjectPrefix.value && cfg.subjectPrefix) subjectPrefix.value = cfg.subjectPrefix
        if (!token.value && cfg.token) token.value = cfg.token
      } catch { /* ignore */ }
    }
  }

  function saveToStorage() {
    localStorage.setItem('pantheon-connection', JSON.stringify({
      url: url.value,
      serviceId: serviceId.value,
      subjectPrefix: subjectPrefix.value,
      token: token.value,
    }))
  }

  async function connect() {
    if (!url.value || !serviceId.value) {
      error.value = 'URL and Service ID are required'
      return
    }
    connecting.value = true
    error.value = ''
    try {
      const config: ConnectionConfig = {
        url: url.value,
        serviceId: serviceId.value,
        subjectPrefix: subjectPrefix.value || undefined,
        token: token.value || undefined,
      }
      await natsService.connect(config)
      connected.value = true
      saveToStorage()

      // Fetch endpoint info
      try {
        const ep = await natsService.invoke('get_endpoint') as Record<string, unknown>
        if (ep?.service_id) endpointServiceId.value = ep.service_id as string
      } catch { /* not critical */ }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      connected.value = false
    } finally {
      connecting.value = false
    }
  }

  async function disconnect() {
    await natsService.disconnect()
    connected.value = false
    endpointServiceId.value = ''
  }

  return {
    url, serviceId, subjectPrefix, token,
    connected, connecting, error, endpointServiceId,
    loadFromUrl, loadFromStorage, connect, disconnect,
  }
})
