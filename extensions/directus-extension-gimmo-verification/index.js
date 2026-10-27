/**
 * G-immo — vérification & confiance (Data Studio, API, front). Voir lib/gimmo/verification.js.
 *
 * 1. Badge « Vérifié » (biens, programmes) : seul l'administrateur de la plateforme l'écrit ; à la création il est
 *    remis à zéro ; modifier les informations clés d'un bien vérifié retire le badge.
 * 2. Anti double vente : un n° de titre foncier déjà enregistré par une autre entreprise est refusé (sans révéler
 *    laquelle) et une alerte est créée pour la plateforme ; dans la même entreprise, le bien existant est indiqué.
 * 3. Documents : la validation exige un fichier ; auteur et date de vérification renseignés automatiquement ;
 *    chaque nuit, un document validé et expiré passe « à renouveler ».
 * 4. Identité (KYC) : « vérifié » exige une pièce d'identité validée et non expirée ; « rejeté » exige un motif ;
 *    date et auteur renseignés automatiquement.
 * Les traitements automatiques (sans utilisateur) ne sont pas concernés.
 */
import { createError } from '@directus/errors'
import { randomUUID } from 'node:crypto'
import { todayIso } from '../../lib/gimmo/commun.js'
import { CHAMPS_BADGE, CHAMPS_CLES, SQL_TITRE, normaliserTitre } from '../../lib/gimmo/verification.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }
const egal = (a, b) => String(a ?? '') === String(b ?? '')

