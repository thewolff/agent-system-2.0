import { readFileSync } from "node:fs";

const SIX_MONTHS = 6;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addMonthsClamped(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay));
}

function evidenceDate(record, label, asOf, warnings) {
  const reason = record?.reason || "not collected";
  if (!record || record.date === null || record.date === undefined) {
    warnings.push(`${label} date is unknown (${reason}). Risk: maintenance freshness cannot be established. Exit: verify the dated upstream evidence manually.`);
    return `unknown (${reason})`;
  }
  if (!validDate(record.date)) {
    warnings.push(`${label} date is malformed; release/commit freshness cannot be established. Risk: stale maintenance may be missed. Exit: verify the dated upstream evidence manually.`);
    return `unknown (invalid date; ${reason})`;
  }
  if (!hasReceipt(record.receipt)) {
    warnings.push(`${label} date has no receipt. Risk: the reported date is unverifiable. Exit: provide the fetched URL and observed result.`);
    return `unknown (date lacks receipt; ${reason})`;
  }
  const date = Date.UTC(...record.date.split("-").map(Number).map((part, index) => index === 1 ? part - 1 : part));
  if (date > asOf) {
    warnings.push(`${label} date is after as-of date. Risk: chronology is inconsistent. Exit: correct the date or collection as-of value using the source evidence.`);
    return `unknown (after as-of date; ${reason})`;
  }
  return `${record.date} — ${record.receipt}`;
}

