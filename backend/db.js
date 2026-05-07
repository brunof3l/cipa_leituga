const { neon } = require("@neondatabase/serverless");

let sqlClient = null;

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL nao configurada. Defina a string de conexao do Neon no ambiente.");
  }

  if (!sqlClient) {
    // O driver HTTP do Neon evita problemas de conexao em ambientes serverless, como a Vercel.
    sqlClient = neon(process.env.DATABASE_URL);
  }

  return sqlClient;
}

async function initializeDatabase() {
  const sql = getSql();
  await sql.transaction([
    sql`
      CREATE TABLE IF NOT EXISTS candidates (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        photo_url TEXT NOT NULL,
        description TEXT NOT NULL,
        votes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS votes (
        id BIGSERIAL PRIMARY KEY,
        candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        token_hash TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`CREATE INDEX IF NOT EXISTS idx_votes_candidate_id ON votes(candidate_id)`,
    sql`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens(expires_at)`,
  ]);
}

async function listCandidates() {
  const sql = getSql();
  return sql`
    SELECT id, name, photo_url, description, votes
    FROM candidates
    ORDER BY LOWER(name) ASC
  `;
}

async function getCandidateById(candidateId) {
  const sql = getSql();
  const [candidate] = await sql`
    SELECT id, name, photo_url, description, votes
    FROM candidates
    WHERE id = ${candidateId}
    LIMIT 1
  `;

  return candidate || null;
}

async function createCandidate({ name, photoUrl, description }) {
  const sql = getSql();
  const [candidate] = await sql`
    INSERT INTO candidates (name, photo_url, description)
    VALUES (${name}, ${photoUrl}, ${description})
    RETURNING id, name, photo_url, description, votes
  `;

  return candidate;
}

async function deleteCandidateById(candidateId) {
  const sql = getSql();
  const [candidate] = await sql`
    DELETE FROM candidates
    WHERE id = ${candidateId}
    RETURNING id
  `;

  return candidate || null;
}

async function resetVotes() {
  const sql = getSql();
  await sql.transaction([
    sql`DELETE FROM revoked_tokens`,
    sql`DELETE FROM votes`,
    sql`UPDATE candidates SET votes = 0`,
  ]);
}

async function isTokenRevoked(tokenHash) {
  const sql = getSql();
  const [token] = await sql`
    SELECT token_hash
    FROM revoked_tokens
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `;

  return Boolean(token);
}

async function revokeToken({ tokenHash, role, expiresAt }) {
  const sql = getSql();
  await sql`
    INSERT INTO revoked_tokens (token_hash, role, expires_at)
    VALUES (${tokenHash}, ${role}, TO_TIMESTAMP(${expiresAt} / 1000.0))
    ON CONFLICT (token_hash) DO NOTHING
  `;
}

async function recordAnonymousVote(candidateId, session) {
  const sql = getSql();
  const [result] = await sql`
    WITH candidate_row AS (
      SELECT id
      FROM candidates
      WHERE id = ${candidateId}
    ),
    token_lock AS (
      INSERT INTO revoked_tokens (token_hash, role, expires_at)
      SELECT ${session.tokenHash}, ${session.role}, TO_TIMESTAMP(${session.exp} / 1000.0)
      WHERE EXISTS (SELECT 1 FROM candidate_row)
      ON CONFLICT (token_hash) DO NOTHING
      RETURNING token_hash
    ),
    vote_insert AS (
      INSERT INTO votes (candidate_id)
      SELECT id
      FROM candidate_row
      WHERE EXISTS (SELECT 1 FROM token_lock)
      RETURNING id
    ),
    candidate_update AS (
      UPDATE candidates
      SET votes = votes + 1
      WHERE id = ${candidateId}
        AND EXISTS (SELECT 1 FROM vote_insert)
      RETURNING id, votes
    )
    SELECT
      EXISTS (SELECT 1 FROM candidate_row) AS candidate_exists,
      EXISTS (SELECT 1 FROM token_lock) AS token_accepted,
      (SELECT id FROM candidate_update LIMIT 1) AS id,
      (SELECT votes FROM candidate_update LIMIT 1) AS votes
  `;

  if (!result?.candidate_exists) {
    return { status: "candidate_not_found" };
  }

  if (!result?.token_accepted) {
    return { status: "token_reused" };
  }

  return {
    status: "success",
    candidate: {
      id: result.id,
      votes: result.votes,
    },
  };
}

module.exports = {
  createCandidate,
  deleteCandidateById,
  getCandidateById,
  initializeDatabase,
  isTokenRevoked,
  listCandidates,
  recordAnonymousVote,
  revokeToken,
  resetVotes,
};
