/**
 * G-immo — documents légaux (CGU, politique de confidentialité) et preuves d'acceptation.
 *
 * Version en vigueur d'un document : la dernière publiée dont la date d'effet est atteinte (date d'effet la plus récente,
 * puis identifiant le plus grand). Chaque utilisateur des entreprises, propriétaire ou client doit avoir accepté les
 * versions en vigueur ; les comptes de la plateforme (administrateur, responsable pays) ne sont pas concernés.
 */
import { randomUUID } from 'node:crypto'
import { todayIso } from './commun.js'

export const TYPES_LEGAUX = ['cgu', 'confidentialite']
export const CHAMPS_VERROUILLES = ['type', 'version', 'date_effet', 'titre_fr', 'titre_en', 'contenu_fr', 'contenu_en']
const ROLES_PLATEFORME = ['Administrator', 'Responsable pays']
const CHAMPS = ['id', 'type', 'version', 'date_effet', 'titre_fr', 'titre_en', 'resume_fr', 'resume_en']

/** Versions en vigueur, par type : { cgu: {...} | undefined, confidentialite: {...} | undefined }. */
export async function documentsCourants(db) {
  const lignes = await db('documents_legaux').where({ statut: 'publie' }).where('date_effet', '<=', todayIso())
    .orderBy([{ column: 'date_effet', order: 'desc' }, { column: 'id', order: 'desc' }]).select(CHAMPS)
  const courants = {}
  for (const l of lignes) if (!courants[l.type]) courants[l.type] = l
  return courants
}

/**
 * Contrôle des versions acceptées à l'inscription ou à l'activation d'un compte : message d'erreur, ou null.
 * Les identifiants envoyés doivent être exactement ceux des versions en vigueur (page affichée avant une mise à jour).
 */
export function controleVersions(courants, acceptes) {
  if (TYPES_LEGAUX.some(t => !courants[t])) return { code: 'INDISPONIBLE', message: 'Les inscriptions sont momentanément indisponibles. Réessayez plus tard.' }
  if (TYPES_LEGAUX.some(t => Number(acceptes?.[t]) !== courants[t].id)) return { code: 'PERIME', message: 'Les conditions ont été mises à jour : rechargez la page pour lire et accepter la nouvelle version.' }
  return null
}

/** Enregistre l'acceptation des documents (une seule ligne par utilisateur et par version). */
export async function enregistrerAcceptations(db, utilisateur, documents, contexte, langue) {
  const deja = new Set((await db('acceptations_legales').where({ utilisateur }).whereIn('document', documents).pluck('document')).map(Number))
  const lignes = documents.filter(d => !deja.has(Number(d))).map(document => ({
    id: randomUUID(), utilisateur, document, contexte, langue: langue === 'en' ? 'en' : 'fr', date_acceptation: new Date(),
  }))
  if (lignes.length) await db('acceptations_legales').insert(lignes)
  return lignes.length
}

/** Comptes de la plateforme : non concernés par l'acceptation. */
export async function estPlateforme(db, utilisateur) {
  const u = await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', utilisateur).first('r.name')
  return ROLES_PLATEFORME.includes(u?.name)
}

/** Versions en vigueur que l'utilisateur n'a pas encore acceptées. */
export async function aAccepter(db, utilisateur) {
  const courants = Object.values(await documentsCourants(db))
  if (!courants.length) return []
  const acceptes = new Set((await db('acceptations_legales').where({ utilisateur }).whereIn('document', courants.map(d => d.id)).pluck('document')).map(Number))
  return courants.filter(d => !acceptes.has(d.id))
}