function countValue(record, key, label, warnings, { warnZero = false } = {}) {
  const value = record?.[key];
  if (value === null || value === undefined) {
    warnings.push(`${label} is unknown (${record?.reason || "not collected"}). Risk: maintenance evidence is incomplete. Exit: collect this value with its source receipt or retain the uncertainty.`);
    return `unknown (${record?.reason || "not collected"})`;
  }
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative number or null`);
  if (!hasReceipt(record.receipt)) {
    warnings.push(`${label} has no receipt. Risk: the count cannot substantiate maintenance health. Exit: supply the source URL and observed result.`);
    return `unknown (count lacks receipt${record.reason ? `; ${record.reason}` : ""})`;
  }
  if (warnZero && value === 0) warnings.push(`No active human maintainers were evidenced. Risk: no accountable maintainer may respond or ship fixes. Exit: identify an active human maintainer or treat upkeep as unknown/high risk.`);
  return `${value} — ${record.receipt}`;
}


function hasReceipt(receipt) {
  return typeof receipt === "string" && receipt.trim().length > 0;
}

export function renderUpkeep(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("evidence must be a JSON object");
  const { candidate, asOf, window, exitPath } = input;
  if (typeof candidate !== "string" || !candidate.trim()) throw new TypeError("candidate must be a non-empty string");
  if (!validDate(asOf)) throw new TypeError("asOf must be a valid YYYY-MM-DD date");
  if (typeof window !== "string" || !window.trim()) throw new TypeError("window must disclose the activity interval");
  if (typeof exitPath !== "string" || !exitPath.trim()) throw new TypeError("exitPath must be non-empty text");
  const asOfMs = Date.UTC(...asOf.split("-").map(Number).map((part, index) => index === 1 ? part - 1 : part));
  const warnings = [];
  const commit = evidenceDate(input.lastCommit, "Last commit", asOfMs, warnings);
  const release = evidenceDate(input.lastRelease, "Last release", asOfMs, warnings);
  if (input.lastRelease?.date && validDate(input.lastRelease.date) && hasReceipt(input.lastRelease.receipt)) {
    const releaseAnniversary = addMonthsClamped(input.lastRelease.date, SIX_MONTHS);
    if (asOfMs >= releaseAnniversary) {
      warnings.push(`Last release is at least six calendar months old (${input.lastRelease.date}). Risk: users may be relying on an unmaintained release stream. Exit: verify an active alternative or plan migration away.`);
    }
  }
  const issues = input.issues;
  const issueSummary = ["opened", "closed", "sampleSize", "unanswered"].map((key) => `${key}: ${countValue(issues, key, `Issues ${key}`, warnings)}`).join("; ");
  const median = issues?.medianFirstHumanResponseHours;
  const sampleSize = issues?.sampleSize;
  const unanswered = issues?.unanswered;
  const noHumanResponse = median === null || median === undefined || !Number.isFinite(sampleSize) || sampleSize <= 0
    || (Number.isFinite(unanswered) && unanswered >= sampleSize)
    || !hasReceipt(issues?.receipt);
  let response;
  if (noHumanResponse) response = `unknown (${issues?.reason || "no measurable human response"})`;
  else if (!Number.isFinite(median) || median < 0) throw new TypeError("medianFirstHumanResponseHours must be non-negative or null");
  else response = `${median} hours — ${issues.receipt}`;
  if (noHumanResponse) warnings.push("No measurable human response is evidenced. Risk: reports may receive no human attention. Exit: collect human-only response evidence or treat support as unknown/high risk.");
  const maintainers = input.maintainers;
  const maintainerCount = maintainers?.count;
  const maintainerText = countValue(maintainers, "count", "Active human maintainers", warnings, { warnZero: true });
  if (maintainerCount === null || maintainerCount === undefined) warnings.push(`Active human maintainer count is unknown (${maintainers?.reason || "not collected"}). Risk: accountable upkeep is unverified. Exit: identify active human maintainers or retain this uncertainty.`);
  else if (maintainerCount === 1 && hasReceipt(maintainers?.receipt)) warnings.push("Only one active human maintainer is evidenced. Risk: upkeep depends on a single person. Exit: identify backup maintainers or treat continuity as a risk.");
  const compatibility = Array.isArray(input.compatibility) && input.compatibility.length ? input.compatibility : null;
  const compatibilityLines = compatibility ? compatibility.map((item) => {
    const receiptsValid = hasReceipt(item?.detectionReceipt) && hasReceipt(item?.supportReceipt);
    const installedValid = typeof item?.installed === "string" && item.installed.trim().length > 0;
    const provenanceValid = receiptsValid && installedValid;
    const reportedStatus = ["supported", "unsupported", "unknown"].includes(item?.status) ? item.status : "unknown";
    const status = provenanceValid ? reportedStatus : "unknown";
    const installed = installedValid ? item.installed : "unknown";
    const detection = hasReceipt(item?.detectionReceipt) ? item.detectionReceipt : "no detection receipt";
    const support = hasReceipt(item?.supportReceipt) ? item.supportReceipt : "no support receipt";
    if (status === "unsupported") warnings.push(`${item.runtime} is reported unsupported. Risk: the selected runtime may not work. Exit: select a supported runtime or verify a replacement.`);
    if (status === "unknown") warnings.push(`${item?.runtime || "Runtime"} compatibility is unknown${item?.reason ? ` (${item.reason})` : ""}${!provenanceValid ? " (installed version or required receipt missing)" : ""}. Risk: runtime fit is unverified. Exit: verify installed and supported versions before relying on it.`);
    return `- ${item?.runtime || "Unspecified runtime"}: ${status}; installed ${installed}; detection: ${detection}; support: ${support}${item?.reason ? `; reason: ${item.reason}` : ""}`;
  }).join("\n") : "- unknown (not collected)";
  if (!compatibility) warnings.push("No runtime compatibility evidence was collected. Risk: required runtime fit is unknown. Exit: verify each essential runtime separately.");
  const warningText = warnings.length ? `**Upkeep warning:**\n${warnings.map((warning) => `- ${warning} Exit path: ${exitPath}`).join("\n")}` : "- None identified from the supplied evidence.";
  return `**Upkeep — ${candidate}:**\n\n- As of: ${asOf}\n- Activity window: ${window}\n- Last commit: ${commit}\n- Last release: ${release}\n- Issues: ${issueSummary}${issues?.reason ? `; reason: ${issues.reason}` : ""}; median first human response: ${response}\n- Active human maintainers: ${maintainerText}\n- Runtime compatibility:\n${compatibilityLines}\n\nWarnings / exit paths:\n${warningText}\n`;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error("usage: node upkeep.mjs EVIDENCE.json");
  const input = JSON.parse(readFileSync(argv[0], "utf8"));
  process.stdout.write(renderUpkeep(input));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
