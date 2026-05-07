require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const PDFDocument = require("pdfkit");
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
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || "4mb";

const collaboratorPassword = process.env.COLLABORATOR_PASSWORD || "COLAB2026";
const adminPassword = process.env.ADMIN_PASSWORD || "ADMIN#CIPA";
const tokenTtlMs = Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60 * 8;
let initializationPromise = null;

app.use(express.json({ limit: jsonBodyLimit }));
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

function formatDateTime(value) {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function formatPercent(value) {
  return `${value.toFixed(2).replace(".", ",")}%`;
}

function getVotingReportData(candidates) {
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
  const candidatesWithVotes = sortedCandidates.filter((candidate) => Number(candidate.votes || 0) > 0).length;
  const candidatesWithoutVotes = sortedCandidates.filter((candidate) => Number(candidate.votes || 0) === 0).length;
  const leaderPercent =
    totalVotes > 0 && leader ? (Number(leader.votes || 0) / totalVotes) * 100 : 0;
  const runnerUpDifference = Math.max(0, highestVoteCount - Number(sortedCandidates[1]?.votes || 0));

  return {
    generatedAt,
    sortedCandidates,
    totalVotes,
    leader,
    averageVotes,
    highestVoteCount,
    leaders,
    participationSummary,
    candidatesWithVotes,
    candidatesWithoutVotes,
    leaderPercent,
    runnerUpDifference,
  };
}

function ensurePdfSpace(doc, neededHeight = 24) {
  const bottomLimit = doc.page.height - doc.page.margins.bottom;

  if (doc.y + neededHeight > bottomLimit) {
    doc.addPage();
  }
}

function resetPdfTextCursor(doc) {
  doc.x = doc.page.margins.left;
}

function drawMetricCard(doc, x, y, width, title, value) {
  doc
    .save()
    .roundedRect(x, y, width, 54, 8)
    .fillAndStroke("#F8FAFC", "#CBD5E1")
    .restore();

  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#475569")
    .text(title, x + 10, y + 10, { width: width - 20 });

  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor("#0F172A")
    .text(value, x + 10, y + 25, { width: width - 20 });
}

function buildVotingReportPdfBuffer(candidates) {
  const report = getVotingReportData(candidates);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      bufferPages: true,
    });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(22).fillColor("#0F172A").text("Relatorio Executivo da Votacao CIPA");
    doc.moveDown(0.25);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#475569")
      .text(`Emitido em ${formatDateTime(report.generatedAt)}`);

    const cardY = doc.y + 16;
    const gap = 12;
    const cardWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - gap) / 2;

    drawMetricCard(doc, doc.page.margins.left, cardY, cardWidth, "Total de candidatos", String(report.sortedCandidates.length));
    drawMetricCard(doc, doc.page.margins.left + cardWidth + gap, cardY, cardWidth, "Total de votos", String(report.totalVotes));
    drawMetricCard(
      doc,
      doc.page.margins.left,
      cardY + 66,
      cardWidth,
      "Lider atual",
      report.leader ? report.leader.name : "Sem candidatos"
    );
    drawMetricCard(
      doc,
      doc.page.margins.left + cardWidth + gap,
      cardY + 66,
      cardWidth,
      "Percentual do lider",
      formatPercent(report.leaderPercent)
    );

    doc.y = cardY + 148;
    resetPdfTextCursor(doc);
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0F172A").text("Resumo Consolidado");
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(10).fillColor("#334155");
    [
      `Media de votos por candidato: ${report.averageVotes.toFixed(2).replace(".", ",")}`,
      `Maior votacao registrada: ${report.highestVoteCount}`,
      `Situacao da lideranca: ${
        report.leaders.length > 1
          ? `empate entre ${report.leaders.map((candidate) => candidate.name).join(", ")}`
          : "lideranca isolada"
      }`,
      `Participacao: ${report.participationSummary}`,
      `Candidatos com voto: ${report.candidatesWithVotes}`,
      `Candidatos sem voto: ${report.candidatesWithoutVotes}`,
      `Diferenca entre 1o e 2o lugar: ${report.runnerUpDifference}`,
    ].forEach((line) => {
      ensurePdfSpace(doc, 18);
      resetPdfTextCursor(doc);
      doc.text(`- ${line}`);
    });

    doc.moveDown(1);
    resetPdfTextCursor(doc);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0F172A").text("Ranking Geral");
    doc.moveDown(0.4);

    if (!report.sortedCandidates.length) {
      resetPdfTextCursor(doc);
      doc.font("Helvetica").fontSize(10).fillColor("#475569").text("Nenhum candidato cadastrado no momento.");
    } else {
      report.sortedCandidates.forEach((candidate, index) => {
        ensurePdfSpace(doc, 72);
        resetPdfTextCursor(doc);
        const percent = report.totalVotes > 0 ? (Number(candidate.votes || 0) / report.totalVotes) * 100 : 0;

        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .fillColor("#1D4ED8")
          .text(`${index + 1}o lugar - ${candidate.name}`);
        doc
          .font("Helvetica")
          .fontSize(10)
          .fillColor("#0F172A")
          .text(
            `Votos: ${candidate.votes || 0} | Percentual: ${formatPercent(percent)} | Diferenca para o lider: ${
              report.highestVoteCount - Number(candidate.votes || 0)
            }`
          );
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#475569")
          .text(`Descricao: ${candidate.description || "Sem descricao informada."}`, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          });
        doc.moveDown(0.6);
      });
    }

    doc.moveDown(0.5);
    resetPdfTextCursor(doc);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0F172A").text("Detalhamento por Candidato");
    doc.moveDown(0.4);

    report.sortedCandidates.forEach((candidate) => {
      ensurePdfSpace(doc, 64);
      resetPdfTextCursor(doc);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#0F172A")
        .text(`${candidate.name} (ID ${candidate.id})`);
      doc
        .font("Helvetica")
        .fontSize(10)
        .fillColor("#334155")
        .text(`Votos recebidos: ${candidate.votes || 0}`);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#475569")
        .text(candidate.description || "Sem descricao informada.");
      doc.moveDown(0.5);
    });

    const pageRange = doc.bufferedPageRange();
    for (let pageIndex = 0; pageIndex < pageRange.count; pageIndex += 1) {
      doc.switchToPage(pageIndex);
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#64748B")
        .text(
          `Relatorio Executivo CIPA | Pagina ${pageIndex + 1} de ${pageRange.count}`,
          doc.page.margins.left,
          doc.page.height - doc.page.margins.bottom + 10,
          {
            align: "center",
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          }
        );
    }

    doc.end();
  });
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

    if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(photoUrl)) {
      response.status(400).json({ message: "Envie uma imagem valida para o candidato." });
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
    const reportPdf = await buildVotingReportPdfBuffer(candidates);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    response.setHeader("Content-Type", "application/pdf");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="relatorio-votacao-cipa-${timestamp}.pdf"`
    );
    response.status(200).send(reportPdf);
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

  if (error?.type === "entity.too.large") {
    response.status(413).json({
      message: "A imagem enviada e muito grande. Tente uma foto menor.",
    });
    return;
  }

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
