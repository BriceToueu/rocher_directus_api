/**
 * G-immo — abonnements des entreprises : tarifs, activation d'une période payée, factures (numérotation, PDF).
 *
 * Tarif : offres_tarifs (offre × pays de l'entreprise), en unité mineure de la devise du pays ; annuel = prix_annuel,
 *         sinon 12 × prix_mensuel. Les prix sont hors taxes ; la TVA du pays (pays.taux_tva) s'ajoute si renseignée.
 * Période payée : à la suite de la dernière période payée encore en cours, sinon à partir du jour du paiement
 *         (fin d'essai, délai de grâce, lecture seule). Mensuel : 1 mois ; annuel : 12 mois (veille de la date anniversaire).
 * Activation idempotente (verrou sur la transaction) : une seule licence, un seul paiement, une seule facture.
 */
import PDFDocument from 'pdfkit'
import { Readable } from 'node:stream'
import { randomBytes, randomUUID } from 'node:crypto'
import { dateLongue, isoDate, montant, pdfBuffer, PDF_COULEURS, todayIso } from './commun.js'
import { langueAgence, tr } from './i18n.js'
import { emailAdministrateurs, rafraichirEtats, viderCacheEntreprise } from './saas.js'
import { lireStatut } from './paiement.js'

export const STATUTS_FINAUX = ['reussie', 'echouee', 'annulee', 'expiree']

export const PERIODICITES = ['mensuel', 'annuel']

/** Référence lisible et unique d'un paiement en ligne. */
export const nouvelleReference = () => `GI-${todayIso().replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`

const ajouterMois = (iso, n) => {
  const [a, m, j] = iso.split('-').map(Number)
  const d = new Date(Date.UTC(a, m - 1 + n, 1))
  const dernier = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(j, dernier))
  return d.toISOString().slice(0, 10)
}
const ajouterJours = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/** Pays, devise et taux de TVA d'une entreprise. */
export async function contexteEntreprise(db, agence) {
  return db('agences as a').leftJoin('pays as p', 'p.id', 'a.pays').leftJoin('devises as d', 'd.id', 'p.devise').where('a.id', agence)
    .first('a.id', 'a.nom', 'a.email', 'a.telephone', 'a.adresse', 'a.ville', 'a.pays', 'p.code as pays_code', 'p.nom as pays_nom', 'p.taux_tva',
      'd.id as devise', 'd.code as devise_code', 'd.symbole as devise_symbole', 'd.decimales as devise_decimales')
}

/** Offres actives avec leur prix pour un pays (null si le prix n'est pas encore fixé). */
export async function offresAvecPrix(db, pays) {
  const offres = await db('offres').where('actif', true).orderBy([{ column: 'sort', order: 'asc' }, { column: 'id', order: 'asc' }])
    .select('id', 'code', 'nom', 'description', 'max_utilisateurs', 'max_biens', 'max_annonces')
  const tarifs = pays ? await db('offres_tarifs').where('pays', pays).select('offre', 'prix_mensuel', 'prix_annuel') : []
  return offres.map((o) => {
    const t = tarifs.find(x => x.offre === o.id)
    const mensuel = t?.prix_mensuel != null ? Number(t.prix_mensuel) : null
    const annuel = t?.prix_annuel != null ? Number(t.prix_annuel) : (mensuel != null ? mensuel * 12 : null)
    return { ...o, prix: { mensuel, annuel } }
  })
}

/** Montant hors taxes, TVA et TTC (unité mineure) d'une offre pour une entreprise ; null si pas de prix. */
export async function prixAbonnement(db, agence, offre, periodicite) {
  const ctx = await contexteEntreprise(db, agence)
  const o = (await offresAvecPrix(db, ctx?.pays)).find(x => x.id === Number(offre))
  const ht = o?.prix?.[periodicite]
  if (!o || ht == null || ht <= 0) return null
  const taux = ctx.taux_tva != null ? Number(ctx.taux_tva) : null
  const tva = taux ? Math.round(ht * taux / 100) : 0
  return { offre: o, ht, taux, tva, ttc: ht + tva, devise: ctx.devise, deviseCode: ctx.devise_code, ctx }
}

