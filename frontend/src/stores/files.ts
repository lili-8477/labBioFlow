import { defineStore } from 'pinia'
import { ref } from 'vue'
import { natsService } from '@/services/nats'
import type { FileEntry } from '@/types'

export const useFileStore = defineStore('files', () => {
  const tree = ref<FileEntry[]>([])
  const loading = ref(false)
  const openFile = ref<{
    path: string
    content: string
    language: string
    encoding: 'utf8' | 'base64'
    mimeType: string
    size?: number
  } | null>(null)

  async function loadTree(subDir?: string) {
    loading.value = true
    try {
      const result = await natsService.proxyToolset('list_files', {
        sub_dir: subDir || null,
        recursive: false,
      }, 'file_manager') as { success: boolean; files: Array<{ name: string; type: string; size?: number }> }

      if (result?.success && Array.isArray(result.files)) {
        const entries: FileEntry[] = result.files
          .filter(f => f.name !== '.executor')
          .map(f => ({
            name: f.name,
            path: subDir ? `${subDir}/${f.name}` : f.name,
            type: (f.type === 'directory' ? 'directory' : 'file') as 'file' | 'directory',
            size: f.size,
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        if (!subDir) {
          tree.value = entries
        }
        return entries
      }
    } catch (e) {
      console.error('Failed to load file tree:', e)
    } finally {
      loading.value = false
    }
    return []
  }

  async function readFile(filePath: string) {
    try {
      const result = await natsService.proxyToolset('read_file', {
        file_path: filePath,
      }, 'file_manager') as {
        success: boolean; content: string;
        encoding?: 'utf8' | 'base64'; mime_type?: string; size?: number
      }
      if (result?.success !== false) {
        const ext = filePath.split('.').pop()?.toLowerCase() || ''
        const langMap: Record<string, string> = {
          py: 'python', js: 'javascript', ts: 'typescript',
          json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml',
          html: 'html', css: 'css', sh: 'shell', r: 'r',
          ipynb: 'json', csv: 'plaintext', txt: 'plaintext',
        }
        openFile.value = {
          path: filePath,
          content: typeof result === 'string' ? result : (result?.content || ''),
          language: langMap[ext] || 'plaintext',
          encoding: result.encoding ?? 'utf8',
          mimeType: result.mime_type ?? 'text/plain',
          size: result.size,
        }
        return openFile.value
      }
    } catch (e) {
      console.error('Failed to read file:', e)
    }
    return null
  }

  async function writeFile(filePath: string, content: string) {
    return await natsService.proxyToolset('write_file', {
      file_path: filePath,
      content,
      overwrite: true,
    }, 'file_manager')
  }

  async function createFile(filePath: string, content = '') {
    return await natsService.proxyToolset('write_file', {
      file_path: filePath,
      content,
    }, 'file_manager')
  }

  async function createDirectory(path: string) {
    return await natsService.proxyToolset('manage_path', {
      operation: 'create_dir',
      path,
    }, 'file_manager')
  }

  async function deletePath(path: string) {
    return await natsService.proxyToolset('manage_path', {
      operation: 'delete',
      path,
      recursive: true,
    }, 'file_manager')
  }

  function closeFile() {
    openFile.value = null
  }

  return {
    tree, loading, openFile,
    loadTree, readFile, writeFile, createFile,
    createDirectory, deletePath, closeFile,
  }
})
