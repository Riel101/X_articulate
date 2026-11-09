// Snapshot of vm-ranker parameter defaults, NOT production settings or trained probabilities.
export const rankingWeights = {
  favorite: 0.5,
  reply: 5,
  retweet: 1,
  photo_expand: 0.05,
  video_open: 0.07,
  click: 0.3,
  open_link: 0.2,
  profile_click: 0,
  vqv: 0,
  share: 2,
  share_via_dm: 5,
  share_via_copy_link: 20,
  dwell: 0.05,
  quote: 5,
  quoted_click: 0.05,
  quoted_vqv: 0,
  dwell_time: 0.004,
  click_dwell_time: 0.4,
  video_continuation: 0,
  user_video_continuation: 0,
  profile_visit_secs: 0,
  follow_author: 4,
  not_interested: -47.52,
  block_author: -31.2,
  mute_author: -58.8,
  report: -234,
  not_dwelled: -0.02,
  post_unexplored: 0.02,
  post_video: 0,
  grok_analyze: 0,
} as const;
export type RankingSignal = keyof typeof rankingWeights;
export const rankingGuidance = {
  version: "x-informed-2026-11-09",
  source_commit: "3b6919f87532e57063bb3f1e85c2f509323b513e",
  sources: [
    "https://github.com/xai-org/x-algorithm/blob/3b6919f87532e57063bb3f1e85c2f509323b513e/xai-value-model/scoring.rs",
    "https://github.com/xai-org/x-algorithm/blob/3b6919f87532e57063bb3f1e85c2f509323b513e/vm-ranker/params.rs",
  ],
  evaluation_mode: "client_editorial_review",
  review_prompts: [
    "Name the intended audience and explain why this specific post would matter to them.",
    "Identify the promise in the opening and whether the body earns continued reading without padding.",
    "Explain what concrete insight might merit sharing, a thoughtful reply or following the author; cite the passage.",
    "Identify reasons for disinterest or negative feedback: audience mismatch, bait, spam, unsupported claims or repetitive filler. Do not manufacture controversy.",
    "Suggest specific rewritten passages. Compare alternatives using audience fit, usefulness, voice and these signals, then explain a preferred candidate qualitatively.",
    "Use observed account metrics as evidence only when available. Distinguish counts/rates from predicted per-viewer action probabilities.",
  ],
  limitations:
    "Text-only editorial proxy, not the X feed model. No viewer histories, trained Phoenix weights, live experiments, visibility labels, media features or competing feed candidates are available. Never claim reach, calibrated probabilities or exact feed rank.",
  simulation:
    "Optional weighted-sum component using supplied scenario values and published defaults only. Missing nonzero-weight inputs keep the score null. Offset, conditional/mutual-follow weights, eligibility, retrieval, author diversity and feed selection are excluded. Not calibrated; weights multiply predicted actions, not raw engagement counts.",
};
export function simulateRanking(
  predictions: {
    id: string;
    source: string;
    signals: Partial<Record<RankingSignal, number>>;
  }[],
  validIds: string[],
  candidateIds: string[] = validIds,
) {
  const scenarios = predictions.map((p) => {
    const missing = (Object.keys(rankingWeights) as RankingSignal[]).filter(
      (k) => rankingWeights[k] !== 0 && p.signals[k] === undefined,
    );
    const contributions = Object.entries(p.signals).map(([signal, value]) => ({
      signal,
      value,
      weight: rankingWeights[signal as RankingSignal],
      contribution: value! * rankingWeights[signal as RankingSignal],
    }));
    const partial = contributions.reduce((sum, c) => sum + c.contribution, 0);
    return {
      id: p.id,
      source: p.source,
      calibration: "unvalidated_scenario",
      missing_signals: missing,
      contributions,
      partial_weighted_sum: partial,
      weighted_sum: missing.length ? null : partial,
      deterministic_valid: validIds.includes(p.id),
    };
  });
  const missingCandidates = candidateIds.filter(
    (id) => !scenarios.some((s) => s.id === id),
  );
  const complete =
    scenarios.length > 0 &&
    missingCandidates.length === 0 &&
    scenarios.every((s) => s.weighted_sum !== null);
  const order = complete
    ? [...scenarios]
        .filter((s) => s.deterministic_valid)
        .sort((a, b) => b.weighted_sum! - a.weighted_sum!)
    : [];
  return {
    type: "public_weight_component_simulation",
    basis: rankingGuidance,
    scenarios,
    missing_candidate_ids: missingCandidates,
    scenario_order: order.map((s) => s.id),
    preferred_scenario_id: order[0]?.id ?? null,
  };
}
