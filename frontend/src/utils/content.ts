/**
 * Extract displayable text from various message content formats.
 *
 * bioFlow message.content can be:
 * - string: plain text
 * - array of content blocks: [{type: "text", text: "..."}, {type: "image_url", ...}]
 * - object: arbitrary data
 * - null/undefined
 */
export function extractTextContent(content: unknown): string {
  if (content == null) return ''

  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object') {
          // OpenAI-style content block: {type: "text", text: "..."}
          if (block.type === 'text' && typeof block.text === 'string') return block.text
          // Image blocks - show placeholder
          if (block.type === 'image_url' || block.type === 'image') return '[Image]'
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }

  if (typeof content === 'object') {
    // Tool result or other structured data
    const obj = content as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
    if (typeof obj.content === 'string') return obj.content
    // Fallback: JSON stringify for debugging
    try {
      return JSON.stringify(content, null, 2)
    } catch {
      return String(content)
    }
  }

  return String(content)
}

/**
 * Check if a message should be displayed in the chat view.
 * Filters out internal tool-call/tool-result messages that are not useful to show.
 */
export function isDisplayableMessage(msg: Record<string, unknown>): boolean {
  const role = msg.role as string
  // Always show user and assistant messages
  if (role === 'user' || role === 'assistant') return true
  // Hide tool results and system messages from main view
  if (role === 'tool' || role === 'system') return false
  return true
}
