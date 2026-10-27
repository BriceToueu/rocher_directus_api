/**
 * G-immo — plateforme SaaS (chargée en premier : « acces » précède les autres extensions gimmo) : règles appliquées par Directus avant chaque écriture d'un utilisateur d'entreprise
 * (Data Studio, API, front). Les traitements automatiques (sans utilisateur), l'administrateur de la plateforme et le
 * responsable pays ne sont pas concernés.
 *
 * 1. Licence : sans licence valide (essai, active, délai de grâce), le compte est en lecture seule.
 * 2. Modules selon le type de compte : promoteur indépendant sans gestion locative ; propriétaire indépendant sans
 *    mandats ni reversements (voir lib/gimmo/saas.js).
 * 3. Limites de l'offre : biens et annonces en ligne (les utilisateurs sont limités par /gimmo/equipe).
 * 4. Licences : dates cohérentes, devise et montant repris du pays et du tarif ; l'état de licence des agences est
 *    recalculé à chaque changement et chaque nuit (délai de grâce de 15 jours puis lecture seule).
 */
import { createError } from '@directus/errors'
import { randomUUID } from 'node:crypto'
import { isoDate } from '../../lib/gimmo/commun.js'
import { ETATS_ECRITURE, LIBELLE_TYPE, MODULES_FERMES, TYPES_COMPTE, controleEntreprise, entrepriseDe, envoyerRappels, offreCourante, rafraichirEtats, usage, viderCacheEntreprise } from '../../lib/gimmo/saas.js'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

