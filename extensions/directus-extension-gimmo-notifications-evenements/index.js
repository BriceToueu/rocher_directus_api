/**
 * G-immo — événements notifiés (cloche, e-mail, SMS selon les préférences). Voir lib/gimmo/notifications.js.
 *
 *  - demande de contact ou de réservation reçue (hors demandes d'estimation, notifiées à part) → direction et commerciaux
 *    de l'entreprise, et la personne à qui la demande est attribuée ;
 *  - signalement créé par un locataire ou un propriétaire → direction de l'entreprise qui gère le bien ;
 *  - quittance émise → le locataire, s'il a un espace en ligne ;
 *  - changement de statut d'une intervention → la personne qui l'a signalée, si elle a un espace en ligne ;
 *  - chaque nuit : notifications de plus de 90 jours supprimées.
 * Les notifications partent après la réponse : elles ne retardent ni ne font échouer l'action de l'utilisateur.
 */
import { destinatairesEntreprise, notifier } from '../../lib/gimmo/notifications.js'
import { tr } from '../../lib/gimmo/i18n.js'

const ROLES_ENTREPRISE = ['Administrateur d’entreprise', 'Manager', 'Financier', 'Commercial']
const STATUTS = { en_attente: 'en attente', planifie: 'planifiée', en_cours: 'en cours', resolu: 'terminée', annule: 'annulée' }
const OBJETS = { contact_annonce: 'une annonce', reservation_lot: 'la réservation d’un lot', publication_bien: 'la publication d’un bien' }

export default ({ action, schedule }, { database: db, services, getSchema, env, logger }) => {
  const plusTard = (fn) => setTimeout(async () => { try { await fn({ services, schema: await getSchema(), env, logger }) } catch (e) { logger.error(e, 'gimmo-notifications : événement non notifié') } }, 300)

  action('demandes.items.create', ({ key, payload }) => plusTard(async (ctx) => {
    const d = await db('demandes').where('id', key).first('agence', 'type', 'nom', 'assignee_a', 'annonce')
    if (!d?.agence || d.type === 'contact_estimation') return
    const titreAnnonce = d.annonce ? (await db('annonces').where('id', d.annonce).first('titre'))?.titre : null
    const ids = await destinatairesEntreprise(db, d.agence, ['Administrateur d’entreprise', 'Manager', 'Commercial'])
    if (d.assignee_a) ids.push(d.assignee_a)
    await notifier(db, ctx, {
      type: 'demande.nouvelle', utilisateurs: ids, agence: d.agence, lien: '/administration-gocleus/crm/demandes',
      titre: 'Nouvelle demande de {nom}',
      corps: titreAnnonce ? 'Bonjour,\n\n{nom} vous a envoyé une demande au sujet de « {annonce} ».' : 'Bonjour,\n\n{nom} vous a envoyé une demande concernant {objet}.',
      params: { nom: d.nom ?? payload?.nom ?? '—', annonce: titreAnnonce ?? '', objet: (L) => tr(L, OBJETS[d.type] ?? 'une annonce') },
    })
  }))

  action('tickets_maintenance.items.create', ({ key }, { accountability }) => plusTard(async (ctx) => {
    if (!accountability?.user) return
    const auteur = await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', accountability.user).first('r.name as role')
    if (ROLES_ENTREPRISE.includes(auteur?.role)) return // signalement saisi par l'agence elle-même
    const t = await db('tickets_maintenance as t').join('biens as b', 'b.id', 't.bien').where('t.id', key).first('t.titre', 't.reference', 'b.agence', 'b.titre as bien')
    if (!t?.agence) return
    await notifier(db, ctx, {
      type: 'maintenance.signalement', utilisateurs: await destinatairesEntreprise(db, t.agence, ['Administrateur d’entreprise', 'Manager']), agence: t.agence,
      lien: `/administration-gocleus/maintenance/${key}`,
      titre: 'Nouveau signalement : {titre}', corps: 'Bonjour,\n\nUn nouveau signalement a été déposé pour « {bien} » : {titre}.', params: { titre: t.titre ?? t.reference ?? '', bien: t.bien ?? '' },
    })
  }))

  action('tickets_maintenance.items.update', ({ keys, payload }) => {
    if (!payload?.statut) return
    plusTard(async (ctx) => {
      for (const key of keys) {
        const t = await db('tickets_maintenance as t').leftJoin('contacts as c', 'c.id', 't.signale_par').join('biens as b', 'b.id', 't.bien')
          .where('t.id', key).first('t.titre', 't.reference', 't.statut', 'c.utilisateur', 'b.agence')
        if (!t?.utilisateur) continue
        const role = (await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', t.utilisateur).first('r.name as role'))?.role
        await notifier(db, ctx, {
          type: 'maintenance.suivi', utilisateurs: [t.utilisateur], agence: t.agence,
          lien: role === 'Client' ? '/mon-compte?onglet=signalements' : '/administration-gocleus/espace-proprietaire',
          titre: 'Votre signalement « {titre} » : intervention {statut}', params: { titre: t.titre ?? t.reference ?? '', statut: (L) => tr(L, STATUTS[t.statut] ?? t.statut) },
        })
      }
    })
  })

  action('quittances.items.create', ({ payload }) => plusTard(async (ctx) => {
    if (!payload?.bail) return
    const b = await db('baux as b').join('contacts as c', 'c.id', 'b.locataire').leftJoin('biens as bi', 'bi.id', 'b.bien').where('b.id', payload.bail).first('c.utilisateur', 'bi.agence')
    if (!b?.utilisateur) return
    await notifier(db, ctx, {
      type: 'quittance.disponible', utilisateurs: [b.utilisateur], agence: b.agence, lien: '/mon-compte?onglet=quittances',
      titre: 'Votre quittance {numero} est disponible', params: { numero: payload.numero ?? '' },
    })
  }))

  schedule('45 2 * * *', async () => {
    const n = await db('notifications').where('date_created', '<', new Date(Date.now() - 90 * 86400000)).delete()
    if (n) logger.info(`gimmo-notifications : ${n} notification(s) de plus de 90 jours supprimée(s)`)
  })
}
