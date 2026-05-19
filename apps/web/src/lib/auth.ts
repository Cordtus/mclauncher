export function authHeaders(): HeadersInit {
  return {};
}

export function jsonAuthHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...authHeaders(),
  };
}

export async function loginWithAdminToken(token: string) {
  const response = await fetch("/api/auth/token/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

export async function loginWithDevAdmin() {
  const response = await fetch("/api/auth/dev/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

export async function readAdminSession() {
  const response = await fetch("/api/auth/session", {
    credentials: "include",
  });
  const data = await response.json().catch(() => ({}));
  return Boolean(response.ok && data.authenticated);
}
