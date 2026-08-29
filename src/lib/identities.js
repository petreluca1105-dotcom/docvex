// Identity records — one file per person or company involved in a case.
//
// A case is people before it is documents: the client, the opposing party, the
// witnesses, the companies behind them. Those facts (full name, national id,
// registered office, who represents whom) are otherwise scattered across
// contracts and letters and get re-read every time somebody needs them. An
// identity file collects them in one place, in the project folder, next to the
// documents they were taken from.
//
// Stored as `<Name>.dvx` inside an `Identities/` subfolder of the project —
// DocVex's own record format. The bytes are JSON: these are FIELDS, not prose,
// so the AI reads and writes them without parsing a layout and the file stays
// diffable and syncs cleanly through Dropbox/iCloud like everything else in
// the folder. The extension is ours so the app can open it in its own viewer
// instead of handing a .json to a text editor.
//
// Written from two places: by hand ("Add identity" in the Files tab) and
// automatically by the Timeline council, which knows every party in the story
// by the time it has finished reconstructing it.

import { localFolderApi, readLocalBlob } from './localFolder';
import { JURISDICTIONS, DEFAULT_JURISDICTION } from './jurisdictions';

export const IDENTITY_EXT = '.dvx';
export const IDENTITY_FOLDER = 'Identities';
// Served as JSON so anything that reads the bytes directly (the AI file
// index, a text editor) still understands them.
export const IDENTITY_MIME = 'application/json';

// A natural person or a legal entity. The two share most fields; the handful
// that differ are marked `only` below so one form can serve both.
export const IDENTITY_KINDS = [
  { id: 'person', label: 'Individual', hint: 'A natural person — client, witness, opposing party.' },
  { id: 'org', label: 'Organisation', hint: 'A company, authority or other legal entity.' },
];

// What this party is TO THE CASE. Free text is allowed; these are the common
// ones, offered as a picker so the same role isn't spelled three ways.
export const IDENTITY_ROLES = [
  'Client',
  'Opposing party',
  'Witness',
  'Expert',
  'Counsel',
  'Court',
  'Authority',
  'Third party',
];

// Field set, declared once so the form, the AI's output contract and the
// summary line can't drift apart. `only` restricts a field to one kind.
//
// The shape follows Romanian practice, because that is the shape the documents
// take: a *persoană fizică* is identified by CNP and an act of identity (type,
// series, number, who issued it and when) — every one of which a contract's
// identification clause asks for by name — and a *persoană juridică* by CUI,
// its Trade Register number, its legal form, who represents it and in what
// capacity, plus the bank account a payment clause needs. Splitting the ID act
// and the bank details into their own fields rather than one free-text line is
// what lets a clause be filled blank by blank instead of by hand.
export const IDENTITY_FIELDS = [
  { key: 'legalName', label: 'Full legal name', hint: 'As it appears in official documents' },
  { key: 'aka', label: 'Also known as', hint: 'Other spellings or trading names' },
  // Not a detail for its own sake: it decides the agreement in every Romanian
  // clause that was drafted to cover both ("domiciliat(ă)", "Domnul/Doamna").
  { key: 'gender', label: 'Gender', only: 'person', choices: 'gender', hint: 'Sets the wording in Romanian clauses' },

  // ── Persoană fizică ──────────────────────────────────────────────────
  { key: 'nationalId', label: 'CNP', only: 'person', hint: 'Cod numeric personal' },
  { key: 'dateOfBirth', label: 'Date of birth', only: 'person', hint: 'Data nașterii' },
  { key: 'placeOfBirth', label: 'Place of birth', only: 'person', hint: 'Locul nașterii' },
  { key: 'nationality', label: 'Nationality', only: 'person', hint: 'Cetățenia' },
  { key: 'idType', label: 'ID document type', only: 'person', choices: 'idType', hint: 'Tipul actului de identitate' },
  // Series and number are stored SEPARATELY, because that is how a Romanian
  // clause asks for them — "seria […] nr. […]" is two blanks — and splitting one
  // typed string back apart was a guess that could only ever be right most of
  // the time. Two fields is two answers, and each blank gets the one it wants.
  // `idDocument` survives in the record shape as the legacy single value: it is
  // no longer offered in the form, but a record written before this still reads
  // correctly, and a clause that asks for the whole thing still gets it.
  { key: 'idSeries', label: 'ID series', only: 'person', hint: 'Seria — e.g. RX' },
  { key: 'idNumber', label: 'ID number', only: 'person', hint: 'Numărul — e.g. 456789' },
  { key: 'idIssuer', label: 'Issued by', only: 'person', hint: 'Eliberat de — SPCLEP, poliția…' },
  { key: 'idIssuedAt', label: 'Issued on', only: 'person', hint: 'La data de' },

  // ── Persoană juridică ────────────────────────────────────────────────
  { key: 'legalForm', label: 'Legal form', only: 'org', choices: 'legalForm', hint: 'SRL, SA, PFA, II…' },
  { key: 'taxId', label: 'CUI / CIF', only: 'org', hint: 'Codul unic de înregistrare' },
  { key: 'regNo', label: 'Trade register number', only: 'org', hint: 'Nr. de ordine — e.g. J40/1234/2020' },
  { key: 'representative', label: 'Represented by', only: 'org', hint: 'Reprezentant legal' },
  { key: 'repCapacity', label: 'Acting as', only: 'org', hint: 'În calitate de — administrator, director…' },
  { key: 'iban', label: 'IBAN', only: 'org', hint: 'Contul bancar' },
  { key: 'bank', label: 'Bank', only: 'org', hint: 'Deschis la' },

  // ── Both ─────────────────────────────────────────────────────────────
  // ONE address field, because that is how a person knows an address and how it
  // arrives in a document. A Romanian clause still asks for it a piece at a
  // time — "str. […], nr. […], bl. […], sc. […], ap. […]" is five blanks — so
  // splitAddress takes the line apart to answer them.
  //
  // The parse is not asked to be infallible, it is asked to be VISIBLE: the
  // form shows what it understood, part by part, under the field. A line it
  // reads wrongly is then something you can see and reword, rather than
  // something that quietly mis-fills a clause. (The individual part keys stay
  // in the record shape and still take precedence when set, so a record written
  // while they were separate fields keeps working.)
  { key: 'address', label: 'Address', multiline: true, parsed: 'address',
    hint: 'Str. Mihai Eminescu nr. 12, bl. A3, sc. B, ap. 15' },
  { key: 'city', label: 'City', hint: 'Town or municipality' },
  // Sector for București, county everywhere else — which is exactly what
  // decides the "județul/sectorul" formula when a document is filled in.
  { key: 'county', label: 'County / sector', parsed: 'county',
    hint: 'Cluj, CJ, Sector 3 — DocVex works out which' },
  { key: 'country', label: 'Country' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
];

// Act of identity, as Romanian documents name them. CI is what almost every
// adult carries; the rest are the ones a clause still has to be able to say.
export const IDENTITY_ID_TYPES = ['CI', 'BI', 'Pașaport', 'Permis de ședere'];

// The legal forms a Romanian entity is registered under.
export const IDENTITY_LEGAL_FORMS = ['SRL', 'SA', 'SRL-D', 'SCS', 'SNC', 'PFA', 'II', 'IF', 'ONG', 'Instituție publică'];

// The origin picker. Every jurisdiction the app knows is listed so the record
// says plainly what it is and what it isn't, but only Romania can be chosen:
// the field set above, the address and ID splitters, and the "domiciliat(ă)" /
// "județul/sectorul" transforms are all Romanian practice. Showing the rest
// greyed out is the honest version of "not yet" — hiding them would suggest the
// question had never been asked.
export const IDENTITY_ORIGINS = JURISDICTIONS.map((j) => ({
  code: j.code,
  name: j.name,
  flag: j.flag,
  available: j.code === DEFAULT_JURISDICTION,
}));

// Fields that apply to the given kind.
export function fieldsFor(kind) {
  return IDENTITY_FIELDS.filter((f) => !f.only || f.only === kind);
}

let seq = 0;
function newId() {
  seq += 1;
  return `idn_${Date.now().toString(36)}_${seq.toString(36)}`;
}

export function emptyIdentity(kind = 'person') {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: newId(),
    kind: kind === 'org' ? 'org' : 'person',
    name: '',
    role: '',
    legalName: '',
    aka: '',
    gender: '',
    // Which country's format this record follows. NOT `origin` — that key is
    // already taken, by where the record came from (hand-entered vs the
    // timeline). Romania-only for now: the field set, the address and ID
    // splitters and every clause transform are built to Romanian practice, so
    // offering a jurisdiction the rest of the stack cannot honour would be a
    // promise the app doesn't keep.
    jurisdiction: DEFAULT_JURISDICTION,
    nationalId: '',
    dateOfBirth: '',
    placeOfBirth: '',
    nationality: '',
    idType: '',
    idSeries: '',
    idNumber: '',
    // Legacy: what the two fields above used to be one of. Kept so a record
    // written before the split still fills a clause; never shown in the form.
    idDocument: '',
    idIssuer: '',
    idIssuedAt: '',
    taxId: '',
    regNo: '',
    legalForm: '',
    representative: '',
    repCapacity: '',
    iban: '',
    bank: '',
    addressStreet: '',
    addressNumber: '',
    addressBlock: '',
    addressStair: '',
    addressFloor: '',
    addressApartment: '',
    // Legacy: the single line the parts above used to be parsed out of. Kept so
    // an older record still fills a clause; never shown in the form.
    address: '',
    city: '',
    county: '',
    country: '',
    email: '',
    phone: '',
    notes: '',
    // Filenames this was read out of, so a disputed detail can be traced back.
    sources: [],
    origin: 'manual',   // 'manual' | 'timeline'
    createdAt: now,
    updatedAt: now,
  };
}

