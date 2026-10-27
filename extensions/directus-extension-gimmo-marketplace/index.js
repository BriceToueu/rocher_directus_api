/**
 * G-immo — annonces (Data Studio, API, front).
 *
 *  - référence ANN-AAAA-NNNNN ; agence et devise reprises du bien (et du pays de son agence) ;
 *  - prix strictement positif ; une seule annonce publiée par bien et par type de transaction ;
 *  - publication (l'agence publie directement) : bien disponible ou réservé (location : pas déjà loué ; vente : pas vendu),
 *    au moins une photo ; date de publication posée, expiration par défaut à 90 jours ;
 *  - statuts : brouillon → publiée ↔ suspendue ; publiée → expirée / conclue ; expirée → republiée ; conclue : définitif ;
 *  - un bail mis en vigueur conclut les annonces de location publiées du bien ;
 *  - chaque nuit : annonces publiées dont la date d'expiration est passée → « expirée ».
 */
import { createError } from '@directus/errors'

const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const fail = (message) => { throw new BusinessRuleError({ message }) }

const TRANSITIONS = {
  brouillon: ['publiee', 'en_attente_validation'],
  en_attente_validation: ['publiee', 'brouillon'],
  publiee: ['suspendue', 'expiree', 'conclue', 'brouillon'],
  suspendue: ['publiee', 'conclue', 'brouillon'],
  expiree: ['publiee', 'conclue', 'brouillon'],
  conclue: [],
}
const LIBELLES = { brouillon: 'brouillon', en_attente_validation: 'en attente', publiee: 'publiée', suspendue: 'suspendue', expiree: 'expirée', conclue: 'conclue' }
const DUREE_JOURS = 90

export default ({ filter, action, schedule }, { database: db0, logger }) => {
  // événements génériques : vus avant les contrôles génériques de gimmo-rules (voir gimmo-gestion)
  const pour = (collection, act, handler) => filter(`items.${act}`, (payload, meta, context) => meta.collection === collection ? handler(payload, meta, context) : payload)

  async function controler(db, payload, existing) {
    const row = { ...(existing ?? {}), ...payload }
    if (existing && 'statut' in payload && payload.statut !== existing.statut && !(TRANSITIONS[existing.statut] ?? []).includes(payload.statut)) {
      fail(`Une annonce ${LIBELLES[existing.statut]} ne peut pas passer à « ${LIBELLES[payload.statut] ?? payload.statut} ».`)
    }
    if ('prix' in payload && !(Number(payload.prix) > 0)) fail('Le prix de l’annonce doit être positif.')
    if (row.bien && (payload.bien || !existing)) {
      const b = await db('biens as b').join('agences as a', 'a.id', 'b.agence').join('pays as p', 'p.id', 'a.pays').where('b.id', row.bien).first('b.agence', 'p.devise')
      if (b) { payload.agence ??= b.agence; payload.devise ??= b.devise; row.agence = payload.agence; row.devise = payload.devise }
    }
    const publication = row.statut === 'publiee' && (!existing || existing.statut !== 'publiee')
    if (publication) {
      if (!row.bien) fail('Une annonce publiée doit présenter un bien.')
      const bien = await db('biens').where('id', row.bien).first('titre', 'statut', 'photo_principale')
      const photos = Number((await db('biens_files').where('biens_id', row.bien).count({ n: '*' }).first())?.n ?? 0)
      if (!bien?.photo_principale && !photos) fail('Ajoutez au moins une photo au bien avant de publier l’annonce.')
      if (['brouillon', 'archive', 'en_attente'].includes(bien?.statut)) fail(`Le bien « ${bien.titre} » n’est pas prêt à être proposé (statut : ${bien.statut}).`)
      if (row.type_transaction === 'location' && bien?.statut === 'loue') fail('Ce bien est déjà loué : l’annonce de location ne peut pas être publiée.')
      if (bien?.statut === 'vendu') fail('Ce bien est vendu : l’annonce ne peut pas être publiée.')
      const autre = await db('annonces').where({ bien: row.bien, type_transaction: row.type_transaction, statut: 'publiee' })
        .modify(q => { if (existing?.id) q.whereNot('id', existing.id) }).first('reference')
      if (autre) fail(`Ce bien a déjà une annonce de ${row.type_transaction === 'vente' ? 'vente' : 'location'} publiée (${autre.reference}).`)
      payload.date_publication = new Date().toISOString()
      if (!row.date_expiration || new Date(row.date_expiration) <= new Date()) payload.date_expiration = new Date(Date.now() + DUREE_JOURS * 86400000).toISOString()
    }
    if (payload.en_vedette === false) payload.vedette_jusqu_au = null
    return payload
  }

  pour('annonces', 'create', async (payload, _meta, { database, accountability }) => {
    if (!payload.reference) {
      const annee = new Date().getFullYear()
      const last = await database('annonces').where('reference', 'like', `ANN-${annee}-%`).orderBy('reference', 'desc').first('reference')
      payload.reference = `ANN-${annee}-${String(last ? Number(last.reference.split('-')[2]) + 1 : 1).padStart(5, '0')}`
    }
    if (payload.agent === undefined && accountability?.user) payload.agent = accountability.user
    payload.statut ??= 'brouillon'
    return controler(database, payload, null)
  })
  pour('annonces', 'update', async (payload, meta, { database }) => {
    for (const id of meta.keys) await controler(database, payload, await database('annonces').where('id', id).first())
    return payload
  })

  // un bail en vigueur conclut les annonces de location publiées ou suspendues du bien
  const conclure = async (ids, { database }) => {
    for (const id of ids) {
      const bail = await database('baux').where('id', id).first('bien', 'statut')
      if (bail?.statut !== 'en_vigueur') continue
      const n = await database('annonces').where({ bien: bail.bien, type_transaction: 'location' }).whereIn('statut', ['publiee', 'suspendue']).update({ statut: 'conclue' })
      if (n) logger.info(`gimmo-marketplace : ${n} annonce(s) de location conclue(s) (bail en vigueur)`)
    }
  }
  action('baux.items.create', (meta, ctx) => conclure([meta.key], ctx))
  action('baux.items.update', (meta, ctx) => conclure(meta.keys, ctx))

  schedule('15 1 * * *', async () => {
    const n = await db0('annonces').where('statut', 'publiee').whereNotNull('date_expiration').where('date_expiration', '<', new Date()).update({ statut: 'expiree' })
    logger.info(`gimmo-marketplace : ${n} annonce(s) expirée(s)`)
  })
}
