/**
 * G-immo — cycle de vie des mandats et des relevés de gérance (Data Studio, API, front).
 *
 * Mandats :
 *  - numéro MAN-AAAA-NNNN si absent ; devise du pays de l'agence par défaut ;
 *  - date de fin calculée à partir de la durée ; fin ≥ début ;
 *  - transitions de statut contrôlées (un mandat clos ne se rouvre pas) ;
 *  - activation d'un brouillon : au moins un bien couvert ; date de signature posée si absente.
 * Relevés de gérance (reversements) :
 *  - brouillon → validé → payé ; brouillon / validé → annulé ; validé → brouillon (correction) ;
 *  - un relevé validé, payé ou annulé n'est plus modifiable (montants, lignes, période, bénéficiaire) ;
 *  - validation : date et auteur enregistrés ; paiement : coordonnées du propriétaire bénéficiaire, moyen et date par défaut ;
 *  - suppression : brouillon ou annulé uniquement (sauf administrateur de la plateforme).
 */
import { createError } from '@directus/errors'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

const pad = (n) => String(n).padStart(2, '0')
const isoDate = (v) => !v ? null : v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10)
const todayIso = () => isoDate(new Date())
function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + months, 1))
  t.setUTCDate(Math.min(d, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()))
  return t.toISOString().slice(0, 10)
}

const MANDAT_TRANSITIONS = {
  brouillon: ['actif', 'resilie'],
  actif: ['suspendu', 'resilie', 'termine', 'expire'],
  suspendu: ['actif', 'resilie', 'termine'],
  resilie: [], termine: [], expire: [],
}
const MANDAT_LIBELLES = { brouillon: 'brouillon', actif: 'actif', suspendu: 'suspendu', resilie: 'résilié', termine: 'terminé', expire: 'expiré' }

const RELEVE_TRANSITIONS = { brouillon: ['valide', 'annule'], valide: ['paye', 'brouillon', 'annule'], paye: [], annule: [] }
const RELEVE_LIBELLES = { brouillon: 'brouillon', valide: 'validé', paye: 'payé', annule: 'annulé' }
// champs encore modifiables sur un relevé qui n'est plus en brouillon (circuit de validation / paiement)
const RELEVE_CHAMPS_CIRCUIT = new Set(['statut', 'date_validation', 'valide_par', 'coordonnees', 'moyen_paiement', 'date_paiement', 'reference_paiement', 'releve_pdf'])

