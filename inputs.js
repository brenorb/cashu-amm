export function parseInteger(value, label) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized) || normalized === "0") {
    throw new Error(`${label} precisa ser um inteiro maior que zero.`);
  }
  return BigInt(normalized);
}

export function parseUsd(value, label = "USD") {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) {
    throw new Error(`${label} deve ter no máximo duas casas decimais.`);
  }
  const [whole, fraction = ""] = normalized.split(".");
  const cents = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  if (cents <= 0n) throw new Error(`${label} precisa ser maior que zero.`);
  return cents;
}
