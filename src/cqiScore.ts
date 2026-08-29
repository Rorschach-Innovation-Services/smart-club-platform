/* ─── CQI scoring — pure, React-free ───
   Extracted from atoms.tsx so it can be imported outside the SPA (e.g. the
   export-cohort CLI in packages/api). atoms.tsx re-exports both symbols, so every
   existing frontend call site is unchanged. Do NOT change the scoring behavior here
   without updating the spreadsheet model it mirrors. */

import { CQI_STRUCTURE } from './data';

export function cqiBand(score: number) {
  if (score === 0) return { tone: 'muted', label: 'Pending' };
  if (score >= 80) return { tone: 'teal', label: 'A · ' + score.toFixed(1) };
  if (score >= 65) return { tone: 'navy', label: 'B · ' + score.toFixed(1) };
  if (score >= 50) return { tone: 'gold', label: 'C · ' + score.toFixed(1) };
  return { tone: 'coral', label: 'D · ' + score.toFixed(1) };
}

/* CQI live scoring — mirrors the spreadsheet weighting model.
   Each question contributes its `pts` value, scaled by yes/no or by num/max.
   Section total = sum of pts (which roughly equals the section weight),
   we then proportion to the section weight and total to 100. */
export function scoreCQI(answers: Record<string, any>) {
  let totalScore = 0;
  const byCat: Record<string, { earned: number; possible: number }> = {};
  for (const cat of CQI_STRUCTURE) {
    let earned = 0,
      possible = 0;
    // Representation 'count' questions score on each race's SHARE of the category
    // total (head-count ÷ total counted), so the diversity weighting is preserved
    // even though the input is now a raw count rather than a percentage.
    const countTotal = cat.questions
      .filter((q) => q.kind === 'count')
      .reduce((s, q) => s + (parseFloat(answers[q.key]) || 0), 0);
    for (const q of cat.questions) {
      possible += q.pts;
      const v = answers[q.key];
      if (q.kind === 'yn') {
        if (v === true) earned += q.pts;
      } else if (q.kind === 'num') {
        const max = q.max || 10;
        const num = Math.max(0, Math.min(max, parseFloat(v) || 0));
        earned += (num / max) * q.pts;
      } else if (q.kind === 'count') {
        // Representation: each race earns points in proportion to its share of the
        // club's counted players. Black African is weighted 1.5× per the spreadsheet.
        const share = countTotal > 0 ? (parseFloat(v) || 0) / countTotal : 0;
        const weight = q.key === 'pctBA' ? 1.5 : 1.0;
        earned += Math.min(q.pts, share * q.pts * weight);
      } else if (q.kind === 'rating') {
        // 1–5 Likert: proportional credit (rating ÷ 5).
        const num = Math.max(0, Math.min(5, parseFloat(v) || 0));
        earned += (num / 5) * q.pts;
      } else if (q.kind === 'choice') {
        // Any option selected = full points
        if (v) earned += q.pts;
      } else if (q.kind === 'money') {
        // A positive amount = full points (presence of structure matters)
        const num = parseFloat(v) || 0;
        if (num > 0) earned += q.pts;
      }
    }
    const sectionScore = possible > 0 ? (earned / possible) * cat.weight : 0;
    byCat[cat.key] = { earned: sectionScore, possible: cat.weight };
    totalScore += sectionScore;
  }
  return { total: Math.round(totalScore * 10) / 10, byCat };
}