export default ({ filter }) => {
  // Événements génériques items.* : ils passent avant les événements propres à une collection, et cette extension
  // est chargée avant gimmo-rules (ordre alphabétique) : les valeurs par défaut posées ici sont donc vues par ses contrôles.
  const pour = (collection, action, handler) => filter(`items.${action}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)

  // ── Mandats ──────────────────────────────────────────────────────────────────
  async function preparerMandat(payload, existing, db, accountability) {
    const row = { ...(existing ?? {}), ...payload }
    if (row.date_debut && row.duree_mois && ('duree_mois' in payload || 'date_debut' in payload) && !('date_fin' in payload)) {
      payload.date_fin = addMonths(isoDate(row.date_debut), Number(row.duree_mois))
      row.date_fin = payload.date_fin
    }
    if (row.date_debut && row.date_fin && isoDate(row.date_fin) < isoDate(row.date_debut)) fail('La date de fin du mandat doit être postérieure à sa date de début.')
    if (!row.devise) {
      const agence = row.agence ?? (accountability?.user ? (await db('directus_users').where('id', accountability.user).first('agence'))?.agence : null)
      const d = agence ? await db('agences as a').join('pays as p', 'p.id', 'a.pays').where('a.id', agence).first('p.devise') : null
      if (d?.devise) payload.devise = d.devise
    }
    if (existing && 'statut' in payload && payload.statut !== existing.statut) {
      if (!(MANDAT_TRANSITIONS[existing.statut] ?? []).includes(payload.statut)) {
        fail(`Un mandat ${MANDAT_LIBELLES[existing.statut]} ne peut pas passer à « ${MANDAT_LIBELLES[payload.statut] ?? payload.statut} ».`)
      }
    }
    if (payload.statut === 'actif' && existing?.statut === 'brouillon') {
      const biens = await db('mandats_biens').where('mandats_id', existing.id).whereNull('date_sortie').first('id')
      if (!biens) fail('Ajoutez au moins un bien couvert avant d’activer le mandat.')
    }
    if (payload.statut === 'actif' && !row.date_signature) payload.date_signature = todayIso()
    return payload
  }

  pour('mandats', 'create', async (payload, _meta, { database, accountability }) => {
    if (!payload.numero) {
      const annee = new Date().getFullYear()
      const last = await database('mandats').where('numero', 'like', `MAN-${annee}-%`).orderBy('numero', 'desc').first('numero')
      payload.numero = `MAN-${annee}-${String(last ? Number(last.numero.split('-')[2]) + 1 : 1).padStart(4, '0')}`
    }
    return preparerMandat(payload, null, database, accountability)
  })
  pour('mandats', 'update', async (payload, meta, { database, accountability }) => {
    for (const id of meta.keys) await preparerMandat(payload, await database('mandats').where('id', id).first(), database, accountability)
    return payload
  })

  // ── Relevés de gérance ───────────────────────────────────────────────────────
  pour('reversements', 'update', async (payload, meta, { database, accountability }) => {
    for (const id of meta.keys) {
      const r = await database('reversements').where('id', id).first()
      if (!r) continue
      const nouveau = payload.statut ?? r.statut
      if (nouveau !== r.statut && !(RELEVE_TRANSITIONS[r.statut] ?? []).includes(nouveau)) {
        fail(`Un relevé ${RELEVE_LIBELLES[r.statut]} ne peut pas passer à « ${RELEVE_LIBELLES[nouveau] ?? nouveau} ».`)
      }
      if (r.statut !== 'brouillon') {
        const interdits = Object.keys(payload).filter(k => !RELEVE_CHAMPS_CIRCUIT.has(k))
        if (interdits.length) fail(`Un relevé ${RELEVE_LIBELLES[r.statut]} n’est plus modifiable. Repassez-le en brouillon pour le corriger.`)
      }
      if (r.statut === 'paye' || r.statut === 'annule') fail(`Un relevé ${RELEVE_LIBELLES[r.statut]} n’est plus modifiable.`)

      if (nouveau === 'valide' && r.statut !== 'valide') {
        payload.date_validation ??= new Date().toISOString()
        payload.valide_par ??= accountability?.user ?? null
      }
      if (nouveau === 'brouillon' && r.statut === 'valide') Object.assign(payload, { date_validation: null, valide_par: null })
      if (nouveau === 'paye') {
        const coordId = payload.coordonnees ?? r.coordonnees
        const coord = coordId ? await database('coordonnees_reversement').where('id', coordId).first('contact', 'type', 'moyen_paiement') : null
        if (coord && coord.contact !== r.beneficiaire) fail('Les coordonnées choisies n’appartiennent pas au propriétaire bénéficiaire du relevé.')
        if (coord && !payload.moyen_paiement && !r.moyen_paiement) {
          payload.moyen_paiement = coord.type === 'virement'
            ? (await database('moyens_paiement').where('code', 'virement').first('id'))?.id ?? null
            : coord.moyen_paiement
        }
        payload.date_paiement ??= r.date_paiement ?? new Date().toISOString()
      }
    }
    return payload
  })

  pour('reversements', 'delete', async (keys, _meta, { database, accountability }) => {
    if (accountability?.admin === true) return keys // administrateur de la plateforme : purge possible
    const bloques = await database('reversements').whereIn('id', keys).whereNotIn('statut', ['brouillon', 'annule']).pluck('numero')
    if (bloques.length) fail(`Le relevé ${bloques[0]} est validé ou payé : annulez-le plutôt que de le supprimer.`)
    return keys
  })

  // lignes : modifiables uniquement tant que le relevé est en brouillon
  const relevesNonModifiables = async (db, reversementIds) => db('reversements').whereIn('id', reversementIds.filter(Boolean)).whereNot('statut', 'brouillon').pluck('numero')
  pour('lignes_reversement', 'create', async (payload, _meta, { database }) => {
    if (typeof payload.reversement === 'string') {
      const bloques = await relevesNonModifiables(database, [payload.reversement])
      if (bloques.length) fail(`Le relevé ${bloques[0]} n’est plus en brouillon : ses lignes ne sont plus modifiables.`)
    }
    return payload
  })
  const lignesParCles = async (db, keys) => db('lignes_reversement').whereIn('id', keys).pluck('reversement')
  pour('lignes_reversement', 'update', async (payload, meta, { database }) => {
    const bloques = await relevesNonModifiables(database, [...await lignesParCles(database, meta.keys), payload.reversement])
    if (bloques.length) fail(`Le relevé ${bloques[0]} n’est plus en brouillon : ses lignes ne sont plus modifiables.`)
    return payload
  })
  pour('lignes_reversement', 'delete', async (keys, _meta, { database }) => {
    const bloques = await relevesNonModifiables(database, await lignesParCles(database, keys))
    if (bloques.length) fail(`Le relevé ${bloques[0]} n’est plus en brouillon : ses lignes ne sont plus modifiables.`)
    return keys
  })
}
