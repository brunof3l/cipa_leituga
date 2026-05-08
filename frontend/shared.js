const SESSION_KEY = "cipa-session";
const DEVICE_KEY = "cipa-device-id";
const FALLBACK_PHOTO =
  "https://ui-avatars.com/api/?background=2563eb&color=ffffff&name=CIPA";

function createDeviceId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `device-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getDeviceId() {
  const storedDeviceId = localStorage.getItem(DEVICE_KEY);

  if (storedDeviceId) {
    return storedDeviceId;
  }

  const newDeviceId = createDeviceId();
  localStorage.setItem(DEVICE_KEY, newDeviceId);
  return newDeviceId;
}

function getSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);

  if (!raw) {
    return null;
  }

  try {
    const session = JSON.parse(raw);

    if (session?.expiresAt && Date.now() > Number(session.expiresAt)) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }

    return session;
  } catch (_error) {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

function setSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

function getAuthHeaders() {
  const session = getSession();

  const headers = {
    "X-Device-Id": getDeviceId(),
  };

  if (session?.token) {
    headers.Authorization = `Bearer ${session.token}`;
  }

  return headers;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
      ...(options.headers || {}),
    },
    ...options,
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
    }

    throw new Error(payload?.message || "Falha na requisicao.");
  }

  return payload;
}

async function logoutAndRedirect() {
  try {
    await apiRequest("/logout", { method: "POST" });
  } catch (_error) {
    // Ignora token expirado para garantir o redirecionamento.
  } finally {
    clearSession();
    window.location.href = "/index.html";
  }
}

function enforceRole(requiredRole) {
  const session = getSession();

  if (!session || session.role !== requiredRole) {
    clearSession();
    window.location.href = "/index.html";
    return null;
  }

  return session;
}

function withFallbackPhoto(imageElement, photoUrl, label) {
  imageElement.src = photoUrl || FALLBACK_PHOTO;
  imageElement.alt = label;
  imageElement.onerror = () => {
    imageElement.onerror = null;
    imageElement.src = `https://ui-avatars.com/api/?background=2563eb&color=ffffff&name=${encodeURIComponent(
      label || "CIPA"
    )}`;
  };
}

window.CipaApp = {
  apiRequest,
  clearSession,
  getDeviceId,
  enforceRole,
  getSession,
  logoutAndRedirect,
  setSession,
  withFallbackPhoto,
};