/** Période d'une nouvelle licence payée : à la suite de la période payée en cours, sinon à partir d'aujourd'hui. */
export async function prochainePeriode(db, agence, periodicite, jour = todayIso()) {
  const derniere = await db('licences').where({ agence, statut: 'active' }).where('date_fin', '>=', jour).orderBy('date_fin', 'desc').first('date_fin')
  const debut = derniere ? ajouterJours(isoDate(derniere.date_fin), 1) : jour
  return { debut, fin: ajouterJours(ajouterMois(debut, periodicite === 'annuel' ? 12 : 1), -1) }
}

// ── Factures ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Numéro suivant (PRÉFIXE-ANNÉE-000001), sous verrou transactionnel : jamais de doublon ni de trou. */
async function numeroSuivant(trx, prefixe, annee) {
  await trx.raw('select pg_advisory_xact_lock(?)', [771122])
  const base = `${prefixe}-${annee}-`
  const dernier = await trx('factures').where('numero', 'like', `${base}%`).orderBy('numero', 'desc').first('numero')
  const n = dernier ? Number(dernier.numero.slice(base.length)) + 1 : 1
  return `${base}${String(n).padStart(6, '0')}`
}

/** Crée une facture acquittée (dans la transaction trx) ; le PDF est produit ensuite par assurerPdfFacture. */
export async function creerFacture(trx, { agence, licence, transaction = null, paiement = null, offre, periode, montants, devise, reference, moyen }) {
  const parametres = await trx('parametres_plateforme').first('prefixe_facture') ?? {}
  const langue = await langueAgence(trx, agence)
  const jour = todayIso()
  const numero = await numeroSuivant(trx, (parametres.prefixe_facture || 'FAC').trim().toUpperCase(), jour.slice(0, 4))
  const libelle = tr(langue, 'Abonnement Gocleus Immo — offre {offre}', { offre: offre.nom })
  const [facture] = await trx('factures').insert({
    id: randomUUID(), numero, statut: 'acquittee', date_emission: jour, libelle, periode_debut: periode?.debut ?? null, periode_fin: periode?.fin ?? null,
    montant_ht: montants.ht, taux_tva: montants.taux ?? null, montant_tva: montants.tva ?? 0, montant_ttc: montants.ttc,
    reference_paiement: reference ?? null, moyen: moyen ?? null, langue, agence, licence, transaction, paiement, devise, date_created: new Date(),
  }).returning(['id', 'numero'])
  return facture
}

async function donneesFacture(db, id) {
  const f = await db('factures').where('id', id).first()
  const ctx = await contexteEntreprise(db, f.agence)
  const ville = ctx?.ville ? await db('villes').where('id', ctx.ville).first('nom') : null
  const devise = f.devise ? await db('devises').where('id', f.devise).first('code', 'symbole', 'decimales') : { symbole: ctx?.devise_symbole, decimales: ctx?.devise_decimales }
  const emetteur = await db('parametres_plateforme').first() ?? {}
  return { f, ctx, ville: ville?.nom ?? null, devise, emetteur }
}

