require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const path = require("path");
const {
  createCandidate,
  deleteCandidateById,
  initializeDatabase,
  isTokenRevoked,
  listCandidates,
  recordAnonymousVote,
  revokeToken,
  resetVotes,
} = require("./db");

const app = express();
const port = Number(process.env.PORT) || 3000;
const frontendPath = path.join(__dirname, "..", "frontend");

const collaboratorPassword = process.env.COLLABORATOR_PASSWORD || "COLAB2026";
const adminPassword = process.env.ADMIN_PASSWORD || "ADMIN#CIPA";
const tokenTtlMs = Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60 * 8;
let initializationPromise = null;

app.use(express.json());
app.use(async (_request, _response, next) => {
  try {
    validateRuntimeConfig();

    if (!initializationPromise) {
      initializationPromise = initializeDatabase().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }

    await initializationPromise;
    next();
  } catch (error) {
    next(error);
  }
});
function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET nao configurada. Defina uma chave forte no ambiente da Vercel.");
  }

  return "troque-esta-chave-em-producao";
}

function validateRuntimeConfig() {
  getSessionSecret();
}

function signTokenPayload(payload) {
  return crypto.createHmac("sha256", getSessionSecret()).update(payload).digest("base64url");
}

function createSessionToken(role) {
  const payload = JSON.stringify({
    role,
    exp: Date.now() + tokenTtlMs,
  });

  const encodedPayload = toBase64Url(payload);
  const signature = signTokenPayload(encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt: JSON.parse(payload).exp,
  };
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readToken(request) {
  const authorization = request.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice(7);
}

function verifySessionToken(token) {
  if (!token) {
    return null;
  }

  const [encodedPayload, receivedSignature] = token.split(".");

  if (!encodedPayload || !receivedSignature) {
    return null;
  }

  const expectedSignature = signTokenPayload(encodedPayload);
  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  const isSignatureValid = crypto.timingSafeEqual(receivedBuffer, expectedBuffer);

  if (!isSignatureValid) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));

    if (!payload.role || !payload.exp || Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch (_error) {
    return null;
  }
}

async function resolveSession(request) {
  const token = readToken(request);
  const session = verifySessionToken(token);

  if (!session) {
    return null;
  }

  const tokenHash = hashToken(token);
  const revoked = await isTokenRevoked(tokenHash);

  if (revoked) {
    return null;
  }

  return {
    ...session,
    token,
    tokenHash,
  };
}

