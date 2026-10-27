/**
 * G-immo — comptabilité : écritures automatiques et intégrité du journal (Data Studio, API, front).
 *
 * - Encaissements de loyers, dépôts et sorties de séquestre, reversements payés et frais de maintenance sont comptabilisés automatiquement
 *   (lib/gimmo/comptabilite.js) après chaque écriture de la source, avec un rattrapage toutes les 10 minutes.
 * - Suppression d'une source déjà comptabilisée : sa pièce est contre-passée avant la suppression.
 * - Pièces et lignes ne s'écrivent que par les endpoints /gimmo/comptabilite (pièces équilibrées) et les automatismes :
 *   toute écriture directe est refusée ; l'administrateur de la plateforme peut seulement supprimer.
 */
import { createError } from '@directus/errors'
import { ORIGINE_SOURCE, synchroniser, rattraper, contrepasser } from '../../lib/gimmo/comptabilite.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }
const SOURCES = { paiements: 'paiement', reversements: 'reversement', tickets_maintenance: 'ticket', transactions_escrow: 'transaction_escrow' }

export default ({ filter, action, schedule }, { database: db0, logger }) => {
  // journal : écriture directe interdite (les endpoints et automatismes passent par la base, sans ces filtres)
  for (const collection of ['pieces_comptables', 'ecritures_comptables']) {
    for (const act of ['create', 'update', 'delete']) {
      filter(`${collection}.items.${act}`, (payload, _meta, { accountability }) => {
        if (accountability && !(act === 'delete' && accountability.admin)) fail('Les écritures comptables se saisissent depuis le module Comptabilité (pièces équilibrées) ; une pièce validée se corrige par contre-passation.')
        return payload
      })
    }
  }

  const suivre = async (source, ids) => {
    for (const id of new Set(ids.filter(Boolean))) {
      try { await synchroniser(db0, source, id) } catch (err) { logger.error(err, `gimmo-comptabilite : ${source} ${id} non comptabilisé (rattrapage dans 10 min)`) }
    }
  }
  for (const [collection, source] of Object.entries(SOURCES)) {
    action(`${collection}.items.create`, (meta) => suivre(source, [meta.key]))
    action(`${collection}.items.update`, (meta) => suivre(source, meta.keys))
    // source supprimée : contre-passation de sa pièce active, avant la suppression (la pièce reste au journal)
    filter(`${collection}.items.delete`, async (keys) => {
      const pieces = await db0('pieces_comptables').whereIn(source, keys).where({ origine: ORIGINE_SOURCE[source], statut: 'validee' }).pluck('id')
      for (const id of pieces) await db0.transaction(trx => contrepasser(trx, id, { motif: 'source supprimée' }))
      return keys
    })
  }

  const rattrapage = async () => {
    const n = await rattraper(db0, logger)
    if (n) logger.info(`gimmo-comptabilite : ${n} source(s) comptabilisée(s) au rattrapage`)
  }
  schedule('*/10 * * * *', rattrapage)
  setTimeout(() => rattrapage().catch(err => logger.error(err, 'gimmo-comptabilite : rattrapage au démarrage')), 15000) // historique et sources modifiées pendant l'arrêt
}
