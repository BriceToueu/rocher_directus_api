/**
 * G-immo — plateforme SaaS : licences des comptes entreprises (agences), modules selon le type de compte, limites d'offre.
 *
 * État de licence (agences.etat_licence, recalculé à chaque changement de licence et chaque nuit) :
 *   essai / active   licence en cours (date du jour entre début et fin) ;
 *   grace            licence échue depuis moins de 15 jours : tout fonctionne, des rappels sont envoyés ;
 *   lecture_seule    licence échue depuis plus de 15 jours, ou résiliée : consultation et export seulement,
 *                    annonces et programmes retirés du site public ;
 *   suspendue        suspension par l'administrateur de la plateforme (mêmes effets que la lecture seule) ;
 *   aucune           compte sans licence (mêmes effets).
 */
import { dateLongue, isoDate, todayIso } from './commun.js'
import { langueAgence, tr, versLangue } from './i18n.js'
import { destinatairesEntreprise, notifier } from './notifications.js'

export const DELAI_GRACE_JOURS = 15
export const ETATS_ECRITURE = ['essai', 'active', 'grace']
export const TYPES_COMPTE = ['agence', 'agent_independant', 'proprietaire_independant', 'promoteur_independant']

/** Collections fermées selon le type de compte (gestion locative pour le promoteur ; mandats pour le propriétaire). */
const GESTION_LOCATIVE = ['baux', 'echeances', 'quittances', 'mandats', 'mandats_biens', 'reversements', 'lignes_reversement', 'coordonnees_reversement', 'tickets_maintenance', 'tickets_maintenance_files', 'prestataires']
export const MODULES_FERMES = {
  promoteur_independant: GESTION_LOCATIVE,
  proprietaire_independant: ['mandats', 'mandats_biens', 'reversements', 'lignes_reversement', 'coordonnees_reversement'],
}
export const LIBELLE_TYPE = { agence: 'agence', agent_independant: 'agent indépendant', proprietaire_independant: 'propriétaire indépendant', promoteur_independant: 'promoteur indépendant' }

// ── Contrôle d'entreprise commun aux hooks (licence en écriture, modules du type de compte)
// Directus 12 enregistre les hooks des extensions en parallèle : l'ordre n'est pas garanti. Ce contrôle est donc appelé
// en tête des filtres génériques de gimmo-acces ET de gimmo-rules : il répond toujours avant les règles métier.
export const COLLECTIONS_ENTREPRISE = new Set([
  'contacts', 'biens', 'programmes', 'prestataires', 'annonces', 'ventes', 'echeances', 'paiements', 'transactions_escrow', 'campagnes', 'documents',
  'visites', 'mandats', 'reversements', 'demandes', 'estimations', 'modeles_messages', 'automatisations', 'baux', 'tickets_maintenance', 'lots',
  'quittances', 'etapes_escrow', 'prospects', 'propositions', 'messages', 'biens_files', 'biens_equipements', 'programmes_files', 'programmes_equipements',
  'tickets_maintenance_files', 'prospects_quartiers', 'biens_proprietaires', 'mandats_biens', 'lignes_reversement', 'coordonnees_reversement', 'agences',
])
export const MESSAGE_ETAT = {
  aucune: 'Ce compte n’a pas encore de licence : il est en lecture seule. Contactez l’administrateur de la plateforme.',
  lecture_seule: 'La licence de votre entreprise a expiré : le compte est en lecture seule (consultation et export). Contactez l’administrateur de la plateforme pour la renouveler.',
  suspendue: 'Le compte de votre entreprise est suspendu : il est en lecture seule. Contactez l’administrateur de la plateforme.',
}
// contexte d'entreprise de l'utilisateur, mis en cache 30 s (vidé à chaque changement de licence ou de compte)
const cacheEntreprise = new Map()
export const viderCacheEntreprise = () => cacheEntreprise.clear()
export async function entrepriseDe(db, accountability) {
  if (!accountability?.user || accountability.admin) return null
  const e = cacheEntreprise.get(accountability.user)
  if (e && e.expire > Date.now()) return e.valeur
  const valeur = await db('directus_users as u').join('agences as a', 'a.id', 'u.agence').where('u.id', accountability.user)
    .first('a.id as agence', 'a.type_compte', 'a.etat_licence') ?? null
  cacheEntreprise.set(accountability.user, { valeur, expire: Date.now() + 30000 })
  return valeur
}
/** Licence en écriture et module ouvert pour le type de compte ; renvoie l'entreprise (null hors entreprise). */
export async function controleEntreprise(db, accountability, collection, fail) {
  if (!COLLECTIONS_ENTREPRISE.has(collection)) return null
  const ent = await entrepriseDe(db, accountability)
  if (!ent) return null
  if (!ETATS_ECRITURE.includes(ent.etat_licence)) fail(MESSAGE_ETAT[ent.etat_licence] ?? MESSAGE_ETAT.lecture_seule)
  if ((MODULES_FERMES[ent.type_compte] ?? []).includes(collection)) fail(`Ce module n’est pas disponible pour un compte ${LIBELLE_TYPE[ent.type_compte]}.`)
  return ent
}

