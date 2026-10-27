/**
 * G-immo — acceptation des documents légaux (préfixe /legal). Voir lib/gimmo/legal.js.
 *
 * POST /legal/inscription   (public)  { email, password, first_name, last_name, verification_url, langue, cgu, confidentialite }
 *                                      inscription d'un client : refusée sans les versions en vigueur ; acceptation enregistrée
 * POST /legal/invitation    (public)  { token, password, langue, cgu, confidentialite } activation d'un compte invité
 * GET  /legal/a-accepter    (connecté) versions en vigueur pas encore acceptées (vide pour les comptes de la plateforme)
 * POST /legal/accepter      (connecté) { documents: [id…], langue } acceptation d'une nouvelle version
 *
 * Même réponse que l'inscription ait créé un compte ou non (adresse déjà inscrite) : rien n'est révélé.
 */
import { createError, ForbiddenError } from '@directus/errors'
import { aAccepter, controleVersions, documentsCourants, enregistrerAcceptations, estPlateforme } from '../../lib/gimmo/legal.js'

const InvalidRequest = createError('INVALID_REQUEST', (ext) => ext.message, 400)
const LegalError = createError('LEGAL_VERSION', (ext) => ext.message, 400)
const texte = (v, max) => String(v ?? '').trim().slice(0, max)
const emailDuJeton = (token) => { try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).email } catch { return null } }

export default {
  id: 'legal',
  handler: (router, { services, getSchema, database: db }) => {
    const { UsersService } = services
    const route = (fn) => async (req, res, next) => { try { res.json({ data: await fn(req) }) } catch (error) { next(error) } }
    const connecte = (req) => { if (!req.accountability?.user) throw new ForbiddenError(); return req.accountability.user }
    const versions = async (b) => {
      const courants = await documentsCourants(db)
      const erreur = controleVersions(courants, b)
      if (erreur) throw new LegalError({ message: erreur.message, raison: erreur.code })
      return [courants.cgu.id, courants.confidentialite.id]
    }
    const utilisateurParEmail = (email) => db('directus_users').whereRaw('lower(email) = ?', [String(email).toLowerCase()]).first('id', 'status')

    router.post('/inscription', route(async (req) => {
      const b = req.body ?? {}
      const email = texte(b.email, 200).toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !b.password) throw new InvalidRequest({ message: 'Adresse e-mail ou mot de passe manquant.' })
      const documents = await versions(b)
      const avant = await utilisateurParEmail(email)
      await new UsersService({ schema: await getSchema(), accountability: null }).registerUser({
        email, password: String(b.password), verification_url: b.verification_url || undefined,
        first_name: texte(b.first_name, 100) || null, last_name: texte(b.last_name, 100) || null,
      })
      // compte créé, ou inscription non confirmée relancée : la personne vient d'accepter les versions en vigueur
      if (!avant || avant.status === 'unverified') {
        const apres = await utilisateurParEmail(email)
        if (apres) await enregistrerAcceptations(db, apres.id, documents, 'inscription', b.langue)
      }
      return { ok: true }
    }))

    router.post('/invitation', route(async (req) => {
      const b = req.body ?? {}
      if (!b.token || !b.password) throw new InvalidRequest({ message: 'Invitation ou mot de passe manquant.' })
      const documents = await versions(b)
      await new UsersService({ schema: await getSchema(), accountability: null }).acceptInvite(String(b.token), String(b.password))
      // jeton vérifié par acceptInvite : l'adresse qu'il porte est celle du compte activé
      const u = await utilisateurParEmail(emailDuJeton(b.token))
      if (u) await enregistrerAcceptations(db, u.id, documents, 'invitation', b.langue)
      return { ok: true }
    }))

    router.get('/a-accepter', route(async (req) => {
      const utilisateur = connecte(req)
      if (req.accountability.admin || await estPlateforme(db, utilisateur)) return []
      return aAccepter(db, utilisateur)
    }))

    router.post('/accepter', route(async (req) => {
      const utilisateur = connecte(req)
      const ids = Array.isArray(req.body?.documents) ? req.body.documents.map(Number) : []
      const courants = Object.values(await documentsCourants(db)).map(d => d.id)
      if (!ids.length || ids.some(id => !courants.includes(id))) {
        throw new LegalError({ message: 'Les conditions ont été mises à jour : rechargez la page pour lire et accepter la nouvelle version.', raison: 'PERIME' })
      }
      await enregistrerAcceptations(db, utilisateur, ids, 'mise_a_jour', req.body?.langue)
      return { restant: (await aAccepter(db, utilisateur)).length }
    }))
  },
}
