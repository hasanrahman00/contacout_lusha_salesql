// utils/nameCleaner.js

const PREFIXES = [
  // Courtesy & social
  "Mr",
  "Mrs",
  "Ms",
  "Miss",
  "Mx",
  "Master",
  "Messrs",
  "Md",
  "Md.",
  "Mdm",
  "Mdm.",
 

  // Academic / professional
  "Dr",
  "Dr.",
  "Doctor",
  "Prof",
  "Professor",
  "Engr",
  "Chancellor",
  "Vice-Chancellor",
  "Dean",
  "Principal",
  "Director",
  "Chief",
  "Chief Executive",
  "Warden",
  "Provost",
  "Regent",
  "Rector",
  "President",

  // Government / legal / judicial
  "Hon",
  "Honorable",
  "The Honourable",
  "The Right Honourable",
  "Justice",
  "Judge",
  "Magistrate",
  "Sen",
  "Senator",
  "Rep",
  "Representative",
  "Gov",
  "Governor",
  "Amb",
  "Ambassador",
  "Pres",
  "President",
  "VP",
  "Vice President",

  // Military ranks (common abbreviations included)
  "Gen",
  "General",
  "Lt Gen",
  "Brig Gen",
  "Brigadier",
  "Col",
  "Colonel",
  "Maj",
  "Major",
  "Capt",
  "Captain",
  "Cmdr",
  "Commander",
  "Lt",
  "Lieutenant",
  "Sgt",
  "Sergeant",
  "Cpl",
  "Corporal",
  "Adm",
  "Admiral",
  "Rear Adm",
  "Commodore",
  "Field Marshal",
  "Air Marshal",
  "Air Vice Marshal",

  // Royal / aristocratic
  "Sir",
  "Dame",
  "Lord",
  "Lady",
  "Baron",
  "Baroness",
  "Earl",
  "Count",
  "Countess",
  "Viscount",
  "Viscountess",
  "Marquess",
  "Marchioness",
  "Duke",
  "Duchess",
  "His Grace",
  "Her Grace",
  "His Excellency",
  "Her Excellency",
  "His Majesty",
  "Her Majesty",
  "His Royal Highness",
  "Her Royal Highness",

  // Religious (Christian)
  "Rev",
  "Reverend",
  "The Reverend",
  "The Most Reverend",
  "Father",
  "Fr",
  "Pastor",
  "Pr",
  "Elder",
  "Archbishop",
  "Cardinal",
  "Bishop",
  "Monsignor",
  "Brother",
  "Br",
  "Sister",
  "Sr",

  // Religious (Judaism)
  "Rabbi",
  "Chief Rabbi",
  "Grand Rabbi",
  "Rebbe",
  "Admor",
  "Cantor",
  "Rebbetzin",

  // Religious (Islam)
  "Imam",
  "Shaykh",
  "Sheikh",
  "Mufti",
  "Haji",
  "Sayyid",
  "Sayyidah",
  "Ayatollah",
  "Seghatoleslam",
  "Mawlana",

  // Religious (Buddhism / other)
  "His Holiness",
  "Venerable",
  "Roshi",
  "Sensei",
  "Eminent",

  // Engineering & technical (occasionally used as prefix)
  "Eng",
  "Engr",
];

const SUFFIXES = [
  // Generational
  "Jr",
  "Sr",
  "II",
  "III",
  "IV",
  "V",

  // Academic degrees
  "PhD",
  "Ph.D",
  "MD",
  "M.D",
  "DO",
  "MBBS",
  "BDS",
  "DDS",
  "DMD",
  "DVM",
  "DPT",
  "OD",
  "JD",
  "J.D",
  "LLM",
  "LL.M",
  "EdD",
  "D.Ed",
  "PsyD",
  "MBA",
  "EMBA",
  "MPA",
  "MPP",
  "MSc",
  "M.S",
  "MS",
  "MA",
  "M.A",
  "BSc",
  "B.S",
  "BS",
  "BA",
  "B.A",
  "BEng",
  "MEng",
  "MPhil",
  "BPhil",

  // Clinical & medical certs
  "RN",
  "LPN",
  "NP",
  "PA-C",
  "RPh",
  "PharmD",
  "RD",
  "RDN",
  "RT",
  "PT",
  "OT",
  "CLS",
  "CLT",
  "MLS",
  "MLS(ASCP)",
  "M.S.(ASCP)",
  "M(ASCP)",

  // Finance & accounting
  "CPA",
  "CFA",
  "CGMA",
  "CGFM",
  "CMA",
  "ACCA",

  // Business & management
  "PMP",
  "PgMP",
  "PMI-ACP",
  "CIPM",
  "CISM",
  "CISSP",
  "CISA",
  "SHRM-CP",
  "SHRM-SCP",
  "PHR",
  "SPHR",

  // Engineering / technical
  "PE",
  "P.E",
  "CEng",
  "PTech",
  "PMEC",

  // Health & safety
  "CHFM",
  "CHC",
  "CHSP",
  "CHMM",

  // IT & security
  "CEH",
  "OSCP",
  "AWS-SA",
  "RHCE",

  // Legal & compliance
  "Esq",
  "Esquire",
  "J.D",
  "LLB",
  "LLM",

  // Honorary / civil orders
  "OBE",
  "MBE",
  "CBE",
  "GBE",
  "KBE",
  "CMG",

  // Misc credentials / memberships
  "ACHE",
  "NRAEMT",
  "ACNP",
  "FACHE",
  "FACC",
  "FACOG",
  "FACP",
  "FAIA",
  "FRICS",
  "FBCS",

  // Country- or region-specific professional memberships
  "MRCVS",
  "MRCP",
  "FRCP",
  "FRCS",

  // Trademark / corporate designators often appearing as noise
  "™",
  "©",
  "®",
];

