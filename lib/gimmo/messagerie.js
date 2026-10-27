/**
 * G-immo — messagerie : conversations agence ↔ locataire, internes à une entreprise, entreprise ↔ plateforme (support).
 *
 * Qui voit quoi (contrôlé ici, jamais par des permissions Directus directes) :
 *  - agence_locataire : le locataire (contact relié à son compte) ; l'administrateur, le manager et le financier de l'entreprise ;
 *  - interne          : les participants (employés de la même entreprise) ;
 *  - support          : l'administrateur et le manager de l'entreprise ; l'administrateur de la plateforme.
 * Chaque message est affiché avec le nom de son auteur et son rôle.
 */
import { preferencesDe } from './notifications.js'
import { envoyerSms } from './communication.js'
import { langueUtilisateur, tr } from './i18n.js'

export const ROLES_ENTREPRISE = ['Administrateur d’entreprise', 'Manager', 'Financier', 'Commercial']
const ROLES_LOCATAIRES = ['Administrateur d’entreprise', 'Manager', 'Financier']
const ROLES_SUPPORT = ['Administrateur d’entreprise', 'Manager']
const FONCTION = { 'Administrateur d’entreprise': 'administrateur', Manager: 'manager', Financier: 'financier', Commercial: 'commercial' }
export const TYPES = ['agence_locataire', 'interne', 'support']
const DELAI_NOTIFICATION = 30 * 60000

/** Profil de l'appelant : plateforme, employé d'entreprise ou locataire (contacts reliés à son compte). */
export async function profil(db, accountability) {
  if (!accountability?.user) return null
  const u = await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', accountability.user).first('u.id', 'u.agence', 'u.status', 'r.name as role')
  if (!u || u.status !== 'active') return null
  if (accountability.admin) return { id: u.id, plateforme: true }
  if (ROLES_ENTREPRISE.includes(u.role) && u.agence) return { id: u.id, agence: u.agence, role: u.role }
  if (u.role === 'Client') {
    const contacts = await db('contacts').where('utilisateur', u.id).select('id', 'agence')
    return { id: u.id, locataire: true, contacts: contacts.map(c => c.id), agences: [...new Set(contacts.map(c => c.agence))] }
  }
  return null
}

/** Conversations visibles par l'appelant (requête knex). */
export function visibles(db, p) {
  const q = db('conversations as c')
  if (p.plateforme) return q.where('c.type', 'support')
  if (p.locataire) return q.where('c.type', 'agence_locataire').whereIn('c.contact', p.contacts.length ? p.contacts : ['00000000-0000-0000-0000-000000000000'])
  return q.where(w => {
    if (ROLES_LOCATAIRES.includes(p.role)) w.orWhere(x => x.where('c.type', 'agence_locataire').where('c.agence', p.agence))
    if (ROLES_SUPPORT.includes(p.role)) w.orWhere(x => x.where('c.type', 'support').where('c.agence', p.agence))
    w.orWhere(x => x.where('c.type', 'interne').where('c.agence', p.agence)
      .whereIn('c.id', db('conversations_membres').where({ utilisateur: p.id, participant: true }).select('conversation')))
  })
}
export async function peutVoir(db, p, id) {
  return !!(await visibles(db, p).where('c.id', id).first('c.id'))
}

/** Nom affiché et rôle d'un utilisateur, vu par la messagerie. */
export async function auteurs(db, ids) {
  const liste = ids.length ? await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').leftJoin('agences as a', 'a.id', 'u.agence')
    .whereIn('u.id', ids).select('u.id', 'u.first_name', 'u.last_name', 'u.email', 'r.name as role', 'r.id as role_id', 'a.nom as agence') : []
  const admins = new Set(liste.length ? await adminsDe(db, liste.map(l => l.id)) : [])
  return Object.fromEntries(liste.map(u => [u.id, {
    nom: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    role: admins.has(u.id) ? 'plateforme' : u.role === 'Client' ? 'locataire' : FONCTION[u.role] ?? null,
    agence: admins.has(u.id) ? null : u.agence ?? null,
  }]))
}
/** Utilisateurs (parmi ids) qui administrent la plateforme (policy avec admin_access). */
async function adminsDe(db, ids) {
  return db('directus_users as u').join('directus_access as acc', function () { this.on('acc.role', 'u.role').orOn('acc.user', 'u.id') })
    .join('directus_policies as p', 'p.id', 'acc.policy').where('p.admin_access', true).whereIn('u.id', ids).distinct().pluck('u.id')
}
export async function adminsPlateforme(db) {
  return db('directus_users as u').join('directus_access as acc', function () { this.on('acc.role', 'u.role').orOn('acc.user', 'u.id') })
    .join('directus_policies as p', 'p.id', 'acc.policy').where('p.admin_access', true).where('u.status', 'active').distinct().pluck('u.id')
}

