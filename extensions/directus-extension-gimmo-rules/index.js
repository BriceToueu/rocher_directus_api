/**
 * G-immo — règles métier appliquées par Directus avant chaque écriture (Data Studio, API, front).
 *
 * 1. Cohérence d'agence (générique) : un élément ne peut référencer que des éléments de sa propre agence.
 * 2. Copropriété : Σ quotes-parts actives ≤ 100 % et un seul mandant actif par bien.
 * 3. Mandats : champs obligatoires selon le type, un seul mandat de gestion actif par bien,
 *    le mandant doit être propriétaire mandant de chaque bien couvert.
 * 4. Paiements : moyen disponible dans le pays de l'agence, numéro obligatoire pour le Mobile Money.
 * 5. Coordonnées de reversement : toute modification sensible repasse « à vérifier » ; une seule par défaut.
 * 6. Reversements : passage à « payé » seulement avec des coordonnées vérifiées, une date et une référence.
 */
import { createError } from '@directus/errors'
import { controleEntreprise } from '../../lib/gimmo/saas.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

// Collections portant directement le champ `agence`
const DIRECT = new Set([
  'contacts', 'biens', 'programmes', 'prestataires', 'annonces', 'ventes', 'echeances', 'paiements',
  'transactions_escrow', 'ecritures_comptables', 'campagnes', 'documents', 'visites', 'mandats', 'reversements',
  'demandes', 'estimations', 'modeles_messages', 'automatisations',
])
// Collections dont l'agence est héritée d'un parent obligatoire (champ vers le parent)
const VIA = {
  baux: 'bien', tickets_maintenance: 'bien', lots: 'programme', quittances: 'bail', etapes_escrow: 'transaction',
  prospects: 'contact', propositions: 'prospect', messages: 'contact', biens_files: 'biens_id', biens_equipements: 'biens_id',
  programmes_files: 'programmes_id', programmes_equipements: 'programmes_id', tickets_maintenance_files: 'tickets_maintenance_id',
  prospects_quartiers: 'prospects_id', biens_proprietaires: 'biens_id', mandats_biens: 'mandats_id',
  lignes_reversement: 'reversement', coordonnees_reversement: 'contact',
}
const isTenant = (c) => DIRECT.has(c) || c in VIA
const isScalarId = (v) => typeof v === 'string' || typeof v === 'number'
const MOBILE_MONEY = 'mobile_money'

/** Collection cible d'un champ M2O, d'après le schéma Directus. */
const relatedOf = (schema, collection, field) =>
  schema.relations.find(r => r.collection === collection && r.field === field)?.related_collection ?? null

/** Agence d'un élément (directe ou héritée), null si aucune, undefined si la collection n'est pas rattachée à une agence. */
async function agenceOf(db, schema, collection, id, depth = 0) {
  if (!isScalarId(id) || depth > 6) return null
  if (DIRECT.has(collection)) return (await db(collection).select('agence').where('id', id).first())?.agence ?? null
  const via = VIA[collection]
  if (!via) return undefined
  const parent = (await db(collection).select(via).where('id', id).first())?.[via]
  return agenceOf(db, schema, relatedOf(schema, collection, via), parent, depth + 1)
}

/** Agence de l'élément en cours d'écriture (valeurs fusionnées). */
async function ownAgence(db, schema, collection, row) {
  if (DIRECT.has(collection)) return row.agence ?? null
  const via = VIA[collection]
  return agenceOf(db, schema, relatedOf(schema, collection, via), row[via])
}

/** Lignes après écriture : création = payload ; modification = existant fusionné avec le payload, pour chaque clé. */
async function mergedRows(db, collection, payload, keys) {
  if (!keys) return [payload]
  const existing = await db(collection).select('*').whereIn('id', keys)
  return existing.map(row => ({ ...row, ...payload }))
}