function dessinerFacture({ f, ctx, ville, devise, emetteur }) {
  const L = f.langue === 'en' ? 'en' : 'fr'
  const t = (fr, p) => tr(L, fr, p)
  const date = (v) => dateLongue(v, L)
  const somme = (v) => montant(v, devise, L)
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: t('Facture {numero}', { numero: f.numero }), Author: emetteur.raison_sociale || 'Gocleus Immo', Creator: 'Gocleus Immo' } })
  const { BRAND, ACCENT, MUTED, LINE } = PDF_COULEURS
  const W = doc.page.width - 100

  doc.rect(0, 0, doc.page.width, 8).fill(ACCENT)
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(16).text(emetteur.raison_sociale || 'Gocleus Immo', 50, 40, { width: W / 2 })
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
  for (const l of [emetteur.forme_juridique, emetteur.adresse, [emetteur.telephone, emetteur.email].filter(Boolean).join('  ·  '),
    [emetteur.rccm && t('RCCM {n}', { n: emetteur.rccm }), emetteur.compte_contribuable && t('CC {n}', { n: emetteur.compte_contribuable })].filter(Boolean).join('  ·  ')].filter(Boolean)) {
    doc.text(l, { width: W / 2 })
  }
  doc.font('Helvetica-Bold').fontSize(22).fillColor(BRAND).text(t('FACTURE'), 50, 40, { width: W, align: 'right' })
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(t('N° {numero}', { numero: f.numero }), { width: W, align: 'right' })
    .text(t('Émise le {date}', { date: date(f.date_emission) }), { width: W, align: 'right' })
  if (f.statut === 'annulee') doc.font('Helvetica-Bold').fontSize(12).fillColor('#C0392B').text(t('ANNULÉE'), { width: W, align: 'right' })

  // Client
  const y1 = 150
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(t('FACTURÉ À'), 50, y1)
  doc.moveDown(0.3).font('Helvetica-Bold').fontSize(12).fillColor('#1A2B3C').text(ctx?.nom ?? '—', { width: W / 2 })
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
  for (const l of [ctx?.adresse, [ville, ctx?.pays_nom].filter(Boolean).join(', '), [ctx?.telephone, ctx?.email].filter(Boolean).join('  ·  ')].filter(Boolean)) doc.text(l, { width: W / 2 })

  // Détail
  let y = y1 + 100
  doc.roundedRect(50, y, W, 26, 4).fill('#EEF7FB')
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(9).text(t('DÉSIGNATION'), 62, y + 9).text(t('MONTANT HT'), 50 + W - 160, y + 9, { width: 148, align: 'right' })
  y += 38
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1A2B3C').text(f.libelle, 62, y, { width: W - 200 })
  doc.font('Helvetica').fontSize(11).text(somme(f.montant_ht), 50 + W - 160, y, { width: 148, align: 'right' })
  if (f.periode_debut) {
    y = doc.y + 2
    doc.fontSize(9).fillColor(MUTED).text(t('Période du {debut} au {fin}', { debut: date(f.periode_debut), fin: date(f.periode_fin) }), 62, y, { width: W - 200 })
  }
  y = doc.y + 18
  doc.moveTo(50, y).lineTo(50 + W, y).strokeColor(LINE).lineWidth(1).stroke()
  y += 12
  const ligne = (label, valeur, gras = false) => {
    doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(gras ? 12 : 10).fillColor(gras ? BRAND : '#1A2B3C')
      .text(label, 50 + W - 330, y, { width: 170, align: 'right' }).text(valeur, 50 + W - 160, y, { width: 148, align: 'right' })
    y += gras ? 26 : 20
  }
  ligne(t('Total hors taxes'), somme(f.montant_ht))
  if (Number(f.montant_tva) > 0) ligne(t('TVA {taux} %', { taux: String(Number(f.taux_tva)).replace('.', L === 'en' ? '.' : ',') }), somme(f.montant_tva))
  else ligne(t('TVA'), t('non applicable'))
  ligne(t('Total TTC'), somme(f.montant_ttc), true)

  // Règlement
  y += 10
  doc.roundedRect(50, y, W, 42, 6).fill('#EAF7EF')
  doc.fillColor('#1E7A46').font('Helvetica-Bold').fontSize(11).text(t('Facture acquittée'), 64, y + 9)
  doc.font('Helvetica').fontSize(9).fillColor('#1A2B3C')
    .text([t('Payée le {date}', { date: date(f.date_emission) }), f.moyen ? t(f.moyen) : null, f.reference_paiement ? t('réf. {ref}', { ref: f.reference_paiement }) : null].filter(Boolean).join('  ·  '), 64, y + 25, { width: W - 28 })

  // Mentions
  const bas = doc.page.height - 90
  doc.page.margins.bottom = 0
  if (emetteur.mentions_facture) doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(emetteur.mentions_facture, 50, bas - 30, { width: W, align: 'center' })
  doc.moveTo(50, bas).lineTo(50 + W, bas).strokeColor(LINE).stroke()
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(t('Facture émise électroniquement par la plateforme Gocleus Immo.'), 50, bas + 8, { width: W, align: 'center' })
  doc.end()
  return doc
}

/** PDF d'une facture (créé une seule fois, sous verrou) ; renvoie l'identifiant du fichier. */
export async function assurerPdfFacture(db, factureId, { FilesService, schema }) {
  return db.transaction(async (trx) => {
    const f = await trx('factures').where('id', factureId).forUpdate().first('id', 'numero', 'fichier_pdf')
    if (!f) return null
    if (f.fichier_pdf) return f.fichier_pdf
    const buffer = await pdfBuffer(dessinerFacture(await donneesFacture(trx, factureId)))
    const fichier = await new FilesService({ schema, accountability: null }).uploadOne(Readable.from(buffer), {
      title: `Facture ${f.numero}`, filename_download: `facture-${f.numero}.pdf`, type: 'application/pdf',
    })
    await trx('factures').where('id', factureId).update({ fichier_pdf: fichier })
    return fichier
  })
}