// Build dot- and case-insensitive lookup tables  ⬇️ add once, top-level
const PREFIX_SET = new Set(
  PREFIXES.map((p) => p.replace(/\./g, "").toUpperCase())
);
const SUFFIX_SET = new Set(
  SUFFIXES.map((s) => s.replace(/\./g, "").toUpperCase())
);

// Utility – quick diacritic removal (Unicode NFD / stripping combining marks)
function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Utility – capitalise "word" → "Word"
function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// Utility – safe token cleanup for comparison (remove dots & upper‑case)
function cleanTokenCompare(token) {
  return token.replace(/\./g, "").toUpperCase();
}

function cleanName(raw) {
  if (typeof raw !== "string") return "";
  let working = raw.trim();
  if (!working) return "";

  // Quick split on spaces for immediate two‑token happy path
  let quickTokens = working.split(/\s+/);
  if (quickTokens.length === 2) {
    quickTokens = quickTokens
      .map((t) => stripDiacritics(t).replace(/[^A-Za-z]/g, ""))
      .filter((t) => t && /[A-Za-z]/.test(t));
    if (quickTokens.length === 2) {
      return quickTokens.map(titleCase).join(" ").trim();
    }
  }

  // -------------------------------------------------------------
  // 1) Remove everything AFTER the first comma (handles multiple)
  // -------------------------------------------------------------
  const commaPos = working.indexOf(",");
  if (commaPos !== -1) working = working.slice(0, commaPos);

  // -------------------------------------------------------------
  // 2) Remove anything wrapped in (...) or [...]
  // -------------------------------------------------------------
  working = working.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  working = working.replace(/\s+/g, " ").trim();

  let tokens = working.split(" ");
  // Remove emoji/symbol-only tokens early
  tokens = tokens.filter((t) => /[A-Za-z]/.test(stripDiacritics(t)));

  // -------------------------------------------------------------
  // 3) Short/special tail cleanup
  // -------------------------------------------------------------
  if (tokens.length > 2) {
    const last = tokens[tokens.length - 1];
    if (last.length <= 2 || /[^A-Za-z]/.test(last)) {
      tokens.pop();
    }
  }

  // 4) Strip a single prefix at the start (case- & dot-insensitive)
  if (tokens.length > 1 && PREFIX_SET.has(cleanTokenCompare(tokens[0]))) {
    tokens.shift();
  }

  // 5) Strip ALL trailing suffixes / credentials
  while (
    tokens.length > 1 &&
    SUFFIX_SET.has(cleanTokenCompare(tokens[tokens.length - 1]))
  ) {
    tokens.pop();
  }

  // -------------------------------------------------------------
  // 6) Middle‑name trimming – keep first + last if >2 tokens
  //    Prefer a real surname and skip noisy trailing words.
  // -------------------------------------------------------------
  if (tokens.length > 2) {
    const noiseWords = new Set([
      "media",
      "authority",
      "educator",
      "reporter",
      "writer",
      "news",
      "photo",
      "backstage",
      "trusted",
      "world",
      "aspire",
      "greatness",
      "entwriter",
      "ent",
    ]);
    const stopWords = new Set(["to", "and", "of", "the", "in", "for", "on", "with"]);
    const cleanToken = (t) => stripDiacritics(t).replace(/[^A-Za-z]/g, "");
    const candidates = tokens
      .map(cleanToken)
      .filter(Boolean)
      .filter((token) => !noiseWords.has(token.toLowerCase()))
      .filter((token) => !stopWords.has(token.toLowerCase()))
      .filter((token) => token.length >= 2);

    if (candidates.length >= 2) {
      const first = candidates[0];
      const lastIndex = candidates.length >= 3 ? 2 : 1;
      const last = candidates[lastIndex];
      tokens = [first, last];
    } else {
      tokens = [tokens[0], tokens[tokens.length - 1]];
    }
  }

  // Final safety: remove any still‑empty tokens
  tokens = tokens.filter(Boolean);
  if (tokens.length === 0) return "";

  // Last sanitisation pass on the two tokens we have
  tokens = tokens.map((t) => stripDiacritics(t).replace(/[^A-Za-z]/g, ""));

  // Remove any empties after sanitisation
  tokens = tokens.filter(Boolean);
  if (tokens.length === 0) return "";
  if (tokens.length === 1) return titleCase(tokens[0]);

  // Title‑case
  tokens = tokens.map(titleCase);

  return tokens.slice(0, 2).join(" ");
}

module.exports = { cleanName, PREFIXES, SUFFIXES };