// ── 1. Cohérence d'agence ──────────────────────────────────────────────────────
async function checkAgencyConsistency(db, schema, collection, row) {
  const own = await ownAgence(db, schema, collection, row)
  if (!own) return // élément global (modèle de plateforme…) ou agence pas encore définie
  for (const rel of schema.relations) {
    if (rel.collection !== collection || !isTenant(rel.related_collection)) continue
    if (rel.field === VIA[collection]) continue // le parent définit justement l'agence
    const value = row[rel.field]
    if (!isScalarId(value)) continue
    const other = await agenceOf(db, schema, rel.related_collection, value)
    if (other && other !== own) {
      fail(`Le champ « ${rel.field} » fait référence à un élément d’une autre agence. Les données de deux agences ne peuvent pas être liées.`)
    }
  }
}

// ── 2. Copropriété ─────────────────────────────────────────────────────────────
async function checkOwnership(db, row) {
  if (row.date_fin) return
  const others = await db('biens_proprietaires').select('quote_part', 'est_mandant')
    .where('biens_id', row.biens_id).whereNull('date_fin').modify(q => { if (row.id) q.whereNot('id', row.id) })
  const total = others.reduce((s, o) => s + Number(o.quote_part), 0) + Number(row.quote_part ?? 0)
  if (total > 100.0001) fail(`La somme des quotes-parts de ce bien dépasserait 100 % (${total.toFixed(2)} %).`)
  if (row.est_mandant && others.some(o => o.est_mandant)) fail('Ce bien a déjà un propriétaire mandant actif : un seul mandant est possible.')
}

// ── 3. Mandats ─────────────────────────────────────────────────────────────────
const REQUIRED_BY_TYPE = {
  gestion_locative: [['taux_honoraires', 'le taux d’honoraires de gestion']],
  mise_en_location: [['commission_mise_en_location', 'la commission de mise en location']],
  vente: [['prix_vente_mandat', 'le prix de vente'], ['taux_commission_vente', 'le taux de commission de vente']],
}
async function activeGestionMandatesFor(db, bienId, exceptMandat) {
  return db('mandats_biens as mb').join('mandats as m', 'm.id', 'mb.mandats_id')
    .where('mb.biens_id', bienId).whereNull('mb.date_sortie')
    .andWhere('m.type', 'gestion_locative').andWhere('m.statut', 'actif')
    .modify(q => { if (exceptMandat) q.whereNot('m.id', exceptMandat) })
    .select('m.numero')
}
async function checkMandat(db, row) {
  for (const [field, label] of REQUIRED_BY_TYPE[row.type] ?? []) {
    if (row[field] === null || row[field] === undefined || row[field] === '') fail(`Pour un mandat de ce type, ${label} est obligatoire.`)
  }
  if (row.id && row.type === 'gestion_locative' && row.statut === 'actif') {
    const biens = await db('mandats_biens').where('mandats_id', row.id).whereNull('date_sortie').pluck('biens_id')
    for (const bienId of biens) {
      const conflicts = await activeGestionMandatesFor(db, bienId, row.id)
      if (conflicts.length) fail(`Un bien de ce mandat est déjà couvert par le mandat de gestion actif ${conflicts[0].numero}.`)
    }
  }
}
async function checkMandatBien(db, row) {
  const mandat = await db('mandats').select('id', 'mandant', 'type', 'statut').where('id', row.mandats_id).first()
  if (!mandat) return
  const isOwner = await db('biens_proprietaires').where({ biens_id: row.biens_id, contacts_id: mandat.mandant, est_mandant: true }).whereNull('date_fin').first()
  if (!isOwner) fail('Le mandant de ce mandat n’est pas le propriétaire mandant de ce bien.')
  if (!row.date_sortie && mandat.type === 'gestion_locative' && mandat.statut === 'actif') {
    const conflicts = await activeGestionMandatesFor(db, row.biens_id, mandat.id)
    if (conflicts.length) fail(`Ce bien est déjà couvert par le mandat de gestion actif ${conflicts[0].numero}.`)
  }
}

// ── 4. Paiements ───────────────────────────────────────────────────────────────
async function checkPaiement(db, row) {
  if (!row.moyen_paiement) return
  const moyen = await db('moyens_paiement').select('id', 'nom', 'type').where('id', row.moyen_paiement).first()
  if (!moyen) return
  if (moyen.type === MOBILE_MONEY && !row.telephone_payeur) fail(`Le numéro ${moyen.nom} du payeur est obligatoire.`)
  if (row.agence) {
    const agence = await db('agences').select('pays').where('id', row.agence).first()
    const dispo = agence && await db('pays_moyens_paiement').where({ pays_id: agence.pays, moyens_paiement_id: moyen.id, actif: true }).first()
    if (!dispo) fail(`${moyen.nom} n’est pas disponible dans le pays de cette agence.`)
  }
}

