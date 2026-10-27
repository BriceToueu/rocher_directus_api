/**
 * G-immo — encaissement des loyers (Data Studio, API, front).
 *
 * Avant écriture d'un paiement (filtre) :
 *  - paiement rattaché à une échéance (loyer) : échéance non annulée ; devise, agence et payeur (locataire) repris de l'échéance ;
 *    les autres paiements (vente, séquestre…) ne sont pas concernés par ces contrôles ;
 *  - montant entier strictement positif, jamais supérieur au reste dû de l'échéance ;
 *  - référence PAY-AAAAMMJJ-XXXXXX et date de paiement par défaut pour un paiement confirmé.
 * Après écriture (action) :
 *  - statut de l'échéance recalculé (à venir, à payer, en retard, partiel, payée) ;
 *  - échéance soldée → quittance émise avec son PDF ; paiement annulé → quittance annulée.
 * Chaque nuit : échéances dépassées non réglées passées « en retard ».
 *
 * L'endpoint POST /gimmo/paiements applique les mêmes effets avant de répondre (le hook reste le filet de sécurité).
 */
import { createError } from '@directus/errors'
import { randomBytes } from 'node:crypto'
import { appliquerEcheance, assurerPdfQuittance, totalConfirme, todayIso } from '../../lib/gimmo/loyers.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

const pad = (n) => String(n).padStart(2, '0')
function reference() {
  const d = new Date()
  const suffix = [...randomBytes(6)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('')
  return `PAY-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${suffix}`
}
async function montantLisible(db, v, deviseId) {
  const d = await db('devises').where('id', deviseId).first('symbole', 'decimales')
  const dec = Number(d?.decimales ?? 0)
  return `${(Number(v) / 10 ** dec).toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec })} ${d?.symbole ?? ''}`.trim()
}

export default ({ filter, action, schedule }, { services, database: db0, logger }) => {
  const { ItemsService, FilesService } = services

  async function controler(db, row, id = null) {
    const e = await db('echeances').where('id', row.echeance).first()
    if (!e) fail('Échéance introuvable.')
    if (e.statut === 'annulee') fail('Cette échéance est annulée : elle ne peut plus être réglée.')
    if (row.devise && Number(row.devise) !== Number(e.devise)) fail('La devise du paiement doit être celle de l’échéance.')
    const m = Number(row.montant)
    if (!Number.isInteger(m) || m <= 0) fail('Le montant du paiement doit être positif.')
    if (row.statut === 'confirme') {
      const reste = Number(e.montant_du) - await totalConfirme(db, e.id, id)
      if (reste <= 0) fail('Cette échéance est déjà entièrement réglée.')
      if (m > reste) fail(`Le montant dépasse le reste dû sur cette échéance (${await montantLisible(db, reste, e.devise)}).`)
    }
    return e
  }

  filter('paiements.items.create', async (payload, _meta, { database }) => {
    if (!payload.echeance) return payload // paiement hors loyer (vente, séquestre…)
    const e = await controler(database, payload)
    payload.devise ??= e.devise
    payload.agence ??= e.agence
    if (!payload.payeur && e.bail) payload.payeur = (await database('baux').where('id', e.bail).first('locataire'))?.locataire ?? null
    payload.reference ??= reference()
    if (payload.statut === 'confirme' && !payload.date_paiement) payload.date_paiement = new Date().toISOString()
    return payload
  })

  filter('paiements.items.update', async (payload, meta, { database }) => {
    const touche = ['echeance', 'montant', 'statut', 'devise'].some(k => k in payload)
    if (!touche) return payload
    for (const id of meta.keys) {
      const existing = await database('paiements').where('id', id).first()
      if (!existing?.echeance && !payload.echeance) continue
      await controler(database, { ...existing, ...payload }, id)
      if (payload.statut === 'confirme' && !existing.date_paiement && !payload.date_paiement) payload.date_paiement = new Date().toISOString()
    }
    return payload
  })

  // échéances concernées par une suppression, mémorisées avant qu'elle n'ait lieu
  const avantSuppression = new Map()
  filter('paiements.items.delete', async (keys, _meta, { database }) => {
    const rows = await database('paiements').whereIn('id', keys).select('id', 'echeance')
    for (const r of rows) avantSuppression.set(r.id, r.echeance)
    return keys
  })

  async function appliquer(echeanceIds, { database, schema }) {
    for (const id of new Set(echeanceIds.filter(Boolean))) {
      try {
        const r = await appliquerEcheance(database, id, { ItemsService, schema })
        if (r?.quittance) await assurerPdfQuittance(database, r.quittance.id, { FilesService, schema })
      } catch (err) {
        logger.error(err, `gimmo-loyers : échéance ${id} non mise à jour`)
      }
    }
  }
  action('paiements.items.create', async (meta, ctx) => appliquer([meta.payload.echeance], ctx))
  action('paiements.items.update', async (meta, ctx) => {
    const rows = await ctx.database('paiements').whereIn('id', meta.keys).select('echeance')
    await appliquer([...rows.map(r => r.echeance), meta.payload.echeance], ctx)
  })
  action('paiements.items.delete', async (meta, ctx) => {
    const ids = meta.keys.map(k => avantSuppression.get(k))
    meta.keys.forEach(k => avantSuppression.delete(k))
    await appliquer(ids, ctx)
  })

  // Chaque nuit à 1 h : échéances échues non réglées → « en retard » ; échéances du jour → « à payer »
  schedule('0 1 * * *', async () => {
    const today = todayIso()
    const retard = await db0('echeances').whereIn('statut', ['a_venir', 'en_attente']).where('date_echeance', '<', today).update({ statut: 'en_retard' })
    const dues = await db0('echeances').where('statut', 'a_venir').where('date_echeance', '=', today).update({ statut: 'en_attente' })
    logger.info(`gimmo-loyers : ${retard} échéance(s) passée(s) en retard, ${dues} à payer aujourd’hui`)
  })
}
