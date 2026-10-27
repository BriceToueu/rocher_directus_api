/**
 * G-immo — traduction des textes produits par le serveur (e-mails, notifications, PDF) : français / anglais.
 *
 * - Le texte français est la clé : tr('en', 'Séquestre {ref} ouvert', { ref }) ; dictionnaire anglais : i18n-en.json.
 * - Langue d'un destinataire : son profil (directus_users.language), sinon la langue du pays de son agence.
 * - Documents contractuels (quittances, relevés de gérance) : langue du pays de l'agence.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const EN = require('./i18n-en.json')

export const versLangue = (v) => (String(v ?? '').toLowerCase().startsWith('en') ? 'en' : 'fr')

const remplir = (texte, params) => (params ? texte.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m)) : texte)

/** Texte dans la langue demandée (le français reste tel quel ; une clé absente du dictionnaire reste en français). */
export function tr(langue, fr, params) {
  return remplir(langue === 'en' ? (EN[fr] ?? fr) : fr, params)
}

/** Langue du pays d'une agence. */
export async function langueAgence(db, agence) {
  if (!agence) return 'fr'
  const p = await db('agences as a').leftJoin('pays as p', 'p.id', 'a.pays').where('a.id', agence).first('p.langue')
  return versLangue(p?.langue)
}

/** Langue d'un utilisateur (profil), sinon celle du pays de son agence. */
export async function langueUtilisateur(db, user) {
  const u = await db('directus_users').where('id', user).first('language', 'agence')
  return u?.language ? versLangue(u.language) : langueAgence(db, u?.agence)
}

/** Langue d'un contact : celle de son compte en ligne s'il en a un, sinon celle du pays de l'agence. */
export async function langueContact(db, contact) {
  const c = await db('contacts').where('id', contact).first('utilisateur', 'agence')
  if (c?.utilisateur) {
    const u = await db('directus_users').where('id', c.utilisateur).first('language')
    if (u?.language) return versLangue(u.language)
  }
  return langueAgence(db, c?.agence)
}

// Langue prévue pour un e-mail envoyé par Directus juste après (invitation : le compte n'a pas encore de langue)
const memo = new Map()
export const memoriserLangue = (email, langue) => memo.set(String(email).toLowerCase(), { langue, jusqua: Date.now() + 5 * 60000 })
export function langueMemorisee(email) {
  const m = memo.get(String(email ?? '').toLowerCase())
  return m && m.jusqua > Date.now() ? m.langue : null
}
