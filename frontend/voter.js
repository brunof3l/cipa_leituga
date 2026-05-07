const session = window.CipaApp.enforceRole("voter");

if (session) {
  document.body.classList.remove("hidden-until-ready");
}

const candidateGrid = document.getElementById("candidate-grid");
const emptyState = document.getElementById("empty-state");
const modal = document.getElementById("candidate-modal");
const closeModalButton = document.getElementById("close-modal");
const confirmVoteButton = document.getElementById("confirm-vote");
const logoutButton = document.getElementById("logout-button");

const modalName = document.getElementById("modal-name");
const modalDescription = document.getElementById("modal-description");
const modalPhoto = document.getElementById("modal-photo");

let selectedCandidate = null;

function closeModal() {
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  selectedCandidate = null;
}

function openModal(candidate) {
  selectedCandidate = candidate;
  modalName.textContent = candidate.name;
  modalDescription.textContent = candidate.description;
  window.CipaApp.withFallbackPhoto(modalPhoto, candidate.photoUrl, candidate.name);
  modal.classList.remove("hidden");
  modal.classList.add("flex");
}

function createCandidateCard(candidate) {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "candidate-card glass-panel min-h-[168px] rounded-3xl border border-white/70 p-5 text-center shadow-lg shadow-slate-200/40 sm:p-6 sm:text-left";
  button.setAttribute("aria-label", `Abrir detalhes de ${candidate.name}`);

  const image = document.createElement("img");
  image.className = "mx-auto h-16 w-16 rounded-full border-4 border-brand-100 object-cover sm:mx-0 sm:h-20 sm:w-20";
  window.CipaApp.withFallbackPhoto(image, candidate.photoUrl, candidate.name);

  const title = document.createElement("h3");
  title.className = "mt-4 text-lg font-semibold text-slate-900 sm:text-xl";
  title.textContent = candidate.name;

  const description = document.createElement("p");
  description.className = "mt-2 text-sm leading-relaxed text-slate-600";
  description.textContent =
    candidate.description.length > 120
      ? `${candidate.description.slice(0, 117)}...`
      : candidate.description;

  const action = document.createElement("span");
  action.className =
    "mx-auto mt-5 inline-flex min-h-[40px] items-center rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 sm:mx-0 sm:text-sm";
  action.textContent = "Visualizar candidatura";

  button.append(image, title, description, action);
  button.addEventListener("click", () => openModal(candidate));

  return button;
}

async function loadCandidates() {
  try {
    const candidates = await window.CipaApp.apiRequest("/candidates");
    candidateGrid.innerHTML = "";

    if (!candidates.length) {
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");
    candidates.forEach((candidate) => {
      candidateGrid.appendChild(createCandidateCard(candidate));
    });
  } catch (error) {
    emptyState.textContent = error.message;
    emptyState.classList.remove("hidden");
  }
}

confirmVoteButton.addEventListener("click", async () => {
  if (!selectedCandidate) {
    return;
  }

  confirmVoteButton.disabled = true;
  confirmVoteButton.textContent = "Registrando voto...";

  try {
    await window.CipaApp.apiRequest(`/vote/${selectedCandidate.id}`, {
      method: "POST",
    });

    window.CipaApp.clearSession();
    window.alert("Voto confirmado com sucesso. Sua sessao sera encerrada.");
    window.location.href = "/index.html";
  } catch (error) {
    window.alert(error.message);
  } finally {
    confirmVoteButton.disabled = false;
    confirmVoteButton.textContent = "Confirmar Voto";
  }
});

closeModalButton.addEventListener("click", closeModal);
logoutButton.addEventListener("click", () => window.CipaApp.logoutAndRedirect());

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closeModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
  }
});

loadCandidates();