export default ({ filter, schedule }, { database: db0, logger }) => {
  // événements génériques : vus après l'isolation par agence de gimmo-rules (agence déjà renseignée à la création)
  const pour = (collection, action, handler) => filter(`items.${action}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)
  const utilisateur = (acc) => !!acc?.user && !acc.admin

  // ── 1. Badge
  for (const col of ['biens', 'programmes']) {
    pour(col, 'create', (payload, _meta, { accountability }) => {
      if (!utilisateur(accountability)) return payload
      if (payload.verifie === true || (payload.statut_verification && payload.statut_verification !== 'aucune')) fail('Le badge « Vérifié » est attribué par la plateforme : demandez la vérification une fois le bien enregistré.')
      for (const k of CHAMPS_BADGE) delete payload[k]
      return { ...payload, verifie: false, statut_verification: 'aucune' }
    })
    pour(col, 'update', async (payload, meta, { database, accountability }) => {
      if (!utilisateur(accountability)) return payload
      const actuels = await database(col).whereIn('id', meta.keys).select('id', ...CHAMPS_BADGE, ...CHAMPS_CLES[col])
      // champs du badge : seules les valeurs inchangées sont tolérées (formulaires qui renvoient tout)
      for (const k of CHAMPS_BADGE.filter(k => k in payload)) {
        if (actuels.some(a => !egal(a[k] === null && k === 'verifie' ? false : a[k], payload[k]))) fail('Le badge « Vérifié » est attribué par la plateforme : il ne peut pas être modifié ici.')
        delete payload[k]
      }
      // informations clés modifiées sur un élément vérifié : le badge est retiré
      const modifies = CHAMPS_CLES[col].filter(k => k in payload)
      const touche = actuels.filter(a => a.statut_verification === 'verifie' && modifies.some(k => !egal(a[k], payload[k])))
      if (touche.length) {
        Object.assign(payload, { verifie: false, statut_verification: 'aucune', date_verification: null, motif_verification: 'Badge retiré : informations clés modifiées (titre foncier, localisation ou surface). Demandez une nouvelle vérification.' })
      }
      return payload
    })
  }

  // ── 2. Anti double vente
  async function controlerTitre(numero, agence, exclure, { database, accountability }) {
    const n = normaliserTitre(numero)
    if (!n) return
    const doublon = await database('biens').whereRaw(`${SQL_TITRE} = ?`, [n]).modify(q => { if (exclure.length) q.whereNotIn('id', exclure) }).first('id', 'titre', 'agence')
    if (!doublon) return
    if (!agence || doublon.agence === agence) fail(`Ce n° de titre foncier est déjà utilisé par votre bien « ${doublon.titre} ».`)
    // autre entreprise : alerte pour la plateforme (connexion hors transaction : conservée malgré le refus), une seule par saisie en attente
    try {
      const deja = await db0('alertes_plateforme').where({ type: 'doublon_titre_foncier', statut: 'ouverte', agence, bien_existant: doublon.id }).first('id')
      if (!deja) await db0('alertes_plateforme').insert({ id: randomUUID(), type: 'doublon_titre_foncier', statut: 'ouverte', numero: String(numero).trim().slice(0, 100), agence, utilisateur: accountability?.user ?? null, bien_existant: doublon.id, agence_existante: doublon.agence, date_created: new Date() })
    } catch (err) { logger.error(err, 'gimmo-verification : alerte de doublon non enregistrée') }
    fail('Ce n° de titre foncier est déjà enregistré sur la plateforme. Vérifiez le numéro ; s’il est correct, la plateforme a été prévenue et reviendra vers vous.')
  }
  pour('biens', 'create', async (payload, _meta, context) => {
    if (!payload.numero_titre_foncier) return payload
    // agence du bien : celle envoyée, sinon celle de l'utilisateur (préremplie ensuite par les permissions)
    const agence = (typeof payload.agence === 'string' ? payload.agence : payload.agence?.id)
      ?? (context.accountability?.user ? (await context.database('directus_users').where('id', context.accountability.user).first('agence'))?.agence : null) ?? null
    await controlerTitre(payload.numero_titre_foncier, agence, [], context)
    return payload
  })
  pour('biens', 'update', async (payload, meta, context) => {
    if (!payload.numero_titre_foncier) return payload
    if (meta.keys.length > 1) fail('Un n° de titre foncier ne peut pas être attribué à plusieurs biens.')
    const b = await context.database('biens').where('id', meta.keys[0]).first('agence', 'numero_titre_foncier')
    if (b && normaliserTitre(b.numero_titre_foncier) !== normaliserTitre(payload.numero_titre_foncier)) await controlerTitre(payload.numero_titre_foncier, b.agence, meta.keys, context)
    return payload
  })

  // ── 3. Documents
  async function controlerDocument(payload, actuel, accountability) {
    if (!('statut_verification' in payload) || egal(payload.statut_verification, actuel?.statut_verification)) return payload
    const fichier = 'fichier' in payload ? payload.fichier : actuel?.fichier
    if (payload.statut_verification === 'valide' && !fichier) fail('Un document sans fichier ne peut pas être validé.')
    if (['valide', 'rejete'].includes(payload.statut_verification)) {
      payload.verifie_par = accountability?.user ?? null
      payload.date_verification = todayIso()
    }
    return payload
  }
  pour('documents', 'create', (payload, _meta, { accountability }) => accountability?.user ? controlerDocument(payload, null, accountability) : payload)
  pour('documents', 'update', async (payload, meta, { database, accountability }) => {
    if (!accountability?.user || !('statut_verification' in payload)) return payload
    const actuels = await database('documents').whereIn('id', meta.keys).select('statut_verification', 'fichier')
    if (payload.statut_verification === 'valide' && ('fichier' in payload ? !payload.fichier : actuels.some(a => !a.fichier))) fail('Un document sans fichier ne peut pas être validé.')
    if (['valide', 'rejete'].includes(payload.statut_verification) && actuels.some(a => a.statut_verification !== payload.statut_verification)) {
      Object.assign(payload, { verifie_par: accountability.user, date_verification: todayIso() })
    }
    return payload
  })

  // ── 4. Identité (KYC)
  async function controlerIdentite(payload, id, actuel, { database, accountability }) {
    if (!('statut_kyc' in payload) || egal(payload.statut_kyc, actuel?.statut_kyc)) return
    if (payload.statut_kyc === 'verifie') {
      const jour = todayIso()
      const piece = id ? await database('documents').where({ contact: id, type_document: 'piece_identite', statut_verification: 'valide' }).whereNotNull('fichier')
        .where(q => q.whereNull('date_expiration').orWhere('date_expiration', '>=', jour)).first('id') : null
      if (!piece) fail('Pour vérifier l’identité, ajoutez puis validez une pièce d’identité en cours de validité.')
      Object.assign(payload, { date_kyc: jour, kyc_verifie_par: accountability.user, motif_kyc: null })
    } else if (payload.statut_kyc === 'rejete') {
      if (!String(payload.motif_kyc ?? actuel?.motif_kyc ?? '').trim()) fail('Indiquez le motif du refus de vérification d’identité.')
      Object.assign(payload, { date_kyc: todayIso(), kyc_verifie_par: accountability.user })
    } else Object.assign(payload, { kyc_verifie_par: null })
  }
  pour('contacts', 'create', async (payload, _meta, context) => {
    if (utilisateur(context.accountability)) await controlerIdentite(payload, null, null, context)
    return payload
  })
  pour('contacts', 'update', async (payload, meta, context) => {
    if (!utilisateur(context.accountability) || !('statut_kyc' in payload)) return payload
    if (meta.keys.length > 1 && payload.statut_kyc === 'verifie') fail('L’identité se vérifie contact par contact.')
    for (const id of meta.keys) await controlerIdentite(payload, id, await context.database('contacts').where('id', id).first('statut_kyc', 'motif_kyc'), context)
    return payload
  })

  // ── Chaque nuit : documents validés arrivés à expiration
  schedule('40 0 * * *', async () => {
    try {
      const n = await db0('documents').where('statut_verification', 'valide').whereNotNull('date_expiration').where('date_expiration', '<', todayIso()).update({ statut_verification: 'a_renouveler' })
      if (n) logger.info(`gimmo-verification : ${n} document(s) à renouveler`)
    } catch (err) { logger.error(err, 'gimmo-verification : expiration des documents') }
  })
}
