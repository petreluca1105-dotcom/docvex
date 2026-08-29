// Server-side jurisdiction catalog — which country's law a project is worked
// under (projects.jurisdiction, migration 033).
//
// The client stamps a CODE on each AI request; this module turns it back into
// the prompt text. Deliberately a code → entry lookup rather than trusting a
// name/adjective sent by the client: a request body is user-controlled and
// anything interpolated into a system prompt is an injection surface. An
// unknown or missing code degrades to Romania, which is what every prompt in
// this stack assumed before the setting existed.
//
// KEEP IN SYNC with src/lib/jurisdictions.js (the picker the user sees).

export interface Jurisdiction {
  code: string;
  name: string;
  adjective: string;
  language: string;
  system: "civil" | "common" | "mixed";
  eu: boolean;
}

export const DEFAULT_JURISDICTION = "RO";

const LIST: Jurisdiction[] = [
  { code: "RO", name: "Romania", adjective: "Romanian", language: "Romanian", system: "civil", eu: true },
  { code: "EU", name: "the European Union", adjective: "EU", language: "English", system: "civil", eu: true },
  { code: "MD", name: "Moldova", adjective: "Moldovan", language: "Romanian", system: "civil", eu: false },
  { code: "AT", name: "Austria", adjective: "Austrian", language: "German", system: "civil", eu: true },
  { code: "BE", name: "Belgium", adjective: "Belgian", language: "Dutch", system: "civil", eu: true },
  { code: "BG", name: "Bulgaria", adjective: "Bulgarian", language: "Bulgarian", system: "civil", eu: true },
  { code: "CH", name: "Switzerland", adjective: "Swiss", language: "German", system: "civil", eu: false },
  { code: "CY", name: "Cyprus", adjective: "Cypriot", language: "Greek", system: "mixed", eu: true },
  { code: "CZ", name: "Czechia", adjective: "Czech", language: "Czech", system: "civil", eu: true },
  { code: "DE", name: "Germany", adjective: "German", language: "German", system: "civil", eu: true },
  { code: "DK", name: "Denmark", adjective: "Danish", language: "Danish", system: "civil", eu: true },
  { code: "ES", name: "Spain", adjective: "Spanish", language: "Spanish", system: "civil", eu: true },
  { code: "FI", name: "Finland", adjective: "Finnish", language: "Finnish", system: "civil", eu: true },
  { code: "FR", name: "France", adjective: "French", language: "French", system: "civil", eu: true },
  { code: "GB", name: "the United Kingdom", adjective: "English (England & Wales)", language: "English", system: "common", eu: false },
  { code: "GR", name: "Greece", adjective: "Greek", language: "Greek", system: "civil", eu: true },
  { code: "HU", name: "Hungary", adjective: "Hungarian", language: "Hungarian", system: "civil", eu: true },
  { code: "IE", name: "Ireland", adjective: "Irish", language: "English", system: "common", eu: true },
  { code: "IT", name: "Italy", adjective: "Italian", language: "Italian", system: "civil", eu: true },
  { code: "LU", name: "Luxembourg", adjective: "Luxembourgish", language: "French", system: "civil", eu: true },
  { code: "NL", name: "the Netherlands", adjective: "Dutch", language: "Dutch", system: "civil", eu: true },
  { code: "PL", name: "Poland", adjective: "Polish", language: "Polish", system: "civil", eu: true },
  { code: "PT", name: "Portugal", adjective: "Portuguese", language: "Portuguese", system: "civil", eu: true },
  { code: "SE", name: "Sweden", adjective: "Swedish", language: "Swedish", system: "civil", eu: true },
  { code: "SK", name: "Slovakia", adjective: "Slovak", language: "Slovak", system: "civil", eu: true },
  { code: "TR", name: "Türkiye", adjective: "Turkish", language: "Turkish", system: "civil", eu: false },
  { code: "US", name: "the United States", adjective: "US federal", language: "English", system: "common", eu: false },
];

const BY_CODE = new Map(LIST.map((j) => [j.code, j]));

export function resolveJurisdiction(code?: unknown): Jurisdiction {
  const c = typeof code === "string" ? code.toUpperCase().slice(0, 2) : "";
  return BY_CODE.get(c) ?? BY_CODE.get(DEFAULT_JURISDICTION)!;
}

// The sentence(s) appended to a system prompt so the model reaches for the
// right legislation, courts and answer language. Kept conditional ("when the
// question is legal") so it doesn't turn ordinary chat into legal register.
export function jurisdictionPrompt(code?: unknown): string {
  const j = resolveJurisdiction(code);
  const eu = j.eu && j.code !== "EU"
    ? ` ${j.name} is an EU member state, so directly applicable EU regulations and transposed directives are part of the applicable law.`
    : "";
  const system = j.system === "common"
    ? "Reason from statute and binding precedent, and cite leading cases by name."
    : j.system === "mixed"
    ? "Reason from the codes and statutes first, with case law as interpretive support."
    : "Reason from the codes and statutes first (case law is persuasive, not binding).";
  return (
    `The legal work in this workspace is governed by the law of ${j.name}. ` +
    `Whenever legislation, regulation, case law, courts, procedure or compliance come up, apply ${j.adjective} law ` +
    `and cite ${j.adjective} sources specifically (name the code, article and, where relevant, the competent court) — ` +
    `never substitute another country's rules, and say so plainly if you are unsure whether a rule applies here.${eu} ` +
    `${system} ` +
    `Write legal documents and answer legal questions in ${j.language} unless the user writes in another language ` +
    `or asks for a different one.`
  );
}

// Short form for prompts that only need to name the jurisdiction (e.g. the
// one-line persona in `suggest`), e.g. "a Romanian law firm".
export function firmDescriptor(code?: unknown): string {
  const j = resolveJurisdiction(code);
  return `a ${j.adjective} law firm`;
}
