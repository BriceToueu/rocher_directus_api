/**
 * G-immo — endpoints métier. Préfixe : /gimmo. Tous s'exécutent avec les droits de l'appelant.
 *
 * POST /gimmo/reversements/generer   { annee: 2026, mois: 9, mandat?: "<uuid>" }
 *   Génère en brouillon les relevés de gérance de la période (voir lib/gimmo/releves.js).
 * GET  /gimmo/reversements/:id/pdf    PDF du relevé de gérance, si l'appelant peut lire le relevé.
 *
 * POST /gimmo/paiements               { echeance, montant, moyen_paiement, telephone_payeur?, reference_operateur?, date_paiement?, note? }
 * POST /gimmo/paiements/:id/annuler   { motif? }
 *   Enregistre / annule un paiement de loyer, puis met à jour l'échéance et émet (ou annule) la quittance avant de répondre.
 * GET  /gimmo/quittances/:id/pdf      PDF de la quittance, si l'appelant peut lire la quittance.
 *
 * GET  /gimmo/biens/:id/photos/:fichier?width=&height=   photo d'un bien que l'appelant peut lire (propriétaire…)
 * GET  /gimmo/documents/:id/fichier                       fichier d'un document que l'appelant peut lire
 *   Les fichiers Directus ne sont pas ouverts aux propriétaires : l'accès passe par l'élément qui les référence.
 *
 * POST /gimmo/analytics/estimation          { type_bien, ville, quartier?, surface, etat?, nb_chambres?, bien? } (back-office)
 * GET  /gimmo/analytics/synthese?agence=    synthèse d'une agence (direction et finance de l'entreprise, responsable pays, plateforme)
 * POST /gimmo/public/estimation             estimation anonyme du site public (même calcul, enregistrée « portail »)
 * POST /gimmo/public/estimation/:id/contact le visiteur demande à être recontacté : demandes « contact_estimation »
 *                                           pour les agences sous licence de sa ville
 *
 * GET  /gimmo/verification/synthese?agence=          indice de confiance des biens, pièces à contrôler / renouveler, identités
 * POST /gimmo/verification/:collection/:id/demander   demande du badge « Vérifié » (biens, programmes)
 * POST /gimmo/plateforme/verification                 décision de la plateforme (verifier, refuser, retirer)
 * POST /gimmo/plateforme/alertes/:id/traiter          alerte (titre foncier en doublon) traitée
 */
import { createError, ForbiddenError } from '@directus/errors'
import { appliquerEcheance, assurerPdfQuittance } from '../../lib/gimmo/loyers.js'
import { genererReleves, pdfReleve } from '../../lib/gimmo/releves.js'
import { creerEtEnvoyer, rendre, traiterAutomatisations, traiterFile, variablesDe } from '../../lib/gimmo/communication.js'
import { jetonValide, notifier as notifierEscrow, recalculer as recalculerEscrow } from '../../lib/gimmo/escrow.js'
import { nomContact } from '../../lib/gimmo/commun.js'
import { langueAgence, langueContact, memoriserLangue, tr } from '../../lib/gimmo/i18n.js'

const TYPE_BIEN_FR = { villa: 'Villa', maison: 'Maison', appartement: 'Appartement', studio: 'Studio', bureau: 'Bureau', local_commercial: 'Local commercial', terrain: 'Terrain' }
import { ETATS_ECRITURE, TYPES_COMPTE, emailAdministrateurs, offreCourante, rafraichirEtats as rafraichirEtatsLicence, usage as usageEntreprise } from '../../lib/gimmo/saas.js'
import { controleDemande, synthese as syntheseVerification } from '../../lib/gimmo/verification.js'
import { estimer, ligneEstimation, lireEntree, synthese as syntheseAnalytics } from '../../lib/gimmo/analytics.js'
import { ErreurComptable, contexteAgence, contrepasser, creerPiece, modifierBrouillon, supprimerBrouillon, validerPiece } from '../../lib/gimmo/comptabilite.js'

const InvalidRequest = createError('INVALID_REQUEST', (ext) => ext.message, 400)
const BusinessRuleError = createError('BUSINESS_RULE', (ext) => ext.message, 400)

/** Envoie un PDF (inline, ou en pièce jointe avec ?download=1). */
function envoyerPdf(req, res, buffer, filename) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(buffer)
}

/** Durée de l'essai gratuit d'une entreprise inscrite en libre-service. */
const DUREE_ESSAI_JOURS = 30

