/**
 * G-immo — notifications : cloche dans l'application, e-mail et SMS, selon les préférences de chaque utilisateur.
 *
 * Catalogue TYPES : chaque type d'événement a un libellé, les rôles concernés, ses canaux possibles et ses réglages
 * par défaut. Une ligne de preferences_notifications (utilisateur × type) remplace les réglages par défaut.
 * Les textes (titre, corps) sont en français avec parties variables {x} ; ils sont traduits dans la langue du
 * destinataire pour l'e-mail et le SMS, et à l'affichage pour la cloche.
 */
import { randomUUID } from 'node:crypto'
import { tr, langueUtilisateur } from './i18n.js'
import { envoyerSms } from './communication.js'

const ENTREPRISE_DIRECTION = ['Administrateur d’entreprise', 'Manager']
export const TYPES = {
  'demande.nouvelle': { libelle: 'Nouvelle demande de contact', description: 'Un visiteur vous contacte au sujet d’une annonce ou réserve un lot.', roles: [...ENTREPRISE_DIRECTION, 'Commercial'], canaux: ['application', 'email', 'sms'], defaut: { application: true, email: true, sms: false } },
  'maintenance.signalement': { libelle: 'Nouveau signalement', description: 'Un locataire ou un propriétaire signale un problème dans un logement.', roles: ENTREPRISE_DIRECTION, canaux: ['application', 'email', 'sms'], defaut: { application: true, email: true, sms: false } },
  'estimation.lead': { libelle: 'Demande d’estimation transmise', description: 'Un visiteur qui a estimé son bien souhaite être recontacté.', roles: ['Administrateur d’entreprise'], canaux: ['application', 'email', 'sms'], defaut: { application: true, email: true, sms: false } },
  'verification.resultat': { libelle: 'Vérification d’un bien', description: 'Badge « Vérifié » accordé, refusé ou retiré par la plateforme.', roles: ['Administrateur d’entreprise'], canaux: ['application', 'email'], defaut: { application: true, email: true, sms: false } },
  'publication.moderation': { libelle: 'Modération d’une publication', description: 'Une annonce ou un programme retiré du site, ou rétabli, par la plateforme.', roles: ['Administrateur d’entreprise'], canaux: ['application', 'email'], defaut: { application: true, email: true, sms: false } },
  'licence.rappel': { libelle: 'Échéance de l’abonnement', description: 'Rappels avant la fin de la licence, délai de grâce, lecture seule.', roles: ['Administrateur d’entreprise'], canaux: ['application', 'email', 'sms'], defaut: { application: true, email: true, sms: false } },
  'abonnement.facture': { libelle: 'Paiement et facture', description: 'Paiement de l’abonnement reçu, facture disponible.', roles: ['Administrateur d’entreprise'], canaux: ['application', 'email'], defaut: { application: true, email: true, sms: false } },
  'messagerie.message': { libelle: 'Nouveau message', description: 'Un nouveau message dans vos conversations (le compteur de la messagerie reste toujours visible).', roles: [...ENTREPRISE_DIRECTION, 'Financier', 'Commercial', 'Client', 'Administrator'], canaux: ['email', 'sms'], defaut: { application: false, email: true, sms: false } },
  'quittance.disponible': { libelle: 'Quittance disponible', description: 'Votre agence a émis la quittance d’un loyer payé.', roles: ['Client'], canaux: ['application', 'email', 'sms'], defaut: { application: true, email: false, sms: false } },
  'maintenance.suivi': { libelle: 'Suivi de vos signalements', description: 'Intervention planifiée, en cours ou terminée.', roles: ['Client', 'Propriétaire'], canaux: ['application', 'email', 'sms'], defaut: { application: true, email: true, sms: false } },
}

/** Types proposés à un utilisateur selon son rôle. */
export const typesPourRole = (role) => Object.entries(TYPES).filter(([, t]) => t.roles.includes(role)).map(([code]) => code)

/** Préférences effectives d'un utilisateur : { type: { application, email, sms } } (défauts du type complétés). */
export async function preferencesDe(db, utilisateur) {
  const lignes = await db('preferences_notifications').where({ utilisateur }).select('type', 'application', 'email', 'sms')
  const prefs = {}
  for (const [code, t] of Object.entries(TYPES)) {
    const l = lignes.find(x => x.type === code)
    prefs[code] = Object.fromEntries(['application', 'email', 'sms'].map(c => [c, t.canaux.includes(c) && (l ? !!l[c] : !!t.defaut[c])]))
  }
  return prefs
}