const ajouterJours = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/** État de licence d'une agence à une date, à partir de ses licences. */
export async function calculerEtat(db, agence, jour = todayIso()) {
  const licences = (await db('licences').where('agence', agence).select('statut', 'date_debut', 'date_fin', 'offre'))
    .map(l => ({ ...l, date_debut: isoDate(l.date_debut), date_fin: isoDate(l.date_fin) }))
  const enCours = licences.filter(l => l.date_debut <= jour && l.date_fin >= jour)
  if (enCours.some(l => l.statut === 'suspendue')) return { etat: 'suspendue', fin: null, licence: null }
  const valides = enCours.filter(l => ['essai', 'active'].includes(l.statut)).sort((a, b) => b.date_fin.localeCompare(a.date_fin))
  if (valides.length) return { etat: valides[0].statut, fin: valides[0].date_fin, licence: valides[0] }
  const echues = licences.filter(l => ['essai', 'active'].includes(l.statut) && l.date_fin < jour).sort((a, b) => b.date_fin.localeCompare(a.date_fin))
  if (echues.length && ajouterJours(echues[0].date_fin, DELAI_GRACE_JOURS) >= jour) return { etat: 'grace', fin: echues[0].date_fin, licence: echues[0] }
  return { etat: licences.length ? 'lecture_seule' : 'aucune', fin: echues[0]?.date_fin ?? null, licence: null }
}

/** Recalcule et enregistre l'état de licence d'agences ; renvoie celles dont l'état a changé. */
export async function rafraichirEtats(db, agences = null) {
  const ids = agences ?? await db('agences').pluck('id')
  const changes = []
  for (const id of ids) {
    const a = await db('agences').where('id', id).first('etat_licence', 'licence_fin')
    if (!a) continue
    const { etat, fin } = await calculerEtat(db, id)
    if (etat !== a.etat_licence || (fin ?? null) !== (a.licence_fin ? isoDate(a.licence_fin) : null)) {
      await db('agences').where('id', id).update({ etat_licence: etat, licence_fin: fin })
      changes.push({ id, avant: a.etat_licence, apres: etat })
    }
  }
  return changes
}

/** Offre de la licence en cours (ou en délai de grâce) d'une agence : limites d'usage. */
export async function offreCourante(db, agence) {
  const { licence } = await calculerEtat(db, agence)
  return licence ? db('offres').where('id', licence.offre).first('nom', 'max_utilisateurs', 'max_biens', 'max_annonces') : null
}

/** Usage actuel d'une agence (pour les limites et la console). */
export async function usage(db, agence) {
  const compte = async (q) => Number((await q.count({ n: '*' }).first())?.n ?? 0)
  return {
    utilisateurs: await compte(db('directus_users').where({ agence }).whereNot('status', 'suspended')),
    biens: await compte(db('biens').where({ agence }).whereNot('statut', 'archive')),
    annonces: await compte(db('annonces').where({ agence, statut: 'publiee' })),
  }
}

