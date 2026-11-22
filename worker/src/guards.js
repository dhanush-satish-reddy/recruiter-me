// Small pure helpers, kept separate so they can be unit-tested with plain Node.

// Safety net against invented facts: any number in the example answer that the
// candidate never wrote is replaced with a placeholder.
export function stripInventedNumbers(answer, candidateText) {
  const said = new Set((candidateText.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")));
  return answer.replace(/\d+(?:[.,]\d+)?(\s?%)?/g, (m, pct) => {
    const n = m.replace(/\s?%$/, "").replace(",", ".");
    return said.has(n) ? m : pct ? "[number] %" : "[number]";
  });
}
