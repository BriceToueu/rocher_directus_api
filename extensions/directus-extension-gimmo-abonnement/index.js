/**
 * G-immo — abonnements des entreprises (préfixe /abonnement). Voir lib/gimmo/abonnement.js et lib/gimmo/paiement.js.
 *
 * GET  /abonnement/public/offres?pays=          (public) offres actives et prix du pays (code ou identifiant)
 * GET  /abonnement                              état de l'abonnement, offres et prix, factures, paiements (administrateur
 *                                               et financier de l'entreprise)
 * POST /abonnement/paiements                    { offre, periodicite } → { reference, url } (administrateur d'entreprise)
 * GET  /abonnement/paiements/:reference         statut relu chez le fournisseur ; activation si réussi
 * POST /abonnement/notifications/:fournisseur   (public) notification relayée par le site : { brut (base64), type, entetes }
 * POST /abonnement/simulation/:reference        (public, mode simulation uniquement) { resultat: reussie | echouee }
 * GET  /abonnement/factures/:id/pdf             PDF d'une facture (entreprise concernée ou plateforme)
 * GET  /abonnement/plateforme                   paiements, factures, configuration (administrateur de la plateforme)
 * POST /abonnement/plateforme/factures/:id/annuler  { motif } (administrateur de la plateforme)
 */
import { createError, ForbiddenError } from '@directus/errors'
import { randomUUID } from 'node:crypto'
import { actualiserTransaction, contexteEntreprise, nouvelleReference, offresAvecPrix, PERIODICITES, prixAbonnement, regenererPdfFacture, assurerPdfFacture } from '../../lib/gimmo/abonnement.js'
import { configuration, creerPaiement, ErreurPaiement, FOURNISSEURS, jetonValide, lireNotification } from '../../lib/gimmo/paiement.js'
import { offreCourante, usage } from '../../lib/gimmo/saas.js'

const InvalidRequest = createError('INVALID_REQUEST', (ext) => ext.message, 400)
const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)
const PaiementError = createError('PAIEMENT_INDISPONIBLE', (ext) => ext.message, 502)

/** Corps form-urlencoded avec crochets (data[invoice][token]=…) → objet imbriqué. */
function lireFormulaire(texte) {
  const objet = {}
  for (const [cle, valeur] of new URLSearchParams(texte)) {
    const parties = cle.replace(/\]/g, '').split('[')
    let o = objet
    parties.forEach((p, i) => { if (i === parties.length - 1) o[p] = valeur; else o = (o[p] ??= {}) })
  }
  return objet
}

