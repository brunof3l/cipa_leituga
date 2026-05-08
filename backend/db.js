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
        device_id TEXT,
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
    sql`
      CREATE TABLE IF NOT EXISTS voting_settings (
        id SMALLINT PRIMARY KEY,
        is_open BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`CREATE INDEX IF NOT EXISTS idx_votes_candidate_id ON votes(candidate_id)`,
    sql`ALTER TABLE votes ADD COLUMN IF NOT EXISTS device_id TEXT`,
    sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_device_id_unique ON votes(device_id) WHERE device_id IS NOT NULL`,
    sql`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens(expires_at)`,
    sql`
      INSERT INTO voting_settings (id, is_open)
      VALUES (1, TRUE)
      ON CONFLICT (id) DO NOTHING
    `,
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

async function getVotingStatus() {
  const sql = getSql();
  const [settings] = await sql`
    SELECT is_open, updated_at
    FROM voting_settings
    WHERE id = 1
    LIMIT 1
  `;

  return {
    isOpen: settings ? Boolean(settings.is_open) : true,
    updatedAt: settings?.updated_at || null,
  };
}

async function setVotingStatus(isOpen) {
  const sql = getSql();
  const [settings] = await sql`
    INSERT INTO voting_settings (id, is_open, updated_at)
    VALUES (1, ${isOpen}, NOW())
    ON CONFLICT (id)
    DO UPDATE SET
      is_open = EXCLUDED.is_open,
      updated_at = NOW()
    RETURNING is_open, updated_at
  `;

  return {
    isOpen: Boolean(settings.is_open),
    updatedAt: settings.updated_at,
  };
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

async function hasDeviceVoted(deviceId) {
  const sql = getSql();
  const [vote] = await sql`
    SELECT id
    FROM votes
    WHERE device_id = ${deviceId}
    LIMIT 1
  `;

  return Boolean(vote);
}

async function recordAnonymousVote(candidateId, session, deviceId) {
  const sql = getSql();
  const candidate = await getCandidateById(candidateId);

  if (!candidate) {
    return { status: "candidate_not_found" };
  }

  const [tokenLock] = await sql`
    INSERT INTO revoked_tokens (token_hash, role, expires_at)
    VALUES (${session.tokenHash}, ${session.role}, TO_TIMESTAMP(${session.exp} / 1000.0))
    ON CONFLICT (token_hash) DO NOTHING
    RETURNING token_hash
  `;

  if (!tokenLock) {
    return { status: "token_reused" };
  }

  const alreadyVoted = await hasDeviceVoted(deviceId);

  if (alreadyVoted) {
    return { status: "device_already_voted" };
  }

  try {
    await sql`
      INSERT INTO votes (candidate_id, device_id)
      VALUES (${candidateId}, ${deviceId})
    `;

    const [updatedCandidate] = await sql`
      UPDATE candidates
      SET votes = votes + 1
      WHERE id = ${candidateId}
      RETURNING id, votes
    `;

    return {
      status: "success",
      candidate: {
        id: updatedCandidate.id,
        votes: updatedCandidate.votes,
      },
    };
  } catch (error) {
    if (error?.code === "23505") {
      return { status: "device_already_voted" };
    }

    throw error;
  }
}

module.exports = {
  createCandidate,
  deleteCandidateById,
  getCandidateById,
  hasDeviceVoted,
  getVotingStatus,
  initializeDatabase,
  isTokenRevoked,
  listCandidates,
  recordAnonymousVote,
  revokeToken,
  resetVotes,
  setVotingStatus,
};
