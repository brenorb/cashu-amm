export const WALLET_STORAGE_KEY = "cashu-amm:test-wallet:v1";

const ASSETS = new Set(["sat", "usd", "lp"]);
const emptyState = () => ({ sat: [], usd: [], lp: [] });

function readState(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "null");
    if (!parsed || typeof parsed !== "object") return emptyState();
    const state = emptyState();
    for (const asset of ASSETS) {
      if (!Array.isArray(parsed[asset])) continue;
      state[asset] = parsed[asset].filter((entry) =>
        entry
        && typeof entry.token === "string"
        && entry.token.startsWith("cashu")
        && Number.isSafeInteger(entry.amount)
        && entry.amount > 0
      );
    }
    return state;
  } catch {
    return emptyState();
  }
}

export function createTokenWallet(storage, key = WALLET_STORAGE_KEY) {
  let state = readState(storage, key);

  const persist = () => storage.setItem(key, JSON.stringify(state));
  const requireAsset = (asset) => {
    if (!ASSETS.has(asset)) throw new TypeError(`Unsupported wallet asset: ${asset}`);
  };

  return {
    list(asset) {
      requireAsset(asset);
      return state[asset].map((entry) => ({ ...entry }));
    },

    total(asset) {
      requireAsset(asset);
      return state[asset].reduce((sum, entry) => sum + entry.amount, 0);
    },

    latest(asset) {
      requireAsset(asset);
      const entry = state[asset].at(-1);
      return entry ? { ...entry } : null;
    },

    find(token) {
      for (const asset of ASSETS) {
        const entry = state[asset].find((candidate) => candidate.token === token);
        if (entry) return { asset, ...entry };
      }
      return null;
    },

    add(asset, amount, token) {
      requireAsset(asset);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new TypeError("Wallet token amount must be a positive safe integer");
      }
      if (typeof token !== "string" || !token.startsWith("cashu")) {
        throw new TypeError("Wallet token must be Cashu bearer data");
      }
      for (const candidate of ASSETS) {
        state[candidate] = state[candidate].filter((entry) => entry.token !== token);
      }
      state[asset].push({ token, amount, savedAt: Date.now() });
      persist();
    },

    remove(token) {
      let removed = false;
      for (const asset of ASSETS) {
        const next = state[asset].filter((entry) => entry.token !== token);
        removed ||= next.length !== state[asset].length;
        state[asset] = next;
      }
      if (removed) persist();
      return removed;
    },

    clear() {
      state = emptyState();
      storage.removeItem(key);
    }
  };
}