export default ({ filter, action, schedule }, { database: db0, logger, services, getSchema, env }) => {
  const viderCache = viderCacheEntreprise

  /** Fiche contact du propriétaire indépendant (lui-même), créée à la première utilisation. */
  async function contactProprietaire(db, agence) {
    const a = await db('agences').where('id', agence).first('nom', 'telephone', 'email', 'proprietaire_contact')
    if (a.proprietaire_contact && await db('contacts').where('id', a.proprietaire_contact).first('id')) return a.proprietaire_contact
    const id = randomUUID()
    await db('contacts').insert({ id, type_personne: 'physique', nom: a.nom, telephone: a.telephone ?? null, email: a.email ?? null, categorie_proprietaire: 'particulier', statut_kyc: 'non_requis', actif: true, agence, date_created: new Date() })
    await db('agences').where('id', agence).update({ proprietaire_contact: id })
    return id
  }

  for (const act of ['create', 'update', 'delete']) {
    filter(`items.${act}`, async (payload, meta, { database, accountability }) => {
      const ent = await controleEntreprise(database, accountability, meta.collection, fail)
      if (!ent) return payload
      if (meta.collection === 'agences' && act === 'update' && ['type_compte', 'etat_licence', 'licence_fin', 'promoteur', 'pays', 'actif'].some(k => k in payload)) fail('Ces réglages du compte sont gérés par l’administrateur de la plateforme.')

      // modération de la plateforme : l'entreprise ne lève pas un retrait et ne republie pas une publication retirée
      if (['annonces', 'programmes'].includes(meta.collection) && act !== 'delete') {
        if (['retire_par_plateforme', 'motif_moderation', 'date_moderation'].some(k => k in payload)) fail('La modération est réservée à l’administrateur de la plateforme.')
        const publie = meta.collection === 'annonces' ? payload.statut === 'publiee' : payload.statut_publication === 'publie'
        if (publie && meta.keys) {
          const retire = await database(meta.collection).whereIn('id', meta.keys).where('retire_par_plateforme', true).first('motif_moderation')
          if (retire) fail(`Cette publication a été retirée par l’administrateur de la plateforme${retire.motif_moderation ? ` (${retire.motif_moderation})` : ''} : contactez-le pour la rétablir.`)
        }
      }

      // comptes indépendants : le propriétaire indépendant possède ses biens ; le promoteur indépendant porte ses programmes
      if (act === 'create' && meta.collection === 'biens' && ent.type_compte === 'proprietaire_independant') {
        const lignes = Array.isArray(payload.proprietaires) ? payload.proprietaires : (payload.proprietaires?.create ?? [])
        if (!lignes.length) payload.proprietaires = [{ contacts_id: await contactProprietaire(database, ent.agence), quote_part: 100, est_mandant: true }]
      }
      if (act === 'create' && meta.collection === 'programmes' && ent.type_compte === 'promoteur_independant') {
        const fiche = (await database('agences').where('id', ent.agence).first('promoteur'))?.promoteur
        if (!fiche) fail('Votre fiche promoteur n’est pas encore créée : contactez l’administrateur de la plateforme.')
        if (payload.promoteur && payload.promoteur !== fiche) fail('Vos programmes sont publiés sous votre propre fiche promoteur.')
        payload.promoteur = fiche
      }
      if (act === 'update' && meta.collection === 'programmes' && ent.type_compte === 'promoteur_independant' && 'promoteur' in payload) {
        const fiche = (await database('agences').where('id', ent.agence).first('promoteur'))?.promoteur
        if (payload.promoteur !== fiche) fail('Vos programmes sont publiés sous votre propre fiche promoteur.')
      }

      // limites de l'offre
      if (act === 'create' && meta.collection === 'biens') {
        const offre = await offreCourante(database, ent.agence)
        if (offre?.max_biens != null && (await usage(database, ent.agence)).biens >= offre.max_biens) fail(`Votre offre ${offre.nom} est limitée à ${offre.max_biens} biens : passez à une offre supérieure pour en ajouter.`)
      }
      if (meta.collection === 'annonces' && act !== 'delete' && payload.statut === 'publiee') {
        const offre = await offreCourante(database, ent.agence)
        if (offre?.max_annonces != null) {
          const autres = Number((await database('annonces').where({ agence: ent.agence, statut: 'publiee' }).modify(q => { if (meta.keys) q.whereNotIn('id', meta.keys) }).count({ n: '*' }).first())?.n ?? 0)
          if (autres + (meta.keys?.length ?? 1) > offre.max_annonces) fail(`Votre offre ${offre.nom} permet ${offre.max_annonces} annonces en ligne : retirez-en une ou passez à une offre supérieure.`)
        }
      }
      return payload
    })
  }

  // ── Site public : pas de demande vers un compte sans licence valide (ses annonces et programmes ne sont plus en ligne)
  filter('demandes.items.create', async (payload, _meta, { database, accountability }) => {
    if (accountability?.user) return payload
    const agence = payload.annonce ? (await database('annonces').where('id', payload.annonce).first('agence'))?.agence
      : payload.lot ? (await database('lots as l').join('programmes as p', 'p.id', 'l.programme').where('l.id', payload.lot).first('p.agence'))?.agence : null
    const etat = agence ? (await database('agences').where('id', agence).first('etat_licence'))?.etat_licence : null
    if (agence && !ETATS_ECRITURE.includes(etat)) fail('Cette annonce n’est plus en ligne.')
    return payload
  })

  // ── Comptes entreprises
  filter('agences.items.create', (payload) => {
    if (payload.type_compte && !TYPES_COMPTE.includes(payload.type_compte)) fail('Type de compte inconnu.')
    delete payload.etat_licence
    delete payload.licence_fin
    return payload
  })
  filter('agences.items.update', async (payload, meta, { database }) => {
    if ('type_compte' in payload && !TYPES_COMPTE.includes(payload.type_compte)) fail('Type de compte inconnu.')
    if ('type_compte' in payload) {
      for (const id of meta.keys) {
        const fermes = MODULES_FERMES[payload.type_compte] ?? []
        const bloquant = [['baux', 'bail'], ['mandats', 'mandat']].find(([c]) => fermes.includes(c))
        if (bloquant && await database(bloquant[0]).modify(q => { if (bloquant[0] === 'baux') q.join('biens as b', 'b.id', 'baux.bien').where('b.agence', id); else q.where('agence', id) }).first(`${bloquant[0]}.id`)) {
          fail(`Ce compte a déjà des ${bloquant[0]} : il ne peut pas devenir ${LIBELLE_TYPE[payload.type_compte]}.`)
        }
      }
    }
    if ('promoteur' in payload && payload.promoteur && await database('agences').where('promoteur', payload.promoteur).whereNotIn('id', meta.keys).first('id')) fail('Cette fiche promoteur est déjà rattachée à un autre compte.')
    delete payload.etat_licence
    delete payload.licence_fin
    return payload
  })

  // ── Licences
  async function controlerLicence(db, row) {
    if (!row.agence || !row.offre) fail('Indiquez le compte entreprise et l’offre.')
    if (!row.date_debut || !row.date_fin || isoDate(row.date_fin) < isoDate(row.date_debut)) fail('La date de fin doit suivre la date de début.')
    if (row.montant != null && (!Number.isSafeInteger(Number(row.montant)) || Number(row.montant) < 0)) fail('Montant invalide.')
  }
  filter('licences.items.create', async (payload, _meta, { database }) => {
    await controlerLicence(database, payload)
    const ag = await database('agences as a').join('pays as p', 'p.id', 'a.pays').where('a.id', payload.agence).first('a.pays', 'p.devise')
    if (!ag) fail('Compte entreprise introuvable.')
    payload.devise ??= ag.devise
    if (payload.montant == null) {
      const t = await database('offres_tarifs').where({ offre: payload.offre, pays: ag.pays }).first('prix_mensuel', 'prix_annuel')
      payload.montant = !t || payload.periodicite === 'essai' ? 0 : payload.periodicite === 'annuel' ? Number(t.prix_annuel ?? Number(t.prix_mensuel) * 12) : Number(t.prix_mensuel)
    }
    return payload
  })
  filter('licences.items.update', async (payload, meta, { database }) => {
    for (const id of meta.keys) await controlerLicence(database, { ...(await database('licences').where('id', id).first()), ...payload })
    return payload
  })
  const avantSuppression = new Map()
  filter('licences.items.delete', async (keys, _meta, { database }) => {
    for (const r of await database('licences').whereIn('id', keys).select('id', 'agence')) avantSuppression.set(r.id, r.agence)
    return keys
  })

  const rafraichir = async (agences) => {
    viderCache()
    try {
      const changes = await rafraichirEtats(db0, [...new Set(agences.filter(Boolean))])
      for (const c of changes) logger.info(`gimmo-acces : compte ${c.id} ${c.avant} → ${c.apres}`)
    } catch (err) { logger.error(err, 'gimmo-acces : état de licence non recalculé') }
  }
  action('licences.items.create', (meta) => rafraichir([meta.payload.agence]))
  action('licences.items.update', async (meta) => rafraichir(await db0('licences').whereIn('id', meta.keys).pluck('agence')))
  action('licences.items.delete', (meta) => { const a = meta.keys.map(k => avantSuppression.get(k)); meta.keys.forEach(k => avantSuppression.delete(k)); return rafraichir(a) })
  action('agences.items.create', (meta) => rafraichir([meta.key]))
  action('agences.items.update', () => viderCache())
  action('users.update', () => viderCache())

  // Au démarrage (licences modifiées pendant l'arrêt) et chaque nuit : passage en délai de grâce, puis en lecture seule
  setTimeout(() => rafraichir([]).then(() => rafraichirEtats(db0)).catch(err => logger.error(err, 'gimmo-acces : recalcul au démarrage')), 5000)
  schedule('20 0 * * *', async () => {
    viderCache()
    const changes = await rafraichirEtats(db0)
    if (changes.length) logger.info(`gimmo-acces : ${changes.length} compte(s) changent d’état de licence`)
    const n = await envoyerRappels(db0, { services, schema: await getSchema(), logger, env })
    if (n) logger.info(`gimmo-acces : ${n} rappel(s) de licence envoyé(s)`)
  })
}