// ── 5. Coordonnées de reversement ──────────────────────────────────────────────
const SENSITIVE = ['type', 'moyen_paiement', 'titulaire', 'banque', 'iban_rib', 'numero_mobile']
async function checkCoordonnees(db, row) {
  if (row.type === 'virement' && !row.iban_rib) fail('L’IBAN / RIB est obligatoire pour un virement.')
  if (row.type === MOBILE_MONEY) {
    if (!row.numero_mobile) fail('Le numéro Mobile Money est obligatoire.')
    const moyen = row.moyen_paiement ? await db('moyens_paiement').select('type').where('id', row.moyen_paiement).first() : null
    if (!moyen || moyen.type !== MOBILE_MONEY) fail('Choisissez l’opérateur Mobile Money.')
  }
}

// ── 6. Reversements ────────────────────────────────────────────────────────────
async function checkReversement(db, row) {
  if (row.statut !== 'paye') return
  const coord = row.coordonnees ? await db('coordonnees_reversement').select('statut_verification').where('id', row.coordonnees).first() : null
  if (!coord || coord.statut_verification !== 'verifie') fail('Un reversement ne peut être payé que sur des coordonnées vérifiées.')
  if (!row.date_paiement || !row.reference_paiement) fail('La date et la référence du paiement sont obligatoires pour un reversement payé.')
}

const SPECIFIC = {
  biens_proprietaires: checkOwnership,
  mandats: checkMandat,
  mandats_biens: checkMandatBien,
  paiements: checkPaiement,
  coordonnees_reversement: checkCoordonnees,
  reversements: checkReversement,
}

export default ({ filter, action }) => {
  const validate = async (collection, payload, keys, { database, schema, accountability }) => {
    if (!isTenant(collection) || !payload || typeof payload !== 'object') return
    for (const row of await mergedRows(database, collection, payload, keys)) {
      // Le filtre s'exécute AVANT les valeurs préremplies des permissions : si l'agence n'est pas fournie,
      // on prend celle de l'utilisateur, exactement ce que la permission « agence = $CURRENT_USER.agence » appliquera.
      if (DIRECT.has(collection) && !row.agence && accountability?.user) {
        row.agence = (await database('directus_users').select('agence').where('id', accountability.user).first())?.agence ?? null
      }
      await checkAgencyConsistency(database, schema, collection, row)
      if (SPECIFIC[collection]) await SPECIFIC[collection](database, row)
    }
  }

  filter('items.create', async (payload, meta, context) => {
    // licence et modules d'abord (l'ordre des hooks entre extensions n'est pas garanti)
    await controleEntreprise(context.database, context.accountability, meta.collection, fail)
    await validate(meta.collection, payload, null, context)
    return payload
  })

  filter('items.update', async (payload, meta, context) => {
    await controleEntreprise(context.database, context.accountability, meta.collection, fail)
    // anti-fraude : une coordonnée de reversement modifiée doit être revérifiée
    if (meta.collection === 'coordonnees_reversement' && SENSITIVE.some(f => f in payload) && !('statut_verification' in payload)) {
      payload = { ...payload, statut_verification: 'en_attente', verifie_par: null, date_verification: null }
    }
    await validate(meta.collection, payload, meta.keys, context)
    return payload
  })

  // une seule coordonnée de reversement par défaut par propriétaire
  const keepSingleDefault = async (meta, { database }) => {
    const ids = meta.keys ?? (meta.key ? [meta.key] : [])
    if (!meta.payload?.par_defaut || !ids.length) return
    const rows = await database('coordonnees_reversement').select('id', 'contact').whereIn('id', ids)
    for (const r of rows) {
      await database('coordonnees_reversement').where('contact', r.contact).whereNot('id', r.id).update({ par_defaut: false })
    }
  }
  action('coordonnees_reversement.items.create', keepSingleDefault)
  action('coordonnees_reversement.items.update', keepSingleDefault)
}
