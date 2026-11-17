export const title = "Add SAT + USD liquidity";
const screens = {
  choose: "Choose SAT and USD tokens",
  checking: "Both tokens received",
  added: "LP token in your wallet",
  refused: "SAT token refused, nothing taken",
};
export const state = (v) => {
  if (screens[v.screen]) return screens[v.screen];
  if (v.screen === "receiving") return v.took.length ? "SAT received" : "Sending tokens";
  if (v.screen === "refunding") return "Returning your tokens";
  if (v.screen === "refunded") return v.took.length === 2 ? "Both tokens returned" : "SAT token returned";
  return v.back.length ? "Part returned, rest held for recovery" : "Held for operator recovery";
};
const steps = {
  YouAdd: "you press add liquidity",
  PoolTakesSat: "the pool receives the SAT token",
  PoolTakesUsd: "the pool receives the USD token",
  SatRefused: "the mint refuses the SAT token",
  UsdRefused: "the mint refuses the USD token",
  PoolIssuesLp: "the pool issues LP shares",
  WrongProportion: "the amounts do not match the pool price",
  RefundsMade: "every refund succeeds",
  SomeRefundFails: "a refund fails",
};
export const step = (action) => steps[action] ?? null;
export const group = (v) =>
  ["added", "refunded"].includes(v.screen) ? "settled"
  : ["held", "refused"].includes(v.screen) ? "stopped" : "working";
export const colors = { settled: "teal", stopped: "orange", working: "blue" };
