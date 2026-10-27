/**
 * G-immo — interventions de maintenance (Data Studio, API, front).
 *
 *  - référence INT-AAAA-NNNNN, date de signalement et avancement par défaut ;
 *  - statuts : signalé (en_attente) → planifié → en cours → résolu ; annulation tant que non résolu ;
 *    une intervention résolue peut être rouverte, une intervention annulée ne se reprend pas ;
 *  - planifiée : date prévue obligatoire ; résolue : coût obligatoire (0 accepté), date de résolution et avancement 100 % ;
 *  - prestataire actif uniquement ; note de satisfaction (1 à 5) seulement une fois résolue ;
 *  - coût imputé au propriétaire déjà repris sur un relevé de gérance non annulé : coût, imputation et statut verrouillés.
 */
import { createError } from '@directus/errors'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

const TRANSITIONS = {
  en_attente: ['planifie', 'en_cours', 'resolu', 'annule'],
  planifie: ['en_attente', 'en_cours', 'resolu', 'annule'],
  en_cours: ['planifie', 'resolu', 'annule'],
  resolu: ['en_cours'],
  annule: [],
}
const LIBELLES = { en_attente: 'signalée', planifie: 'planifiée', en_cours: 'en cours', resolu: 'résolue', annule: 'annulée' }
const CHAMPS_IMPUTES = ['cout', 'imputation', 'statut', 'bien']

export default ({ filter }) => {
  // événements génériques : vus avant les contrôles génériques de gimmo-rules (voir gimmo-gestion)
  const pour = (collection, action, handler) => filter(`items.${action}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)

  async function controler(db, payload, existing) {
    const row = { ...(existing ?? {}), ...payload }
    if (existing && 'statut' in payload && payload.statut !== existing.statut && !(TRANSITIONS[existing.statut] ?? []).includes(payload.statut)) {
      fail(`Une intervention ${LIBELLES[existing.statut]} ne peut pas passer à « ${LIBELLES[payload.statut] ?? payload.statut} ».`)
    }
    if (row.statut === 'planifie' && !row.date_planifiee) fail('Indiquez la date prévue de l’intervention.')
    if (row.statut === 'resolu') {
      if (row.cout === null || row.cout === undefined || row.cout === '') fail('Indiquez le coût de l’intervention (0 si aucun frais).')
      if (Number(row.cout) < 0) fail('Le coût ne peut pas être négatif.')
      if (!row.date_resolution) payload.date_resolution = new Date().toISOString()
      if (Number(row.progression) !== 100) payload.progression = 100
    } else if (existing?.statut === 'resolu' && payload.statut) {
      // réouverture
      payload.date_resolution = null
      payload.note_satisfaction = null
      if (!('progression' in payload)) payload.progression = 80
    }
    if (row.progression !== undefined && (Number(row.progression) < 0 || Number(row.progression) > 100)) fail('L’avancement doit être compris entre 0 et 100 %.')
    if (payload.note_satisfaction !== undefined && payload.note_satisfaction !== null) {
      if ((payload.statut ?? existing?.statut) !== 'resolu') fail('La satisfaction se note une fois l’intervention résolue.')
      if (![1, 2, 3, 4, 5].includes(Number(payload.note_satisfaction))) fail('La note de satisfaction va de 1 à 5.')
    }
    if (payload.prestataire && payload.prestataire !== existing?.prestataire) {
      const p = await db('prestataires').where('id', payload.prestataire).first('nom', 'actif')
      if (p && !p.actif) fail(`Le prestataire ${p.nom} est inactif.`)
    }
    if (existing && CHAMPS_IMPUTES.some(k => k in payload && String(payload[k] ?? '') !== String(existing[k] ?? ''))) {
      const releve = await db('lignes_reversement as l').join('reversements as r', 'r.id', 'l.reversement')
        .where('l.ticket', existing.id).whereNot('r.statut', 'annule').first('r.numero')
      if (releve) fail(`Le coût de cette intervention figure sur le relevé de gérance ${releve.numero} : annulez d’abord ce relevé pour la modifier.`)
    }
    return payload
  }

  pour('tickets_maintenance', 'create', async (payload, _meta, { database }) => {
    if (!payload.reference) {
      const annee = new Date().getFullYear()
      const last = await database('tickets_maintenance').where('reference', 'like', `INT-${annee}-%`).orderBy('reference', 'desc').first('reference')
      payload.reference = `INT-${annee}-${String(last ? Number(last.reference.split('-')[2]) + 1 : 1).padStart(5, '0')}`
    }
    payload.date_signalement ??= new Date().toISOString()
    payload.statut ??= 'en_attente'
    payload.progression ??= 0
    return controler(database, payload, null)
  })

  pour('tickets_maintenance', 'update', async (payload, meta, { database }) => {
    for (const id of meta.keys) await controler(database, payload, await database('tickets_maintenance').where('id', id).first())
    return payload
  })

  pour('tickets_maintenance', 'delete', async (keys, _meta, { database, accountability }) => {
    if (accountability?.admin === true) return keys
    const imputes = await database('lignes_reversement as l').join('reversements as r', 'r.id', 'l.reversement')
      .whereIn('l.ticket', keys).whereNot('r.statut', 'annule').first('l.id')
    if (imputes) fail('Cette intervention figure sur un relevé de gérance : annulez-la plutôt que de la supprimer.')
    const avancees = await database('tickets_maintenance').whereIn('id', keys).whereIn('statut', ['en_cours', 'resolu']).first('reference')
    if (avancees) fail(`L’intervention ${avancees.reference} est en cours ou résolue : annulez-la plutôt que de la supprimer.`)
    return keys
  })
}