/** Régénère le PDF (après annulation d'une facture : mention « ANNULÉE »). */
export async function regenererPdfFacture(db, factureId, services) {
  await db('factures').where('id', factureId).update({ fichier_pdf: null })
  return assurerPdfFacture(db, factureId, services)
}

// ── Activation d'un paiement réussi ──────────────────────────────────────────────────────────────────────────────

/**
 * Transaction confirmée par le fournisseur : licence de la période, paiement enregistré, facture, e-mail.
 * Idempotent : renvoie { cree: false } si la transaction est déjà activée. ctx = { services, schema, logger, env }.
 */
export async function activerPaiement(db, reference, statutFournisseur, ctx) {
  const resultat = await db.transaction(async (trx) => {
    const tx = await trx('transactions_paiement').where('reference', reference).forUpdate().first()
    if (!tx) return null
    if (tx.statut === 'reussie' && tx.licence) return { cree: false, tx }
    const offre = await trx('offres').where('id', tx.offre).first('id', 'nom')
    const periode = await prochainePeriode(trx, tx.agence, tx.periodicite)
    const ctxE = await contexteEntreprise(trx, tx.agence)
    const taux = ctxE?.taux_tva != null ? Number(ctxE.taux_tva) : null
    // le montant payé est TTC : on en retrouve la base hors taxes au taux du pays
    const ttc = Number(tx.montant)
    const ht = taux ? Math.round(ttc / (1 + taux / 100)) : ttc
    const moyen = (await trx('moyens_paiement').where('code', String(statutFournisseur?.methode ?? '').toLowerCase()).first('id', 'nom'))
      ?? await trx('moyens_paiement').where('code', 'carte').first('id', 'nom')
    const [licence] = await trx('licences').insert({
      id: randomUUID(), agence: tx.agence, offre: tx.offre, statut: 'active', periodicite: tx.periodicite,
      date_debut: periode.debut, date_fin: periode.fin, montant: ttc, devise: tx.devise, notes: `Paiement en ligne ${tx.reference} (${tx.fournisseur})`, date_created: new Date(),
    }).returning('id')
    const licenceId = licence.id ?? licence
    const [paiement] = await trx('paiements_licences').insert({
      id: randomUUID(), licence: licenceId, date_paiement: todayIso(), montant: ttc, reference: tx.reference, moyen_paiement: moyen?.id ?? null,
      note: `Paiement en ligne (${tx.fournisseur})${tx.reference_fournisseur ? ` — réf. fournisseur ${tx.reference_fournisseur}` : ''}`, date_created: new Date(),
    }).returning('id')
    const facture = await creerFacture(trx, {
      agence: tx.agence, licence: licenceId, transaction: tx.id, paiement: paiement.id ?? paiement, offre, periode,
      montants: { ht, taux, tva: ttc - ht, ttc }, devise: tx.devise, reference: tx.reference, moyen: moyen?.nom ?? 'Paiement en ligne',
    })
    await trx('transactions_paiement').where('id', tx.id).update({ statut: 'reussie', licence: licenceId, date_reussite: new Date(), details: JSON.stringify({ ...(tx.details ?? {}), confirmation: statutFournisseur?.details ?? null }) })
    return { cree: true, tx, licence: licenceId, facture, periode, offre }
  })
  if (!resultat?.cree) return resultat
  await rafraichirEtats(db, [resultat.tx.agence])
  viderCacheEntreprise()
  try { await assurerPdfFacture(db, resultat.facture.id, { FilesService: ctx.services.FilesService, schema: ctx.schema }) } catch (e) { ctx.logger?.error(e, 'gimmo-abonnement : PDF de facture non produit') }
  const site = String(ctx.env?.GIMMO_SITE_URL ?? '').replace(/\/$/, '')
  await emailAdministrateurs(db, resultat.tx.agence, 'Paiement reçu — facture {numero}',
    'Bonjour,\n\nNous avons bien reçu votre paiement pour l’offre {offre}. Votre abonnement est actif du {debut} au {fin}.\nVotre facture {numero} est disponible dans votre espace : {lien}\n\nMerci de votre confiance.',
    ctx,
    { numero: resultat.facture.numero, offre: resultat.offre?.nom ?? '', debut: (L) => dateLongue(resultat.periode.debut, L), fin: (L) => dateLongue(resultat.periode.fin, L), lien: `${site}/administration-gocleus/abonnement` },
    { type: 'abonnement.facture', lien: '/administration-gocleus/abonnement' })
  return resultat
}

