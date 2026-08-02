function normalizeMintUrl(mintUrl) {
  const url = new URL(mintUrl.trim());
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

export function describeMintInfo(info) {
  const methods = info?.nuts?.["4"]?.methods;
  const units = new Set(Array.isArray(methods) ? methods.map((method) => method.unit) : []);
  const supportsSat = units.has("sat");
  const supportsUsd = units.has("usd");
  return {
    supportsSat,
    supportsUsd,
    label: supportsSat && supportsUsd ? "sat + usd online" : "online"
  };
}

export async function inspectMint(mintUrl, fetchImpl = globalThis.fetch, timeoutMs = 5_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${normalizeMintUrl(mintUrl)}/v1/info`, {
      signal: controller.signal
    });
    if (!response.ok) return { status: "offline", label: `HTTP ${response.status}` };
    return { status: "online", ...describeMintInfo(await response.json()) };
  } catch {
    return { status: "offline", label: "indisponível / CORS" };
  } finally {
    clearTimeout(timeout);
  }
}