// Accept anything that parses and looks like a record; fill the rest from the
// blank shape so a hand-edited or older file never crashes the form.
export function parseIdentity(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const base = emptyIdentity(raw.kind === 'org' ? 'org' : 'person');
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (key === 'sources') continue;
    if (typeof raw[key] === 'string') out[key] = raw[key];
  }
  out.id = typeof raw.id === 'string' && raw.id ? raw.id : base.id;
  out.kind = raw.kind === 'org' ? 'org' : 'person';
  out.version = 1;
  out.sources = Array.isArray(raw.sources) ? raw.sources.filter((s) => typeof s === 'string') : [];
  out.origin = raw.origin === 'timeline' ? 'timeline' : 'manual';
  out.jurisdiction = IDENTITY_ORIGINS.some((o) => o.code === raw.jurisdiction)
    ? raw.jurisdiction
    : DEFAULT_JURISDICTION;
  return out;
}

// Read a file ONLY if it really is a record. `readIdentity` is deliberately
// lenient — it fills gaps from the blank shape so an older or hand-edited record
// still opens — which makes it useless for deciding whether an arbitrary `.json`
// IS one. This asks that question first.
export async function readIdentityIfRecord(pathOrName) {
  try {
    const blob = await readLocalBlob(pathOrName);
    if (!blob) return null;
    const text = await blob.text();
    if (!looksLikeIdentityJson(text)) return null;
    return parseIdentity(text);
  } catch {
    return null;
  }
}

export function serializeIdentity(identity) {
  return `${JSON.stringify({ ...identity, version: 1 }, null, 2)}\n`;
}

export function identityBlob(identity) {
  return new Blob([serializeIdentity(identity)], { type: IDENTITY_MIME });
}

export function isIdentityFile(name) {
  return String(name || '').toLowerCase().endsWith(IDENTITY_EXT);
}

// Could these bytes be a record, regardless of what the file is called?
//
// `.dvx` is what this app writes, but records reach a project folder by other
// routes too — an older build, a hand-written file, one saved out as plain
// `.json` — and a record the viewer shows as raw JSON is a record the user
// can't read or edit. So the viewer sniffs instead of trusting the extension,
// and this is the test it uses.
//
// Deliberately strict, because a false positive opens somebody's `package.json`
// in an identity form: it must be a JSON object that declares one of OUR two
// kinds AND carries at least one field only an identity record has.
const IDENTITY_MARKERS = [
  'legalName', 'nationalId', 'dateOfBirth', 'nationality', 'idDocument',
  'taxId', 'regNo', 'legalForm', 'representative', 'role', 'aka',
];
export function looksLikeIdentityJson(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return false; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.kind !== 'person' && raw.kind !== 'org') return false;
  if (typeof raw.name !== 'string') return false;
  // `version: 1` is ours and settles it on its own; otherwise look for a field
  // that no ordinary JSON document would happen to carry alongside a matching
  // `kind` and `name`.
  if (raw.version === 1) return true;
  return IDENTITY_MARKERS.some((k) => typeof raw[k] === 'string');
}

// Is this file worth sniffing at all? `.dvx` is a record by definition; `.json`
// is the only other extension a record has ever been written under.
export function isIdentityCandidate(name) {
  const n = String(name || '').toLowerCase();
  return n.endsWith(IDENTITY_EXT) || n.endsWith('.json');
}

// Everything in the project's Identities/ folder is a record, whatever it is
// called — which settles a `.json` one without reading a byte. Handles both
// separators, since a path can arrive from either platform's listing.
export function isInIdentityFolder(path) {
  const p = String(path || '').replace(/\\/g, '/').toLowerCase();
  return p.includes(`/${IDENTITY_FOLDER.toLowerCase()}/`);
}

// "Ionescu Maria.dvx" → "Ionescu Maria"
export function identityDisplayName(name) {
  const n = String(name || '');
  return isIdentityFile(n) ? n.slice(0, -IDENTITY_EXT.length) : n;
}

// Filename for a record. Path separators and the characters Windows refuses are
// replaced rather than stripped, so two different names can't collapse into one
// file and silently overwrite each other.
export function identityFileName(identity) {
  const base = String(identity?.name || identity?.legalName || 'Unnamed')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 90) || 'Unnamed';
  return `${base}${IDENTITY_EXT}`;
}

