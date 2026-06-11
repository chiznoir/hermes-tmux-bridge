function stripSyntheticSkillBlock(match) {
  return /<path>[^<]*\/skills\/[^<]*\/SKILL\.md<\/path>|^<skill>\s*<name>[^<]+<\/name>/s.test(match.trim()) ? '\n' : match;
}

function escapedLineBreakPattern() {
  return String.raw`(?:\n|\\n)`;
}

function hasSyntheticPromptContract(text) {
  const lineBreak = escapedLineBreakPattern();
  const behaviorContract = new RegExp(String.raw`Reference behavior contract:\s*${lineBreak}-+\s*BEGIN [A-Z][A-Z -]*PROMPT\s*-+\s*${lineBreak}---`);
  const frontmatterIdentity = new RegExp(String.raw`---${lineBreak}(?=[\s\S]{0,1600}\bdescription\s*:)(?=[\s\S]{0,1600}\bargument-hint\s*:)[\s\S]{0,1600}?${lineBreak}---\s*(?:${lineBreak})?\s*<identity>`, 's');
  return behaviorContract.exec(text) || frontmatterIdentity.exec(text);
}

function hasSyntheticUserRequestMarker(text) {
  const lineBreak = escapedLineBreakPattern();
  return new RegExp(String.raw`${lineBreak}User request:\s*${lineBreak}`, 's').test(text);
}

function stripSyntheticHarnessPrompt(text) {
  const trimmedStart = text.trimStart();
  const body = trimmedStart.replace(/^["']/, '');
  const contractMatch = hasSyntheticPromptContract(body);
  if (!contractMatch || contractMatch.index > 800) return text;
  if (hasSyntheticUserRequestMarker(body)) return '\n';

  const afterContractStart = body.slice(contractMatch.index + contractMatch[0].length).trim();
  if (!afterContractStart || /^(description:|argument-hint:|<identity>|-+\s*END [A-Z][A-Z -]*PROMPT\s*-+)/.test(afterContractStart)) {
    return '\n';
  }

  return afterContractStart.replace(/^["']\s*/, '\n');
}

export function stripSyntheticNotificationContext(text) {
  const original = String(text || '');
  const rawNormalized = original.replace(/\r\n/g, '\n');
  const normalized = stripSyntheticHarnessPrompt(rawNormalized);
  const stripped = normalized
    .replace(/(?:^|\n)# AGENTS\.md instructions for [^\n]*(?:\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>)?(?:\s*<environment_context>[\s\S]*?<\/environment_context>)?/g, '\n')
    .replace(/(?:^|\n)\s*<environment_context>[\s\S]*?<\/environment_context>\s*/g, '\n')
    .replace(/(?:^|\n)\s*<codex_internal_context\b[^>]*>[\s\S]*?<\/codex_internal_context>\s*/g, '\n')
    .replace(/(?:^|\n)\s*<hook_prompt\b[^>]*>[\s\S]*?<\/hook_prompt>\s*/g, '\n')
    .replace(/(?:^|\n)\s*<turn_aborted>[\s\S]*?<\/turn_aborted>\s*/g, '\n')
    .replace(/(?:^|\n)\s*<subagent_notification>[\s\S]*?<\/subagent_notification>\s*/g, '\n')
    .replace(/(?:^|\n)\s*<skill>[\s\S]*?<\/skill>\s*/g, stripSyntheticSkillBlock)
    .replace(/\n{3,}/g, '\n\n');
  return stripped === rawNormalized ? original : stripped.trim();
}
