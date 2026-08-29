// Document templates — what a blank document can be turned into.
//
// A new, empty file opens on a chooser rather than on an empty preview and an
// advisor waiting for a prompt: "what do you want to make?", answered by
// picking one of these or describing something else.
//
// The point of a template is NOT that it saves typing — it is that the skeleton
// travels with the app instead of through the model. The outline below is
// client-side and costs nothing; the model is handed a structure to fill rather
// than asked to invent one, so the drafting turn is shorter, cheaper and comes
// back in a predictable shape every time. Adding a template is adding an entry
// to this array — no other file changes.

export const DOC_TEMPLATES = [
  {
    id: 'nda',
    label: 'Contract NDA',
    blurb: 'Acord de confidențialitate între două părți.',
    kind: 'docx',
    // The sections the finished document must have, in order. Sent verbatim,
    // so the model spends its budget on the CLAUSES, not on deciding what an
    // NDA contains.
    outline: [
      'Părțile contractante',
      'Obiectul contractului',
      'Definiția informațiilor confidențiale',
      'Obligațiile părții care primește informațiile',
      'Excepții de la confidențialitate',
      'Durata obligației de confidențialitate',
      'Răspunderea contractuală și penalități',
      'Legea aplicabilă și soluționarea litigiilor',
      'Semnături',
    ],
  },
  {
    id: 'sale',
    label: 'Contract vânzare-cumpărare',
    blurb: 'Transferul proprietății unui bun de la vânzător la cumpărător.',
    kind: 'docx',
    outline: [
      'Părțile contractante',
      'Obiectul contractului și identificarea bunului',
      'Prețul și modalitatea de plată',
      'Predarea bunului și transferul proprietății',
      'Garanții privind bunul vândut',
      'Obligațiile vânzătorului',
      'Obligațiile cumpărătorului',
      'Răspunderea contractuală',
      'Legea aplicabilă și soluționarea litigiilor',
      'Semnături',
    ],
  },
];

export function templateById(id) {
  return DOC_TEMPLATES.find((t) => t.id === id) || null;
}

// One blank shape for every generated document: square brackets around a short
// description of what the person has to supply. Anything else — underscores,
// dotted rules, curly braces, "TBD" — either escapes the Complete-data panel's
// scan or reads inconsistently next to the blanks that don't.
const PLACEHOLDER_RULE_RO =
  'Nu inventa date. Scrie fiecare spațiu de completat între paranteze drepte DUBLE, iar în interior pune '
  + 'NUMELE CÂMPULUI din această listă: legalName, aka, nationalId, dateOfBirth, nationality, idDocument, '
  + 'idSeries, idNumber, idIssuer, idIssuedAt, idType, placeOfBirth, taxId, regNo, legalForm, representative, '
  + 'repCapacity, iban, bank, address, addressStreet, addressNumber, '
  + 'addressBlock, addressStair, addressFloor, addressApartment, addressLocality, addressCounty, city, county, country, email, phone. '
  + 'Pune înaintea numelui partea implicată atunci când sunt mai multe — [[vanzator.legalName]], '
  + '[[cumparator.nationalId]] — și folosește numele simplu când este una singură: [[legalName]]. '
  + 'DocVex ține câte o fișă pentru fiecare parte, așa că un spațiu numit astfel se completează dintr-un clic. '
  + 'GREȘIT: domiciliat în [localitatea], str. [...], nr. [...], bl. [...], CNP [...]. '
  + 'CORECT: domiciliat în [[vanzator.addressLocality]], str. [[vanzator.addressStreet]], '
  + 'nr. [[vanzator.addressNumber]], bl. [[vanzator.addressBlock]], CNP [[vanzator.nationalId]]. '
  + 'Câte un spațiu separat pentru fiecare informație. Pentru ce nu se află în listă (un preț, un termen, '
  + 'autoritatea emitentă) folosește tot paranteze duble, cu o descriere scurtă: [[prețul convenit în lei]]. '
  + 'Niciodată „[...]”, „[…]”, paranteze goale, liniuțe (____), puncte (....), {acolade} sau <paranteze unghiulare>. '
  + 'GEN: păstrează formulele care acoperă ambele variante — „Domnul/Doamna”, „domiciliat(ă)”, '
  + '„identificat(ă)”. DocVex le rezolvă din fișa părții la completare, deci nu alege tu genul.';

// The opening instruction for a picked template.
//
// Placeholders, not invented facts: the drafter does not know the parties yet,
// so it is told to leave every unknown as a bracketed blank. Those blanks are
// exactly what the Doc Viewer's "Complete data" panel later finds and fills, so
// the two features meet in the middle — and the panel finds them BY SHAPE
// (`matchFields` scans for square brackets), which is why the rule below spells
// out one blank style and forbids the rest. Keep it in step with
// PLACEHOLDER_RULE in supabase/functions/project-ai/index.ts.
export function templatePrompt(template) {
  if (!template) return '';
  return [
    `Redactează un ${template.label} complet, în limba română.`,
    '',
    'Structurează documentul exact pe aceste secțiuni, în această ordine:',
    ...template.outline.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Reguli:',
    '- Scrie clauzele integral, în limbaj juridic corect și uzual.',
    `- ${PLACEHOLDER_RULE_RO}`,
    '- Folosește exact aceleași denumiri de secțiuni de mai sus ca titluri.',
  ].join('\n');
}

// A free-text answer to "what do you want to make?". Kept in the same shape as
// a template prompt so the advisor is entered the same way either way.
export function customPrompt(text) {
  const wanted = String(text || '').trim();
  if (!wanted) return '';
  return [
    wanted,
    '',
    PLACEHOLDER_RULE_RO,
  ].join('\n');
}
