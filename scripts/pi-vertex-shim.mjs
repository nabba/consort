// consort — Pi request shim for Google Vertex (a Pi extension, loaded with -e
// by pi-backend.sh next to the fence, only when CONSORT_PI_PROVIDER is
// google-vertex; not auto-discovered).
//
// 1. Gemini 4+ thinking. Pi picks the Gemini thinking control by matching the
//    model id against gemini-3(.x)-pro / gemini-3(.x)-flash. Any other id —
//    gemini-4-argon included — falls through to the Gemini 2.5 path and is
//    sent thinkingConfig.thinkingBudget, which Gemini 4 rejects outright (400
//    "Thinking budget is not supported for this model. Use thinking level
//    instead"). That includes the thinkingBudget:0 Pi sends for --thinking
//    off, so even the reachability probe failed. For a gemini-N id with
//    N >= 4 this hook rewrites the budget into a thinkingLevel. The level
//    comes from CONSORT_PI_THINKING (pi-backend.sh passes the same value to
//    --thinking), and a zero budget (Pi's "thinking off") maps to LOW. Measured
//    on gemini-4-argon, 2026-10-13: LOW, MEDIUM and HIGH are accepted;
//    MINIMAL and any thinkingBudget are refused, so minimal is raised to LOW.
//    With no thinkingConfig at all argon spent 0 thinking tokens, so for a
//    reviewer, dropping the budget silently would be a quiet quality loss.
//    Gemini 3.x and 2.x payloads, and a payload that already carries a
//    thinkingLevel (a future Pi that knows the model), are left untouched.
//
// 2. Priority PayGo (opt-in). CONSORT_VERTEX_PRIORITY=1 adds
//    X-Vertex-AI-LLM-Request-Type: shared and
//    X-Vertex-AI-LLM-Shared-Request-Type: priority, so the request takes
//    Vertex's priority queue at priority token rates (usageMetadata
//    trafficType ON_DEMAND_PRIORITY). Google serves it on the global
//    endpoint only.

const PI_EFFORT_TO_LEVEL = {
  off: "LOW", minimal: "LOW", low: "LOW", medium: "MEDIUM",
  high: "HIGH", xhigh: "HIGH", max: "HIGH",
};

// gemini-<major>[.<minor>]-... with major >= 4. Matched on the last path
// segment so a fully qualified publisher name is judged like the bare id.
export function isGemini4Plus(modelId) {
  const id = String(modelId ?? "").toLowerCase().split("/").pop();
  const m = /^gemini-(\d+)(?:[.-]|$)/.exec(id);
  return !!m && Number(m[1]) >= 4;
}

export function levelFor(budget, effort) {
  if (budget === 0) return "LOW";
  const level = PI_EFFORT_TO_LEVEL[String(effort ?? "high").toLowerCase()];
  if (!level) throw new Error(`consort vertex shim: unknown CONSORT_PI_THINKING '${effort}'`);
  return level;
}

// Returns a new payload, or undefined to keep Pi's payload as it is.
export function rewritePayload(payload, effort) {
  if (!payload || typeof payload !== "object" || !isGemini4Plus(payload.model)) return undefined;
  const tc = payload.config?.thinkingConfig;
  if (!tc || tc.thinkingBudget === undefined) return undefined;
  const { thinkingBudget, ...rest } = tc;
  return {
    ...payload,
    config: { ...payload.config, thinkingConfig: { ...rest, thinkingLevel: levelFor(thinkingBudget, effort) } },
  };
}

export function priorityHeaders(env) {
  if (env.CONSORT_VERTEX_PRIORITY !== "1") return {};
  return {
    "X-Vertex-AI-LLM-Request-Type": "shared",
    "X-Vertex-AI-LLM-Shared-Request-Type": "priority",
  };
}

export default function (pi) {
  const env = process.env;
  pi.on("before_provider_request", (event) => rewritePayload(event.payload, env.CONSORT_PI_THINKING));
  const extra = priorityHeaders(env);
  if (Object.keys(extra).length) {
    pi.on("before_provider_headers", (event) => { Object.assign(event.headers, extra); });
  }
}
