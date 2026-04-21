export function formatDate(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString()
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

export function getFileIcon(name: string, type: 'file' | 'directory'): string {
  if (type === 'directory') return '📁'
  const ext = name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    py: '🐍', js: '📜', ts: '📜', json: '📋', md: '📝',
    ipynb: '📓', csv: '📊', html: '🌐', css: '🎨',
    yaml: '⚙️', yml: '⚙️', sh: '💻', r: '📈',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    pdf: '📄', txt: '📄',
  }
  return map[ext || ''] || '📄'
}
