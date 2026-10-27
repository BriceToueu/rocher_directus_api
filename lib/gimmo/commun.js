/**
 * G-immo — utilitaires partagés par les extensions (dates, montants, noms, rendu PDF).
 */
const pad = (n) => String(n).padStart(2, '0')

/** Date (Date pg à minuit local ou chaîne) → AAAA-MM-JJ. */
export const isoDate = (v) => {
  if (!v) return null
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  return String(v).slice(0, 10)
}
export const todayIso = () => isoDate(new Date())

export const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** « 1er août 2026 » (français) ou « 1 August 2026 » (anglais). */
export const dateLongue = (v, langue = 'fr') => {
  const [y, m, d] = isoDate(v).split('-').map(Number)
  return langue === 'en' ? `${d} ${MONTHS[m - 1]} ${y}` : `${d === 1 ? '1er' : d} ${MOIS[m - 1]} ${y}`
}

/** Montant en unité mineure → « 265 000 FCFA » / « 265,000 FCFA » (espaces simples : jeu de caractères des polices PDF standard). */
export function montant(v, devise, langue = 'fr') {
  const dec = Number(devise?.decimales ?? 0)
  const n = Number(v) / 10 ** dec
  const [ent, frac] = Math.abs(n).toFixed(dec).split('.')
  const [mil, virgule] = langue === 'en' ? [',', '.'] : [' ', ',']
  return `${n < 0 ? '-' : ''}${ent.replace(/\B(?=(\d{3})+(?!\d))/g, mil)}${frac ? virgule + frac : ''} ${devise?.symbole ?? ''}`.trim()
}

export const nomContact = (c) => c ? (c.raison_sociale || [c.prenom, c.nom].filter(Boolean).join(' ') || '—') : '—'

/** Flux PDFKit terminé → Buffer. */
export async function pdfBuffer(doc) {
  const chunks = []
  for await (const c of doc) chunks.push(c)
  return Buffer.concat(chunks)
}

/** Charte des documents PDF. */
export const PDF_COULEURS = { BRAND: '#004E9B', ACCENT: '#0091B9', MUTED: '#5B6B7F', LINE: '#D6E4EE', TEXTE: '#1A2B3C', FOND: '#EEF7FB' }