/**
 * Statut d'une transaction relu chez son fournisseur et enregistré ; activation si réussi. Renvoie la transaction à jour.
 * simulation : résultat choisi sur la page de simulation (mode simulation uniquement).
 */
export async function actualiserTransaction(db, reference, ctx, { simulation } = {}) {
  const tx = await db('transactions_paiement as t').join('agences as a', 'a.id', 't.agence').leftJoin('pays as p', 'p.id', 'a.pays')
    .where('t.reference', reference).first('t.*', 'p.code as pays')
  if (!tx) return null
  if (STATUTS_FINAUX.includes(tx.statut) && (tx.statut !== 'reussie' || tx.licence)) return tx
  if (simulation) tx.details = { ...(tx.details ?? {}), simulation }
  let lu
  try {
    lu = await lireStatut(ctx.env, tx)
  } catch (e) {
    ctx.logger?.warn(`gimmo-abonnement : statut de ${reference} illisible (${e.message})`)
    return tx
  }
  if (lu.statut === 'reussie') {
    await activerPaiement(db, reference, lu, ctx)
  } else {
    await db('transactions_paiement').where({ id: tx.id }).whereNot('statut', 'reussie')
      .update({ statut: lu.statut, details: JSON.stringify({ ...(tx.details ?? {}), dernier: lu.details ?? null }) })
  }
  return db('transactions_paiement').where({ id: tx.id }).first()
}

/**
 * Facture d'un paiement de licence enregistré par la plateforme (virement, espèces…), si elle n'existe pas encore.
 * Le montant enregistré est TTC ; la base hors taxes est retrouvée au taux du pays de l'entreprise.
 */
export async function facturerPaiementManuel(db, paiementId, ctx) {
  const resultat = await db.transaction(async (trx) => {
    const p = await trx('paiements_licences').where('id', paiementId).forUpdate().first('id', 'licence', 'montant', 'reference', 'moyen_paiement', 'date_paiement')
    if (!p?.licence || !(Number(p.montant) > 0)) return null
    if (await trx('factures').where('paiement', p.id).first('id')) return null
    const l = await trx('licences').where('id', p.licence).first('agence', 'offre', 'date_debut', 'date_fin', 'devise')
    const offre = await trx('offres').where('id', l.offre).first('nom')
    const e = await contexteEntreprise(trx, l.agence)
    const taux = e?.taux_tva != null ? Number(e.taux_tva) : null
    const ttc = Number(p.montant)
    const ht = taux ? Math.round(ttc / (1 + taux / 100)) : ttc
    const moyen = p.moyen_paiement ? await trx('moyens_paiement').where('id', p.moyen_paiement).first('nom') : null
    const facture = await creerFacture(trx, {
      agence: l.agence, licence: p.licence, paiement: p.id, offre: offre ?? { nom: '—' }, periode: { debut: isoDate(l.date_debut), fin: isoDate(l.date_fin) },
      montants: { ht, taux, tva: ttc - ht, ttc }, devise: l.devise ?? e?.devise, reference: p.reference, moyen: moyen?.nom ?? null,
    })
    return { facture, agence: l.agence }
  })
  if (!resultat) return null
  try { await assurerPdfFacture(db, resultat.facture.id, { FilesService: ctx.services.FilesService, schema: ctx.schema }) } catch (e) { ctx.logger?.error(e, 'gimmo-abonnement : PDF de facture non produit') }
  const site = String(ctx.env?.GIMMO_SITE_URL ?? '').replace(/\/$/, '')
  await emailAdministrateurs(db, resultat.agence, 'Votre facture {numero} est disponible',
    'Bonjour,\n\nNous avons enregistré votre paiement. Votre facture {numero} est disponible dans votre espace : {lien}\n\nMerci de votre confiance.',
    ctx, { numero: resultat.facture.numero, lien: `${site}/administration-gocleus/abonnement` }, { type: 'abonnement.facture', lien: '/administration-gocleus/abonnement' })
  return resultat.facture
}
