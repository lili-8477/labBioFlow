/**
 * Shared Monaco loader.
 *
 * Monaco is large (~2 MB parsed). Loading it once and sharing the module + theme
 * registration across every cell editor avoids duplicate imports and the visible
 * flash of each Monaco instance redefining the theme on mount.
 */

type Monaco = typeof import('monaco-editor')

let monacoPromise: Promise<Monaco> | null = null
let themeRegistered = false

export const PANTHEON_THEME = 'bioflow-cell'

/**
 * Monaco colors mirror the bioFlow OKLCH palette. Monaco doesn't accept
 * oklch() strings, so these are hex approximations of the same tokens.
 */
export function getMonaco(): Promise<Monaco> {
  if (!monacoPromise) {
    monacoPromise = import('monaco-editor').then((m) => {
      if (!themeRegistered) {
        m.editor.defineTheme(PANTHEON_THEME, {
          base: 'vs-dark',
          inherit: true,
          rules: [
            { token: 'comment', foreground: '6f7a6c', fontStyle: 'italic' },
            { token: 'keyword', foreground: 'e8a084' },
            { token: 'string',  foreground: 'b5c991' },
            { token: 'number',  foreground: 'd7b57a' },
            { token: 'type',    foreground: 'c7a9e0' },
          ],
          colors: {
            // matches --bg-secondary (oklch 0.215 0.010 135)
            'editor.background': '#1c211d',
            'editor.foreground': '#eee7dd',
            'editorLineNumber.foreground':       '#525a52',
            'editorLineNumber.activeForeground': '#b4ad9f',
            'editor.selectionBackground':         '#5c3d31',
            'editor.inactiveSelectionBackground': '#3a3127',
            'editorCursor.foreground':            '#e8a084',
            'editor.lineHighlightBackground':     '#22271f',
            'editorIndentGuide.background1':      '#2d332c',
          },
        })
        themeRegistered = true
      }
      return m
    })
  }
  return monacoPromise
}

/** Common per-cell editor options. Caller can override. */
export function defaultCellEditorOptions(isCode: boolean) {
  return {
    theme: PANTHEON_THEME,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: 'JetBrains Mono, Fira Code, Consolas, monospace',
    lineNumbers: (isCode ? 'on' : 'off') as 'on' | 'off',
    scrollBeyondLastLine: false,
    wordWrap: 'on' as const,
    automaticLayout: true,
    scrollbar: { vertical: 'hidden' as const, horizontal: 'auto' as const, alwaysConsumeMouseWheel: false },
    overviewRulerLanes: 0,
    renderLineHighlight: 'none' as const,
    folding: false,
    lineDecorationsWidth: 10,
    lineNumbersMinChars: 3,
    glyphMargin: false,
    padding: { top: 6, bottom: 6 },
    contextmenu: false,
    fixedOverflowWidgets: true,
  }
}
