// Drop-to-create-project: the orchestration that turns a file (or a few
// files) dropped on the chat composer into a fresh project under
// local_projects/, a new chat bound to it, and the kickoff message the
// caller will send.
//
// Frontend-only: the backend has no "project" concept beyond the folder,
// and `create_chat` doesn't currently bind a working dir. The agent learns
// the project context from the kickoff message instead.

import { useFileStore } from '@/stores/files'
import { useChatStore } from '@/stores/chat'
import { queueUpload } from '@/services/upload'

const PROJECTS_ROOT = 'local_projects'

export interface CreatedProject {
  /** Display name + chat name. Final segment of projectDir. */
  projectName: string
  /** Workspace-relative dir, e.g. 'local_projects/pbmc-data-1a2b'. */
  projectDir: string
  /** Absolute path the agent sees, e.g. '/workspace/local_projects/...'. */
  workspaceDir: string
  files: { name: string; workspacePath: string }[]
  chatId: string | null
}

function slugify(name: string): string {
  const noExt = name.replace(/\.[^./]+$/, '')
  // Strip combining marks (NFKD-decomposed accents) and reduce to a safe slug.
  const s = noExt
    .toLowerCase()
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s || 'project'
}

function randomSuffix(): string {
  const bytes = new Uint8Array(2)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function pickProjectName(seedFilename: string): string {
  return `${slugify(seedFilename)}-${randomSuffix()}`
}

/** Compose the first user message for a freshly-created project. The agent
 *  has no per-chat working dir today, so the prompt is what tells it where
 *  to operate. Keep this terse — agents pick up structure faster than prose. */
export function composeKickoffMessage(proj: CreatedProject, userText: string): string {
  const fileLines = proj.files.map(f => `- ${f.workspacePath}`).join('\n')
  const noun = proj.files.length === 1 ? 'file' : 'files'
  const fallback = `Take a look at the ${noun} I just dropped and tell me what you can do with ${proj.files.length === 1 ? 'it' : 'them'}.`
  return [
    `New project: \`${proj.projectName}\``,
    `Working directory: \`${proj.workspaceDir}\` — please cd here and keep all outputs inside it.`,
    ``,
    `Dropped ${noun}:`,
    fileLines,
    ``,
    userText || fallback,
  ].join('\n')
}

/** Create local_projects/<slug>-<hex>/, upload each file into it, then
 *  create and select a new chat named after the project. */
export async function createProjectWithFiles(files: File[]): Promise<CreatedProject> {
  if (files.length === 0) throw new Error('No files to create project from')
  const filesStore = useFileStore()
  const chatStore = useChatStore()

  const projectName = pickProjectName(files[0].name)
  const projectDir = `${PROJECTS_ROOT}/${projectName}`
  const workspaceDir = `/workspace/${projectDir}`

  await filesStore.createDirectory(projectDir)

  const uploaded: { name: string; workspacePath: string }[] = []
  for (const f of files) {
    const { promise } = queueUpload(f, projectDir)
    await promise
    uploaded.push({ name: f.name, workspacePath: `${workspaceDir}/${f.name}` })
  }

  const chatId = await chatStore.createChat(projectName)
  if (chatId) await chatStore.selectChat(chatId)

  return { projectName, projectDir, workspaceDir, files: uploaded, chatId }
}
