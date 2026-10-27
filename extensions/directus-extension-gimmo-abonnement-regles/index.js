/**
 * G-immo — abonnements (Data Studio, API). Voir lib/gimmo/abonnement.js.
 *
 * 1. Paiement de licence enregistré par la plateforme (paiements_licences) : facture émise automatiquement (PDF, e-mail).
 * 2. Factures : jamais modifiées après émission (seuls le statut « annulée » et son motif peuvent changer) ;
 *    suppression possible seulement pour une facture annulée.
 * 3. Paiements en ligne : écrits uniquement par le serveur (aucune écriture par l'API).
 * 4. Toutes les 15 minutes : paiements en attente relus chez le fournisseur (notification perdue) ; au-delà de 48 h, expirés.
 */
import { createError } from '@directus/errors'
import { actualiserTransaction, facturerPaiementManuel } from '../../lib/gimmo/abonnement.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }
const MODIFIABLES = ['statut', 'motif_annulation', 'fichier_pdf', 'date_updated', 'user_updated']

export default ({ filter, action, schedule }, { database: db, services, getSchema, env, logger }) => {
  const ctx = async () => ({ services, schema: await getSchema(), logger, env })

  action('paiements_licences.items.create', async ({ key }) => {
    try { await facturerPaiementManuel(db, key, await ctx()) } catch (e) { logger.error(e, 'gimmo-abonnement : facture du paiement enregistré non émise') }
  })

  filter('factures.items.create', (payload, _meta, { accountability }) => {
    if (accountability) fail('Les factures sont émises automatiquement à chaque paiement : elles ne se créent pas à la main.')
    return payload
  })
  filter('factures.items.update', async (payload, { keys }) => {
    const interdits = Object.keys(payload).filter(k => !MODIFIABLES.includes(k))
    if (interdits.length) fail('Une facture émise ne peut pas être modifiée : annulez-la (avec un motif) si nécessaire.')
    if (payload.statut && payload.statut !== 'annulee') fail('Une facture annulée ne peut pas être rétablie.')
    if (payload.statut === 'annulee' && !String(payload.motif_annulation ?? '').trim()) {
      const sansMotif = await db('factures').whereIn('id', keys).whereNull('motif_annulation').first('id')
      if (sansMotif) fail('Indiquez le motif de l’annulation.')
    }
    return payload
  })
  filter('factures.items.delete', async (keys) => {
    if (await db('factures').whereIn('id', keys).whereNot('statut', 'annulee').first('id')) fail('Une facture émise ne se supprime pas : annulez-la.')
    return keys
  })

  for (const evenement of ['create', 'update', 'delete']) {
    filter(`transactions_paiement.items.${evenement}`, (payload, _meta, { accountability }) => {
      if (accountability && !accountability.admin) fail('Les paiements en ligne sont enregistrés uniquement par le serveur.')
      return payload
    })
  }

  schedule('*/15 * * * *', async () => {
    try {
      const avant = (minutes) => new Date(Date.now() - minutes * 60000)
      const enAttente = await db('transactions_paiement').whereIn('statut', ['initiee', 'en_attente']).where('date_created', '<', avant(10)).select('id', 'reference', 'fournisseur', 'date_created')
      const c = await ctx()
      for (const t of enAttente) {
        if (t.fournisseur !== 'simulation') await actualiserTransaction(db, t.reference, c)
        if (new Date(t.date_created) < avant(48 * 60)) await db('transactions_paiement').where('id', t.id).whereIn('statut', ['initiee', 'en_attente']).update({ statut: 'expiree' })
      }
    } catch (e) {
      logger.error(e, 'gimmo-abonnement : suivi des paiements en attente')
    }
  })
}
