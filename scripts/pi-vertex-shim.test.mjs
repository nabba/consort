// node scripts/pi-vertex-shim.test.mjs — pins the Gemini 4+ thinking rewrite
// and the opt-in priority headers. Exit 0 = all green.
import { isGemini4Plus, levelFor, rewritePayload, priorityHeaders } from "./pi-vertex-shim.mjs";
import shim from "./pi-vertex-shim.mjs";

let fails = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}
const payload = (model, thinkingConfig) => ({
  model, contents: [{ role: "user", parts: [{ text: "x" }] }],
  config: { systemInstruction: "s", ...(thinkingConfig && { thinkingConfig }) },
});

// model family detection
check("argon is 4+", isGemini4Plus("gemini-4-argon"), true);
check("qualified argon is 4+", isGemini4Plus("publishers/google/models/gemini-4-argon"), true);
check("4.1 flash is 4+", isGemini4Plus("gemini-4.1-flash"), true);
check("bare gemini-5 is 4+", isGemini4Plus("gemini-5"), true);
check("double-digit major", isGemini4Plus("gemini-10-pro"), true);
check("3.1 pro is not", isGemini4Plus("gemini-3.1-pro-preview"), false);
check("2.5 pro is not", isGemini4Plus("gemini-2.5-pro"), false);
check("embedding is not", isGemini4Plus("gemini-embedding-2"), false);
check("flash-latest alias is not", isGemini4Plus("gemini-flash-latest"), false);
check("40-prefixed digits not misread", isGemini4Plus("gemini-3"), false);
check("undefined is not", isGemini4Plus(undefined), false);

// effort -> level
check("high -> HIGH", levelFor(16384, "high"), "HIGH");
check("default effort is high", levelFor(16384, undefined), "HIGH");
check("xhigh -> HIGH", levelFor(32768, "xhigh"), "HIGH");
check("max -> HIGH", levelFor(32768, "max"), "HIGH");
check("medium -> MEDIUM", levelFor(8192, "medium"), "MEDIUM");
check("low -> LOW", levelFor(2048, "low"), "LOW");
check("minimal raised to LOW (argon refuses MINIMAL)", levelFor(1024, "minimal"), "LOW");
check("budget 0 (thinking off) -> LOW whatever the effort", levelFor(0, "high"), "LOW");
let threw = false; try { levelFor(1, "bogus"); } catch { threw = true; }
check("unknown effort throws", threw, true);

// payload rewrite
const r = rewritePayload(payload("gemini-4-argon", { includeThoughts: true, thinkingBudget: 16384 }), "high");
check("argon budget -> level", r.config.thinkingConfig, { includeThoughts: true, thinkingLevel: "HIGH" });
check("rest of config kept", r.config.systemInstruction, "s");
check("model and contents kept", [r.model, r.contents.length], ["gemini-4-argon", 1]);
const off = rewritePayload(payload("gemini-4-argon", { thinkingBudget: 0 }), "high");
check("argon thinking-off probe -> LOW, no includeThoughts added", off.config.thinkingConfig, { thinkingLevel: "LOW" });
const orig = payload("gemini-4-argon", { includeThoughts: true, thinkingBudget: 16384 });
rewritePayload(orig, "high");
check("input payload not mutated", orig.config.thinkingConfig, { includeThoughts: true, thinkingBudget: 16384 });
check("3.1 pro untouched", rewritePayload(payload("gemini-3.1-pro-preview", { thinkingLevel: "HIGH" }), "high"), undefined);
check("2.5 budget untouched", rewritePayload(payload("gemini-2.5-pro", { thinkingBudget: 8192 }), "high"), undefined);
check("argon already on a level untouched", rewritePayload(payload("gemini-4-argon", { thinkingLevel: "MEDIUM" }), "high"), undefined);
check("argon without thinkingConfig untouched", rewritePayload(payload("gemini-4-argon"), "high"), undefined);
check("non-object payload untouched", rewritePayload(null, "high"), undefined);

// priority headers
check("priority off by default", priorityHeaders({}), {});
check("priority only on exactly 1", priorityHeaders({ CONSORT_VERTEX_PRIORITY: "true" }), {});
check("priority on", priorityHeaders({ CONSORT_VERTEX_PRIORITY: "1" }),
  { "X-Vertex-AI-LLM-Request-Type": "shared", "X-Vertex-AI-LLM-Shared-Request-Type": "priority" });

// extension wiring against a stub pi
function load(env) {
  const saved = { ...process.env };
  for (const k of ["CONSORT_VERTEX_PRIORITY", "CONSORT_PI_THINKING"]) delete process.env[k];
  Object.assign(process.env, env);
  const handlers = {};
  try { shim({ on: (ev, fn) => { handlers[ev] = fn; } }); } finally { process.env = saved; }
  return handlers;
}
let h = load({ CONSORT_PI_THINKING: "medium" });
check("no header hook without priority", "before_provider_headers" in h, false);
check("request hook uses CONSORT_PI_THINKING",
  h.before_provider_request({ payload: payload("gemini-4-argon", { thinkingBudget: 8192 }) }).config.thinkingConfig,
  { thinkingLevel: "MEDIUM" });
h = load({ CONSORT_VERTEX_PRIORITY: "1" });
const hdrs = { "x-goog-api-client": "keep" };
h.before_provider_headers({ headers: hdrs });
check("header hook adds priority, keeps existing", hdrs,
  { "x-goog-api-client": "keep", "X-Vertex-AI-LLM-Request-Type": "shared", "X-Vertex-AI-LLM-Shared-Request-Type": "priority" });

console.log(fails ? `${fails} FAILED` : "all green");
process.exit(fails ? 1 : 0);
