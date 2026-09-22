// Version-qualified GUI support. A combination is only `supported` once the live protocol in
// docs/vscode-compatibility.md has passed for it; everything else is experimental at best.

/** From the extension's published prerequisites (code.claude.com/docs/en/vs-code, 2026-09-23). */
export const MIN_VSCODE = "1.94.0";

/**
 * Combinations that have been tested live. Each record names what was observed, so the
 * doctor can say exactly which combination a claim rests on. Empty until evidence exists.
 * @type {{ vscode: string, extension: string, status: "supported"|"experimental"|"incompatible", date: string, note: string }[]}
 */
export const TESTED = [];

export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = String(b).split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Classifies a discovered combination; unknown versions are never promoted to supported. */
export function classify({ vscode, extension, tested = TESTED }) {
  if (vscode && compareVersions(vscode, MIN_VSCODE) < 0) {
    return { status: "incompatible", note: `the Claude Code extension requires VS Code ${MIN_VSCODE} or later` };
  }
  if (!vscode || !extension) {
    return { status: "experimental", note: "versions could not be discovered, so no tested combination applies" };
  }
  const record = tested.find((entry) => entry.vscode === vscode && entry.extension === extension);
  if (record) return { status: record.status, note: `${record.note} (tested ${record.date})` };
  return { status: "experimental", note: `VS Code ${vscode} with extension ${extension} has not been tested live` };
}