// ── County or sector? ───────────────────────────────────────────────────
// One field holds both, because a Romanian address has one or the other and
// never both — and which it is decides how the document reads: "județul X"
// everywhere in the country, "sectorul N" in București alone.
//
// So the field works out which was typed rather than asking. The 41 counties
// (plus the capital) are a closed, unchanging list, so recognising one is a
// lookup; a sector is a number, with or without the word in front of it. What
// it concluded is shown back under the field — the same bargain as the address
// line: the guess has to be visible to be trustworthy.
export const RO_COUNTIES = [
  'Alba', 'Arad', 'Argeș', 'Bacău', 'Bihor', 'Bistrița-Năsăud', 'Botoșani', 'Brașov',
  'Brăila', 'București', 'Buzău', 'Caraș-Severin', 'Călărași', 'Cluj', 'Constanța',
  'Covasna', 'Dâmbovița', 'Dolj', 'Galați', 'Giurgiu', 'Gorj', 'Harghita', 'Hunedoara',
  'Ialomița', 'Iași', 'Ilfov', 'Maramureș', 'Mehedinți', 'Mureș', 'Neamț', 'Olt',
  'Prahova', 'Satu Mare', 'Sălaj', 'Sibiu', 'Suceava', 'Teleorman', 'Timiș', 'Tulcea',
  'Vaslui', 'Vâlcea', 'Vrancea',
];
const COUNTY_BY_FOLDED = new Map(RO_COUNTIES.map((c) => [foldLabel(c), c]));
// The two-letter plates, which is how a county is often abbreviated in an
// address. Only the ones that aren't already the county's first letters.
const COUNTY_BY_PLATE = new Map(Object.entries({
  ab: 'Alba', ar: 'Arad', ag: 'Argeș', bc: 'Bacău', bh: 'Bihor', bn: 'Bistrița-Năsăud',
  bt: 'Botoșani', bv: 'Brașov', br: 'Brăila', b: 'București', bz: 'Buzău', cs: 'Caraș-Severin',
  cl: 'Călărași', cj: 'Cluj', ct: 'Constanța', cv: 'Covasna', db: 'Dâmbovița', dj: 'Dolj',
  gl: 'Galați', gr: 'Giurgiu', gj: 'Gorj', hr: 'Harghita', hd: 'Hunedoara', il: 'Ialomița',
  is: 'Iași', if: 'Ilfov', mm: 'Maramureș', mh: 'Mehedinți', ms: 'Mureș', nt: 'Neamț',
  ot: 'Olt', ph: 'Prahova', sm: 'Satu Mare', sj: 'Sălaj', sb: 'Sibiu', sv: 'Suceava',
  tr: 'Teleorman', tm: 'Timiș', tl: 'Tulcea', vs: 'Vaslui', vl: 'Vâlcea', vn: 'Vrancea',
}));

// What did the user type into "County / sector"?
//
//   { kind: 'sector' | 'county' | null, label, value }
//
// `value` is the tidied form the document should use ("Sector 3", "Cluj").
// `kind` is null when it is neither — a foreign region, a typo, something
// half-typed — and null means the document's "județul/sectorul" is left as
// drafted, because nothing here justifies choosing a half.
//
// `city` is used only to read a bare number: "3" is a sector in București and
// means nothing anywhere else.
export function classifyCounty(value, city) {
  const raw = String(value || '').trim();
  if (!raw) return { kind: null, label: '', value: '' };
  const folded = foldLabel(raw);

  // "Sector 3", "sectorul 3", "S3", or a bare 1–6 when the city is the capital.
  const withWord = /^s(?:ector(?:ul)?)?\s*\.?\s*([1-6])$/.exec(folded);
  const bare = /^([1-6])$/.exec(folded);
  const cityIsCapital = /^bucuresti$|^bucharest$/.test(foldLabel(city || ''));
  if (withWord || (bare && cityIsCapital)) {
    const n = (withWord || bare)[1];
    return { kind: 'sector', label: 'Sector', value: `Sector ${n}` };
  }

  const named = COUNTY_BY_FOLDED.get(folded)
    || COUNTY_BY_FOLDED.get(folded.replace(/^jude[tt]?(?:ul)?\s+/, ''));
  if (named) {
    // București as a "county" IS the sector case — the capital is its own
    // county, and an address there is written by sector.
    if (named === 'București') return { kind: 'sector', label: 'Sector', value: 'București' };
    return { kind: 'county', label: 'County', value: named };
  }
  const plate = COUNTY_BY_PLATE.get(folded);
  if (plate) {
    if (plate === 'București') return { kind: 'sector', label: 'Sector', value: 'București' };
    return { kind: 'county', label: 'County', value: plate };
  }
  return { kind: null, label: '', value: raw };
}

// ── "județul/sectorul" ──────────────────────────────────────────────────
// Romanian address formulas cover both because only ONE city in the country is
// divided into sectors: București. Everywhere else has a county. So once the
// party's city is known, exactly one half of that pair is right and the other
// is wrong — not merely redundant — and a draft that keeps both is a draft
// nobody has finished reading.
//
// Deliberately its own transform rather than another entry in the gender pair
// list: this one is decided by the address, not the person, and the two are set
// from different fields at different moments.
// Is this party's address in the one city that has sectors? Decided by what the
// county/sector field turned out to BE, with the city as the tie-breaker for a
// bare number — and by the city alone when the field says nothing usable.
export function addressHasSectors(identity) {
  if (!identity) return false;
  if (identityValueForField(identity, 'addressSector')) return true;
  const city = identityValueForField(identity, 'addressLocality');
  const county = identityValueForField(identity, 'addressCounty');
  return /^bucuresti$|^bucharest$/.test(foldLabel(city))
    || /^bucuresti$|^bucharest$/.test(foldLabel(county));
}

// Keep the half that applies. Case and wording come from the document itself —
// the matched text is reused verbatim — so "Județul/Sectorul" stays capitalised
// and "jud./sect." stays abbreviated.
// Both halves in every form a document writes them: full, articulated, and the
// two abbreviations ("jud." / "sect."), in either order.
const COUNTY_WORD = '(?:jude[țţt](?:ul)?|jud)\\.?';
const SECTOR_WORD = '(?:sector(?:ul)?|sect)\\.?';
const LOCALITY_PAIR_RES = [
  [new RegExp(`(${COUNTY_WORD})\\s*/\\s*(${SECTOR_WORD})`, 'gi'), 'county'],
  [new RegExp(`(${SECTOR_WORD})\\s*/\\s*(${COUNTY_WORD})`, 'gi'), 'sector'],
];

export function applyLocalityToText(text, hasSectors) {
  if (hasSectors == null) return String(text || '');
  let out = String(text || '');
  for (const [re, firstIs] of LOCALITY_PAIR_RES) {
    out = out.replace(re, (_all, a, b) => {
      const keepFirst = hasSectors ? firstIs === 'sector' : firstIs === 'county';
      return keepFirst ? a : b;
    });
  }
  return out;
}

// ── Gender, and the forms a Romanian clause takes because of it ─────────
// Romanian legal formulas are written to cover both: "Domnul/Doamna",
// "domiciliat(ă)", "identificat(ă)". Once the party is known, exactly one half
// of each is right and the other is noise — so filling a record in also settles
// the agreement, the same way it settles the CNP.
export const IDENTITY_GENDERS = [
  { id: '', label: 'Not specified' },
  { id: 'male', label: 'Male' },
  { id: 'female', label: 'Female' },
  { id: 'other', label: 'Other' },
];

// Masculine / feminine word pairs written as "A/B" in a formula. Deliberately a
// SHORT, closed list: "județul/sectorul" is also an A/B pair and has nothing to
// do with gender, so anything not named here is left alone.
const GENDER_WORD_PAIRS = [
  ['Domnul', 'Doamna'], ['DOMNUL', 'DOAMNA'], ['domnul', 'doamna'],
  ['Dl', 'Dna'], ['dl', 'dna'], ['D-l', 'D-na'], ['Dnul', 'Dna'],
  ['Domnului', 'Doamnei'], ['domnului', 'doamnei'],
  ['cetățean', 'cetățeană'], ['cetatean', 'cetateana'],
  ['fiul', 'fiica'], ['născut', 'născută'], ['nascut', 'nascuta'],
  ['VÂNZĂTOR', 'VÂNZĂTOARE'], ['CUMPĂRĂTOR', 'CUMPĂRĂTOARE'],
];