/** Enregistre les préférences d'un utilisateur (types et canaux non proposés ignorés). */
export async function enregistrerPreferences(db, utilisateur, role, choix) {
  const autorises = typesPourRole(role)
  for (const [code, v] of Object.entries(choix ?? {})) {
    if (!autorises.includes(code)) continue
    const t = TYPES[code]
    const ligne = Object.fromEntries(['application', 'email', 'sms'].map(c => [c, t.canaux.includes(c) ? !!v?.[c] : false]))
    const existe = await db('preferences_notifications').where({ utilisateur, type: code }).first('id')
    if (existe) await db('preferences_notifications').where('id', existe.id).update({ ...ligne, date_updated: new Date() })
    else await db('preferences_notifications').insert({ utilisateur, type: code, ...ligne, date_created: new Date() })
  }
}

/** Utilisateurs actifs d'une entreprise ayant l'un des rôles donnés. */
export async function destinatairesEntreprise(db, agence, roles) {
  return db('directus_users as u').join('directus_roles as r', 'r.id', 'u.role').where({ 'u.agence': agence, 'u.status': 'active' }).whereIn('r.name', roles).pluck('u.id')
}

const echapper = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]))

/**
 * Notifie des utilisateurs d'un événement, sur les canaux qu'ils ont choisis. Ne lève jamais ; renvoie le nombre de
 * destinataires atteints.
 *   type       code du catalogue TYPES
 *   titre      texte français (objet de l'e-mail, titre de la cloche, SMS) ; corps : texte français détaillé
 *   params     parties variables ; une valeur peut être une fonction (langue) => texte
 *   lien       chemin interne (ex. /administration-gocleus/crm) ; préfixé /en pour un client en anglais
 *   lienDansCorps : true si le corps contient déjà {lien} (le lien n'est alors pas ajouté à l'e-mail)
 */
export async function notifier(db, { services, schema, env, logger }, { type, utilisateurs, titre, corps = '', params = {}, lien = null, agence = null, lienDansCorps = false }) {
  const site = String(env?.GIMMO_SITE_URL ?? '').replace(/\/$/, '')
  let atteints = 0
  for (const id of [...new Set(utilisateurs ?? [])]) {
    try {
      const u = await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', id).first('u.email', 'u.status', 'u.telephone', 'r.name as role')
      if (!u || u.status !== 'active') continue
      const prefs = (await preferencesDe(db, id))[type] ?? TYPES[type]?.defaut ?? { application: true, email: true, sms: false }
      if (!prefs.application && !prefs.email && !prefs.sms) continue
      const L = await langueUtilisateur(db, id)
      const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'function' ? v(L) : v]))
      const chemin = lien && u.role === 'Client' && L === 'en' && !lien.startsWith('/administration') ? `/en${lien}` : lien
      const url = chemin ? `${site}${chemin}` : ''
      if (prefs.application) {
        await db('notifications').insert({ id: randomUUID(), utilisateur: id, agence, type, titre, corps: corps || null, params: JSON.stringify({ ...p, ...(lienDansCorps ? { lien: url } : {}) }), lien: chemin, date_created: new Date() })
      }
      if (prefs.email && u.email) {
        const sujet = tr(L, titre, p)
        let texte = tr(L, corps || titre, { ...p, lien: url })
        if (url && !lienDansCorps) texte += `\n\n${tr(L, 'Ouvrir : {lien}', { lien: url })}`
        await new services.MailService({ schema, knex: db }).send({
          to: u.email, subject: sujet,
          template: { name: L === 'en' ? 'gimmo-message-en' : 'gimmo-message', data: { sujet, corps_html: echapper(texte).replace(/\n/g, '<br />'), agence: 'Gocleus Immo', telephone_agence: '', langue: L } },
        })
      }
      if (prefs.sms && u.telephone) {
        await envoyerSms(env ?? {}, u.telephone, `Gocleus Immo : ${tr(L, titre, p)}${url ? ` ${url}` : ''}`.slice(0, 320), logger)
      }
      atteints++
    } catch (err) {
      logger?.error(err, `gimmo-notifications : « ${type} » non transmis à ${id}`)
    }
  }
  return atteints
}
