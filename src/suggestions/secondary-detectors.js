import { readFile as defaultReadFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const lineSnippet = (line) => line.trim().slice(0, 160);
const homeOf = (home) => (typeof home === "string" && home ? home : os.homedir());

export function detectKeywordOrRuleTable(text, keywords) {
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (keywords.some((keyword) => keyword.test(lines[index]))) {
      return { line: index + 1, snippet: lineSnippet(lines[index]), reason: "keyword-match" };
    }
  }
  const ruleId = /\|\s*[A-Za-z]{1,6}-\d{1,4}\s*\|/;
  for (let index = 0; index < lines.length; index += 1) {
    if (ruleId.test(lines[index])) {
      return { line: index + 1, snippet: lineSnippet(lines[index]), reason: "rule-id-table" };
    }
  }
  return null;
}

export function detectNumericCapNearKeywords(text) {
  const CAP_PHRASE = /\b(?:at most|up to|no more than|max(?:imum)?|cap(?:ped)?(?: at)?|limit(?:ed)?(?: to)?|exceed)\b[^\d\n]{0,15}\d+/i;
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (/concurrent|parallel|sub-agent/i.test(lines[index]) && CAP_PHRASE.test(lines[index])) {
      return { line: index + 1, snippet: lineSnippet(lines[index]), reason: "numeric-cap-near-keyword" };
    }
  }
  return null;
}

export function detectPreserveNearCompact(text) {
  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!/compact/i.test(lines[index])) continue;
    for (let nearby = Math.max(0, index - 5); nearby <= Math.min(lines.length - 1, index + 5); nearby += 1) {
      if (/preserve/i.test(lines[nearby])) {
        return { line: nearby + 1, snippet: lineSnippet(lines[nearby]), reason: "preserve-near-compact" };
      }
    }
  }
  return null;
}

export async function detectLaunchCommandFlag({ binaryNames, flagPattern, env, home, readFile = defaultReadFile }) {
  const filenames = [".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile"];
  for (const filename of filenames) {
    let text;
    try {
      text = await readFile(path.join(homeOf(home), filename), "utf8");
    } catch {
      continue;
    }
    const lines = String(text).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (binaryNames.some((name) => new RegExp(`\\b${name}\\b`).test(lines[index])) && flagPattern.test(lines[index])) {
        return {
          line: index + 1,
          snippet: lineSnippet(lines[index]),
          reason: "launch-command-flag",
          sourceFile: `~/${filename}`,
        };
      }
    }
  }
  return null;
}
