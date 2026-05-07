const adminSession = window.CipaApp.enforceRole("admin");

if (adminSession) {
  document.body.classList.remove("hidden-until-ready");
}

const candidateForm = document.getElementById("candidate-form");
const candidateList = document.getElementById("candidate-list");
const candidateCount = document.getElementById("candidate-count");
const voteCount = document.getElementById("vote-count");
const formFeedback = document.getElementById("form-feedback");
const listEmptyState = document.getElementById("list-empty-state");
const resetVotesButton = document.getElementById("reset-votes");
const downloadReportButton = document.getElementById("download-report");
const logoutButton = document.getElementById("logout-button");
const photoFileInput = document.getElementById("photoFile");
const photoPreview = document.getElementById("photo-preview");
const photoPreviewText = document.getElementById("photo-preview-text");

let refreshIntervalId = null;
const MAX_PHOTO_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_DIMENSION = 640;
const UPLOAD_IMAGE_QUALITY = 0.82;

function showFormFeedback(message, type) {
  formFeedback.textContent = message;
  formFeedback.className =
    "mt-4 rounded-2xl border px-4 py-3 text-sm " +
    (type === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700");
  formFeedback.classList.remove("hidden");
}

function resetPhotoPreview() {
  photoPreview.classList.add("hidden");
  photoPreview.removeAttribute("src");
  photoPreviewText.textContent = "Nenhuma imagem selecionada.";
}

function readImageFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Nao foi possivel ler a imagem selecionada."));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nao foi possivel processar a imagem selecionada."));
    image.src = dataUrl;
  });
}

async function buildOptimizedPhotoDataUrl(file) {
  const originalDataUrl = await readImageFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(originalDataUrl);
  const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Nao foi possivel preparar a imagem para envio.");
  }

  canvas.width = width;
  canvas.height = height;
  context.drawImage(image, 0, 0, width, height);

  return canvas.toDataURL("image/jpeg", UPLOAD_IMAGE_QUALITY);
}

function renderCandidate(candidate) {
  const wrapper = document.createElement("article");
  wrapper.className = "rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5";

  const topRow = document.createElement("div");
  topRow.className = "flex flex-col gap-4 md:flex-row md:items-center md:justify-between";

  const identity = document.createElement("div");
  identity.className = "flex items-center gap-3 sm:gap-4";

  const image = document.createElement("img");
  image.className = "h-14 w-14 rounded-full border-4 border-brand-100 object-cover sm:h-16 sm:w-16";
  window.CipaApp.withFallbackPhoto(image, candidate.photoUrl, candidate.name);

  const texts = document.createElement("div");
  const name = document.createElement("h3");
  name.className = "text-base font-semibold text-slate-900 sm:text-lg";
  name.textContent = candidate.name;

  const votes = document.createElement("p");
  votes.className = "mt-1 text-sm font-medium text-brand-700";
  votes.textContent = `${candidate.votes} voto(s)`;

  texts.append(name, votes);
  identity.append(image, texts);

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className =
    "touch-target w-full rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100 md:w-auto";
  deleteButton.textContent = "Excluir";
  deleteButton.addEventListener("click", async () => {
    const confirmed = window.confirm(`Excluir o candidato ${candidate.name}?`);

    if (!confirmed) {
      return;
    }

    try {
      await window.CipaApp.apiRequest(`/admin/candidates/${candidate.id}`, {
        method: "DELETE",
      });
      await loadCandidates();
    } catch (error) {
      window.alert(error.message);
    }
  });

  topRow.append(identity, deleteButton);

  const description = document.createElement("p");
  description.className = "mt-4 text-sm leading-relaxed text-slate-600";
  description.textContent =
    candidate.description.length > 180
      ? `${candidate.description.slice(0, 177)}...`
      : candidate.description;

  wrapper.append(topRow, description);
  return wrapper;
}

async function loadCandidates() {
  try {
    const candidates = await window.CipaApp.apiRequest("/candidates");
    candidateList.innerHTML = "";

    const totalVotes = candidates.reduce((sum, candidate) => sum + (candidate.votes || 0), 0);

    candidateCount.textContent = String(candidates.length);
    voteCount.textContent = String(totalVotes);

    if (!candidates.length) {
      listEmptyState.classList.remove("hidden");
      return;
    }

    listEmptyState.classList.add("hidden");
    candidates.forEach((candidate) => {
      candidateList.appendChild(renderCandidate(candidate));
    });
  } catch (error) {
    listEmptyState.textContent = error.message;
    listEmptyState.classList.remove("hidden");
  }
}

