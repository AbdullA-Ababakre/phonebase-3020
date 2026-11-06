import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJevLocateRequest,
  OPENROUTER_JEV_MODEL,
  parseJevLocateResponse,
  qualifyJevActionCandidate,
} from "./openrouter-jev";

test("builds one Jev visibility and box request around the same screenshot", () => {
  const request = buildJevLocateRequest("Weather", "data:image/jpeg;base64,AA==");
  assert.equal(request.model, OPENROUTER_JEV_MODEL);
  assert.equal(request.questions.target_visible.type, "noul");
  assert.equal(request.questions.target_box.type, "box");
  assert.match(request.questions.target_box.instructions, /Weather/);
});

test("lets Jev qualify a visible, bounded target and uses agreement for a narrow confidence recovery", () => {
  const box = { top: 0.88, bottom: 0.96, left: 0.52, right: 0.68 };
  assert.deepEqual(qualifyJevActionCandidate({
    visibleProbability: 0.98,
    confidence: 0.91,
    box,
  }).qualifiedBy, "jev");
  const jevPrimary = qualifyJevActionCandidate({
    visibleProbability: 0.98,
    confidence: 0.37,
    box,
    plannerPoint: { x: 0.6, y: 0.92 },
  });
  assert.equal(jevPrimary.safeToAct, true);
  assert.equal(jevPrimary.qualifiedBy, "jev");
  assert.equal(jevPrimary.plannerAgreement, true);
  assert.equal(qualifyJevActionCandidate({
    visibleProbability: 0.98,
    confidence: 0.37,
    box,
    plannerPoint: { x: 0.2, y: 0.2 },
  }).safeToAct, true);
  assert.equal(qualifyJevActionCandidate({
    visibleProbability: 0.89,
    confidence: 0.6,
    box,
  }).safeToAct, true);
  assert.equal(qualifyJevActionCandidate({
    visibleProbability: 0.89,
    confidence: 0.54,
    box,
  }).safeToAct, false);
  const learnedMessagesCase = qualifyJevActionCandidate({
    visibleProbability: 0.95,
    confidence: 0.34,
    box,
    plannerPoint: { x: 0.616, y: 0.929 },
  });
  assert.equal(learnedMessagesCase.safeToAct, true);
  assert.equal(learnedMessagesCase.qualifiedBy, "planner+jev");
  assert.equal(qualifyJevActionCandidate({
    visibleProbability: 0.95,
    confidence: 0.34,
    box,
    plannerPoint: { x: 0.2, y: 0.2 },
  }).safeToAct, false);
  assert.equal(qualifyJevActionCandidate({
    visibleProbability: 0.79,
    confidence: 0.9,
    box,
  }).safeToAct, false);
});

test("parses a bounded Jev box with usage and rejects malformed coordinates", () => {
  assert.deepEqual(parseJevLocateResponse({
    model: "typesafe/jev-1.14",
    provider: "TypeSafe",
    answers: {
      target_visible: { type: "noul", noul: 0.97 },
      target_box: {
        type: "box",
        box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
        confidence: 0.91,
      },
    },
    usage: { input_tokens: 321, output_tokens: 0, cost: 0.000013482 },
    id: "decision-1",
  }), {
    model: "typesafe/jev-1.14",
    provider: "TypeSafe",
    visibleProbability: 0.97,
    confidence: 0.91,
    box: { top: 0.1, bottom: 0.3, left: 0.2, right: 0.4 },
    usage: { inputTokens: 321, outputTokens: 0, cost: 0.000013482 },
    requestId: "decision-1",
  });
  assert.throws(() => parseJevLocateResponse({
    answers: {
      target_visible: { noul: 0.9 },
      target_box: { box: { top: 0.8, bottom: 0.2, left: 0.1, right: 0.2 }, confidence: 0.8 },
    },
  }), /inverted/i);
});
