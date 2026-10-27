/**
 * G-immo — documents légaux (Data Studio, API). Voir lib/gimmo/legal.js.
 *
 * 1. Une version acceptée par au moins un utilisateur ne peut plus être modifiée (type, version, date d'effet, titres,
 *    contenus) : seul son statut peut changer (archivage). Pour corriger le texte, on crée une nouvelle version.
 * 2. Une version acceptée ne peut pas être supprimée (preuve d'acceptation).
 * 3. Une version publiée doit avoir un titre et un contenu en français.
 */
import { createError } from '@directus/errors'
import { CHAMPS_VERROUILLES } from '../../lib/gimmo/legal.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

export default ({ filter }, { database: db }) => {
  const acceptees = async (keys) => (await db('acceptations_legales').whereIn('document', keys).countDistinct('document as n').first())?.n > 0

  filter('documents_legaux.items.create', (payload) => {
    if (payload.statut === 'publie' && (!String(payload.titre_fr ?? '').trim() || !String(payload.contenu_fr ?? '').trim())) fail('Une version publiée doit avoir un titre et un contenu en français.')
    return payload
  })

  filter('documents_legaux.items.update', async (payload, { keys }) => {
    if (CHAMPS_VERROUILLES.some(c => c in payload) && await acceptees(keys)) {
      fail('Cette version a déjà été acceptée par des utilisateurs : elle ne peut plus être modifiée. Créez une nouvelle version (« Enregistrer comme copie »), puis publiez-la.')
    }
    if (payload.statut === 'publie' || 'titre_fr' in payload || 'contenu_fr' in payload) {
      const lignes = await db('documents_legaux').whereIn('id', keys).select('statut', 'titre_fr', 'contenu_fr')
      for (const l of lignes) {
        const v = { ...l, ...payload }
        if (v.statut === 'publie' && (!String(v.titre_fr ?? '').trim() || !String(v.contenu_fr ?? '').trim())) fail('Une version publiée doit avoir un titre et un contenu en français.')
      }
    }
    return payload
  })

  filter('documents_legaux.items.delete', async (keys) => {
    if (await acceptees(keys)) fail('Cette version a déjà été acceptée par des utilisateurs : elle ne peut pas être supprimée. Archivez-la.')
    return keys
  })
}
