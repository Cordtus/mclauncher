export function authHeaders(): HeadersInit {
  const token = localStorage.getItem("ADMIN_TOKEN");
  const session = localStorage.getItem("ADMIN_SESSION");
  const headers: Record<string, string> = {};

  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers["X-Admin-Session"] = session;
  if (!token && session) headers.Authorization = `Session ${session}`;

  return headers;
}

export function jsonAuthHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...authHeaders(),
  };
}
