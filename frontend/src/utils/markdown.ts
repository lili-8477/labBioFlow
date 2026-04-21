import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked for code highlighting
marked.setOptions({
  breaks: true,
  gfm: true,
})

export function renderMarkdown(text: string): string {
  if (!text) return ''
  const html = marked.parse(text) as string
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['target', 'rel'],
  })
}

export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
