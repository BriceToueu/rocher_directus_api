/**
 * G-immo — CRM (Data Studio, API, front).
 *
 * Prospects :
 *  - budget minimum ≤ budget maximum, montants et critères numériques positifs ;
 *  - commercial par défaut : l'utilisateur qui crée le prospect.
 * Messages (journal des échanges) :
 *  - un échange entrant est « reçu » (livré) ; un échange sortant consigné est « envoyé » ; date d'envoi par défaut ;
 *  - le contact est repris du prospect si absent.
 * Demandes du site public :
 *  - agence reprise de l'annonce visée ; un visiteur anonyme ne peut viser qu'une annonce publiée ;
 *  - prise en charge : assignée par défaut à l'utilisateur ; une demande traitée ou rejetée ne se rouvre pas.
 */
import { createError } from '@directus/errors'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

export default ({ filter }) => {
  // événements génériques : vus avant les contrôles génériques de gimmo-rules (voir gimmo-gestion)
  const pour = (collection, action, handler) => filter(`items.${action}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)

  function controlerProspect(row) {
    for (const k of ['budget_min', 'budget_max', 'nb_chambres_min', 'surface_min']) {
      if (row[k] !== null && row[k] !== undefined && row[k] !== '' && Number(row[k]) < 0) fail('Les montants et critères chiffrés doivent être positifs.')
    }
    if (row.budget_min != null && row.budget_max != null && row.budget_min !== '' && row.budget_max !== '' && Number(row.budget_min) > Number(row.budget_max)) {
      fail('Le budget minimum ne peut pas dépasser le budget maximum.')
    }
  }
  pour('prospects', 'create', (payload, _meta, { accountability }) => {
    controlerProspect(payload)
    if (payload.commercial === undefined && accountability?.user) payload.commercial = accountability.user
    return payload
  })
  pour('prospects', 'update', async (payload, meta, { database }) => {
    for (const id of meta.keys) controlerProspect({ ...(await database('prospects').where('id', id).first()), ...payload })
    return payload
  })

  pour('messages', 'create', async (payload, _meta, { database }) => {
    if (!payload.contact && typeof payload.prospect === 'string') payload.contact = (await database('prospects').where('id', payload.prospect).first('contact'))?.contact
    if (!payload.statut || payload.statut === 'brouillon') {
      if (payload.direction === 'entrant') payload.statut = 'livre'
      else if (payload.date_planifiee && new Date(payload.date_planifiee) > new Date()) payload.statut = 'planifie'
      else if (payload.statut !== 'brouillon') payload.statut = 'envoye'
    }
    if (['envoye', 'livre', 'lu'].includes(payload.statut)) payload.date_envoi ??= new Date().toISOString()
    return payload
  })

  // demande envoyée depuis le site public : agence reprise de l'annonce ; un visiteur anonyme ne peut viser qu'une annonce en ligne
  pour('demandes', 'create', async (payload, _meta, { database, accountability }) => {
    if (typeof payload.annonce === 'string') {
      const a = await database('annonces').where('id', payload.annonce).first('agence', 'statut')
      if (!a || (!accountability?.user && a.statut !== 'publiee')) fail('Cette annonce n’est plus disponible.')
      // visiteur anonyme : l'agence est TOUJOURS celle de l'annonce (une valeur envoyée est ignorée)
      if (!accountability?.user) payload.agence = a.agence
      else payload.agence ??= a.agence
    }
    // demande de réservation d'un lot : programme et agence repris du lot ; un visiteur ne vise qu'un lot disponible d'un programme publié
    if (typeof payload.lot === 'string') {
      const l = await database('lots as l').join('programmes as p', 'p.id', 'l.programme').where('l.id', payload.lot).first('l.statut', 'l.programme', 'p.agence', 'p.statut_publication')
      if (!l || (!accountability?.user && (l.statut_publication !== 'publie' || l.statut !== 'disponible'))) fail('Ce lot n’est plus disponible à la réservation.')
      payload.programme = l.programme
      if (!accountability?.user) payload.agence = l.agence
      else payload.agence ??= l.agence
    }
    return payload
  })

  pour('demandes', 'update', async (payload, meta, { database, accountability }) => {
    for (const id of meta.keys) {
      const d = await database('demandes').where('id', id).first('statut', 'assignee_a')
      if (!d) continue
      if (['traitee', 'rejetee'].includes(d.statut) && payload.statut && payload.statut !== d.statut) fail('Cette demande est close : elle ne peut plus changer de statut.')
      if (payload.statut === 'en_cours' && !d.assignee_a && payload.assignee_a === undefined && accountability?.user) payload.assignee_a = accountability.user
    }
    return payload
  })
}
