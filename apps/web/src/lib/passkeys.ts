import { authHeaders, jsonAuthHeaders } from "./auth";

function base64urlToArrayBuffer(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function arrayBufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCreationOptions(options: any): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: base64urlToArrayBuffer(options.challenge),
    user: {
      ...options.user,
      id: base64urlToArrayBuffer(options.user.id),
    },
    excludeCredentials: (options.excludeCredentials || []).map((credential: any) => ({
      ...credential,
      id: base64urlToArrayBuffer(credential.id),
    })),
  };
}

function decodeRequestOptions(options: any): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: base64urlToArrayBuffer(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential: any) => ({
      ...credential,
      id: base64urlToArrayBuffer(credential.id),
    })),
  };
}

function credentialTransports(response: AuthenticatorAttestationResponse): string[] {
  if (typeof response.getTransports !== "function") return [];
  return response.getTransports();
}

function serializeRegistrationCredential(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: arrayBufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
      attestationObject: arrayBufferToBase64url(response.attestationObject),
      transports: credentialTransports(response),
    },
  };
}

function serializeAuthenticationCredential(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: arrayBufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: arrayBufferToBase64url(response.clientDataJSON),
      authenticatorData: arrayBufferToBase64url(response.authenticatorData),
      signature: arrayBufferToBase64url(response.signature),
      userHandle: response.userHandle ? arrayBufferToBase64url(response.userHandle) : null,
    },
  };
}

async function readJsonResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

export function passkeysAvailable(): boolean {
  return Boolean(
    window.isSecureContext &&
    window.PublicKeyCredential &&
    navigator.credentials?.create &&
    navigator.credentials?.get
  );
}

export type PasskeyRegistrationCode = {
  id: string;
  label: string | null;
  source: "env" | "generated";
  createdAt: string;
  usedAt: string | null;
  usedByCredentialId: string | null;
};

export async function registerPasskey(name: string, setupCode?: string) {
  const optionsResponse = await fetch("/api/auth/passkeys/register/options", {
    method: "POST",
    headers: jsonAuthHeaders(),
    credentials: "include",
    body: JSON.stringify({ name, setupCode: setupCode?.trim() || undefined }),
  });
  const optionsData = await readJsonResponse(optionsResponse);
  const credential = await navigator.credentials.create({
    publicKey: decodeCreationOptions(optionsData.publicKey),
  }) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey registration was cancelled");

  const verificationResponse = await fetch("/api/auth/passkeys/register/verify", {
    method: "POST",
    headers: jsonAuthHeaders(),
    credentials: "include",
    body: JSON.stringify(serializeRegistrationCredential(credential)),
  });
  return readJsonResponse(verificationResponse);
}

export async function createPasskeyRegistrationCode(label?: string) {
  const response = await fetch("/api/auth/passkeys/registration-codes", {
    method: "POST",
    headers: jsonAuthHeaders(),
    credentials: "include",
    body: JSON.stringify({ label: label?.trim() || undefined }),
  });
  const data = await readJsonResponse(response);
  return data.code as PasskeyRegistrationCode & { code: string };
}

export async function listPasskeyRegistrationCodes() {
  const response = await fetch("/api/auth/passkeys/registration-codes", {
    credentials: "include",
  });
  const data = await readJsonResponse(response);
  return data.codes as PasskeyRegistrationCode[];
}

export async function deletePasskeyRegistrationCode(id: string) {
  const response = await fetch(`/api/auth/passkeys/registration-codes/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
    credentials: "include",
  });
  return readJsonResponse(response);
}

export async function loginWithPasskey() {
  const optionsResponse = await fetch("/api/auth/passkeys/login/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: "{}",
  });
  const optionsData = await readJsonResponse(optionsResponse);
  const credential = await navigator.credentials.get({
    publicKey: decodeRequestOptions(optionsData.publicKey),
  }) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey sign-in was cancelled");

  const verificationResponse = await fetch("/api/auth/passkeys/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(serializeAuthenticationCredential(credential)),
  });
  return readJsonResponse(verificationResponse);
}

export async function logoutPasskeySession() {
  const response = await fetch("/api/auth/logout", {
    method: "POST",
    headers: authHeaders(),
    credentials: "include",
  });
  return readJsonResponse(response);
}