export default {
  id: 'gimmo',
  handler: (router, { services, getSchema, database, env, logger }) => {
    const { ItemsService, FilesService, AssetsService, UsersService } = services

    // ── Communication
    const CANAUX = ['email', 'sms', 'whatsapp']
    // POST /gimmo/messages/envoyer { contact, canal, contenu, sujet?, modele?, prospect?, echeance?, bail?, quittance?, lien? }
    router.post('/messages/envoyer', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const b = req.body ?? {}
        if (!CANAUX.includes(b.canal)) throw new InvalidRequest({ message: 'Canal invalide (email, sms ou whatsapp).' })
        if (!b.contact || !String(b.contenu ?? '').trim()) throw new InvalidRequest({ message: 'Indiquez le destinataire et le message.' })
        const schema = await getSchema()
        // le destinataire doit être dans le périmètre de l'appelant
        await new ItemsService('contacts', { schema, accountability: req.accountability }).readOne(b.contact, { fields: ['id'] })
        const r = await creerEtEnvoyer(database, {
          contact: b.contact, canal: b.canal, sujet: b.sujet ?? null, contenu: String(b.contenu).slice(0, 2000), modele: b.modele ?? null,
          prospect: b.prospect ?? null, echeance: b.echeance ?? null, bail: b.bail ?? null, quittance: b.quittance ?? null, lien: b.lien ?? null,
        }, { services, schema, env, logger }, req.accountability)
        res.json({ data: r })
      } catch (error) {
        next(error)
      }
    })

    // POST /gimmo/messages/apercu { contenu, sujet?, contact?, echeance?, bail?, quittance? } — rendu des variables
    router.post('/messages/apercu', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const b = req.body ?? {}
        const schema = await getSchema()
        if (b.contact) await new ItemsService('contacts', { schema, accountability: req.accountability }).readOne(b.contact, { fields: ['id'] })
        const vars = await variablesDe(database, { contact: b.contact, echeance: b.echeance, bail: b.bail, quittance: b.quittance })
        res.json({ data: { sujet: b.sujet ? rendre(b.sujet, vars) : null, contenu: rendre(b.contenu, vars) } })
      } catch (error) {
        next(error)
      }
    })

    // POST /gimmo/campagnes/:id/envoyer { contacts?: [] } — envoi d'une campagne à son segment (périmètre de l'appelant)
    router.post('/campagnes/:id/envoyer', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        const svc = (c) => new ItemsService(c, { schema, accountability: req.accountability })
        const camp = await svc('campagnes').readOne(req.params.id, { fields: ['id', 'nom', 'canal', 'segment', 'contenu', 'statut', 'agence', 'modele.id', 'modele.sujet'] })
        if (!['brouillon', 'planifiee'].includes(camp.statut)) throw new InvalidRequest({ message: 'Cette campagne a déjà été envoyée ou annulée.' })
        let destinataires = []
        if (camp.segment === 'tous_locataires') {
          const baux = await svc('baux').readByQuery({ filter: { statut: { _in: ['en_vigueur', 'litige'] }, bien: { agence: { _eq: camp.agence } } }, fields: ['locataire'], limit: -1 })
          destinataires = baux.map(b => b.locataire)
        } else if (camp.segment === 'locataires_en_retard') {
          const ech = await svc('echeances').readByQuery({ filter: { agence: { _eq: camp.agence }, statut: { _in: ['en_attente', 'partiel', 'en_retard'] }, date_echeance: { _lt: new Date().toISOString().slice(0, 10) }, bail: { _nnull: true } }, fields: ['bail.locataire'], limit: -1 })
          destinataires = ech.map(e => e.bail?.locataire)
        } else {
          const ids = Array.isArray(req.body?.contacts) ? req.body.contacts.slice(0, 500) : []
          destinataires = (await svc('contacts').readByQuery({ filter: { id: { _in: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] } }, fields: ['id'], limit: -1 })).map(c => c.id)
        }
        destinataires = [...new Set(destinataires.filter(Boolean))]
        await svc('campagnes').updateOne(camp.id, { statut: 'en_cours' })
        const bilan = { destinataires: destinataires.length, envoyes: 0, echecs: 0, sans_coordonnees: 0 }
        const ctx = { services, schema, env, logger }
        for (const contact of destinataires) {
          const c = await database('contacts').where('id', contact).first('email', 'telephone')
          if (camp.canal === 'email' ? !c?.email : !c?.telephone) { bilan.sans_coordonnees++; continue }
          const r = await creerEtEnvoyer(database, { contact, canal: camp.canal, sujet: camp.modele?.sujet ?? camp.nom, contenu: camp.contenu, modele: camp.modele?.id ?? null, campagne: camp.id }, ctx, req.accountability)
          r.statut === 'envoye' ? bilan.envoyes++ : bilan.echecs++
        }
        await svc('campagnes').updateOne(camp.id, { statut: 'envoyee', date_envoi: new Date().toISOString() })
        res.json({ data: bilan })
      } catch (error) {
        next(error)
      }
    })

    // POST /gimmo/communication/executer — traitement immédiat de la file et des relances du jour (personnel du back-office)
    router.post('/communication/executer', async (req, res, next) => {
      try {
        if (!req.accountability?.user || !req.accountability.app) throw new ForbiddenError()
        const ctx = { services, schema: await getSchema(), env, logger }
        const relances = await traiterAutomatisations(database, ctx)
        const file = await traiterFile(database, ctx)
        res.json({ data: { relances, file } })
      } catch (error) {
        next(error)
      }
    })

    // ── Relevés de gérance
    router.post('/reversements/generer', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const annee = Number(req.body?.annee)
        const mois = Number(req.body?.mois)
        if (!Number.isInteger(annee) || annee < 2000 || annee > 2100 || !Number.isInteger(mois) || mois < 1 || mois > 12) {
          throw new InvalidRequest({ message: 'Indiquez une année et un mois valides (ex. { "annee": 2026, "mois": 9 }).' })
        }
        const schema = await getSchema()
        const resultat = await genererReleves({ annee, mois, mandat: req.body?.mandat }, { ItemsService, schema, accountability: req.accountability, database })
        res.json({ data: { annee, mois, ...resultat } })
      } catch (error) {
        next(error)
      }
    })

    router.get('/reversements/:id/pdf', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        // lecture avec les droits de l'appelant (agence, ou propriétaire bénéficiaire)
        const r = await new ItemsService('reversements', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['id'] })
        const { buffer, numero } = await pdfReleve(database, r.id)
        envoyerPdf(req, res, buffer, `releve-gerance-${numero}.pdf`)
      } catch (error) {
        next(error)
      }
    })

    // ── Loyers
    const quittanceActive = async (echeance) => (await database('quittances').where({ echeance }).whereNot('statut', 'annulee').first('id'))?.id ?? null

    /** Réponse commune : paiement, statut de l'échéance et quittance (PDF prêt). */
    async function appliquerEtRepondre(res, schema, paiementId, echeanceId, quittanceAvant) {
      const r = await appliquerEcheance(database, echeanceId, { ItemsService, schema })
      if (r?.quittance) await assurerPdfQuittance(database, r.quittance.id, { FilesService, schema })
      const paiement = await database('paiements').where('id', paiementId).first('id', 'reference', 'statut', 'montant')
      res.json({ data: { paiement, echeance: { id: echeanceId, statut: r?.statut ?? null, paye: r?.paye ?? 0 }, quittance: r?.quittance ?? null, quittance_emise: !!r?.quittance && r.quittance.id !== quittanceAvant } })
    }

    router.post('/paiements', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const body = req.body ?? {}
        if (!body.echeance) throw new InvalidRequest({ message: 'Indiquez l’échéance réglée.' })
        const schema = await getSchema()
        // l'appelant doit pouvoir lire l'échéance (périmètre de son agence) avant tout contrôle métier
        await new ItemsService('echeances', { schema, accountability: req.accountability }).readOne(body.echeance, { fields: ['id'] })
        const quittanceAvant = await quittanceActive(body.echeance)
        const allowed = ['echeance', 'montant', 'moyen_paiement', 'telephone_payeur', 'reference_operateur', 'date_paiement', 'note', 'payeur', 'agence']
        const payload = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)))
        const id = await new ItemsService('paiements', { schema, accountability: req.accountability }).createOne({ ...payload, statut: 'confirme' })
        await appliquerEtRepondre(res, schema, id, body.echeance, quittanceAvant)
      } catch (error) {
        next(error)
      }
    })

    router.post('/paiements/:id/annuler', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        const svc = new ItemsService('paiements', { schema, accountability: req.accountability })
        const p = await svc.readOne(req.params.id, { fields: ['id', 'echeance', 'statut', 'note'] })
        if (p.statut !== 'confirme') throw new InvalidRequest({ message: 'Seul un paiement confirmé peut être annulé.' })
        const motif = String(req.body?.motif ?? '').trim().slice(0, 200)
        await svc.updateOne(p.id, { statut: 'annule', ...(motif ? { note: [p.note, `Annulé : ${motif}`].filter(Boolean).join(' · ').slice(0, 255) } : {}) })
        await appliquerEtRepondre(res, schema, p.id, p.echeance, await quittanceActive(p.echeance))
      } catch (error) {
        next(error)
      }
    })

    // ── Fichiers rattachés à un élément lisible par l'appelant
    async function envoyerFichier(req, res, schema, fileId, transformation, telechargement) {
      const { stream, file, stat } = await new AssetsService({ schema, accountability: null }).getAsset(fileId, transformation)
      res.setHeader('Content-Type', file.type ?? 'application/octet-stream')
      if (!transformation) res.setHeader('Content-Length', stat.size)
      if (telechargement) res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${String(file.filename_download ?? 'document').replace(/"/g, '')}"`)
      res.setHeader('Cache-Control', 'private, max-age=3600')
      stream.pipe(res)
    }

    router.get('/biens/:id/photos/:fichier', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        const bien = await new ItemsService('biens', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['photo_principale', 'photos.directus_files_id'] })
        const autorises = new Set([bien.photo_principale, ...(bien.photos ?? []).map(p => p.directus_files_id)].filter(Boolean))
        if (!autorises.has(req.params.fichier)) throw new ForbiddenError()
        const taille = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2000 ? n : undefined }
        const width = taille(req.query.width), height = taille(req.query.height)
        await envoyerFichier(req, res, schema, req.params.fichier, width || height ? { transformationParams: { width, height, fit: 'cover', quality: 80 } } : undefined, false)
      } catch (error) {
        next(error)
      }
    })

    // photo d'une annonce publiée : accessible aux visiteurs non connectés (politique Public), uniquement pour
    // les fichiers du bien de l'annonce
    router.get('/annonces/:id/photos/:fichier', async (req, res, next) => {
      try {
        const schema = await getSchema()
        const a = await new ItemsService('annonces', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['bien.photo_principale', 'bien.photos.directus_files_id'] })
        const autorises = new Set([a.bien?.photo_principale, ...(a.bien?.photos ?? []).map(p => p.directus_files_id)].filter(Boolean))
        if (!autorises.has(req.params.fichier)) throw new ForbiddenError()
        const taille = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2000 ? n : undefined }
        const width = taille(req.query.width), height = taille(req.query.height)
        await envoyerFichier(req, res, schema, req.params.fichier, width || height ? { transformationParams: { width, height, fit: 'cover', quality: 80 } } : undefined, false)
      } catch (error) {
        next(error)
      }
    })

    // fichier d'un programme publié (image, galerie, plan de masse, brochure, plans de lots) : accessible aux visiteurs
    router.get('/programmes/:id/fichiers/:fichier', async (req, res, next) => {
      try {
        const schema = await getSchema()
        const p = await new ItemsService('programmes', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['image_principale', 'plan_masse', 'brochure', 'photos.directus_files_id', 'lots.plan'] })
        const autorises = new Set([p.image_principale, p.plan_masse, p.brochure, ...(p.photos ?? []).map(x => x.directus_files_id), ...(p.lots ?? []).map(l => l.plan)].filter(Boolean))
        if (!autorises.has(req.params.fichier)) throw new ForbiddenError()
        const taille = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 2400 ? n : undefined }
        const width = taille(req.query.width), height = taille(req.query.height)
        await envoyerFichier(req, res, schema, req.params.fichier, width || height ? { transformationParams: { width, height, fit: req.query.fit === 'inside' ? 'inside' : 'cover', quality: 82 } } : undefined, req.params.fichier === p.brochure)
      } catch (error) {
        next(error)
      }
    })

    router.get('/documents/:id/fichier', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        const doc = await new ItemsService('documents', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['fichier'] })
        if (!doc.fichier) throw new ForbiddenError()
        await envoyerFichier(req, res, schema, doc.fichier, undefined, true)
      } catch (error) {
        next(error)
      }
    })

    // ── Comptabilité
    /** Agence comptable de l'appelant : policy « Comptabilité agence » (gestionnaire) ou administrateur (agence choisie). */
    async function agenceComptable(req, agenceChoisie) {
      const acc = req.accountability
      if (!acc?.user) throw new ForbiddenError()
      if (acc.admin) {
        if (!agenceChoisie) throw new InvalidRequest({ message: 'Choisissez l’agence.' })
        return agenceChoisie
      }
      const autorise = await database('directus_access as a').join('directus_policies as p', 'p.id', 'a.policy').where('p.name', 'Comptabilité agence')
        .where(q => { q.where('a.user', acc.user); if (acc.role) q.orWhere('a.role', acc.role) }).first('p.id')
      const agence = (await database('directus_users').where('id', acc.user).first('agence'))?.agence
      if (!autorise || !agence) throw new ForbiddenError()
      // écritures comptables hors ItemsService : la licence est vérifiée ici (gimmo-acces couvre les autres collections)
      const etat = (await database('agences').where('id', agence).first('etat_licence'))?.etat_licence
      if (!ETATS_ECRITURE.includes(etat)) throw new BusinessRuleError({ message: 'Licence non valide : le compte de votre entreprise est en lecture seule.' })
      return agence
    }
    /** Pièce existante, dans le périmètre comptable de l'appelant. */
    async function pieceDeLAppelant(req) {
      const piece = await database('pieces_comptables').where('id', req.params.id).first('id', 'agence', 'origine')
      if (!piece) throw new ForbiddenError()
      if (await agenceComptable(req, piece.agence) !== piece.agence) throw new ForbiddenError()
      return piece
    }
    /** Contrôle du corps d'une pièce : date, libellé, comptes du plan du pays, bien / tiers / prestataire de l'agence. */
    async function lirePiece(req, agence) {
      const b = req.body ?? {}
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? '')) || Number.isNaN(Date.parse(b.date))) throw new InvalidRequest({ message: 'Date de pièce invalide (AAAA-MM-JJ).' })
      const libelle = String(b.libelle ?? '').trim()
      if (!libelle) throw new InvalidRequest({ message: 'Le libellé est obligatoire.' })
      if (!Array.isArray(b.lignes) || b.lignes.length > 200) throw new InvalidRequest({ message: 'Lignes invalides.' })
      const ag = await contexteAgence(database, agence)
      const ids = (k) => [...new Set(b.lignes.map(l => l?.[k]).filter(v => v !== null && v !== undefined && v !== ''))]
      const comptes = ids('compte').map(Number)
      if (comptes.some(c => !Number.isInteger(c))) throw new InvalidRequest({ message: 'Compte invalide.' })
      const okComptes = await database('comptes_comptables').whereIn('id', comptes).where('actif', true).where(q => q.whereNull('pays').orWhere('pays', ag.pays)).pluck('id')
      if (okComptes.length !== comptes.length) throw new BusinessRuleError({ message: 'Un compte n’existe pas, est inactif ou n’appartient pas au plan comptable de votre pays.' })
      for (const [champ, table] of [['bien', 'biens'], ['tiers', 'contacts'], ['prestataire', 'prestataires']]) {
        const v = ids(champ)
        if (v.some(x => typeof x !== 'string')) throw new InvalidRequest({ message: `Référence « ${champ} » invalide.` })
        if (v.length && (await database(table).whereIn('id', v).where('agence', agence).pluck('id')).length !== v.length) throw new ForbiddenError()
      }
      const justificatif = b.piece_justificative ?? null
      if (justificatif) {
        if (typeof justificatif !== 'string') throw new InvalidRequest({ message: 'Pièce justificative invalide.' })
        if (!req.accountability.admin) await new ItemsService('directus_files', { schema: await getSchema(), accountability: req.accountability }).readOne(justificatif, { fields: ['id'] })
      }
      return {
        agence, devise: ag.devise, date: b.date, libelle: libelle.slice(0, 255), journal: b.journal ?? 'operations_diverses', piece_justificative: justificatif, user: req.accountability.user,
        lignes: b.lignes.map(l => ({ compte: Number(l.compte), debit: Number(l.debit ?? 0), credit: Number(l.credit ?? 0), libelle: l.libelle ? String(l.libelle).slice(0, 255) : null, bien: l.bien || null, tiers: l.tiers || null, prestataire: l.prestataire || null })),
      }
    }
    /** Opération comptable : les refus métier de la bibliothèque deviennent des erreurs BUSINESS_RULE. */
    const compta = (fn) => async (req, res, next) => {
      try {
        res.json({ data: await fn(req) })
      } catch (error) {
        next(error instanceof ErreurComptable ? new BusinessRuleError({ message: error.message }) : error)
      }
    }

    router.post('/comptabilite/pieces', compta(async (req) => {
      const agence = await agenceComptable(req, req.body?.agence)
      const p = await lirePiece(req, agence)
      return database.transaction(trx => creerPiece(trx, { ...p, origine: 'manuelle', statut: req.body?.statut === 'brouillon' ? 'brouillon' : 'validee' }))
    }))
    router.patch('/comptabilite/pieces/:id', compta(async (req) => {
      const piece = await pieceDeLAppelant(req)
      const p = await lirePiece(req, piece.agence)
      await database.transaction(trx => modifierBrouillon(trx, piece.id, p))
      return { id: piece.id }
    }))
    router.post('/comptabilite/pieces/:id/valider', compta(async (req) => {
      const piece = await pieceDeLAppelant(req)
      await database.transaction(trx => validerPiece(trx, piece.id, req.accountability.user))
      return { id: piece.id }
    }))
    router.post('/comptabilite/pieces/:id/contrepasser', compta(async (req) => {
      const piece = await pieceDeLAppelant(req)
      // une écriture automatique suit sa source : elle se corrige en modifiant ou annulant le paiement, le relevé ou le ticket
      if (piece.origine !== 'manuelle') throw new BusinessRuleError({ message: 'Écriture automatique : corrigez sa source (paiement, relevé ou intervention), la comptabilité suivra.' })
      const date = req.body?.date
      if (date !== undefined && date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new InvalidRequest({ message: 'Date invalide (AAAA-MM-JJ).' })
      const motif = req.body?.motif ? String(req.body.motif).slice(0, 120) : null
      return database.transaction(trx => contrepasser(trx, piece.id, { date: date ?? undefined, user: req.accountability.user, motif }))
    }))
    router.delete('/comptabilite/pieces/:id', compta(async (req) => {
      const piece = await pieceDeLAppelant(req)
      await database.transaction(trx => supprimerBrouillon(trx, piece.id))
      return { id: piece.id }
    }))

    // ── Séquestre (registre de l'agence) : opérations avec les droits de l'appelant, puis recalcul et notification des parties
    const ctxNotif = async () => ({ services, schema: await getSchema(), env, logger })
    const ETAT_ESCROW = ['id', 'reference', 'statut', 'montant', 'montant_recu', 'date_liberation', 'date_remboursement', 'date_litige', 'litige_par', 'motif_litige', 'resolution_litige']
    /** Opération d'agence sur un séquestre : périmètre vérifié par la lecture, règles par les hooks (ItemsService). */
    const escrow = (fn) => async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        const svc = (c) => new ItemsService(c, { schema, accountability: req.accountability })
        const t = await svc('transactions_escrow').readOne(req.params.id, { fields: ['id', 'statut', 'payeur', 'devise'] })
        const evenement = await fn(req, t, svc)
        await recalculerEscrow(database, t.id)
        res.json({ data: await database('transactions_escrow').where('id', t.id).first(ETAT_ESCROW) })
        // e-mails après la réponse : l'opération ne dépend pas de la messagerie (notifier ne lève jamais)
        if (evenement) ctxNotif().then(ctx => notifierEscrow(database, t.id, evenement.nom, evenement.extra, ctx))
      } catch (error) {
        next(error)
      }
    }
    const texte = (v, max, message) => { const s = String(v ?? '').trim(); if (!s) throw new InvalidRequest({ message }); return s.slice(0, max) }

    router.post('/escrow/:id/depots', escrow(async (req, t, svc) => {
      const b = req.body ?? {}
      const montant = Number(b.montant)
      if (!Number.isSafeInteger(montant) || montant <= 0) throw new InvalidRequest({ message: 'Montant du dépôt invalide.' })
      if (!b.moyen_paiement) throw new InvalidRequest({ message: 'Indiquez le moyen de paiement.' })
      await svc('paiements').createOne({
        transaction_escrow: t.id, montant, moyen_paiement: b.moyen_paiement, statut: 'confirme', payeur: t.payeur, devise: t.devise,
        date_paiement: b.date_paiement || new Date().toISOString(), telephone_payeur: b.telephone_payeur || null, reference_operateur: b.reference_operateur || null, note: b.note ? String(b.note).slice(0, 500) : null,
      })
      return { nom: 'depot', extra: { montant } }
    }))
    for (const action of ['valider', 'annuler']) {
      router.post(`/escrow/:id/etapes/:etape/${action}`, escrow(async (req, t, svc) => {
        const e = await svc('etapes_escrow').readOne(req.params.etape, { fields: ['id', 'transaction', 'libelle'] })
        if (e.transaction !== t.id) throw new ForbiddenError()
        await svc('etapes_escrow').updateOne(e.id, { terminee: action === 'valider' })
        return action === 'valider' ? { nom: 'etape', extra: { libelle: e.libelle } } : null
      }))
    }
    for (const [action, statut] of [['liberer', 'liberee'], ['rembourser', 'remboursee']]) {
      router.post(`/escrow/:id/${action}`, escrow(async (req, t, svc) => {
        const b = req.body ?? {}
        if (!b.moyen_sortie) throw new InvalidRequest({ message: 'Indiquez le moyen du versement.' })
        await svc('transactions_escrow').updateOne(t.id, { statut, moyen_sortie: b.moyen_sortie, reference_sortie: texte(b.reference_sortie, 120, 'Indiquez la référence du versement.') })
        return { nom: statut }
      }))
    }
    router.post('/escrow/:id/litige', escrow(async (req, t, svc) => {
      await svc('transactions_escrow').updateOne(t.id, { statut: 'litige', motif_litige: texte(req.body?.motif, 2000, 'Le motif du litige est obligatoire.') })
      return { nom: 'litige' }
    }))
    router.post('/escrow/:id/lever', escrow(async (req, t, svc) => {
      await svc('transactions_escrow').updateOne(t.id, { statut: 'en_cours', resolution_litige: texte(req.body?.resolution, 2000, 'Indiquez la décision prise pour lever le litige.') })
      return { nom: 'levee' }
    }))
    router.post('/escrow/:id/annuler', escrow(async (_req, t, svc) => {
      await svc('transactions_escrow').updateOne(t.id, { statut: 'annulee' })
      return { nom: 'annulee' }
    }))

    // Accès des parties par leur lien signé (sans compte) : consultation et signalement d'un litige
    async function escrowPublic(req) {
      const role = String(req.query.r ?? req.body?.r ?? '')
      const j = String(req.query.j ?? req.body?.j ?? '')
      if (!/^[0-9a-f-]{36}$/.test(req.params.id) || !jetonValide(env.SECRET, req.params.id, role, j)) throw new ForbiddenError()
      const t = await database('transactions_escrow').where('id', req.params.id).first()
      if (!t) throw new ForbiddenError()
      return { t, role }
    }
    router.get('/escrow/public/:id', async (req, res, next) => {
      try {
        const { t, role } = await escrowPublic(req)
        const [devise, etapes, agence, payeur, beneficiaire, bien, depots] = await Promise.all([
          database('devises').where('id', t.devise).first('code', 'symbole', 'decimales'),
          database('etapes_escrow').where('transaction', t.id).orderBy('ordre').select('libelle', 'ordre', 'terminee', 'date_validation'),
          database('agences').where('id', t.agence).first('nom', 'telephone', 'email'),
          database('contacts').where('id', t.payeur).first('prenom', 'nom', 'raison_sociale'),
          database('contacts').where('id', t.beneficiaire).first('prenom', 'nom', 'raison_sociale'),
          t.bien ? database('biens as b').leftJoin('villes as v', 'v.id', 'b.ville').leftJoin('quartiers as q', 'q.id', 'b.quartier').where('b.id', t.bien).first('b.titre', 'v.nom as ville', 'q.nom as quartier') : null,
          database('paiements').where({ transaction_escrow: t.id, statut: 'confirme' }).orderBy('date_paiement').select('montant', 'date_paiement'),
        ])
        res.setHeader('Cache-Control', 'private, no-store')
        res.json({ data: {
          role, reference: t.reference, titre: t.titre, type: t.type, statut: t.statut, montant: Number(t.montant), montant_recu: Number(t.montant_recu), devise,
          date_creation: t.date_created, date_litige: t.date_litige, litige_par: t.litige_par, motif_litige: t.motif_litige, resolution_litige: t.resolution_litige,
          date_liberation: t.date_liberation, date_remboursement: t.date_remboursement,
          payeur: nomContact(payeur), beneficiaire: nomContact(beneficiaire), bien, agence, etapes, depots: depots.map(d => ({ montant: Number(d.montant), date: d.date_paiement })),
        } })
      } catch (error) {
        next(error)
      }
    })
    router.post('/escrow/public/:id/litige', async (req, res, next) => {
      try {
        const { t, role } = await escrowPublic(req)
        const motif = texte(req.body?.motif, 2000, 'Décrivez le problème rencontré.')
        if (!['en_cours', 'a_valider'].includes(t.statut)) throw new BusinessRuleError({ message: t.statut === 'litige' ? 'Un litige est déjà en cours : l’agence vous recontactera.' : 'Ce séquestre est clos.' })
        // sans utilisateur : les règles du hook s'appliquent, le signalement est attribué à la partie authentifiée par son lien
        await new ItemsService('transactions_escrow', { schema: await getSchema(), accountability: null }).updateOne(t.id, { statut: 'litige', motif_litige: `${role === 'payeur' ? 'Payeur' : 'Bénéficiaire'} : ${motif}`, litige_par: role })
        res.json({ data: { statut: 'litige' } })
        ctxNotif().then(ctx => notifierEscrow(database, t.id, 'litige', null, ctx))
      } catch (error) {
        next(error)
      }
    })

    // ── Équipe d'une entreprise : l'Administrateur d'entreprise (ou l'administrateur de la plateforme) gère les utilisateurs
    const ROLES_ENTREPRISE = { administrateur: 'Administrateur d’entreprise', manager: 'Manager', financier: 'Financier', commercial: 'Commercial' }
    const roleIds = async () => Object.fromEntries((await database('directus_roles').whereIn('name', Object.values(ROLES_ENTREPRISE)).select('id', 'name'))
      .map(r => [Object.keys(ROLES_ENTREPRISE).find(k => ROLES_ENTREPRISE[k] === r.name), r.id]))
    /** Agence gérée par l'appelant : la sienne s'il est Administrateur d'entreprise ; celle demandée s'il administre la plateforme. */
    async function agenceEquipe(req, demandee) {
      const acc = req.accountability
      if (!acc?.user) throw new ForbiddenError()
      if (acc.admin) {
        if (!demandee || !await database('agences').where('id', demandee).first('id')) throw new InvalidRequest({ message: 'Choisissez le compte entreprise.' })
        return demandee
      }
      const ids = await roleIds()
      const u = await database('directus_users').where('id', acc.user).first('agence', 'role')
      if (!u?.agence || u.role !== ids.administrateur) throw new ForbiddenError()
      return u.agence
    }
    const membre = async (agence, id) => {
      const ids = Object.values(await roleIds())
      const u = await database('directus_users').where({ id, agence }).first('id', 'role', 'status', 'email')
      if (!u || !ids.includes(u.role)) throw new ForbiddenError()
      return u
    }
    const nomRole = async (roleId) => Object.entries(await roleIds()).find(([, id]) => id === roleId)?.[0] ?? null
    const administrateursActifs = async (agence, sauf = null) => {
      const { administrateur } = await roleIds()
      return Number((await database('directus_users').where({ agence, role: administrateur }).whereIn('status', ['active', 'invited']).modify(q => { if (sauf) q.whereNot('id', sauf) }).count({ n: '*' }).first())?.n ?? 0)
    }

    router.get('/equipe', async (req, res, next) => {
      try {
        const agence = await agenceEquipe(req, req.query.agence)
        const ids = await roleIds()
        const membres = await database('directus_users').where({ agence }).whereIn('role', Object.values(ids))
          .orderBy(['last_name', 'first_name']).select('id', 'first_name', 'last_name', 'email', 'telephone', 'role', 'status', 'last_access')
        const [offre, u, a] = await Promise.all([offreCourante(database, agence), usageEntreprise(database, agence), database('agences').where('id', agence).first('nom', 'type_compte', 'etat_licence', 'licence_fin')])
        res.json({ data: {
          agence: a, offre, usage: u,
          membres: membres.map(m => ({ ...m, role: Object.keys(ids).find(k => ids[k] === m.role), moi: m.id === req.accountability.user })),
        } })
      } catch (error) {
        next(error)
      }
    })

    /** Invite un membre dans une entreprise (rôle d'entreprise, limite d'utilisateurs de l'offre, e-mail unique). */
    async function inviterMembre(agence, b, { controlerLicence = true } = {}) {
      const email = String(b.email ?? '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidRequest({ message: 'Adresse e-mail invalide.' })
      const ids = await roleIds()
      if (!ids[b.role]) throw new InvalidRequest({ message: 'Rôle inconnu (administrateur, manager, financier ou commercial).' })
      const etat = (await database('agences').where('id', agence).first('etat_licence'))?.etat_licence
      if (controlerLicence && !ETATS_ECRITURE.includes(etat)) throw new BusinessRuleError({ message: 'Licence non valide : le compte de votre entreprise est en lecture seule.' })
      const offre = await offreCourante(database, agence)
      if (offre?.max_utilisateurs != null && (await usageEntreprise(database, agence)).utilisateurs >= offre.max_utilisateurs) {
        throw new BusinessRuleError({ message: `Votre offre ${offre.nom} est limitée à ${offre.max_utilisateurs} utilisateurs : désactivez un compte ou passez à une offre supérieure.` })
      }
      if (await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id')) throw new BusinessRuleError({ message: 'Un compte existe déjà avec cette adresse e-mail.' })
      const users = new UsersService({ schema: await getSchema(), accountability: null })
      // e-mail d'invitation et profil dans la langue du pays de l'entreprise (modifiable ensuite par la personne)
      const langue = await langueAgence(database, agence)
      memoriserLangue(email, langue)
      await users.inviteUser(email, ids[b.role], `${String(env.GIMMO_SITE_URL ?? '').replace(/\/$/, '')}/administration-gocleus/invitation`)
      const cree = await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id')
      await users.updateOne(cree.id, {
        agence, language: langue === 'en' ? 'en-US' : 'fr-FR', first_name: String(b.prenom ?? '').trim().slice(0, 50) || null, last_name: String(b.nom ?? '').trim().slice(0, 50) || null,
        telephone: /^\+[1-9]\d{6,14}$/.test(String(b.telephone ?? '')) ? b.telephone : null,
      })
      return { id: cree.id, email, role: b.role, status: 'invited' }
    }

    router.post('/equipe/inviter', async (req, res, next) => {
      try {
        const agence = await agenceEquipe(req, req.body?.agence)
        // l'administrateur de la plateforme peut inviter même hors licence (mise en place d'un compte)
        res.json({ data: await inviterMembre(agence, req.body ?? {}, { controlerLicence: !req.accountability.admin }) })
      } catch (error) {
        next(error)
      }
    })

    router.patch('/equipe/:id', async (req, res, next) => {
      try {
        const b = req.body ?? {}
        const agence = await agenceEquipe(req, b.agence)
        const u = await membre(agence, req.params.id)
        if (u.id === req.accountability.user) throw new BusinessRuleError({ message: 'Vous ne pouvez pas modifier votre propre rôle ni désactiver votre compte.' })
        const ids = await roleIds()
        const maj = {}
        if (b.role !== undefined) {
          if (!ids[b.role]) throw new InvalidRequest({ message: 'Rôle inconnu.' })
          maj.role = ids[b.role]
        }
        if (b.status !== undefined) {
          if (!['active', 'suspended'].includes(b.status)) throw new InvalidRequest({ message: 'Statut invalide (active ou suspended).' })
          if (b.status === 'active' && u.status === 'invited') throw new BusinessRuleError({ message: 'Invitation en attente : la personne doit d’abord l’accepter.' })
          maj.status = b.status
        }
        const resteAdmin = (await nomRole(u.role)) === 'administrateur' && ((maj.role && maj.role !== ids.administrateur) || maj.status === 'suspended')
        if (resteAdmin && await administrateursActifs(agence, u.id) === 0) throw new BusinessRuleError({ message: 'L’entreprise doit garder au moins un administrateur actif.' })
        if (maj.status === 'active') {
          const offre = await offreCourante(database, agence)
          if (u.status === 'suspended' && offre?.max_utilisateurs != null && (await usageEntreprise(database, agence)).utilisateurs >= offre.max_utilisateurs) {
            throw new BusinessRuleError({ message: `Votre offre ${offre.nom} est limitée à ${offre.max_utilisateurs} utilisateurs.` })
          }
        }
        if (Object.keys(maj).length) await new UsersService({ schema: await getSchema(), accountability: null }).updateOne(u.id, maj)
        res.json({ data: { id: u.id, role: maj.role ? b.role : await nomRole(u.role), status: maj.status ?? u.status } })
      } catch (error) {
        next(error)
      }
    })

    // ── Console de la plateforme (administrateur du SaaS uniquement)
    const plateforme = (fn) => async (req, res, next) => {
      try {
        if (!req.accountability?.user || !req.accountability.admin) throw new ForbiddenError()
        res.json({ data: await fn(req) })
      } catch (error) {
        next(error)
      }
    }

    // Synthèse : comptes par état / type / pays, échéances à 30 jours, revenus encaissés sur 12 mois, revenu mensuel récurrent
    router.get('/plateforme/synthese', plateforme(async () => {
      const today = new Date().toISOString().slice(0, 10)
      const dans30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
      const debut12 = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11, 1)).toISOString().slice(0, 10)
      const n = (rows, k) => rows.map(r => ({ cle: r[k], n: Number(r.n) }))
      const [parEtat, parType, parPays, echeances, encaisse, actives, roles, annonces, programmes] = await Promise.all([
        database('agences').groupBy('etat_licence').select('etat_licence').count({ n: '*' }),
        database('agences').groupBy('type_compte').select('type_compte').count({ n: '*' }),
        database('agences as a').join('pays as p', 'p.id', 'a.pays').groupBy('p.code', 'p.nom').select('p.code', 'p.nom').count({ n: '*' }),
        database('agences as a').leftJoin('pays as p', 'p.id', 'a.pays').whereBetween('a.licence_fin', [today, dans30]).whereIn('a.etat_licence', ['essai', 'active']).orderBy('a.licence_fin')
          .select('a.id', 'a.nom', 'a.licence_fin', 'a.etat_licence', 'p.nom as pays'),
        database('paiements_licences as pl').join('licences as l', 'l.id', 'pl.licence').leftJoin('devises as d', 'd.id', 'l.devise').where('pl.date_paiement', '>=', debut12)
          .select('pl.date_paiement', 'pl.montant', 'd.code', 'd.symbole', 'd.decimales'),
        database('licences as l').leftJoin('devises as d', 'd.id', 'l.devise').where('l.statut', 'active').where('l.date_debut', '<=', today).where('l.date_fin', '>=', today)
          .select('l.montant', 'l.periodicite', 'd.code', 'd.symbole', 'd.decimales'),
        database('directus_users as u').join('directus_roles as r', 'r.id', 'u.role').whereNot('u.status', 'archived').groupBy('r.name').select('r.name').count({ n: '*' }),
        database('annonces').where('statut', 'publiee').count({ n: '*' }).first(),
        database('programmes').where('statut_publication', 'publie').count({ n: '*' }).first(),
      ])
      // montants par devise (un pays = une devise)
      const devises = {}
      const parDevise = (d) => (devises[d.code] ??= { devise: { code: d.code, symbole: d.symbole, decimales: d.decimales }, mrr: 0, mois: {} })
      for (const l of actives) if (l.code) parDevise(l).mrr += Math.round(Number(l.montant) / (l.periodicite === 'annuel' ? 12 : 1))
      for (const p of encaisse) if (p.code) { const m = String(p.date_paiement instanceof Date ? p.date_paiement.toISOString() : p.date_paiement).slice(0, 7); const e = parDevise(p); e.mois[m] = (e.mois[m] ?? 0) + Number(p.montant) }
      return {
        comptes: { parEtat: n(parEtat, 'etat_licence'), parType: n(parType, 'type_compte'), parPays: parPays.map(r => ({ code: r.code, nom: r.nom, n: Number(r.n) })) },
        echeances: echeances.map(e => ({ ...e, licence_fin: e.licence_fin instanceof Date ? e.licence_fin.toISOString().slice(0, 10) : e.licence_fin })),
        finances: Object.values(devises),
        utilisateurs: roles.map(r => ({ role: r.name, n: Number(r.n) })),
        publications: { annonces: Number(annonces?.n ?? 0), programmes: Number(programmes?.n ?? 0) },
        verification: {
          demandes: Number((await database('biens').where('statut_verification', 'demandee').count({ n: '*' }).first())?.n ?? 0)
            + Number((await database('programmes').where('statut_verification', 'demandee').count({ n: '*' }).first())?.n ?? 0),
          alertes: Number((await database('alertes_plateforme').where('statut', 'ouverte').count({ n: '*' }).first())?.n ?? 0),
        },
      }
    }))

    // Création d'un compte entreprise : compte, (fiche promoteur), licence, invitation du premier administrateur
    router.post('/plateforme/entreprises', plateforme(async (req) => creerEntreprise(req.body ?? {}, req.accountability)))

    /**
     * Création d'un compte entreprise complet (entreprise, promoteur éventuel, licence, invitation de l'administrateur) ;
     * rien de partiel en cas d'erreur. Utilisée par la plateforme et par l'inscription en libre-service (essai gratuit).
     */
    async function creerEntreprise({ entreprise: e = {}, licence: l = {}, administrateur: adm = {} }, accountability) {
      const schema = await getSchema()
      const svc = (c) => new ItemsService(c, { schema, accountability })
      if (!String(e.nom ?? '').trim() || !e.pays || !e.type_compte) throw new InvalidRequest({ message: 'Indiquez le nom, le pays et le type du compte.' })
      if (!l.offre || !l.date_debut || !l.date_fin) throw new InvalidRequest({ message: 'Indiquez l’offre et la période de la licence.' })
      const email = String(adm.email ?? '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidRequest({ message: 'Adresse e-mail de l’administrateur invalide.' })
      if (await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id')) throw new BusinessRuleError({ message: 'Un compte existe déjà avec l’adresse e-mail de l’administrateur.' })
      let promoteur = e.promoteur ?? null
      const crees = []
      try {
        if (e.type_compte === 'promoteur_independant' && !promoteur) {
          const nom = String(e.nom).trim()
          const slug = nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'promoteur'
          promoteur = await svc('promoteurs').createOne({ raison_sociale: nom, slug: (await database('promoteurs').where('slug', slug).first('id')) ? `${slug}-${Date.now().toString(36)}` : slug, statut: 'actif', certifie: false, telephone: e.telephone ?? null, email: e.email ?? null })
          crees.push(['promoteurs', promoteur])
        }
        const agence = await svc('agences').createOne({
          nom: String(e.nom).trim(), type_compte: e.type_compte, pays: e.pays, ville: e.ville ?? null, telephone: e.telephone ?? null, email: e.email ?? null,
          adresse: e.adresse ?? null, actif: true, promoteur: e.type_compte === 'promoteur_independant' ? promoteur : null,
        })
        crees.push(['agences', agence])
        const licence = await svc('licences').createOne({ agence, offre: l.offre, statut: l.statut === 'essai' ? 'essai' : 'active', periodicite: l.periodicite ?? (l.statut === 'essai' ? 'essai' : 'mensuel'), date_debut: l.date_debut, date_fin: l.date_fin, ...(l.montant != null ? { montant: l.montant } : {}), notes: l.notes ?? null })
        crees.push(['licences', licence])
        await rafraichirEtatsLicence(database, [agence])
        const membre = await inviterMembre(agence, { ...adm, email, role: 'administrateur' }, { controlerLicence: false })
        return { agence, licence, promoteur, administrateur: membre }
      } catch (error) {
        // rien de partiel : on défait ce qui a été créé (ordre inverse)
        for (const [c, id] of crees.reverse()) await database(c).where('id', id).delete().catch(() => {})
        throw error
      }
    }

    // Réinitialisation du mot de passe d'un utilisateur (e-mail avec lien)
    router.post('/plateforme/utilisateurs/:id/reinitialiser', plateforme(async (req) => {
      const u = await database('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', req.params.id).first('u.email', 'u.status', 'r.name as role')
      if (!u) throw new ForbiddenError()
      if (u.status !== 'active') throw new BusinessRuleError({ message: 'Seul un compte actif peut réinitialiser son mot de passe.' })
      const site = String(env.GIMMO_SITE_URL ?? '').replace(/\/$/, '')
      await new UsersService({ schema: await getSchema(), accountability: null }).requestPasswordReset(u.email, u.role === 'Client' ? `${site}/reinitialiser-mot-de-passe` : `${site}/administration-gocleus/reinitialiser-mot-de-passe`)
      return { email: u.email }
    }))

    // Modération a posteriori : retrait d'une annonce ou d'un programme du site public, ou levée du retrait
    router.post('/plateforme/moderation', plateforme(async (req) => {
      const { collection, id, action, motif } = req.body ?? {}
      if (!['annonces', 'programmes'].includes(collection) || typeof id !== 'string') throw new InvalidRequest({ message: 'Publication invalide.' })
      const item = await database(collection).where('id', id).first('id', 'agence', collection === 'annonces' ? 'titre' : 'nom', collection === 'annonces' ? 'statut' : 'statut_publication', 'retire_par_plateforme')
      if (!item) throw new ForbiddenError()
      const titre = item.titre ?? item.nom
      const svc = new ItemsService(collection, { schema: await getSchema(), accountability: null })
      if (action === 'retirer') {
        const m = String(motif ?? '').trim()
        if (m.length < 5) throw new InvalidRequest({ message: 'Indiquez le motif du retrait (il est transmis à l’entreprise).' })
        const statut = collection === 'annonces' ? (item.statut === 'publiee' ? { statut: 'suspendue' } : {}) : (item.statut_publication === 'publie' ? { statut_publication: 'brouillon' } : {})
        await svc.updateOne(id, { ...statut, retire_par_plateforme: true, motif_moderation: m.slice(0, 1000), date_moderation: new Date().toISOString() })
        await emailAdministrateurs(database, item.agence, 'Publication retirée : {titre}', 'Bonjour,\n\n« {titre} » a été retiré du site public par l’administrateur de la plateforme.\nMotif : {motif}\n\nContactez-nous pour le rétablir une fois le problème corrigé.', { services, schema: await getSchema(), logger, env }, { titre, motif: m }, { type: 'publication.moderation', lien: collection === 'annonces' ? '/administration-gocleus/marketplace' : '/administration-gocleus/promoteurs' })
        return { id, retire: true }
      }
      if (action === 'retablir') {
        await svc.updateOne(id, { retire_par_plateforme: false, motif_moderation: null, date_moderation: null })
        await emailAdministrateurs(database, item.agence, 'Publication rétablie : {titre}', 'Bonjour,\n\nLe retrait de « {titre} » a été levé : vous pouvez de nouveau la publier.', { services, schema: await getSchema(), logger, env }, { titre }, { type: 'publication.moderation', lien: collection === 'annonces' ? '/administration-gocleus/marketplace' : '/administration-gocleus/promoteurs' })
        return { id, retire: false }
      }
      throw new InvalidRequest({ message: 'Action inconnue (retirer ou retablir).' })
    }))

    // ── Analytics : estimation par comparables (marché de la plateforme, agrégats seulement) et synthèse d'agence
    const ROLES_DIRECTION = ['Administrateur d’entreprise', 'Manager', 'Financier']
    const ROLES_BACK_OFFICE = [...ROLES_DIRECTION, 'Commercial', 'Responsable pays']
    const profil = async (acc) => database('directus_users as u').leftJoin('directus_roles as r', 'r.id', 'u.role').where('u.id', acc.user).first('u.agence', 'u.pays', 'r.name as role')
    /** Agence analysée : la sienne (direction, finance) ; une agence de son pays (responsable pays) ; au choix (plateforme). */
    async function agenceAnalytics(req, demandee) {
      const acc = req.accountability
      if (!acc?.user) throw new ForbiddenError()
      if (acc.admin) {
        if (!demandee || !await database('agences').where('id', demandee).first('id')) throw new InvalidRequest({ message: 'Choisissez le compte entreprise.' })
        return demandee
      }
      const u = await profil(acc)
      if (u?.role === 'Responsable pays') {
        const a = demandee ? await database('agences').where({ id: demandee, pays: u.pays }).first('id') : null
        if (!a) throw new InvalidRequest({ message: 'Choisissez une agence de votre pays.' })
        return a.id
      }
      if (!u?.agence || !ROLES_DIRECTION.includes(u.role)) throw new ForbiddenError()
      return u.agence
    }
    /** Résultat d'estimation exposé (agrégats ; aucune donnée de comparable). */
    const resultatPublic = (r, id = null) => ({ id, loyer: r.loyer, vente: r.vente, rendement: r.rendement, confiance: r.confiance, niveau: r.niveau, nb_comparables: r.nb_comparables, devise: r.devise })

    router.post('/analytics/estimation', async (req, res, next) => {
      try {
        const acc = req.accountability
        if (!acc?.user) throw new ForbiddenError()
        const u = acc.admin ? null : await profil(acc)
        if (!acc.admin && !ROLES_BACK_OFFICE.includes(u?.role)) throw new ForbiddenError()
        const schema = await getSchema()
        const b = { ...(req.body ?? {}) }
        let bien = null
        if (b.bien) {
          // bien du périmètre de l'appelant : ses caractéristiques servent de valeurs par défaut
          bien = await new ItemsService('biens', { schema, accountability: acc }).readOne(b.bien, { fields: ['id', 'type_bien', 'ville', 'quartier', 'surface_habitable', 'surface_terrain', 'etat', 'nb_chambres', 'agence'] })
          b.type_bien ??= bien.type_bien; b.ville ??= bien.ville; b.quartier ??= bien.quartier; b.etat ??= bien.etat; b.nb_chambres ??= bien.nb_chambres
          b.surface ??= b.type_bien === 'terrain' ? bien.surface_terrain : bien.surface_habitable
        }
        const { entree, erreur } = await lireEntree(database, b)
        if (erreur) throw new InvalidRequest({ message: erreur })
        const r = await estimer(database, { ...entree, exclure: bien?.id ?? null })
        // historique de l'entreprise (pas d'enregistrement si la licence est en lecture seule)
        const agence = bien?.agence ?? u?.agence ?? null
        const etat = agence ? (await database('agences').where('id', agence).first('etat_licence'))?.etat_licence : null
        let id = null
        if (acc.admin || !agence || ETATS_ECRITURE.includes(etat)) {
          id = await new ItemsService('estimations', { schema, accountability: null })
            .createOne(ligneEstimation(entree, r, { source: 'back_office', agence, bien: bien?.id ?? null }))
        }
        res.json({ data: resultatPublic(r, id) })
      } catch (error) {
        next(error)
      }
    })

    router.get('/analytics/synthese', async (req, res, next) => {
      try {
        const agence = await agenceAnalytics(req, req.query.agence)
        res.json({ data: await syntheseAnalytics(database, agence) })
      } catch (error) {
        next(error)
      }
    })

    // site public : appel par le serveur Nuxt (limité par adresse IP), sans jeton
    /**
     * Inscription d'une entreprise en libre-service : compte créé avec une licence d'essai de 30 jours (offre choisie),
     * l'administrateur reçoit l'invitation d'activation (choix du mot de passe et acceptation des CGU).
     * Adresse déjà utilisée : même réponse, rien n'est créé (aucune information révélée).
     */
    router.post('/public/inscription-entreprise', async (req, res, next) => {
      try {
        const b = req.body ?? {}
        const e = b.entreprise ?? {}, adm = b.administrateur ?? {}
        const nom = String(e.nom ?? '').trim().slice(0, 120)
        if (nom.length < 2) throw new InvalidRequest({ message: 'Indiquez le nom de votre entreprise.' })
        if (!TYPES_COMPTE.includes(e.type_compte)) throw new InvalidRequest({ message: 'Choisissez le type de compte.' })
        const pays = await database('pays').where({ id: Number(e.pays) || 0 }).first('id')
        if (!pays) throw new InvalidRequest({ message: 'Choisissez votre pays.' })
        const ville = e.ville ? await database('villes').where({ id: Number(e.ville) || 0, pays: pays.id }).first('id') : null
        const telephone = String(e.telephone ?? '').replace(/[\s.-]/g, '')
        if (!/^\+[1-9]\d{6,14}$/.test(telephone)) throw new InvalidRequest({ message: 'Indiquez un numéro de téléphone au format international (ex. +225 07 00 00 00 00).' })
        const email = String(adm.email ?? '').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidRequest({ message: 'Adresse e-mail invalide.' })
        if (String(adm.prenom ?? '').trim().length < 1 || String(adm.nom ?? '').trim().length < 1) throw new InvalidRequest({ message: 'Indiquez votre prénom et votre nom.' })
        const offre = await database('offres').where({ id: Number(b.offre) || 0, actif: true }).first('id')
          ?? await database('offres').where('actif', true).orderBy([{ column: 'sort', order: 'asc' }, { column: 'id', order: 'asc' }]).first('id')
        if (!offre) throw new BusinessRuleError({ message: 'Les inscriptions sont momentanément indisponibles. Réessayez plus tard.' })
        if (await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id')) return res.json({ data: { ok: true } })
        const debut = new Date().toISOString().slice(0, 10)
        const fin = new Date(Date.parse(`${debut}T00:00:00Z`) + (DUREE_ESSAI_JOURS - 1) * 86400000).toISOString().slice(0, 10)
        await creerEntreprise({
          entreprise: { nom, type_compte: e.type_compte, pays: pays.id, ville: ville?.id ?? null, telephone, email },
          licence: { offre: offre.id, statut: 'essai', periodicite: 'essai', date_debut: debut, date_fin: fin, notes: 'Essai gratuit (inscription en libre-service)' },
          administrateur: { email, prenom: adm.prenom, nom: adm.nom, telephone },
        }, null)
        logger.info(`gimmo-api : nouvelle entreprise inscrite en libre-service (${e.type_compte}, essai ${DUREE_ESSAI_JOURS} jours)`)
        res.json({ data: { ok: true } })
      } catch (error) {
        next(error)
      }
    })

    router.post('/public/estimation', async (req, res, next) => {
      try {
        const { entree, erreur } = await lireEntree(database, req.body ?? {})
        if (erreur) throw new InvalidRequest({ message: erreur })
        if (!await database('villes').where({ id: entree.ville, actif: true }).first('id')) throw new InvalidRequest({ message: 'Choisissez la ville.' })
        const r = await estimer(database, entree)
        const id = await new ItemsService('estimations', { schema: await getSchema(), accountability: null }).createOne(ligneEstimation(entree, r, { source: 'portail' }))
        res.json({ data: resultatPublic(r, id) })
      } catch (error) {
        next(error)
      }
    })

    router.post('/public/estimation/:id/contact', async (req, res, next) => {
      try {
        const b = req.body ?? {}
        const nom = String(b.nom ?? '').trim().slice(0, 120), telephone = String(b.telephone ?? '').trim().slice(0, 30)
        const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200), message = String(b.message ?? '').trim().slice(0, 1000)
        if (b.consentement !== true) throw new InvalidRequest({ message: 'Votre accord est nécessaire pour être recontacté.' })
        if (nom.length < 2 || (!telephone && !email)) throw new InvalidRequest({ message: 'Indiquez votre nom et un téléphone ou un e-mail.' })
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidRequest({ message: 'Adresse e-mail invalide.' })
        const e = /^[0-9a-f-]{36}$/.test(req.params.id) ? await database('estimations').where({ id: req.params.id, source: 'portail' }).first('id', 'ville', 'type_bien', 'surface', 'date_created') : null
        // lien valable 24 h après l'estimation ; une seule transmission par estimation
        if (!e || Date.now() - new Date(e.date_created).getTime() > 86400000) throw new BusinessRuleError({ message: 'Cette estimation a expiré : relancez une estimation.' })
        if (await database('demandes').where('estimation', e.id).first('id')) throw new BusinessRuleError({ message: 'Votre demande a déjà été transmise aux agences.' })
        // agences sous licence installées dans la ville ou y gérant des biens (les plus présentes d'abord), 5 au plus
        const agences = await database('agences as a').leftJoin('biens as b', function () { this.on('b.agence', 'a.id').andOn('b.ville', database.raw('?', [e.ville])) })
          .where('a.actif', true).whereIn('a.etat_licence', ETATS_ECRITURE).whereIn('a.type_compte', ['agence', 'agent_independant'])
          .groupBy('a.id', 'a.nom', 'a.ville').havingRaw('a.ville = ? or count(b.id) > 0', [e.ville])
          .orderByRaw('count(b.id) desc').orderBy('a.nom').limit(5).select('a.id', 'a.nom')
        const schema = await getSchema()
        const demandes = new ItemsService('demandes', { schema, accountability: null })
        for (const a of agences) {
          await demandes.createOne({ type: 'contact_estimation', estimation: e.id, agence: a.id, nom, telephone: telephone || null, email: email || null, message: message || null, consentement: true, statut: 'nouvelle' })
        }
        res.json({ data: { agences: agences.length } })
        // prévenir les administrateurs des agences (après la réponse)
        const ville = (await database('villes').where('id', e.ville).first('nom'))?.nom ?? ''
        for (const a of agences) {
          emailAdministrateurs(database, a.id, 'Nouvelle demande d’estimation', 'Bonjour,\n\nUn visiteur du site a estimé un bien ({type}, {surface} m², {ville}) et souhaite être recontacté.\nRetrouvez sa demande dans le CRM, avec les autres demandes du site.', { services, schema, logger, env }, { type: (L) => tr(L, TYPE_BIEN_FR[e.type_bien] ?? e.type_bien), surface: e.surface, ville }, { type: 'estimation.lead', lien: '/administration-gocleus/crm' })
        }
      } catch (error) {
        if (!res.headersSent) next(error)
        else logger.error(error, 'gimmo-api : notification des demandes d’estimation')
      }
    })


    // ── Vérification & confiance : synthèse et demande de badge (entreprise), décision (plateforme)
    const ROLES_GESTION = ['Administrateur d’entreprise', 'Manager']
    /** Entreprise dont l'appelant gère la vérification : la sienne (administrateur, manager) ; de son pays (responsable pays) ; au choix (plateforme). */
    async function agenceVerification(req, demandee) {
      const acc = req.accountability
      if (!acc?.user) throw new ForbiddenError()
      if (acc.admin) {
        if (!demandee || !await database('agences').where('id', demandee).first('id')) throw new InvalidRequest({ message: 'Choisissez le compte entreprise.' })
        return demandee
      }
      const u = await profil(acc)
      if (u?.role === 'Responsable pays') {
        const a = demandee ? await database('agences').where({ id: demandee, pays: u.pays }).first('id') : null
        if (!a) throw new InvalidRequest({ message: 'Choisissez une agence de votre pays.' })
        return a.id
      }
      if (!u?.agence || !ROLES_GESTION.includes(u.role)) throw new ForbiddenError()
      return u.agence
    }

    router.get('/verification/synthese', async (req, res, next) => {
      try {
        const agence = await agenceVerification(req, req.query.agence)
        res.json({ data: await syntheseVerification(database, agence) })
      } catch (error) {
        next(error)
      }
    })

    // POST /gimmo/verification/:collection/:id/demander — l'entreprise demande le badge « Vérifié » (pièces fournies)
    router.post('/verification/:collection/:id/demander', async (req, res, next) => {
      try {
        const collection = req.params.collection
        if (!['biens', 'programmes'].includes(collection)) throw new ForbiddenError()
        const acc = req.accountability
        if (!acc?.user) throw new ForbiddenError()
        // élément du périmètre de l'appelant ; demande réservée à la direction de l'entreprise
        const item = await new ItemsService(collection, { schema: await getSchema(), accountability: acc }).readOne(req.params.id, { fields: ['id', 'agence', 'statut_verification', ...(collection === 'biens' ? ['numero_titre_foncier', 'titre'] : ['nom'])] })
        if (!acc.admin) {
          const u = await profil(acc)
          if (!ROLES_GESTION.includes(u?.role) || u.agence !== item.agence) throw new ForbiddenError()
          const etat = (await database('agences').where('id', item.agence).first('etat_licence'))?.etat_licence
          if (!ETATS_ECRITURE.includes(etat)) throw new BusinessRuleError({ message: 'Licence non valide : le compte de votre entreprise est en lecture seule.' })
        }
        const erreur = await controleDemande(database, collection, item)
        if (erreur) throw new BusinessRuleError({ message: erreur })
        await database(collection).where('id', item.id).update({ statut_verification: 'demandee', date_demande_verification: new Date(), motif_verification: null })
        res.json({ data: { id: item.id, statut_verification: 'demandee' } })
      } catch (error) {
        next(error)
      }
    })

    // POST /gimmo/plateforme/verification { collection, id, decision: verifier | refuser | retirer, motif? }
    router.post('/plateforme/verification', plateforme(async (req) => {
      const { collection, id, decision, motif } = req.body ?? {}
      if (!['biens', 'programmes'].includes(collection) || typeof id !== 'string') throw new InvalidRequest({ message: 'Élément invalide.' })
      const item = await database(collection).where('id', id).first('id', 'agence', 'statut_verification', collection === 'biens' ? 'titre' : 'nom')
      if (!item) throw new ForbiddenError()
      const titre = item.titre ?? item.nom
      const m = String(motif ?? '').trim().slice(0, 1000)
      let maj, sujet, corps
      if (decision === 'verifier') {
        if (item.statut_verification === 'verifie') throw new BusinessRuleError({ message: 'Cet élément est déjà vérifié.' })
        maj = { verifie: true, statut_verification: 'verifie', date_verification: new Date().toISOString().slice(0, 10), motif_verification: null }
        sujet = 'Badge « Vérifié » accordé : {titre}'
        corps = 'Bonjour,\n\n« {titre} » a été vérifié par la plateforme Gocleus Immo : le badge « Vérifié » s’affiche désormais sur le site public.'
      } else if (decision === 'refuser' || decision === 'retirer') {
        if (m.length < 5) throw new InvalidRequest({ message: 'Indiquez le motif (il est transmis à l’entreprise).' })
        if (decision === 'refuser' && item.statut_verification !== 'demandee') throw new BusinessRuleError({ message: 'Aucune demande de vérification en cours pour cet élément.' })
        if (decision === 'retirer' && item.statut_verification !== 'verifie') throw new BusinessRuleError({ message: 'Cet élément n’est pas vérifié.' })
        maj = { verifie: false, statut_verification: 'refusee', date_verification: null, motif_verification: m }
        sujet = decision === 'refuser' ? 'Vérification refusée : {titre}' : 'Badge « Vérifié » retiré : {titre}'
        corps = decision === 'refuser'
          ? 'Bonjour,\n\nLa demande de vérification de « {titre} » n’a pas pu être acceptée.\nMotif : {motif}\n\nVous pouvez compléter les pièces puis demander une nouvelle vérification.'
          : 'Bonjour,\n\nLe badge « Vérifié » de « {titre} » a été retiré.\nMotif : {motif}\n\nVous pouvez compléter les pièces puis demander une nouvelle vérification.'
      } else throw new InvalidRequest({ message: 'Décision inconnue (verifier, refuser ou retirer).' })
      await database(collection).where('id', id).update(maj)
      const schema = await getSchema()
      // l'entreprise est informée sans faire attendre la plateforme
      emailAdministrateurs(database, item.agence, sujet, corps, { services, schema, logger, env }, { titre, motif: m }, { type: 'verification.resultat', lien: '/administration-gocleus/verification' })
      return { id, statut_verification: maj.statut_verification }
    }))

    // POST /gimmo/plateforme/alertes/:id/traiter { note }
    router.post('/plateforme/alertes/:id/traiter', plateforme(async (req) => {
      const note = String(req.body?.note ?? '').trim().slice(0, 2000)
      if (note.length < 3) throw new InvalidRequest({ message: 'Indiquez la décision prise.' })
      const n = await database('alertes_plateforme').where({ id: req.params.id, statut: 'ouverte' }).update({ statut: 'traitee', note_traitement: note, date_traitement: new Date() })
      if (!n) throw new BusinessRuleError({ message: 'Cette alerte est introuvable ou déjà traitée.' })
      return { id: req.params.id, statut: 'traitee' }
    }))

    // ── Espace locataire (site public)
    /** L'agence invite un locataire à son espace en ligne (ou relie le compte client qu'il a déjà). */
    router.post('/locataires/:id/inviter', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        // périmètre de l'appelant : la fiche doit être lisible et modifiable par lui
        const c = await new ItemsService('contacts', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['id', 'prenom', 'nom', 'raison_sociale', 'email', 'utilisateur', 'agence'] })
        // réservé à qui gère les baux de ce locataire (le commercial lit les contacts, pas les baux)
        await new ItemsService('baux', { schema, accountability: req.accountability }).readByQuery({ filter: { locataire: { _eq: c.id } }, fields: ['id'], limit: 1 })
        if (!req.accountability.admin) {
          const etat = (await database('agences').where('id', c.agence).first('etat_licence'))?.etat_licence
          if (!ETATS_ECRITURE.includes(etat)) throw new BusinessRuleError({ message: 'Licence non valide : le compte de votre entreprise est en lecture seule.' })
        }
        if (c.utilisateur) throw new BusinessRuleError({ message: 'Ce locataire a déjà accès à son espace en ligne.' })
        const email = String(c.email ?? '').trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BusinessRuleError({ message: 'Renseignez d’abord l’adresse e-mail du locataire.' })
        if (!await database('baux').where('locataire', c.id).whereIn('statut', ['en_vigueur', 'litige', 'en_attente_signature']).first('id')) throw new BusinessRuleError({ message: 'Ce contact n’a pas de bail en cours.' })
        const roleClient = (await database('directus_roles').where('name', 'Client').first('id'))?.id
        const existant = await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id', 'role', 'status')
        let utilisateur, invite = false
        if (existant) {
          // compte du site public déjà existant : on le relie ; un compte professionnel ne peut pas devenir un espace locataire
          if (existant.role !== roleClient) throw new BusinessRuleError({ message: 'Cette adresse e-mail est déjà utilisée par un compte professionnel.' })
          utilisateur = existant.id
        } else {
          const users = new UsersService({ schema, accountability: null })
          // langue du locataire (pays de l'agence) : lien d'activation /en/invitation et profil en anglais le cas échéant
          const langue = await langueContact(database, c.id)
          memoriserLangue(email, langue)
          await users.inviteUser(email, roleClient, `${String(env.GIMMO_SITE_URL ?? '').replace(/\/$/, '')}${langue === 'en' ? '/en' : ''}/invitation`)
          utilisateur = (await database('directus_users').whereRaw('lower(email) = ?', [email]).first('id')).id
          await users.updateOne(utilisateur, { first_name: c.prenom ?? null, last_name: c.nom ?? c.raison_sociale ?? null, language: langue === 'en' ? 'en-US' : 'fr-FR' })
          invite = true
        }
        await database('contacts').where('id', c.id).update({ utilisateur })
        res.json({ data: { contact: c.id, utilisateur, invite } })
      } catch (error) {
        next(error)
      }
    })

    /** Le locataire connecté signale un problème dans son logement (bail en cours vérifié) : ticket de maintenance. */
    router.post('/locataire/tickets', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const b = req.body ?? {}
        const titre = String(b.titre ?? '').trim(), description = String(b.description ?? '').trim()
        if (titre.length < 3 || description.length < 10) throw new InvalidRequest({ message: 'Décrivez le problème (un titre et quelques mots de description).' })
        const categorie = ['plomberie', 'electricite', 'climatisation', 'menuiserie', 'peinture', 'autre'].includes(b.categorie) ? b.categorie : 'autre'
        const baux = await database('baux as ba').join('contacts as c', 'c.id', 'ba.locataire').where('c.utilisateur', req.accountability.user)
          .whereIn('ba.statut', ['en_vigueur', 'litige']).select('ba.id', 'ba.bien', 'c.id as contact')
        const bail = b.bail ? baux.find(x => x.id === b.bail) : baux[0]
        if (!bail) throw new ForbiddenError()
        const schema = await getSchema()
        const id = await new ItemsService('tickets_maintenance', { schema, accountability: null }).createOne({
          bien: bail.bien, signale_par: bail.contact, titre: titre.slice(0, 150), description: description.slice(0, 3000), categorie, priorite: b.urgent ? 'urgent' : 'normal',
        })
        const t = await database('tickets_maintenance').where('id', id).first('id', 'reference', 'statut')
        res.json({ data: t })
      } catch (error) {
        next(error)
      }
    })

    router.get('/quittances/:id/pdf', async (req, res, next) => {
      try {
        if (!req.accountability?.user) throw new ForbiddenError()
        const schema = await getSchema()
        // lecture avec les droits de l'appelant : refusée si la quittance n'est pas de son périmètre
        const q = await new ItemsService('quittances', { schema, accountability: req.accountability }).readOne(req.params.id, { fields: ['id', 'numero', 'statut'] })
        const fileId = await assurerPdfQuittance(database, q.id, { FilesService, schema })
        const { stream, stat } = await new AssetsService({ schema, accountability: null }).getAsset(fileId)
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Length', stat.size)
        res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="quittance-${q.numero}${q.statut === 'annulee' ? '-ANNULEE' : ''}.pdf"`)
        res.setHeader('Cache-Control', 'private, no-store')
        stream.pipe(res)
      } catch (error) {
        next(error)
      }
    })
  },
}
