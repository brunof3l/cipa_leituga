const loginForm = document.getElementById("login-form");
const passwordInput = document.getElementById("password");
const feedback = document.getElementById("feedback");

const currentSession = window.CipaApp.getSession();
if (currentSession?.role === "voter") {
  window.location.href = "/voter.html";
}

if (currentSession?.role === "admin") {
  window.location.href = "/admin.html";
}

function showFeedback(message, type) {
  feedback.textContent = message;
  feedback.className =
    "mt-4 rounded-2xl border px-4 py-3 text-sm " +
    (type === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700");
  feedback.classList.remove("hidden");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.classList.add("hidden");

  const password = passwordInput.value.trim();

  try {
    const session = await window.CipaApp.apiRequest("/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });

    window.CipaApp.setSession(session);
    showFeedback("Acesso autorizado. Redirecionando...", "success");

    window.setTimeout(() => {
      window.location.href = session.role === "admin" ? "/admin.html" : "/voter.html";
    }, 450);
  } catch (error) {
    showFeedback(error.message, "error");
  }
});
