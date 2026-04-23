import type { Pool } from "pg";

export interface ChatRow {
  chat_id: string;
  username: string;
  session_id: string | null;
  name: string;
  active_agent: string | null;
  created_at: string;
  last_used_at: string;
  deleted_at: string | null;
}

export interface ChatInfo {
  id: string;
  name: string;
  last_activity_date: string;
  project_name: string;
  active_agent: string | null;
}

/**
 * All chat CRUD for one tenant. Username is injected at construction and
 * every query filters on it — no path lets a crafted chat_id read or mutate
 * another tenant's data. This is the one and only query surface for chats
 * in the adapter.
 */
export class ChatsRepo {
  constructor(private pool: Pool, private username: string) {}

  async create(chatId: string, name: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO chats (chat_id, username, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (chat_id) DO NOTHING`,
      [chatId, this.username, name],
    );
  }

  async read(chatId: string): Promise<ChatRow | null> {
    const r = await this.pool.query(
      `SELECT chat_id, username, session_id, name, active_agent,
              created_at, last_used_at, deleted_at
       FROM chats
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username],
    );
    if (r.rowCount === 0) return null;
    const row = r.rows[0];
    return {
      chat_id: row.chat_id,
      username: row.username,
      session_id: row.session_id,
      name: row.name,
      active_agent: row.active_agent,
      created_at: row.created_at.toISOString(),
      last_used_at: row.last_used_at.toISOString(),
      deleted_at: row.deleted_at ? row.deleted_at.toISOString() : null,
    };
  }

  async list(): Promise<ChatInfo[]> {
    const r = await this.pool.query(
      `SELECT
         c.chat_id        AS id,
         COALESCE(NULLIF(c.name, 'New chat'), s.title, c.name) AS name,
         c.last_used_at   AS last_used_at,
         c.active_agent   AS active_agent,
         COALESCE(s.project_display, '') AS project_name
       FROM chats c
       LEFT JOIN sessions s ON s.session_id = c.session_id
       WHERE c.username = $1
         AND c.deleted_at IS NULL
         AND (s.is_sidechain IS DISTINCT FROM true)
       ORDER BY c.last_used_at DESC
       LIMIT 1000`,
      [this.username],
    );
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      last_activity_date: row.last_used_at.toISOString(),
      project_name: row.project_name,
      active_agent: row.active_agent,
    }));
  }

  async updateName(chatId: string, name: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET name = $3, last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, name],
    );
  }

  async setActiveAgent(chatId: string, agent: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET active_agent = $3
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username, agent],
    );
  }

  async setSessionUuid(chatId: string, sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET session_id = $3, last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL
         AND (session_id IS NULL OR session_id <> $3::uuid)`,
      [chatId, this.username, sessionId],
    );
  }

  async touch(chatId: string): Promise<void> {
    await this.pool.query(
      `UPDATE chats SET last_used_at = now()
       WHERE chat_id = $1 AND username = $2 AND deleted_at IS NULL`,
      [chatId, this.username],
    );
  }

  async delete(chatId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM chats WHERE chat_id = $1 AND username = $2`,
      [chatId, this.username],
    );
  }
}
