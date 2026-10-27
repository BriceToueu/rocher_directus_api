/**
 * G-immo — messagerie (préfixe /messagerie). Voir lib/gimmo/messagerie.js pour les règles d'accès.
 *
 * GET  /messagerie/conversations?type=            conversations visibles, avec non-lus et dernier message
 * POST /messagerie/conversations                   { type, sujet, message, contact?, agence?, participants? } → nouvelle conversation
 * GET  /messagerie/conversations/:id               conversation et messages (auteur : nom + rôle) ; la marque lue
 * POST /messagerie/conversations/:id/messages      { contenu } en JSON, ou multipart (contenu + fichier : image ou PDF, 10 Mo)
 * POST /messagerie/conversations/:id/statut        { statut: ouverte | close }
 * GET  /messagerie/non-lus                         { total }
 * GET  /messagerie/messages/:id/piece-jointe       fichier joint (participants de la conversation seulement)
 * GET  /messagerie/destinataires                   locataires (avec espace en ligne) et collègues proposés à l'ouverture
 */
import { createError, ForbiddenError } from '@directus/errors'
import { randomUUID } from 'node:crypto'
import Busboy from 'busboy'
import { ROLES_ENTREPRISE, TYPES, auteurs, destinataires, marquerLu, nonLus, notifier, peutVoir, profil, visibles } from '../../lib/gimmo/messagerie.js'
import { ETATS_ECRITURE } from '../../lib/gimmo/saas.js'

const InvalidRequest = createError('INVALID_REQUEST', (ext) => ext.message, 400)
const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const TYPES_FICHIERS = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const MAX_FICHIER = 10 * 1024 * 1024
const ROLES_LOCATAIRES = ['Administrateur d’entreprise', 'Manager', 'Financier']
const ROLES_SUPPORT = ['Administrateur d’entreprise', 'Manager']