function requireAuth(role) {
  return async (request, response, next) => {
    try {
      const session = await resolveSession(request);

      if (!session) {
        response.status(401).json({ message: "Sessao invalida ou expirada." });
        return;
      }

      if (role && session.role !== role) {
        response.status(403).json({ message: "Acesso negado." });
        return;
      }

      request.session = session;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function sanitizeCandidate(candidate, includeVotes = false) {
  const baseCandidate = {
    id: candidate.id,
    name: candidate.name,
    photoUrl: candidate.photo_url,
    description: candidate.description,
  };

  if (includeVotes) {
    return {
      ...baseCandidate,
      votes: candidate.votes,
    };
  }

  return baseCandidate;
}

function escapeCsvValue(value) {
  const normalizedValue = String(value ?? "").replace(/"/g, '""');
  return `"${normalizedValue}"`;
}

function buildVotingReportCsv(candidates) {
  const generatedAt = new Date().toISOString();
  const sortedCandidates = [...candidates].sort((left, right) => {
    const voteDifference = Number(right.votes || 0) - Number(left.votes || 0);

    if (voteDifference !== 0) {
      return voteDifference;
    }

    return String(left.name).localeCompare(String(right.name), "pt-BR");
  });
  const totalVotes = sortedCandidates.reduce((sum, candidate) => sum + Number(candidate.votes || 0), 0);
  const leader = sortedCandidates[0] || null;
  const averageVotes = sortedCandidates.length ? totalVotes / sortedCandidates.length : 0;
  const highestVoteCount = leader ? Number(leader.votes || 0) : 0;
  const leaders = sortedCandidates.filter(
    (candidate) => Number(candidate.votes || 0) === highestVoteCount && highestVoteCount > 0
  );
  const participationSummary =
    totalVotes > 0
      ? `${sortedCandidates.filter((candidate) => Number(candidate.votes || 0) > 0).length} candidato(s) receberam voto(s)`
      : "Nenhum voto registrado ate o momento";
  const lines = [
    ["Relatorio Executivo", "Votacao CIPA"],
    ["Gerado em", generatedAt],
    ["Total de candidatos", String(sortedCandidates.length)],
    ["Total de votos", String(totalVotes)],
    ["Media de votos por candidato", averageVotes.toFixed(2).replace(".", ",")],
    ["Lider atual", leader ? leader.name : "Sem candidatos"],
    ["Maior votacao", String(highestVoteCount)],
    [
      "Situacao da lideranca",
      leaders.length > 1 ? `Empate entre ${leaders.map((candidate) => candidate.name).join(", ")}` : "Lideranca isolada",
    ],
    ["Participacao", participationSummary],
    [],
    ["Ranking Geral"],
    ["Posicao", "ID", "Nome", "Votos", "Percentual", "Diferenca para lider", "Descricao"],
    ...sortedCandidates.map((candidate, index) => [
      String(index + 1),
      String(candidate.id),
      candidate.name,
      String(candidate.votes || 0),
      totalVotes > 0
        ? `${((Number(candidate.votes || 0) / totalVotes) * 100).toFixed(2).replace(".", ",")}%`
        : "0,00%",
      String(highestVoteCount - Number(candidate.votes || 0)),
      candidate.description,
    ]),
    [],
    ["Resumo Consolidado"],
    ["Indicador", "Valor"],
    ["Candidatos com voto", String(sortedCandidates.filter((candidate) => Number(candidate.votes || 0) > 0).length)],
    ["Candidatos sem voto", String(sortedCandidates.filter((candidate) => Number(candidate.votes || 0) === 0).length)],
    [
      "Percentual do lider",
      totalVotes > 0 && leader
        ? `${((Number(leader.votes || 0) / totalVotes) * 100).toFixed(2).replace(".", ",")}%`
        : "0,00%",
    ],
    ["Diferenca entre 1o e 2o lugar", String(Math.max(0, highestVoteCount - Number(sortedCandidates[1]?.votes || 0)))],
    [],
    ["Detalhamento por Candidato"],
    ["ID", "Nome", "Descricao", "Votos"],
    ...sortedCandidates.map((candidate) => [
      String(candidate.id),
      candidate.name,
      candidate.description,
    ]),
  ];


  return lines
    .map((line) => line.map((value) => escapeCsvValue(value)).join(";"))
    .join("\n");
}

app.post("/login", (request, response) => {
  const { password } = request.body || {};

  if (!password) {
    response.status(400).json({ message: "Informe a senha para continuar." });
    return;
  }

  if (password === collaboratorPassword) {
    const session = createSessionToken("voter");

    response.json({
      role: "voter",
      token: session.token,
      expiresAt: session.expiresAt,
    });
    return;
  }

  if (password === adminPassword) {
    const session = createSessionToken("admin");

    response.json({
      role: "admin",
      token: session.token,
      expiresAt: session.expiresAt,
    });
    return;
  }

  response.status(401).json({ message: "Senha invalida." });
});

app.post("/logout", requireAuth(), async (request, response, next) => {
  try {
    await revokeToken({
      tokenHash: request.session.tokenHash,
      role: request.session.role,
      expiresAt: request.session.exp,
    });

    response.json({ message: "Sessao encerrada." });
  } catch (error) {
    next(error);
  }
});

app.get("/candidates", async (request, response, next) => {
  try {
    const session = await resolveSession(request);
    const includeVotes = session?.role === "admin";
    const candidates = await listCandidates();

    response.json(candidates.map((candidate) => sanitizeCandidate(candidate, includeVotes)));
  } catch (error) {
    next(error);
  }
});

app.post("/vote/:id", requireAuth("voter"), async (request, response, next) => {
  try {
    const candidateId = Number(request.params.id);

    if (!Number.isInteger(candidateId)) {
      response.status(400).json({ message: "Candidato invalido." });
      return;
    }

    const voteResult = await recordAnonymousVote(candidateId, request.session);

    if (voteResult.status === "candidate_not_found") {
      response.status(404).json({ message: "Candidato nao encontrado." });
      return;
    }

    if (voteResult.status === "token_reused") {
      response.status(409).json({ message: "Esta sessao ja foi utilizada para votar ou encerrada." });
      return;
    }

    response.json({ message: "Voto registrado com sucesso." });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/candidates", requireAuth("admin"), async (request, response, next) => {
  try {
    const { name, photoUrl, description } = request.body || {};

    if (!name || !photoUrl || !description) {
      response.status(400).json({ message: "Preencha nome, foto e descricao." });
      return;
    }

    const candidate = await createCandidate({
      name: name.trim(),
      photoUrl: photoUrl.trim(),
      description: description.trim(),
    });

    response.status(201).json(sanitizeCandidate(candidate, true));
  } catch (error) {
    next(error);
  }
});

app.delete("/admin/candidates/:id", requireAuth("admin"), async (request, response, next) => {
  try {
    const candidateId = Number(request.params.id);

    if (!Number.isInteger(candidateId)) {
      response.status(400).json({ message: "Candidato invalido." });
      return;
    }

    const deletedCandidate = await deleteCandidateById(candidateId);

    if (!deletedCandidate) {
      response.status(404).json({ message: "Candidato nao encontrado." });
      return;
    }

    response.json({ message: "Candidato removido com sucesso." });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/reset", requireAuth("admin"), async (request, response, next) => {
  try {
    await resetVotes();
    response.json({ message: "Votacao zerada com sucesso." });
  } catch (error) {
    next(error);
  }
});

app.get("/admin/report", requireAuth("admin"), async (_request, response, next) => {
  try {
    const candidates = await listCandidates();
    const reportCsv = buildVotingReportCsv(candidates);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="relatorio-votacao-cipa-${timestamp}.csv"`
    );
    response.status(200).send("\uFEFF" + reportCsv);
  } catch (error) {
    next(error);
  }
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use(express.static(frontendPath));

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(frontendPath, "index.html"));
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ message: "Erro interno do servidor." });
});

async function start() {
  if (!initializationPromise) {
    initializationPromise = initializeDatabase();
  }

  await initializationPromise;

  app.listen(port, () => {
    console.log(`Servidor da CIPA ativo em http://localhost:${port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Falha ao iniciar o servidor:", error);
    process.exit(1);
  });
}

module.exports = app;
