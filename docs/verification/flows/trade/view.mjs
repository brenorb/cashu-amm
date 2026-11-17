export const title = "Trade SAT and USD";
const waiting = {
  swapped: "Swapped, answer on its way",
  refunded: "Refunded, answer on its way",
  held: "Held, answer on its way",
};
const final = {
  choose: "Choose a token to trade",
  offline: "Connection lost, trade ID kept",
  traded: "Output token in your wallet",
  refund: "Refund token in your wallet",
  support: "Held for operator recovery",
  rejected: "Token refused, nothing taken",
};
export const state = (v) =>
  final[v.screen] ?? (v.pool === "untouched" ? "Trade in progress" : waiting[v.pool]);
const steps = {
  YouSubmit: "you press trade",
  PoolSwaps: "the pool swaps at the curve price",
  PoolRefunds: "the output fails and the pool refunds",
  PoolHolds: "the output and the refund both fail",
  RejectToken: "the mint refuses the token",
  ResponseLost: "the response is lost",
  YouRetry: "you press trade again",
};
const shown = {
  traded: "the page saves the output token",
  refund: "the page saves the refund token",
  support: "the page says the pool holds it",
};
export const step = (action, from, to) =>
  action === "ShowResult" ? shown[to.screen] : (steps[action] ?? null);
export const group = (v) =>
  ["traded", "refund"].includes(v.screen) ? "settled"
  : ["support", "rejected"].includes(v.screen) ? "stopped" : "working";
export const colors = { settled: "teal", stopped: "orange", working: "blue" };