// Rewrite a clause for one gender: pick the right half of each "A/B" pair, and
// resolve the "(ă)" agreement suffix that covers both. 'other' and an unset
// gender leave the text exactly as drafted — a formula that covers both is
// still correct, and silently choosing one would be putting words in the
// document that nobody asked for.
const RO_LETTER = '[A-Za-zĂÂÎȘȚăâîșț]';
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Domnul/Doamna", "Dl./Dna." — an optional dot after each half, and a
// lookahead rather than \b so a trailing dot doesn't break the match.
const GENDER_PAIR_RES = GENDER_WORD_PAIRS.map(([m, f]) => [
  new RegExp(`(?<!${RO_LETTER})${escRe(m)}\\.?\\s*/\\s*${escRe(f)}\\.?(?!${RO_LETTER})`, 'g'),
  m, f,
]);

export function applyGenderToText(text, gender) {
  if (gender !== 'male' && gender !== 'female') return String(text || '');
  const fem = gender === 'female';
  let out = String(text || '');
  for (const [re, m, f] of GENDER_PAIR_RES) out = out.replace(re, fem ? f : m);
  // "domiciliat(ă)" → "domiciliat" / "domiciliată"; "identificat(a)" likewise.
  // The parenthetical is only ever the feminine ending, so the masculine form
  // is the word with it dropped.
  out = out.replace(new RegExp(`(${RO_LETTER}{3,})\\(\\s*([ăa])\\s*\\)`, 'g'), (_all, stem, tail) => (fem ? stem + tail : stem));
  return out;
}

// ── Card presentation ───────────────────────────────────────────────────
// The viewer renders a record as an ID-card / passport data page, so the two
// pieces of that look which need real logic — the name split and the machine-
// readable strip along the bottom — live here next to the fields they read.

// Latin-ise for the machine zone: the strip is A–Z and `<` only, so Romanian
// diacritics are folded to their base letters exactly as a real MRZ folds them.
function mrzFold(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // ă â î → a a i
    .replace(/ș|ş/gi, 's').replace(/ț|ţ/gi, 't')
    .toUpperCase()
    // Digits survive: the same fold serves names AND the document / personal
    // numbers on the second line, which are mostly numeric.
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .trim();
}

// Romanian records are written surname-first ("Ionescu Maria"), which is also
// the order the machine zone wants. The first token is the surname; whatever
// follows is the given name(s). A single-token name is treated as the surname.
export function identityNameParts(identity) {
  const full = String(identity?.legalName || identity?.name || '').trim();
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { surname: parts[0] || '', given: '' };
  return { surname: parts[0], given: parts.slice(1).join(' ') };
}

