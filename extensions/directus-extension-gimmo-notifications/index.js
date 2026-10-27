/**
 * G-immo — notifications de l'utilisateur connecté (préfixe /notifications). Voir lib/gimmo/notifications.js.
 *
 * GET  /notifications?avant=<date>     20 dernières notifications (pagination par date) et nombre de non lues
 * GET  /notifications/non-lues         { total }
 * POST /notifications/lues             { ids?: [uuid…] } — marque comme lues (toutes si ids absent)
 * GET  /notifications/preferences      types proposés selon le rôle, canaux possibles et choix actuels
 * PUT  /notifications/preferences      { choix: { type: { application, email, sms } } }
 * Chaque utilisateur ne voit et ne modifie que ses propres notifications.
 */
import { createError, ForbiddenError } from '@directus/errors'
import { TYPES, enregistrerPreferences, preferencesDe, typesPourRole } from '../../lib/gimmo/notifications.js'

const InvalidRequest = createError('INVALID_REQUEST', (ext) => ext.message, 400)
const PAGE = 20

export default {
  id: 'notifications',
  handler: (router, { database: db }) => {
    const route = (fn) => async (req, res, next) => { try { res.json({ data: await fn(req) }) } catch (error) { next(error) } }
    const moi = (req) => { if (!req.accountability?.user) throw new ForbiddenError(); return req.accountability.user }
    const nonLues = async (u) => Number((await db('notifications').where({ utilisateur: u }).whereNull('date_lecture').count({ n: '*' }).first())?.n ?? 0)

    router.get('/', route(async (req) => {
      const u = moi(req)
      const q = db('notifications').where({ utilisateur: u }).orderBy('date_created', 'desc').limit(PAGE)
      if (req.query.avant && !Number.isNaN(Date.parse(String(req.query.avant)))) q.where('date_created', '<', new Date(String(req.query.avant)))
      const items = await q.select('id', 'type', 'titre', 'corps', 'params', 'lien', 'date_created', 'date_lecture')
      return { non_lues: await nonLues(u), items: items.map(n => ({ ...n, lue: !!n.date_lecture })), suite: items.length === PAGE }
    }))

    router.get('/non-lues', route(async (req) => ({ total: await nonLues(moi(req)) })))

    router.post('/lues', route(async (req) => {
      const u = moi(req)
      const ids = req.body?.ids
      const q = db('notifications').where({ utilisateur: u }).whereNull('date_lecture')
      if (Array.isArray(ids)) {
        if (!ids.length || ids.some(id => !/^[0-9a-f-]{36}$/.test(String(id)))) throw new InvalidRequest({ message: 'Notifications invalides.' })
        q.whereIn('id', ids)
      }
      const n = await q.update({ date_lecture: new Date() })
      return { marquees: n, non_lues: await nonLues(u) }
    }))

    const role = async (u) => (await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', u).first('r.name as role', 'u.telephone')) ?? {}

    router.get('/preferences', route(async (req) => {
      const u = moi(req)
      const r = await role(u)
      const prefs = await preferencesDe(db, u)
      return {
        telephone: !!r.telephone,
        types: typesPourRole(r.role).map(code => ({ code, libelle: TYPES[code].libelle, description: TYPES[code].description, canaux: TYPES[code].canaux, ...prefs[code] })),
      }
    }))

    router.put('/preferences', route(async (req) => {
      const u = moi(req)
      const choix = req.body?.choix
      if (!choix || typeof choix !== 'object') throw new InvalidRequest({ message: 'Préférences invalides.' })
      await enregistrerPreferences(db, u, (await role(u)).role, choix)
      return { ok: true }
    }))
  },
}