export default {
  id: 'abonnement',
  handler: (router, { services, getSchema, database: db, env, logger }) => {
    const { AssetsService } = services
    const route = (fn) => async (req, res, next) => { try { res.json({ data: await fn(req) }) } catch (error) { next(error) } }
    const site = () => String(env.GIMMO_SITE_URL ?? '').replace(/\/$/, '')
    const ctx = async () => ({ services, schema: await getSchema(), logger, env })

    /** Profil : entreprise et fonction de l'utilisateur connecté, ou plateforme. */
    async function profil(req) {
      if (!req.accountability?.user) throw new ForbiddenError()
      if (req.accountability.admin) return { plateforme: true }
      const u = await db('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', req.accountability.user).first('u.agence', 'r.name as role')
      if (u?.role === 'Administrator') return { plateforme: true }
      if (!u?.agence || !['Administrateur d’entreprise', 'Financier'].includes(u.role)) throw new ForbiddenError()
      return { agence: u.agence, administrateur: u.role === 'Administrateur d’entreprise', user: req.accountability.user }
    }

    const actualiser = async (reference, options) => actualiserTransaction(db, reference, await ctx(), options)

    const resumeTransaction = (t) => t && ({
      reference: t.reference, statut: t.statut, fournisseur: t.fournisseur, montant: Number(t.montant), periodicite: t.periodicite,
      offre: t.offre, date: t.date_created, date_reussite: t.date_reussite, licence: t.licence,
    })

    // ── Offres et prix publics (page Tarifs)
    router.get('/public/offres', route(async (req) => {
      const q = String(req.query.pays ?? '')
      const pays = await db('pays as p').leftJoin('devises as d', 'd.id', 'p.devise')
        .where(/^\d+$/.test(q) ? { 'p.id': Number(q) } : { 'p.code': q.toUpperCase() || 'CI' })
        .first('p.id', 'p.code', 'p.nom', 'p.taux_tva', 'd.code as devise', 'd.symbole', 'd.decimales')
      if (!pays) throw new InvalidRequest({ message: 'Pays inconnu.' })
      return { pays, offres: await offresAvecPrix(db, pays.id) }
    }))

    // ── Pays ouverts et leurs villes (inscription en libre-service)
    router.get('/public/pays', route(async () => {
      const pays = await db('pays').where('actif', true).orderBy([{ column: 'sort', order: 'asc' }, { column: 'nom', order: 'asc' }]).select('id', 'code', 'nom', 'indicatif_telephonique')
      const villes = await db('villes').whereIn('pays', pays.map(p => p.id)).orderBy('nom').select('id', 'nom', 'pays')
      return pays.map(p => ({ ...p, villes: villes.filter(v => v.pays === p.id).map(({ id, nom }) => ({ id, nom })) }))
    }))

    // ── Espace entreprise : état de l'abonnement
    router.get('/', route(async (req) => {
      const p = await profil(req)
      if (p.plateforme) throw new ForbiddenError()
      const e = await contexteEntreprise(db, p.agence)
      const a = await db('agences').where('id', p.agence).first('etat_licence', 'licence_fin', 'type_compte')
      const licences = await db('licences').where('agence', p.agence).orderBy('date_debut', 'desc').limit(24)
        .select('id', 'statut', 'periodicite', 'date_debut', 'date_fin', 'montant', 'offre')
      const factures = await db('factures').where('agence', p.agence).orderBy('date_emission', 'desc').orderBy('numero', 'desc').limit(100)
        .select('id', 'numero', 'statut', 'date_emission', 'libelle', 'periode_debut', 'periode_fin', 'montant_ht', 'montant_tva', 'montant_ttc', 'fichier_pdf')
      const paiements = await db('transactions_paiement').where('agence', p.agence).orderBy('date_created', 'desc').limit(20).select('*')
      const c = configuration(env)
      return {
        entreprise: { nom: e.nom, type_compte: a.type_compte, etat_licence: a.etat_licence, licence_fin: a.licence_fin, pays: e.pays_code, taux_tva: e.taux_tva != null ? Number(e.taux_tva) : null },
        devise: { code: e.devise_code, symbole: e.devise_symbole, decimales: e.devise_decimales },
        offre_courante: await offreCourante(db, p.agence), usage: await usage(db, p.agence),
        licences, factures: factures.map(f => ({ ...f, montant_ht: Number(f.montant_ht), montant_tva: Number(f.montant_tva), montant_ttc: Number(f.montant_ttc), pdf: !!f.fichier_pdf, fichier_pdf: undefined })),
        paiements: paiements.map(resumeTransaction),
        offres: await offresAvecPrix(db, e.pays),
        paiement: { fournisseur: c.code, simulation: c.code === 'simulation', configure: !c.manquantes.length },
        peut_payer: p.administrateur,
      }
    }))

    // ── Lancer un paiement
    router.post('/paiements', route(async (req) => {
      const p = await profil(req)
      if (!p.administrateur) throw new ForbiddenError()
      const periodicite = String(req.body?.periodicite ?? '')
      if (!PERIODICITES.includes(periodicite)) throw new InvalidRequest({ message: 'Choisissez une périodicité (mensuelle ou annuelle).' })
      const prix = await prixAbonnement(db, p.agence, req.body?.offre, periodicite)
      if (!prix) throw new BusinessRuleError({ message: 'Le prix de cette offre n’est pas encore disponible dans votre pays : contactez-nous.' })
      const offreLimite = prix.offre
      const u = await usage(db, p.agence)
      for (const [cle, max] of [['utilisateurs', offreLimite.max_utilisateurs], ['biens', offreLimite.max_biens], ['annonces', offreLimite.max_annonces]]) {
        if (max != null && u[cle] > max) throw new BusinessRuleError({ message: `L’offre ${offreLimite.nom} est limitée à ${max} ${cle} : vous en avez ${u[cle]}. Choisissez une offre supérieure.` })
      }
      const payeur = await db('directus_users').where('id', p.user).first('first_name', 'last_name', 'email', 'telephone')
      const reference = nouvelleReference()
      const id = randomUUID()
      const montant = prix.ttc
      await db('transactions_paiement').insert({
        id, reference, fournisseur: configuration(env).code, objet: 'licence', statut: 'initiee', montant, periodicite,
        agence: p.agence, offre: prix.offre.id, devise: prix.devise, payeur: p.user, date_created: new Date(), user_created: p.user,
      })
      const decimales = Number(prix.ctx.devise_decimales ?? 0)
      try {
        const r = await creerPaiement(env, {
          reference, montant: montant / 10 ** decimales, devise: prix.deviseCode ?? 'XOF', pays: prix.ctx.pays_code ?? 'CI', langue: req.body?.langue === 'en' ? 'en' : 'fr',
          description: `Gocleus Immo — ${prix.offre.nom} (${periodicite === 'annuel' ? '12 mois' : '1 mois'})`,
          client: { nom: [payeur?.first_name, payeur?.last_name].filter(Boolean).join(' ') || prix.ctx.nom, email: payeur?.email, telephone: payeur?.telephone ?? prix.ctx.telephone ?? null },
          urlRetour: `${site()}/administration-gocleus/abonnement?paiement=${reference}`,
          urlNotification: `${site()}/api/paiement/notification/${configuration(env).code}`,
          urlSimulation: `${site()}/paiement/simulation?reference=${reference}`,
        })
        await db('transactions_paiement').where({ id }).update({
          fournisseur: r.fournisseur, statut: 'en_attente', reference_fournisseur: r.referenceFournisseur, url_paiement: r.urlPaiement, jeton: r.jeton, details: JSON.stringify(r.details ?? {}),
        })
        return { reference, url: r.urlPaiement, montant, fournisseur: r.fournisseur }
      } catch (e) {
        await db('transactions_paiement').where({ id }).update({ statut: 'echouee', details: JSON.stringify({ erreur: e.message, ...(e.details ? { fournisseur: e.details } : {}) }) })
        logger.error(`gimmo-abonnement : paiement ${reference} non initialisé (${e.message})`)
        if (e instanceof ErreurPaiement) throw new PaiementError({ message: e.message.includes('.env') ? 'Le paiement en ligne n’est pas encore disponible. Contactez-nous pour régler votre abonnement.' : e.message })
        throw e
      }
    }))

    // ── Suivi d'un paiement (retour du fournisseur)
    router.get('/paiements/:reference', route(async (req) => {
      const p = await profil(req)
      const tx = await db('transactions_paiement').where('reference', String(req.params.reference)).first('agence')
      if (!tx || (!p.plateforme && tx.agence !== p.agence)) throw new ForbiddenError()
      const t = await actualiser(String(req.params.reference))
      const facture = t.statut === 'reussie' ? await db('factures').where('transaction', t.id).first('id', 'numero') : null
      return { ...resumeTransaction(t), facture }
    }))

    // ── Notifications des fournisseurs (relayées par le site public, corps brut conservé pour la signature)
    router.post('/notifications/:fournisseur', async (req, res) => {
      const fournisseur = String(req.params.fournisseur)
      try {
        if (!FOURNISSEURS.includes(fournisseur) || fournisseur === 'simulation') throw new ErreurPaiement('Fournisseur inconnu.')
        const brut = Buffer.from(String(req.body?.brut ?? ''), 'base64').toString('utf8')
        const entetes = Object.fromEntries(Object.entries(req.body?.entetes ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]))
        const corps = /json/i.test(String(req.body?.type ?? '')) ? JSON.parse(brut || '{}') : lireFormulaire(brut)
        const n = lireNotification(env, fournisseur, { brut, entetes, corps })
        const tx = n.reference
          ? await db('transactions_paiement').where({ reference: n.reference, fournisseur }).first('reference', 'jeton')
          : await db('transactions_paiement').where({ reference_fournisseur: n.referenceFournisseur, fournisseur }).first('reference', 'jeton')
        if (!tx) throw new ErreurPaiement('Transaction inconnue.')
        if (n.jeton != null && !jetonValide(tx.jeton, n.jeton)) throw new ErreurPaiement('Jeton de notification invalide.')
        const t = await actualiser(tx.reference)
        logger.info(`gimmo-abonnement : notification ${fournisseur} pour ${tx.reference} → ${t?.statut}`)
        res.json({ data: { ok: true } })
      } catch (e) {
        logger.warn(`gimmo-abonnement : notification ${fournisseur} rejetée (${e.message})`)
        res.status(400).json({ errors: [{ message: 'Notification rejetée.' }] })
      }
    })

    // ── Simulation (tant que les identifiants du fournisseur ne sont pas fournis)
    router.post('/simulation/:reference', route(async (req) => {
      if (configuration(env).code !== 'simulation') throw new ForbiddenError()
      const resultat = req.body?.resultat === 'reussie' ? 'reussie' : 'echouee'
      const tx = await db('transactions_paiement').where({ reference: String(req.params.reference), fournisseur: 'simulation' }).first('reference', 'statut')
      if (!tx || !['initiee', 'en_attente'].includes(tx.statut)) throw new ForbiddenError()
      const t = await actualiser(tx.reference, { simulation: resultat })
      return { statut: t.statut }
    }))
    router.get('/simulation/:reference', route(async (req) => {
      if (configuration(env).code !== 'simulation') throw new ForbiddenError()
      const t = await db('transactions_paiement as t').join('agences as a', 'a.id', 't.agence').leftJoin('offres as o', 'o.id', 't.offre').leftJoin('devises as d', 'd.id', 't.devise')
        .where({ 't.reference': String(req.params.reference), 't.fournisseur': 'simulation' })
        .first('t.reference', 't.statut', 't.montant', 't.periodicite', 'a.nom as entreprise', 'o.nom as offre', 'd.symbole', 'd.decimales')
      if (!t) throw new ForbiddenError()
      return { ...t, montant: Number(t.montant) }
    }))

    // ── PDF d'une facture
    router.get('/factures/:id/pdf', async (req, res, next) => {
      try {
        const p = await profil(req)
        const f = /^[0-9a-f-]{36}$/.test(req.params.id) ? await db('factures').where('id', req.params.id).first('id', 'agence', 'numero', 'fichier_pdf') : null
        if (!f || (!p.plateforme && f.agence !== p.agence)) throw new ForbiddenError()
        const fichier = f.fichier_pdf ?? await assurerPdfFacture(db, f.id, { FilesService: services.FilesService, schema: await getSchema() })
        const { stream, stat } = await new AssetsService({ schema: await getSchema(), accountability: null }).getAsset(fichier)
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="facture-${f.numero}.pdf"`)
        if (stat?.size) res.setHeader('Content-Length', stat.size)
        res.setHeader('Cache-Control', 'private, no-store')
        stream.pipe(res)
      } catch (error) {
        next(error)
      }
    })

    // ── Plateforme
    router.get('/plateforme', route(async (req) => {
      if (!(await profil(req)).plateforme) throw new ForbiddenError()
      const c = configuration(env)
      const transactions = await db('transactions_paiement as t').leftJoin('agences as a', 'a.id', 't.agence').leftJoin('offres as o', 'o.id', 't.offre')
        .orderBy('t.date_created', 'desc').limit(200).select('t.reference', 't.statut', 't.fournisseur', 't.montant', 't.periodicite', 't.date_created', 't.date_reussite', 'a.nom as entreprise', 'o.nom as offre', 't.devise')
      const factures = await db('factures as f').leftJoin('agences as a', 'a.id', 'f.agence').orderBy('f.date_emission', 'desc').orderBy('f.numero', 'desc').limit(200)
        .select('f.id', 'f.numero', 'f.statut', 'f.date_emission', 'f.libelle', 'f.montant_ttc', 'f.devise', 'a.nom as entreprise')
      const parametres = await db('parametres_plateforme').first('raison_sociale', 'adresse', 'rccm', 'compte_contribuable', 'email', 'telephone', 'prefixe_facture')
      const incomplets = Object.entries(parametres ?? {}).filter(([, v]) => !v || /^\[.*\]$/.test(String(v))).map(([k]) => k)
      return {
        paiement: { fournisseur: c.code, sandbox: c.sandbox, manquantes: c.manquantes },
        parametres_incomplets: incomplets,
        transactions: transactions.map(t => ({ ...t, montant: Number(t.montant) })),
        factures: factures.map(f => ({ ...f, montant_ttc: Number(f.montant_ttc) })),
      }
    }))

    router.post('/plateforme/factures/:id/annuler', route(async (req) => {
      if (!(await profil(req)).plateforme) throw new ForbiddenError()
      const motif = String(req.body?.motif ?? '').trim()
      if (motif.length < 5) throw new InvalidRequest({ message: 'Indiquez le motif de l’annulation.' })
      const f = /^[0-9a-f-]{36}$/.test(req.params.id) ? await db('factures').where('id', req.params.id).first('id', 'statut') : null
      if (!f) throw new ForbiddenError()
      if (f.statut === 'annulee') throw new BusinessRuleError({ message: 'Cette facture est déjà annulée.' })
      await db('factures').where('id', f.id).update({ statut: 'annulee', motif_annulation: motif.slice(0, 1000), date_updated: new Date() })
      await regenererPdfFacture(db, f.id, { FilesService: services.FilesService, schema: await getSchema() })
      return { id: f.id, statut: 'annulee' }
    }))
  },
}