/** Destinataires d'un nouveau message (hors auteur). */
export async function destinataires(db, conv, auteur) {
  const membres = await db('conversations_membres').where('conversation', conv.id).select('utilisateur', 'participant')
  const staffAgence = (roles) => db('directus_users as u').join('directus_roles as r', 'r.id', 'u.role').where({ 'u.agence': conv.agence, 'u.status': 'active' }).whereIn('r.name', roles).pluck('u.id')
  let ids = []
  if (conv.type === 'interne') ids = membres.filter(m => m.participant).map(m => m.utilisateur)
  else if (conv.type === 'agence_locataire') {
    const locataire = (await db('contacts').where('id', conv.contact).first('utilisateur'))?.utilisateur
    if (auteur === locataire) {
      // l'agence : les employés qui suivent déjà la conversation, sinon administrateur et manager
      const staff = new Set(await staffAgence(ROLES_LOCATAIRES))
      ids = membres.map(m => m.utilisateur).filter(u => staff.has(u))
      if (!ids.length) ids = await staffAgence(ROLES_SUPPORT)
    } else ids = locataire ? [locataire] : []
  } else {
    const admins = new Set(await adminsPlateforme(db))
    if (admins.has(auteur)) {
      const staff = new Set(await staffAgence(ROLES_SUPPORT))
      ids = membres.map(m => m.utilisateur).filter(u => staff.has(u))
      if (!ids.length) ids = [...staff]
    } else {
      ids = membres.map(m => m.utilisateur).filter(u => admins.has(u))
      if (!ids.length) ids = [...admins]
    }
  }
  return [...new Set(ids)].filter(id => id && id !== auteur)
}

/** Marque la conversation lue par l'utilisateur jusqu'à maintenant. */
export async function marquerLu(db, conversation, utilisateur) {
  const m = await db('conversations_membres').where({ conversation, utilisateur }).first('id')
  if (m) await db('conversations_membres').where('id', m.id).update({ date_lecture: new Date() })
  else await db('conversations_membres').insert({ conversation, utilisateur, participant: false, date_lecture: new Date() })
}

/** Nombre de messages non lus par conversation (pour l'utilisateur). */
export async function nonLus(db, utilisateur, ids) {
  if (!ids.length) return {}
  const rows = await db('conversations_messages as m')
    .leftJoin('conversations_membres as cm', function () { this.on('cm.conversation', 'm.conversation').andOn('cm.utilisateur', db.raw('?', [utilisateur])) })
    .whereIn('m.conversation', ids).where(q => q.whereNull('m.auteur').orWhereNot('m.auteur', utilisateur))
    .where(q => q.whereNull('cm.date_lecture').orWhereRaw('m.date_created > cm.date_lecture'))
    .groupBy('m.conversation').select('m.conversation').count({ n: '*' })
  return Object.fromEntries(rows.map(r => [r.conversation, Number(r.n)]))
}

/** E-mail aux destinataires d'un message (au plus un toutes les 30 minutes par conversation et par personne). Ne lève jamais. */
export async function notifier(db, conv, message, auteurNom, ids, { services, schema, env, logger }) {
  const site = String(env.GIMMO_SITE_URL ?? '').replace(/\/$/, '')
  const admins = new Set(await adminsPlateforme(db))
  for (const id of ids) {
    try {
      const m = await db('conversations_membres').where({ conversation: conv.id, utilisateur: id }).first('id', 'date_notification', 'date_lecture')
      if (m?.date_notification && Date.now() - new Date(m.date_notification).getTime() < DELAI_NOTIFICATION) continue
      const u = await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', id).first('u.email', 'u.status', 'u.telephone', 'r.name as role')
      if (!u?.email || u.status !== 'active') continue
      // canaux choisis par la personne (préférences de notification « Nouveau message »)
      const pref = (await preferencesDe(db, id))['messagerie.message']
      if (!pref.email && !pref.sms) continue
      const L = await langueUtilisateur(db, id)
      const lien = admins.has(id) ? `${site}/administration-plateforme/support?c=${conv.id}`
        : u.role === 'Client' ? `${site}${L === 'en' ? '/en' : ''}/mon-compte?onglet=messages&c=${conv.id}`
          : `${site}/administration-gocleus/messagerie?c=${conv.id}`
      const extrait = String(message.contenu ?? '').trim().slice(0, 300) || tr(L, '(pièce jointe)')
      const sujet = tr(L, 'Nouveau message : {sujet}', { sujet: conv.sujet ?? '' })
      const corps = tr(L, 'Bonjour,\n\n{auteur} vous a écrit :\n\n« {extrait} »\n\nLire et répondre : {lien}', { auteur: auteurNom, extrait, lien })
      const echapper = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      if (pref.sms && u.telephone) await envoyerSms(env, u.telephone, `Gocleus Immo : ${sujet} ${lien}`.slice(0, 320), logger)
      if (pref.email) await new services.MailService({ schema, knex: db }).send({
        to: u.email, subject: sujet,
        template: { name: L === 'en' ? 'gimmo-message-en' : 'gimmo-message', data: { sujet, corps_html: echapper(corps).replace(/\n/g, '<br />'), agence: 'Gocleus Immo', telephone_agence: '', langue: L } },
      })
      if (m) await db('conversations_membres').where('id', m.id).update({ date_notification: new Date() })
      else await db('conversations_membres').insert({ conversation: conv.id, utilisateur: id, participant: false, date_notification: new Date() })
    } catch (err) { logger?.error(err, `gimmo-messagerie : notification de ${id} non envoyée`) }
  }
}