async function downloadVotingReport() {
  const session = window.CipaApp.getSession();

  if (!session?.token) {
    window.CipaApp.clearSession();
    window.location.href = "/index.html";
    return;
  }

  downloadReportButton.disabled = true;
  downloadReportButton.textContent = "Gerando...";

  try {
    const response = await fetch("/admin/report", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    if (!response.ok) {
      let errorMessage = "Falha ao baixar o relatorio.";

      try {
        const payload = await response.json();
        errorMessage = payload?.message || errorMessage;
      } catch (_error) {
        // Mantem a mensagem padrao quando a resposta nao e JSON.
      }

      throw new Error(errorMessage);
    }

    const contentDisposition = response.headers.get("content-disposition") || "";
    const matchedFileName = contentDisposition.match(/filename="([^"]+)"/i);
    const fileName = matchedFileName?.[1] || "relatorio-votacao-cipa.pdf";
    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const temporaryLink = document.createElement("a");

    temporaryLink.href = downloadUrl;
    temporaryLink.download = fileName;
    document.body.appendChild(temporaryLink);
    temporaryLink.click();
    temporaryLink.remove();
    window.URL.revokeObjectURL(downloadUrl);

    showFormFeedback("Relatorio em PDF baixado com sucesso.", "success");
  } catch (error) {
    if (error.message.includes("Sessao invalida") || error.message.includes("expirada")) {
      window.CipaApp.clearSession();
      window.location.href = "/index.html";
      return;
    }

    showFormFeedback(error.message, "error");
  } finally {
    downloadReportButton.disabled = false;
    downloadReportButton.textContent = "Baixar PDF";
  }
}

photoFileInput.addEventListener("change", async () => {
  const file = photoFileInput.files?.[0];

  if (!file) {
    resetPhotoPreview();
    return;
  }

  if (!file.type.startsWith("image/")) {
    photoFileInput.value = "";
    resetPhotoPreview();
    showFormFeedback("Selecione um arquivo de imagem valido.", "error");
    return;
  }

  if (file.size > MAX_PHOTO_SIZE_BYTES) {
    photoFileInput.value = "";
    resetPhotoPreview();
    showFormFeedback("A imagem deve ter no maximo 2 MB.", "error");
    return;
  }

  try {
    const previewDataUrl = await buildOptimizedPhotoDataUrl(file);
    photoPreview.src = previewDataUrl;
    photoPreview.classList.remove("hidden");
    photoPreviewText.textContent = file.name;
  } catch (error) {
    photoFileInput.value = "";
    resetPhotoPreview();
    showFormFeedback(error.message, "error");
  }
});

candidateForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(candidateForm);
  const photoFile = photoFileInput.files?.[0];

  if (!photoFile) {
    showFormFeedback("Selecione uma foto do candidato.", "error");
    return;
  }

  if (photoFile.size > MAX_PHOTO_SIZE_BYTES) {
    showFormFeedback("A imagem deve ter no maximo 2 MB.", "error");
    return;
  }

  let photoDataUrl = "";

  try {
    photoDataUrl = await buildOptimizedPhotoDataUrl(photoFile);
  } catch (error) {
    showFormFeedback(error.message, "error");
    return;
  }

  const payload = {
    name: String(formData.get("name") || "").trim(),
    photoUrl: photoDataUrl,
    description: String(formData.get("description") || "").trim(),
  };

  try {
    await window.CipaApp.apiRequest("/admin/candidates", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    candidateForm.reset();
    resetPhotoPreview();
    showFormFeedback("Candidato cadastrado com sucesso.", "success");
    await loadCandidates();
  } catch (error) {
    showFormFeedback(error.message, "error");
  }
});

resetVotesButton.addEventListener("click", async () => {
  const confirmed = window.confirm("Deseja zerar a votacao de todos os candidatos?");

  if (!confirmed) {
    return;
  }

  try {
    await window.CipaApp.apiRequest("/admin/reset", {
      method: "POST",
    });
    await loadCandidates();
  } catch (error) {
    window.alert(error.message);
  }
});

downloadReportButton.addEventListener("click", downloadVotingReport);
logoutButton.addEventListener("click", () => window.CipaApp.logoutAndRedirect());

resetPhotoPreview();
loadCandidates();
refreshIntervalId = window.setInterval(loadCandidates, 4000);

window.addEventListener("beforeunload", () => {
  if (refreshIntervalId) {
    window.clearInterval(refreshIntervalId);
  }
});