export default {
  id: 'messagerie',
  handler: (router, { services, getSchema, database: db, env, logger }) => {
    const { FilesService, AssetsService } = services
    const route = (fn) => async (req, res, next) => {
      try {
        const p = await profil(db, req.accountability)
        if (!p) throw new ForbiddenError()
        const r = await fn(req, p, res)
        if (r !== undefined) res.json({ data: r })
      } catch (error) { next(error) }
    }
    // écriture : licence de l'entreprise en écriture (la plateforme et les locataires ne sont pas concernés)
    const licenceOk = async (agence) => ETATS_ECRITURE.includes((await db('agences').where('id', agence).first('etat_licence'))?.etat_licence)

    router.get('/conversations', route(async (req, p) => {
      let q = visibles(db, p).leftJoin('agences as a', 'a.id', 'c.agence').leftJoin('contacts as ct', 'ct.id', 'c.contact')
      if (TYPES.includes(req.query.type)) q = q.where('c.type', req.query.type)
      const liste = await q.orderBy('c.date_dernier_message', 'desc').limit(200)
        .select('c.id', 'c.type', 'c.sujet', 'c.statut', 'c.date_dernier_message', 'c.extrait', 'c.agence', 'a.nom as agence_nom', 'c.contact', 'ct.prenom', 'ct.nom', 'ct.raison_sociale')
      const nl = await nonLus(db, p.id, liste.map(c => c.id))
      const parts = await db('conversations_membres').whereIn('conversation', liste.filter(c => c.type === 'interne').map(c => c.id).concat(['00000000-0000-0000-0000-000000000000']))
        .where('participant', true).select('conversation', 'utilisateur')
      const noms = await auteurs(db, [...new Set(parts.map(x => x.utilisateur))])
      return liste.map(c => ({
        id: c.id, type: c.type, sujet: c.sujet, statut: c.statut, date_dernier_message: c.date_dernier_message, extrait: c.extrait, non_lus: nl[c.id] ?? 0,
        agence: { id: c.agence, nom: c.agence_nom },
        locataire: c.contact ? (c.raison_sociale || [c.prenom, c.nom].filter(Boolean).join(' ')) : null,
        participants: c.type === 'interne' ? parts.filter(x => x.conversation === c.id && x.utilisateur !== p.id).map(x => noms[x.utilisateur]?.nom).filter(Boolean) : undefined,
      }))
    }))

    router.get('/non-lus', route(async (_req, p) => {
      const ids = await visibles(db, p).pluck('c.id')
      const nl = await nonLus(db, p.id, ids)
      return { total: Object.values(nl).reduce((s, n) => s + n, 0) }
    }))

    // personnes à qui l'on peut écrire : locataires (compte en ligne actif) et collègues de l'entreprise
    router.get('/destinataires', route(async (_req, p) => {
      if (p.plateforme) return { agences: await db('agences').where('actif', true).orderBy('nom').select('id', 'nom') }
      if (p.locataire) return { agences: await db('agences').whereIn('id', p.agences.length ? p.agences : ['00000000-0000-0000-0000-000000000000']).orderBy('nom').select('id', 'nom') }
      const collegues = await db('directus_users as u').join('directus_roles as r', 'r.id', 'u.role').where({ 'u.agence': p.agence, 'u.status': 'active' }).whereIn('r.name', ROLES_ENTREPRISE)
        .whereNot('u.id', p.id).orderBy(['u.first_name', 'u.last_name']).select('u.id', 'u.first_name', 'u.last_name', 'u.email', 'r.name as role')
      const locataires = ROLES_LOCATAIRES.includes(p.role)
        ? await db('contacts as c').join('baux as b', 'b.locataire', 'c.id').where('c.agence', p.agence).whereNotNull('c.utilisateur')
          .whereIn('b.statut', ['en_vigueur', 'litige', 'en_attente_signature']).distinct('c.id', 'c.prenom', 'c.nom', 'c.raison_sociale').orderBy('c.nom')
        : []
      return {
        collegues: collegues.map(u => ({ id: u.id, nom: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email, role: u.role })),
        locataires: locataires.map(c => ({ id: c.id, nom: c.raison_sociale || [c.prenom, c.nom].filter(Boolean).join(' ') })),
        support: ROLES_SUPPORT.includes(p.role), locatairesPermis: ROLES_LOCATAIRES.includes(p.role),
      }
    }))

    router.post('/conversations', route(async (req, p) => {
      const b = req.body ?? {}
      const sujet = String(b.sujet ?? '').trim().slice(0, 150)
      const message = String(b.message ?? '').trim().slice(0, 5000)
      if (!TYPES.includes(b.type)) throw new InvalidRequest({ message: 'Type de conversation inconnu.' })
      let agence, contact = null, participants = []
      if (b.type === 'agence_locataire') {
        if (p.locataire) {
          agence = b.agence && p.agences.includes(b.agence) ? b.agence : p.agences.length === 1 ? p.agences[0] : null
          if (!agence) throw new InvalidRequest({ message: 'Choisissez votre agence.' })
          contact = (await db('contacts').where({ agence, utilisateur: p.id }).first('id'))?.id
        } else if (!p.plateforme && ROLES_LOCATAIRES.includes(p.role)) {
          agence = p.agence
          const c = await db('contacts').where({ id: b.contact, agence }).first('id', 'utilisateur')
          if (!c) throw new InvalidRequest({ message: 'Choisissez le locataire.' })
          if (!c.utilisateur) throw new BusinessRuleError({ message: 'Ce locataire n’a pas encore d’espace en ligne : invitez-le depuis sa fiche.' })
          contact = c.id
        } else throw new ForbiddenError()
      } else if (b.type === 'interne') {
        if (p.plateforme || p.locataire) throw new ForbiddenError()
        agence = p.agence
        const ids = Array.isArray(b.participants) ? b.participants.filter(x => typeof x === 'string').slice(0, 50) : []
        participants = ids.length ? await db('directus_users as u').join('directus_roles as r', 'r.id', 'u.role').whereIn('u.id', ids)
          .where({ 'u.agence': agence, 'u.status': 'active' }).whereIn('r.name', ROLES_ENTREPRISE).whereNot('u.id', p.id).pluck('u.id') : []
        if (!participants.length) throw new InvalidRequest({ message: 'Choisissez au moins un collègue.' })
      } else {
        if (p.locataire) throw new ForbiddenError()
        if (p.plateforme) {
          agence = b.agence
          if (!agence || !await db('agences').where('id', agence).first('id')) throw new InvalidRequest({ message: 'Choisissez le compte entreprise.' })
        } else {
          if (!ROLES_SUPPORT.includes(p.role)) throw new ForbiddenError()
          agence = p.agence
        }
      }
      // droits vérifiés d'abord, contenu ensuite
      if (sujet.length < 2 || !message) throw new InvalidRequest({ message: 'Indiquez le sujet et le message.' })
      // le support reste ouvert même en lecture seule (pour régulariser une licence)
      if (!p.plateforme && !p.locataire && b.type !== 'support' && !await licenceOk(agence)) throw new BusinessRuleError({ message: 'Licence non valide : le compte de votre entreprise est en lecture seule.' })
      const id = randomUUID(), maintenant = new Date()
      await db.transaction(async (trx) => {
        await trx('conversations').insert({ id, type: b.type, sujet, statut: 'ouverte', agence, contact, cree_par: p.id, date_created: maintenant, date_dernier_message: maintenant, extrait: message.slice(0, 200) })
        await trx('conversations_membres').insert([{ conversation: id, utilisateur: p.id, participant: true, date_lecture: maintenant }, ...participants.map(u => ({ conversation: id, utilisateur: u, participant: true }))])
        await trx('conversations_messages').insert({ id: randomUUID(), conversation: id, auteur: p.id, contenu: message, date_created: maintenant })
      })
      const conv = await db('conversations').where('id', id).first()
      await envoyerNotifications(conv, { contenu: message }, p.id)
      return { id }
    }))

    router.get('/conversations/:id', route(async (req, p) => {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !await peutVoir(db, p, req.params.id)) throw new ForbiddenError()
      const c = await db('conversations as c').leftJoin('agences as a', 'a.id', 'c.agence').leftJoin('contacts as ct', 'ct.id', 'c.contact').where('c.id', req.params.id)
        .first('c.id', 'c.type', 'c.sujet', 'c.statut', 'c.agence', 'a.nom as agence_nom', 'ct.prenom', 'ct.nom', 'ct.raison_sociale', 'c.contact')
      const messages = (await db('conversations_messages as m').leftJoin('directus_files as f', 'f.id', 'm.piece_jointe').where('m.conversation', c.id)
        .orderBy('m.date_created', 'desc').limit(300).select('m.id', 'm.contenu', 'm.date_created', 'm.auteur', 'f.id as fichier', 'f.filename_download', 'f.type as fichier_type', 'f.filesize')).reverse()
      const noms = await auteurs(db, [...new Set(messages.map(m => m.auteur).filter(Boolean))])
      const parts = c.type === 'interne' ? await db('conversations_membres').where({ conversation: c.id, participant: true }).pluck('utilisateur') : []
      const nomsParts = await auteurs(db, parts)
      await marquerLu(db, c.id, p.id)
      return {
        id: c.id, type: c.type, sujet: c.sujet, statut: c.statut, agence: { id: c.agence, nom: c.agence_nom },
        locataire: c.contact ? (c.raison_sociale || [c.prenom, c.nom].filter(Boolean).join(' ')) : null,
        participants: parts.map(u => ({ id: u, ...nomsParts[u] })),
        messages: messages.map(m => ({
          id: m.id, contenu: m.contenu, date: m.date_created, moi: m.auteur === p.id,
          auteur: m.auteur ? { id: m.auteur, ...(noms[m.auteur] ?? { nom: '—', role: null }) } : { nom: 'Gocleus Immo', role: 'plateforme' },
          piece_jointe: m.fichier ? { nom: m.filename_download, type: m.fichier_type, taille: Number(m.filesize ?? 0) } : null,
        })),
      }
    }))

    /** Lit un envoi multipart : champs texte + un fichier (image ou PDF, 10 Mo). */
    function lireMultipart(req) {
      return new Promise((resolve, reject) => {
        const champs = {}
        let fichier = null, erreur = null
        const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_FICHIER, fields: 5, fieldSize: 20000 } })
        bb.on('field', (nom, valeur) => { champs[nom] = valeur })
        bb.on('file', (_nom, flux, info) => {
          if (!TYPES_FICHIERS.includes(info.mimeType)) { erreur = 'Format non accepté : image (JPEG, PNG, WebP) ou PDF.'; flux.resume(); return }
          const morceaux = []
          flux.on('data', d => morceaux.push(d))
          flux.on('limit', () => { erreur = 'Fichier trop lourd (10 Mo maximum).' })
          flux.on('end', () => { if (!erreur) fichier = { buffer: Buffer.concat(morceaux), nom: String(info.filename ?? 'fichier').slice(0, 120), type: info.mimeType } })
        })
        bb.on('error', reject)
        bb.on('close', () => (erreur ? reject(new InvalidRequest({ message: erreur })) : resolve({ champs, fichier })))
        req.pipe(bb)
      })
    }

    router.post('/conversations/:id/messages', route(async (req, p) => {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !await peutVoir(db, p, req.params.id)) throw new ForbiddenError()
      const conv = await db('conversations').where('id', req.params.id).first()
      if (!p.plateforme && !p.locataire && conv.type !== 'support' && !await licenceOk(conv.agence)) throw new BusinessRuleError({ message: 'Licence non valide : le compte de votre entreprise est en lecture seule.' })
      const multipart = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')
      const { champs, fichier } = multipart ? await lireMultipart(req) : { champs: req.body ?? {}, fichier: null }
      const contenu = String(champs.contenu ?? '').trim().slice(0, 5000)
      if (!contenu && !fichier) throw new InvalidRequest({ message: 'Écrivez un message ou joignez un fichier.' })
      let piece = null
      if (fichier) {
        const { Readable } = await import('node:stream')
        piece = await new FilesService({ schema: await getSchema(), accountability: null }).uploadOne(Readable.from(fichier.buffer), {
          filename_download: fichier.nom, title: fichier.nom, type: fichier.type, storage: 'local',
        })
      }
      const maintenant = new Date(), id = randomUUID()
      await db('conversations_messages').insert({ id, conversation: conv.id, auteur: p.id, contenu: contenu || null, piece_jointe: piece, date_created: maintenant })
      await db('conversations').where('id', conv.id).update({ date_dernier_message: maintenant, extrait: (contenu || fichier.nom).slice(0, 200), statut: 'ouverte' })
      await marquerLu(db, conv.id, p.id)
      await envoyerNotifications(conv, { contenu: contenu || fichier?.nom }, p.id)
      return { id }
    }))

    router.post('/conversations/:id/statut', route(async (req, p) => {
      if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !await peutVoir(db, p, req.params.id)) throw new ForbiddenError()
      if (p.locataire) throw new ForbiddenError()
      if (!['ouverte', 'close'].includes(req.body?.statut)) throw new InvalidRequest({ message: 'Statut inconnu.' })
      await db('conversations').where('id', req.params.id).update({ statut: req.body.statut })
      return { id: req.params.id, statut: req.body.statut }
    }))

    router.get('/messages/:id/piece-jointe', route(async (req, p, res) => {
      const m = /^[0-9a-f-]{36}$/.test(req.params.id) ? await db('conversations_messages').where('id', req.params.id).first('conversation', 'piece_jointe') : null
      if (!m?.piece_jointe || !await peutVoir(db, p, m.conversation)) throw new ForbiddenError()
      const f = await db('directus_files').where('id', m.piece_jointe).first('filename_download', 'type')
      const { stream, stat } = await new AssetsService({ schema: await getSchema(), accountability: null }).getAsset(m.piece_jointe)
      res.setHeader('Content-Type', f.type ?? 'application/octet-stream')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(f.filename_download ?? 'fichier')}"`)
      res.setHeader('Cache-Control', 'private, no-store')
      stream.pipe(res)
    }))

    /** Notifications par e-mail, envoyées après la réponse. */
    async function envoyerNotifications(conv, message, auteur) {
      setImmediate(async () => {
        try {
          const ids = await destinataires(db, conv, auteur)
          const nom = (await auteurs(db, [auteur]))[auteur]?.nom ?? 'Gocleus Immo'
          await notifier(db, conv, message, nom, ids, { services, schema: await getSchema(), env, logger })
        } catch (err) { logger.error(err, 'gimmo-messagerie : notifications') }
      })
    }
  },
}