// ICAO 9303 check digit: weights cycle 7-3-1, letters count as A=10…Z=35,
// filler `<` as 0. Real arithmetic over the data we actually hold — a blank
// field yields the `<`-filled group and its honest check digit of 0.
function mrzCheck(str) {
  const W = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    const v = c === '<' ? 0 : (/[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
    sum += (Number.isFinite(v) ? v : 0) * W[i % 3];
  }
  return String(sum % 10);
}

const pad = (text, len) => mrzFold(text).replace(/ /g, '<').slice(0, len).padEnd(len, '<');

// "1985-03-14" / "14.03.1985" → "850314" (the strip's YYMMDD). Anything we
// can't read confidently stays filler rather than being guessed at.
function mrzDate(value) {
  const v = String(value || '').trim();
  let y; let m; let d;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(v);
  if (iso) { [, y, m, d] = iso; } else if (dmy) { [, d, m, y] = dmy; } else return '<<<<<<';
  return `${String(y).slice(2)}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

// Two 44-character lines, the shape of a passport data page's machine zone.
// Purely presentational — it is generated FROM the record on every render and
// never stored, so it can't drift from the fields above it, and it carries
// nothing the card isn't already showing in plain text.
export function identityMrz(identity) {
  if (!identity) return [];
  const org = identity.kind === 'org';
  const { surname, given } = identityNameParts(identity);
  const code = org ? 'C<' : 'I<';
  const issuer = pad(identity.nationality || 'ROU', 3);
  const fill = (text) => mrzFold(text).replace(/ /g, '<');
  const name = `${fill(surname) || '<'}<<${fill(given)}`;
  const line1 = `${code}${issuer}${name}`.slice(0, 44).padEnd(44, '<');

  const docNo = pad(org ? identity.regNo : identityValueForField(identity, 'idDocument'), 9);
  const personal = pad(org ? identity.taxId : identity.nationalId, 14);
  const dob = org ? '<<<<<<' : mrzDate(identity.dateOfBirth);
  const body = `${docNo}${mrzCheck(docNo)}${issuer}${dob}${mrzCheck(dob)}<<<<<<<${personal}`;
  const line2 = `${body}${mrzCheck(personal)}`.slice(0, 43).padEnd(43, '<');
  return [line1, `${line2}${mrzCheck(line2)}`];
}

// Initials for the card's portrait panel — the monogram that stands in for the
// photograph a real document would carry.
export function identityInitials(identity) {
  const { surname, given } = identityNameParts(identity);
  const letters = `${surname[0] || ''}${given[0] || ''}`.trim();
  return (letters || String(identity?.name || '?')[0] || '?').toUpperCase();
}

// ── Derived fields ──────────────────────────────────────────────────────
// A record keeps an address as ONE string and an ID document as ONE string,
// because that is how a person reads them back. A Romanian identification
// clause takes them apart:
//
//   domiciliat în [[localitatea]], str. [[…]], nr. [[…]], bl. [[…]], sc. [[…]],
//   ap. [[…]], județul [[…]], identificat cu CI seria [[…]] nr. [[…]]
//
// Nine blanks, two stored values. So the splitters below take the stored string
// apart the same way the clause does, and the field table exposes each piece as
// its own key. Nothing new is stored — a derived key is computed on demand from
// the field it comes from, so the record stays the one a human edits.

// Everything a Romanian address line can carry, in the order it is normally
// written. `null` for a part the address doesn't mention — never a guess.
//
// The address is ONE field because that is how a person knows an address and
// how it arrives in a document. Taking it apart is this function's job, and the
// job is harder than it looks: every part has a full word, a short word and an
// abbreviation ("Bloc" / "Bl." / "bl"), the markers may or may not carry a dot
// or a colon, the parts arrive in any order, and a house number can be "12A",
// "12 bis", "141-143" or "12/3".
//
// The trap this table exists to avoid: a naive `bl\.?` matches the first two
// letters of "Bloc" and reads the block as "oc". Every marker below is anchored
// with \b on BOTH sides and lists its long forms before its short ones, so the
// longest name wins and a prefix can never eat a word that merely starts the
// same way. Same for "sc" inside "Scara" and "et" inside "Etaj".
const RO_DIA = '[ăâîșşțţĂÂÎȘŞȚŢ]';
// Thoroughfare words, longest first.
// Diacritics are written both ways in practice ("Soseaua" / "Șoseaua"), and a
// list that only knows one of them silently drops the street.
const THOROUGHFARE = [
  'strada', 'str[aă]du[tțţ]a', 'stradela', 'str',
  'bulevardul', 'b-dul', 'bdul', 'bd', 'blvd',
  'calea', 'aleea', '[sșş]oseaua', '[sșş]os', 'pia[tțţ]a',
  'intrarea', 'intr', 'drumul', 'fundacul', 'prelungirea', 'splaiul', 'cartierul',
].join('|');
// "12", "12A", "12 bis", "12/3", "141-143".
const HOUSE_NO = '\\d+\\s*[A-Za-z]?(?:\\s*bis)?(?:\\s*[/-]\\s*\\d+\\s*[A-Za-z]?)?';

// A labelled part: its marker words (longest first), then an optional dot or
// colon, then the value. `\b` on both sides of the marker is what stops "bl"
// from matching inside "Bloc".
function partRe(words, value) {
  return new RegExp(`\\b(?:${words})\\b\\s*[.:]?\\s*(${value})`, 'i');
}

const PART_RES = {
  number: partRe('num[ăa]rul|num[ăa]r|nr|no', HOUSE_NO),
  block: partRe('blocul|bloc|bl', '[\\w.-]+'),
  stair: partRe('scara|sc', '[\\w.-]+'),
  floor: partRe('etajul|etaj|et', '[\\w.-]+'),
  apartment: partRe('apartamentul|apartament|apt|ap', '[\\w.-]+'),
  postalCode: partRe('cod po[sșşt]tal|cod postal|cod po[sșş]tal|cod|cp', '\\d{6}'),
};

// Words that mark a segment as one of the parts above (or a locality/county
// marker), used to rule a segment out as a bare town name or street.
const PART_WORD = new RegExp(
  `\\b(?:${THOROUGHFARE}|num[ăa]rul|num[ăa]r|nr|no|blocul|bloc|bl|scara|sc|etajul|etaj|et`
  + `|apartamentul|apartament|apt|ap|jude[tțţ]ul|jude[tțţ]|jud|sectorul|sector|cod|cp)\\b`,
  'i',
);

export function splitAddress(address) {
  const raw = String(address || '').trim();
  const out = {
    street: null, number: null, block: null, stair: null, floor: null,
    apartment: null, locality: null, county: null, sector: null, postalCode: null,
  };
  if (!raw) return out;
  const clean = (v) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '').trim() || null);
  const pick = (re) => { const m = re.exec(raw); return m ? clean(m[1]) : null; };

  // The postal code first: it is six digits, and reading it before anything
  // else keeps it from being taken for a house number.
  out.postalCode = pick(PART_RES.postalCode) || (/(?:^|[,;]\s*)(\d{6})(?:\s*$|[,;])/.exec(raw)?.[1] ?? null);
  for (const key of ['number', 'block', 'stair', 'floor', 'apartment']) {
    out[key] = pick(PART_RES[key]);
  }
  // A six-digit postal code must never come back as the house number.
  if (out.number && out.number === out.postalCode) out.number = null;

  // County and sector are TWO things, not one. București is itself a county —
  // the capital is a județ in its own right — and it is the only one divided
  // into sectors. So "Sector 2, București" is both "sectorul 2" AND "județul
  // București", and an address there has to be able to say either.
  out.sector = pick(new RegExp(`\\b(sector(?:ul)?\\s*\\d)\\b`, 'i'));
  out.county = pick(new RegExp(`\\bjude[tțţ](?:ul)?\\b\\s*[.:]?\\s*([^,;]+)`, 'i'))
    || pick(new RegExp(`\\bjud\\b\\s*[.:]?\\s*([^,;]+)`, 'i'));

  // Street: the thoroughfare word, then everything up to the next comma, the
  // number marker, or a bare trailing house number.
  out.street = pick(new RegExp(
    `(?:^|[,;]\\s*)(?:${THOROUGHFARE})\\b\\s*[.:]?\\s*([^,;]+?)`
    + `(?=\\s*(?:[,;]|\\s+(?:num[ăa]rul|num[ăa]r|nr|no)\\b|\\s+${HOUSE_NO}\\s*(?:[,;]|$)|$))`,
    'i',
  ));
  // …and without the marker: a segment that ENDS in a house number is a street
  // and its number. "Mihai Eminescu 12" is how most people type an address.
  if (!out.street || !out.number) {
    for (const seg of raw.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
      const m = new RegExp(`^(?:(?:${THOROUGHFARE})\\b\\s*[.:]?\\s*)?(.+?)\\s+(${HOUSE_NO})$`, 'i').exec(seg);
      if (!m) continue;
      const name = clean(m[1]);
      // Guard against reading "Sector 2", "Bloc 4" or "Cod Poștal 021652" as a
      // street: any of those carries a part word.
      if (!name || PART_WORD.test(name)) continue;
      if (!out.street) out.street = name;
      if (!out.number) out.number = clean(m[2]);
      break;
    }
  }
  // A thoroughfare word with no number at all — "Str. Lungă".
  if (!out.street) {
    out.street = pick(new RegExp(`(?:^|[,;]\\s*)(?:${THOROUGHFARE})\\b\\s*[.:]?\\s*([^,;]+)`, 'i'));
  }

  out.locality = pick(new RegExp(
    `\\b(?:municipiul|mun|ora[sșş]ul|ora[sșş]|comuna|com|satul|sat|localitatea)\\b\\s*[.:]?\\s*([^,;]+)`,
    'i',
  ));
  if (!out.locality) {
    // Whatever comma-segment is left once the parts above are accounted for —
    // in practice the bare town name, which is how addresses are usually typed.
    const rest = raw.split(/[,;]/)
      .map((p) => p.trim())
      .filter((p) => p && !PART_WORD.test(p) && !/\d/.test(p));
    out.locality = clean(rest[0]);
  }
  // An address in the capital states its county by stating its city, and a
  // sector implies the capital even when the city was left out. Neither has to
  // be typed twice.
  const capital = /^bucuresti$|^bucharest$/;
  if (!out.county && (capital.test(foldLabel(out.locality || '')) || out.sector)) {
    // Always the canonical spelling: the county goes into a legal document,
    // and it should read the same whether the line was typed "Bucuresti",
    // "București" or left to be inferred from a sector.
    out.county = 'București';
  }
  if (!out.locality && out.sector) out.locality = 'București';
  return out;
}

// "RX 456789" / "seria RX nr. 456789" / "RX-456789" → { series, number }.
export function splitIdDocument(doc) {
  const raw = String(doc || '').trim();
  const out = { series: null, number: null };
  if (!raw) return out;
  // An explicit "seria XX" wins; otherwise the leading letter group, anchored to
  // the start so the "nr" in "seria RX nr. 456789" can't be read as the series.
  const explicit = /seria\s*([A-Za-z]{1,3})\b/i.exec(raw);
  const leading = /^\s*([A-Za-z]{1,3})\b(?=[\s.\-/]*\d)/.exec(raw);
  if (explicit) out.series = explicit[1].toUpperCase();
  else if (leading) out.series = leading[1].toUpperCase();
  const n = /(\d{4,})/.exec(raw);
  if (n) out.number = n[1];
  // No letters at all — the whole thing is the number.
  if (!out.series && !out.number && raw) out.number = raw;
  return out;
}

// ── Blanks → identity fields ────────────────────────────────────────────
// A drafted contract is mostly blanks about PEOPLE: "[[numele vânzătorului]]",
// "[[CNP-ul cumpărătorului]]", "[[adresa completă]]". Every one of those is
// already recorded on some identity in the project, so the viewer offers to
// fill them all from one record instead of making the user retype what it
// knows.
//
// The match is on the words inside the brackets, by rule rather than by AI:
// filling a contract's parties is not a judgement call, and a table that runs
// instantly and identically every time is worth more here than one that is
// cleverer but occasionally surprising. Anything the rules don't recognise is
// left to the per-field inputs, which is why those stay.
//
// Two things make the table work on real drafts. Everything is compared with
// diacritics folded away, so "vânzătorului" and "vanzatorului" are the same
// word and no rule has to be written twice. And each synonym matches with its
// Romanian enclitic article attached — "telefon" catches "telefonul", "nume"
// catches "numele" — while still refusing "numerar", which a bare substring
// test would have read as a name.
//
// ORDER MATTERS twice over. The broad name rule is LAST, because "numele
// vânzătorului" contains "nume" and would otherwise swallow half the table. And
// the contact fields come before the address, because "adresa de email" is an
// email and a rule for "adresa" would otherwise claim it on the way past.
const IDENTITY_FIELD_SYNONYMS = [
  ['nationalId', ['cnp', 'cod numeric personal', 'personal numeric code', 'national id',
    'national identification number', 'idnp']],
  ['taxId', ['cui', 'cif', 'cod fiscal', 'cod unic de inregistrare', 'vat', 'tva',
    'tax id', 'tax number', 'vat number', 'vat id']],
  ['regNo', ['reg com', 'registrul comertului', 'nr de ordine', 'numar de ordine',
    'nr de inregistrare', 'numar de inregistrare', 'trade register', 'trade registry',
    'registration number', 'registration no', 'company number', 'company registration']],
  ['idDocument', ['carte de identitate', 'act de identitate', 'document de identitate',
    'buletin', 'seria si numarul', 'seria si nr', 'serie si numar', 'seria', 'serie',
    'identity card', 'identity document', 'id card', 'id document', 'id series',
    'pasaport', 'passport']],
  ['dateOfBirth', ['data nasterii', 'data si locul nasterii', 'nascut', 'nascuta',
    'date of birth', 'birth date', 'dob', 'born on', 'born']],
  // "eliberat de …" / "la data de …" — the two blanks the identification clause
  // asks for right after the series and number, and which used to fall through
  // to nothing because the record had nowhere to keep them.
  ['idIssuer', ['eliberat de', 'eliberata de', 'emis de', 'emisa de', 'eliberat', 'eliberata',
    'issued by', 'issuing authority', 'authority']],
  ['idIssuedAt', ['data eliberarii', 'data emiterii', 'la data de', 'eliberat la', 'eliberata la',
    'date of issue', 'issued on', 'issue date']],
  ['idType', ['tipul actului', 'tip act', 'felul actului', 'act de identitate tip', 'id type',
    'document type', 'type of id']],
  ['placeOfBirth', ['locul nasterii', 'nascut in', 'nascuta in', 'place of birth', 'born in']],
  ['repCapacity', ['in calitate de', 'calitatea de', 'calitate', 'acting as', 'capacity']],
  ['iban', ['iban', 'contul bancar', 'cont bancar', 'cont', 'bank account', 'account number']],
  ['bank', ['deschis la', 'banca', 'unitatea bancara', 'bank', 'branch']],
  ['nationality', ['cetatenia', 'cetatenie', 'nationalitate', 'nationality', 'citizenship']],
  ['legalForm', ['forma juridica', 'legal form', 'entity type', 'type of entity']],
  ['representative', ['reprezentat legal', 'reprezentata legal', 'reprezentat prin',
    'reprezentata prin', 'reprezentant legal', 'reprezentant', 'reprezentanta',
    'represented by', 'legal representative', 'acting through', 'through its representative']],
  ['country', ['tara', 'statul', 'country', 'state of residence']],
  ['email', ['email', 'e mail', 'adresa de email', 'posta electronica', 'electronic mail']],
  ['phone', ['telefon', 'nr de telefon', 'numar de telefon', 'phone', 'phone number',
    'telephone', 'mobil', 'mobile']],
  ['address', ['adresa', 'adresa completa', 'domiciliu', 'domiciliat', 'domiciliata',
    'sediul social', 'sediul', 'sediu', 'resedinta', 'address', 'full address', 'domicile',
    'registered office', 'place of residence', 'residing at', 'registered address']],
  ['aka', ['alias', 'cunoscut ca', 'cunoscuta ca', 'also known as', 'aka',
    'denumire comerciala', 'trading name']],
  ['legalName', ['numele complet', 'nume complet', 'numele si prenumele', 'nume si prenume',
    'denumirea completa', 'denumirea', 'denumire', 'numele', 'nume', 'prenume', 'prenumele',
    'full legal name', 'full name', 'legal name', 'company name', 'name', 'surname']],
];

// The address and ID-document pieces, in the order a Romanian identification
// clause writes them. They come BEFORE the whole-value rules below, so
// "str. […]" resolves to the street rather than to the address as a whole.
const IDENTITY_PART_SYNONYMS = [
  ['addressStreet', ['strada', 'str', 'bulevardul', 'bdul', 'bd', 'calea', 'aleea',
    'soseaua', 'sos', 'piata', 'intrarea', 'drumul', 'street']],
  ['addressBlock', ['blocul', 'bloc', 'bl', 'block']],
  ['addressStair', ['scara', 'sc', 'staircase']],
  ['addressFloor', ['etajul', 'etaj', 'et', 'floor']],
  ['addressApartment', ['apartamentul', 'apartament', 'ap', 'apt', 'apartment']],
  ['addressPostalCode', ['cod postal', 'codul postal', 'cod po', 'postal code', 'zip', 'zip code']],
  // A label naming BOTH — the "județul/sectorul" a formula is drafted with — is
  // its own answer: whichever of the two this address actually has.
  ['addressCountyOrSector', ['judetul sectorul', 'judet sector', 'jud sect', 'jud sector', 'sectorul judetul']],
  ['addressSector', ['sectorul', 'sector']],
  ['addressCounty', ['judetul', 'judet', 'jud', 'county']],
  ['addressLocality', ['localitatea', 'localitate', 'municipiul', 'orasul', 'oras',
    'comuna', 'satul', 'city', 'town', 'locality']],
  ['idSeries', ['ci seria', 'seria', 'serie', 'series']],
];

// Lowercase, strip diacritics, and reduce everything else to single spaces, so
// one written form of a word is the only one the table has to carry.
function foldLabel(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ș|ş/gi, 's').replace(/ț|ţ/gi, 't')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A synonym matches as a whole word, optionally carrying a Romanian enclitic
// article or plural ending. "telefon" → telefonul, "nume" → numele, but NOT
// numerar; "adresa" → adresa, adresele.
const SUFFIX = '(?:a|e|i|l|ul|ului|ua|ue|le|lui|lor|ei|ii|iei|elor|urile|urilor|s)?';
const IDENTITY_FIELD_MATCHERS = [...IDENTITY_PART_SYNONYMS, ...IDENTITY_FIELD_SYNONYMS].map(([key, syns]) => [
  key,
  syns.map((syn) => new RegExp(`\\b${escapeRe(foldLabel(syn))}${SUFFIX}\\b`)),
]);

// Which identity field is this blank asking for, if any? `label` is the text
// inside the placeholder's brackets (see fieldLabel in the Doc Viewer).
export function identityFieldForLabel(label) {
  const t = foldLabel(label);
  if (!t) return null;
  // "seria și nr. CI" as ONE blank asks for the whole document, not the half
  // that "seria" alone would resolve to. Checked before the part rules, which
  // would otherwise stop at the first word they recognise.
  if (/\bseri[ae]\b|\bseries\b/.test(t) && /\b(?:nr|numarul|numar|number)\b/.test(t)) return 'idDocument';
  for (const [key, res] of IDENTITY_FIELD_MATCHERS) {
    if (res.some((re) => re.test(t))) return key;
  }
  return null;
}

// Labels that name a slot without saying what goes in it. On their own they are
// unresolvable — "nr." is a street number after a street and an ID number after
// a series — so they are answered by what came before them. See resolveIdentityFields.
const WEAK_NUMBER = /^(?:nr|no|numarul|numar|number)\b/;
// What a bare "nr." means, given the blank resolved just before it.
const NUMBER_AFTER = {
  addressStreet: 'addressNumber',
  idSeries: 'idNumber',
};

// ── The canonical placeholder vocabulary ────────────────────────────────
// Everything above this line is RECOVERY: reading a blank that was written by
// a human, or by a model that ignored the house style, and guessing what it
// wants from the words around it. It works, but it is guessing, and guessing is
// where a value lands in the wrong gap.
//
// So generated documents are told to name their blanks from this list instead:
//
//   [[legalName]]                  a field, filled from whichever party the
//                                  user picks for the paragraph
//   [[seller.legalName]]           the same field, tied to a named party, so a
//                                  clause naming two people fills from two
//                                  different records
//
// The token IS the identity field's own name, so recognition is a lookup rather
// than a judgement. Keep this list in step with PLACEHOLDER_RULE in
// supabase/functions/project-ai/index.ts, which publishes it to the model.
//
// The derived names (addressStreet…, idSeries/idNumber) are the pieces a
// Romanian identification clause asks for one at a time; splitAddress and
// splitIdDocument above compute them from the single string the record stores.
export const IDENTITY_FIELD_KEYS = [
  'legalName', 'aka',
  'nationalId', 'dateOfBirth', 'placeOfBirth', 'nationality',
  'idType', 'idDocument', 'idSeries', 'idNumber', 'idIssuer', 'idIssuedAt',
  'taxId', 'regNo', 'legalForm', 'representative', 'repCapacity', 'iban', 'bank',
  'address', 'addressStreet', 'addressNumber', 'addressBlock', 'addressStair',
  'addressFloor', 'addressApartment', 'addressLocality', 'addressCounty', 'addressSector',
  'addressCountyOrSector', 'addressPostalCode',
  'city', 'county', 'country',
  'email', 'phone',
];

// Case-insensitive lookup, so a model that writes [[LegalName]] or
// [[address_street]] is still understood exactly rather than falling through to
// the heuristics.
const KEY_BY_NORMALISED = new Map(
  IDENTITY_FIELD_KEYS.map((k) => [k.toLowerCase(), k]),
);

// A canonical token → { role, key }. Returns null for anything that isn't one,
// which is the signal to fall back to the word rules.
//
// `role` is whatever the document called the party ("seller", "vanzator",
// "buyer") — it is never interpreted, only used to group blanks that belong to
// the same person, so the panel can offer one record per party.
export function parseFieldToken(label) {
  const t = String(label || '').trim();
  if (!t || /\s/.test(t)) return null;          // a token is one word, dotted
  const bits = t.split('.').filter(Boolean);
  if (!bits.length || bits.length > 3) return null;
  const norm = (x) => x.toLowerCase().replace(/[_-]/g, '');
  // Longest suffix that names a field: "seller.address.street" and
  // "seller.addressStreet" both land on addressStreet.
  const last = norm(bits[bits.length - 1]);
  const joined2 = bits.length >= 2 ? norm(bits[bits.length - 2] + bits[bits.length - 1]) : '';
  let key = KEY_BY_NORMALISED.get(last) || null;
  let used = 1;
  if (!key && joined2 && KEY_BY_NORMALISED.get(joined2)) { key = KEY_BY_NORMALISED.get(joined2); used = 2; }
  if (!key) return null;
  const role = bits.slice(0, bits.length - used).join('.').toLowerCase() || null;
  return { role, key };
}

// Resolve a paragraph's blanks IN ORDER, because that is the only way some of
// them can be read at all.
//
// A Romanian identification clause labels its blanks in the prose before them
// rather than inside them — "str. […], nr. […], bl. […] … CI seria […] nr. […]"
// — so two blanks can carry the same word and mean different things. Reading
// them left to right settles it: the "nr." after a street is a house number,
// the "nr." after a series is a document number.
//
// `labels` is one entry per blank, in document order; the answer is the same
// length, with null for blanks that name nothing this app records.
export function resolveIdentityFields(labels) {
  const out = [];
  let prev = null;
  for (const label of labels || []) {
    // A canonical token settles it outright — that is the whole point of
    // generating them. Only a blank that ISN'T one goes through the guessing.
    const token = parseFieldToken(label);
    if (token) {
      out.push({ key: token.key, role: token.role });
      prev = token.key;
      continue;
    }
    const folded = foldLabel(label);
    let key = identityFieldForLabel(label);
    if (!key && WEAK_NUMBER.test(folded)) key = NUMBER_AFTER[prev] || null;
    // "nr." matched as a part word can still be the weak one — a house number
    // only if a street came first, a document number only after a series.
    if (key === 'addressNumber' && prev !== 'addressStreet' && !/strad|str\b/.test(folded)) {
      key = NUMBER_AFTER[prev] || key;
    }
    out.push({ key, role: null });
    if (key) prev = key;
  }
  return out;
}

// Parts of an address that only exist in a block of flats. When the address
// being filled in is a house, these are not blanks left empty — they are lines
// the clause should not carry at all.
export const APARTMENT_ONLY_FIELDS = ['addressBlock', 'addressStair', 'addressFloor', 'addressApartment'];

// Does this address describe a flat? Any of the block-of-flats parts being
// present says yes; a bare street and number says no.
export function addressIsApartment(identityOrAddress) {
  // Accepts a record (the parts) or a bare string (the legacy line), because
  // both are still in circulation.
  const rec = typeof identityOrAddress === 'string'
    ? { address: identityOrAddress }
    : (identityOrAddress || {});
  return APARTMENT_ONLY_FIELDS.some((k) => !!identityValueForField(rec, k));
}

// The value a record offers for one field — including the derived ones, which
// are computed from the single string the record actually stores.
export function identityValueForField(identity, key) {
  if (!identity || !key) return '';
  if (key === 'legalName') return String(identity.legalName || identity.name || '').trim();
  // `city` and `addressLocality` name the same thing by two routes, so they
  // answer identically: the typed city if there is one — better than a guess —
  // and otherwise whatever the address line parses to.
  if (key === 'addressLocality' || key === 'city') {
    const typed = String(identity.city || '').trim();
    return typed || String(splitAddress(identity.address).locality || '').trim();
  }
  if (key === 'addressCounty' || key === 'county') {
    const typed = String(identity.county || '').trim();
    if (typed) {
      // The one field on the form holds whichever the user had; if they typed a
      // sector into it, the county is still the capital.
      const seen = classifyCounty(typed, identity.city);
      return seen.kind === 'sector' && seen.value !== 'București' ? 'București' : (seen.value || typed);
    }
    return String(splitAddress(identity.address).county || '').trim();
  }
  if (key === 'addressSector') {
    const typed = classifyCounty(identity.county, identity.city);
    if (typed.kind === 'sector' && typed.value !== 'București') return typed.value;
    return String(splitAddress(identity.address).sector || '').trim();
  }
  // The blank a formula leaves open — "județul/sectorul […]" — takes whichever
  // of the two this address has. In the capital that is the sector; everywhere
  // else it is the county.
  if (key === 'addressCountyOrSector') {
    const sector = identityValueForField(identity, 'addressSector');
    return sector || identityValueForField(identity, 'addressCounty');
  }
  if (key.startsWith('address') && key !== 'address') {
    const typed = String(identity[key] || '').trim();
    if (typed) return typed;
    // Nothing typed — a record from before the split, so read the part out of
    // the single line it used to be kept in.
    const part = key.slice('address'.length);
    const bits = splitAddress(identity.address);
    return String(bits[part.charAt(0).toLowerCase() + part.slice(1)] || '').trim();
  }
  // A blank that wants the address WHOLE gets it written back up in Romanian
  // order from the resolved parts, so it can never disagree with them.
  if (key === 'address') {
    const p = (k) => identityValueForField(identity, k);
    const line = [
      p('addressStreet') && `Str. ${p('addressStreet')}`,
      p('addressNumber') && `nr. ${p('addressNumber')}`,
      p('addressBlock') && `bl. ${p('addressBlock')}`,
      p('addressStair') && `sc. ${p('addressStair')}`,
      p('addressFloor') && `et. ${p('addressFloor')}`,
      p('addressApartment') && `ap. ${p('addressApartment')}`,
      p('addressLocality'),
      p('addressSector'),
      p('addressCounty') && `jud. ${p('addressCounty')}`,
    ].filter(Boolean);
    // "Str. X nr. Y" reads as one phrase; everything after it is comma-separated.
    const head = line.slice(0, 2).join(' ');
    const rest = line.slice(2);
    const composed = [head, ...rest].filter(Boolean).join(', ');
    return composed || String(identity.address || '').trim();
  }
  if (key === 'idSeries' || key === 'idNumber') {
    const typed = String(identity[key] || '').trim();
    if (typed) return typed;
    // Nothing typed — this is a record from before the split, so read it out of
    // the single string it used to be kept in.
    const bits = splitIdDocument(identity.idDocument);
    return String((key === 'idSeries' ? bits.series : bits.number) || '').trim();
  }
  // "seria și nr." as ONE blank wants the whole act — built back from the parts
  // rather than stored a second time, so it can never disagree with them.
  if (key === 'idDocument') {
    // Composed from the RESOLVED halves, not the raw ones — a record that was
    // half-migrated (a series typed in, the number still only in the old
    // string) has to come out whole rather than as the one part that moved.
    const composed = [
      identityValueForField(identity, 'idSeries'),
      identityValueForField(identity, 'idNumber'),
    ].filter(Boolean).join(' ');
    return composed || String(identity.idDocument || '').trim();
  }
  return String(identity[key] || '').trim();
}

// Every identity record ANYWHERE in the project folder, not just the ones in
// Identities/ — records reach a project by other routes, and one the user can
// see in the Files tab is one they will expect to fill from. Reading is what
// decides: readIdentityIfRecord returns null for ordinary JSON.
const IDENTITY_SCAN_MAX = 60;
export async function listProjectIdentities(projectDir) {
  if (!projectDir) return [];
  try {
    const { files } = await localFolderApi.listAll(projectDir);
    const candidates = (files || [])
      .filter((f) => f?.name && !f.name.startsWith('.') && isIdentityCandidate(f.name))
      .slice(0, IDENTITY_SCAN_MAX);
    const out = [];
    for (const f of candidates) {
      const rec = await readIdentityIfRecord(f.path || f.name);
      if (rec) out.push({ ...rec, _path: f.path || null, _fileName: f.name });
    }
    // Named parties first, then by name, so the list reads like a cast list.
    return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  } catch {
    return [];
  }
}

// One-line description for a tile or a list row.
export function identitySummary(identity) {
  if (!identity) return '';
  const bits = [
    identity.role,
    identity.kind === 'org' ? identity.taxId || identity.regNo : identity.nationalId,
  ].filter(Boolean);
  return bits.join(' · ');
}

// ── Folder IO ────────────────────────────────────────────────────────────
// Everything lives in one `Identities/` subfolder so the project root stays the
// documents themselves. The folder is created on first write.

export function identityDirIn(projectDir) {
  if (!projectDir) return '';
  const sep = projectDir.includes('\\') ? '\\' : '/';
  return `${projectDir.replace(/[\\/]+$/, '')}${sep}${IDENTITY_FOLDER}`;
}

export async function ensureIdentityDir(projectDir) {
  if (!projectDir) return '';
  const dir = identityDirIn(projectDir);
  // Already there → createFolder reports an error we can ignore; the write
  // that follows is the real test of whether the folder is usable.
  await localFolderApi.createFolder({ dir: projectDir, name: IDENTITY_FOLDER }).catch(() => null);
  return dir;
}

// Every identity in the project, newest first. Missing folder → empty list.
export async function listIdentities(projectDir) {
  if (!projectDir) return [];
  try {
    const { files } = await localFolderApi.list(identityDirIn(projectDir));
    const found = (files || []).filter((f) => isIdentityFile(f?.name));
    const out = [];
    for (const f of found) {
      const rec = await readIdentity(f.path || f.name);
      if (rec) out.push({ ...rec, _path: f.path || null, _fileName: f.name });
    }
    return out;
  } catch {
    return [];
  }
}

export async function readIdentity(pathOrName) {
  try {
    const blob = await readLocalBlob(pathOrName);
    if (!blob) return null;
    return parseIdentity(await blob.text());
  } catch {
    return null;
  }
}

// Write a record. `previousFileName` lets a rename replace the old file instead
// of leaving a stale duplicate behind when the person's name is corrected.
export async function writeIdentity(projectDir, identity, { previousFileName } = {}) {
  if (!projectDir) return { error: 'no_folder' };
  const dir = await ensureIdentityDir(projectDir);
  const filename = identityFileName(identity);
  const record = { ...identity, updatedAt: new Date().toISOString() };
  const { results, error } = await localFolderApi.writeFiles({
    dir,
    files: [{ filename, blob: identityBlob(record) }],
  });
  const res = results?.[0];
  if (error || !res?.ok) return { error: error || res?.error || 'write_failed' };
  if (previousFileName && previousFileName !== filename) {
    const sep = dir.includes('\\') ? '\\' : '/';
    await localFolderApi.deleteFiles({ dir, paths: [`${dir}${sep}${previousFileName}`] }).catch(() => null);
  }
  return { ok: true, path: res.path, filename, identity: record };
}

// Save a record back to the exact file it was opened from — what the Doc
// Viewer does. Separate from writeIdentity because the viewer knows the file's
// own path, not the project folder, and must not move it: a window whose file
// silently relocated mid-edit would lose its tab.
//
// Renaming the party is still honoured — the caller gets the new filename back
// and repoints its tab, the same way the AI document generator does when it
// renames a file it just wrote.
export async function saveIdentityAt(filePath, identity, { rename = true } = {}) {
  if (!filePath) return { error: 'no_path' };
  const sep = filePath.includes('\\') ? '\\' : '/';
  const dir = filePath.slice(0, filePath.lastIndexOf(sep));
  const current = filePath.slice(filePath.lastIndexOf(sep) + 1);
  const wanted = identityFileName(identity);
  const filename = rename ? wanted : current;
  const record = { ...identity, updatedAt: new Date().toISOString() };
  const { results, error } = await localFolderApi.writeFiles({
    dir,
    files: [{ filename, blob: identityBlob(record) }],
  });
  const res = results?.[0];
  if (error || !res?.ok) return { error: error || res?.error || 'write_failed' };
  if (filename !== current) {
    await localFolderApi.deleteFiles({ dir, paths: [filePath] }).catch(() => null);
  }
  return { ok: true, path: res.path, filename, renamed: filename !== current, identity: record };
}

// Fold AI-extracted records into what's already on disk: an existing identity
// with the same name is UPDATED (empty fields filled, sources merged) rather
// than duplicated, and fields the user already typed are never overwritten.
export function mergeIdentity(existing, incoming) {
  if (!existing) return incoming;
  const out = { ...existing };
  for (const key of Object.keys(incoming)) {
    if (['id', 'createdAt', 'updatedAt', 'sources', 'origin', 'version'].includes(key)) continue;
    const cur = String(out[key] ?? '').trim();
    const next = String(incoming[key] ?? '').trim();
    if (!cur && next) out[key] = next;
  }
  out.sources = Array.from(new Set([...(existing.sources || []), ...(incoming.sources || [])]));
  return out;
}

// Match on name, case- and spacing-insensitively — the AI writes "Ion Popescu"
// where the user typed "ion  popescu".
export function identityKey(identity) {
  return String(identity?.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}
