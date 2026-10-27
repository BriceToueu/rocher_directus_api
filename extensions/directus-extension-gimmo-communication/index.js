/**
 * G-immo — communication automatique (voir lib/gimmo/communication.js).
 *  - chaque minute : envoi des messages planifiés arrivés à échéance et des quittances à transmettre par e-mail ;
 *  - chaque jour à 8 h : rappels avant échéance, relances d'impayé et messages avant fin de bail.
 * SMS / WhatsApp : fournisseur GIMMO_SMS_PROVIDER (« simulation » par défaut, aucun envoi réel).
 */
import { traiterFile, traiterAutomatisations } from '../../lib/gimmo/communication.js'

export default ({ schedule }, { services, database, getSchema, env, logger }) => {
  let enCours = false
  const ctx = async () => ({ services, schema: await getSchema(), env, logger })

  schedule('* * * * *', async () => {
    if (enCours) return
    enCours = true
    try {
      const b = await traiterFile(database, await ctx())
      if (b.envoyes || b.echecs) logger.info(`gimmo-communication : file — ${b.envoyes} envoyé(s), ${b.echecs} échec(s)`)
    } catch (err) {
      logger.error(err, 'gimmo-communication : file non traitée')
    } finally { enCours = false }
  })

  schedule('0 8 * * *', async () => {
    try {
      const b = await traiterAutomatisations(database, await ctx())
      logger.info(`gimmo-communication : relances du jour — ${b.envoyes} envoyée(s), ${b.echecs} échec(s), ${b.ignores} sans coordonnées`)
    } catch (err) {
      logger.error(err, 'gimmo-communication : relances non traitées')
    }
  })
}
