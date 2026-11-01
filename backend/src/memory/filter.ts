// M11: what a memory line may say. Memory is data, never instructions: a fact that reads as an
// order to the assistant (a planted prompt injection, "ignore previous instructions", "you must ...")
// is refused before it is written, both from remember and from dreaming. The list catches known
// attack wording only; a planted fact in plain words passes, bounded by provenance and the turn
// rules (see .pi/handoff/m11-contract.md and Codync's bot-memory design).

/** Zero-width and bidi control characters: invisible text has no place in a memory line. */
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** Where a sentence starts: the text's start or after . ! ? ; : , a newline or a quote. */
const START = String.raw`(?:^|[.!?;:,\n"“'(]\s*)`;

const PATTERNS: RegExp[] = [
  // "ignore / disregard / forget / override (all) previous / your / the above instructions"
  /\b(ignore|disregard|forget|override|bypass)\s+(all\s+|any\s+|the\s+|of\s+)*(previous|prior|earlier|above|preceding|your|my|these|those|system|original|existing)\s+(instructions?|prompts?|rules?|guidelines?|directives?|orders)\b/,
  /\b(ignore|disregard)\s+(all|everything)\s+(above|before|previous|prior|else)\b/,
  /\b(ignore|disregard|forget)\s+(the|your|all)\s+(instructions?|prompts?|directives?)\b/,
  // talking about the model's own configuration ("system prompt", "your instructions")
  /\b(system|developer|hidden|initial)\s+(prompt|instructions?)\b|\byour\s+(system\s+)?(prompt|instructions)\b/,
  /\bjailbreak\s+(mode|prompt)\b|\bdan\s+mode\b|\bdo\s+anything\s+now\b/,
  // re-defining the assistant
  /\byou\s+are\s+now\b|\bfrom\s+now\s+on\s*,?\s+(you|the\s+assistant|claude|open\s*duet)\b/,
  new RegExp(`${START}you\\s+(must|shall|have\\s+to|need\\s+to|are\\s+required\\s+to|will\\s+always|will\\s+never|always\\s+must|must\\s+always|must\\s+never)\\b`),
  /\b(the\s+assistant|claude|open\s*duet|the\s+ai|the\s+model)\s+(must|shall|has\s+to|is\s+required\s+to|will\s+always|will\s+never)\b/,
  /\bpretend\s+(to\s+be|you\s+are)\b|\brole-?\s?play\s+as\b|\bact\s+as\s+(if\s+you|though\s+you|an?\s+(ai|assistant|different|unrestricted))\b/,
  new RegExp(`${START}new\\s+(instructions?|rules|persona)\\s*:|\\bnew\\s+(instructions?|rules|persona)\\s+for\\s+(you|the\\s+assistant|claude|open\\s*duet)\\b`),
  // hiding things from the user / exfiltration
  /\b(do\s+not|don't|never)\s+(tell|inform|mention\s+(it\s+)?to|show)\s+the\s+user\b|\bwithout\s+telling\s+the\s+user\b/,
  // chat-template and tag injection
  /<\/?\s*(system|assistant|user|instructions?|im_start|im_end)\b[^>]*>|\[\/?(inst|system)\]|<\|[a-z_]+\|>/,
  // Chinese wording of the same
  /(忽略|无视|無視|忘记|忘記|忘掉|覆盖|覆蓋|绕过|繞過)\s*(之前|以上|上面|上述|先前|所有|全部|你的|原来的|原來的)[^。\n]{0,6}(指令|提示|规则|規則|设定|設定|指示)/,
  /(系统|系統)\s*(提示词|提示詞|指令)|你的(提示词|提示詞|指令|设定|設定)/,
  /(?:^|[。！？；：，,.!?;:\n])\s*(你|助手|claude)\s*(现在|現在|从现在起|從現在起|从今以后|從今以後|以后|以後)?\s*(必须|必須|一定要|务必|務必)/,
  /(你现在是|你現在是|你扮演|请扮演|請扮演|假装你是|假裝你是|给你的新指令|給你的新指令|新的指令\s*[:：]|新指令\s*[:：])/,
  /(不要|别|別)\s*(告诉|告訴|让|讓)\s*用户|不要让用户知道/,
  // M14b (Codync check.rs): making a site a "trusted source" is how a planted fact gains authority
  /\b(trusted|authoritative|official)\s+(source|site|domain|website)\b/,
  /(可信|可信任|权威|權威)的?(来源|來源|网站|網站)/,
];

/** M14b (Codync check.rs): a link whose query carries a prompt (`?q=…`, `prompt=…`). */
function promptLink(plain: string): boolean {
  for (const word of plain.split(/\s+/)) {
    if (!/^https?:\/\//.test(word.replace(/^[("'“]+/, ""))) continue;
    const query = word.split("?")[1];
    if (!query) continue;
    if (query.split("&").some((pair) => /^(q|prompt|query|instructions?)=/.test(pair))) return true;
  }
  return false;
}

/**
 * True when the text reads as an instruction to the assistant rather than a fact about the user
 * or the channel. Normalised first (NFKC, lower case) so full-width or styled letters don't slip by.
 */
export function readsAsInstruction(text: string): boolean {
  if (HIDDEN.test(text)) return true;
  const plain = text.normalize("NFKC").toLowerCase().replace(/[ \t]+/g, " ").trim();
  return PATTERNS.some((pattern) => pattern.test(plain)) || promptLink(plain);
}

// M14b: secrets are never stored, even when the user asks (Codync crates/memory/src/check.rs; the
// user chose this on 2026-10-27). Deterministic code, not the model's judgment.

/** Labels that mark the value next to them as a secret. "password manager" and friends are not. */
const SECRET_LABELS = /\b(password|passwd|passcode|pass code|api[ _-]?key|secret[ _-]?key|access[ _-]?key|private[ _-]?key|client[ _-]?secret|auth[ _-]?token|access[ _-]?token|bearer|pin code)\b|\btoken\s*[:=]|\bpin\s*[:=]|\bpin\s+(is|was)\b|密码|密碼|口令|支付密码|验证码|驗證碼|私钥|私鑰|密钥|密鑰|秘钥|助记词|助記詞/;
const BENIGN_SECRET_WORDS = /\b(password|passcode)\s+(manager|managers|reset|resets|policy|policies|rules?|field|hint|strength)\b|\b1password\b|\bforgot\s+(my\s+|their\s+)?password\b|密码管理|密碼管理|忘记密码|忘記密碼|重置密码|重設密碼|修改密码/g;
/** Key shapes: OpenAI / Anthropic sk-, GitHub, Slack, AWS, Google, PEM blocks. */
const KEY_SHAPES = /(?<![a-z0-9])(sk-[a-z0-9_-]{12,}|sk_(live|test)_[a-z0-9]{12,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[abpr]-[a-z0-9-]{10,}|akia[a-z0-9]{12,}|aiza[a-z0-9_-]{20,})|-----begin [a-z ]*private key-----/;
/** Account labels: with a run of 6+ digits on the same line they make an account number. */
const ACCOUNT_LABELS = /\b(account (number|no\.?)|acct|iban|routing number|sort code|card number|card no\.?)\b|账号|帳號|账户|帳戶|卡号|卡號|银行卡|銀行卡|身份证|身分證/;

/** Digit runs, with single spaces or dashes between groups ("4111 1111 1111 1111"). */
function digitRuns(text: string): string[] {
  return (text.match(/\d(?:[ -]?\d)*/g) ?? []).map((run) => run.replace(/[ -]/g, ""));
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Mainland resident ID (GB 11643: 17 digits + a check digit or X), Taiwan ID, US SSN. */
function nationalId(text: string): boolean {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  for (const match of text.matchAll(/(?<![0-9a-z])(\d{17})([0-9x])(?![0-9a-z])/g)) {
    const body = match[1]!;
    const sum = [...body].reduce((acc, d, i) => acc + Number(d) * weights[i]!, 0);
    if ("10x98765432"[sum % 11] === match[2]) return true;
  }
  return /(?<![0-9a-z])[a-z][1289]\d{8}(?![0-9a-z])/.test(text) || /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/.test(text);
}

/**
 * True when the text carries a password, key, token, ID number or card / account number. Normalised
 * first (NFKC, lower case); checked line by line for account labels (each line is its own fact).
 */
export function readsAsSecret(text: string): boolean {
  const plain = text.normalize("NFKC").toLowerCase();
  const labelled = plain.replace(BENIGN_SECRET_WORDS, " ");
  if (SECRET_LABELS.test(labelled) || KEY_SHAPES.test(plain) || nationalId(plain)) return true;
  if (digitRuns(plain).some((run) => run.length >= 13 && run.length <= 19 && luhn(run))) return true;
  return plain.split("\n").some((line) => ACCOUNT_LABELS.test(line) && digitRuns(line).some((run) => run.length >= 6));
}

/** The error a refused secret answers with (model-facing): say so, and where it belongs instead. */
export const SECRET_REFUSED =
  "Not saved: passwords, keys, tokens, ID numbers and card or account numbers are never stored in memory, even when the user asks. Tell the user you didn't save it and why, and suggest a password manager (or the phone's Passwords app) instead. Don't repeat the secret back.";

/** The error a refused write answers with (model-facing). */
export const INSTRUCTION_REFUSED =
  "Not saved: memory holds facts about the user and this channel, not instructions to you. Write it as a plain fact (\"Prefers short replies\"), or offer a change to how you behave with propose_soul_change.";