const echapper = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * E-mail aux administrateurs (actifs) d'un compte entreprise ; renvoie le nombre de destinataires. Ne lève jamais.
 * sujet / corps : textes français à parties variables {x} (params), traduits dans la langue de chaque destinataire
 * (profil, sinon pays de l'agence) ; une valeur de params peut être une fonction (langue) => texte.
 * options.type : événement du catalogue des notifications → cloche et canaux choisis par chaque administrateur
 * (options.lien : page de l'application concernée).
 */
export async function emailAdministrateurs(db, agence, sujet, corps, ctx, params = {}, options = {}) {
  const { services, schema, logger } = ctx
  if (options.type) {
    const ids = await destinatairesEntreprise(db, agence, ['Administrateur d’entreprise'])
    return notifier(db, ctx, { type: options.type, utilisateurs: ids, titre: sujet, corps, params, lien: options.lien ?? null, agence, lienDansCorps: corps.includes('{lien}') })
  }
  try {
    const role = (await db('directus_roles').where('name', 'Administrateur d’entreprise').first('id'))?.id
    const admins = await db('directus_users').where({ agence, role, status: 'active' }).select('email', 'language')
    if (!admins.length) return 0
    const parDefaut = await langueAgence(db, agence)
    const groupes = {}
    for (const a of admins) (groupes[a.language ? versLangue(a.language) : parDefaut] ??= []).push(a.email)
    for (const [L, dest] of Object.entries(groupes)) {
      const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'function' ? v(L) : v]))
      const s = tr(L, sujet, p), c = tr(L, corps, p)
      await new services.MailService({ schema, knex: db }).send({
        to: dest, subject: s,
        template: { name: L === 'en' ? 'gimmo-message-en' : 'gimmo-message', data: { sujet: s, corps_html: echapper(c).replace(/\n/g, '<br />'), agence: 'Gocleus Immo', telephone_agence: '', langue: L } },
      })
    }
    return admins.length
  } catch (err) {
    logger?.error(err, `gimmo-acces : e-mail « ${sujet} » non envoyé (compte ${agence})`)
    return 0
  }
}


/** Rappels de licence (J-15, J-7, J-1, délai de grâce, lecture seule) : une seule fois par échéance et par étape. */
export async function envoyerRappels(db, ctx, jour = todayIso()) {
  let n = 0
  for (const a of await db('agences').whereNotNull('licence_fin').select('id', 'nom', 'etat_licence', 'licence_fin', 'rappel_licence')) {
    const fin = isoDate(a.licence_fin)
    const jours = Math.round((Date.parse(`${fin}T00:00:00Z`) - Date.parse(`${jour}T00:00:00Z`)) / 86400000)
    let etape = null, sujet = '', corps = ''
    const params = { nom: a.nom, date: (L) => dateLongue(fin, L), jours, delai: DELAI_GRACE_JOURS, lien: `${String(ctx.env?.GIMMO_SITE_URL ?? '').replace(/\/$/, '')}/administration-gocleus/abonnement` }
    if (['essai', 'active'].includes(a.etat_licence) && [15, 7, 1].includes(jours)) {
      etape = `J${jours}`
      sujet = jours > 1 ? 'Votre licence Gocleus Immo expire dans {jours} jours' : 'Votre licence Gocleus Immo expire dans {jours} jour'
      corps = 'Bonjour,\n\nLa licence de {nom} arrive à échéance le {date}.\nPour continuer à utiliser la plateforme sans interruption, renouvelez votre abonnement en ligne : {lien}'
    } else if (a.etat_licence === 'grace') {
      etape = 'grace'
      sujet = 'Votre licence Gocleus Immo a expiré'
      corps = 'Bonjour,\n\nLa licence de {nom} a expiré le {date}. Vous disposez de {delai} jours pour la renouveler ; passé ce délai, le compte sera en lecture seule et vos annonces seront retirées du site public.\nRenouveler en ligne : {lien}'
    } else if (a.etat_licence === 'lecture_seule') {
      etape = 'lecture_seule'
      sujet = 'Votre compte Gocleus Immo est en lecture seule'
      corps = 'Bonjour,\n\nLe délai de grâce de la licence de {nom} est écoulé : le compte est en lecture seule (consultation et export) et vos annonces ne sont plus en ligne. Vos données sont conservées ; réactivez le compte en choisissant une offre : {lien}'
    }
    const code = etape ? `${fin}:${etape}` : null
    if (!code || code === a.rappel_licence) continue
    if (await emailAdministrateurs(db, a.id, sujet, corps, ctx, params, { type: 'licence.rappel', lien: '/administration-gocleus/abonnement' })) n++
    await db('agences').where('id', a.id).update({ rappel_licence: code })
  }
  return n
}
